// M35 «Режим BunnyMo» (stage 3; plan M35 п. 4–9, P13, Q25): the data side of the BunnyMo mode.
//
// - Books: BunnyMo core and packs by M35 roles (the user's role wins), else the BunnyMo adapter's classification of
//   the active books, else (no roles module) a content classification of every book on demand. Archive books: role
//   'ck.archive', CarrotKernel repos, and active books with archives. Books are read through the Lore Studio store
//   when it runs (fresh deep copies), else ST's loadWorldInfo (copied); the cache is dropped on WORLDINFO_UPDATED.
// - The dictionary is built lazily (UI, commands) and cached by the books' content fingerprints: never on the send path.
// - Per-chat pack selection (Q25) lives in the chat metadata pointer 'bunnymoPacks' and acts at scan time: a
//   WORLDINFO_ENTRIES_LOADED listener (order normal, after the canon's 'first') splices the entries of non-selected
//   packs out of ST's per-scan lists. Never the core, never a file, never a nested array (P13).
// - Sheets: the archive editor writes one entry through the Lore Studio store (journal + undo there) or, without it,
//   with `saveWorldInfo(name, data, true)` + editor reload + DES Lore Library reset and its own journal record. BunnyMo
//   books and a changed `<Name:…>` are refused.
import { adaptersOf } from '../../adapters';
import { archiveWorlds, classifyWorlds, isCharacterArchive } from '../../domain/bunnymo';
import type { BunnyMoEntryLike } from '../../domain/bunnymo';
import { integrityFindings, wrapFacts, CK_BACKUP_SUFFIX } from '../../domain/bunnymo-mode-integrity';
import type { WrapFacts } from '../../domain/bunnymo-mode-integrity';
import {
    bookSignatures,
    coreVersionOf,
    diffPackEntries,
    isOffBySelection,
    packEdition,
    packFamily,
    packTitle,
    parseWorldFile,
    readPackSelection,
    samePackSelection,
    suppressBooks,
    worldsOf,
} from '../../domain/bunnymo-mode-packs';
import type { PackSelectionValue } from '../../domain/bunnymo-mode-packs';
import { parseSheet, rebuildSheet, sheetDraftOf } from '../../domain/bunnymo-mode-sheet';
import {
    archiveNameOf,
    buildTagDictionary,
    checkTags,
    entriesWithUid,
    tagVocabulary,
    templateCategories,
} from '../../domain/bunnymo-mode-tags';
import type { Dictionary, TagVocabulary, UidEntry } from '../../domain/bunnymo-mode-tags';
import { listsOf } from '../../domain/canon-inject';
import type { EntryListsLike } from '../../domain/canon-inject';
import { entryKeyOf, isBunnyMoBook } from '../../domain/doctor-fixes';
import { bookFingerprint, isBackupBookName, isCanonBookName } from '../../domain/roles-detect';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { LoreJournalApi } from '../loreJournal/api';
import type { RulesApi, RuleChange } from '../rules/api';
import type {
    ArchiveSheet,
    BunnyMoModeApi,
    IntegrityFinding,
    PackDiff,
    PackInfo,
    PackSelection,
    TagDictionary,
    TagValidation,
} from './api';

export const BUNNYMO_MODE_KEY = 'bunnymoMode';
export const BUNNYMO_MODE_ID = 'M35b';
/** Chat metadata pointer of the per-chat pack selection. */
export const SELECTION_POINTER = 'bunnymoPacks';
/** Journal targets (undo of a selection change; undo of a sheet saved without the Lore Studio store). */
export const SELECTION_TARGET = 'm35b.packSelection';
export const SHEET_TARGET = 'm35b.sheet';
const LORE_STORE_KEY = 'loreStore';
/** Rules that act on BunnyMo books; listed in «Правки на лету» even without changes in the last scan. */
export const BUNNYMO_RULES: readonly string[] = [
    'role.assistantToSystem',
    'pack.duplicates',
    'pack.versionConflict',
    'wrapper.nsfwCollision',
    'book.cap',
];

type Dict = Record<string, unknown>;
type BookKind = 'core' | 'pack' | null;

/** The part of the Lore Studio store (app.modules.api('loreStore')) this module uses. */
interface LoreStoreLike {
    books?(): string[];
    load(name: string): Promise<Dict | null>;
    updateEntry(book: string, uid: number, patch: Dict, reason: { module: string; summary: string }): Promise<void>;
}

