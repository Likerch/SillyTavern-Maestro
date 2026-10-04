// Conditional preset blocks (M34 п.8), pure checks: what can go wrong with a block's `{{if .flag}}` (malformed tags,
// whitespace outside the tags → a whitespace-only message ST still sends, flags Maestro does not own, the unsafe
// bare-word and global forms, the old macro engine that sends everything literally — research/parity-preset.md
// P-133…P-138, P-146, §10.2 hard place 6), which flag combinations leave a whitespace-only message, and the flag
// catalogue (the director's flags, read defensively, merged with fallbacks and the flags the preset uses).
import { emptyMessageIssue } from './preset-analysis-text';
import {
    blockCondition,
    conditionHolds,
    evaluate,
    flagUses,
    isFlagName,
    isMaestroFlag,
    parseConditional,
    trimScoped,
    wrap,
    wrapBlockers,
} from './preset-conditional-syntax';
import type { IfSection, SyntaxIssueCode } from './preset-conditional-syntax';

/* ------------------------------------------------------------------ catalogue */

export type FlagSource = 'director' | 'builtin' | 'preset' | 'custom';

/** A flag the studio offers (the director's catalogue: `{ name, titleKey, descriptionKey }`). */
export interface FlagEntry {
    name: string;
    titleKey?: string;
    descriptionKey?: string;
    source: FlagSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flag entries from an unknown value: an array of `{name, titleKey?, descriptionKey?}` or of names, or a record of
 * flag → value (the director's current flags). Invalid names are dropped.
 */
export function readFlagEntries(value: unknown, source: FlagSource): FlagEntry[] {
    const result: FlagEntry[] = [];
    const push = (name: unknown, titleKey?: unknown, descriptionKey?: unknown) => {
        if (typeof name !== 'string' || !isFlagName(name)) return;
        const entry: FlagEntry = { name, source };
        if (typeof titleKey === 'string' && titleKey) entry.titleKey = titleKey;
        if (typeof descriptionKey === 'string' && descriptionKey) entry.descriptionKey = descriptionKey;
        result.push(entry);
    };
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === 'string') push(item);
            else if (isRecord(item)) push(item.name, item.titleKey, item.descriptionKey);
        }
    } else if (isRecord(value)) {
        for (const name of Object.keys(value)) push(name);
    }
    return result;
}

/** One entry per name, the first list that has a name wins (director before fallbacks before the preset's own). */
export function mergeCatalogue(...lists: readonly (readonly FlagEntry[])[]): FlagEntry[] {
    const seen = new Map<string, FlagEntry>();
    for (const list of lists) for (const entry of list) if (!seen.has(entry.name)) seen.set(entry.name, entry);
    return [...seen.values()];
}

/** A free name typed by the user: `maestro_` is added when missing; null when `.name` cannot take it. */
export function customFlagName(input: string): string | null {
    const name = input.trim();
    if (!name) return null;
    const full = name.startsWith('maestro_') ? name : `maestro_${name}`;
    return isMaestroFlag(full) ? full : null;
}

/* ------------------------------------------------------------------ combinations */

/** Flags beyond this count are not enumerated exhaustively (2^8 = 256 evaluations at most). */
export const EXHAUSTIVE_FLAGS = 8;

/**
 * The «on» sets to try for these flags: every combination up to EXHAUSTIVE_FLAGS flags, beyond that none, all,
 * each one alone and all but one.
 */
export function flagCombinations(names: readonly string[], limit = EXHAUSTIVE_FLAGS): string[][] {
    const unique = [...new Set(names)];
    if (unique.length <= limit) {
        const result: string[][] = [];
        for (let mask = 0; mask < 1 << unique.length; mask++) {
            result.push(unique.filter((_, index) => (mask & (1 << index)) !== 0));
        }
        return result;
    }
    const result: string[][] = [[], [...unique]];
    for (const name of unique) result.push([name]);
    for (const name of unique) result.push(unique.filter((other) => other !== name));
    return result;
}

/** The first flag combination that leaves a whitespace-only message (ST sends it, P-117), or null. */
export function whitespaceCombination(text: string, limit = EXHAUSTIVE_FLAGS): string[] | null {
    const names = flagUses(text).map((use) => use.name);
    if (!names.length) return null;
    for (const on of flagCombinations(names, limit)) {
        if (emptyMessageIssue(evaluate(text, on)) === 'whitespace') return on;
    }
    return null;
}

/** True when every flag combination gives an empty message (ST drops it): the block never sends anything. */
export function neverSends(text: string, limit = EXHAUSTIVE_FLAGS): boolean {
    const names = flagUses(text).map((use) => use.name);
    if (!names.length) return false;
    return flagCombinations(names, limit).every((on) => evaluate(text, on) === '');
}

/* ------------------------------------------------------------------ validation */

