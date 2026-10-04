// World Info key semantics of SillyTavern 1.19, ported for static checks (research/st-world-info.md §3, §10):
// regex keys (`parseRegexFromString`), plain keys with case and whole-word options, and the whole-word bug for
// Cyrillic: ST builds `(?:^|\W)(key)(?:$|\W)` and JavaScript's `\W` is ASCII-only, so every Cyrillic letter counts
// as a boundary and Cyrillic keys match as plain substrings ("аня" inside "Таня").

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const CYRILLIC_G = /\p{Script=Cyrillic}/gu;
const LETTER_G = /\p{L}/gu;
/** Anything written like `/…/flags` (ST tries to parse it as a regex key). */
const REGEX_LIKE_RE = /^\/[\s\S]+\/[a-z]*$/i;
const TAG_KEY_RE = /^<[^<>]+>$/;
const BARE_TAG_RE = /^<[A-Za-z][A-Za-z0-9_-]*>$/;
const MBTI_TAG_RE = /^<[EI][NS][FT][JP]-[UH]>$/i;

export function hasCyrillic(text: string): boolean {
    return CYRILLIC_RE.test(text);
}

/** Share of Cyrillic letters among all letters of the texts (0 when there are no letters). */
export function cyrillicShare(texts: Iterable<string>): { share: number; letters: number } {
    let letters = 0;
    let cyrillic = 0;
    for (const text of texts) {
        letters += text.match(LETTER_G)?.length ?? 0;
        cyrillic += text.match(CYRILLIC_G)?.length ?? 0;
    }
    return { share: letters ? cyrillic / letters : 0, letters };
}

/** The chat is Russian: enough letters and at least 30 % of them Cyrillic (English names and tags are common). */
export function isRussianChat(texts: Iterable<string>, minLetters = 200): boolean {
    const { share, letters } = cyrillicShare(texts);
    return letters >= minLetters && share >= 0.3;
}

export function looksLikeRegexKey(key: string): boolean {
    return REGEX_LIKE_RE.test(key.trim());
}

/**
 * ST's `parseRegexFromString` (world-info.js): `/pattern/flags` with flags from `gimsuy`, no unescaped `/` inside,
 * and a pattern the engine accepts. Null when the key is not a (valid) regex key — ST then matches it as text.
 */
export function parseRegexKey(key: string): RegExp | null {
    const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(key);
    if (!match) return null;
    let pattern = match[1] ?? '';
    const flags = match[2] ?? '';
    if (/(^|[^\\])\//.test(pattern)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

export type RegexKeyProblem = 'flags' | 'slash' | 'syntax' | 'braces';

/**
 * Why a key written like a regex does not work in ST:
 * - 'flags' (unknown flags), 'slash' (unescaped `/` inside), 'syntax' (the engine rejects the pattern, e.g. `\-` in
 *   `u` mode): ST silently treats the key as plain text, which never matches;
 * - 'braces': `\{` / `\}` — the macro engine turns them into bare braces before matching (audit T2), so the
 *   pattern changes meaning; `[{]` is the safe spelling.
 * Null for valid regex keys and for keys that do not look like regexes.
 */
export function regexKeyProblem(key: string): RegexKeyProblem | null {
    const trimmed = key.trim();
    if (!looksLikeRegexKey(trimmed)) return null;
    const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(trimmed);
    if (!match) {
        // The last-slash split may differ from the lazy one: try the greedy form to tell flags from slashes.
        const greedy = /^\/([\w\W]+)\/([a-z]*)$/i.exec(trimmed);
        return greedy && /[^gimsuy]/.test(greedy[2] ?? '') ? 'flags' : 'slash';
    }
    const pattern = match[1] ?? '';
    if (/(^|[^\\])\//.test(pattern)) return 'slash';
    if (!parseRegexKey(trimmed)) return 'syntax';
    return /\\[{}]/.test(pattern) ? 'braces' : null;
}

/** `<KEY:VALUE>`, `<ELF>`, `<ESFP-H>`: tag keys (BunnyMo); they never come from prose. */
export function isTagKey(key: string): boolean {
    return TAG_KEY_RE.test(key.trim());
}

/** A bare tag without a colon (`<NSFW>`, `<DERE>`); MBTI archetypes included. */
export function isBareTagKey(key: string): boolean {
    return BARE_TAG_RE.test(key.trim());
}

export function isMbtiTag(key: string): boolean {
    return MBTI_TAG_RE.test(key.trim());
}

/** ST's `escapeRegex` (utils.js). */
export function escapeRegexLikeSt(text: string): string {
    return text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** ASCII word character: what `\w` means without the `u` flag (and what ST's boundary is built from). */
export function isAsciiWordChar(char: string | undefined): boolean {
    return char !== undefined && char !== '' && /\w/.test(char);
}

export interface MatchOptions {
    caseSensitive: boolean;
    wholeWords: boolean;
}

/** One key against a haystack, exactly like ST's `WorldInfoBuffer.matchKeys` (keys with macros are not expanded). */
export function matchKey(haystack: string, key: string, options: MatchOptions): boolean {
    const needle = key.trim();
    if (!needle) return false;
    const regex = parseRegexKey(needle);
    if (regex) {
        regex.lastIndex = 0;
        return regex.test(haystack);
    }
    const hay = options.caseSensitive ? haystack : haystack.toLowerCase();
    const word = options.caseSensitive ? needle : needle.toLowerCase();
    if (!options.wholeWords || word.split(/\s+/).length > 1) return hay.includes(word);
    return new RegExp(`(?:^|\\W)(${escapeRegexLikeSt(word)})(?:$|\\W)`).test(hay);
}

/** True when the whole-word bug applies: a plain single-word key that contains Cyrillic letters. */
export function isCyrillicWholeWordKey(key: string): boolean {
    const trimmed = key.trim();
    return hasCyrillic(trimmed) && !looksLikeRegexKey(trimmed) && trimmed.split(/\s+/).length === 1;
}

/**
 * Pack key normalisation (research/bunnymo-carrotkernel.md §1.6): trim, upper case, no spaces after `:` (packs
 * contain `<LING: HORNY>`). Regex keys stay verbatim.
 */
export function normalizePackKey(key: string): string {
    const trimmed = key.trim();
    if (looksLikeRegexKey(trimmed)) return trimmed;
    return trimmed.toUpperCase().replace(/:\s+/g, ':');
}
