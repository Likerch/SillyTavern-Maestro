// M23 data layer: the LoreStore contract (store-api.ts) over SillyTavern's World Info (research/parity-lore.md
// §10.3 step 1, «трудные места» 1, 2, 4, 7):
// - one save queue per book, every write immediate (`saveWorldInfo(name, data, true)`): ST's shared 1 s debounce
//   drops the first of two books saved within a second, and an immediate save cancels another book's pending one;
// - after every write: `reloadWorldInfoEditor(name)` (the classic editor holds its own copy) and DES Lore Library
//   cache reset (DES ignores WORLDINFO_UPDATED and would save its stale copy over ours);
// - loads are deep copies (ST's first `loadWorldInfo` returns the cache object itself); a saved object is never
//   touched again (ST keeps it in its cache by reference);
// - card-embedded books keep `originalData` mirrored for every changed field (sweeping rule 2);
// - unknown entry and book fields are round-tripped (we only ever patch copies of what ST gave us);
// - every change is journaled with an undo target and the previous entry versions go to a per-book history file;
// - external WORLDINFO_UPDATED (classic editor, slash commands, CK, Localizer, DES) is reported through onChange.
import { adaptersOf } from '../../adapters';
import {
    avatarKey,
    fallbackRole,
    findSameName,
    isReadOnlyRole,
    removeFromCharLore,
    renameInCharLore,
    sameName,
    sanitizeBookName,
} from '../../domain/lore-studio-books';
import type { LinkState, RoleHints, StudioRole } from '../../domain/lore-studio-books';
import {
    cloneJson,
    diffEntries,
    diffSize,
    freeUid,
    isRecord,
    maxDisplayIndex,
    mirrorBook,
    normalizedEntry,
    patchEntry,
    sameJson,
    templateEntry,
} from '../../domain/lore-studio-entries';
import type { LoreBook, LoreEntry } from '../../domain/lore-studio-entries';
import { pushVersions, readHistory, versionsOf } from '../../domain/lore-studio-history';
import { normalizeWiPatch } from '../../domain/lore-studio-settings';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookRoleInfo, BookRolesApi } from '../bookRoles/api';
import type { CanonApi } from '../canon/api';
import type { DesLore } from './des-lore';
import { LoreStudioError } from './st-lore';
import type { StLore } from './st-lore';
import type {
    EntryVersion,
    LoreStore,
    SaveReason,
    WiBindings,
    WiBookData,
    WiEntry,
    WiGlobalSettings,
} from './store-api';

export const STORE_KEY = 'loreStore';
// Own journal targets: 'lore-entry' belongs to M5/M22 (changed fields only, BunnyMo refused) and is not re-registered.
// Ours carry whole entries (before/after), book operations, bindings and global settings.
export const UNDO_ENTRY = 'lore-studio-entry';
export const UNDO_BOOK = 'lore-studio-book';
export const UNDO_BINDING = 'lore-studio-binding';
export const UNDO_SETTINGS = 'lore-studio-settings';
export const STUDIO_MODULE = 'M23';
/** Saves touching more entries than this are journaled as one book snapshot (keeps the chat journal small). */
export const PER_ENTRY_JOURNAL_LIMIT = 10;
/** Books whose last known entries are kept to attribute external changes in the history. */
const KNOWN_LIMIT = 8;

export interface RoleView {
    role: StudioRole;
    readOnly: boolean;
    info?: BookRoleInfo;
    /** M35 runs but has not detected this book yet: read-only until it has (P13 — it may be a BunnyMo pack). */
    pending?: boolean;
}

export interface StoreDeps {
    app: App;
    log: Logger;
    st: StLore;
    des: DesLore;
}

type BookOp = 'create' | 'delete' | 'rename' | 'restore' | 'import';

interface BookRef {
    op: BookOp;
    book: string;
    to?: string;
    file?: string;
    wasGlobal?: boolean;
}

function asEntries(value: unknown): Record<string, LoreEntry> {
    return isRecord(value) ? (value as Record<string, LoreEntry>) : {};
}

export class LoreStoreService implements LoreStore {
    private readonly app: App;
    private readonly log: Logger;
    readonly st: StLore;
    readonly des: DesLore;
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly ownSaves = new Map<string, number>();
    private readonly listeners = new Set<(book: string | null) => void>();
    private readonly known = new Map<string, Record<string, LoreEntry>>();
    private readonly disposers: Unsubscribe[] = [];
    private readonly pending = new Set<string | null>();
    private flushScheduled = false;
    private disposed = false;

