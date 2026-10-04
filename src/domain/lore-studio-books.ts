// Book-level logic of the Lore Studio (M23, M35 п. 3): sections by role, free and sanitized names, the links a
// book has (global, characters, personas, chat, DES campaigns) and their rename. Pure.

/** Role ids of M35 (same strings as features/bookRoles/api.ts BookRole). */
export type StudioRole =
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

export type SectionId = 'chat' | 'card' | 'world' | 'characters' | 'system' | 'maestro' | 'backup';

/** Section display order (M35 п. 3: «Этот чат», «Карточка», «Мир», «Персонажи», «Система», «Maestro», «Копии»). */
export const SECTION_ORDER: readonly SectionId[] = [
    'chat',
    'card',
    'world',
    'characters',
    'system',
    'maestro',
    'backup',
];

export interface SectionContext {
    /** Chat book of the current chat (`chat_metadata.world_info`). */
    chatBook?: string | null;
    /** Current persona's book. */
    personaBook?: string | null;
    /** Canon book of the current chat (M6). */
    canonBook?: string | null;
    /** Primary and additional books of the current character(s). */
    characterBooks?: readonly string[];
}

export function sectionOfRole(role: StudioRole): SectionId {
    switch (role) {
        case 'bunnymo.core':
        case 'bunnymo.pack':
            return 'system';
        case 'ck.archive':
        case 'npc':
            return 'characters';
        case 'card':
            return 'card';
        case 'canon':
        case 'maestro':
            return 'maestro';
        case 'backup':
            return 'backup';
        case 'chat':
        case 'persona':
        case 'world':
        default:
            return 'world';
    }
}

/**
 * Section of a book: bindings of the current chat come first (its canon, chat and persona books), then the
 * current character's books (unless they are system books), then the role.
 */
export function sectionOf(book: string, role: StudioRole, context: SectionContext): SectionId {
    if (role === 'bunnymo.core' || role === 'bunnymo.pack') return 'system';
    if (role === 'backup') return 'backup';
    if (book === context.canonBook || book === context.chatBook || book === context.personaBook) return 'chat';
    if (context.characterBooks?.includes(book)) return 'card';
    return sectionOfRole(role);
}

export interface Section {
    id: SectionId;
    books: string[];
}

/** Books grouped by section in SECTION_ORDER; books keep their input order inside a section; empty sections dropped. */
export function groupBooks(
    books: readonly string[],
    roleOf: (book: string) => StudioRole,
    context: SectionContext,
): Section[] {
    const map = new Map<SectionId, string[]>();
    for (const book of books) {
        const id = sectionOf(book, roleOf(book), context);
        const list = map.get(id) ?? [];
        list.push(book);
        map.set(id, list);
    }
    return SECTION_ORDER.filter((id) => map.has(id)).map((id) => ({ id, books: map.get(id) as string[] }));
}

export interface RoleHints {
    bunnyCore?: readonly string[];
    bunnyPacks?: readonly string[];
    ckArchives?: readonly string[];
    canonBooks?: readonly string[];
    cardBooks?: readonly string[];
    /** DES roster names (books named after a character are NPC books). */
    rosterNames?: readonly string[];
}

