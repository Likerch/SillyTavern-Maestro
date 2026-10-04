// Conditional preset blocks (M34 п.8), pure syntax: the `{{if .maestro_<flag>}}…{{else}}…{{/if}}` structure of a block,
// as SillyTavern 1.19's new macro engine reads it (research/parity-preset.md §6, §10.4 д), checked against its source:
// - lexer (macros/engine/MacroLexer.js): `{{`, optional flags `!?~#/` and whitespace, an identifier
//   `[a-zA-Z][\w-]*`, then whitespace / `:` / `}}`; after whitespace (or one `:`) the rest is ONE argument, colons
//   included; `::` right after the name makes a `::`-separated list (MacroParser.js `arguments`);
// - pairing (MacroCstWalker.js #processScopedMacros, #findMatchingClosingMacro): an opener finds the next closing tag
//   of the same name (case-insensitive) counting nested openers that take scoped content; `{{if}}` takes it only with
//   exactly one argument (`if` has 2 required args, MacroRegistry minArgs = maxArgs = 2); an opener without a
//   closing tag fails the arity check and stays in the text literally, an unmatched `{{/if}}` too;
// - `{{if}}` (definitions/core-macros.js:134-213): `!` inverts; `.name` → local variable (`{{getvar::name}}`,
//   chat_metadata.variables), `$name` → global; falsy = '' or 'off' / 'false' / '0' (utils.js:1019 isFalseBoolean,
//   trimmed, any case); the content splits on the first `{{else}}` at nesting depth 0 (splitOnTopLevelElse); only
//   the chosen branch is evaluated, then trimmed with dedent (MacroEngine.js:372 trimScopedContent) unless `#`;
// - a `{{else}}` outside an `{{if}}` becomes ELSE_MARKER, which a post-processor removes (MacroEngine.js:319).
// Text outside the tags is kept as is, so whitespace there turns into a whitespace-only message that ST still sends
// (P-117, P-138, P-146): the whole block text must be the conditional.

/** ST's ELSE_MARKER (core-macros.js:20): what an `{{else}}` outside its `{{if}}` resolves to before cleanup. */
export const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';

/** Prefix of the flags Maestro sets and clears around a generation (core/ephemeral.ts). */
export const MAESTRO_FLAG_PREFIX = 'maestro_';

/** ST's MACRO_VARIABLE_SHORTHAND_PATTERN (MacroLexer.js:26), anchored. */
const FLAG_NAME_RE = /^[a-zA-Z](?:[\w-]*\w)?$/;
const IDENTIFIER_RE = /^[a-zA-Z][\w-]*/;
const MACRO_FLAG_CHARS = '!?~#/>';

/** A name the `.name` shorthand accepts (starts with a letter, ends with a letter, digit or `_`). */
export function isFlagName(name: string): boolean {
    return FLAG_NAME_RE.test(name);
}

/** A flag of Maestro: `maestro_` and at least one more character, valid for the shorthand. */
export function isMaestroFlag(name: string): boolean {
    return name.length > MAESTRO_FLAG_PREFIX.length && name.startsWith(MAESTRO_FLAG_PREFIX) && isFlagName(name);
}

/* ------------------------------------------------------------------ macros */

/** One `{{…}}` at the top level of a text (nested macros belong to its arguments). */
export interface MacroToken {
    /** Offsets of `{{` and just after `}}`. */
    start: number;
    end: number;
    /** Lower-case identifier; '' for variable expressions (`{{.x}}`), comments and macros the lexer cannot read. */
    name: string;
    /** The `/` flag (closing tag of a scoped macro). */
    closing: boolean;
    /** The `#` flag (keep whitespace of the scoped content). */
    preserve: boolean;
    /** Arguments as written (trimmed). */
    args: string[];
}

/** End (just after `}}`) of the macro that starts at `start`, nested macros included; -1 when it is not closed. */
function macroEnd(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') {
            depth++;
            i++;
        } else if (text[i] === '}' && text[i + 1] === '}') {
            depth--;
            i++;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

/** Splits on `::` outside nested macros. */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < text.length - 1; i++) {
        const pair = text.slice(i, i + 2);
        if (pair === '{{') {
            depth++;
            i++;
        } else if (pair === '}}') {
            depth--;
            i++;
        } else if (pair === '::' && depth === 0) {
            parts.push(text.slice(from, i));
            from = i + 2;
            i++;
        }
    }
    parts.push(text.slice(from));
    return parts;
}

