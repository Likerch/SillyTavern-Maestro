// M6 «Канон чата» — Russian keys and scan-only glosses (plan M6 п. 2, M20 п. 5; audit T2, A7).
//
// Canon entries are written in English but must fire on Russian chat text:
// - keys: DES-RU case forms when available; otherwise the term itself plus a left-boundary regex key built with our
//   own escaper. ST's `escapeRegex` escapes `-`, and `\-` outside a class is a syntax error under the `u` flag (the
//   key would never match); ST's macro engine turns `\{` into `{`, so braces go through `[{]`/`[}]`; keys holding
//   `{{` are skipped. Only a LEFT boundary: the right side must stay open for case endings («Элизабет|ой»).
// - glosses: when a Russian form of a known name appears in recent messages, its English name is added to the scan
//   buffer through a scan-only extension prompt (the model never sees it), so English books fire too.
// Pure: no DOM, no SillyTavern.
import { parseRegexKey } from './lore-match';

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /[A-Za-z]/;
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const REGEX_KEY_RE = /^\/[\s\S]+\/[gimsuy]*$/;
/** Endings dropped from a Russian name to reach a stem that also matches the other case forms. */
const STEM_ENDING_RE = /[аяоеёьйыиуюэ]$/i;
const MIN_STEM = 3;

export function hasCyrillic(text: string): boolean {
    return CYRILLIC_RE.test(text);
}

export function hasLatin(text: string): boolean {
    return LATIN_RE.test(text);
}

/** A `/pattern/flags` key (ST's regex key syntax). */
export function isRegexKey(key: string): boolean {
    return REGEX_KEY_RE.test(key.trim());
}

/** Lower case with ё folded to е: Russian texts mix both spellings. */
export function normalizeForMatch(text: string): string {
    return text.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Escapes a literal for a `/…/u` World Info key. Unlike ST's escapeRegex it leaves `-` alone (an escaped hyphen
 * outside a class is invalid with `u`), writes braces as classes (the macro engine eats `\{`), escapes `/` (ST
 * rejects an unescaped slash inside the pattern), matches any whitespace run between words and both е and ё.
 */
export function escapeForKey(text: string): string {
    let out = '';
    let space = false;
    for (const char of text.trim()) {
        if (/\s/.test(char)) {
            if (!space) out += '\\s+';
            space = true;
            continue;
        }
        space = false;
        if (char === '{') out += '[{]';
        else if (char === '}') out += '[}]';
        else if (char === 'е' || char === 'ё') out += '[её]';
        else if (char === 'Е' || char === 'Ё') out += '[ЕЁ]';
        else if ('\\^$.*+?()[]|/'.includes(char)) out += `\\${char}`;
        else out += char;
    }
    return out;
}

/** Drops one final vowel, soft sign or й when the rest keeps at least three letters (Маша → Маш, Анна → Анн). */
export function russianStem(word: string): string {
    const trimmed = word.trim();
    if (!hasCyrillic(trimmed) || /\s/.test(trimmed)) return trimmed;
    const stem = trimmed.replace(STEM_ENDING_RE, '');
    return stem.length >= MIN_STEM ? stem : trimmed;
}

/**
 * A left-boundary regex key for a Russian term: `/(?:^|[^\p{L}\p{N}_])Маш/iu` matches «Маша», «Машей», «Маши» but
 * not «Ромашка». Null for terms without Cyrillic, with `{{` (macros) or empty.
 */
export function leftBoundaryKey(term: string): string | null {
    const trimmed = term.trim();
    if (!trimmed || !hasCyrillic(trimmed) || trimmed.includes('{{')) return null;
    return `/(?:^|[^\\p{L}\\p{N}_])${escapeForKey(russianStem(trimmed))}/iu`;
}

/** Unique non-empty strings in first-seen order (case-sensitive). */
export function uniqueStrings(values: Iterable<unknown>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const text = value.trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

/**
 * Russian keys for a term from what DES-RU offered: its plain case forms, else its single regex key, else the term
 * itself plus our left-boundary key (Cyrillic terms only).
 */
export function russianKeysFrom(term: string, forms: unknown, formsKey: unknown): string[] {
    const plain = Array.isArray(forms) ? uniqueStrings(forms).filter((form) => !form.includes('{{')) : [];
    if (plain.length) return plain;
    if (typeof formsKey === 'string' && formsKey.trim() && !formsKey.includes('{{')) return [formsKey.trim()];
    const trimmed = term.trim();
    if (!trimmed) return [];
    const regex = leftBoundaryKey(trimmed);
    return regex ? [trimmed, regex] : [trimmed];
}

/* ------------------------------------------------------------------ glossary */

/** One Russian name (with its known forms) that stands for an English one. */
export interface GlossPair {
    ru: string;
    en: string;
    /** Exact case forms (DES-RU); the stem of `ru` is always tried as well. */
    forms?: string[];
}

interface GlossRow {
    en: string;
    /** Normalised needles matched with a left word boundary. */
    needles: string[];
    regexes: RegExp[];
}

export interface Glossary {
    rows: GlossRow[];
}

/** English side of a pair: Latin, no Cyrillic, no regex, no macros. */
function englishName(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || !hasLatin(trimmed) || hasCyrillic(trimmed) || isRegexKey(trimmed) || trimmed.includes('{{')) {
        return null;
    }
    return trimmed;
}

