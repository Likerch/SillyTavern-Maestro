// M35 «Роли книг», pure parts (plan M35 п. 1–2, P2, P13; dev-plan 2.1): what a lorebook is, from its name, its content
// and the bindings of ST and the neighbours; the registry record kept in a Maestro file (by book name and a content
// fingerprint, never in the book itself) and its merge between tabs.
//
// Detection order (most specific first):
// 1. canon books ("Maestro · канон · …", or book-level `extensions.maestro.role === 'canon'`);
// 2. Maestro books (book-level `extensions.maestro.role === 'maestro'`, or the "Maestro · " prefix);
// 3. backups ("(backup …)" copies of the Localizer, ".carrot_backup" copies of CarrotKernel) — before content
//    detection, so a copy of a pack or an archive is not taken for the original;
// 4. BunnyMo core and packs (content heuristics shared with DES-RU, src/domain/bunnymo.ts);
// 5. CarrotKernel character archives (a CK repo, or a book mostly made of `<BunnymoTags>` archives);
// 6. bindings: card books (any character's primary or extra book), the current chat book, persona books;
// 7. NPC books (named exactly like a DES character of this chat);
// 8. world — or 'unknown' when the content could not be read.
// Chat and NPC roles depend on the open chat; once detected they stick while the content stays the same and the book
// is not selected globally.
import { archiveWorlds, classifyWorlds, isCharacterArchive } from './bunnymo';
import type { BunnyMoEntryLike } from './bunnymo';
import { hash53 } from './hash';
import { CANON_BOOK_PREFIX, MAESTRO_BOOK_PREFIX } from './lore-journal';
import { bookVersion } from './rules-lore';

export type RoleId =
    | 'bunnymo.core'
    | 'bunnymo.pack'
    | 'ck.archive'
    | 'world'
    | 'card'
    | 'npc'
    | 'canon'
    | 'maestro'
    | 'chat'
    | 'persona'
    | 'backup'
    | 'unknown';

export const ROLE_IDS: readonly RoleId[] = [
    'bunnymo.core',
    'bunnymo.pack',
    'ck.archive',
    'world',
    'card',
    'npc',
    'canon',
    'maestro',
    'chat',
    'persona',
    'backup',
    'unknown',
];

/** Roles that depend on the open chat and stick while the content is unchanged. */
const STICKY_ROLES: ReadonlySet<RoleId> = new Set(['chat', 'npc']);
/** Share of character archives that makes a book an archive book even outside CK's repo list. */
const ARCHIVE_SHARE = 0.5;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRoleId(value: unknown): value is RoleId {
    return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value);
}

export function isCanonBookName(name: string): boolean {
    return name.startsWith(CANON_BOOK_PREFIX);
}

export function isMaestroBookName(name: string): boolean {
    return name.startsWith(MAESTRO_BOOK_PREFIX) && !isCanonBookName(name);
}

