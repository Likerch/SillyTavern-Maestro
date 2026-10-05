// The assistant's regex tester (M33, stage 13: «регексы с испытанием»), pure: runs a find/replace on a sample with
// the semantics of SillyTavern's regex extension (public/scripts/extensions/regex/engine.js `runRegexScript`):
// - the find pattern is read by `regexFromString` (`/source/flags` or a bare source WITHOUT flags — no `g`, so only
//   the first match is replaced);
// - ST replaces through a function, so only `{{match}}` (= `$0`), `$1`…`$99` and `$<name>` are expanded; `$&`, `$'`,
//   `` $` `` and `$$` stay literal text; an empty or missing group gives '';
// - trim strings are removed from every inserted group;
// - macros (`{{user}}`, `{{char}}`, …) are filled after the groups (`substituteParams`); the tester fills the ones it
//   is given and reports the rest.
// Long samples are capped by the caller; the result lists the matches with their groups.

export interface RegexRunInput {
    /** `/source/flags` or a bare source (then `flags` applies, default none like ST). */
    pattern: string;
    /** Explicit flags; when given, `pattern` is taken as the bare source. */
    flags?: string;
    /** Replace string (ST script `replaceString`); absent → only the matches are listed. */
    replacement?: string;
    sample: string;
    /** ST script `trimStrings`. */
    trimStrings?: readonly string[];
    /** Macro values by lower-case name (`user`, `char`). */
    macros?: Readonly<Record<string, string>>;
}

export interface RegexMatchInfo {
    index: number;
    text: string;
    /** Numbered groups ($1…), null when the group did not take part. */
    groups: (string | null)[];
    named?: Record<string, string | null>;
}

export type RegexRunNote =
    'noGlobal' | 'unsupportedDollar' | 'unknownMacro' | 'missingGroup' | 'emptyMatch' | 'matchesCapped' | 'sticky';

export interface RegexRunResult {
    ok: boolean;
    error?: string;
    source: string;
    flags: string;
    /** Matches found (all with `g`, else the first). */
    matchCount: number;
    matches: RegexMatchInfo[];
    /** The sample after the replacement (absent without a replacement). */
    result?: string;
    changed: boolean;
    notes: RegexRunNote[];
    /** Macros left for ST to fill (`{{time}}` …), lower case. */
    unknownMacros: string[];
}

export interface RegexRunLimits {
    /** Matches listed (default 20); `matchCount` still counts them all up to `countCap`. */
    maxMatches?: number;
    /** Matches counted at most (default 1000). */
    countCap?: number;
    /** Characters of a listed match / group (default 200). */
    maxMatchChars?: number;
}

/** ST's `regexFromString` (utils.js): `/source/flags` or a bare source; null when it does not compile. */
export function stRegexFromString(input: string): RegExp | null {
    try {
        const match = /(\/?)(.+)\1([a-z]*)/i.exec(input);
        if (!match) return null;
        const flags = match[3] ?? '';
        if (flags && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(flags)) return new RegExp(input);
        return new RegExp(match[2] ?? '', flags);
    } catch {
        return null;
    }
}

/** The RegExp of a run: explicit flags take the pattern as a bare source; otherwise ST's own parsing. */
export function compileRunPattern(pattern: string, flags?: string): { regex: RegExp | null; error?: string } {
    if (flags !== undefined) {
        try {
            const slashed = /^\/([\s\S]+)\/[a-zA-Z]*$/.exec(pattern);
            return { regex: new RegExp(slashed ? (slashed[1] ?? '') : pattern, flags) };
        } catch (error) {
            return { regex: null, error: error instanceof Error ? error.message : String(error) };
        }
    }
    const regex = stRegexFromString(pattern);
    if (regex) return { regex };
    try {
        new RegExp(pattern);
    } catch (error) {
        return { regex: null, error: error instanceof Error ? error.message : String(error) };
    }
    return { regex: null, error: 'invalid pattern' };
}

const MACRO = /\{\{\s*([a-zA-Z_][\w.:-]*)\s*\}\}/g;

/** Fills the known macros (case-insensitive names); returns the text and the names left unfilled. */
export function fillMacros(
    text: string,
    macros: Readonly<Record<string, string>> = {},
): { text: string; unknown: string[] } {
    const unknown = new Set<string>();
    const filled = text.replace(MACRO, (whole, name: string) => {
        const key = name.toLowerCase();
        if (key in macros) return macros[key] ?? '';
        unknown.add(key);
        return whole;
    });
    return { text: filled, unknown: [...unknown] };
}

function trimmed(value: string, trimStrings: readonly string[], macros: Readonly<Record<string, string>>): string {
    let result = value;
    for (const trim of trimStrings) {
        const needle = fillMacros(trim, macros).text;
        if (needle) result = result.split(needle).join('');
    }
    return result;
}

/**
 * ST's replacement: `{{match}}` → `$0`, then `$N` / `$<name>` from the match (trim strings removed, empty → ''),
 * then macros. Everything else in the template is literal (no `$&`).
 */