export type ConditionalIssueCode =
    | SyntaxIssueCode
    /** Whitespace outside the tags: with the condition false the block sends a whitespace-only message. */
    | 'outsideWhitespace'
    /** Some flag combination leaves only whitespace (sent as is). */
    | 'whitespaceResult'
    /** Nothing is sent whatever the flags. */
    | 'neverSends'
    /** `.name` that is neither in the catalogue nor a `maestro_` flag: Maestro never sets or clears it. */
    | 'unknownFlag'
    /** A `maestro_` flag no module of Maestro sets (a free name). */
    | 'customFlag'
    /** `{{if maestro_x}}` without the dot: a bare word is non-empty text, so it is TRUE without Maestro (P-137). */
    | 'bareFlag'
    /** `{{if $maestro_x}}`: a global variable, shared by every chat. */
    | 'globalFlag'
    /** The old macro engine: `{{if}}` and every branch go to the model literally (P-133). */
    | 'macroEngineOff';

export interface ConditionalIssue {
    code: ConditionalIssueCode;
    severity: 'warn' | 'info';
    /** The flag it is about. */
    flag?: string;
    /** whitespaceResult: the flags that were on. */
    flags?: string[];
}

export interface ValidateOptions {
    /** Flag names of the catalogue (the director's and the fallbacks). */
    known?: Iterable<string>;
    /** `power_user.experimental_macro_engine`: false reports macroEngineOff; true/undefined do not. */
    macroEngine?: boolean | null;
    /** Exhaustive enumeration limit for whitespaceResult / neverSends. */
    limit?: number;
}

const SYNTAX_SEVERITY: Record<SyntaxIssueCode, 'warn' | 'info'> = {
    unclosed: 'warn',
    strayClose: 'warn',
    strayElse: 'warn',
    extraElse: 'warn',
    emptyCondition: 'warn',
};

function sectionsDeep(sections: readonly IfSection[]): IfSection[] {
    return sections.flatMap((section) => [
        section,
        ...sectionsDeep(section.nested.then),
        ...sectionsDeep(section.nested.else),
    ]);
}

/** Everything wrong with a block's conditionals (empty list for a text without `{{if}}`). */
export function validateConditional(text: string, options: ValidateOptions = {}): ConditionalIssue[] {
    const parse = parseConditional(text);
    if (!parse.tagged) return [];
    const known = new Set(options.known ?? []);
    const issues: ConditionalIssue[] = [];
    const add = (issue: ConditionalIssue) => {
        const same = issues.some(
            (other) => other.code === issue.code && other.flag === issue.flag && other.flags === issue.flags,
        );
        if (!same) issues.push(issue);
    };
    if (options.macroEngine === false) add({ code: 'macroEngineOff', severity: 'warn' });
    for (const issue of parse.issues) add({ code: issue.code, severity: SYNTAX_SEVERITY[issue.code] });
    const outsideWhitespace = parse.sections.length > 0 && parse.outside !== '' && parse.outside.trim() === '';
    if (outsideWhitespace) add({ code: 'outsideWhitespace', severity: 'warn' });
    for (const section of sectionsDeep(parse.sections)) {
        const { condition } = section;
        const ours = isMaestroFlag(condition.name) || known.has(condition.name);
        if (condition.kind === 'local') {
            if (!known.has(condition.name)) {
                if (isMaestroFlag(condition.name)) add({ code: 'customFlag', severity: 'info', flag: condition.name });
                else add({ code: 'unknownFlag', severity: 'warn', flag: condition.name });
            }
        } else if (condition.kind === 'name' && ours) {
            add({ code: 'bareFlag', severity: 'warn', flag: condition.name });
        } else if (condition.kind === 'global' && ours) {
            add({ code: 'globalFlag', severity: 'warn', flag: condition.name });
        }
    }
    if (!parse.issues.some((issue) => issue.code === 'unclosed') && parse.sections.length) {
        if (!outsideWhitespace) {
            const on = whitespaceCombination(text, options.limit);
            if (on) add({ code: 'whitespaceResult', severity: 'warn', flags: on });
        }
        if (neverSends(text, options.limit)) add({ code: 'neverSends', severity: 'info' });
    }
    return issues;
}

/* ------------------------------------------------------------------ preset blocks */

export interface ConditionalBlockInfo {
    identifier: string;
    /** Flags its conditionals read (`.name` form), in order. */
    flags: string[];
    /** The whole text is one conditional on a `.flag`. */
    whole: boolean;
    /** It reads at least one Maestro flag (a `maestro_` name or a catalogue flag, any form, closed or not). */
    maestro: boolean;
    /** Nothing but well-formed Maestro conditionals (whitespace aside): without Maestro it sends nothing useful. */
    onlyMaestro: boolean;
}

