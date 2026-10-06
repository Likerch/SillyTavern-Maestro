// World model scopes (plan-2 §9 «Офелия из другого чата»): where a record about a person, place or thing lives — this
// chat, the chat's card or every chat (global books, CarrotKernel repos, DES Workshop stores) —, the stable keys the
// chat's identity decisions remember for a source, and «of the card»: a name the chat's card itself uses (its name,
// group members, the persona, words of its text and its own lorebook). A card or global record joins a person of this
// chat without a question only when it is of the card or the user said it is the same. Pure: no DOM, no SillyTavern.
import { stableHash } from './hash';
import { findNeedle, mentionNeedles, normalizeName } from './world-names';

export type WorldScope = 'chat' | 'card' | 'global';

/**
 * `extensions.maestro.origin` of an entry Maestro wrote for one chat into a shared book («Оформить» writes an NPC's
 * archive into a CK repo): the entry is that chat's own, wherever it lives.
 */
export function chatOriginTag(chatId: string): string {
    return `chat:${stableHash(chatId)}`;
}

/** The origin tag of an entry, or null. */
export function entryOrigin(entry: unknown): string | null {
    if (!isDict(entry) || !isDict(entry.extensions)) return null;
    const maestro = entry.extensions.maestro;
    return isDict(maestro) && typeof maestro.origin === 'string' && maestro.origin ? maestro.origin : null;
}

/** `lore:<book>#<uid>` — a lorebook entry (typed record or an entry named after an entity). */
export function entrySourceKey(book: string, uid: number): string {
    return `lore:${book}#${uid}`;
}

/** `ck:<book>#<normalised name>` — a CarrotKernel archive (one name per archive and repo). */
export function archiveSourceKey(book: string, name: string): string {
    return `ck:${book}#${normalizeName(name)}`;
}

/** `nai:<owner>#<passport id>` — a NAI Studio passport; the owner is the card avatar, `persona` or `chat`. */
export function passportSourceKey(owner: string, id: string): string {
    return `nai:${owner}#${id}`;
}

/** `des:<normalised name>` — DES Workshop data kept by name for every chat (portrait, description, relationship). */
export function workshopSourceKey(name: string): string {
    return `des:${normalizeName(name)}`;
}

/** The passport id of a card passport key (NAI Studio switches it off per chat); null for other keys. */
export function cardPassportIdOfKey(key: string): string | null {
    if (!key.startsWith('nai:')) return null;
    const at = key.lastIndexOf('#');
    if (at < 0) return null;
    const owner = key.slice(4, at);
    const id = key.slice(at + 1);
    return owner && owner !== 'persona' && owner !== 'chat' && id ? id : null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function texts(...values: unknown[]): string[] {
    const out: string[] = [];
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) out.push(value);
        else if (Array.isArray(value)) out.push(...texts(...value));
    }
    return out;
}

/**
 * What a card says (ST card fields and their V2 `data` copies): description, personality, scenario, the first message
 * and alternate greetings, dialogue examples, and the keys, names and texts of its embedded character book.
 */
export function cardTexts(card: unknown): string[] {
    if (!isDict(card)) return [];
    const data = isDict(card.data) ? card.data : {};
    const out = texts(
        card.description,
        card.personality,
        card.scenario,
        card.first_mes,
        card.mes_example,
        data.description,
        data.personality,
        data.scenario,
        data.first_mes,
        data.mes_example,
        data.alternate_greetings,
    );
    const book = isDict(data.character_book) ? data.character_book : null;
    const entries = book && Array.isArray(book.entries) ? book.entries : [];
    for (const entry of entries) {
        if (!isDict(entry)) continue;
        out.push(...texts(entry.keys, entry.secondary_keys, entry.key, entry.comment, entry.name, entry.content));
    }
    return [...new Set(out)];
}

/** Texts of lorebook entries (keys, title, content): a card's own book counts as its text. */
export function entryTexts(entry: unknown): string[] {
    if (!isDict(entry)) return [];
    return texts(entry.key, entry.keysecondary, entry.comment, entry.content);
}

export interface CardNameInput {
    /** Names that are the card's by themselves: the card(s), group members, the persona. */
    names: readonly string[];
    /** The card's text (cardTexts) and its own lorebooks (entryTexts). */
    texts: readonly string[];
    /** Russian case forms of a name (DES-RU); without them single Cyrillic words also match by stem. */
    forms?: (name: string) => readonly string[];
}

/**
 * «Of the card»: the name is one of the card's names, or the card's text uses it (a left word boundary, Cyrillic names
 * with a short case ending: «с Офелией»). Answers are cached per name.
 */
export function cardNameMatcher(input: CardNameInput): (name: string) => boolean {
    const own = new Set(input.names.map(normalizeName).filter(Boolean));
    const haystack = normalizeName(input.texts.join('\n'));
    const cache = new Map<string, boolean>();
    return (name: string): boolean => {
        const key = normalizeName(name);
        if (!key) return false;
        const known = cache.get(key);
        if (known !== undefined) return known;
        let found = own.has(key);
        if (!found && haystack) {
            const forms = input.forms?.(name.trim()) ?? [];
            const needles = mentionNeedles([name], forms, forms.length === 0);
            found = needles.some(({ needle, tail }) => findNeedle(haystack, needle, tail) >= 0);
        }
        cache.set(key, found);
        return found;
    };
}

export interface BookScopeInput {
    /** `chatMetadata.world_info`. */
    chatBook?: unknown;
    /** The chat's cards (every group member). */
    cards: readonly unknown[];
    /** world-info.js `world_info.charLore` (extra books per card avatar). */
    charLore?: unknown;
}

/** The chat's own books: the chat book, and each card's primary and extra books (the rest are global). */
export function localBookNames(input: BookScopeInput): { chat: string[]; card: string[] } {
    const chat = typeof input.chatBook === 'string' && input.chatBook.trim() ? [input.chatBook] : [];
    const card = new Set<string>();
    const lore = Array.isArray(input.charLore) ? input.charLore : [];
    for (const raw of input.cards) {
        if (!isDict(raw)) continue;
        const data = isDict(raw.data) ? raw.data : {};
        const extensions = isDict(data.extensions) ? data.extensions : {};
        if (typeof extensions.world === 'string' && extensions.world.trim()) card.add(extensions.world);
        const avatar = typeof raw.avatar === 'string' ? raw.avatar.replace(/\.[^/.]+$/, '') : '';
        if (!avatar) continue;
        for (const item of lore) {
            if (!isDict(item) || item.name !== avatar || !Array.isArray(item.extraBooks)) continue;
            for (const book of item.extraBooks) if (typeof book === 'string' && book.trim()) card.add(book);
        }
    }
    return { chat, card: [...card].filter((book) => !chat.includes(book)) };
}
