// Cyrillic keys under ST's "match whole words" (plan M22, Q35; audit T2, №4, B5; research/st-world-info.md §3).
// ST builds `(?:^|\W)(key)(?:$|\W)` without the `u` flag: `\W` knows only ASCII, so every Cyrillic letter counts as a
// boundary and a Cyrillic key matches as a substring («аня» fires inside «Таня»). A regex key overrides every other
// option of the entry (no matchWholeWords change, no extra hash change), so the fix replaces a plain Cyrillic key with
// `/(?<![\p{L}\p{N}])key/u` (+ `i` when the entry is case-insensitive). The boundary is on the left only: case endings
// keep working («Иван» → «Ивану»). Escaping is our own: ST's escapeRegex escapes `-`, which is a syntax error with `u`;
// braces are written `[{]` / `[}]` because the macro engine turns `\{` into `{`; keys with `{{` are macros and stay.

/** Not preceded by a letter or a digit of any script. */
export const LEFT_BOUNDARY = '(?<![\\p{L}\\p{N}])';

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
/** Anything written like `/…/flags` (ST tries to parse it as a regex key). */
const REGEX_LIKE_RE = /^\/[\s\S]+\/[a-z]*$/i;
const SPECIAL_G = /[.*+?^$()[\]|\\/{}]/g;

/**
 * Escapes a literal for a `u`-mode pattern inside an ST regex key: `. * + ? ^ $ ( ) [ ] | \ /` get a backslash,
 * `{` and `}` become `[{]` and `[}]`, and `-` stays as it is (`\-` is invalid outside a class with `u`).
 */
export function escapeKeyRegex(text: string): string {
    return text.replace(SPECIAL_G, (char) => (char === '{' ? '[{]' : char === '}' ? '[}]' : `\\${char}`));
}

/** ST's `entry.flag ?? global`. */
export function effectiveFlag(value: unknown, global: boolean): boolean {
    return value === null || value === undefined ? global : value === true;
}

/**
 * A key the whole-word bug applies to and the left boundary can replace: one word (ST matches several words as a
 * plain substring anyway), with Cyrillic letters, not a regex key and without macros.
 */
export function isLeftBoundaryCandidate(key: unknown): key is string {
    if (typeof key !== 'string') return false;
    const trimmed = key.trim();
    if (!trimmed || trimmed.includes('{{') || REGEX_LIKE_RE.test(trimmed)) return false;
    return CYRILLIC_RE.test(trimmed) && !/\s/.test(trimmed);
}

/** `/(?<![\p{L}\p{N}])<escaped key>/iu` (or `/u` for a case-sensitive entry). */
export function leftBoundaryKey(key: string, caseSensitive: boolean): string {
    return `/${LEFT_BOUNDARY}${escapeKeyRegex(key.trim())}/${caseSensitive ? 'u' : 'iu'}`;
}

/**
 * A new key list with every candidate replaced by its left-boundary regex, or null when nothing changes (the
 * input is never modified: on scan copies it aliases ST's cache).
 */
export function convertKeyList(value: unknown, caseSensitive: boolean): string[] | null {
    if (!Array.isArray(value) || !value.some(isLeftBoundaryCandidate)) return null;
    return value.map((key: unknown) =>
        isLeftBoundaryCandidate(key) ? leftBoundaryKey(key, caseSensitive) : (key as string),
    );
}
