// M25 «Механики», formulas (plan-2 §6 п. 9 «Формулы и производные значения», п. 1 effects with formulas): a small
// arithmetic language read by a hand-written parser and evaluated over an AST — never `eval`, never `Function`.
//   numbers 12, 0.5 · + − × ÷ (also - * /, the unicode minus) · parentheses · min(a, b, …) max(…) floor(x) ceil(x)
//   round(x) abs(x) clamp(x, lo, hi) · references `@attr` (the holder's attribute), `@mechanic.attr` (another
//   mechanic of the same holder), `@roll.total` / `@roll.margin` / `@roll.natural` (the roll an effect follows)
//   · dice `2d6`, `d20`, `1к6` where the caller allows them (effects; never in derived attributes).
// Errors carry a code (`m25.formula.error.<code>` in the UI) and the character position; `formulaErrorText` gives the
// English sentence. Derived attributes may not reference each other in a circle (`formulaCycles`).
// Pure: no DOM, no SillyTavern.

/* ------------------------------------------------------------------ types */

export type FormulaNode =
    | { type: 'num'; value: number }
    | { type: 'ref'; path: string[] }
    | { type: 'dice'; count: number; sides: number }
    | { type: 'neg'; arg: FormulaNode }
    | { type: 'bin'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
    | { type: 'call'; name: FormulaFunction; args: FormulaNode[] };

export type FormulaFunction = 'min' | 'max' | 'floor' | 'ceil' | 'round' | 'abs' | 'clamp';

export type FormulaErrorCode =
    'empty' | 'long' | 'char' | 'syntax' | 'paren' | 'func' | 'args' | 'dice' | 'ref' | 'cycle' | 'depth';

export interface FormulaError {
    code: FormulaErrorCode;
    /** Character position (0-based) where the problem was found. */
    at?: number;
    /** The token, function, reference or circle involved. */
    detail?: string;
}

export type ParsedFormula =
    { ok: true; ast: FormulaNode; refs: string[][]; dice: boolean; text: string } | { ok: false; error: FormulaError };

export interface FormulaOptions {
    /** Dice terms are allowed (effects); derived attributes refuse them. */
    dice?: boolean;
}

export interface EvalContext {
    /** A reference's value; null when the holder has none (counted as 0 and reported). */
    ref(path: readonly string[]): number | null;
    /** RNG for dice terms in [0, 1); without one a dice term is its average. */
    rng?: () => number;
}

export interface EvalResult {
    value: number;
    /** References that had no value (dotted). */
    missing: string[];
    /** Every die rolled, in order. */
    rolls: number[];
    /** A division by zero happened (the quotient counted as 0). */
    divZero?: boolean;
}

export const FORMULA_LIMITS = { length: 200, depth: 24, dice: 20, sides: 1000, args: 12 } as const;

const FUNCTIONS: Record<FormulaFunction, { min: number; max: number }> = {
    min: { min: 1, max: FORMULA_LIMITS.args },
    max: { min: 1, max: FORMULA_LIMITS.args },
    floor: { min: 1, max: 1 },
    ceil: { min: 1, max: 1 },
    round: { min: 1, max: 1 },
    abs: { min: 1, max: 1 },
    clamp: { min: 3, max: 3 },
};

/* ------------------------------------------------------------------ tokens */

type Token =
    | { kind: 'num'; value: number; at: number }
    | { kind: 'ident'; name: string; at: number }
    | { kind: 'ref'; path: string[]; at: number }
    | { kind: 'dice'; count: number; sides: number; at: number }
    | { kind: 'op'; op: '+' | '-' | '*' | '/'; at: number }
    | { kind: 'lp' | 'rp' | 'comma'; at: number };

const IDENT = /[a-z_][a-z0-9_]*/y;
const NUMBER = /\d+(?:\.\d+)?/y;
const DICE = /(\d*)[dк](\d+)(?![a-z0-9_])/y;

function tokenize(text: string): Token[] | FormulaError {
    const tokens: Token[] = [];
    let i = 0;
    while (i < text.length) {
        const char = text[i] as string;
        if (/\s/.test(char)) {
            i++;
            continue;
        }
        const at = i;
        if ('+'.includes(char)) {
            tokens.push({ kind: 'op', op: '+', at });
            i++;
        } else if ('-\u2212\u2013\u2012'.includes(char)) {
            tokens.push({ kind: 'op', op: '-', at });
            i++;
        } else if ('*×·'.includes(char)) {
            tokens.push({ kind: 'op', op: '*', at });
            i++;
        } else if ('/÷:'.includes(char)) {
            tokens.push({ kind: 'op', op: '/', at });
            i++;
        } else if (char === '(') {
            tokens.push({ kind: 'lp', at });
            i++;
        } else if (char === ')') {
            tokens.push({ kind: 'rp', at });
            i++;
        } else if (char === ',' || char === ';') {
            tokens.push({ kind: 'comma', at });
            i++;
        } else if (char === '@') {
            const path: string[] = [];
            let cursor = i + 1;
            for (;;) {
                IDENT.lastIndex = cursor;
                const match = IDENT.exec(text);
                if (!match) return { code: 'ref', at, detail: text.slice(at, cursor + 1) };
                path.push(match[0]);
                cursor += match[0].length;
                if (text[cursor] === '.' && path.length < 3) {
                    cursor++;
                    continue;
                }
                break;
            }
            tokens.push({ kind: 'ref', path, at });
            i = cursor;
        } else {
            DICE.lastIndex = i;
            const dice = DICE.exec(text);
            if (dice) {
                const count = dice[1] ? Number(dice[1]) : 1;
                tokens.push({ kind: 'dice', count, sides: Number(dice[2]), at });
                i += dice[0].length;
                continue;
            }
            NUMBER.lastIndex = i;
            const number = NUMBER.exec(text);
            if (number) {
                tokens.push({ kind: 'num', value: Number(number[0]), at });
                i += number[0].length;
                continue;
            }
            IDENT.lastIndex = i;
            const ident = IDENT.exec(text);
            if (ident) {
                tokens.push({ kind: 'ident', name: ident[0], at });
                i += ident[0].length;
                continue;
            }
            return { code: 'char', at, detail: char };
        }
    }
    return tokens;
}

/* ------------------------------------------------------------------ parser */

class Parser {
    private pos = 0;
    private depth = 0;
    readonly refs: string[][] = [];
    usesDice = false;

    constructor(
        private readonly tokens: readonly Token[],
        private readonly options: FormulaOptions,
        private readonly length: number,
    ) {}

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private fail(code: FormulaErrorCode, token?: Token, detail?: string): never {
        const error: FormulaError = { code, at: token?.at ?? this.length };
        if (detail !== undefined) error.detail = detail;
        throw error;
    }

    parse(): FormulaNode {
        const node = this.expr();
        const rest = this.peek();
        if (rest) this.fail(rest.kind === 'rp' ? 'paren' : 'syntax', rest, rest.kind === 'rp' ? ')' : undefined);
        return node;
    }

    private enter(token?: Token): void {
        if (++this.depth > FORMULA_LIMITS.depth) this.fail('depth', token);
    }

    private expr(): FormulaNode {
        this.enter(this.peek());
        let left = this.term();
        for (let token = this.peek(); token?.kind === 'op' && (token.op === '+' || token.op === '-');) {
            this.pos++;
            left = { type: 'bin', op: token.op, left, right: this.term() };
            token = this.peek();
        }
        this.depth--;
        return left;
    }

    private term(): FormulaNode {
        let left = this.unary();
        for (let token = this.peek(); token?.kind === 'op' && (token.op === '*' || token.op === '/');) {
            this.pos++;
            left = { type: 'bin', op: token.op, left, right: this.unary() };
            token = this.peek();
        }
        return left;
    }

    private unary(): FormulaNode {
        const token = this.peek();
        if (token?.kind === 'op' && (token.op === '-' || token.op === '+')) {
            this.pos++;
            this.enter(token);
            const arg = this.unary();
            this.depth--;
            return token.op === '-' ? { type: 'neg', arg } : arg;
        }
        return this.primary();
    }

    private primary(): FormulaNode {
        const token = this.peek();
        if (!token) return this.fail('syntax');
        this.pos++;
        switch (token.kind) {
            case 'num':
                return { type: 'num', value: token.value };
            case 'ref':
                this.refs.push(token.path);
                return { type: 'ref', path: token.path };
            case 'dice':
                if (!this.options.dice) this.fail('dice', token, `${token.count}d${token.sides}`);
                if (token.count < 1 || token.count > FORMULA_LIMITS.dice || token.sides < 2) {
                    this.fail('dice', token, `${token.count}d${token.sides}`);
                }
                if (token.sides > FORMULA_LIMITS.sides) this.fail('dice', token, `${token.count}d${token.sides}`);
                this.usesDice = true;
                return { type: 'dice', count: token.count, sides: token.sides };
            case 'lp': {
                const inner = this.expr();
                const close = this.peek();
                if (close?.kind !== 'rp') this.fail('paren', close ?? token, '(');
                this.pos++;
                return inner;
            }
            case 'ident': {
                const name = token.name as FormulaFunction;
                if (!Object.hasOwn(FUNCTIONS, name)) this.fail('func', token, token.name);
                const open = this.peek();
                if (open?.kind !== 'lp') this.fail('syntax', open ?? token, token.name);
                this.pos++;
                const args: FormulaNode[] = [];
                if (this.peek()?.kind !== 'rp') {
                    args.push(this.expr());
                    while (this.peek()?.kind === 'comma') {
                        this.pos++;
                        args.push(this.expr());
                    }
                }
                const close = this.peek();
                if (close?.kind !== 'rp') this.fail('paren', close ?? token, '(');
                this.pos++;
                const spec = FUNCTIONS[name];
                if (args.length < spec.min || args.length > spec.max) this.fail('args', token, name);
                return { type: 'call', name, args };
            }
            default:
                return this.fail(token.kind === 'rp' ? 'paren' : 'syntax', token, token.kind === 'rp' ? ')' : '');
        }
    }
}

function isFormulaError(value: unknown): value is FormulaError {
    return typeof value === 'object' && value !== null && typeof (value as FormulaError).code === 'string';
}

/** Reads a formula. Lower case; the Russian «к» is a die; spaces do not matter. */
export function parseFormula(raw: string | number, options: FormulaOptions = {}): ParsedFormula {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) return { ok: false, error: { code: 'syntax' } };
        return { ok: true, ast: { type: 'num', value: raw }, refs: [], dice: false, text: String(raw) };
    }
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!text) return { ok: false, error: { code: 'empty' } };
    if (text.length > FORMULA_LIMITS.length) return { ok: false, error: { code: 'long' } };
    const tokens = tokenize(text);
    if (!Array.isArray(tokens)) return { ok: false, error: tokens };
    if (!tokens.length) return { ok: false, error: { code: 'empty' } };
    const parser = new Parser(tokens, options, text.length);
    try {
        const ast = parser.parse();
        return { ok: true, ast, refs: parser.refs, dice: parser.usesDice, text: formulaText(ast) };
    } catch (error) {
        if (isFormulaError(error)) return { ok: false, error };
        throw error;
    }
}

