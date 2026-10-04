// World Info key matching, re-implemented from SillyTavern 1.19 (public/scripts/world-info.js): ST never records
// which key activated an entry (research/st-world-info.md §2), so M1 repeats the match itself — lazily, when the
// journal is opened (P15), and cheaply during finalisation to tell which entry pulled another one through
// recursion. Keep the behaviour identical to ST's `WorldInfoBuffer.matchKeys` / `parseRegexFromString` and the
// primary/secondary logic of `checkWorldInfo`.

/** World Info secondary-key logic (`world_info_logic`, WI:33). */
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const;

/** The separator ST puts before every scanned message (WI:290-292). */
const MATCHER = '\x01';
const JOINER = `\n${MATCHER}`;

/** Global WI matching settings (`world_info_case_sensitive`, `world_info_match_whole_words`). */
export interface GlobalMatchSettings {
    caseSensitive: boolean;
    matchWholeWords: boolean;
}

export interface KeyMatchOptions extends GlobalMatchSettings {
    /** ST's own `parseRegexFromString` when available (parity); the port below otherwise. */
    parseRegex?: (key: string) => RegExp | null;
}

/** The entry fields matching reads. Everything is optional and may hold junk. */
export interface KeyedEntry {
    key?: unknown;
    keysecondary?: unknown;
    selective?: unknown;
    selectiveLogic?: unknown;
    caseSensitive?: unknown;
    matchWholeWords?: unknown;
}

