// Keys of a World Info entry in the Lore Studio form (M23): the exact port of ST 1.19's text-mode key parsing
// (`splitKeywordsAndRegexes` + `customTokenizer`, world-info.js:2797-2878), key diagnostics (regex keys ST cannot
// parse, Cyrillic under «whole words», macro braces — audit T2) and the key tester (primary/secondary logic of
// `checkWorldInfo`, world-info.js:4875-4985). research/parity-lore.md L-063…L-066, L-070, L-084, L-085, L-103.
import { WI_LOGIC, entryMatchOptions, matchKey, parseRegexKey } from './lore-match';
import type { GlobalMatchSettings, Substitute } from './lore-match';

/** True when ST would treat the key as a regular expression (`/pattern/flags` that `parseRegexFromString` accepts). */
export function isRegexKey(key: string): boolean {
    return parseRegexKey(key) !== null;
}

/**
 * Port of ST's `customTokenizer` in text mode: a comma separates keys unless it sits inside a regex whose closing
 * slash has not been seen yet; a finished token that starts with `/` but is not a valid regex is cut at every comma.
 * ST quirk kept on purpose: after a separator the loop restarts at index 1 of the rest, so a slash right after a
 * comma (`a,/b,c/`) does not open a regex — `a, /b,c/` (with the space ST itself writes) does.
 */
function tokenize(input: string, add: (token: string) => void): string {
    let current = input;
    let insideRegex = false;
    let regexClosed = false;
    for (let i = 0; i < current.length; i++) {
        const char = current[i];
        if (char === '/' && (i === 0 || current[i - 1] !== '\\')) {
            if (!insideRegex) insideRegex = true;
            else if (!regexClosed) regexClosed = true;
        }
        if (char !== ',') continue;
        if (insideRegex && !regexClosed) continue;
        const token = current.slice(0, i).trim();
        if (token) {
            if (token.startsWith('/') && !isRegexKey(token)) {
                for (const part of token.split(',').map((item) => item.trim())) add(part);
            } else {
                add(token);
            }
        }
        current = current.slice(i + 1);
        insideRegex = false;
        regexClosed = false;
        i = 0;
    }
    return current;
}

/** Exact port of ST's `splitKeywordsAndRegexes` (may return empty strings for `/a,,b` like ST does). */
export function splitKeywordsAndRegexes(input: string): string[] {
    const keys: string[] = [];
    const rest = tokenize(input, (token) => keys.push(token)).trim();
    if (rest) keys.push(rest);
    return keys;
}

/** Keys from the text field of the form: ST's split without the empty keys it can leave behind. */
export function parseKeyInput(input: string): string[] {
    return splitKeywordsAndRegexes(input).filter((key) => key.length > 0);
}

/** Keys as ST shows them in its text field (`join(', ')`); round-trips through parseKeyInput. */
export function formatKeys(keys: readonly string[]): string {
    return keys.join(', ');
}

export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;
/** Shaped like `/…/flags` (what users mean as a regex), whether or not ST can parse it. */
const REGEX_SHAPED = /^\/.+\/[A-Za-z]*$/s;

export type KeyKind = 'plain' | 'regex' | 'badRegex';

export type KeyIssue =
    /** Looks like `/…/flags` but ST cannot parse it: it is matched as plain text. */
    | 'badRegex'
    /** A plain key with a comma inside (an unpaired slash kept the comma): ST keeps it as one key. */
    | 'comma'
    /** `\{` in a regex key: ST's macro engine turns it into `{` before matching (T2). Use `[{]`. */
    | 'macroBrace'
    /** `{{…}}` in a key: ST substitutes macros in keys before matching. */
    | 'macro'
    /** One Cyrillic word with «whole words» on: JS `\W` does not know Cyrillic, so it matches inside words too. */
    | 'cyrillicWholeWord'
    /** The same key twice. */
    | 'duplicate';

export interface KeyInfo {
    key: string;
    kind: KeyKind;
    cyrillic: boolean;
    issues: KeyIssue[];
}

export interface KeyAnalysisOptions {
    /** Effective «whole words» of the entry (entry value ?? global). */
    matchWholeWords: boolean;
    /** Effective case sensitivity (duplicates are case-insensitive otherwise). */
    caseSensitive: boolean;
}

export function keyKind(key: string): KeyKind {
    if (isRegexKey(key)) return 'regex';
    return REGEX_SHAPED.test(key) ? 'badRegex' : 'plain';
}

/** Per-key diagnostics for the chips under a key field. */
export function analyzeKeys(keys: readonly string[], options: KeyAnalysisOptions): KeyInfo[] {
    const seen = new Set<string>();
    return keys.map((key) => {
        const kind = keyKind(key);
        const cyrillic = CYRILLIC.test(key);
        const issues: KeyIssue[] = [];
        if (kind === 'badRegex') issues.push('badRegex');
        if (kind !== 'regex' && key.includes(',')) issues.push('comma');
        if (kind === 'regex' && key.includes('\\{')) issues.push('macroBrace');
        if (key.includes('{{')) issues.push('macro');
        if (kind !== 'regex' && cyrillic && options.matchWholeWords && key.trim().split(/\s+/).length === 1) {
            issues.push('cyrillicWholeWord');
        }
        const norm = options.caseSensitive ? key : key.toLowerCase();
        if (seen.has(norm)) issues.push('duplicate');
        seen.add(norm);
        return { key, kind, cyrillic, issues };
    });
}

/** Plain English terms among the keys (no regex, Latin letters, no Cyrillic): candidates for Russian forms. */
export function englishTerms(keys: readonly string[]): string[] {
    return keys.filter((key) => keyKind(key) === 'plain' && LATIN.test(key) && !CYRILLIC.test(key));
}

