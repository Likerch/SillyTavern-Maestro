// M25 «Механики», definitions part (plan M25 п. 1, 7; §2.1 «Механики: правила»; P2, P13, P16): the user's mechanics
// live as entries of type 'mechanic' in Maestro books (role 'maestro'), with the definition in
// `extensions.maestro.mechanic`. The entries are disabled — ST never scans them; Maestro injects the rules itself, near
// the end of the prompt. Here: the cache of every definition (refreshed on WORLDINFO_UPDATED, chat change and role
// changes — never on the send path), scope filtering, the per-chat switch (a pointer in chat metadata), saves into the
// settings' book (created with the role 'maestro' and never activated), removal, and the journal undo.
//
// Host rules (ARCHITECTURE «Lorebook writes»): a fresh copy is loaded, changed and saved at once with
// saveWorldInfo(name, data, true); then ST's editor is reloaded and DES's Lore Library cache reset (dossier/book-io).
// BunnyMo books are never written (P13): role, adapter and content are checked right before every write.
import { adaptersOf } from '../../adapters';
import type { BookData } from '../../domain/doctor-fixes';
import { isBunnyMoBook } from '../../domain/doctor-fixes';
import {
    cloneDef,
    defToEntry,
    entryToDef,
    hasErrors,
    isMechanicEntry,
    normalizeDef,
    scopeMatches,
    uniqueId,
    validateDef,
} from '../../domain/mechanics-defs';
import type { DefIssue, ScopeContext } from '../../domain/mechanics-defs';
import { isCanonBookName, isMaestroBookName } from '../../domain/roles-detect';
import type { App, JournalChange, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import { bookIo } from '../dossier/book-io';
import type { DossierBookIo } from '../dossier/book-io';
import type { MechanicDef } from './api';
import { DEFAULT_MECHANICS_BOOK, MECHANICS_ID } from './parts';
import type { DefinitionsPart, PartDeps } from './parts';

type Dict = Record<string, unknown>;

/** Journal target of a definition entry (ref: {book, uid, id}). */
export const MECHANICS_DEF_TARGET = 'mechanics.def';
/** Chat-metadata pointer (`chatMetadata.maestro.pointers`) with the ids switched off in that chat. */
export const MECHANICS_OFF_POINTER = 'mechanics.off';
const BOOK_ROLES_KEY = 'bookRoles';

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where the open chat is: its character's avatar (every member's in a group chat) and its id. */
export function scopeContextOf(app: App): ScopeContext {
    const ctx = app.host.ctx();
    const avatars: string[] = [];
    if (ctx.groupId) {
        const group = (ctx.groups ?? []).find((item) => item.id === ctx.groupId);
        for (const member of group?.members ?? []) if (typeof member === 'string' && member) avatars.push(member);
    } else if (ctx.characterId !== undefined && ctx.characterId !== null && ctx.characterId !== '') {
        const avatar = ctx.characters?.[Number(ctx.characterId)]?.avatar;
        if (typeof avatar === 'string' && avatar) avatars.push(avatar);
    }
    return { avatars, chatId: app.host.chatId() };
}

/** The definitions of a book's mechanic entries, by uid. */
function defsOfBook(book: string, data: unknown): MechanicDef[] {
    if (!isDict(data) || !isDict(data.entries)) return [];
    const defs: MechanicDef[] = [];
    for (const entry of Object.values(data.entries)) {
        const def = entryToDef(entry, book);
        if (def) defs.push(def);
    }
    return defs.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
}

function freeUid(entries: Dict): number {
    let uid = 0;
    while (Object.prototype.hasOwnProperty.call(entries, String(uid))) uid++;
    return uid;
}

export class MechanicDefinitions implements DefinitionsPart {
    private readonly byBook = new Map<string, MechanicDef[]>();
    /** Bumped on every direct update of a book, so a slower load does not overwrite fresher data. */
    private readonly versions = new Map<string, number>();
    private merged: MechanicDef[] = [];
    private readonly listeners = new Set<() => void>();
    private readonly offs: Unsubscribe[] = [];
    private chain: Promise<unknown> = Promise.resolve();
    private syncing: Promise<void> | null = null;
    private resync = false;
    private disposed = false;

    constructor(private readonly deps: PartDeps) {}

