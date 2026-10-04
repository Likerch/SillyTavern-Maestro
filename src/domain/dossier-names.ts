// Dossier (M7) name helpers: normalisation, entity ids, whether entry keys fire on a name, whether two names are the
// same person, and mention matching in Russian and English text. Pure.
//
// Key coverage repeats SillyTavern's matching closely enough for structural checks (research/st-world-info.md §10):
// a regex key is tested as is; a plain Cyrillic key fires inside a longer word (ST's whole-word boundary `\W` is
// ASCII-only), so a stem key «Лир» covers «Лиру», «Лирой»; a plain Latin key needs whole words.
import {
    containsWithLeftBoundary,
    hasCyrillic,
    isRegexKey,
    normalizeForMatch,
    russianStem,
    uniqueStrings,
} from './canon-keys';
import { parseRegexKey } from './lore-match';
import { sameCharacter } from './sheet-context';

const MIN_STEM = 3;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/** Lower case, ё → е, `_` → space, whitespace collapsed, trimmed. Non-strings give ''. */
export function normName(name: unknown): string {
    if (typeof name !== 'string') return '';
    return normalizeForMatch(name).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `${kind}:${normalised name}` (the world model's id scheme for named entities). */
export function entityIdFor(kind: string, name: string): string {
    return `${kind}:${normName(name)}`;
}

/** The kind part of an entity id ('' when the id has none). */
export function entityKindOf(id: string): string {
    const index = id.indexOf(':');
    return index > 0 ? id.slice(0, index) : '';
}

/** Does this key make an entry fire on a text holding `name`? */
export function keyCovers(key: string, name: string): boolean {
    const trimmed = key.trim();
    const target = name.trim();
    if (!trimmed || !target || trimmed.includes('{{')) return false;
    if (isRegexKey(trimmed)) {
        const regex = parseRegexKey(trimmed);
        if (!regex) return false;
        regex.lastIndex = 0;
        if (regex.test(target)) return true;
        regex.lastIndex = 0;
        return regex.test(normName(target));
    }
    const k = normName(trimmed);
    const n = normName(target);
    if (!k || !n) return false;
    if (k === n) return true;
    if (hasCyrillic(k)) return k.length >= MIN_STEM && containsWithLeftBoundary(n, k);
    return n.startsWith(`${k} `) || n.endsWith(` ${k}`) || n.includes(` ${k} `);
}

/** Some key of the list covers the name. */
export function keysCover(keys: readonly string[], name: string): boolean {
    return keys.some((key) => keyCovers(key, name));
}

/** Forms (in order, unique) that no key covers. */
export function uncoveredForms(keys: readonly string[], forms: readonly string[]): string[] {
    return uniqueStrings(forms).filter((form) => !keysCover(keys, form));
}

/** A plain (not regex, no macros) key with Cyrillic letters. */
export function isCyrillicPlainKey(key: string): boolean {
    const trimmed = key.trim();
    return hasCyrillic(trimmed) && !isRegexKey(trimmed) && !trimmed.includes('{{');
}

/**
 * A name agrees with the canonical one: same after normalisation, one of the known names (aliases, forms), or the same
 * person by words («Elizabeth_Smith» vs «Elizabeth», «Веру» vs «Вера»). Empty names agree.
 */
export function nameAgrees(name: string, canonical: string, known: Iterable<string> = []): boolean {
    const n = normName(name);
    if (!n || !normName(canonical)) return true;
    if (n === normName(canonical)) return true;
    for (const other of known) if (normName(other) === n) return true;
    return sameCharacter(name, canonical);
}

/** Normalised names of a set (unique, non-empty). */
export function normSet(names: Iterable<unknown>): Set<string> {
    const set = new Set<string>();
    for (const name of names) {
        const value = normName(name);
        if (value) set.add(value);
    }
    return set;
}

/** Two name lists share a name after normalisation. */
export function namesOverlap(a: Iterable<unknown>, b: Iterable<unknown>): boolean {
    const left = normSet(a);
    for (const name of normSet(b)) if (left.has(name)) return true;
    return false;
}

export interface MentionMatcher {
    /** Cyrillic needles: left boundary only (case endings stay open). */
    open: string[];
    /** Latin needles: whole words. */
    closed: string[];
}

/** Needles for the names of one entity: the names themselves plus the stem of one-word Russian names. */
export function mentionMatcher(names: Iterable<string>): MentionMatcher {
    const open = new Set<string>();
    const closed = new Set<string>();
    for (const raw of names) {
        const name = normName(raw);
        if (name.length < 2) continue;
        if (!hasCyrillic(name)) {
            closed.add(name);
            continue;
        }
        open.add(name);
        if (!name.includes(' ')) {
            const stem = normName(russianStem(name));
            if (stem.length >= MIN_STEM) open.add(stem);
        }
    }
    return { open: [...open], closed: [...closed] };
}

function closedHit(text: string, needle: string): boolean {
    let from = 0;
    for (;;) {
        const index = text.indexOf(needle, from);
        if (index < 0) return false;
        const before = index > 0 ? text[index - 1] : undefined;
        const after = text[index + needle.length];
        const leftOk = before === undefined || !WORD_CHAR_RE.test(before);
        const rightOk = after === undefined || !WORD_CHAR_RE.test(after);
        if (leftOk && rightOk) return true;
        from = index + 1;
    }
}

/** The text mentions the entity (case-insensitive, ё = е). */
export function mentionsAny(matcher: MentionMatcher, text: string): boolean {
    if (!text || (!matcher.open.length && !matcher.closed.length)) return false;
    const haystack = normalizeForMatch(text).replace(/_/g, ' ');
    return (
        matcher.open.some((needle) => containsWithLeftBoundary(haystack, needle)) ||
        matcher.closed.some((needle) => closedHit(haystack, needle))
    );
}
