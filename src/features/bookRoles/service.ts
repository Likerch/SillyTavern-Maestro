// M35 «Роли книг» (plan M35 п. 1–2, P2, P13; dev-plan 2.1): the role registry and the entry-meta sidecar.
//
// - Roles are detected from names, content and bindings (src/domain/roles-detect.ts) and kept in
//   `maestro-book-roles.json` by book name with a content fingerprint; content facts are reused while the
//   fingerprint is the same; the user's own role always wins (P2: nothing is written into the books).
// - Active books are re-detected after WORLDINFO_UPDATED / WORLDINFO_SETTINGS_UPDATED / CHAT_CHANGED (debounced, never
//   during a generation: P15); every book only on refresh(), or lazily when someone asks for an unknown one.
// - Entry metadata of base books lives in `maestro-entry-meta.json` (`${book}#${uid}` → {meta, contentHash}); it is
//   returned only while the entry content still has that hash (audit A12), otherwise it is reported stale.
// Both files are written with a read-merge-write, so two tabs do not erase each other's changes.
import { readFresh } from '../../core/files';
import {
    bookFingerprint,
    contentFacts,
    detectRole,
    emptyRegistry,
    mergeRegistry,
    packInfo,
    readRegistry,
    roleTraits,
    sameRecord,
} from '../../domain/roles-detect';
import type { RoleContext, RoleRecord, RoleRegistryFile } from '../../domain/roles-detect';
import {
    checkEntryMeta,
    emptyEntryMetaFile,
    entryHashes,
    entryMetaKey,
    mergeEntryMeta,
    parseEntryMetaKey,
    readEntryMetaFile,
} from '../../domain/roles-meta';
import type { EntryMetaFile } from '../../domain/roles-meta';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookRole, BookRoleInfo, BookRolesApi } from './api';
import { activeBooks, loadBook, readRoleContext, worldNames } from './context';

export const BOOK_ROLES_KEY = 'bookRoles';
export const BOOK_ROLES_ID = 'M35r';
export const ROLES_FILE = 'maestro-book-roles.json';
export const ENTRY_META_FILE = 'maestro-entry-meta.json';
/** Journal target of a manual role change (undo restores the previous record). */
export const ROLE_TARGET = 'book-role';

export interface BookRolesOptions {
    saveDelayMs?: number;
    refreshDelayMs?: number;
}

const SAVE_DELAY_MS = 1000;
const REFRESH_DELAY_MS = 400;
/** Books detected between two yields to the event loop during a full refresh. */
const BATCH = 4;

function jsonCopy<T>(value: T): T {
    const text = JSON.stringify(value);
    return text === undefined ? value : (JSON.parse(text) as T);
}

function sameFacts(a: RoleRecord['facts'], b: RoleRecord['facts']): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function isRecord(value: unknown): value is RoleRecord {
    return typeof value === 'object' && value !== null && typeof (value as RoleRecord).role === 'string';
}