/** Reads the inside of `{{…}}` the way ST's lexer and parser see a regular macro. */
function readMacro(inner: string): Omit<MacroToken, 'start' | 'end'> {
    let i = 0;
    let closing = false;
    let preserve = false;
    const none = { name: '', closing: false, preserve: false, args: [] };
    while (i < inner.length) {
        const char = inner[i]!;
        // `.x` / `$x` are variable expressions and `//` a comment: never an if/else.
        if ((char === '.' || char === '$') && !closing) return none;
        if (char === '/' && inner[i + 1] === '/') return none;
        if (/\s/.test(char)) i++;
        else if (MACRO_FLAG_CHARS.includes(char)) {
            if (char === '/') closing = true;
            if (char === '#') preserve = true;
            i++;
        } else break;
    }
    const match = IDENTIFIER_RE.exec(inner.slice(i));
    if (!match) return none;
    const name = match[0].toLowerCase();
    const rest = inner.slice(i + match[0].length);
    // After the name the lexer wants whitespace, a colon or the end (MacroLexer.js EndOfIdentifier).
    if (rest && !/^[\s:|]/.test(rest)) return none;
    let args: string[];
    if (rest.startsWith('::')) args = splitTopLevel(rest.slice(2)).map((arg) => arg.trim());
    else if (rest.startsWith(':')) args = [rest.slice(1).trim()];
    else args = rest.trim() ? [rest.trim()] : [];
    return { name, closing, preserve, args };
}

/** The macros at the top level of a text, in order (an unclosed `{{` ends the scan). */
export function topLevelMacros(text: string): MacroToken[] {
    const tokens: MacroToken[] = [];
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('{{', i);
        if (start < 0) break;
        const end = macroEnd(text, start);
        if (end < 0) break;
        tokens.push({ start, end, ...readMacro(text.slice(start + 2, end - 2)) });
        i = end;
    }
    return tokens;
}

/** `{{if …}}` with exactly one argument: the only form that takes scoped content up to `{{/if}}`. */
function isScopedIf(token: MacroToken): boolean {
    return token.name === 'if' && !token.closing && token.args.length === 1;
}

/** `{{if::condition::content}}`: the inline form (two arguments, no closing tag). */
function isInlineIf(token: MacroToken): boolean {
    return token.name === 'if' && !token.closing && token.args.length === 2;
}

/* ------------------------------------------------------------------ conditions */

export type ConditionKind =
    /** `.name`: a chat-local variable — the only safe form for Maestro flags (P-137). */
    | 'local'
    /** `$name`: a global variable (one value for every chat). */
    | 'global'
    /** A bare word: a registered macro is resolved, anything else is compared as text (non-empty → true). */
    | 'name'
    /** Anything else (nested macros, phrases). */
    | 'other'
    /** No condition at all (`{{if !}}`). */
    | 'empty';

export interface Condition {
    /** The argument as written, `!` included. */
    raw: string;
    negate: boolean;
    kind: ConditionKind;
    /** Variable name for 'local'/'global', the word for 'name', the rest of the text otherwise. */
    name: string;
}

const SHORTHAND_RE = /^([.$])([a-zA-Z](?:[\w-]*\w)?)$/;

/** Reads a `{{if}}` condition (core-macros.js:163-189). */
export function parseCondition(raw: string): Condition {
    let negate = false;
    let rest = raw;
    if (/^\s*!/.test(rest)) {
        negate = true;
        rest = rest.replace(/^\s*!\s*/, '');
    }
    rest = rest.trim();
    const shorthand = SHORTHAND_RE.exec(rest);
    if (shorthand) {
        return { raw: raw.trim(), negate, kind: shorthand[1] === '.' ? 'local' : 'global', name: shorthand[2]! };
    }
    if (!rest) return { raw: raw.trim(), negate, kind: 'empty', name: '' };
    if (/^[a-zA-Z][\w-]*$/.test(rest)) return { raw: raw.trim(), negate, kind: 'name', name: rest };
    return { raw: raw.trim(), negate, kind: 'other', name: rest };
}