/** Port of ST's `parseRegexFromString` (WI:2901): `/pattern/flags` → RegExp, anything else → null. */
export function parseRegexKey(input: string): RegExp | null {
    const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(input);
    if (!match) return null;
    let pattern = match[1] ?? '';
    const flags = match[2] ?? '';
    // An unescaped slash inside the pattern makes it invalid for ST.
    if (/(^|[^\\])\//.test(pattern)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

export function escapeRegex(text: string): string {
    return text.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** Port of `WorldInfoBuffer.matchKeys` (WI:337-366). */
export function matchKey(haystack: string, needle: string, options: KeyMatchOptions): boolean {
    const regex = (options.parseRegex ?? parseRegexKey)(needle);
    if (regex) {
        // A fresh RegExp per call, like ST: `g`/`y` flags must not carry lastIndex between tests.
        return regex.test(haystack);
    }
    const text = options.caseSensitive ? haystack : haystack.toLowerCase();
    const key = options.caseSensitive ? needle : needle.toLowerCase();
    if (!options.matchWholeWords) return text.includes(key);
    if (key.split(/\s+/).length > 1) return text.includes(key);
    // ST's custom boundaries; `\W` is ASCII-only, so Cyrillic keys behave like substrings (research §10).
    return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(text);
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Per-entry options with ST's fallback to the global settings (`entry.caseSensitive ?? global`). */
export function entryMatchOptions(
    entry: KeyedEntry,
    globals: GlobalMatchSettings,
    parseRegex?: (key: string) => RegExp | null,
): KeyMatchOptions {
    const caseSensitive = typeof entry.caseSensitive === 'boolean' ? entry.caseSensitive : globals.caseSensitive;
    const matchWholeWords =
        typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : globals.matchWholeWords;
    return parseRegex ? { caseSensitive, matchWholeWords, parseRegex } : { caseSensitive, matchWholeWords };
}

/** Macro substitution of keys (ST runs `substituteParams` on every key before matching). */
export type Substitute = (text: string) => string;

const identity: Substitute = (text) => text;

function matchesAny(text: string, keys: string[], options: KeyMatchOptions, substitute: Substitute): string | null {
    for (const key of keys) {
        const substituted = substitute(key);
        if (substituted && matchKey(text, substituted.trim(), options)) return key;
    }
    return null;
}

/**
 * Which key activated the entry on `text`, as a short label: the primary key, plus the secondary keys that the
 * entry's logic needed (`Аня + лес`). Null when no primary key matches. When the secondary condition fails on
 * this text the primary key is still returned: the entry did activate, and the scan text is a reconstruction.
 */
export function findTriggerKey(
    entry: KeyedEntry,
    text: string,
    globals: GlobalMatchSettings,
    substitute: Substitute = identity,
    parseRegex?: (key: string) => RegExp | null,
): string | null {
    const options = entryMatchOptions(entry, globals, parseRegex);
    const primary = matchesAny(text, stringList(entry.key), options, substitute);
    if (primary === null) return null;
    const secondary = stringList(entry.keysecondary);
    // ST: `entry.selective && keysecondary.length` (every 1.19 entry is selective; old ones may lack the flag).
    if (!entry.selective || secondary.length === 0) return primary;
    const logic = typeof entry.selectiveLogic === 'number' ? entry.selectiveLogic : WI_LOGIC.AND_ANY;
    const matched: string[] = [];
    const missed: string[] = [];
    for (const key of secondary) {
        const substituted = substitute(key);
        if (substituted && matchKey(text, substituted.trim(), options)) matched.push(key);
        else missed.push(key);
    }
    if (logic === WI_LOGIC.AND_ANY && matched.length) return `${primary} + ${matched[0]}`;
    if (logic === WI_LOGIC.AND_ALL && !missed.length) return [primary, ...matched].join(' + ');
    if (logic === WI_LOGIC.NOT_ALL && missed.length) return `${primary} + ¬${missed[0]}`;
    if (logic === WI_LOGIC.NOT_ANY && !matched.length) return `${primary} + ¬(${secondary.join(', ')})`;
    return primary;
}

/** Scan sources of an entry beyond the chat (`match*` flags, WI:300-317). */
export interface GlobalScanText {
    personaDescription?: string;
    characterDescription?: string;
    characterPersonality?: string;
    characterDepthPrompt?: string;
    scenario?: string;
    creatorNotes?: string;
}

export interface ScanFlags {
    matchPersonaDescription?: unknown;
    matchCharacterDescription?: unknown;
    matchCharacterPersonality?: unknown;
    matchCharacterDepthPrompt?: unknown;
    matchScenario?: unknown;
    matchCreatorNotes?: unknown;
}

export interface ScanTextInput {
    /** Chat messages, newest first (ST's `chatForWI`). */
    messages: string[];
    /** Messages to scan (entry.scanDepth ?? world_info_depth). */
    depth: number;
    global?: GlobalScanText;
    flags?: ScanFlags;
    /** Extension prompts with `scan: true`. */
    injects?: string[];
    /** Recursion buffer: contents added by earlier scan loops. */
    recursion?: string[];
}

/** Rebuilds `WorldInfoBuffer.get()` (WI:279-328) for one entry. */
export function buildScanText(input: ScanTextInput): string {
    const depth = Math.max(0, Math.floor(input.depth));
    if (depth <= 0) return '';
    const messages = input.messages.slice(0, depth).map((message) => message.trim());
    let result = MATCHER + messages.join(JOINER);
    const global = input.global ?? {};
    const flags = input.flags ?? {};
    const pairs: [unknown, string | undefined][] = [
        [flags.matchPersonaDescription, global.personaDescription],
        [flags.matchCharacterDescription, global.characterDescription],
        [flags.matchCharacterPersonality, global.characterPersonality],
        [flags.matchCharacterDepthPrompt, global.characterDepthPrompt],
        [flags.matchScenario, global.scenario],
        [flags.matchCreatorNotes, global.creatorNotes],
    ];
    for (const [flag, value] of pairs) {
        if (flag === true && value) result += JOINER + value;
    }
    if (input.injects?.length) result += JOINER + input.injects.join(JOINER);
    if (input.recursion?.length) result += JOINER + input.recursion.join(JOINER);
    return result;
}

/** An entry that may have pulled another one in through recursion. */
export interface ViaCandidate {
    world: string;
    uid: number;
    content: string;
}

/**
 * The first candidate whose content contains one of the entry's primary keys (candidates in priority order:
 * the caller lists the most recent scan loop first). Cheap: plain substring/regex tests, no secondary logic.
 */
export function findVia(
    entry: KeyedEntry,
    candidates: readonly ViaCandidate[],
    globals: GlobalMatchSettings,
    substitute: Substitute = identity,
    parseRegex?: (key: string) => RegExp | null,
): { world: string; uid: number } | undefined {
    const keys = stringList(entry.key);
    if (!keys.length) return undefined;
    const options = entryMatchOptions(entry, globals, parseRegex);
    for (const candidate of candidates) {
        if (!candidate.content) continue;
        if (matchesAny(candidate.content, keys, options, substitute) !== null) {
            return { world: candidate.world, uid: candidate.uid };
        }
    }
    return undefined;
}