    constructor(deps: StoreDeps) {
        this.app = deps.app;
        this.log = deps.log;
        this.st = deps.st;
        this.des = deps.des;
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe {
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = this.app.host.events.name(key);
            if (name) this.disposers.push(this.app.host.events.on(name, handler));
        };
        on('WORLDINFO_UPDATED', (name, data) => this.onExternalUpdate(name, data));
        on('WORLDINFO_SETTINGS_UPDATED', () => this.emit(null));
        on('CHAT_CHANGED', () => this.emit(null));
        on('PERSONA_UPDATED', () => this.emit(null));
        const journal = this.app.journal;
        journal.registerUndo(UNDO_ENTRY, (change) => this.undoEntry(change));
        journal.registerUndo(UNDO_BOOK, (change) => this.undoBook(change));
        journal.registerUndo(UNDO_BINDING, (change) => this.undoBinding(change));
        journal.registerUndo(UNDO_SETTINGS, (change) => this.undoSettings(change));
        return () => this.dispose();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const dispose of this.disposers.splice(0)) dispose();
        this.listeners.clear();
        this.known.clear();
    }

    onChange(listener: (book: string | null) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Coalesced per microtask: one change of many entries (or a settings event right after ours) fires once. */
    private emit(book: string | null): void {
        if (this.disposed) return;
        this.pending.add(book);
        if (this.flushScheduled) return;
        this.flushScheduled = true;
        queueMicrotask(() => {
            this.flushScheduled = false;
            const books = [...this.pending];
            this.pending.clear();
            for (const item of books) {
                for (const listener of [...this.listeners]) {
                    try {
                        listener(item);
                    } catch (error) {
                        this.log.error('lore store listener failed', error);
                    }
                }
            }
        });
    }

    private onExternalUpdate(name: unknown, data: unknown): void {
        if (typeof name !== 'string' || this.disposed) return;
        if ((this.ownSaves.get(name) ?? 0) > 0) return;
        const before = this.known.get(name);
        if (before && isRecord(data)) {
            const after = cloneJson(asEntries(data.entries));
            this.remember(name, after);
            void this.enqueue(name, () =>
                this.recordHistory(name, before, after, {
                    module: 'st',
                    summary: this.app.i18n.t('m23.history.external'),
                }),
            );
        }
        this.emit(name);
    }

    private remember(book: string, entries: Record<string, LoreEntry>): void {
        this.known.delete(book);
        this.known.set(book, cloneJson(entries));
        while (this.known.size > KNOWN_LIMIT) {
            const oldest = this.known.keys().next().value;
            if (oldest === undefined) break;
            this.known.delete(oldest);
        }
    }

    /* ---------------------------------------------------------------- queues */

    private enqueue<T>(book: string, job: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(book) ?? Promise.resolve();
        const next = previous.then(job, job);
        const settled = next.then(
            () => undefined,
            () => undefined,
        );
        this.queues.set(book, settled);
        void settled.then(() => {
            if (this.queues.get(book) === settled) this.queues.delete(book);
        });
        return next;
    }

    /** Locks several books in a fixed (sorted) order so two cross-book operations never wait on each other. */
    private lock<T>(books: string[], job: () => Promise<T>): Promise<T> {
        const order = [...new Set(books)].sort();
        const run = (index: number): Promise<T> =>
            index >= order.length ? job() : this.enqueue(order[index] as string, () => run(index + 1));
        return run(0);
    }

    /** Resolves when every queued write of a book has finished (tests, UI refresh after a burst). */
    async idle(book?: string): Promise<void> {
        const pending = book ? [this.queues.get(book)] : [...this.queues.values()];
        await Promise.all(pending.filter(Boolean));
    }

    /* ---------------------------------------------------------------- reading */

    books(): string[] {
        return this.st.names();
    }

    async load(name: string): Promise<WiBookData | null> {
        const data = await this.st.load(name);
        if (data) this.remember(name, asEntries(data.entries));
        return data as WiBookData | null;
    }

    async history(book: string, uid: number): Promise<EntryVersion[]> {
        const doc = readHistory(await this.app.files.read(this.historyFile(book)), book);
        return versionsOf(doc, uid) as EntryVersion[];
    }

    /** Role of a book: M35 when it runs, else a guess from the neighbour adapters (P13: BunnyMo is read-only). */
    roleOf(book: string, hints?: RoleHints): RoleView {
        const roles = this.app.modules.api<BookRolesApi>('bookRoles');
        const info = roles?.roleOf(book);
        if (info) return { role: info.role, readOnly: info.readOnly, info };
        const role = fallbackRole(book, hints ?? this.roleHints());
        if (roles) return { role, readOnly: true, pending: true };
        return { role, readOnly: isReadOnlyRole(role) };
    }

    /** Adapter facts for fallbackRole() (computed once per render). */
    roleHints(): RoleHints {
        const hints: RoleHints = {};
        const adapters = adaptersOf(this.app);
        try {
            const bunny = adapters.bunnymo.books();
            hints.bunnyCore = bunny.core;
            hints.bunnyPacks = bunny.packs;
        } catch {
            // adapter absent in this build or not ready
        }
        try {
            hints.ckArchives = adapters.ck.repoBooks();
        } catch {
            // CK absent
        }
        try {
            hints.rosterNames = adapters.des.knownCharacters();
        } catch {
            // DES absent
        }
        const canon = this.app.modules.api<CanonApi>('canon');
        if (canon) {
            try {
                hints.canonBooks = [canon.bookName()];
            } catch {
                // no chat
            }
        }
        const character = this.st.currentCharacter();
        if (character?.primary) hints.cardBooks = [character.primary];
        return hints;
    }

    isReadOnly(book: string): boolean {
        return this.roleOf(book).readOnly;
    }

    private guardWritable(book: string): void {
        if (this.isReadOnly(book)) throw new LoreStudioError('readOnly', { book });
    }

    /** Everything that points at books, for link reports and rename (L-025, M35 п. 9). */
    async linkState(): Promise<LinkState> {
        const library = (await this.des.ready()) || this.des.present() ? this.des.view(this.books(), []) : null;
        return {
            global: await this.st.globalBooks(),
            charLore: await this.st.charLore(),
            characters: this.st.characters().map((item) => ({
                name: item.name,
                avatar: avatarKey(item.avatar),
                world: item.world,
            })),
            personaBook: this.st.personaBook(),
            personas: this.st.personas(),
            chatBook: this.st.chatBook(),
            campaigns: library?.campaigns.map((campaign) => ({
                id: campaign.id,
                name: campaign.name,
                books: campaign.books,
            })),
            workshop: this.des.present() ? this.des.workshop() : {},
        };
    }

    /* ---------------------------------------------------------------- the write path */

    /** The one place where a book is written (inside its queue). */
    private async write(
        book: string,
        next: LoreBook,
        previous: LoreBook | null,
        reason: SaveReason,
        options: { journal?: boolean } = {},
    ): Promise<void> {
        const before = previous ?? { entries: {} };
        await this.mirror(before, next);
        await this.writeRaw(book, next);
        const beforeEntries = asEntries(before.entries);
        const afterEntries = asEntries(next.entries);
        this.remember(book, afterEntries);
        await this.recordHistory(book, beforeEntries, afterEntries, reason);
        if (options.journal !== false) await this.journalSave(book, beforeEntries, afterEntries, reason);
        this.emit(book);
    }

    /** Immediate save + classic editor reload + DES cache reset; our own WORLDINFO_UPDATED is not "external". */
    private async writeRaw(book: string, data: LoreBook): Promise<void> {
        this.ownSaves.set(book, (this.ownSaves.get(book) ?? 0) + 1);
        try {
            await this.st.save(book, data);
        } finally {
            const left = (this.ownSaves.get(book) ?? 1) - 1;
            if (left > 0) this.ownSaves.set(book, left);
            else this.ownSaves.delete(book);
        }
        this.st.reloadEditor(book);
        this.des.invalidate(book);
    }

    private async mirror(previous: LoreBook, next: LoreBook): Promise<void> {
        if (!isRecord(next.originalData)) return;
        const { set, remove, keyMap } = await this.st.mirrorFunctions();
        mirrorBook(previous, next, {
            set: set ? (book, uid, path, value) => void set(book, uid, path, value) : undefined,
            remove: remove ? (book, uid) => void remove(book, uid) : undefined,
            keyMap: keyMap ?? undefined,
        });
    }

    private historyFile(book: string): string {
        return this.app.files.fileName('lore-history', book);
    }

    private async recordHistory(
        book: string,
        before: Record<string, LoreEntry>,
        after: Record<string, LoreEntry>,
        reason: SaveReason,
    ): Promise<void> {
        const diff = diffEntries(before, after);
        const at = Date.now();
        const versions = [...diff.changed.map((change) => change.uid), ...diff.removed]
            .map((uid) => ({ uid, entry: before[String(uid)] }))
            .filter((item): item is { uid: number; entry: LoreEntry } => !!item.entry)
            .map(({ uid, entry }) => ({ uid, version: { at, by: reason.module, summary: reason.summary, entry } }));
        if (!versions.length) return;
        try {
            const name = this.historyFile(book);
            const doc = readHistory(await this.app.files.read(name), book);
            await this.app.files.write(name, pushVersions(doc, versions));
        } catch (error) {
            this.log.warn(`entry history of "${book}" was not saved`, error);
        }
    }

    private async moveHistory(from: string, to: string): Promise<void> {
        try {
            const raw = await this.app.files.read(this.historyFile(from));
            if (raw === null) return;
            const doc = readHistory(raw, to);
            await this.app.files.write(this.historyFile(to), doc);
            await this.app.files.remove(this.historyFile(from));
        } catch (error) {
            this.log.warn('entry history was not moved', error);
        }
    }

    private journalModule(reason: SaveReason): string {
        return reason.module === 'user' ? STUDIO_MODULE : reason.module;
    }

    private async journalSave(
        book: string,
        before: Record<string, LoreEntry>,
        after: Record<string, LoreEntry>,
        reason: SaveReason,
    ): Promise<void> {
        const diff = diffEntries(before, after);
        const size = diffSize(diff);
        if (!size) return;
        try {
            let changes: JournalChange[];
            if (size <= PER_ENTRY_JOURNAL_LIMIT) {
                const uids = [...diff.added, ...diff.changed.map((change) => change.uid), ...diff.removed];
                changes = uids.map((uid) => ({
                    target: UNDO_ENTRY,
                    ref: { book, uid },
                    before: before[String(uid)] ?? null,
                    after: after[String(uid)] ?? null,
                }));
            } else {
                const file = await this.stash('lore-snapshot', book, { book, entries: before });
                const ref: BookRef = { op: 'restore', book, file };
                changes = [
                    {
                        target: UNDO_BOOK,
                        ref: { ...ref },
                        before: { entries: Object.keys(before).length },
                        after: { entries: Object.keys(after).length },
                    },
                ];
            }
            await this.app.journal.record({
                module: this.journalModule(reason),
                kind: 'lore.save',
                summary: reason.summary,
                changes,
            });
        } catch (error) {
            this.log.warn('lore change was not journaled', error);
        }
    }

    private async journalBook(ref: BookRef, summary: string): Promise<void> {
        try {
            await this.app.journal.record({
                module: STUDIO_MODULE,
                kind: `lore.book.${ref.op}`,
                summary,
                changes: [{ target: UNDO_BOOK, ref: { ...ref }, before: null, after: null }],
            });
        } catch (error) {
            this.log.warn('book action was not journaled', error);
        }
    }

    private async journalBinding(
        kind: string,
        ref: Record<string, unknown>,
        before: unknown,
        after: unknown,
    ): Promise<void> {
        try {
            await this.app.journal.record({
                module: STUDIO_MODULE,
                kind: `lore.binding.${kind}`,
                summary: this.app.i18n.t(`m23.journal.binding.${kind}`),
                changes: [{ target: UNDO_BINDING, ref: { kind, ...ref }, before, after }],
            });
        } catch (error) {
            this.log.warn('binding change was not journaled', error);
        }
    }

    /** A Maestro file with a copy of book data (snapshots for undo, the trash of deleted books). */
    private async stash(kind: string, book: string, data: unknown): Promise<string> {
        const name = this.app.files.fileName(kind, `${book}\u0000${Date.now()}\u0000${Math.random()}`);
        await this.app.files.write(name, data);
        return name;
    }

    private userReason(key: string, params: Record<string, string | number> = {}): SaveReason {
        return { module: 'user', summary: this.app.i18n.t(key, params) };
    }

    /* ---------------------------------------------------------------- books */

    private async cleanName(name: string): Promise<string> {
        const trimmed = name.trim();
        if (!trimmed) throw new LoreStudioError('emptyName');
        const server = await this.st.sanitize(trimmed);
        const clean = (server ?? sanitizeBookName(trimmed)).trim();
        if (!clean) throw new LoreStudioError('emptyName');
        return clean;
    }

    private assertFree(name: string, except?: string): void {
        const clash = findSameName(
            name,
            this.books().filter((book) => book !== except),
        );
        if (clash) throw new LoreStudioError('exists', { name: clash });
    }

    async save(name: string, data: WiBookData, reason: SaveReason): Promise<void> {
        this.guardWritable(name);
        const next = cloneJson(data) as LoreBook;
        if (!isRecord(next.entries)) next.entries = {};
        await this.enqueue(name, async () => {
            const previous = await this.st.load(name);
            await this.write(name, next, previous, reason);
        });
    }

    async createBook(name: string): Promise<string> {
        const clean = await this.cleanName(name);
        this.assertFree(clean);
        return this.enqueue(clean, async () => {
            await this.writeRaw(clean, { entries: {} });
            await this.st.updateList();
            await this.journalBook(
                { op: 'create', book: clean },
                this.app.i18n.t('m23.journal.createBook', { book: clean }),
            );
            this.emit(null);
            return clean;
        });
    }

    async duplicateBook(name: string, newName: string): Promise<void> {
        const clean = await this.cleanName(newName);
        this.assertFree(clean);
        await this.lock([name, clean], async () => {
            const data = await this.st.load(name);
            if (!data) throw new LoreStudioError('missing', { book: name });
            await this.writeRaw(clean, cloneJson(data));
            await this.st.updateList();
            await this.journalBook(
                { op: 'create', book: clean },
                this.app.i18n.t('m23.journal.duplicateBook', { book: name, copy: clean }),
            );
            this.emit(null);
        });
    }

    async renameBook(oldName: string, newName: string): Promise<void> {
        if (!this.books().includes(oldName)) throw new LoreStudioError('missing', { book: oldName });
        this.guardWritable(oldName);
        const clean = await this.cleanName(newName);
        if (sameName(oldName, clean)) throw new LoreStudioError('sameName');
        this.assertFree(clean, oldName);
        await this.lock([oldName, clean], () => this.renameNow(oldName, clean, true));
    }

    /**
     * ST's `renameWorldInfo` + `updateWorldInfoLinks` (not exported, WI:4192-4338), all links moved without the
     * per-character question (the studio's rename dialog lists them first), plus what ST forgets: DES campaigns,
     * global flags and journals, the entry history and M35's registry.
     */
    private async renameNow(oldName: string, newName: string, journal: boolean): Promise<void> {
        const data = (await this.st.load(oldName)) ?? { entries: {} };
        const wasGlobal = (await this.st.globalBooks()).includes(oldName);
        await this.writeRaw(newName, data);
        await this.st.updateList();
        // Primary links first, so ST's deleteWorldInfo no longer finds the old name in the open character's form.
        for (const character of this.st.characters()) {
            if (character.world !== oldName) continue;
            try {
                await this.st.setPrimaryBook(character.id, newName);
            } catch (error) {
                this.log.warn(`primary book of ${character.name} was not moved`, error);
            }
        }
        const charLore = await this.st.charLore();
        if (charLore.some((item) => item.extraBooks.includes(oldName))) {
            await this.st.writeCharLore((list) => {
                const renamed = renameInCharLore(list, oldName, newName).charLore;
                list.splice(0, list.length, ...renamed);
            });
        }
        this.st.renamePersonaLinks(oldName, newName);
        if (this.st.chatBook() === oldName) await this.st.setChatBook(newName);
        // ST's delete also drops the old name from the global selection; the new name takes its place.
        await this.st.deleteBook(oldName);
        if (wasGlobal) await this.applyGlobal(newName, true);
        await this.des.onWorldRenamed(oldName, newName);
        await this.moveHistory(oldName, newName);
        this.known.delete(oldName);
        await this.followRename(oldName, newName);
        await this.refreshRoles();
        if (journal) {
            await this.journalBook(
                { op: 'rename', book: oldName, to: newName },
                this.app.i18n.t('m23.journal.renameBook', { book: oldName, to: newName }),
            );
        }
        this.emit(null);
    }

    async deleteBook(name: string): Promise<void> {
        await this.enqueue(name, () => this.deleteNow(name, true));
    }

    /** ST's delete button: additional-book links dropped, then `deleteWorldInfo` (WI:2330-2353), then DES. */
    private async deleteNow(name: string, journal: boolean): Promise<void> {
        const data = await this.st.load(name);
        const wasGlobal = (await this.st.globalBooks()).includes(name);
        const file = data ? await this.stash('lore-trash', name, { book: name, data }) : undefined;
        const charLore = await this.st.charLore();
        if (charLore.some((item) => item.extraBooks.includes(name))) {
            await this.st.writeCharLore((list) => {
                const rest = removeFromCharLore(list, name);
                list.splice(0, list.length, ...rest);
            });
        }
        const ok = await this.st.deleteBook(name);
        if (!ok) throw new LoreStudioError('deleteFailed', { book: name });
        await this.des.onWorldDeleted(name);
        this.known.delete(name);
        await this.refreshRoles();
        if (journal) {
            await this.journalBook(
                { op: 'delete', book: name, file, wasGlobal },
                this.app.i18n.t('m23.journal.deleteBook', { book: name }),
            );
        }
        this.emit(null);
    }

    async importBook(file: File): Promise<string> {
        const stem = file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name;
        const existing = findSameName(stem, this.books());
        // An import over an existing book replaces it: keep the old content so the journal can bring it back.
        const before = existing ? await this.st.load(existing) : null;
        const snapshot =
            existing && before
                ? await this.stash('lore-snapshot', existing, { book: existing, entries: before.entries, data: before })
                : undefined;
        const name = await this.st.importFile(file);
        if (!name) return '';
        this.known.delete(name);
        const ref: BookRef =
            snapshot && name === existing
                ? { op: 'restore', book: name, file: snapshot }
                : { op: 'import', book: name };
        await this.journalBook(ref, this.app.i18n.t('m23.journal.importBook', { book: name }));
        await this.refreshRoles();
        this.emit(null);
        return name;
    }

    /** Name the current card's embedded book would be imported under, or null without one (L-042, L-046). */
    cardBookName(): string | null {
        const character = this.st.currentCharacter();
        const book = character ? this.st.characterBook(character.id) : null;
        if (!character || !book) return null;
        return typeof book.name === 'string' && book.name.trim() ? book.name.trim() : `${character.name}'s Lorebook`;
    }

    /**
     * «Import Card Lore» (L-043) for the current character: ST's `convertCharacterBook`, an immediate save, the list
     * update and the book bound as the character's primary book. Overwriting a book of that name is journaled with
     * a snapshot, so it can be undone.
     */
    async importCardBook(): Promise<string> {
        const character = this.st.currentCharacter();
        if (!character) throw new LoreStudioError('noCharacter');
        const raw = this.st.characterBook(character.id);
        if (!raw) throw new LoreStudioError('noCardBook');
        const name = await this.cleanName(this.cardBookName() ?? `${character.name}'s Lorebook`);
        const data = this.st.convertCharacterBook(raw);
        const target = findSameName(name, this.books()) ?? name;
        return this.enqueue(target, async () => {
            const previous = this.books().includes(target) ? await this.st.load(target) : null;
            const file = previous
                ? await this.stash('lore-snapshot', target, { book: target, entries: previous.entries, data: previous })
                : undefined;
            await this.writeRaw(target, data);
            await this.st.updateList();
            await this.st.setPrimaryBook(character.id, target);
            this.known.delete(target);
            await this.journalBook(
                file ? { op: 'restore', book: target, file } : { op: 'create', book: target },
                this.app.i18n.t('m23.journal.importCardBook', { book: target, name: character.name }),
            );
            await this.refreshRoles();
            this.emit(null);
            return target;
        });
    }

    async exportBook(name: string): Promise<void> {
        const data = await this.st.load(name);
        if (!data) throw new LoreStudioError('missing', { book: name });
        await this.st.download(JSON.stringify(data), `${name}.json`);
    }

    /** M35 roles and entry metadata, and canon items pointing at the book, follow a rename. */
    private async followRename(oldName: string, newName: string): Promise<void> {
        try {
            await this.app.modules.api<BookRolesApi>('bookRoles')?.renameBook?.(oldName, newName);
        } catch (error) {
            this.log.warn('book roles did not follow the rename', error);
        }
        try {
            await this.app.modules.api<CanonApi>('canon')?.renameBase?.(oldName, newName);
        } catch (error) {
            this.log.warn('canon did not follow the rename', error);
        }
    }

    private async refreshRoles(): Promise<void> {
        try {
            await this.app.modules.api<BookRolesApi>('bookRoles')?.refresh();
        } catch (error) {
            this.log.debug('book roles refresh failed', error);
        }
    }

    /* ---------------------------------------------------------------- entries */

    async createEntry(book: string, partial: Partial<WiEntry> = {}, reason?: SaveReason): Promise<number> {
        this.guardWritable(book);
        return this.enqueue(book, async () => {
            const data = (await this.st.load(book)) ?? { entries: {} };
            const next = cloneJson(data);
            const uid = freeUid(next.entries);
            next.entries[String(uid)] = normalizedEntry(
                templateEntry(uid, {
                    displayIndex: maxDisplayIndex(next.entries) + 1,
                    ...(partial as Record<string, unknown>),
                }),
            );
            await this.write(book, next, data, reason ?? this.userReason('m23.journal.createEntry', { book }));
            return uid;
        });
    }

    async updateEntry(book: string, uid: number, patch: Partial<WiEntry>, reason: SaveReason): Promise<void> {
        await this.patchEntries(book, [{ uid, patch: patch as Record<string, unknown> }], reason);
    }

    /** One save for many entry patches (bulk edit, apply sorting as order, backfill, drag reorder). */
    async patchEntries(
        book: string,
        patches: readonly { uid: number; patch: Record<string, unknown> }[],
        reason: SaveReason,
    ): Promise<number> {
        this.guardWritable(book);
        if (!patches.length) return 0;
        return this.enqueue(book, async () => {
            const data = await this.st.load(book);
            if (!data) throw new LoreStudioError('missing', { book });
            const next = cloneJson(data);
            let changed = 0;
            for (const { uid, patch } of patches) {
                const entry = next.entries[String(uid)];
                if (!entry) throw new LoreStudioError('missingEntry', { book, uid });
                // ST's list fills missing template fields of every entry it shows and writes them on the next
                // save (L-105); we do it for the entries we touch, so an entry behaves the same in both windows.
                const updated = normalizedEntry(patchEntry(entry, patch));
                if (!sameJson(updated, entry)) changed++;
                next.entries[String(uid)] = updated;
            }
            if (changed) await this.write(book, next, data, reason);
            return changed;
        });
    }

    /** Replaces an entry with a stored version (history «restore»); the uid stays. */
    async restoreVersion(book: string, uid: number, version: EntryVersion): Promise<void> {
        this.guardWritable(book);
        await this.enqueue(book, async () => {
            const data = await this.st.load(book);
            if (!data) throw new LoreStudioError('missing', { book });
            const next = cloneJson(data);
            next.entries[String(uid)] = { ...cloneJson(version.entry), uid };
            await this.write(book, next, data, this.userReason('m23.journal.restoreVersion', { book, uid }));
        });
    }

    async deleteEntry(book: string, uid: number, reason?: SaveReason): Promise<void> {
        await this.deleteEntries(book, [uid], reason);
    }

    async deleteEntries(book: string, uids: readonly number[], reason?: SaveReason): Promise<number> {
        this.guardWritable(book);
        return this.enqueue(book, async () => {
            const data = await this.st.load(book);
            if (!data) return 0;
            const next = cloneJson(data);
            let removed = 0;
            for (const uid of uids) {
                if (!next.entries[String(uid)]) continue;
                delete next.entries[String(uid)];
                removed++;
            }
            if (removed) {
                await this.write(
                    book,
                    next,
                    data,
                    reason ?? this.userReason('m23.journal.deleteEntries', { book, count: removed }),
                );
            }
            return removed;
        });
    }

    /** ST's duplicate (WI:4019-4033): every field copied under the smallest free uid, same displayIndex. */
    async duplicateEntry(book: string, uid: number, reason?: SaveReason): Promise<number> {
        this.guardWritable(book);
        return this.enqueue(book, async () => {
            const data = await this.st.load(book);
            const source = data?.entries[String(uid)];
            if (!data || !source) throw new LoreStudioError('missingEntry', { book, uid });
            const next = cloneJson(data);
            const copyUid = freeUid(next.entries);
            next.entries[String(copyUid)] = normalizedEntry({ ...cloneJson(source), uid: copyUid });
            await this.write(book, next, data, reason ?? this.userReason('m23.journal.duplicateEntry', { book, uid }));
            return copyUid;
        });
    }

    async moveEntry(
        fromBook: string,
        uid: number,
        toBook: string,
        copy: boolean,
        reason?: SaveReason,
    ): Promise<number> {
        const [result] = await this.moveEntries(fromBook, [uid], toBook, copy, reason);
        if (result === undefined) throw new LoreStudioError('missingEntry', { book: fromBook, uid });
        return result;
    }

    /**
     * ST's `moveWorldInfoEntry` (WI:6000-6089) for many entries: copies get the smallest free uid in the target and
     * `displayIndex` at its end; a move also deletes the source entries (and their originalData). Both books are
     * saved immediately, in a fixed lock order.
     */
    async moveEntries(
        fromBook: string,
        uids: readonly number[],
        toBook: string,
        copy: boolean,
        reason?: SaveReason,
    ): Promise<number[]> {
        if (fromBook === toBook) return [...uids];
        this.guardWritable(toBook);
        if (!copy) this.guardWritable(fromBook);
        return this.lock([fromBook, toBook], async () => {
            const source = await this.st.load(fromBook);
            if (!source) throw new LoreStudioError('missing', { book: fromBook });
            const target = (await this.st.load(toBook)) ?? { entries: {} };
            const nextTarget = cloneJson(target);
            const nextSource = cloneJson(source);
            const created: number[] = [];
            for (const uid of uids) {
                const entry = source.entries[String(uid)];
                if (!entry) continue;
                const newUid = freeUid(nextTarget.entries);
                nextTarget.entries[String(newUid)] = normalizedEntry({
                    ...cloneJson(entry),
                    uid: newUid,
                    displayIndex: maxDisplayIndex(nextTarget.entries) + 1,
                });
                created.push(newUid);
                if (!copy) delete nextSource.entries[String(uid)];
            }
            if (!created.length) return created;
            const why =
                reason ??
                this.userReason(copy ? 'm23.journal.copyEntries' : 'm23.journal.moveEntries', {
                    from: fromBook,
                    to: toBook,
                    count: created.length,
                });
            await this.write(toBook, nextTarget, target, why);
            if (!copy) await this.write(fromBook, nextSource, source, why);
            return created;
        });
    }

    /* ---------------------------------------------------------------- bindings */

    async bindings(): Promise<WiBindings> {
        const character = this.st.currentCharacter();
        const charLore = await this.st.charLore();
        const extra = character
            ? (charLore.find((item) => item.name === avatarKey(character.avatar))?.extraBooks ?? [])
            : [];
        return {
            global: await this.st.globalBooks(),
            character: { primary: character?.primary ?? null, extra: [...extra] },
            chat: this.st.chatBook(),
            persona: this.st.personaBook(),
        };
    }

    async setGlobal(name: string, active: boolean): Promise<void> {
        const before = await this.st.globalBooks();
        if (before.includes(name) === active) return;
        await this.applyGlobal(name, active);
        await this.journalBinding('global', { book: name }, before.includes(name), active);
        this.emit(null);
    }

    /** Global activation queued behind DES campaign switches (L-198, L-203). */
    private async applyGlobal(name: string, active: boolean): Promise<void> {
        await this.des.ready();
        await this.des.queueBookTask(async () => {
            const current = await this.st.globalBooks();
            const rest = current.filter((book) => book !== name);
            await this.st.setGlobalBooks(active ? [...rest, name] : rest);
        });
    }

    /** Replaces the whole global selection (bulk activation, undo). */
    async setGlobalList(names: readonly string[]): Promise<void> {
        await this.des.ready();
        await this.des.queueBookTask(() => this.st.setGlobalBooks(names));
        this.emit(null);
    }

    async setCharacterPrimary(name: string | null): Promise<void> {
        const character = this.st.currentCharacter();
        if (!character) throw new LoreStudioError('noCharacter');
        if (character.primary === name) return;
        await this.st.setPrimaryBook(character.id, name);
        await this.journalBinding(
            'primary',
            { characterId: character.id, avatar: character.avatar },
            character.primary,
            name,
        );
        this.emit(null);
    }

    async setCharacterExtra(names: string[]): Promise<void> {
        const character = this.st.currentCharacter();
        if (!character) throw new LoreStudioError('noCharacter');
        const before = (await this.bindings()).character.extra;
        await this.st.setExtraBooks(character.avatar, names);
        await this.journalBinding('extra', { characterId: character.id, avatar: character.avatar }, before, [...names]);
        this.emit(null);
    }

    async setChatBook(name: string | null): Promise<void> {
        const before = this.st.chatBook();
        if (before === name) return;
        await this.st.setChatBook(name);
        await this.journalBinding('chat', { chatId: this.app.host.chatId() }, before, name);
        this.emit(null);
    }

    async setPersonaBook(name: string | null): Promise<void> {
        const before = this.st.personaBook();
        if (before === name) return;
        await this.st.setPersonaBook(name);
        await this.journalBinding('persona', {}, before, name);
        this.emit(null);
    }

    /* ---------------------------------------------------------------- global settings */

    async globalSettings(): Promise<WiGlobalSettings> {
        return this.st.settings();
    }

    async setGlobalSettings(patch: WiGlobalSettings, journal = true): Promise<void> {
        const current = await this.st.settings();
        const changed = normalizeWiPatch(current, patch);
        const keys = Object.keys(changed);
        if (!keys.length) return;
        await this.st.applySettings(changed);
        if (journal) {
            const before = Object.fromEntries(keys.map((key) => [key, current[key]]));
            try {
                await this.app.journal.record({
                    module: STUDIO_MODULE,
                    kind: 'lore.settings',
                    summary: this.app.i18n.t('m23.journal.settings', { count: keys.length }),
                    changes: [{ target: UNDO_SETTINGS, ref: {}, before, after: changed }],
                });
            } catch (error) {
                this.log.warn('settings change was not journaled', error);
            }
        }
        this.emit(null);
    }

    /* ---------------------------------------------------------------- undo */

    private async undoEntry(change: JournalChange): Promise<boolean> {
        if (this.disposed) return false;
        const book = typeof change.ref.book === 'string' ? change.ref.book : '';
        const uid = Number(change.ref.uid);
        if (!book || !Number.isInteger(uid)) return false;
        return this.enqueue(book, async () => {
            const data = await this.st.load(book);
            if (!data) return false;
            const current = data.entries[String(uid)];
            const after = isRecord(change.after) ? (change.after as LoreEntry) : null;
            // Changed again since: never overwrite a newer edit silently.
            if (after ? !current || !sameJson(current, after) : !!current) {
                this.log.warn(`undo skipped: entry ${uid} of "${book}" changed since`);
                return false;
            }
            const next = cloneJson(data);
            if (isRecord(change.before)) next.entries[String(uid)] = { ...cloneJson(change.before as LoreEntry), uid };
            else delete next.entries[String(uid)];
            await this.write(book, next, data, this.userReason('m23.journal.undo', { book }), { journal: false });
            return true;
        });
    }

    private async undoBook(change: JournalChange): Promise<boolean> {
        if (this.disposed) return false;
        const ref = change.ref as unknown as BookRef;
        if (typeof ref.book !== 'string' || !ref.book) return false;
        switch (ref.op) {
            case 'create':
            case 'import':
                if (!this.books().includes(ref.book)) return true;
                await this.enqueue(ref.book, () => this.deleteNow(ref.book, false));
                return true;
            case 'delete': {
                if (!ref.file || this.books().includes(ref.book)) return false;
                const stored = await this.app.files.read<{ data?: LoreBook }>(ref.file);
                if (!stored?.data) return false;
                await this.enqueue(ref.book, async () => {
                    await this.writeRaw(ref.book, stored.data as LoreBook);
                    await this.st.updateList();
                    if (ref.wasGlobal) await this.applyGlobal(ref.book, true);
                });
                this.emit(null);
                return true;
            }
            case 'rename':
                if (!ref.to || !this.books().includes(ref.to) || this.books().includes(ref.book)) return false;
                await this.lock([ref.to, ref.book], () => this.renameNow(ref.to as string, ref.book, false));
                return true;
            case 'restore': {
                if (!ref.file) return false;
                const stored = await this.app.files.read<{ entries?: unknown; data?: LoreBook }>(ref.file);
                if (!stored) return false;
                await this.enqueue(ref.book, async () => {
                    const current = await this.st.load(ref.book);
                    const base = current ?? { entries: {} };
                    const next: LoreBook = stored.data
                        ? cloneJson(stored.data)
                        : { ...cloneJson(base), entries: cloneJson(asEntries(stored.entries)) };
                    await this.write(ref.book, next, current, this.userReason('m23.journal.undo', { book: ref.book }), {
                        journal: false,
                    });
                    if (!current) await this.st.updateList();
                });
                return true;
            }
            default:
                return false;
        }
    }

    private async undoBinding(change: JournalChange): Promise<boolean> {
        if (this.disposed) return false;
        const kind = change.ref.kind;
        const before = change.before;
        switch (kind) {
            case 'global': {
                const book = typeof change.ref.book === 'string' ? change.ref.book : '';
                if (!book) return false;
                await this.applyGlobal(book, before === true);
                this.emit(null);
                return true;
            }
            case 'primary': {
                const character = this.st.currentCharacter();
                if (!character || character.avatar !== change.ref.avatar) return false;
                await this.st.setPrimaryBook(character.id, typeof before === 'string' ? before : null);
                this.emit(null);
                return true;
            }
            case 'extra': {
                const avatar = typeof change.ref.avatar === 'string' ? change.ref.avatar : '';
                if (!avatar) return false;
                await this.st.setExtraBooks(avatar, Array.isArray(before) ? before.map(String) : []);
                this.emit(null);
                return true;
            }
            case 'chat':
                if (change.ref.chatId !== this.app.host.chatId()) return false;
                await this.st.setChatBook(typeof before === 'string' ? before : null);
                this.emit(null);
                return true;
            case 'persona':
                await this.st.setPersonaBook(typeof before === 'string' ? before : null);
                this.emit(null);
                return true;
            default:
                return false;
        }
    }

    private async undoSettings(change: JournalChange): Promise<boolean> {
        if (this.disposed || !isRecord(change.before)) return false;
        await this.setGlobalSettings(change.before as WiGlobalSettings, false);
        return true;
    }
}