/** "World (backup 2026-10-04 12-00)" from the Localizer, "World.carrot_backup" from CarrotKernel. */
export function isBackupBookName(name: string): boolean {
    return /\(backup/i.test(name) || /\.carrot_backup$/i.test(name.trim());
}

/** What the content says about a book; cached in the registry while the fingerprint is unchanged. */
export interface ContentFacts {
    bunnymo: 'core' | 'pack' | null;
    /** Entries that are character archives (`<BunnymoTags>` with a real name or tags). */
    archives: number;
    entries: number;
    /** Book-level `extensions.maestro.role`. */
    maestroRole: string | null;
}

function entriesOf(data: unknown): Dict[] {
    const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
    return Object.values(entries).filter(isDict);
}

function maestroRoleOf(data: unknown): string | null {
    const extensions = isDict(data) ? data.extensions : undefined;
    const maestro = isDict(extensions) ? extensions.maestro : undefined;
    return isDict(maestro) && typeof maestro.role === 'string' ? maestro.role : null;
}

/** Classifies a loaded book (`{entries, extensions}`) with the BunnyMo heuristics. */
export function contentFacts(book: string, data: unknown): ContentFacts {
    const entries = entriesOf(data);
    const light: BunnyMoEntryLike[] = entries.map((entry) => ({
        key: entry.key,
        keysecondary: entry.keysecondary,
        comment: entry.comment,
        content: entry.content,
        world: book,
    }));
    const { core, packs } = classifyWorlds(light);
    const enabled = light.filter((_, index) => entries[index]?.disable !== true);
    const archives = archiveWorlds(enabled).has(book) ? enabled.filter((entry) => isCharacterArchive(entry)).length : 0;
    return {
        bunnymo: core.has(book) ? 'core' : packs.has(book) ? 'pack' : null,
        archives,
        entries: entries.length,
        maestroRole: maestroRoleOf(data),
    };
}

function joined(value: unknown): string {
    return Array.isArray(value) ? value.map((item) => String(item)).join('\u0002') : '';
}

/**
 * Fingerprint of a book's content: uid, keys, title and text of every entry plus the book-level Maestro role.
 * Settings such as order or position do not change the kind of a book and are left out.
 */
export function bookFingerprint(data: unknown): string {
    const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
    const parts: string[] = [];
    for (const key of Object.keys(entries).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0))) {
        const entry = entries[key];
        if (!isDict(entry)) continue;
        parts.push(
            [
                key,
                joined(entry.key),
                joined(entry.keysecondary),
                String(entry.comment ?? ''),
                String(entry.content ?? ''),
            ].join('\u0001'),
        );
    }
    parts.push(maestroRoleOf(data) ?? '');
    return `${parts.length - 1}:${hash53(parts.join('\u0003')).toString(36)}`;
}

/** Bindings and neighbour state the binding roles are read from. */
export interface RoleContext {
    /** CarrotKernel Character Repos. */
    ckRepos: ReadonlySet<string>;
    /** Primary and extra books of every character. */
    cardBooks: ReadonlySet<string>;
    /** The chat book of the open chat. */
    chatBook: string | null;
    /** Persona books (current and every persona's). */
    personaBooks: ReadonlySet<string>;
    /** DES characters of the open chat, lower case. */
    npcNames: ReadonlySet<string>;
    /** Globally selected books (a sticky chat/NPC role is dropped when the book becomes global). */
    globalBooks: ReadonlySet<string>;
}

export function emptyRoleContext(): RoleContext {
    return {
        ckRepos: new Set(),
        cardBooks: new Set(),
        chatBook: null,
        personaBooks: new Set(),
        npcNames: new Set(),
        globalBooks: new Set(),
    };
}

/** What the registry remembers about a book. */
export interface RoleRecord {
    role: RoleId;
    source: 'auto' | 'user';
    fingerprint: string;
    pack?: { name: string; version?: string };
    facts?: ContentFacts;
    at: number;
}

/**
 * The automatic role of a book. `facts` is null when the book could not be read (then only names and bindings
 * decide, and 'unknown' is the fallback instead of 'world').
 */
export function detectRole(
    book: string,
    facts: ContentFacts | null,
    context: RoleContext,
    previous?: Pick<RoleRecord, 'role' | 'source' | 'fingerprint'>,
    fingerprint?: string,
): RoleId {
    if (isCanonBookName(book) || facts?.maestroRole === 'canon') return 'canon';
    if (isMaestroBookName(book) || facts?.maestroRole === 'maestro') return 'maestro';
    if (isBackupBookName(book)) return 'backup';
    if (facts?.bunnymo === 'core') return 'bunnymo.core';
    if (facts?.bunnymo === 'pack') return 'bunnymo.pack';
    if (context.ckRepos.has(book)) return 'ck.archive';
    if (facts && facts.archives > 0 && facts.archives / Math.max(facts.entries, 1) >= ARCHIVE_SHARE)
        return 'ck.archive';
    if (context.cardBooks.has(book)) return 'card';
    if (context.chatBook === book) return 'chat';
    if (context.personaBooks.has(book)) return 'persona';
    if (context.npcNames.has(book.trim().toLowerCase())) return 'npc';
    if (
        previous &&
        previous.source === 'auto' &&
        STICKY_ROLES.has(previous.role) &&
        fingerprint !== undefined &&
        previous.fingerprint === fingerprint &&
        !context.globalBooks.has(book)
    ) {
        return previous.role;
    }
    return facts ? 'world' : 'unknown';
}

