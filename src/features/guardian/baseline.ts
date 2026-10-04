// The baseline file `maestro-baseline.json` (user files, plan §4.8): the tracked snapshot, when and why it was
// taken, and the drift sets the user dismissed. One file for the whole account (settings are global), read fresh
// before every change so two tabs merge instead of overwriting each other.
import { readFresh } from '../../core/files';
import type { TrackedPart } from '../../domain/settings-diff';
import type { FileStore, Logger } from '../../shared/contracts';

export const BASELINE_FILE = 'maestro-baseline.json';
const DISMISSED_LIMIT = 20;

export interface BaselineFile extends TrackedPart {
    schema: 1;
    takenAt: number;
    reason: string;
    /** Drift hashes whose Inbox card was dismissed: not proposed again until the drift changes. */
    dismissed: string[];
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a stored file; null for anything that is not a baseline. */
export function readBaseline(raw: unknown): BaselineFile | null {
    if (!isDict(raw) || raw.schema !== 1 || !isDict(raw.values)) return null;
    return {
        schema: 1,
        takenAt: typeof raw.takenAt === 'number' ? raw.takenAt : 0,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        values: raw.values,
        restore: isDict(raw.restore) ? raw.restore : {},
        dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((item) => typeof item === 'string') : [],
    };
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