/** New array: `existing` plus the additions it lacks (case-insensitive unless `caseSensitive`), order kept. */
export function mergeKeys(existing: readonly string[], additions: readonly string[], caseSensitive = false): string[] {
    const norm = (key: string) => (caseSensitive ? key.trim() : key.trim().toLowerCase());
    const seen = new Set(existing.map(norm));
    const result = [...existing];
    for (const key of additions) {
        const trimmed = key.trim();
        if (!trimmed || seen.has(norm(trimmed))) continue;
        seen.add(norm(trimmed));
        result.push(trimmed);
    }
    return result;
}

/* ------------------------------------------------------------------ decorators (WI:4652-4698, L-103) */

export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const;

export interface DecoratorInfo {
    /** Known decorators ST reads (`@@@x` after an unknown one counts as `@@x`). */
    known: string[];
    /** Unknown `@@…` lines: ST cuts them from the prompt without a word. */
    unknown: string[];
    /** Content as it reaches the prompt (ST cuts nothing when the content is only `@@` lines). */
    content: string;
}

function isKnownDecorator(line: string): boolean {
    const data = line.startsWith('@@@') ? line.substring(1) : line;
    return KNOWN_DECORATORS.some((known) => data.startsWith(known));
}

/** Port of ST's `parseDecorators`, plus the unknown lines it drops. */
export function analyzeDecorators(content: string): DecoratorInfo {
    if (!content.startsWith('@@')) return { known: [], unknown: [], content };
    const lines = content.split('\n');
    const known: string[] = [];
    const unknown: string[] = [];
    let fallbacked = false;
    let rest = content;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!line.startsWith('@@')) {
            rest = lines.slice(i).join('\n');
            break;
        }
        if (line.startsWith('@@@') && !fallbacked) continue;
        if (isKnownDecorator(line)) {
            known.push(line.startsWith('@@@') ? line.substring(1) : line);
            fallbacked = false;
        } else {
            unknown.push(line);
            fallbacked = true;
        }
    }
    return { known, unknown, content: rest };
}

/* ------------------------------------------------------------------ tester */

export interface KeyHit {
    key: string;
    kind: KeyKind;
    matched: boolean;
}

export type TestOutcome =
    | 'disabled'
    | 'dontActivate'
    | 'activateDecorator'
    | 'constant'
    | 'noKeys'
    | 'noPrimary'
    | 'secondaryFailed'
    | 'activated';

export interface EntryTestResult {
    primary: KeyHit[];
    secondary: KeyHit[];
    /** ST checks the secondary keys only for `selective` entries with at least one secondary key. */
    secondaryUsed: boolean;
    logic: number;
    primaryMatched: boolean;
    secondaryPassed: boolean;
    outcome: TestOutcome;
    /** The entry would activate on this text (ignoring probability, timers, filters and the budget). */
    activates: boolean;
}

export interface TestableEntry {
    key?: unknown;
    keysecondary?: unknown;
    selective?: unknown;
    selectiveLogic?: unknown;
    caseSensitive?: unknown;
    matchWholeWords?: unknown;
    constant?: unknown;
    disable?: unknown;
    content?: unknown;
}

function secondaryPasses(logic: number, hits: KeyHit[]): boolean {
    const any = hits.some((hit) => hit.matched);
    const all = hits.every((hit) => hit.matched);
    if (logic === WI_LOGIC.AND_ANY) return any;
    if (logic === WI_LOGIC.NOT_ALL) return !all;
    if (logic === WI_LOGIC.NOT_ANY) return !any;
    if (logic === WI_LOGIC.AND_ALL) return all;
    return false;
}

/**
 * Which keys of the entry match `text`, and whether ST's key logic would activate it. Order of checks as in
 * `checkWorldInfo`: disabled → @@activate → @@dont_activate → constant → keys (probability, timers, filters,
 * groups and the budget are out of scope of the tester).
 */
export function testEntry(
    entry: TestableEntry,
    text: string,
    globals: GlobalMatchSettings,
    substitute: Substitute = (value) => value,
): EntryTestResult {
    const options = entryMatchOptions(entry, globals);
    const hit = (key: string): KeyHit => {
        const substituted = substitute(key);
        return { key, kind: keyKind(key), matched: !!substituted && matchKey(text, substituted.trim(), options) };
    };
    const primary = stringList(entry.key).map(hit);
    const secondaryKeys = stringList(entry.keysecondary);
    const secondary = secondaryKeys.map(hit);
    const logic = typeof entry.selectiveLogic === 'number' ? entry.selectiveLogic : WI_LOGIC.AND_ANY;
    const secondaryUsed = !!entry.selective && secondaryKeys.length > 0;
    const primaryMatched = primary.some((item) => item.matched);
    const secondaryPassed = !secondaryUsed || secondaryPasses(logic, secondary);
    const decorators = analyzeDecorators(typeof entry.content === 'string' ? entry.content : '').known;
    let outcome: TestOutcome;
    if (entry.disable === true) outcome = 'disabled';
    else if (decorators.includes('@@activate')) outcome = 'activateDecorator';
    else if (decorators.includes('@@dont_activate')) outcome = 'dontActivate';
    else if (entry.constant === true) outcome = 'constant';
    else if (!primary.length) outcome = 'noKeys';
    else if (!primaryMatched) outcome = 'noPrimary';
    else if (!secondaryPassed) outcome = 'secondaryFailed';
    else outcome = 'activated';
    const activates = outcome === 'activateDecorator' || outcome === 'constant' || outcome === 'activated';
    return { primary, secondary, secondaryUsed, logic, primaryMatched, secondaryPassed, outcome, activates };
}
