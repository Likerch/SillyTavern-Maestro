// Criterion 10 (plan §14, P13): BunnyMo pack files stay byte-for-byte what their author shipped. M21m fingerprints
// every BunnyMo core and pack book the first time it sees it (`maestro-metrics-packs.json`, global) and compares the
// files with those fingerprints on demand. Reads only: the books are fetched from the server, never written.
// On the bench tools/stand/measure.mjs compares the installed files with the pinned BunnyMo export byte by byte.
import { readFresh } from '../../core/files';
import { comparePacks } from '../../domain/metrics-checks';
import type { PackComparison, PackFingerprint } from '../../domain/metrics-checks';
import type { App } from '../../shared/contracts';
import { bunnymoBooks, fingerprint } from './sources';

export const PACKS_FILE_KIND = 'metrics-packs';

interface PackFile {
    v: 1;
    books: Record<string, PackFingerprint>;
}

export interface PackStoreDeps {
    readBook(name: string): Promise<string | null>;
    now(): number;
}

export class PackStore {
    private last: { at: number; comparison: PackComparison } | null = null;

    constructor(
        private readonly app: App,
        private readonly deps: PackStoreDeps,
    ) {}

    /** The latest comparison of this page, if any. */
    lastCheck(): { at: number; comparison: PackComparison } | null {
        return this.last;
    }

    private fileName(): string {
        return this.app.files.fileName(PACKS_FILE_KIND);
    }

    private async read(): Promise<PackFile> {
        const raw = await readFresh<PackFile>(this.app.files, this.fileName());
        const books: Record<string, PackFingerprint> = {};
        if (raw && typeof raw === 'object' && raw.books && typeof raw.books === 'object') {
            for (const [name, value] of Object.entries(raw.books)) {
                if (value && typeof value.hash === 'string' && typeof value.bytes === 'number') {
                    books[name] = { hash: value.hash, bytes: value.bytes, at: Number(value.at) || 0 };
                }
            }
        }
        return { v: 1, books };
    }

    private async fingerprints(names: readonly string[]): Promise<Record<string, PackFingerprint | null>> {
        const result: Record<string, PackFingerprint | null> = {};
        for (const name of names) {
            const text = await this.deps.readBook(name);
            result[name] = text === null ? null : fingerprint(text, this.deps.now());
        }
        return result;
    }

    /** Merged into what is on disk now (another tab may have added books); `replace` starts from scratch. */
    private async store(taken: Record<string, PackFingerprint | null>, replace: boolean): Promise<number> {
        const latest: PackFile = replace ? { v: 1, books: {} } : await this.read();
        let added = 0;
        for (const [name, value] of Object.entries(taken)) {
            if (!value || (!replace && latest.books[name])) continue;
            latest.books[name] = value;
            added++;
        }
        if (added || replace) await this.app.files.write(this.fileName(), latest);
        return added;
    }

    /** Fingerprints BunnyMo books that have none yet; stored fingerprints are never replaced here. */
    async capture(): Promise<number> {
        const books = bunnymoBooks(this.app);
        if (!books.length) return 0;
        const stored = await this.read();
        const missing = books.filter((name) => !stored.books[name]);
        if (!missing.length) return 0;
        return this.store(await this.fingerprints(missing), false);
    }

    /** Reads every known book now and compares; books seen for the first time get their fingerprint stored. */
    async check(): Promise<PackComparison | null> {
        const stored = await this.read();
        const names = [...new Set([...Object.keys(stored.books), ...bunnymoBooks(this.app)])].sort();
        if (!names.length) return null;
        const current = await this.fingerprints(names);
        const comparison = comparePacks(stored.books, current);
        if (comparison.added.length) {
            await this.store(Object.fromEntries(comparison.added.map((name) => [name, current[name] ?? null])), false);
        }
        this.last = { at: this.deps.now(), comparison };
        return comparison;
    }

    /** The current files become the reference (after an intended pack update by its author). */
    async accept(): Promise<void> {
        const stored = await this.read();
        const names = [...new Set([...Object.keys(stored.books), ...bunnymoBooks(this.app)])];
        await this.store(await this.fingerprints(names), true);
        this.last = null;
    }
}
