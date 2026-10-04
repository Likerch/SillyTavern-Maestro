// M6 «Канон чата» — the canon lorebook of a chat (plan M6, §4.8, §4.9; audit T1, C1, C2).
//
// Host rules followed here (research/st-world-info.md §6, parity-lore.md):
// - books are read with ctx.loadWorldInfo (a deep clone from ST's cache) and written with
//   saveWorldInfo(name, data, true) only — the debounced save is shared by all books and loses writes; ST keeps the
//   saved object by reference, so it is never touched after the call; then reloadWorldInfoEditor(name) (the editor
//   keeps its own copy) and the DES Lore Library cache reset (DES ignores WORLDINFO_UPDATED);
// - the canon book is created with saveWorldInfo + updateWorldInfoList and never put into any activation list;
// - nothing is written during a generation (P8): writes wait for `generation:ended`, one at a time;
// - every write is journaled with "before"/"after" and undone through the handlers registered here.
import { adaptersOf } from '../../adapters';
import {
    CANON_KINDS,
    DEFAULT_OVERRIDE_FIELDS,
    buildCanonEntry,
    buildExportBook,
    canonBookName,
    canonItemsOf,
    findItemForBase,
    freeUid,
    isDict,
    itemOverrideFields,
    jsonClone,
    materializeOverride,
    overrideFields,
    readCanonMeta,
    uniqueBookName,
    baseDriftOf,
} from '../../domain/canon-book';
import { isCanonBookName } from '../../domain/roles-detect';
import { entryContentHash } from '../../domain/roles-meta';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { BaseDrift, CanonDraft, CanonItem, CanonKind, CanonMeta, CanonOrigin, CanonStatus } from './api';

type Dict = Record<string, unknown>;

export const CANON_KEY = 'canon';
export const CANON_ID = 'M6';
/** Journal targets: an entry of a canon book, an entry of a base book (promote), a book Maestro created. */
export const CANON_ENTRY_TARGET = 'canon-entry';
export const CANON_BASE_TARGET = 'canon-base-entry';
export const CANON_BOOK_TARGET = 'canon-book';
const BOOK_ROLES_KEY = 'bookRoles';
/** How often a queued write re-checks for a generation that ended without `generation:ended`. */
const IDLE_POLL_MS = 2000;

export interface BookState {
    name: string;
    exists: boolean;
    data: Dict | null;
    items: CanonItem[];
}

export interface ListFilter {
    kind?: CanonKind;
    status?: CanonStatus;
    origin?: CanonOrigin;
}

function emptyBook(chatId: string, chatName: string): Dict {
    return { entries: {}, extensions: { maestro: { role: 'canon', chatId, chatName } } };
}

function entriesOf(data: Dict): Dict {
    if (!isDict(data.entries)) data.entries = {};
    return data.entries as Dict;
}

function titleOf(entry: unknown, uid: number): string {
    if (isDict(entry)) {
        if (typeof entry.comment === 'string' && entry.comment.trim()) return entry.comment.trim();
        const key = Array.isArray(entry.key) ? entry.key.find((item) => typeof item === 'string' && item.trim()) : '';
        if (typeof key === 'string' && key) return key;
    }
    return `#${uid}`;
}

export class CanonStore {
    private readonly cache = new Map<string, BookState>();
    private readonly loading = new Map<string, Promise<BookState>>();
    private readonly listeners = new Set<() => void>();
    private chain: Promise<unknown> = Promise.resolve();
    private epoch = 0;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- names and reads */

