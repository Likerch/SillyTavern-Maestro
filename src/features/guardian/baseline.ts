// The baseline file `maestro-baseline.json` (user files, plan §4.8): the tracked snapshot, when and why it was
// taken, and the drift sets the user dismissed. One file for the whole account (settings are global), read fresh
// before every change so two tabs merge instead of overwriting each other.
//
// Schema 2 holds system settings only (tracked.ts SCOPE). A schema 1 file (M4 before the scope) is migrated, not
// thrown away: its values pass through today's rules (migrateTracked), its dismissed drifts are forgotten (their
// hashes covered other paths), and paths it could not hold (ADOPT_WHEN_MISSING) take their live values silently
// the first time the file is settled against the live settings (settleBaseline).
import { readFresh } from '../../core/files';
import { pathMatches } from '../../domain/settings-diff';
import type { TrackedPart } from '../../domain/settings-diff';
import type { FileStore, Logger } from '../../shared/contracts';
import { ADOPT_WHEN_MISSING, migrateTracked, pruneScope } from './tracked';

export const BASELINE_FILE = 'maestro-baseline.json';
export const BASELINE_SCHEMA = 2;
const DISMISSED_LIMIT = 20;

export interface BaselineFile extends TrackedPart {
    schema: typeof BASELINE_SCHEMA;
    takenAt: number;
    reason: string;
    /** Drift hashes whose Inbox card was dismissed: not proposed again until the drift changes. */
    dismissed: string[];
    /**
     * Patterns of paths an older baseline could not hold (set by the schema 1 migration): a live value of such a
     * path missing from the baseline is taken in silently, once, by settleBaseline.
     */
    adoptMissing?: string[];
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Validates a stored file (migrating schema 1); null for anything that is not a baseline. */
export function readBaseline(raw: unknown): BaselineFile | null {
    if (!isDict(raw) || !isDict(raw.values)) return null;
    if (raw.schema !== 1 && raw.schema !== BASELINE_SCHEMA) return null;
    const old = raw.schema === 1;
    const stored: TrackedPart = { values: raw.values, restore: isDict(raw.restore) ? raw.restore : {} };
    const part = old ? migrateTracked(stored) : stored;
    const file: BaselineFile = {
        schema: BASELINE_SCHEMA,
        takenAt: typeof raw.takenAt === 'number' ? raw.takenAt : 0,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        values: part.values,
        restore: part.restore,
        dismissed: old ? [] : strings(raw.dismissed),
    };
    const adopt = old ? [...ADOPT_WHEN_MISSING] : strings(raw.adoptMissing);
    if (adopt.length) file.adoptMissing = adopt;
    return file;
}

/**
 * Brings a stored baseline in line with the scope against a live snapshot (in place): paths outside the scope go,
 * and paths of `adoptMissing` that the baseline lacks take their live values (no «added» drift for paths an older
 * baseline could not hold). True when the file changed and should be written.
 */
export function settleBaseline(file: BaselineFile, current: TrackedPart): boolean {
    let changed = pruneScope(file);
    const patterns = file.adoptMissing;
    if (patterns) {
        for (const [path, value] of Object.entries(current.values)) {
            if (Object.hasOwn(file.values, path) || !pathMatches(path, patterns)) continue;
            file.values[path] = value;
            if (Object.hasOwn(current.restore, path)) file.restore[path] = current.restore[path];
        }
        delete file.adoptMissing;
        changed = true;
    }
    return changed;
}

export class BaselineStore {
    /** undefined = not loaded yet. */
    private cached: BaselineFile | null | undefined = undefined;
    private chain: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly files: FileStore,
        private readonly log: Logger,
    ) {}

    current(): BaselineFile | null {
        return this.cached ?? null;
    }

    loaded(): boolean {
        return this.cached !== undefined;
    }

    async load(fresh = false): Promise<BaselineFile | null> {
        if (!fresh && this.cached !== undefined) return this.cached;
        try {
            this.cached = readBaseline(await readFresh(this.files, BASELINE_FILE));
        } catch (error) {
            this.log.warn('baseline could not be read', error);
            if (this.cached === undefined) this.cached = null;
        }
        return this.cached;
    }

    /** Replaces the file. */
    save(file: BaselineFile): Promise<void> {
        return this.serial(async () => {
            await this.files.write(BASELINE_FILE, file);
            this.cached = file;
        });
    }

    /** Read-modify-write; `change` returns false when nothing changed (no write). */
    update(change: (file: BaselineFile) => boolean): Promise<BaselineFile | null> {
        return this.serial(async () => {
            const file = await this.load(true);
            if (!file || !change(file)) return file;
            await this.files.write(BASELINE_FILE, file);
            this.cached = file;
            return file;
        });
    }

    dismiss(hash: string): Promise<BaselineFile | null> {
        return this.update((file) => {
            if (file.dismissed.includes(hash)) return false;
            file.dismissed.push(hash);
            if (file.dismissed.length > DISMISSED_LIMIT)
                file.dismissed.splice(0, file.dismissed.length - DISMISSED_LIMIT);
            return true;
        });
    }

    private serial<R>(job: () => Promise<R>): Promise<R> {
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }
}