export function stReplace(
    text: string,
    regex: RegExp,
    replacement: string,
    trimStrings: readonly string[] = [],
    macros: Readonly<Record<string, string>> = {},
): { text: string; missingGroup: boolean; unknownMacros: string[] } {
    let missingGroup = false;
    const unknownMacros = new Set<string>();
    const template = replacement.replace(/{{match}}/gi, '$0');
    regex.lastIndex = 0;
    const result = text.replace(regex, (...args: unknown[]) => {
        const hasNamed = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
        const groups = hasNamed ? (args[args.length - 1] as Record<string, unknown>) : undefined;
        // args: match, groups…, offset, input[, named groups].
        const groupCount = args.length - 3 - (hasNamed ? 1 : 0);
        const withGroups = template.replace(
            /\$(\d+)|\$<([^>]+)>/g,
            (_whole, num: string | undefined, name: string | undefined) => {
                let value: unknown;
                // Like ST: `args[N]` even past the groups (then it is the offset or the whole input).
                if (num) {
                    if (Number(num) > groupCount) missingGroup = true;
                    value = args[Number(num)];
                } else if (name) {
                    value = groups?.[name];
                    if (!groups || !(name in groups)) missingGroup = true;
                }
                if (typeof value !== 'string' || !value) return '';
                return trimmed(value, trimStrings, macros);
            },
        );
        const filled = fillMacros(withGroups, macros);
        for (const name of filled.unknown) unknownMacros.add(name);
        return filled.text;
    });
    return { text: result, missingGroup, unknownMacros: [...unknownMacros] };
}

function cut(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Runs a find (and optional replace) on the sample with ST's semantics. */
export function runRegex(input: RegexRunInput, limits: RegexRunLimits = {}): RegexRunResult {
    const maxMatches = limits.maxMatches ?? 20;
    const countCap = limits.countCap ?? 1000;
    const maxChars = limits.maxMatchChars ?? 200;
    const compiled = compileRunPattern(input.pattern, input.flags);
    const regex = compiled.regex;
    if (!regex) {
        return {
            ok: false,
            error: compiled.error ?? 'invalid pattern',
            source: input.pattern,
            flags: input.flags ?? '',
            matchCount: 0,
            matches: [],
            changed: false,
            notes: [],
            unknownMacros: [],
        };
    }
    const notes = new Set<RegexRunNote>();
    if (!regex.global) notes.add('noGlobal');
    if (regex.sticky) notes.add('sticky');
    const matches: RegexMatchInfo[] = [];
    let matchCount = 0;
    const record = (match: RegExpExecArray) => {
        matchCount += 1;
        if (match[0] === '') notes.add('emptyMatch');
        if (matches.length >= maxMatches) {
            notes.add('matchesCapped');
            return;
        }
        const info: RegexMatchInfo = {
            index: match.index,
            text: cut(match[0], maxChars),
            groups: match.slice(1).map((group) => (group === undefined ? null : cut(group, maxChars))),
        };
        if (match.groups) {
            info.named = Object.fromEntries(
                Object.entries(match.groups).map(([name, value]) => [
                    name,
                    value === undefined ? null : cut(value, maxChars),
                ]),
            );
        }
        matches.push(info);
    };
    const finder = new RegExp(regex.source, regex.flags);
    if (finder.global) {
        for (const match of input.sample.matchAll(finder)) {
            record(match as RegExpExecArray);
            if (matchCount >= countCap) break;
        }
    } else {
        finder.lastIndex = 0;
        const match = finder.exec(input.sample);
        if (match) record(match);
    }
    const result: RegexRunResult = {
        ok: true,
        source: regex.source,
        flags: regex.flags,
        matchCount,
        matches,
        changed: false,
        notes: [],
        unknownMacros: [],
    };
    if (input.replacement !== undefined) {
        if (/\$[&'`$]/.test(input.replacement)) notes.add('unsupportedDollar');
        // ST returns the text untouched when it is empty.
        const replaced = input.sample
            ? stReplace(input.sample, regex, input.replacement, input.trimStrings ?? [], input.macros ?? {})
            : { text: input.sample, missingGroup: false, unknownMacros: [] };
        if (replaced.missingGroup) notes.add('missingGroup');
        if (replaced.unknownMacros.length) notes.add('unknownMacro');
        result.result = replaced.text;
        result.changed = replaced.text !== input.sample;
        result.unknownMacros = replaced.unknownMacros;
    }
    result.notes = [...notes];
    return result;
}

/** Short texts of the run notes, for the model and the chip. */
export const RUN_NOTE_TEXT: Record<'en' | 'ru', Record<RegexRunNote, string>> = {
    en: {
        noGlobal: 'No g flag: ST replaces only the first match.',
        unsupportedDollar: "ST does not expand $&, $', $` or $$ — they stay literal; use {{match}} or $0.",
        unknownMacro: 'Some macros are filled by ST only at run time.',
        missingGroup:
            'The replacement names a group the pattern does not have: ST inserts nothing there, or (for $N right past the groups) the match position or even the whole text.',
        emptyMatch: 'The pattern can match the empty string.',
        matchesCapped: 'Only the first matches are listed.',
        sticky: 'The y flag matches only at the current position.',
    },
    ru: {
        noGlobal: 'Нет флага g: ST заменит только первое совпадение.',
        unsupportedDollar: "ST не раскрывает $&, $', $` и $$ — они останутся как есть; используй {{match}} или $0.",
        unknownMacro: 'Часть макросов ST подставит только при работе.',
        missingGroup:
            'В замене есть группа, которой нет в шаблоне: ST вставит пустоту, а для $N сразу за последней группой — позицию совпадения или даже весь текст.',
        emptyMatch: 'Шаблон может совпасть с пустой строкой.',
        matchesCapped: 'Показаны только первые совпадения.',
        sticky: 'Флаг y ищет только с текущей позиции.',
    },
};