export class BookRolesService {
    private registry: RoleRegistryFile = emptyRegistry();
    private readonly dirty = new Set<string>();
    private metaFile: EntryMetaFile = emptyEntryMetaFile();
    private readonly metaDirty = new Set<string>();
    /** Content hashes per book and uid, from the last read of the book. */
    private readonly hashes = new Map<string, Map<number, string>>();
    /** Book data ST reported saved (read lazily for hashes; never mutated). */
    private readonly latest = new Map<string, unknown>();
    private readonly stale = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private readonly pending = new Set<string>();
    private readonly hashLoads = new Map<string, Promise<void>>();
    private pendingActive = false;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private waitingForIdle: Unsubscribe | null = null;
    private loaded: Promise<void> | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private saving: Promise<void> = Promise.resolve();
    private disposed = false;
    private readonly saveDelay: number;
    private readonly refreshDelay: number;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        options: BookRolesOptions = {},
    ) {
        this.saveDelay = options.saveDelayMs ?? SAVE_DELAY_MS;
        this.refreshDelay = options.refreshDelayMs ?? REFRESH_DELAY_MS;
    }

    /* ---------------------------------------------------------------- lifecycle */

    /** Reads both files once (missing files mean empty registries). */
    load(): Promise<void> {
        this.loaded ??= (async () => {
            try {
                this.registry = readRegistry(await readFresh(this.app.files, ROLES_FILE));
            } catch (error) {
                this.log.warn('book roles file could not be read', error);
            }
            try {
                this.metaFile = readEntryMetaFile(await readFresh(this.app.files, ENTRY_META_FILE));
            } catch (error) {
                this.log.warn('entry meta file could not be read', error);
            }
        })();
        return this.loaded;
    }

    /** ST listeners and the undo handler; every disposer must be owned by the module. */
    install(): Unsubscribe[] {
        const { host } = this.app;
        const offs: Unsubscribe[] = [];
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = host.events.name(key);
            if (name) offs.push(host.events.on(name, handler));
        };
        on('WORLDINFO_UPDATED', (name, data) => {
            if (typeof name !== 'string' || !name) return;
            this.latest.set(name, data);
            this.hashes.delete(name);
            this.queue(name);
        });
        on('WORLDINFO_SETTINGS_UPDATED', () => this.queueActive());
        on('CHAT_CHANGED', () => this.queueActive());
        this.app.journal.registerUndo(ROLE_TARGET, (change) => this.undoRole(change));
        return offs;
    }

    /** Starts the first detection of the active books (after the files are read). */
    start(): void {
        void this.load().then(() => this.queueActive());
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        this.waitingForIdle?.();
        this.waitingForIdle = null;
        this.listeners.clear();
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            await this.saveNow();
        }
        await this.saving;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------------------------------------------------------------- roles */

    info(book: string, record: RoleRecord): BookRoleInfo {
        const info: BookRoleInfo = {
            book,
            role: record.role,
            source: record.source,
            fingerprint: record.fingerprint,
            ...roleTraits(record.role),
        };
        if (record.pack) info.pack = { ...record.pack };
        return info;
    }

    roleOf(book: string): BookRoleInfo | undefined {
        const record = this.registry.books[book];
        if (!record) {
            if (book) this.queue(book);
            return undefined;
        }
        return this.info(book, record);
    }

    all(): BookRoleInfo[] {
        return Object.entries(this.registry.books)
            .map(([book, record]) => this.info(book, record))
            .sort((a, b) => (a.book < b.book ? -1 : a.book > b.book ? 1 : 0));
    }

    async setRole(book: string, role: BookRole): Promise<void> {
        if (!book) return;
        if (role === 'unknown') return this.resetRole(book);
        await this.load();
        const before = this.registry.books[book];
        const after: RoleRecord = {
            role,
            source: 'user',
            fingerprint: before?.fingerprint ?? '',
            at: Date.now(),
        };
        if (before?.facts) after.facts = before.facts;
        if (role === 'bunnymo.core' || role === 'bunnymo.pack') after.pack = before?.pack ?? packInfo(book);
        this.put(book, after);
        await this.journal(book, before, after);
    }

    async resetRole(book: string): Promise<void> {
        await this.load();
        const before = this.registry.books[book];
        if (!before || before.source !== 'user') return;
        const auto: RoleRecord = { ...before, source: 'auto' };
        this.put(book, auto);
        await this.detectBooks([book], true);
        await this.journal(book, before, this.registry.books[book] ?? null);
    }

    /** Every lorebook (lazily: a full pass reads each book once; facts are reused while fingerprints match). */
    async refresh(): Promise<void> {
        await this.load();
        const names = worldNames(this.app);
        const books = names ?? (await activeBooks(this.app, this.log));
        if (names) this.prune(new Set(names));
        await this.detectBooks(books, true);
    }

    private put(book: string, record: RoleRecord | null): void {
        if (record) this.registry.books[book] = record;
        else delete this.registry.books[book];
        this.dirty.add(book);
        this.scheduleSave();
        this.emit();
    }

    private async journal(book: string, before: RoleRecord | undefined | null, after: RoleRecord | null) {
        if (sameRecord(before ?? undefined, after ?? undefined)) return;
        const t = this.app.i18n.t.bind(this.app.i18n);
        const role = after ? t(`m35r.role.${after.role}`) : t('m35r.role.unknown');
        try {
            await this.app.journal.record({
                module: BOOK_ROLES_ID,
                kind: 'bookRoles.set',
                summary: t(after?.source === 'user' ? 'm35r.journal.set' : 'm35r.journal.reset', { book, role }),
                changes: [{ target: ROLE_TARGET, ref: { book }, before: before ?? null, after }],
            });
        } catch (error) {
            this.log.warn('role change was not journaled', error);
        }
    }

    private async undoRole(change: JournalChange): Promise<boolean> {
        const book = change.ref.book;
        if (typeof book !== 'string' || !book) return false;
        await this.load();
        const before = isRecord(change.before) ? readRegistry({ books: { [book]: change.before } }).books[book] : null;
        this.put(book, before ?? null);
        if (!before) this.queue(book);
        return true;
    }

    /** Auto records of books that no longer exist are dropped; the user's own records are kept. */
    private prune(existing: ReadonlySet<string>): void {
        let changed = false;
        for (const [book, record] of Object.entries(this.registry.books)) {
            if (existing.has(book) || record.source === 'user') continue;
            delete this.registry.books[book];
            this.dirty.add(book);
            changed = true;
        }
        if (changed) {
            this.scheduleSave();
            this.emit();
        }
    }

    /* ---------------------------------------------------------------- detection */

    /** Re-detects one book soon (debounced). */
    queue(book: string): void {
        if (this.disposed) return;
        this.pending.add(book);
        this.scheduleRefresh();
    }

    /** Re-detects the active books soon (debounced). */
    queueActive(): void {
        if (this.disposed) return;
        this.pendingActive = true;
        this.scheduleRefresh();
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer !== null || this.waitingForIdle) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.flushQueue();
        }, this.refreshDelay);
    }

    /** Runs the queued detections, or waits for the generation in progress to end first (P15). */
    async flushQueue(): Promise<void> {
        if (this.disposed) return;
        if (this.app.turn.current() !== null) {
            if (!this.waitingForIdle) {
                const off = this.app.bus.on('generation:ended', () => {
                    off();
                    if (this.waitingForIdle === off) this.waitingForIdle = null;
                    this.scheduleRefresh();
                });
                this.waitingForIdle = off;
            }
            return;
        }
        const books = new Set(this.pending);
        this.pending.clear();
        if (this.pendingActive) {
            this.pendingActive = false;
            for (const book of await activeBooks(this.app, this.log)) books.add(book);
        }
        if (books.size) await this.detectBooks([...books], false);
    }

    /** Detects books one by one (serialised with other runs); emits once when anything changed. */
    detectBooks(books: readonly string[], yieldBetween: boolean): Promise<void> {
        const job = async () => {
            await this.load();
            let context: RoleContext | null = null;
            let changed = false;
            let count = 0;
            for (const book of books) {
                if (this.disposed) return;
                context ??= await readRoleContext(this.app, this.log);
                if (await this.detect(book, context)) changed = true;
                if (yieldBetween && ++count % BATCH === 0) await new Promise((resolve) => setTimeout(resolve, 0));
            }
            // Facts or fingerprints may change without a visible change: still saved, but nobody is told.
            if (this.dirty.size) this.scheduleSave();
            if (changed) this.emit();
        };
        const next = this.chain.then(job, job);
        this.chain = next.catch((error: unknown) => this.log.warn('role detection failed', error));
        return next;
    }

    private async detect(book: string, context: RoleContext): Promise<boolean> {
        const data = await loadBook(this.app, book, this.log);
        if (data) {
            this.hashes.set(book, entryHashes(data));
            this.latest.delete(book);
        }
        const previous = this.registry.books[book];
        const fingerprint = data ? bookFingerprint(data) : (previous?.fingerprint ?? '');
        const facts =
            previous?.facts && previous.fingerprint === fingerprint && fingerprint
                ? previous.facts
                : data
                  ? contentFacts(book, data)
                  : (previous?.facts ?? null);
        const role =
            previous?.source === 'user'
                ? previous.role
                : detectRole(book, facts, context, previous, data ? fingerprint : undefined);
        const next: RoleRecord = {
            role,
            source: previous?.source ?? 'auto',
            fingerprint,
            at: Date.now(),
        };
        if (facts) next.facts = facts;
        if (role === 'bunnymo.core' || role === 'bunnymo.pack') next.pack = previous?.pack ?? packInfo(book);
        const visible = !sameRecord(previous, next);
        if (!visible && previous?.facts && sameFacts(previous.facts, next.facts)) return false;
        this.registry.books[book] = next;
        this.dirty.add(book);
        return visible;
    }

    /* ---------------------------------------------------------------- entry meta */

    entryMeta<T = Record<string, unknown>>(book: string, uid: number): T | undefined {
        const key = entryMetaKey(book, uid);
        const record = this.metaFile.entries[key];
        if (!record) return undefined;
        const checked = checkEntryMeta(record, this.currentHash(book, uid));
        if (checked.state === 'unknown') {
            void this.loadHashes(book);
            return undefined;
        }
        if (checked.state === 'stale') {
            if (!this.stale.has(key)) {
                this.stale.add(key);
                queueMicrotask(() => this.emit());
            }
            return undefined;
        }
        if (this.stale.delete(key)) queueMicrotask(() => this.emit());
        return jsonCopy(checked.meta) as T;
    }

    async loadEntryMeta<T = Record<string, unknown>>(book: string, uid: number): Promise<T | undefined> {
        await this.load();
        if (this.currentHash(book, uid) === undefined) await this.loadHashes(book);
        return this.entryMeta<T>(book, uid);
    }

    async setEntryMeta(book: string, uid: number, meta: Record<string, unknown> | undefined): Promise<void> {
        await this.load();
        const key = entryMetaKey(book, uid);
        if (meta === undefined) {
            if (!this.metaFile.entries[key]) return;
            delete this.metaFile.entries[key];
        } else {
            const data = await loadBook(this.app, book, this.log);
            if (!data) throw new Error(this.app.i18n.t('m35r.error.noBook', { book }));
            const hashes = entryHashes(data);
            this.hashes.set(book, hashes);
            const contentHash = hashes.get(uid);
            if (contentHash === undefined) throw new Error(this.app.i18n.t('m35r.error.noEntry', { book, uid }));
            this.metaFile.entries[key] = { meta: jsonCopy(meta), contentHash, at: Date.now() };
        }
        this.stale.delete(key);
        this.metaDirty.add(key);
        this.scheduleSave();
        this.emit();
    }

    /** A book was renamed (Lore Studio): its role record and entry metadata move to the new name. */
    async renameBook(oldName: string, newName: string): Promise<void> {
        await this.load();
        const record = this.registry.books[oldName];
        if (record) {
            this.put(newName, { ...record });
            this.put(oldName, null);
        }
        for (const [key, value] of Object.entries(this.metaFile.entries)) {
            const parsed = parseEntryMetaKey(key);
            if (!parsed || parsed.book !== oldName) continue;
            const moved = entryMetaKey(newName, parsed.uid);
            this.metaFile.entries[moved] = value;
            delete this.metaFile.entries[key];
            this.metaDirty.add(key);
            this.metaDirty.add(moved);
            if (this.stale.delete(key)) this.stale.add(moved);
        }
        const hashes = this.hashes.get(oldName);
        if (hashes) {
            this.hashes.set(newName, hashes);
            this.hashes.delete(oldName);
        }
        this.scheduleSave();
        this.emit();
    }

    staleEntryMeta(): { book: string; uid: number }[] {
        return [...this.stale]
            .map((key) => parseEntryMetaKey(key))
            .filter((item): item is { book: string; uid: number } => item !== null);
    }

    /** Hash of an entry's content as last read; '' when the book is known and the entry is gone; undefined if unknown. */
    private currentHash(book: string, uid: number): string | undefined {
        let hashes = this.hashes.get(book);
        if (!hashes && this.latest.has(book)) {
            hashes = entryHashes(this.latest.get(book));
            this.hashes.set(book, hashes);
            this.latest.delete(book);
        }
        if (!hashes) return undefined;
        return hashes.get(uid) ?? '';
    }

    private loadHashes(book: string): Promise<void> {
        let pending = this.hashLoads.get(book);
        if (!pending) {
            pending = (async () => {
                const data = await loadBook(this.app, book, this.log);
                this.hashes.set(book, data ? entryHashes(data) : new Map());
                this.emit();
            })().finally(() => this.hashLoads.delete(book));
            this.hashLoads.set(book, pending);
        }
        return pending;
    }

    /* ---------------------------------------------------------------- persistence */

    private scheduleSave(): void {
        if (this.disposed && this.saveTimer === null) {
            void this.saveNow();
            return;
        }
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.saveNow();
        }, this.saveDelay);
    }

    /** Writes pending changes of both files (read-merge-write). */
    saveNow(): Promise<void> {
        const job = async () => {
            const roles = new Set(this.dirty);
            this.dirty.clear();
            if (roles.size) {
                try {
                    const stored = readRegistry(await readFresh(this.app.files, ROLES_FILE));
                    const merged = mergeRegistry(stored, this.registry, roles);
                    await this.app.files.write(ROLES_FILE, merged);
                    this.registry = merged;
                } catch (error) {
                    for (const book of roles) this.dirty.add(book);
                    this.log.warn('book roles were not saved', error);
                }
            }
            const metas = new Set(this.metaDirty);
            this.metaDirty.clear();
            if (metas.size) {
                try {
                    const stored = readEntryMetaFile(await readFresh(this.app.files, ENTRY_META_FILE));
                    const merged = mergeEntryMeta(stored, this.metaFile, metas);
                    await this.app.files.write(ENTRY_META_FILE, merged);
                    this.metaFile = merged;
                } catch (error) {
                    for (const key of metas) this.metaDirty.add(key);
                    this.log.warn('entry meta was not saved', error);
                }
            }
        };
        const next = this.saving.then(job, job);
        this.saving = next.catch(() => undefined);
        return next;
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('book roles listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- facade */

    api(): Required<BookRolesApi> {
        return {
            roleOf: (book) => this.roleOf(book),
            all: () => this.all(),
            setRole: (book, role) => this.setRole(book, role),
            refresh: () => this.refresh(),
            entryMeta: <T = Record<string, unknown>>(book: string, uid: number) => this.entryMeta<T>(book, uid),
            setEntryMeta: (book, uid, meta) => this.setEntryMeta(book, uid, meta),
            onChange: (listener) => this.onChange(listener),
            resetRole: (book) => this.resetRole(book),
            loadEntryMeta: <T = Record<string, unknown>>(book: string, uid: number) => this.loadEntryMeta<T>(book, uid),
            staleEntryMeta: () => this.staleEntryMeta(),
            renameBook: (oldName, newName) => this.renameBook(oldName, newName),
        };
    }
}