/* ------------------------------------------------------------------ structure */

export type SyntaxIssueCode =
    /** `{{if …}}` without its `{{/if}}`: the tag and all text go to the model literally. */
    | 'unclosed'
    /** `{{/if}}` without an opener: sent literally. */
    | 'strayClose'
    /** `{{else}}` outside a conditional: removed by ST, the text around it is always sent. */
    | 'strayElse'
    /** A second `{{else}}` on the same level: it vanishes and its text joins the else branch. */
    | 'extraElse'
    /** `{{if}}` with no condition: it cannot take content, both tags stay in the text. */
    | 'emptyCondition';

export interface SyntaxIssue {
    code: SyntaxIssueCode;
    /** Offset in the parsed text. */
    at: number;
}

/** A paired `{{if …}}…{{/if}}`. Offsets are in the text it was parsed from. */
export interface IfSection {
    start: number;
    /** Just after the closing tag. */
    end: number;
    /** The content between the tags: [contentStart, contentEnd). */
    contentStart: number;
    contentEnd: number;
    condition: Condition;
    /** `{{#if …}}`: the chosen branch is not trimmed. */
    preserve: boolean;
    /** Raw branches (split on the first top-level `{{else}}`); elseText null without `{{else}}`. */
    thenText: string;
    elseText: string | null;
    /** `{{else}}` tags on the top level of the content (more than one is 'extraElse'). */
    elseCount: number;
    /** Conditionals inside the branches (their offsets are relative to the branch text). */
    nested: { then: IfSection[]; else: IfSection[] };
}

export interface ConditionalParse {
    /** Paired top-level conditionals, in order. */
    sections: IfSection[];
    /** The text outside them (everything else kept as written). */
    outside: string;
    /** Malformed tags, nested ones included (offsets of nested issues point at their section). */
    issues: SyntaxIssue[];
    /** The text has a conditional tag anywhere (`{{if`, `{{else}}`, `{{/if}}`; paired or not, nested too). */
    tagged: boolean;
}