/* ------------------------------------------------------------------ evaluation */

function roundSafe(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function rollDie(sides: number, rng: () => number): number {
    const raw = rng();
    const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON) : 0;
    return Math.floor(unit * sides) + 1;
}

/** Evaluates a parsed formula; never throws (missing references count as 0, division by zero as 0). */
export function evaluateFormula(ast: FormulaNode, context: EvalContext): EvalResult {
    const result: EvalResult = { value: 0, missing: [], rolls: [] };
    const walk = (node: FormulaNode): number => {
        switch (node.type) {
            case 'num':
                return node.value;
            case 'ref': {
                let value: number | null;
                try {
                    value = context.ref(node.path);
                } catch {
                    value = null;
                }
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                const key = node.path.join('.');
                if (!result.missing.includes(key)) result.missing.push(key);
                return 0;
            }
            case 'dice': {
                let sum = 0;
                for (let i = 0; i < node.count; i++) {
                    if (context.rng) {
                        const face = rollDie(node.sides, context.rng);
                        result.rolls.push(face);
                        sum += face;
                    } else sum += (node.sides + 1) / 2;
                }
                return sum;
            }
            case 'neg':
                return -walk(node.arg);
            case 'bin': {
                const left = walk(node.left);
                const right = walk(node.right);
                switch (node.op) {
                    case '+':
                        return left + right;
                    case '-':
                        return left - right;
                    case '*':
                        return left * right;
                    default:
                        if (right === 0) {
                            result.divZero = true;
                            return 0;
                        }
                        return left / right;
                }
            }
            case 'call': {
                const args = node.args.map(walk);
                switch (node.name) {
                    case 'min':
                        return Math.min(...args);
                    case 'max':
                        return Math.max(...args);
                    case 'floor':
                        return Math.floor(args[0] as number);
                    case 'ceil':
                        return Math.ceil(args[0] as number);
                    case 'round':
                        return Math.round(args[0] as number);
                    case 'abs':
                        return Math.abs(args[0] as number);
                    default: {
                        const [value, lo, hi] = args as [number, number, number];
                        return Math.min(Math.max(value, Math.min(lo, hi)), Math.max(lo, hi));
                    }
                }
            }
        }
    };
    const value = walk(ast);
    result.value = Number.isFinite(value) ? roundSafe(value) : 0;
    return result;
}

