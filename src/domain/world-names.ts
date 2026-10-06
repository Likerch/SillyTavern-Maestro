// World model names (M7, plan §4.2): normalisation, entity ids, name-like lorebook keys and the mention matcher.
// Russian text declines names, so matching works on normalised text (NFC, lower case, ё → е, one space) with a left
// word boundary; Cyrillic needles may be followed by a short case ending, Latin ones need a right boundary too
// («Ann» must not fire inside «Annual»). Pure: no DOM, no SillyTavern.
import { hasCyrillic, isRegexKey, russianStem } from './canon-keys';

/** Entity kinds of the world model (same ids as `EntityKind` in src/features/world/api.ts). */
export const WORLD_KINDS = [
    'persona',
    'character',
    'place',
    'item',
    'faction',
    'event',
    'tradition',
    'promise',
    'secret',
    'quest',
    'mechanic',
] as const;

export type WorldKind = (typeof WORLD_KINDS)[number];

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const LETTER_RE = /\p{L}/u;
const MAX_NAME_CHARS = 60;
const MAX_NAME_WORDS = 4;
/** Letters a Cyrillic name may be followed by (a case ending the forms did not list: «Анн|ой»). */
const NAME_TAIL = 2;
/** Letters after a stem («Маш» + «енька» is too much, «Маш» + «ей» is fine). */
const STEM_TAIL = 3;
const MIN_NEEDLE = 2;

export function isWorldKind(value: unknown): value is WorldKind {
    return typeof value === 'string' && (WORLD_KINDS as readonly string[]).includes(value);
}

/** Order of kinds in lists (persona first, then people, places, things). */
export function kindOrder(kind: string): number {
    const index = (WORLD_KINDS as readonly string[]).indexOf(kind);
    return index < 0 ? WORLD_KINDS.length : index;
}

/** People share one namespace: a DES roster name equal to the persona's name is the persona. */
export function kindFamily(kind: string): string {
    return kind === 'character' || kind === 'persona' ? 'being' : kind;
}

