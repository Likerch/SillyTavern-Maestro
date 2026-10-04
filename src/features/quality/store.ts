// Storage of M12: verdicts per message and swipe in the chat document 'quality' (capped), and the statistics per
// defect kind in one global file `maestro-quality-stats.json` (several tabs add their deltas, like the autonomy stats).
import { readFresh } from '../../core/files';
import type { App, Logger } from '../../shared/contracts';
import type { Defect, DefectKind, QualityStats, QualityVerdict } from './api';
import { DEFECT_KINDS } from './settings';

export const QUALITY_DOC_KIND = 'quality';
const STATS_FILE_KIND = 'quality-stats';
/** Verdicts kept per chat (newest last). */
export const MAX_VERDICTS = 100;
const SAVE_DELAY_MS = 500;
const STATS_SAVE_DELAY_MS = 2000;

/** A verdict as stored: plus the reply's text hash (dedupe) and why it no longer applies. */
export interface StoredVerdict extends QualityVerdict {
    hash: string;
    invalidated?: 'swiped' | 'deleted' | 'edited';
}

export interface QualityDoc {
    version: 1;
    verdicts: StoredVerdict[];
}

export function emptyDoc(): QualityDoc {
    return { version: 1, verdicts: [] };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readVerdict(value: unknown): StoredVerdict | null {
    if (!isDict(value)) return null;
    if (typeof value.messageIndex !== 'number' || typeof value.swipeId !== 'number') return null;
    const defects = Array.isArray(value.defects)
        ? value.defects.filter((item): item is Defect => isDict(item) && typeof item.kind === 'string')
        : [];
    return { ...(value as unknown as StoredVerdict), defects, hash: typeof value.hash === 'string' ? value.hash : '' };
}

/** Per-chat verdicts: the live list the service mutates, saved with a delay and one retry over another tab's write. */
export class VerdictStore {
    private doc: QualityDoc = emptyDoc();
    private chatId: string | null = null;
    private loading: Promise<void> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** Loads the current chat's document (call on start and on chat change). */
    load(): Promise<void> {
        const chatId = this.app.host.chatId();
        this.flushTimer();
        this.chatId = chatId;
        this.doc = emptyDoc();
        if (!chatId || this.app.host.isGroupChat()) {
            this.loading = null;
            return Promise.resolve();
        }
        const pending = this.app.chat
            .get<QualityDoc>(QUALITY_DOC_KIND, emptyDoc)
            .then((doc) => {
                if (this.chatId !== chatId || this.loading !== pending) return;
                const verdicts = Array.isArray(doc.verdicts) ? doc.verdicts.map(readVerdict) : [];
                // Verdicts written before the load finished (a reply checked right after opening the chat) stay.
                const early = this.doc.verdicts;
                doc.version = 1;
                doc.verdicts = [...verdicts.filter((item): item is StoredVerdict => item !== null), ...early];
                this.doc = doc;
                this.trim();
            })
            .catch((error: unknown) => this.log.warn('could not load quality verdicts', error));
        this.loading = pending;
        return pending;
    }

    ready(): Promise<void> {
        return this.loading ?? Promise.resolve();
    }

    currentChat(): string | null {
        return this.chatId;
    }

    all(): StoredVerdict[] {
        return this.doc.verdicts;
    }

    /** The live verdict of a message swipe (not invalidated). */
    live(index: number, swipeId: number): StoredVerdict | undefined {
        for (let i = this.doc.verdicts.length - 1; i >= 0; i--) {
            const verdict = this.doc.verdicts[i] as StoredVerdict;
            if (verdict.messageIndex === index && verdict.swipeId === swipeId && !verdict.invalidated) return verdict;
        }
        return undefined;
    }

    /** Adds a verdict; an older live verdict of the same message swipe is replaced. */
    put(verdict: StoredVerdict): void {
        this.doc.verdicts = this.doc.verdicts.filter(
            (item) =>
                item.invalidated || item.messageIndex !== verdict.messageIndex || item.swipeId !== verdict.swipeId,
        );
        this.doc.verdicts.push(verdict);
        this.trim();
        this.schedule();
    }

    /** Marks live verdicts as no longer applying; returns them. */
    invalidate(match: (verdict: StoredVerdict) => boolean, reason: 'swiped' | 'deleted' | 'edited'): StoredVerdict[] {
        const hit = this.doc.verdicts.filter((verdict) => !verdict.invalidated && match(verdict));
        for (const verdict of hit) verdict.invalidated = reason;
        if (hit.length) this.schedule();
        return hit;
    }

    changed(): void {
        this.schedule();
    }

    /** Writes now (module stop). */
    async flush(): Promise<void> {
        if (this.timer === null) return;
        this.flushTimer();
        await this.save();
    }

    dispose(): void {
        void this.flush();
    }

    private flushTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
            void this.save();
        }
    }

    private trim(): void {
        const extra = this.doc.verdicts.length - MAX_VERDICTS;
        if (extra > 0) this.doc.verdicts.splice(0, extra);
    }

    private schedule(): void {
        if (!this.chatId || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.save();
        }, SAVE_DELAY_MS);
    }

    private async save(): Promise<void> {
        const chatId = this.chatId;
        let doc = this.doc;
        const loading = this.loading;
        if (!chatId) return;
        if (loading) {
            // Verdicts written before the load finished are merged into the loaded document: save that one.
            await loading;
            if (this.chatId === chatId) doc = this.doc;
        }
        try {
            if (await this.app.chat.put(QUALITY_DOC_KIND, doc)) return;
            // Another tab wrote a newer version: take it, keep our newer verdicts on top, write once more.
            const fresh = await this.app.chat.getFor<QualityDoc>(chatId, QUALITY_DOC_KIND, emptyDoc);
            const theirs = Array.isArray(fresh.verdicts) ? fresh.verdicts.map(readVerdict) : [];
            const merged = new Map<string, StoredVerdict>();
            for (const verdict of [...theirs, ...doc.verdicts]) {
                if (verdict) merged.set(`${verdict.messageIndex}:${verdict.swipeId}:${verdict.at}`, verdict);
            }
            fresh.version = 1;
            fresh.verdicts = [...merged.values()].sort((a, b) => a.at - b.at).slice(-MAX_VERDICTS);
            if (this.chatId === chatId) this.doc = fresh;
            if (!(await this.app.chat.put(QUALITY_DOC_KIND, fresh))) this.log.info('quality verdicts: write conflict');
        } catch (error) {
            this.log.warn('could not save quality verdicts', error);
        }
    }
}