interface CachedBook {
    entries: UidEntry[];
    fingerprint: string;
}

export interface ViewTarget {
    section?: 'dictionary' | 'packs' | 'integrity' | 'sheets' | 'edits';
    book?: string;
    tag?: string;
    uid?: number;
}

export interface ArchiveListItem {
    book: string;
    items: { uid: number; name: string; title: string; tags: number }[];
}

export interface RuleEditsView {
    rules: {
        id: string;
        titleKey: string;
        owner: string;
        enabled: boolean;
        waiting: boolean;
        changes: RuleChange[];
        cuts: number;
    }[];
    /** Entries the per-chat selection took out of the last real scan, per book. */
    suppressed: { book: string; count: number }[];
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

function copy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** Code-point order: the same in every locale. */
function byText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function sortNames(list: Iterable<string>): string[] {
    return [...new Set(list)].sort(byText);
}

/** Name compare for commands: case, `_` and extra spaces do not matter. */
function sameName(a: string, b: string): boolean {
    const norm = (value: string) => value.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return norm(a) === norm(b);
}

export class BunnyMoModeService {
    private readonly cache = new Map<string, CachedBook>();
    /** Content classification of books M35 roles and the adapter do not know (scan time and lazy reads). */
    private readonly kinds = new Map<string, { kind: BookKind; archives?: boolean }>();
    /** Payloads of scans already reported (M22 may apply the selection before our own listener does). */
    private seenPayloads = new WeakSet<object>();
    private dictionaryCache: { key: string; dictionary: Dictionary; vocabulary: TagVocabulary } | null = null;
    private rolesReady: Promise<void> | null = null;
    private rolesOff: Unsubscribe | null = null;
    private readonly listeners = new Set<() => void>();
    private suppressed = new Map<string, number>();
    private disposed = false;
    /** Where the pult tab opens next (set by open(), taken by the view on its next render). */
    target: ViewTarget | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = this.app.host.events.name(key);
            if (name) offs.push(this.app.host.events.on(name, handler));
            else this.log.debug(`ST event ${key} is missing`);
        };
        // Order normal: after the canon's 'first' listener (its overrides and suppressions are already in place).
        on('WORLDINFO_ENTRIES_LOADED', (payload) => {
            this.applySelection(payload);
        });
        on('WORLDINFO_UPDATED', (name) => this.invalidate(typeof name === 'string' ? name : null));
        on('WORLDINFO_SETTINGS_UPDATED', () => this.emit());
        on('CHAT_CHANGED', () => {
            this.suppressed = new Map();
            this.emit();
        });
        this.app.journal.registerUndo(SELECTION_TARGET, (change) => this.undoSelection(change));
        this.app.journal.registerUndo(SHEET_TARGET, (change) => this.undoSheet(change));
        this.watchRoles();
        offs.push(() => this.dispose());
        return offs;
    }

    dispose(): void {
        this.disposed = true;
        this.rolesOff?.();
        this.rolesOff = null;
        this.listeners.clear();
        this.cache.clear();
        this.dictionaryCache = null;
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
                this.log.error('bunnymo mode listener failed', error);
            }
        }
    }

    /** A book was saved: drop what was read from it. The dictionary itself is keyed by content fingerprints. */
    private invalidate(book: string | null): void {
        if (book === null) {
            this.cache.clear();
            this.kinds.clear();
            this.dictionaryCache = null;
            this.emit();
            return;
        }
        const known = this.cache.delete(book);
        const classified = this.kinds.delete(book);
        if (known || classified) this.emit();
    }

    private roles(): BookRolesApi | undefined {
        return this.app.modules.api<BookRolesApi>('bookRoles');
    }

    private watchRoles(): void {
        if (this.rolesOff) return;
        const roles = this.roles();
        if (!roles) return;
        this.rolesOff = roles.onChange(() => {
            this.dictionaryCache = null;
            this.emit();
        });
    }

    /** M35 roles detect every book once per session (lazily, the first time the BunnyMo mode needs the list). */
    private async ensureRoles(): Promise<void> {
        const roles = this.roles();
        if (!roles) return;
        this.watchRoles();
        this.rolesReady ??= roles
            .refresh()
            .catch((error: unknown) => this.log.warn('book roles refresh failed', error));
        await this.rolesReady;
    }

    /* ---------------------------------------------------------------- reading books */

    private store(): LoreStoreLike | undefined {
        const store = this.app.modules.api<LoreStoreLike>(LORE_STORE_KEY);
        return store && typeof store.load === 'function' ? store : undefined;
    }

    /** Every lorebook name ST knows (empty when this ST has no list). */
    worldNames(): string[] {
        try {
            const names = this.app.host.ctx().getWorldInfoNames?.();
            if (Array.isArray(names)) return strings(names);
        } catch (error) {
            this.log.debug('getWorldInfoNames failed', error);
        }
        return strings(this.store()?.books?.());
    }

    /** A fresh copy of a book (never the cache object of ST). */
    private async readBook(book: string): Promise<Dict | null> {
        const store = this.store();
        try {
            if (store) {
                const data = await store.load(book);
                return isDict(data) && isDict(data.entries) ? data : null;
            }
            const load = this.app.host.ctx().loadWorldInfo;
            if (typeof load !== 'function') return null;
            const data = await load(book);
            return isDict(data) && isDict(data.entries) ? copy(data) : null;
        } catch (error) {
            this.log.debug(`lorebook ${book} did not load`, error);
            return null;
        }
    }

    private async book(book: string): Promise<CachedBook | null> {
        const cached = this.cache.get(book);
        if (cached) return cached;
        const data = await this.readBook(book);
        if (!data) return null;
        const item: CachedBook = { entries: entriesWithUid(data), fingerprint: bookFingerprint(data) };
        this.cache.set(book, item);
        return item;
    }

    private light(book: string, entries: readonly UidEntry[], enabledOnly = false): BunnyMoEntryLike[] {
        return entries
            .filter(({ entry }) => !enabledOnly || entry.disable !== true)
            .map(({ entry }) => ({
                key: entry.key,
                keysecondary: entry.keysecondary,
                comment: entry.comment,
                content: entry.content,
                world: book,
            }));
    }

    /** Content classification of a loaded book (cached until the book is saved). */
    private async classify(book: string): Promise<{ kind: BookKind; archives: boolean }> {
        const known = this.kinds.get(book);
        if (known?.archives !== undefined) return { kind: known.kind, archives: known.archives };
        const item = await this.book(book);
        if (!item) return { kind: null, archives: false };
        const { core, packs } = classifyWorlds(this.light(book, item.entries));
        const kind: BookKind = core.has(book) ? 'core' : packs.has(book) ? 'pack' : null;
        const archives = archiveWorlds(this.light(book, item.entries, true)).has(book);
        this.kinds.set(book, { kind, archives });
        return { kind, archives };
    }

    private adapterBooks(): { core: string[]; packs: string[]; archives: string[] } {
        try {
            return adaptersOf(this.app).bunnymo.books();
        } catch {
            return { core: [], packs: [], archives: [] };
        }
    }

    private ckRepos(): string[] {
        try {
            return adaptersOf(this.app).ck.repoBooks();
        } catch {
            return [];
        }
    }

    /** BunnyMo core and pack books (existing ones), by roles → adapter → content. */
    async bunnyBooks(): Promise<{ core: string[]; packs: string[] }> {
        await this.ensureRoles();
        const names = this.worldNames();
        const exists = (book: string) => !names.length || names.includes(book);
        const core = new Set<string>();
        const packs = new Set<string>();
        const roles = this.roles();
        const adapter = this.adapterBooks();
        if (roles) {
            for (const info of roles.all()) {
                if (info.role === 'bunnymo.core') core.add(info.book);
                else if (info.role === 'bunnymo.pack') packs.add(info.book);
            }
            for (const book of adapter.core) if (!roles.roleOf(book)) core.add(book);
            for (const book of adapter.packs) if (!roles.roleOf(book)) packs.add(book);
        } else {
            for (const book of adapter.core) core.add(book);
            for (const book of adapter.packs) packs.add(book);
            for (const book of names) {
                // Backups (`.carrot_backup`, Localizer copies) look like what they copy: never a pack of their own.
                if (core.has(book) || packs.has(book) || isBackupBookName(book)) continue;
                const { kind } = await this.classify(book);
                if (kind === 'core') core.add(book);
                else if (kind === 'pack') packs.add(book);
            }
        }
        return { core: sortNames([...core].filter(exists)), packs: sortNames([...packs].filter(exists)) };
    }

    /** Books holding character archives: role 'ck.archive', CK repos and active books with archives. */
    async archiveBooks(): Promise<string[]> {
        const { core, packs } = await this.bunnyBooks();
        const bunny = new Set([...core, ...packs]);
        const names = this.worldNames();
        const books = new Set<string>([...this.ckRepos(), ...this.adapterBooks().archives]);
        const roles = this.roles();
        if (roles) {
            for (const info of roles.all()) if (info.role === 'ck.archive') books.add(info.book);
        } else {
            for (const book of names) {
                if (bunny.has(book) || isBackupBookName(book)) continue;
                if ((await this.classify(book)).archives) books.add(book);
            }
        }
        return sortNames([...books].filter((book) => !bunny.has(book) && (!names.length || names.includes(book))));
    }

    private async activeBooks(): Promise<Set<string>> {
        try {
            return new Set(await adaptersOf(this.app).bunnymo.activeBooks());
        } catch {
            return new Set();
        }
    }

    /* ---------------------------------------------------------------- dictionary */

    private async dictionaryState(): Promise<{ dictionary: Dictionary; vocabulary: TagVocabulary }> {
        const { core, packs } = await this.bunnyBooks();
        const archives = await this.archiveBooks();
        const load = async (names: string[]) => {
            const result: { name: string; item: CachedBook }[] = [];
            for (const name of names) {
                const item = await this.book(name);
                if (item) result.push({ name, item });
            }
            return result;
        };
        const cores = await load(core);
        const packBooks = await load(packs);
        const archiveBooks = await load(archives);
        const part = (list: { name: string; item: CachedBook }[]) =>
            list.map(({ name, item }) => `${name}#${item.fingerprint}`).join('\u0002');
        const key = [part(cores), part(packBooks), part(archiveBooks)].join('\u0003');
        if (this.dictionaryCache?.key === key) return this.dictionaryCache;
        const infoCategories = new Set<string>();
        for (const { item } of cores) {
            for (const category of templateCategories(item.entries)) infoCategories.add(category);
        }
        const dictionary = buildTagDictionary({
            books: [
                ...cores.map(({ name, item }) => ({ name, core: true, entries: item.entries })),
                ...packBooks.map(({ name, item }) => ({ name, core: false, entries: item.entries })),
            ],
            archives: archiveBooks.map(({ name, item }) => ({ name, entries: item.entries })),
            builtAt: Date.now(),
            infoCategories,
        });
        const state = { key, dictionary, vocabulary: tagVocabulary(dictionary, infoCategories) };
        this.dictionaryCache = state;
        return state;
    }

    async dictionary(): Promise<TagDictionary> {
        return (await this.dictionaryState()).dictionary;
    }

    async validateTags(tags: readonly string[]): Promise<TagValidation[]> {
        const { vocabulary } = await this.dictionaryState();
        return checkTags(tags, vocabulary).map((check) => ({
            ...check,
            ...(check.reason ? { message: this.t(`m35b.reason.${check.reason}`) } : {}),
        }));
    }

    /* ---------------------------------------------------------------- packs and per-chat selection */

    selection(): PackSelection {
        try {
            return readPackSelection(this.app.chat.pointer(SELECTION_POINTER));
        } catch {
            return { mode: 'all' };
        }
    }

    async packs(): Promise<PackInfo[]> {
        const { packs } = await this.bunnyBooks();
        const active = await this.activeBooks();
        const selection = this.selection();
        const roles = this.roles();
        const loaded: { book: string; item: CachedBook; signatures: Set<string> }[] = [];
        for (const book of packs) {
            const item = await this.book(book);
            if (item) loaded.push({ book, item, signatures: bookSignatures(item.entries) });
        }
        const others = loaded.map(({ book, signatures }) => ({ book, signatures }));
        const result: PackInfo[] = loaded.map(({ book, item, signatures }) => {
            const title = packTitle(book);
            const family = packFamily(item.entries);
            const version = roles?.roleOf(book)?.pack?.version ?? title.version;
            return {
                book,
                name: family ?? title.name,
                ...(version ? { version } : {}),
                ...(family ? { family } : {}),
                edition: packEdition(book, signatures, others),
                entries: item.entries.length,
                active: active.has(book),
                offInChat: isOffBySelection(selection, book),
            };
        });
        return result.sort(
            (a, b) => Number(b.active) - Number(a.active) || byText(a.name, b.name) || byText(a.book, b.book),
        );
    }

    /** Core books with their versions (integrity, packs view). */
    async cores(): Promise<{ book: string; active: boolean; named: string | null; detected: string }[]> {
        const { core } = await this.bunnyBooks();
        const active = await this.activeBooks();
        const result: { book: string; active: boolean; named: string | null; detected: string }[] = [];
        for (const book of core) {
            const item = await this.book(book);
            if (!item) continue;
            result.push({ book, active: active.has(book), ...coreVersionOf(book, item.entries) });
        }
        return result;
    }

    async setSelection(selection: PackSelection): Promise<void> {
        const next = readPackSelection(selection);
        if (!this.app.host.chatId()) throw new Error(this.t('m35b.error.noChat'));
        const before = this.selection();
        if (samePackSelection(before, next)) return;
        await this.app.chat.setPointer(SELECTION_POINTER, next);
        try {
            await this.app.journal.record({
                module: BUNNYMO_MODE_ID,
                kind: 'bunnymo.packSelection',
                summary:
                    next.mode === 'all'
                        ? this.t('m35b.journal.selectionAll')
                        : this.t('m35b.journal.selectionOnly', { count: next.books.length }),
                changes: [{ target: SELECTION_TARGET, ref: { chatId: this.app.host.chatId() }, before, after: next }],
            });
        } catch (error) {
            this.log.warn('pack selection was not journaled', error);
        }
        this.emit();
    }

    private async undoSelection(change: JournalChange): Promise<boolean> {
        const chatId = isDict(change.ref) ? change.ref.chatId : undefined;
        if (!chatId || chatId !== this.app.host.chatId()) return false;
        await this.app.chat.setPointer(SELECTION_POINTER, readPackSelection(change.before));
        this.emit();
        return true;
    }

    /** Sync kind of a book for the scan: roles → adapter → cached content classification. */
    private kindOf(book: string): BookKind | undefined {
        const info = this.roles()?.roleOf(book);
        if (info) return info.role === 'bunnymo.core' ? 'core' : info.role === 'bunnymo.pack' ? 'pack' : null;
        const adapter = this.adapterBooks();
        if (adapter.core.includes(book)) return 'core';
        if (adapter.packs.includes(book)) return 'pack';
        return this.kinds.get(book)?.kind;
    }

    isOffInChat(book: string): boolean {
        const selection = this.selection();
        return isOffBySelection(selection, book) && this.kindOf(book) === 'pack';
    }

    /** Splices the entries of packs not selected for this chat out of a WORLDINFO_ENTRIES_LOADED payload. */
    applySelection(payload: unknown): number {
        const selection = this.selection();
        const simulating = this.app.modules.api<LoreJournalApi>('loreJournal')?.simulating() === true;
        if (selection.mode === 'all') {
            if (!simulating && this.suppressed.size) this.suppressed = new Map();
            return 0;
        }
        const lists = listsOf(payload);
        if (!lists) return 0;
        this.classifyUnknown(lists);
        const removed = suppressBooks(
            lists,
            (world) => isOffBySelection(selection, world) && this.kindOf(world) === 'pack',
        );
        if (!simulating && isDict(payload)) {
            // A second call in the same scan (M22 first, our own listener later) adds to the same report.
            if (!this.seenPayloads.has(payload)) {
                this.seenPayloads.add(payload);
                this.suppressed = removed;
            } else {
                for (const [book, value] of removed) {
                    this.suppressed.set(book, (this.suppressed.get(book) ?? 0) + value);
                }
            }
        }
        let count = 0;
        for (const value of removed.values()) count += value;
        return count;
    }

    /** Books in the scan that neither roles nor the adapter know: one classification pass over their entries. */
    private classifyUnknown(lists: EntryListsLike): void {
        const unknown = worldsOf(lists).filter((world) => this.kindOf(world) === undefined);
        if (!unknown.length) return;
        const wanted = new Set(unknown);
        const entries: BunnyMoEntryLike[] = [];
        for (const list of Object.values(lists)) {
            for (const entry of list) {
                if (typeof entry?.world === 'string' && wanted.has(entry.world)) entries.push(entry);
            }
        }
        const { core, packs } = classifyWorlds(entries);
        for (const world of unknown) {
            this.kinds.set(world, { kind: core.has(world) ? 'core' : packs.has(world) ? 'pack' : null });
        }
    }

    /* ---------------------------------------------------------------- diff with a new file */

    async diffWithFile(book: string, file: File): Promise<PackDiff> {
        const entries = parseWorldFile(await file.text());
        if (!entries) throw new Error(this.t('m35b.error.file', { file: file.name }));
        const current = await this.book(book);
        if (!current) throw new Error(this.t('m35b.error.noBook', { book }));
        return diffPackEntries(current.entries, entries);
    }

    /* ---------------------------------------------------------------- integrity */

    async integrity(): Promise<IntegrityFinding[]> {
        const names = this.worldNames();
        const { core, packs } = await this.bunnyBooks();
        const active = await this.activeBooks();
        const cores = await this.cores();
        const archives = await this.archiveBooks();
        let global: string[] = [];
        try {
            global = strings((await this.app.host.modules.worldInfo()).selected_world_info);
        } catch (error) {
            this.log.debug('world-info.js is not available', error);
        }
        let tagLibraries: string[] = [];
        let wrapping = false;
        try {
            const ck = adaptersOf(this.app).ck;
            tagLibraries = ck.tagLibraries();
            wrapping = ck.settings()?.bunnymoTagWrapping === true;
        } catch {
            // CK absent.
        }
        const bunny = new Set([...core, ...packs]);
        const wraps: WrapFacts[] = [];
        for (const book of sortNames([...core, ...packs, ...archives, ...tagLibraries])) {
            if (names.length && !names.includes(book)) continue;
            const item = await this.book(book);
            if (!item) continue;
            const backupName = `${book}${CK_BACKUP_SUFFIX}`;
            const backup = names.includes(backupName) ? await this.book(backupName) : null;
            const facts = wrapFacts(book, item.entries, backup?.entries ?? null, {
                tagLibrary: tagLibraries.includes(book),
                wrapping,
                bunnymo: bunny.has(book),
            });
            if (facts.rewritten || facts.nested || facts.pending) wraps.push(facts);
        }
        const chatBooks = new Set<string>();
        const chatBook = this.app.host.ctx().chatMetadata?.world_info;
        if (typeof chatBook === 'string' && chatBook) chatBooks.add(chatBook);
        for (const info of this.roles()?.all() ?? []) if (info.role === 'chat') chatBooks.add(info.book);
        const items = integrityFindings({
            books: names,
            global,
            cores,
            packs: packs.map((book) => ({ book, active: active.has(book) })),
            ckRepos: this.ckRepos(),
            wraps,
            isCanon: isCanonBookName,
            chatBooks: [...chatBooks],
        });
        return items.map((item) => ({
            kind: item.kind,
            text: this.t(`m35b.integrity.${item.kind}.${item.variant}`, item.params),
            ...(item.book ? { book: item.book } : {}),
        }));
    }

    /* ---------------------------------------------------------------- sheets */

    /** Archives by book for the sheet list. */
    async archives(): Promise<ArchiveListItem[]> {
        const result: ArchiveListItem[] = [];
        for (const book of await this.archiveBooks()) {
            const item = await this.book(book);
            if (!item) continue;
            const items = item.entries
                .filter(({ entry }) => isCharacterArchive(entry))
                .map(({ uid, entry }) => ({
                    uid,
                    name: archiveNameOf(entry),
                    title: typeof entry.comment === 'string' ? entry.comment : '',
                    tags: parseSheet(typeof entry.content === 'string' ? entry.content : '').tags.length,
                }))
                .sort((a, b) => a.uid - b.uid);
            if (items.length) result.push({ book, items });
        }
        return result;
    }

    /** An archive by character name (`<Name:…>`, the title or a key), for the command. */
    async findArchive(name: string): Promise<{ book: string; uid: number } | null> {
        for (const book of await this.archiveBooks()) {
            const item = await this.book(book);
            for (const { uid, entry } of item?.entries ?? []) {
                if (!isCharacterArchive(entry)) continue;
                const keys = strings(entry.key);
                if (sameName(archiveNameOf(entry), name) || keys.some((key) => sameName(key, name))) {
                    return { book, uid };
                }
            }
        }
        return null;
    }

    async readSheet(book: string, uid: number): Promise<ArchiveSheet | null> {
        const item = await this.book(book);
        const entry = item?.entries.find((candidate) => candidate.uid === uid)?.entry;
        if (!entry || !isCharacterArchive(entry)) return null;
        const parsed = parseSheet(typeof entry.content === 'string' ? entry.content : '');
        if (!parsed.block) return null;
        const draft = sheetDraftOf(parsed);
        return {
            book,
            uid,
            name: draft.name,
            tags: [...draft.tags],
            ...(draft.mbti ? { mbti: draft.mbti } : {}),
            ...(draft.linguistics !== undefined ? { linguistics: draft.linguistics } : {}),
            sections: [...draft.sections],
            title: typeof entry.comment === 'string' ? entry.comment : '',
            blocks: parsed.blocks,
        };
    }

    /** BunnyMo books are never written (P13): by role, by the adapter and by content. */
    private isBunnyMo(book: string, data: Dict | null): boolean {
        const kind = this.kindOf(book);
        if (kind === 'core' || kind === 'pack') return true;
        return !!data && isDict(data.entries) && isBunnyMoBook(book, data as { entries: Record<string, Dict> });
    }

    async saveSheet(sheet: ArchiveSheet): Promise<void> {
        const { book, uid } = sheet;
        // The Lore Studio store keeps books M35 has not detected yet read-only.
        await this.ensureRoles();
        if (this.isBunnyMo(book, null)) throw new Error(this.t('m35b.error.bunnymoBook', { book }));
        const data = await this.readBook(book);
        if (!data) throw new Error(this.t('m35b.error.noBook', { book }));
        if (this.isBunnyMo(book, data)) throw new Error(this.t('m35b.error.bunnymoBook', { book }));
        const key = entryKeyOf(data as { entries: Record<string, Dict> }, uid);
        const entry = key === null ? undefined : (data.entries as Record<string, Dict>)[key];
        if (key === null || !entry) throw new Error(this.t('m35b.error.noEntry', { book, uid }));
        const before = typeof entry.content === 'string' ? entry.content : '';
        const result = rebuildSheet(before, {
            name: sheet.name,
            tags: sheet.tags,
            ...(sheet.mbti ? { mbti: sheet.mbti } : {}),
            ...(sheet.linguistics !== undefined ? { linguistics: sheet.linguistics } : {}),
            sections: sheet.sections,
        });
        if (!result.ok) throw new Error(this.t(`m35b.error.sheet.${result.error}`, { book, uid }));
        if (!result.changed) return;
        const summary = this.t('m35b.journal.sheet', { name: sheet.name || `#${uid}`, book });
        await this.writeContent(book, uid, data, key, result.content, before, summary);
        this.cache.delete(book);
        this.dictionaryCache = null;
        this.refreshCk(book);
        this.emit();
    }

    private async writeContent(
        book: string,
        uid: number,
        data: Dict,
        key: string,
        content: string,
        before: string,
        summary: string,
    ): Promise<void> {
        const store = this.store();
        if (store) {
            // The store journals the change (undo target 'lore-studio-entry') and keeps the entry history.
            await store.updateEntry(book, uid, { content }, { module: BUNNYMO_MODE_ID, summary });
            return;
        }
        await this.writeDirect(book, data, key, content);
        try {
            await this.app.journal.record({
                module: BUNNYMO_MODE_ID,
                kind: 'bunnymo.sheet',
                summary,
                changes: [{ target: SHEET_TARGET, ref: { book, uid }, before, after: content }],
            });
        } catch (error) {
            this.log.warn('sheet save was not journaled', error);
        }
    }

    /** Immediate save of a copy, editor reload and DES Lore Library reset (ARCHITECTURE «Lorebook writes»). */
    private async writeDirect(book: string, data: Dict, key: string, content: string): Promise<void> {
        const ctx = this.app.host.ctx();
        if (typeof ctx.saveWorldInfo !== 'function') throw new Error(this.t('m35b.error.noSave'));
        const next = copy(data);
        const entries = next.entries as Record<string, Dict>;
        entries[key] = { ...entries[key], content };
        await ctx.saveWorldInfo(book, next, true);
        try {
            ctx.reloadWorldInfoEditor?.(book);
        } catch (error) {
            this.log.debug('lorebook editor reload failed', error);
        }
        try {
            adaptersOf(this.app).des.invalidateLoreCache(book);
        } catch {
            // DES absent.
        }
    }

    /** CK keeps parsed archives in memory: re-scan every repo after an archive changed (research §5 step 3). */
    private refreshCk(book: string): void {
        try {
            const ck = adaptersOf(this.app).ck;
            const repos = ck.repoBooks();
            if (!repos.includes(book)) return;
            void Promise.resolve(ck.kernel()?.scanSelectedLorebooks?.(repos)).catch((error: unknown) =>
                this.log.debug('CK rescan failed', error),
            );
        } catch (error) {
            this.log.debug('CK rescan is not available', error);
        }
    }

    private async undoSheet(change: JournalChange): Promise<boolean> {
        const ref = isDict(change.ref) ? change.ref : {};
        const book = typeof ref.book === 'string' ? ref.book : null;
        const uid = Number(ref.uid);
        if (!book || !Number.isFinite(uid) || typeof change.before !== 'string') return false;
        const data = await this.readBook(book);
        if (!data || this.isBunnyMo(book, data)) return false;
        const key = entryKeyOf(data as { entries: Record<string, Dict> }, uid);
        const entry = key === null ? undefined : (data.entries as Record<string, Dict>)[key];
        // Changed since (another edit): leave it.
        if (key === null || !entry || entry.content !== change.after) return false;
        await this.writeDirect(book, data, key, change.before);
        this.cache.delete(book);
        this.dictionaryCache = null;
        this.refreshCk(book);
        this.emit();
        return true;
    }

    /* ---------------------------------------------------------------- runtime edits (M22) */

    async ruleEdits(): Promise<RuleEditsView | null> {
        const rules = this.app.modules.api<RulesApi>('rules');
        if (!rules) return null;
        const { core, packs } = await this.bunnyBooks();
        const bunny = new Set([...core, ...packs]);
        const cuts = rules.cutEntries?.() ?? [];
        const list = rules
            .list()
            .map((state) => ({
                id: state.id,
                titleKey: state.definition.titleKey,
                owner: state.definition.owner,
                enabled: state.enabled,
                waiting: state.waiting === true,
                changes: state.lastChanges.filter((change) => bunny.has(change.world)),
                cuts: cuts.filter((cut) => cut.ruleId === state.id && bunny.has(cut.world)).length,
            }))
            .filter((rule) => rule.changes.length || rule.cuts || BUNNYMO_RULES.includes(rule.id));
        return {
            rules: list,
            suppressed: [...this.suppressed].map(([book, count]) => ({ book, count })),
        };
    }

    async setRuleEnabled(id: string, enabled: boolean): Promise<void> {
        const rules = this.app.modules.api<RulesApi>('rules');
        if (!rules) return;
        await rules.setEnabled(id, enabled);
        this.emit();
    }

    /* ---------------------------------------------------------------- opening the view */

    open(target: ViewTarget = {}): void {
        this.target = { ...target };
        this.app.ui.openPult('bunnymo');
    }

    /** The public API (app.modules.api<BunnyMoModeApi>('bunnymoMode')). */
    api(): Required<BunnyMoModeApi> {
        return {
            dictionary: () => this.dictionary(),
            packs: () => this.packs(),
            selection: () => this.selection(),
            setSelection: (selection) => this.setSelection(selection),
            diffWithFile: (book, file) => this.diffWithFile(book, file),
            integrity: () => this.integrity(),
            readSheet: (book, uid) => this.readSheet(book, uid),
            validateTags: (tags) => this.validateTags(tags),
            saveSheet: (sheet) => this.saveSheet(sheet),
            open: (target) => this.open(target),
            onChange: (listener) => this.onChange(listener),
            isOffInChat: (book) => this.isOffInChat(book),
            applySelection: (payload) => this.applySelection(payload),
        };
    }
}

export type { PackSelectionValue };