/** Parses and evaluates in one step; null when the formula does not parse. */
export function computeFormula(
    raw: string | number,
    context: EvalContext,
    options: FormulaOptions = {},
): EvalResult | null {
    const parsed = parseFormula(raw, options);
    return parsed.ok ? evaluateFormula(parsed.ast, context) : null;
}

/* ------------------------------------------------------------------ text */

const PRECEDENCE: Record<'+' | '-' | '*' | '/', number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** The canonical text of a formula ('max(1, @level * 2) + 2d6'). */
export function formulaText(node: FormulaNode): string {
    switch (node.type) {
        case 'num':
            return String(node.value);
        case 'ref':
            return `@${node.path.join('.')}`;
        case 'dice':
            return `${node.count}d${node.sides}`;
        case 'neg': {
            const inner = formulaText(node.arg);
            return node.arg.type === 'bin' ? `-(${inner})` : `-${inner}`;
        }
        case 'bin': {
            const wrap = (child: FormulaNode, right: boolean) => {
                const text = formulaText(child);
                if (child.type !== 'bin') return text;
                const lower = PRECEDENCE[child.op] < PRECEDENCE[node.op];
                const sameRight = right && PRECEDENCE[child.op] === PRECEDENCE[node.op] && node.op !== '+';
                return lower || (right && sameRight) ? `(${text})` : text;
            };
            const op = node.op === '*' ? '*' : node.op;
            return `${wrap(node.left, false)} ${op} ${wrap(node.right, true)}`;
        }
        case 'call':
            return `${node.name}(${node.args.map(formulaText).join(', ')})`;
    }
}