/* ------------------------------------------------------------------ statistics */

interface Counters {
    detected: number;
    falsePositives: number;
    autoActions: number;
}

interface StatsFile {
    schema: 1;
    stats: Record<string, Counters>;
}

function zero(): Counters {
    return { detected: 0, falsePositives: 0, autoActions: 0 };
}

function readCounters(value: unknown): Counters {
    const source = isDict(value) ? value : {};
    const num = (key: keyof Counters) => {
        const raw = source[key];
        return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    };
    return { detected: num('detected'), falsePositives: num('falsePositives'), autoActions: num('autoActions') };
}

function add(a: Counters, b: Counters): Counters {
    return {
        detected: a.detected + b.detected,
        falsePositives: a.falsePositives + b.falsePositives,
        autoActions: a.autoActions + b.autoActions,
    };
}

/** Counts per kind: what is on disk plus this tab's unsaved delta. */
export class StatsStore {
    private base = new Map<DefectKind, Counters>();
    private delta = new Map<DefectKind, Counters>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private chain: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    private readonly loaded: Promise<void>;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.loaded = this.read()
            .then((stored) => {
                this.base = stored;
                this.emit();
            })
            .catch((error: unknown) => this.log.warn('could not load quality stats', error));
    }

    ready(): Promise<void> {
        return this.loaded;
    }

    bump(kind: DefectKind, field: keyof Counters, by = 1): void {
        const delta = this.delta.get(kind) ?? zero();
        delta[field] += by;
        this.delta.set(kind, delta);
        this.emit();
        if (this.timer === null) {
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, STATS_SAVE_DELAY_MS);
        }
    }

    list(): QualityStats[] {
        return DEFECT_KINDS.map((kind) => ({
            kind,
            ...add(this.base.get(kind) ?? zero(), this.delta.get(kind) ?? zero()),
        }));
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    flush(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const job = async () => {
            await this.loaded;
            if (this.delta.size === 0) return;
            const pending = this.delta;
            this.delta = new Map();
            try {
                const stored = await this.read();
                for (const [kind, counters] of pending) stored.set(kind, add(stored.get(kind) ?? zero(), counters));
                const file: StatsFile = { schema: 1, stats: Object.fromEntries(stored) };
                await this.app.files.write(this.fileName(), file);
                this.base = stored;
            } catch (error) {
                this.log.warn('could not save quality stats', error);
                for (const [kind, counters] of pending)
                    this.delta.set(kind, add(this.delta.get(kind) ?? zero(), counters));
            }
            this.emit();
        };
        this.chain = this.chain.then(job, job);
        return this.chain;
    }

    private fileName(): string {
        return this.app.files.fileName(STATS_FILE_KIND);
    }

    private async read(): Promise<Map<DefectKind, Counters>> {
        const file = await readFresh<StatsFile>(this.app.files, this.fileName());
        const stored = new Map<DefectKind, Counters>();
        const stats = file && isDict(file.stats) ? file.stats : {};
        for (const kind of DEFECT_KINDS) if (stats[kind]) stored.set(kind, readCounters(stats[kind]));
        return stored;
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('quality stats listener failed', error);
            }
        }
    }
}