const BACKUP_RE = /\(backup\b|\.carrot_backup|\bbackup\s*\d{4}/i;
const CANON_RE = /^Maestro · канон · /;

/** Role guess used when M35 (bookRoles) is not running: neighbour adapters' lists and name patterns. */
export function fallbackRole(book: string, hints: RoleHints = {}): StudioRole {
    if (hints.bunnyCore?.includes(book)) return 'bunnymo.core';
    if (hints.bunnyPacks?.includes(book)) return 'bunnymo.pack';
    if (BACKUP_RE.test(book)) return 'backup';
    if (hints.canonBooks?.includes(book) || CANON_RE.test(book)) return 'canon';
    if (hints.ckArchives?.includes(book)) return 'ck.archive';
    if (hints.cardBooks?.includes(book)) return 'card';
    if (hints.rosterNames?.includes(book)) return 'npc';
    return 'world';
}

/** BunnyMo core and packs are read-only in the studio (P13). */
export function isReadOnlyRole(role: StudioRole): boolean {
    return role === 'bunnymo.core' || role === 'bunnymo.pack';
}

/** ST's `equalsIgnoreCaseAndAccents` (utils.js): NFD, no combining marks, lower case. */
export function foldName(name: string): string {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function sameName(a: string, b: string): boolean {
    return foldName(a) === foldName(b);
}

/** Existing book whose name equals `name` ignoring case and accents. */
export function findSameName(name: string, books: readonly string[]): string | undefined {
    const folded = foldName(name);
    return books.find((book) => foldName(book) === folded);
}

const ILLEGAL_RE = /[/?<>\\:*|"]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED_RE = /^\.+$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const TRAILING_RE = /[. ]+$/;

/**
 * `sanitize-filename` as the server applies it to book file names (SRV-WI:151): illegal and control characters
 * removed, reserved names and trailing dots/spaces dropped, at most 255 UTF-8 bytes. Used when ST's
 * `/api/files/sanitize-filename` is unreachable.
 */
export function sanitizeBookName(name: string): string {
    let result = name.replace(ILLEGAL_RE, '').replace(CONTROL_RE, '');
    if (RESERVED_RE.test(result)) result = '';
    if (WINDOWS_RESERVED_RE.test(result)) result = '';
    result = result.replace(TRAILING_RE, '');
    while (new TextEncoder().encode(result).length > 255) result = result.slice(0, -1);
    return result;
}

/** `getFreeWorldName` (WI:4422-4446): `<name> (N)` with the first free N, after stripping a trailing `(N)`. */
export function freeBookName(base: string, books: readonly string[], stripIndex = true): string {
    const stem = stripIndex ? base.replace(/\s*\(\d+\)$/, '') : base;
    for (let index = 1; index < 100_000; index++) {
        const candidate = `${stem} (${index})`;
        if (!books.includes(candidate)) return candidate;
    }
    return `${stem} (${Date.now()})`;
}

/* ------------------------------------------------------------------ links */

export interface CharLoreItem {
    name: string;
    extraBooks: string[];
}

export interface LinkState {
    global: readonly string[];
    charLore: readonly CharLoreItem[];
    /** Characters: card name, avatar key (file name without extension) and primary book. */
    characters: readonly { name: string; avatar: string; world?: string | null }[];
    /** Book of the current persona (`power_user.persona_description_lorebook`). */
    personaBook?: string | null;
    /** Persona avatar → { name, lorebook }. */
    personas: Readonly<Record<string, { name?: string; lorebook?: string | null }>>;
    chatBook?: string | null;
    campaigns?: readonly { id: string; name: string; books: readonly string[] }[];
    /** Workshop NPC → attached book (read-only in the studio). */
    workshop?: Readonly<Record<string, string>>;
}

export interface BookLinks {
    global: boolean;
    /** Characters with this primary book (card names). */
    primaryOf: string[];
    /** Characters with this additional book (avatar keys of `charLore`, resolved to names when known). */
    extraOf: string[];
    personas: string[];
    currentPersona: boolean;
    chat: boolean;
    campaigns: string[];
    workshop: string[];
}

export function bookLinks(state: LinkState, book: string): BookLinks {
    const nameOfAvatar = (avatar: string) => state.characters.find((item) => item.avatar === avatar)?.name ?? avatar;
    return {
        global: state.global.includes(book),
        primaryOf: state.characters.filter((item) => item.world === book).map((item) => item.name),
        extraOf: state.charLore.filter((item) => item.extraBooks.includes(book)).map((item) => nameOfAvatar(item.name)),
        personas: Object.entries(state.personas)
            .filter(([, persona]) => persona.lorebook === book)
            .map(([avatar, persona]) => persona.name || avatar),
        currentPersona: !!book && state.personaBook === book,
        chat: !!book && state.chatBook === book,
        campaigns: (state.campaigns ?? []).filter((item) => item.books.includes(book)).map((item) => item.name),
        workshop: Object.entries(state.workshop ?? {})
            .filter(([, attached]) => attached === book)
            .map(([npc]) => npc),
    };
}

export function linkCount(links: BookLinks): number {
    return (
        (links.global ? 1 : 0) +
        links.primaryOf.length +
        links.extraOf.length +
        links.personas.length +
        (links.currentPersona && !links.personas.length ? 1 : 0) +
        (links.chat ? 1 : 0) +
        links.campaigns.length +
        links.workshop.length
    );
}

/** `charLore` with `oldName` replaced by `newName` (WI:4232-4241); also returns how many items changed. */
export function renameInCharLore(
    charLore: readonly CharLoreItem[],
    oldName: string,
    newName: string,
): { charLore: CharLoreItem[]; changed: number } {
    let changed = 0;
    const next = charLore.map((item) => {
        if (!item.extraBooks.includes(oldName)) return { ...item, extraBooks: [...item.extraBooks] };
        changed++;
        const books = item.extraBooks.filter((book) => book !== oldName);
        if (!books.includes(newName)) books.push(newName);
        return { ...item, extraBooks: books };
    });
    return { charLore: next, changed };
}

/** `charLore` without a deleted book; items left without books are dropped (ST's `charSetAuxWorlds` rule). */
export function removeFromCharLore(charLore: readonly CharLoreItem[], book: string): CharLoreItem[] {
    return charLore
        .map((item) => ({ ...item, extraBooks: item.extraBooks.filter((name) => name !== book) }))
        .filter((item) => item.extraBooks.length > 0);
}

/** Avatar key of a character (`getCharaFilename`): the avatar file name without its extension. */
export function avatarKey(avatar: string): string {
    return avatar.replace(/\.[^/.]+$/, '');
}