/** NFC, lower case, ё → е, whitespace runs → one space, trimmed. */
export function normalizeName(text: string): string {
    return text.normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Same as normalizeName but keeps the length of leading/trailing text (used on whole messages). */
function normalizeText(text: string): string {
    return text.normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/** `${kind}:${normalised name}` (places use their registry id instead). */
export function entityIdOf(kind: string, name: string): string {
    return `${kind}:${normalizeName(name)}`;
}

/** Order-independent key of two ids (separated pairs, proposed merges). */
export function pairKey(a: string, b: string): string {
    return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** The two ids of a pair key (null for junk). */
export function splitPairKey(key: string): [string, string] | null {
    const parts = key.split('\u0000');
    return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

export function wordsOf(normalized: string): string[] {
    return normalized.split(' ').filter(Boolean);
}

/**
 * A lorebook key or alias that can stand for a name: not a regex, no macros, not a BunnyMo tag or sheet command,
 * one line of at most four words and 60 characters, with at least one letter.
 */
export function looksLikeName(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (text.length < MIN_NEEDLE || text.length > MAX_NAME_CHARS) return false;
    if (isRegexKey(text) || text.includes('{{') || /[\n\r<>]/.test(text) || /^[!@#/]/.test(text)) return false;
    if (!LETTER_RE.test(text)) return false;
    return wordsOf(normalizeName(text)).length <= MAX_NAME_WORDS;
}

/** Name-like values, trimmed, unique by normalised form, first spelling kept. */
export function nameList(values: Iterable<unknown>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (!looksLikeName(value)) continue;
        const text = value.trim();
        const key = normalizeName(text);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

/** «Лиз, Лиза; Liz» → names (typed entries keep aliases in one comma-separated field). */
export function splitAliases(text: unknown): string[] {
    return typeof text === 'string' ? nameList(text.split(/[,;\n]/)) : [];
}

/* ------------------------------------------------------------------ mentions */

export interface MentionNeedle {
    /** Normalised text. */
    needle: string;
    /** Word characters allowed right after the needle before a boundary. */
    tail: number;
}

export interface MentionRow {
    id: string;
    needles: MentionNeedle[];
}

export interface MentionMatcher {
    rows: MentionRow[];
}

/**
 * Needles of one entity: every name, alias and form (Cyrillic ones may take a short ending, Latin ones need a right
 * boundary). With `stems` (no DES-RU forms known), single Cyrillic words also give their stem («Маша» → «Маш»).
 */
export function mentionNeedles(names: readonly string[], forms: readonly string[], stems: boolean): MentionNeedle[] {
    const out = new Map<string, number>();
    const add = (needle: string, tail: number) => {
        if (needle.length < MIN_NEEDLE) return;
        const known = out.get(needle);
        if (known === undefined || known < tail) out.set(needle, tail);
    };
    for (const raw of [...names, ...forms]) {
        if (typeof raw !== 'string') continue;
        const needle = normalizeName(raw);
        if (!needle) continue;
        const cyrillic = hasCyrillic(needle);
        add(needle, cyrillic ? NAME_TAIL : 0);
        if (stems && cyrillic && !needle.includes(' ')) {
            const stem = normalizeName(russianStem(raw));
            if (stem !== needle) add(stem, STEM_TAIL);
        }
    }
    return [...out].map(([needle, tail]) => ({ needle, tail }));
}

export function buildMentionMatcher(rows: Iterable<MentionRow>): MentionMatcher {
    return { rows: [...rows].filter((row) => row.needles.length > 0) };
}

/** Position of the first occurrence with a left boundary and at most `tail` word characters after it; -1 if none. */
export function findNeedle(text: string, needle: string, tail: number): number {
    if (!needle) return -1;
    let from = 0;
    for (;;) {
        const index = text.indexOf(needle, from);
        if (index < 0) return -1;
        from = index + 1;
        const before = index > 0 ? text[index - 1] : undefined;
        if (before !== undefined && WORD_CHAR_RE.test(before)) continue;
        const end = index + needle.length;
        let extra = 0;
        while (end + extra < text.length && WORD_CHAR_RE.test(text[end + extra] ?? '') && extra <= tail) extra++;
        if (extra <= tail) return index;
    }
}

const WORD_SPLIT_RE = /[^\p{L}\p{N}_]+/u;

/**
 * The words of a chat with the message each first appears in (plan-2 §9: does this chat name someone?). Messages are
 * read once; a name is then looked up among the words instead of in every message: a needle matches a word that
 * starts with it and has at most `tail` more characters — what findNeedle accepts at a word start.
 */
export class WordIndex {
    private readonly first = new Map<string, number>();
    /** Words by their first two and three characters. */
    private readonly buckets = new Map<string, string[]>();
    /** Messages read (the next one to read). */
    size = 0;
    /** Bumped whenever a new word is learned: a name not found stays not found until then. */
    version = 0;

    add(index: number, text: string): void {
        for (const word of normalizeText(text).split(WORD_SPLIT_RE)) {
            if (!word) continue;
            const known = this.first.get(word);
            if (known !== undefined && known <= index) continue;
            if (known === undefined) {
                for (const length of [2, 3]) {
                    if (word.length < length) continue;
                    const key = word.slice(0, length);
                    const bucket = this.buckets.get(key);
                    if (bucket) bucket.push(word);
                    else this.buckets.set(key, [word]);
                }
                this.version++;
            }
            this.first.set(word, index);
        }
    }

    /**
     * The first message using a one-word needle, -1 if none. Null for a needle of several words (or with a hyphen):
     * the caller reads the messages that have all its words (wordsAt).
     */
    firstOf(needle: MentionNeedle): number | null {
        const text = needle.needle;
        if (WORD_SPLIT_RE.test(text)) return null;
        let best = -1;
        for (const word of this.buckets.get(text.slice(0, Math.min(3, text.length))) ?? []) {
            if (word.length - text.length > needle.tail || !word.startsWith(text)) continue;
            const at = this.first.get(word) ?? -1;
            if (at >= 0 && (best < 0 || at < best)) best = at;
        }
        return best;
    }

    /** From which message every word of a several-word needle has appeared (-1: one of them never did). */
    wordsAt(needle: MentionNeedle): number {
        const words = needle.needle.split(WORD_SPLIT_RE).filter(Boolean);
        let from = 0;
        for (const [index, word] of words.entries()) {
            const at =
                index === words.length - 1
                    ? (this.firstOf({ needle: word, tail: needle.tail }) ?? -1)
                    : (this.first.get(word) ?? -1);
            if (at < 0) return -1;
            from = Math.max(from, at);
        }
        return from;
    }
}

/** Ids of the rows mentioned in `text`, in order of their first mention. */
export function findMentions(matcher: MentionMatcher, text: string): string[] {
    if (!text || !matcher.rows.length) return [];
    const haystack = normalizeText(text);
    const hits: { id: string; at: number }[] = [];
    for (const row of matcher.rows) {
        let best = -1;
        for (const { needle, tail } of row.needles) {
            const at = findNeedle(haystack, needle, tail);
            if (at >= 0 && (best < 0 || at < best)) best = at;
        }
        if (best >= 0) hits.push({ id: row.id, at: best });
    }
    hits.sort((a, b) => a.at - b.at);
    return hits.map((hit) => hit.id);
}