    private get app(): App {
        return this.deps.app;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private roles(): BookRolesApi | undefined {
        try {
            return this.app.modules.api<BookRolesApi>(BOOK_ROLES_KEY);
        } catch {
            return undefined;
        }
    }

    private io(): DossierBookIo {
        const io = bookIo(this.app, this.deps.log);
        if (!io) throw new Error(this.t('m25.def.error.noWorldInfo'));
        return io;
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): void {
        const { host } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = host.events.name(key);
            if (name) this.offs.push(host.events.on(name, handler));
        };
        // Our own saves, ST's editor and the Lore Studio all land here (ST passes the saved data).
        on('WORLDINFO_UPDATED', (name, data) => this.onBookUpdated(name, data));
        on('CHAT_CHANGED', () => {
            void this.sync();
            this.emit();
        });
        const roles = this.roles();
        if (roles) this.offs.push(roles.onChange(() => void this.sync()));
        this.app.journal.registerUndo(MECHANICS_DEF_TARGET, (change) => this.undo(change));
        void this.sync();
    }

    dispose(): void {
        this.disposed = true;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('mechanics: listener removal failed', error);
            }
        }
        this.listeners.clear();
    }

    /** Resolves when the books known now are read (tests, the constructor's first draw). */
    ready(): Promise<void> {
        return this.syncing ?? Promise.resolve();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        if (this.disposed) return;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.deps.log.error('mechanics: definitions listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- books */

    private worldNames(): string[] | null {
        try {
            const names = this.app.host.ctx().getWorldInfoNames?.();
            return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : null;
        } catch {
            return null;
        }
    }

    /**
     * Books that hold definitions: every book with the role 'maestro', books named «Maestro · …» (not canon) whose role
     * the user did not change, and the settings' book. Never BunnyMo or canon books.
     */
    candidates(): string[] {
        const names = this.worldNames();
        let roles: { book: string; role: string }[] = [];
        try {
            roles = this.roles()?.all() ?? [];
        } catch (error) {
            this.deps.log.debug('mechanics: book roles are not available', error);
        }
        const roleOf = new Map(roles.map((info) => [info.book, info.role]));
        const fits = (book: string) => {
            const role = roleOf.get(book);
            return (role === undefined || role === 'maestro') && !isCanonBookName(book);
        };
        const out = new Set<string>();
        for (const [book, role] of roleOf) if (role === 'maestro') out.add(book);
        for (const name of names ?? []) if (isMaestroBookName(name) && fits(name)) out.add(name);
        const own = this.deps.settings().book;
        if (own && fits(own)) out.add(own);
        // ST's list may lag behind a book we have just created (it is refreshed after the save), so the settings' book
        // and the books already read are kept; a book that does not exist loads as nothing.
        const listed = (book: string) =>
            names === null || names.includes(book) || book === own || this.byBook.has(book);
        return [...out].filter((book) => !isCanonBookName(book) && listed(book)).sort();
    }

    private bump(book: string): void {
        this.versions.set(book, (this.versions.get(book) ?? 0) + 1);
    }

    private async load(book: string): Promise<BookData | null> {
        try {
            return await this.io().load(book);
        } catch (error) {
            this.deps.log.debug(`mechanics: lorebook ${book} did not load`, error);
            return null;
        }
    }

    /** Reads books that became candidates and drops those that stopped being ones (one pass at a time). */
    sync(): Promise<void> {
        if (this.syncing) {
            this.resync = true;
            return this.syncing;
        }
        const job = (async () => {
            do {
                this.resync = false;
                await this.syncOnce();
            } while (this.resync && !this.disposed);
        })();
        this.syncing = job.finally(() => {
            this.syncing = null;
        });
        return this.syncing;
    }

    private async syncOnce(): Promise<void> {
        const wanted = new Set(this.candidates());
        let changed = false;
        for (const book of [...this.byBook.keys()]) {
            if (wanted.has(book)) continue;
            this.byBook.delete(book);
            changed = true;
        }
        for (const book of wanted) {
            if (this.byBook.has(book) || this.disposed) continue;
            const version = this.versions.get(book) ?? 0;
            const data = await this.load(book);
            if (this.disposed) return;
            if ((this.versions.get(book) ?? 0) !== version && this.byBook.has(book)) continue;
            this.byBook.set(book, defsOfBook(book, data));
            changed = true;
        }
        if (changed) {
            this.rebuild();
            this.emit();
        }
    }

    private onBookUpdated(name: unknown, data: unknown): void {
        if (typeof name !== 'string' || !name || this.disposed) return;
        if (!this.candidates().includes(name)) {
            if (this.byBook.delete(name)) {
                this.bump(name);
                this.rebuild();
                this.emit();
            }
            return;
        }
        this.bump(name);
        if (isDict(data) && isDict(data.entries)) {
            this.store(name, data);
            return;
        }
        this.byBook.delete(name);
        void this.sync();
    }

    /** Re-reads the definitions of a book from data just saved or received (nothing of `data` is kept). */
    private store(book: string, data: unknown): void {
        this.byBook.set(book, defsOfBook(book, data));
        this.rebuild();
        this.emit();
    }

    /** All definitions in book order; a repeated id (a copied entry) gets `_2`… in memory and is repaired on save. */
    private rebuild(): void {
        const all: MechanicDef[] = [];
        const taken = new Set<string>();
        for (const book of [...this.byBook.keys()].sort()) {
            for (const def of this.byBook.get(book) ?? []) {
                const id = taken.has(def.id) ? uniqueId(def.id, taken) : def.id;
                if (id !== def.id) this.deps.log.warn(`mechanics: id ${def.id} repeats in ${book} #${def.uid}`);
                taken.add(id);
                all.push(id === def.id ? def : { ...def, id });
            }
        }
        this.merged = all;
    }

    /* ---------------------------------------------------------------- reads */

    /** Every definition in every Maestro book, whatever its scope (copies). */
    all(): MechanicDef[] {
        return this.merged.map((def) => cloneDef(def));
    }

    list(): MechanicDef[] {
        const context = scopeContextOf(this.app);
        return this.merged.filter((def) => scopeMatches(def.scope, context)).map((def) => cloneDef(def));
    }

    /** Ids switched off in this chat. */
    offIds(): string[] {
        let value: unknown;
        try {
            value = this.app.chat.pointer<unknown>(MECHANICS_OFF_POINTER);
        } catch {
            value = undefined;
        }
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    }

    isEnabledInChat(id: string): boolean {
        return !this.offIds().includes(id);
    }

    active(): MechanicDef[] {
        const off = new Set(this.offIds());
        return this.list().filter((def) => !off.has(def.id));
    }

    /** A visible definition, else any definition with that id. */
    get(id: string): MechanicDef | null {
        const found = this.list().find((def) => def.id === id) ?? this.merged.find((def) => def.id === id);
        return found ? cloneDef(found) : null;
    }

    /* ---------------------------------------------------------------- writes */

    /** Runs writes one at a time. */
    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /** BunnyMo core or pack (P13): by its role, the BunnyMo adapter or the book's content. */
    private isProtected(book: string, data: BookData | null): boolean {
        try {
            const info = this.roles()?.roleOf(book);
            if (info && (info.readOnly || info.role === 'bunnymo.core' || info.role === 'bunnymo.pack')) return true;
        } catch (error) {
            this.deps.log.debug('mechanics: role check failed', error);
        }
        try {
            const books = adaptersOf(this.app).bunnymo.books();
            if (books.core.includes(book) || books.packs.includes(book)) return true;
        } catch (error) {
            this.deps.log.debug('mechanics: BunnyMo books are not known', error);
        }
        return !!data && isBunnyMoBook(book, data);
    }

    private issueText(issue: DefIssue): string {
        return this.t(`m25.def.issue.${issue.code}`, issue.params);
    }

    private async journal(action: { kind: string; summary: string; changes: JournalChange[] }): Promise<void> {
        try {
            await this.app.journal.record({ module: MECHANICS_ID, ...action });
        } catch (error) {
            this.deps.log.warn(`mechanics: ${action.kind} was not journaled`, error);
        }
    }

    /**
     * Creates or updates a definition: validated, written into its book (or the settings' book, created with the
     * role 'maestro' when missing), updated in place by uid, journaled with undo. Returns the stored definition.
     */
    save(def: MechanicDef): Promise<MechanicDef> {
        const draft = normalizeDef(def);
        if (!draft)
            return Promise.reject(new Error(this.t('m25.def.error.invalid', { issue: this.t('m25.def.issue.id') })));
        const issues = validateDef(draft);
        if (hasErrors(issues)) {
            const first = issues.find((issue) => issue.level === 'error') as DefIssue;
            return Promise.reject(new Error(this.t('m25.def.error.invalid', { issue: this.issueText(first) })));
        }
        return this.enqueue(async () => {
            const io = this.io();
            const known = draft.book && this.byBook.has(draft.book) ? draft.book : '';
            const book = known || this.deps.settings().book.trim() || DEFAULT_MECHANICS_BOOK;
            const clashOf = (uid: number | null) =>
                this.merged.find((other) => other.id === draft.id && !(other.book === book && other.uid === uid));
            const elsewhere = clashOf(null);
            // Before anything is written: the same id in another book is never overwritten.
            if (elsewhere && elsewhere.book !== book) {
                throw new Error(this.t('m25.def.error.duplicateId', { id: draft.id, name: elsewhere.name }));
            }
            let data = await io.load(book);
            if (this.isProtected(book, data)) throw new Error(this.t('m25.def.error.p13', { book }));
            if (data) {
                const role = this.roles()?.roleOf(book)?.role;
                if (role && role !== 'maestro' && role !== 'unknown') {
                    throw new Error(this.t('m25.def.error.notMaestro', { book }));
                }
            } else {
                // A new book: saved at once, announced to ST's list, never put into any activation list.
                await io.create(book, { entries: {}, extensions: { maestro: { role: 'maestro' } } });
                try {
                    await this.roles()?.setRole(book, 'maestro');
                } catch (error) {
                    this.deps.log.warn(`mechanics: role of ${book} was not set`, error);
                }
                this.deps.log.info(`mechanics: book ${book} created`);
                data = (await io.load(book)) ?? { entries: {} };
            }
            const entries = data.entries;
            // In place by uid; a definition without one updates the entry of the same id in this book (by id).
            const own = draft.book === book && draft.uid !== undefined ? entries[String(draft.uid)] : undefined;
            const sameId =
                draft.uid === undefined
                    ? Object.values(entries).find((entry) => entryToDef(entry, book)?.id === draft.id)
                    : undefined;
            const uid =
                own && isMechanicEntry(own)
                    ? (draft.uid as number)
                    : isDict(sameId) && typeof sameId.uid === 'number'
                      ? sameId.uid
                      : freeUid(entries);
            const clash = clashOf(uid);
            if (clash) throw new Error(this.t('m25.def.error.duplicateId', { id: draft.id, name: clash.name }));
            const previous = entries[String(uid)];
            const before = isDict(previous) ? cloneDef(previous) : null;
            const after = defToEntry({ ...draft, updatedAt: Date.now() }, uid, before);
            entries[String(uid)] = after;
            this.bump(book);
            await io.save(book, data);
            this.store(book, data);
            await this.journal({
                kind: before ? 'mechanics.def.update' : 'mechanics.def.create',
                summary: this.t(before ? 'm25.def.journal.update' : 'm25.def.journal.create', { name: draft.name }),
                changes: [
                    { target: MECHANICS_DEF_TARGET, ref: { book, uid, id: draft.id }, before, after: cloneDef(after) },
                ],
            });
            const saved = entryToDef(after, book);
            if (!saved) throw new Error(this.t('m25.def.error.invalid', { issue: this.t('m25.def.issue.id') }));
            return saved;
        });
    }

    /** Removes a definition's entry (journaled; undo brings it back). */
    remove(id: string): Promise<void> {
        const def = this.list().find((item) => item.id === id) ?? this.merged.find((item) => item.id === id);
        const book = def?.book;
        const uid = def?.uid;
        if (!def || !book || uid === undefined) return Promise.resolve();
        return this.enqueue(async () => {
            const io = this.io();
            const data = await io.load(book);
            if (!data) return;
            if (this.isProtected(book, data)) throw new Error(this.t('m25.def.error.p13', { book }));
            const previous = data.entries[String(uid)];
            if (!isDict(previous) || !isMechanicEntry(previous)) return;
            const before = cloneDef(previous);
            delete data.entries[String(uid)];
            this.bump(book);
            await io.save(book, data);
            this.store(book, data);
            await this.journal({
                kind: 'mechanics.def.remove',
                summary: this.t('m25.def.journal.remove', { name: def.name }),
                changes: [{ target: MECHANICS_DEF_TARGET, ref: { book, uid, id: def.id }, before, after: null }],
            });
        });
    }

    /** Per-chat switch: the id goes into (or out of) the chat's «off» list. */
    async setEnabledInChat(id: string, on: boolean): Promise<void> {
        if (!this.app.host.chatId()) throw new Error(this.t('m25.def.error.noChat'));
        const off = new Set(this.offIds());
        if (on === !off.has(id)) return;
        if (on) off.delete(id);
        else off.add(id);
        await this.app.chat.setPointer(MECHANICS_OFF_POINTER, [...off].sort());
        this.emit();
    }

    /** Journal undo: puts the entry back as it was before the change (or removes a created one). */
    private undo(change: JournalChange): Promise<boolean> {
        const { book, uid } = change.ref;
        if (typeof book !== 'string' || typeof uid !== 'number') return Promise.resolve(false);
        return this.enqueue(async () => {
            const io = this.io();
            const data = await io.load(book);
            if (!data) return change.before === null;
            if (this.isProtected(book, data)) return false;
            if (isDict(change.before)) data.entries[String(uid)] = cloneDef(change.before);
            else delete data.entries[String(uid)];
            this.bump(book);
            await io.save(book, data);
            if (this.candidates().includes(book)) this.store(book, data);
            return true;
        });
    }
}