/** Builds the matcher; pairs without a usable English or Russian side are skipped. Deterministic. */
export function buildGlossary(pairs: Iterable<GlossPair>): Glossary {
    const byEnglish = new Map<string, GlossRow>();
    for (const pair of pairs) {
        const en = englishName(pair.en);
        const ru = pair.ru.trim();
        if (!en || !ru || ru.includes('{{')) continue;
        const key = en.toLowerCase();
        let row = byEnglish.get(key);
        if (!row) {
            row = { en, needles: [], regexes: [] };
            byEnglish.set(key, row);
        }
        if (isRegexKey(ru)) {
            if (!hasCyrillic(ru)) continue;
            const regex = parseRegexKey(ru);
            if (regex && !row.regexes.some((item) => item.source === regex.source && item.flags === regex.flags)) {
                row.regexes.push(regex);
            }
            continue;
        }
        if (!hasCyrillic(ru)) continue;
        for (const form of [russianStem(ru), ...(pair.forms ?? [])]) {
            if (typeof form !== 'string' || !hasCyrillic(form)) continue;
            const needle = normalizeForMatch(form.trim());
            if (needle && !row.needles.includes(needle)) row.needles.push(needle);
        }
    }
    const rows = [...byEnglish.values()].filter((row) => row.needles.length || row.regexes.length);
    rows.sort((a, b) =>
        a.en.toLowerCase() < b.en.toLowerCase() ? -1 : a.en.toLowerCase() > b.en.toLowerCase() ? 1 : 0,
    );
    return { rows };
}

/** `needle` occurs in `text` right after a non-word character (or at the start). */
export function containsWithLeftBoundary(text: string, needle: string): boolean {
    if (!needle) return false;
    let from = 0;
    for (;;) {
        const index = text.indexOf(needle, from);
        if (index < 0) return false;
        const before = index > 0 ? text[index - 1] : undefined;
        if (before === undefined || !WORD_CHAR_RE.test(before)) return true;
        from = index + 1;
    }
}

/** English names whose Russian forms occur in `text`, sorted, at most `limit`. */
export function matchGlossary(glossary: Glossary, text: string, limit = 40): string[] {
    if (!text || !glossary.rows.length) return [];
    const normalized = normalizeForMatch(text);
    const found: string[] = [];
    for (const row of glossary.rows) {
        if (found.length >= limit) break;
        const hit =
            row.needles.some((needle) => containsWithLeftBoundary(normalized, needle)) ||
            row.regexes.some((regex) => {
                regex.lastIndex = 0;
                return regex.test(text);
            });
        if (hit) found.push(row.en);
    }
    return found;
}

/** Joins names into the scan text, cut to `maxChars` at a name boundary. */
export function formatGlosses(names: readonly string[], maxChars = 600): string {
    let out = '';
    for (const name of names) {
        const next = out ? `${out}, ${name}` : name;
        if (next.length > maxChars) break;
        out = next;
    }
    return out;
}

/** Pairs from one entry's keys: every Russian key stands for every English key of the same entry. */
export function pairsFromKeys(keys: Iterable<unknown>): GlossPair[] {
    const list = uniqueStrings(keys);
    const english = list.filter((key) => englishName(key) !== null);
    const russian = list.filter((key) => hasCyrillic(key) && !key.includes('{{'));
    const pairs: GlossPair[] = [];
    for (const en of english) for (const ru of russian) pairs.push({ ru, en });
    return pairs;
}

/** DES canonical aliases `{name: [aliases]}`: whichever side is Russian maps to the English ones. */
export function pairsFromAliases(aliases: unknown): GlossPair[] {
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return [];
    const pairs: GlossPair[] = [];
    for (const [canonical, list] of Object.entries(aliases as Record<string, unknown>)) {
        const names = uniqueStrings([canonical, ...(Array.isArray(list) ? list : [])]);
        pairs.push(...pairsFromKeys(names));
    }
    return pairs;
}

/** Localizer marker of one entry: the keys it appended (Russian) stand for the source keys it translated. */
export function pairsFromLocalizer(sources: readonly string[], added: readonly string[]): GlossPair[] {
    const english = uniqueStrings(sources).filter((key) => englishName(key) !== null);
    // An entry with many translated keys gives no reliable pairing; keep the glossary short.
    if (!english.length || english.length > 3) return [];
    const pairs: GlossPair[] = [];
    for (const ru of uniqueStrings(added)) {
        if (!hasCyrillic(ru)) continue;
        for (const en of english) pairs.push({ ru, en });
    }
    return pairs;
}