/** Any `{{if …}}`, `{{#if …}}`, `{{else}}` or `{{/if}}` (the lexer allows flags and spaces before the name). */
const CONDITIONAL_TAG_RE = /\{\{[\s!?~#/]*(?:if|else)(?=[\s:|}])/i;

interface Pairing {
    /** opener index → closing index (token indices). */
    pairs: Map<number, number>;
    /** Token indices left as literal text: an opener that cannot take content and the closing it found. */
    raw: Set<number>;
    /** Closing tags with no opener (literal text too). */
    stray: Set<number>;
    /** Token indices inside a pair (handled when the content is read). */
    inside: Set<number>;
    /** Scoped openers that found no closing. */
    unclosed: number[];
}

/** ST's pairing of scoped `{{if}}` tags (MacroCstWalker.js #processScopedMacros, #findMatchingClosingMacro). */
function pairIfs(tokens: readonly MacroToken[]): Pairing {
    const pairs = new Map<number, number>();
    const raw = new Set<number>();
    const stray = new Set<number>();
    const inside = new Set<number>();
    const matched = new Set<number>();
    const unclosed: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const open = tokens[i]!;
        if (open.name !== 'if' || open.closing || matched.has(i) || inside.has(i)) continue;
        let depth = 1;
        let closing = -1;
        for (let j = i + 1; j < tokens.length; j++) {
            const token = tokens[j]!;
            if (token.name !== 'if' || matched.has(j)) continue;
            if (token.closing) {
                depth--;
                if (depth === 0) {
                    closing = j;
                    break;
                }
            } else if (isScopedIf(token)) depth++;
        }
        if (closing < 0) {
            if (isScopedIf(open)) unclosed.push(i);
            continue;
        }
        matched.add(i);
        matched.add(closing);
        if (!isScopedIf(open)) {
            raw.add(i);
            raw.add(closing);
            continue;
        }
        pairs.set(i, closing);
        for (let j = i + 1; j < closing; j++) inside.add(j);
    }
    tokens.forEach((token, index) => {
        if (token.name === 'if' && token.closing && !matched.has(index) && !inside.has(index)) stray.add(index);
    });
    return { pairs, raw, stray, inside, unclosed };
}

/** Splits content on its first top-level `{{else}}` (core-macros.js:104 splitOnTopLevelElse) and counts them. */
function splitElse(content: string): { thenText: string; elseText: string | null; elseCount: number } {
    let depth = 0;
    let split: MacroToken | null = null;
    let count = 0;
    for (const token of topLevelMacros(content)) {
        if (token.name === 'if' && token.closing) depth--;
        else if (isScopedIf(token)) depth++;
        else if (token.name === 'else' && depth === 0) {
            count++;
            split ??= token;
        }
    }
    if (!split) return { thenText: content, elseText: null, elseCount: 0 };
    return { thenText: content.slice(0, split.start), elseText: content.slice(split.end), elseCount: count };
}

/** The conditional structure of a block text. Nesting of any depth is read (the studio edits the top level). */
export function parseConditional(text: string): ConditionalParse {
    const tokens = topLevelMacros(text);
    const pairing = pairIfs(tokens);
    const sections: IfSection[] = [];
    const issues: SyntaxIssue[] = [];
    let outside = '';
    let cursor = 0;
    tokens.forEach((token, index) => {
        if (pairing.inside.has(index)) return;
        if (token.name === 'if' && !token.closing && token.args.length === 0) {
            issues.push({ code: 'emptyCondition', at: token.start });
        }
        if (pairing.stray.has(index)) issues.push({ code: 'strayClose', at: token.start });
        if (token.name === 'else') issues.push({ code: 'strayElse', at: token.start });
        const closing = pairing.pairs.get(index);
        if (closing === undefined) return;
        const close = tokens[closing]!;
        const content = text.slice(token.end, close.start);
        const split = splitElse(content);
        const thenParse = parseConditional(split.thenText);
        const elseParse = split.elseText === null ? null : parseConditional(split.elseText);
        if (split.elseCount > 1) issues.push({ code: 'extraElse', at: token.start });
        for (const nested of [...thenParse.issues, ...(elseParse?.issues ?? [])]) {
            // A stray else inside a branch is the extra else already reported for this section.
            if (nested.code !== 'strayElse') issues.push({ code: nested.code, at: token.start });
        }
        sections.push({
            start: token.start,
            end: close.end,
            contentStart: token.end,
            contentEnd: close.start,
            condition: parseCondition(token.args[0] ?? ''),
            preserve: token.preserve,
            thenText: split.thenText,
            elseText: split.elseText,
            elseCount: split.elseCount,
            nested: { then: thenParse.sections, else: elseParse?.sections ?? [] },
        });
        outside += text.slice(cursor, token.start);
        cursor = close.end;
    });
    outside += text.slice(cursor);
    for (const index of pairing.unclosed) issues.push({ code: 'unclosed', at: tokens[index]!.start });
    issues.sort((a, b) => a.at - b.at);
    return { sections, outside, issues, tagged: CONDITIONAL_TAG_RE.test(text) };
}

/* ------------------------------------------------------------------ whole-block conditions */

/** A block whose whole text is one conditional on a `.flag` (what the studio's «Условие» control edits). */
export interface BlockCondition {
    flag: string;
    negate: boolean;
    /** The then-branch as ST would trim it (macros kept). */
    body: string;
    /** The else branch trimmed, or null. */
    elseText: string | null;
    preserve: boolean;
}

/**
 * The block's own condition: the text is exactly one well-formed `{{if .flag}}…{{/if}}` (nothing outside, not even
 * whitespace). Null for plain, mixed, malformed blocks and other condition kinds.
 */
export function blockCondition(text: string): BlockCondition | null {
    const parse = parseConditional(text);
    if (parse.issues.length || parse.sections.length !== 1 || parse.outside !== '') return null;
    const section = parse.sections[0]!;
    if (section.condition.kind !== 'local') return null;
    const trim = (value: string) => (section.preserve ? value : trimScoped(value));
    return {
        flag: section.condition.name,
        negate: section.condition.negate,
        body: trim(section.thenText),
        elseText: section.elseText === null ? null : trim(section.elseText),
        preserve: section.preserve,
    };
}

/** Problems that make wrapping unsafe: a stray `{{else}}` or `{{/if}}` would pair with the new tags. */
export function wrapBlockers(text: string): SyntaxIssueCode[] {
    const codes = parseConditional(text).issues.map((issue) => issue.code);
    return [...new Set(codes.filter((code) => code === 'strayElse' || code === 'strayClose' || code === 'unclosed'))];
}

export interface WrapOptions {
    negate?: boolean;
    /** Text sent when the condition is false (empty → no `{{else}}`). */
    elseText?: string | null;
}

/**
 * The block text inside `{{if .flag}}…{{/if}}` with nothing outside the tags (§10.4 д). Multi-line texts get the
 * tags on their own lines (ST trims the branch, so the message is the same). Throws on a name `.name` cannot take.
 */
export function wrap(text: string, flag: string, options: WrapOptions = {}): string {
    if (!isFlagName(flag)) throw new Error(`not a variable name for {{if .name}}: ${flag}`);
    const body = text.trim();
    const alt = options.elseText?.trim() ?? '';
    const open = `{{if ${options.negate ? '!' : ''}.${flag}}}`;
    const lines = body.includes('\n') || alt.includes('\n');
    const sep = lines ? '\n' : '';
    const elsePart = alt ? `${sep}{{else}}${sep}${alt}` : '';
    return `${open}${sep}${body}${elsePart}${sep}{{/if}}`;
}

export interface UnwrapOptions {
    /** Which branch replaces a conditional (default 'then', the text between `{{if}}` and `{{else}}`). */
    branch?: 'then' | 'else';
    /** Which top-level conditionals to unwrap (default: those on a `.flag`). */
    filter?: (condition: Condition) => boolean;
}

/**
 * The text with its top-level conditionals replaced by one branch (trimmed like ST does, macros kept); a block that
 * is one conditional becomes that branch. Malformed tags are left as they are.
 */
export function unwrap(text: string, options: UnwrapOptions = {}): string {
    const parse = parseConditional(text);
    const filter = options.filter ?? ((condition: Condition) => condition.kind === 'local');
    let result = '';
    let cursor = 0;
    for (const section of parse.sections) {
        if (!filter(section.condition)) continue;
        const branch = options.branch === 'else' ? (section.elseText ?? '') : section.thenText;
        result += text.slice(cursor, section.start) + (section.preserve ? branch : trimScoped(branch));
        cursor = section.end;
    }
    return result + text.slice(cursor);
}

/* ------------------------------------------------------------------ evaluation */

/** Local variables (flags) by name: a value, or a set/list of names that are on ('1'). */
export type FlagValues = Readonly<Record<string, unknown>> | ReadonlySet<string> | readonly string[];

export interface EvaluateOptions {
    /** Global variables for `$name` conditions (absent → empty). */
    globals?: Readonly<Record<string, unknown>>;
    /** Value of a bare-word or other condition (default: the text itself, as ST does for an unknown name). */
    resolve?: (condition: Condition) => string;
}

/** ST's isFalseBoolean (utils.js:1019). */
export function isFalseBoolean(value: string): boolean {
    return ['off', 'false', '0'].includes(value.trim().toLowerCase());
}

/**
 * The text `{{getvar::name}}` gives for a stored value: getLocalVariable (variables.js:22-46) turns numeric strings
 * into numbers, normalizeMacroResult (MacroEngine.js:332) turns the result back into a string.
 */
export function variableText(value: unknown): string {
    if (value === undefined || value === null) return '';
    const blank = typeof value === 'string' && value.trim() === '';
    const number = Number(value);
    const result = blank || Number.isNaN(number) ? value || '' : number;
    if (typeof result === 'object') {
        try {
            return JSON.stringify(result);
        } catch {
            return String(result);
        }
    }
    return String(result);
}

/** True when `{{if}}` would take its then-branch for this value (core-macros.js:192). */
export function isTruthy(text: string): boolean {
    return text !== '' && !isFalseBoolean(text);
}

function lookup(flags: FlagValues, name: string): unknown {
    if (flags instanceof Set) return flags.has(name) ? '1' : undefined;
    if (Array.isArray(flags)) return flags.includes(name) ? '1' : undefined;
    const record = flags as Readonly<Record<string, unknown>>;
    return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
}

/** True when the condition holds for these flags. */
export function conditionHolds(condition: Condition, flags: FlagValues, options: EvaluateOptions = {}): boolean {
    let value: string;
    if (condition.kind === 'local') value = variableText(lookup(flags, condition.name));
    else if (condition.kind === 'global') value = variableText(options.globals?.[condition.name]);
    else if (condition.kind === 'empty') value = '';
    else value = options.resolve ? options.resolve(condition) : condition.name;
    const truthy = isTruthy(value);
    return condition.negate ? !truthy : truthy;
}

/** ST's trimScopedContent (MacroEngine.js:372): trim, removing the first non-empty line's indent from every line. */
export function trimScoped(content: string): string {
    if (!content) return '';
    const lines = content.split('\n');
    const first = lines.find((line) => line.trim() !== '');
    const base = first ? (/^[ \t]*/.exec(first)?.[0].length ?? 0) : 0;
    if (base === 0) return content.trim();
    return lines
        .map((line) => {
            const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
            return indent >= base ? line.slice(base) : line.trimStart();
        })
        .join('\n')
        .trim();
}

function evaluateInner(text: string, flags: FlagValues, options: EvaluateOptions): string {
    const tokens = topLevelMacros(text);
    if (!tokens.length) return text;
    const pairing = pairIfs(tokens);
    const branchOf = (condition: Condition, content: string, preserve: boolean): string => {
        const split = splitElse(content);
        const branch = conditionHolds(condition, flags, options) ? split.thenText : split.elseText;
        if (branch === null) return '';
        const value = evaluateInner(branch, flags, options);
        return preserve ? value : trimScoped(value);
    };
    let result = '';
    let cursor = 0;
    tokens.forEach((token, index) => {
        if (pairing.inside.has(index)) return;
        const closing = pairing.pairs.get(index);
        if (closing !== undefined) {
            const close = tokens[closing]!;
            result += text.slice(cursor, token.start);
            result += branchOf(parseCondition(token.args[0] ?? ''), text.slice(token.end, close.start), token.preserve);
            cursor = close.end;
        } else if (isInlineIf(token) && !pairing.raw.has(index)) {
            result += text.slice(cursor, token.start);
            result += branchOf(parseCondition(token.args[0] ?? ''), token.args[1] ?? '', token.preserve);
            cursor = token.end;
        } else if (token.name === 'else') {
            // ELSE_MARKER, removed by ST's post-processor (MacroEngine.js:319).
            result += text.slice(cursor, token.start);
            cursor = token.end;
        }
    });
    return result + text.slice(cursor);
}

/**
 * The text ST's new macro engine sends for these flags: conditionals resolved, every other macro left as written
 * (previews). Unclosed and stray tags stay in the text, as in ST.
 */
export function evaluate(text: string, flags: FlagValues, options: EvaluateOptions = {}): string {
    return evaluateInner(text, flags, options).replaceAll(ELSE_MARKER, '');
}

/* ------------------------------------------------------------------ flags of a text */

export interface FlagUse {
    name: string;
    /** Used with `!` somewhere. */
    negated: boolean;
    /** Used without `!` somewhere. */
    plain: boolean;
}

/** Local variables the conditionals of a text read (nested ones included), in order of first use. */
export function flagUses(text: string): FlagUse[] {
    const uses = new Map<string, FlagUse>();
    const visit = (sections: readonly IfSection[]) => {
        for (const section of sections) {
            const { condition } = section;
            if (condition.kind === 'local') {
                const use = uses.get(condition.name) ?? { name: condition.name, negated: false, plain: false };
                if (condition.negate) use.negated = true;
                else use.plain = true;
                uses.set(condition.name, use);
            }
            visit(section.nested.then);
            visit(section.nested.else);
        }
    };
    visit(parseConditional(text).sections);
    return [...uses.values()];
}