/** A plain number for constant formulas ('12', '-3'), null otherwise. */
export function constantOf(raw: string | number): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    const parsed = parseFormula(raw, { dice: true });
    if (!parsed.ok || parsed.refs.length || parsed.dice) return null;
    return evaluateFormula(parsed.ast, { ref: () => null }).value;
}

const ERROR_TEXT: Record<FormulaErrorCode, string> = {
    empty: 'the formula is empty',
    long: `the formula is longer than ${FORMULA_LIMITS.length} characters`,
    char: 'an unexpected character',
    syntax: 'something is missing or out of place',
    paren: 'the parentheses do not match',
    func: 'an unknown function (min, max, floor, ceil, round, abs and clamp are known)',
    args: 'a function got the wrong number of values',
    dice: 'dice are not allowed here (or the die is too large)',
    ref: 'an unknown reference',
    cycle: 'the formulas refer to each other in a circle',
    depth: 'the formula is nested too deeply',
};

/** English text of an error ("an unknown function (min, max…) at 4: «pow»"). */
export function formulaErrorText(error: FormulaError): string {
    const where = error.at !== undefined ? ` at ${error.at + 1}` : '';
    const what = error.detail ? `: «${error.detail}»` : '';
    return `${ERROR_TEXT[error.code]}${where}${what}`;
}

/* ------------------------------------------------------------------ references and cycles */

/**
 * Checks the references of a parsed formula: `known(path)` says whether one exists. The first unknown one as an
 * error, or null.
 */
export function unknownRef(parsed: ParsedFormula, known: (path: readonly string[]) => boolean): FormulaError | null {
    if (!parsed.ok) return parsed.error;
    for (const path of parsed.refs) {
        if (!known(path)) return { code: 'ref', detail: `@${path.join('.')}` };
    }
    return null;
}

/**
 * Circles in a dependency graph (node → nodes it reads). Each circle once, as the list of its nodes in order
 * (starting with the smallest key). Used for derived attributes that read each other.
 */
export function formulaCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
    const cycles: string[][] = [];
    const seen = new Set<string>();
    const state = new Map<string, 'open' | 'done'>();
    const stack: string[] = [];
    const visit = (node: string) => {
        state.set(node, 'open');
        stack.push(node);
        for (const next of graph.get(node) ?? []) {
            if (!graph.has(next)) continue;
            const mark = state.get(next);
            if (mark === 'open') {
                const cycle = stack.slice(stack.indexOf(next));
                const start = cycle.indexOf([...cycle].sort()[0] as string);
                const ordered = [...cycle.slice(start), ...cycle.slice(0, start)];
                const key = ordered.join('>');
                if (!seen.has(key)) {
                    seen.add(key);
                    cycles.push(ordered);
                }
            } else if (mark === undefined) visit(next);
        }
        stack.pop();
        state.set(node, 'done');
    };
    for (const node of [...graph.keys()].sort()) if (!state.has(node)) visit(node);
    return cycles;
}
