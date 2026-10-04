// Storage of «Твой слой» (M34 п.5, plan §4.8): one Maestro file per base preset name,
// `maestro-preset-layer-<hash(name)>.json` = {schema:1, base, ops, updatedAt, applied?}, plus the index of names
// `maestro-preset-layers.json` (FileStore cannot list files), so every layer is loaded eagerly at start and the
// OAI_PRESET_CHANGED_BEFORE handler never waits for the network (P-178).
// Writes are debounced. Each change is kept as a function and replayed on a fresh read of the file when it is
// written, so two tabs (or devices) merge their edits instead of the later one overwriting the earlier.
import { readFresh } from '../../core/files';
import { sanitizeOps } from '../../domain/preset-layer-ops';
import type { LayerOp } from '../../domain/preset-layer-apply';
import { jsonCopy } from '../../domain/settings-diff';
import type { FileStore, Logger } from '../../shared/contracts';

export const LAYER_INDEX_FILE = 'maestro-preset-layers.json';
export const LAYER_FILE_KIND = 'preset-layer';
const SAVE_DELAY_MS = 400;

/** What the layer produced in the working copy last time (page-load check, §10.4 б). */
export interface AppliedMark {
    /** layerFingerprint of the working copy after OAI_PRESET_CHANGED_AFTER. */
    fingerprint: string;
    /** baseFingerprint of the saved base body the layer was laid over. */
    baseFingerprint: string;
    at: number;
}

export interface LayerFile {
    schema: 1;
    base: string;
    ops: LayerOp[];
    updatedAt: number;
    applied?: AppliedMark;
}

type Mutation = (file: LayerFile) => void;

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyLayer(base: string): LayerFile {
    return { schema: 1, base, ops: [], updatedAt: 0 };
}