/** Names in every `{{if …}}` tag, paired or not (`.name`, `$name` or a bare word). */
const IF_TAG_NAME_RE = /\{\{[\s!?~#]*if\s+!?\s*[.$]?([a-zA-Z][\w-]*)/gi;

/** Conditional facts of one block text (null when it has no `{{if}}`). */
export function conditionalInfo(
    identifier: string,
    text: string,
    known: Iterable<string> = [],
): ConditionalBlockInfo | null {
    const parse = parseConditional(text);
    if (!parse.tagged) return null;
    const catalogue = new Set(known);
    const sections = sectionsDeep(parse.sections);
    const flags = flagUses(text).map((use) => use.name);
    const whole =
        parse.sections.length === 1 &&
        parse.outside === '' &&
        !parse.issues.length &&
        parse.sections[0]!.condition.kind === 'local';
    const mentioned = [...text.matchAll(IF_TAG_NAME_RE)].some(
        (match) => isMaestroFlag(match[1]!) || catalogue.has(match[1]!),
    );
    const maestro = mentioned || sections.some((section) => isMaestroCondition(section, catalogue));
    const onlyMaestro =
        !parse.issues.length &&
        parse.sections.length > 0 &&
        parse.outside.trim() === '' &&
        parse.sections.every((section) => isMaestroCondition(section, catalogue));
    return { identifier, flags, whole, maestro, onlyMaestro };
}

/** A condition on a Maestro flag (a `maestro_` name or a catalogue flag, in any of the three forms). */
function isMaestroCondition(section: IfSection, catalogue: ReadonlySet<string>): boolean {
    const { condition } = section;
    return (
        (condition.kind === 'local' || condition.kind === 'name' || condition.kind === 'global') &&
        (isMaestroFlag(condition.name) || catalogue.has(condition.name))
    );
}

function stripMaestro(text: string, mode: 'then' | 'absent', catalogue: ReadonlySet<string>): string {
    const parse = parseConditional(text);
    let result = '';
    let cursor = 0;
    for (const section of parse.sections) {
        let replacement: string;
        if (isMaestroCondition(section, catalogue)) {
            // Without Maestro a `.flag` is unset; a bare word stays true (P-137); a global is unknown here (unset).
            const branch =
                mode === 'then' || conditionHolds(section.condition, []) ? section.thenText : (section.elseText ?? '');
            const inner = stripMaestro(branch, mode, catalogue);
            replacement = section.preserve ? inner : trimScoped(inner);
        } else {
            // Not ours: the tags stay, Maestro conditionals inside its branches go.
            const open = text.slice(section.start, section.contentStart);
            const close = text.slice(section.contentEnd, section.end);
            const thenText = stripMaestro(section.thenText, mode, catalogue);
            const elseText =
                section.elseText === null ? '' : `{{else}}${stripMaestro(section.elseText, mode, catalogue)}`;
            replacement = `${open}${thenText}${elseText}${close}`;
        }
        result += text.slice(cursor, section.start) + replacement;
        cursor = section.end;
    }
    return result + text.slice(cursor);
}

/**
 * The block text without its Maestro conditionals, for «Подготовить к отключению»: 'then' keeps the text between
 * `{{if}}` and `{{else}}` of each Maestro conditional; 'absent' keeps what ST sends without Maestro (no flag set).
 * Other conditionals (the user's own variables, card fields) stay, with Maestro's removed inside them.
 */
export function withoutMaestroConditionals(
    text: string,
    mode: 'then' | 'absent',
    known: Iterable<string> = [],
): string {
    return stripMaestro(text, mode, new Set(known));
}

/* ------------------------------------------------------------------ the editor's «Условие» */

export type ConditionChoice =
    /** No condition of the block itself (a whole-block conditional loses its tags and its else text). */
    | { mode: 'always' }
    /** `{{if .flag}}` ('when') or `{{if !.flag}}` ('unless'), with an optional else text. */
    | { mode: 'when' | 'unless'; flag: string; elseText?: string | null };

export type ConditionResult =
    | { ok: true; text: string }
    /** The text has stray or unclosed tags that would pair with the new ones; or the flag name is not valid. */
    | { ok: false; reason: 'blocked'; codes: SyntaxIssueCode[] }
    | { ok: false; reason: 'flag' };

/**
 * The block text with this condition: a block that already is one conditional on a `.flag` is re-wrapped around its
 * body (never nested), any other text is wrapped whole. The result has nothing outside the tags.
 */
export function applyCondition(content: string, choice: ConditionChoice): ConditionResult {
    const current = blockCondition(content);
    const body = current ? current.body : content;
    if (choice.mode === 'always') return { ok: true, text: current ? body : content };
    if (!isFlagName(choice.flag)) return { ok: false, reason: 'flag' };
    const codes = wrapBlockers(body);
    if (codes.length) return { ok: false, reason: 'blocked', codes };
    return { ok: true, text: wrap(body, choice.flag, { negate: choice.mode === 'unless', elseText: choice.elseText }) };
}