/** Lore Studio rules of a role: BunnyMo books are read-only and never localised (P13); backups are not localised. */
export function roleTraits(role: RoleId): { readOnly: boolean; localizable: boolean } {
    const bunnymo = role === 'bunnymo.core' || role === 'bunnymo.pack';
    return { readOnly: bunnymo, localizable: !bunnymo && role !== 'backup' };
}

/** Pack name and version from a BunnyMo book name ("MBTI V2" → MBTI, 2). */
export function packInfo(book: string): { name: string; version?: string } {
    const version = bookVersion(book);
    const name = book
        .replace(/[\s_-]*[vV]\.?\s*\d+(?:\.\d+)*\s*$/, '')
        .replace(/[\s_-]+$/, '')
        .trim();
    return version.length ? { name: name || book, version: version.join('.') } : { name: book };
}

/* ------------------------------------------------------------------ registry file */

export interface RoleRegistryFile {
    schema: 1;
    books: Record<string, RoleRecord>;
}

export function emptyRegistry(): RoleRegistryFile {
    return { schema: 1, books: {} };
}

function readFacts(value: unknown): ContentFacts | undefined {
    if (!isDict(value)) return undefined;
    const bunnymo = value.bunnymo === 'core' || value.bunnymo === 'pack' ? value.bunnymo : null;
    const number = (field: unknown) => (typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : 0);
    return {
        bunnymo,
        archives: number(value.archives),
        entries: number(value.entries),
        maestroRole: typeof value.maestroRole === 'string' ? value.maestroRole : null,
    };
}

/** A stored registry with junk records dropped. */
export function readRegistry(raw: unknown): RoleRegistryFile {
    const registry = emptyRegistry();
    const books = isDict(raw) && isDict(raw.books) ? raw.books : {};
    for (const [book, record] of Object.entries(books)) {
        if (!book || !isDict(record) || !isRoleId(record.role)) continue;
        const item: RoleRecord = {
            role: record.role,
            source: record.source === 'user' ? 'user' : 'auto',
            fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : '',
            at: typeof record.at === 'number' ? record.at : 0,
        };
        if (isDict(record.pack) && typeof record.pack.name === 'string') {
            item.pack = { name: record.pack.name };
            if (typeof record.pack.version === 'string') item.pack.version = record.pack.version;
        }
        const facts = readFacts(record.facts);
        if (facts) item.facts = facts;
        registry.books[book] = item;
    }
    return registry;
}

/** Another tab's registry plus this tab's changes (`dirty` books take this tab's record; absent = removed here). */
export function mergeRegistry(
    stored: RoleRegistryFile,
    local: RoleRegistryFile,
    dirty: ReadonlySet<string>,
): RoleRegistryFile {
    const merged: RoleRegistryFile = { schema: 1, books: { ...stored.books } };
    for (const book of dirty) {
        const record = local.books[book];
        if (record) merged.books[book] = record;
        else delete merged.books[book];
    }
    return merged;
}

/** Records differ in what the API reports (role, source, fingerprint, pack). */
export function sameRecord(a: RoleRecord | undefined, b: RoleRecord | undefined): boolean {
    if (!a || !b) return a === b;
    return (
        a.role === b.role &&
        a.source === b.source &&
        a.fingerprint === b.fingerprint &&
        a.pack?.name === b.pack?.name &&
        a.pack?.version === b.pack?.version
    );
}