/** Validates a stored file; null when it is not a layer of `base` (or another name with the same hash). */
export function readLayerFile(raw: unknown, base: string): LayerFile | null {
    if (!isDict(raw) || raw.schema !== 1 || raw.base !== base) return null;
    const file: LayerFile = {
        schema: 1,
        base,
        ops: sanitizeOps(raw.ops),
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
    const applied = raw.applied;
    if (
        isDict(applied) &&
        typeof applied.fingerprint === 'string' &&
        typeof applied.baseFingerprint === 'string' &&
        typeof applied.at === 'number'
    ) {
        file.applied = { fingerprint: applied.fingerprint, baseFingerprint: applied.baseFingerprint, at: applied.at };
    }
    return file;
}

function readIndex(raw: unknown): string[] {
    if (!isDict(raw) || raw.schema !== 1 || !Array.isArray(raw.bases)) return [];
    return raw.bases.filter((name): name is string => typeof name === 'string' && name !== '');
}

export interface LayerFilesOptions {
    delayMs?: number;
    /** Called when a write failed (the changes stay queued for the next write). */
    onError?: (base: string, error: unknown) => void;
}

export class LayerFiles {
    /** What the API sees: the disk state plus the queued changes. */
    private readonly memory = new Map<string, LayerFile>();
    /** Last state known to be on disk (fallback when a fresh read fails). */
    private readonly synced = new Map<string, LayerFile>();
    private readonly pending = new Map<string, Mutation[]>();
    private indexed = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly delayMs: number;

    constructor(
        private readonly files: FileStore,
        private readonly log: Logger,
        private readonly options: LayerFilesOptions = {},
    ) {
        this.delayMs = options.delayMs ?? SAVE_DELAY_MS;
    }

    fileName(base: string): string {
        return this.files.fileName(LAYER_FILE_KIND, base);
    }

    /** Reads the index and every listed layer (plus `extra` names, e.g. the current preset) in parallel. */
    async load(extra: readonly string[] = []): Promise<void> {
        let names: string[] = [];
        try {
            names = readIndex(await readFresh<unknown>(this.files, LAYER_INDEX_FILE));
        } catch (error) {
            this.log.warn('preset layer index could not be read', error);
        }
        this.indexed = new Set(names);
        const all = [...new Set([...names, ...extra.filter((name) => name !== '')])];
        await Promise.all(
            all.map(async (base) => {
                try {
                    const file = readLayerFile(await readFresh<unknown>(this.files, this.fileName(base)), base);
                    if (!file) return;
                    this.synced.set(base, jsonCopy(file));
                    // Changes made before the load finished go on top of what is on disk.
                    const memory = jsonCopy(file);
                    for (const change of this.pending.get(base) ?? []) change(memory);
                    this.memory.set(base, memory);
                    if (file.ops.length) this.indexed.add(base);
                } catch (error) {
                    this.log.warn(`preset layer of ${base} could not be read`, error);
                }
            }),
        );
    }

    get(base: string): LayerFile | undefined {
        return this.memory.get(base);
    }

    /** Names of bases whose layer has ops. */
    bases(): string[] {
        return [...this.memory.values()].filter((file) => file.ops.length > 0).map((file) => file.base);
    }

    /** Changes the layer now (memory) and queues the same change for the debounced write. */
    mutate(base: string, change: Mutation): LayerFile {
        const next = jsonCopy(this.memory.get(base) ?? emptyLayer(base));
        change(next);
        next.updatedAt = Date.now();
        this.memory.set(base, next);
        const list = this.pending.get(base) ?? [];
        list.push(change);
        this.pending.set(base, list);
        this.schedule();
        return next;
    }

    /** Moves a layer to a new base name (ST renamed the preset, P-181). */
    rename(oldBase: string, newBase: string): boolean {
        const source = this.memory.get(oldBase);
        if (!source?.ops.length || oldBase === newBase) return false;
        const ops = jsonCopy(source.ops);
        const applied = source.applied ? { ...source.applied } : undefined;
        this.mutate(newBase, (file) => {
            file.ops = jsonCopy(ops);
            if (applied) file.applied = { ...applied };
            else delete file.applied;
        });
        this.mutate(oldBase, (file) => {
            file.ops = [];
            delete file.applied;
        });
        return true;
    }

    hasPending(): boolean {
        return this.pending.size > 0;
    }

    /** Writes every queued change now. */
    flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const job = () => this.writeAll();
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /** Drops the timer (dispose); queued changes stay for an explicit flush(). */
    stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush().catch((error: unknown) => this.log.error('preset layer save failed', error));
        }, this.delayMs);
    }

    private async writeAll(): Promise<void> {
        const added: string[] = [];
        const removed: string[] = [];
        for (const base of [...this.pending.keys()]) {
            const changes = this.pending.get(base) ?? [];
            this.pending.delete(base);
            if (!changes.length) continue;
            const name = this.fileName(base);
            let target: LayerFile;
            try {
                target = readLayerFile(await readFresh<unknown>(this.files, name), base) ?? emptyLayer(base);
            } catch (error) {
                this.log.warn(`preset layer of ${base} could not be re-read; writing over the last known state`, error);
                target = jsonCopy(this.synced.get(base) ?? emptyLayer(base));
            }
            for (const change of changes) change(target);
            target.updatedAt = Date.now();
            try {
                if (target.ops.length) {
                    await this.files.write(name, target);
                    if (!this.indexed.has(base)) added.push(base);
                } else if (this.synced.has(base) || this.indexed.has(base)) {
                    await this.files.remove(name);
                    removed.push(base);
                }
            } catch (error) {
                this.pending.set(base, [...changes, ...(this.pending.get(base) ?? [])]);
                this.log.error(`preset layer of ${base} could not be saved`, error);
                this.options.onError?.(base, error);
                continue;
            }
            if (target.ops.length) this.synced.set(base, jsonCopy(target));
            else this.synced.delete(base);
            // Memory = disk + the changes made while this write was running.
            const newer = this.pending.get(base) ?? [];
            const memory = jsonCopy(target);
            for (const change of newer) change(memory);
            if (memory.ops.length || newer.length) this.memory.set(base, memory);
            else this.memory.delete(base);
        }
        if (added.length || removed.length) await this.updateIndex(added, removed);
    }

    private async updateIndex(added: readonly string[], removed: readonly string[]): Promise<void> {
        try {
            const names = new Set(readIndex(await readFresh<unknown>(this.files, LAYER_INDEX_FILE)));
            for (const name of added) names.add(name);
            for (const name of removed) names.delete(name);
            await this.files.write(LAYER_INDEX_FILE, { schema: 1, bases: [...names].sort() });
            this.indexed = names;
        } catch (error) {
            this.log.warn('preset layer index could not be saved', error);
        }
    }
}