    /** Canon book of a chat (the current one by default); '' without a chat. */
    bookName(chatId?: string): string {
        const id = chatId ?? this.app.host.chatId();
        return id ? canonBookName(id) : '';
    }

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const { host } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = host.events.name(key);
            if (name) offs.push(host.events.on(name, handler));
        };
        // Our own saves and edits elsewhere (ST's editor, the Lore Studio) both land here.
        on('WORLDINFO_UPDATED', (name, data) => {
            if (typeof name !== 'string' || !isCanonBookName(name)) return;
            if (isDict(data) && isDict(data.entries)) this.remember(name, jsonClone(data));
            else this.invalidate(name);
            this.emit();
        });
        on('CHAT_CHANGED', () => {
            this.invalidate();
            this.emit();
        });
        this.app.journal.registerUndo(CANON_ENTRY_TARGET, (change) => this.undoEntry(change));
        this.app.journal.registerUndo(CANON_BASE_TARGET, (change) => this.undoBaseEntry(change));
        this.app.journal.registerUndo(CANON_BOOK_TARGET, (change) => this.undoBook(change));
        return offs;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('canon listener failed', error);
            }
        }
    }

    invalidate(name?: string): void {
        this.epoch++;
        if (name === undefined) {
            this.cache.clear();
            this.loading.clear();
        } else {
            this.cache.delete(name);
            this.loading.delete(name);
        }
    }

    private remember(name: string, data: Dict | null): BookState {
        const state: BookState = {
            name,
            exists: data !== null,
            data,
            items: data ? (canonItemsOf(data) as unknown as CanonItem[]) : [],
        };
        this.cache.set(name, state);
        this.loading.delete(name);
        return state;
    }

    /** Cached state of a canon book without loading (scan listeners use it when warm). */
    peek(name: string): BookState | undefined {
        return this.cache.get(name);
    }

    /** State of a canon book (cached until WORLDINFO_UPDATED of that book or a chat switch). */
    state(name: string): Promise<BookState> {
        const cached = this.cache.get(name);
        if (cached) return Promise.resolve(cached);
        const pending = this.loading.get(name);
        if (pending) return pending;
        const epoch = this.epoch;
        const job = (async (): Promise<BookState> => {
            const data = await this.readBook(name);
            const state: BookState = {
                name,
                exists: data !== null,
                data,
                items: data ? (canonItemsOf(data) as unknown as CanonItem[]) : [],
            };
            if (epoch === this.epoch) {
                this.cache.set(name, state);
                this.loading.delete(name);
            }
            return state;
        })();
        this.loading.set(name, job);
        return job;
    }

    /** Names of every lorebook, or null when this ST cannot list them. */
    worldNames(): string[] | null {
        const names = this.app.host.ctx().getWorldInfoNames?.();
        return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : null;
    }

    /** A deep copy of any book; null when it is missing or unreadable. */
    async readBook(name: string): Promise<Dict | null> {
        const ctx = this.app.host.ctx();
        const names = this.worldNames();
        if (names && !names.includes(name)) return null;
        if (typeof ctx.loadWorldInfo !== 'function') return null;
        try {
            const data = await ctx.loadWorldInfo(name);
            return isDict(data) && isDict(data.entries) ? data : null;
        } catch (error) {
            this.log.debug(`lorebook ${name} did not load`, error);
            return null;
        }
    }

    async readEntry(book: string, uid: number): Promise<Dict | null> {
        const data = await this.readBook(book);
        const entry = data && isDict(data.entries) ? data.entries[String(uid)] : undefined;
        return isDict(entry) ? entry : null;
    }

    async list(filter: ListFilter = {}): Promise<CanonItem[]> {
        const name = this.bookName();
        if (!name) return [];
        const { items } = await this.state(name);
        return items.filter(
            (item) =>
                (!filter.kind || item.meta.kind === filter.kind) &&
                (!filter.status || item.meta.status === filter.status) &&
                (!filter.origin || item.meta.origin === filter.origin),
        );
    }

    /* ---------------------------------------------------------------- write plumbing */

    /** Resolves when no generation is running (P8); re-checks periodically in case the end event was lost. */
    async idle(): Promise<void> {
        while (this.app.turn.current() !== null) {
            await new Promise<void>((resolve) => {
                let timer: ReturnType<typeof setTimeout> | null = null;
                const off = this.app.bus.on('generation:ended', () => {
                    off();
                    if (timer !== null) clearTimeout(timer);
                    resolve();
                });
                timer = setTimeout(() => {
                    off();
                    resolve();
                }, IDLE_POLL_MS);
            });
        }
    }

    /** Runs writes one at a time, each after the generation in progress (if any) ended. */
    enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = async () => {
            await this.idle();
            return job();
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /** Immediate save of any book, then ST's editor and DES's Lore Library caches are refreshed. */
    async saveBook(name: string, data: Dict, created = false): Promise<void> {
        const ctx = this.app.host.ctx();
        if (typeof ctx.saveWorldInfo !== 'function') throw new Error(this.t('m6.error.noWorldInfo'));
        const snapshot = jsonClone(data);
        // ST caches `data` by reference from here on: never touch it again.
        await ctx.saveWorldInfo(name, data, true);
        if (created) {
            try {
                await ctx.updateWorldInfoList?.();
            } catch (error) {
                this.log.warn('lorebook list was not refreshed', error);
            }
        }
        try {
            ctx.reloadWorldInfoEditor?.(name);
        } catch (error) {
            this.log.debug('lorebook editor was not reloaded', error);
        }
        try {
            adaptersOf(this.app).des.invalidateLoreCache(name);
        } catch (error) {
            this.log.debug('DES Lore Library cache was not reset', error);
        }
        if (isCanonBookName(name)) this.remember(name, snapshot);
    }

    private async journal(kind: string, summary: string, changes: JournalChange[], sourceMessage?: number) {
        try {
            await this.app.journal.record({
                module: CANON_ID,
                kind,
                summary,
                changes,
                ...(sourceMessage !== undefined ? { sourceMessage } : {}),
            });
        } catch (error) {
            this.log.warn(`${kind} was not journaled`, error);
        }
    }

    /** The chat a write belongs to: captured when the write is requested, not when the queue reaches it. */
    private chatInfo(): { chatId: string; chatName: string } {
        const chatId = this.app.host.chatId();
        if (!chatId) throw new Error(this.t('m6.error.noChat'));
        return { chatId, chatName: chatId };
    }

    /* ---------------------------------------------------------------- the book */

    ensureBook(): Promise<string> {
        const chat = this.chatInfo();
        return this.enqueue(() => this.ensureBookNow(chat));
    }

    /** Creates the canon book of a chat when it is missing (call inside the write queue). */
    private async ensureBookNow({ chatId, chatName }: { chatId: string; chatName: string }): Promise<string> {
        const name = canonBookName(chatId);
        const state = await this.state(name);
        if (state.exists) return name;
        await this.saveBook(name, emptyBook(chatId, chatName), true);
        this.log.info(`canon book ${name} created`);
        this.emit();
        return name;
    }

    /* ---------------------------------------------------------------- items */

    async put(draft: CanonDraft, options: { uid?: number } = {}): Promise<number> {
        const kind = draft.meta.kind;
        if (!(CANON_KINDS as readonly string[]).includes(kind)) throw new Error(this.t('m6.error.kind'));
        if (kind !== 'addition' && !draft.meta.base) throw new Error(this.t('m6.error.base'));
        const chat = this.chatInfo();
        // The base is snapshotted as it is now: the override is (re)made against this text (drift starts here).
        const base = draft.meta.base ? await this.readEntry(draft.meta.base.world, draft.meta.base.uid) : null;
        return this.enqueue(async () => {
            const name = await this.ensureBookNow(chat);
            const state = await this.state(name);
            const data = state.data ? jsonClone(state.data) : emptyBook(chat.chatId, chat.chatName);
            const entries = entriesOf(data);
            const existing =
                options.uid !== undefined
                    ? state.items.find((item) => item.uid === options.uid)
                    : findItemForBase(state.items, kind, draft.meta.base);
            const uid = options.uid ?? existing?.uid ?? freeUid(entries);
            const previous = entries[String(uid)];
            const before = isDict(previous) ? jsonClone(previous) : null;
            const previousMeta = before && isDict(before.extensions) ? readCanonMeta(before.extensions.maestro) : null;
            const now = Date.now();
            const meta: CanonMeta = {
                ...draft.meta,
                createdAt: previousMeta?.createdAt ?? now,
                updatedAt: now,
            };
            if (draft.meta.base) {
                meta.base = {
                    world: draft.meta.base.world,
                    uid: draft.meta.base.uid,
                    contentHash: base ? entryContentHash(base) : draft.meta.base.contentHash,
                };
                const content = base ? String(base.content ?? '') : draft.meta.base.content;
                if (content !== undefined) meta.base.content = content;
            }
            if (kind === 'override') {
                const fields = overrideFields(draft.meta.fields, draft.entry);
                meta.fields = fields.length ? fields : [...DEFAULT_OVERRIDE_FIELDS];
            }
            const fallback =
                kind === 'addition' ? '' : `${this.t(`m6.kind.${kind}`)}: ${titleOf(base, meta.base?.uid ?? uid)}`;
            const entry = buildCanonEntry(uid, draft.entry, meta, fallback);
            entries[String(uid)] = entry;
            await this.saveBook(name, data);
            const title = titleOf(entry, uid);
            await this.journal(
                'canon.put',
                this.t(before ? 'm6.journal.update' : 'm6.journal.put', { title }),
                [{ target: CANON_ENTRY_TARGET, ref: { book: name, uid }, before, after: entry }],
                meta.sourceMessage,
            );
            this.emit();
            return uid;
        });
    }

    async remove(uid: number): Promise<void> {
        const name = this.bookName();
        if (!name) return;
        await this.enqueue(async () => {
            const state = await this.state(name);
            if (!state.data) return;
            const data = jsonClone(state.data);
            const entries = entriesOf(data);
            const before = entries[String(uid)];
            if (!isDict(before)) return;
            delete entries[String(uid)];
            await this.saveBook(name, data);
            await this.journal('canon.remove', this.t('m6.journal.remove', { title: titleOf(before, uid) }), [
                { target: CANON_ENTRY_TARGET, ref: { book: name, uid }, before, after: null },
            ]);
            this.emit();
        });
    }

    async setStatus(uid: number, status: CanonStatus): Promise<void> {
        const name = this.bookName();
        if (!name) return;
        await this.enqueue(async () => {
            const state = await this.state(name);
            if (!state.data) return;
            const data = jsonClone(state.data);
            const entries = entriesOf(data);
            const current = entries[String(uid)];
            if (!isDict(current) || !isDict(current.extensions) || !isDict(current.extensions.maestro)) return;
            const raw = current.extensions.maestro;
            if (!readCanonMeta(raw) || raw.status === status) return;
            const before = jsonClone(current);
            const entry: Dict = {
                ...current,
                extensions: { ...current.extensions, maestro: { ...raw, status, updatedAt: Date.now() } },
            };
            entries[String(uid)] = entry;
            await this.saveBook(name, data);
            await this.journal(
                'canon.status',
                this.t('m6.journal.status', { title: titleOf(entry, uid), status: this.t(`m6.status.${status}`) }),
                [{ target: CANON_ENTRY_TARGET, ref: { book: name, uid }, before, after: entry }],
            );
            this.emit();
        });
    }

    /**
     * «Сделать каноном для всех чатов» (plan M6 п. 9, level 'ask'): writes an override's fields (or a suppression as
     * `disable`) into the base book after the user confirms, then drops the item. Refused for read-only books.
     */
    async promote(uid: number): Promise<boolean> {
        const item = (await this.list()).find((candidate) => candidate.uid === uid);
        const base = item?.meta.base;
        if (!item || !base || (item.meta.kind !== 'override' && item.meta.kind !== 'suppress')) return false;
        const roles = this.app.modules.api<BookRolesApi>(BOOK_ROLES_KEY);
        if (roles?.roleOf(base.world)?.readOnly) {
            this.app.ui.notice(this.t('m6.promote.readOnly', { book: base.world }), { level: 'warn' });
            return false;
        }
        const baseEntry = await this.readEntry(base.world, base.uid);
        if (!baseEntry) {
            this.app.ui.notice(this.t('m6.promote.missing', { book: base.world }), { level: 'warn' });
            return false;
        }
        const ok = await this.app.ui.confirm(
            this.t('m6.promote.title'),
            this.t(item.meta.kind === 'override' ? 'm6.promote.body' : 'm6.promote.bodySuppress', {
                book: base.world,
                entry: titleOf(baseEntry, base.uid),
            }),
        );
        if (!ok) return false;
        const canonBook = this.bookName();
        return this.enqueue(async () => {
            const baseData = await this.readBook(base.world);
            const current = baseData && isDict(baseData.entries) ? baseData.entries[String(base.uid)] : undefined;
            if (!baseData || !isDict(current)) return false;
            const data = jsonClone(baseData);
            const before = jsonClone(current);
            const after =
                item.meta.kind === 'override'
                    ? materializeOverride(current, item.entry, itemOverrideFields(item.meta, item.entry))
                    : { ...current, disable: true };
            delete after.world;
            entriesOf(data)[String(base.uid)] = after;
            await this.saveBook(base.world, data);

            const state = await this.state(canonBook);
            const changes: JournalChange[] = [
                { target: CANON_BASE_TARGET, ref: { book: base.world, uid: base.uid }, before, after },
            ];
            if (state.data && isDict(entriesOf(state.data)[String(uid)])) {
                const canonData = jsonClone(state.data);
                const removed = entriesOf(canonData)[String(uid)];
                delete entriesOf(canonData)[String(uid)];
                await this.saveBook(canonBook, canonData);
                changes.push({
                    target: CANON_ENTRY_TARGET,
                    ref: { book: canonBook, uid },
                    before: removed,
                    after: null,
                });
            }
            await this.journal(
                'canon.promote',
                this.t('m6.journal.promote', { title: titleOf(after, base.uid), book: base.world }),
                changes,
            );
            this.emit();
            return true;
        });
    }

    /** Items whose base entry changed (or disappeared) since the item was made. */
    async baseDrift(): Promise<BaseDrift[]> {
        const items = (await this.list()).filter((item) => item.meta.base);
        const books = new Map<string, Dict | null>();
        const drift: BaseDrift[] = [];
        for (const item of items) {
            const base = item.meta.base;
            if (!base) continue;
            if (!books.has(base.world)) books.set(base.world, await this.readBook(base.world));
            const data = books.get(base.world);
            const entry = data && isDict(data.entries) ? data.entries[String(base.uid)] : undefined;
            const changed = baseDriftOf(item, entry);
            if (changed) drift.push({ item, baseThen: changed.then, baseNow: changed.now });
        }
        return drift;
    }

    /** «Экспорт канона» (plan §4.9, audit C1): a plain lorebook "<chat> — канон"; not bound anywhere. */
    async exportPlain(): Promise<string> {
        const name = this.bookName();
        if (!name) throw new Error(this.t('m6.error.noChat'));
        const { chatName } = this.chatInfo();
        return this.exportBook(name, chatName);
    }

    /**
     * «Подготовить к отключению» (plan §4.9): every chat's canon book as a plain lorebook. Books without items are
     * skipped. Returns the created book names.
     */
    async exportAll(): Promise<string[]> {
        const created: string[] = [];
        for (const name of (this.worldNames() ?? []).filter((book) => isCanonBookName(book))) {
            const data = await this.readBook(name);
            if (!data || !canonItemsOf(data).length) continue;
            const extensions = isDict(data.extensions) ? data.extensions : {};
            const meta = isDict(extensions.maestro) ? extensions.maestro : {};
            const chatName = typeof meta.chatName === 'string' && meta.chatName ? meta.chatName : name;
            created.push(await this.exportBook(name, chatName));
        }
        return created;
    }

    private async exportBook(name: string, chatName: string): Promise<string> {
        const { items } = await this.state(name);
        if (!items.length) throw new Error(this.t('m6.export.empty'));
        const books = new Map<string, Dict | null>();
        for (const item of items) {
            const world = item.meta.base?.world;
            if (world && !books.has(world)) books.set(world, await this.readBook(world));
        }
        const baseOf = (world: string, uid: number): Dict | null => {
            const data = books.get(world);
            const entry = data && isDict(data.entries) ? data.entries[String(uid)] : undefined;
            return isDict(entry) ? entry : null;
        };
        const book = buildExportBook(items, baseOf, {
            noteTitle: this.t('m6.export.noteTitle'),
            suppressed: this.t('m6.export.suppressed'),
            overridden: this.t('m6.export.overridden'),
            pinned: this.t('m6.export.pinned'),
            line: (world, uid, comment) => this.t('m6.export.line', { world, uid, comment: comment || '—' }),
        });
        return this.enqueue(async () => {
            const exportName = uniqueBookName(`${chatName} — канон`, this.worldNames() ?? []);
            await this.saveBook(exportName, book, true);
            await this.journal('canon.export', this.t('m6.journal.export', { book: exportName }), [
                { target: CANON_BOOK_TARGET, ref: { book: exportName }, before: null, after: { created: true } },
            ]);
            return exportName;
        });
    }

    /**
     * Copies another canon book into the canon of `chatId` (branches, audit C2). Not journaled here: it is applied
     * through autonomy/Inbox, which journal the proposal's changes. False when the target already exists.
     */
    async copyBook(fromBook: string, chatId: string): Promise<boolean> {
        return this.enqueue(async () => {
            const target = canonBookName(chatId);
            const names = this.worldNames();
            if ((names && names.includes(target)) || (!names && (await this.readBook(target)))) return false;
            const source = await this.readBook(fromBook);
            if (!source) return false;
            const data = jsonClone(source);
            const extensions = isDict(data.extensions) ? data.extensions : {};
            data.extensions = {
                ...extensions,
                maestro: { role: 'canon', chatId, chatName: chatId, copiedFrom: fromBook },
            };
            await this.saveBook(target, data, true);
            this.emit();
            return true;
        });
    }

    /**
     * A base book was renamed (Lore Studio): items of every chat's canon that point at it follow the new name.
     * Returns the number of items moved.
     */
    renameBase(oldName: string, newName: string): Promise<number> {
        return this.enqueue(async () => {
            let moved = 0;
            for (const name of (this.worldNames() ?? []).filter((book) => isCanonBookName(book))) {
                const current = await this.readBook(name);
                if (!current) continue;
                const data = jsonClone(current);
                let changed = false;
                for (const entry of Object.values(entriesOf(data))) {
                    if (!isDict(entry) || !isDict(entry.extensions)) continue;
                    const meta = entry.extensions.maestro;
                    if (!isDict(meta) || !isDict(meta.base) || meta.base.world !== oldName) continue;
                    entry.extensions = {
                        ...entry.extensions,
                        maestro: { ...meta, base: { ...meta.base, world: newName } },
                    };
                    changed = true;
                    moved++;
                }
                if (changed) await this.saveBook(name, data);
            }
            if (moved) this.emit();
            return moved;
        });
    }

    /* ---------------------------------------------------------------- undo */

    private async undoEntry(change: JournalChange): Promise<boolean> {
        const book = change.ref.book;
        const uid = change.ref.uid;
        if (typeof book !== 'string' || !isCanonBookName(book) || typeof uid !== 'number') return false;
        return this.enqueue(async () => {
            const state = await this.state(book);
            if (!state.data && change.before === null) return true;
            const data = state.data ? jsonClone(state.data) : { entries: {} };
            const entries = entriesOf(data);
            if (isDict(change.before)) entries[String(uid)] = jsonClone(change.before);
            else delete entries[String(uid)];
            await this.saveBook(book, data, !state.exists);
            this.emit();
            return true;
        });
    }

    private async undoBaseEntry(change: JournalChange): Promise<boolean> {
        const book = change.ref.book;
        const uid = change.ref.uid;
        if (typeof book !== 'string' || typeof uid !== 'number') return false;
        return this.enqueue(async () => {
            const current = await this.readBook(book);
            if (!current) return false;
            const data = jsonClone(current);
            const entries = entriesOf(data);
            if (isDict(change.before)) entries[String(uid)] = jsonClone(change.before);
            else delete entries[String(uid)];
            await this.saveBook(book, data);
            return true;
        });
    }

    private async undoBook(change: JournalChange): Promise<boolean> {
        const book = change.ref.book;
        if (typeof book !== 'string' || !book) return false;
        return this.enqueue(async () => {
            try {
                const module = await this.app.host.modules.worldInfo();
                const remove = module.deleteWorldInfo;
                if (typeof remove !== 'function') return false;
                // ST's deleteWorldInfo answers false when it does not know the book or the server refused.
                if ((await (remove as (name: string) => Promise<unknown>)(book)) === false) return false;
            } catch (error) {
                this.log.warn(`lorebook ${book} was not deleted`, error);
                return false;
            }
            this.invalidate(book);
            this.emit();
            return true;
        });
    }
}
