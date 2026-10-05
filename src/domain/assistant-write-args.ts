// Arguments of the assistant's write tools (M33, stage 13): the model sends JSON that only looks like the schema, so
// every tool reads its arguments through these checks. A problem is an ArgError with a code and parameters; the
// feature layer turns it into a sentence in the user's language (`m33w.err.<code>`). Lenient where a model often
// slips (numbers and booleans as strings), strict where a guess would change the meaning.
// Pure: no DOM, no SillyTavern.

export type Dict = Record<string, unknown>;
export type ErrorParams = Record<string, string | number>;

/** A problem with the arguments (or with what they describe); `code` names the message, `params` fill it. */
export class ArgError extends Error {
    constructor(
        readonly code: string,
        readonly params: ErrorParams = {},
    ) {
        super(code);
        this.name = 'ArgError';
    }
}

/** Type names used in `argType` errors (the feature translates them). */
export type ExpectedType = 'string' | 'boolean' | 'number' | 'integer' | 'list' | 'object';

export function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-safe deep copy. */
export function jsonCopy<T>(value: T): T {
    const text = JSON.stringify(value);
    return text === undefined ? value : (JSON.parse(text) as T);
}

/** Same JSON (key order matters only within arrays). */
export function sameJson(a: unknown, b: unknown): boolean {
    return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (isDict(value)) {
        const keys = Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

function present(args: Dict, name: string): boolean {
    return args[name] !== undefined && args[name] !== null;
}

export interface StringOptions {
    /** Longest allowed length (after trimming). */
    max?: number;
    /** Keep the text as given (multi-line content); otherwise it is trimmed. */
    raw?: boolean;
    /** An empty text is accepted (e.g. a regex replacement). */
    allowEmpty?: boolean;
}

/** An optional string: undefined when absent; numbers are accepted as their text. */
export function optString(args: Dict, name: string, options: StringOptions = {}): string | undefined {
    if (!present(args, name)) return undefined;
    const value = args[name];
    let text: string;
    if (typeof value === 'string') text = value;
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else throw new ArgError('argType', { name, expected: 'string' });
    if (!options.raw) text = text.trim();
    else text = text.replace(/\r\n?/g, '\n');
    if (!text.trim() && !options.allowEmpty) throw new ArgError('argEmpty', { name });
    if (options.max !== undefined && text.length > options.max) {
        throw new ArgError('argTooLong', { name, max: options.max });
    }
    return text;
}

export function reqString(args: Dict, name: string, options: StringOptions = {}): string {
    const value = optString(args, name, options);
    if (value === undefined) throw new ArgError('argMissing', { name });
    return value;
}

/** An optional boolean; "true"/"false" (any case), 1/0 are accepted. */
export function optBool(args: Dict, name: string): boolean | undefined {
    if (!present(args, name)) return undefined;
    const value = args[name];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (text === 'true') return true;
        if (text === 'false') return false;
    }
    throw new ArgError('argType', { name, expected: 'boolean' });
}

export function reqBool(args: Dict, name: string): boolean {
    const value = optBool(args, name);
    if (value === undefined) throw new ArgError('argMissing', { name });
    return value;
}

/** An optional integer within bounds; numeric strings are accepted. */
export function optInt(args: Dict, name: string, min: number, max: number): number | undefined {
    if (!present(args, name)) return undefined;
    const value = args[name];
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isInteger(number)) throw new ArgError('argType', { name, expected: 'integer' });
    if (number < min || number > max) throw new ArgError('argRange', { name, min, max });
    return number;
}

export function reqInt(args: Dict, name: string, min: number, max: number): number {
    const value = optInt(args, name, min, max);
    if (value === undefined) throw new ArgError('argMissing', { name });
    return value;
}

/** One of the listed values (exact match, then case-insensitive). */
export function optEnum<T extends string>(args: Dict, name: string, options: readonly T[]): T | undefined {
    if (!present(args, name)) return undefined;
    const value = args[name];
    if (typeof value !== 'string') throw new ArgError('argEnum', { name, options: options.join(', ') });
    const exact = options.find((option) => option === value.trim());
    if (exact) return exact;
    const loose = options.find((option) => option.toLowerCase() === value.trim().toLowerCase());
    if (loose) return loose;
    throw new ArgError('argEnum', { name, options: options.join(', ') });
}

export function reqEnum<T extends string>(args: Dict, name: string, options: readonly T[]): T {
    const value = optEnum(args, name, options);
    if (value === undefined) throw new ArgError('argMissing', { name });
    return value;
}

export interface ListOptions {
    /** Most items accepted. */
    maxItems?: number;
    /** Longest item. */
    maxLength?: number;
    /** Keep items as given (multi-line samples); otherwise trimmed. */
    raw?: boolean;
    /** Drop duplicates (case-insensitive) and empty items. */
    unique?: boolean;
    /** A single string is accepted as a list: split by commas (`split`) or taken as one item. */
    fromString?: 'split' | 'single';
}

/** An optional list of strings. */
export function optStringList(args: Dict, name: string, options: ListOptions = {}): string[] | undefined {
    if (!present(args, name)) return undefined;
    const value = args[name];
    let items: unknown[];
    if (Array.isArray(value)) items = value;
    else if (typeof value === 'string' && options.fromString === 'split') items = value.split(',');
    else if (typeof value === 'string' && options.fromString === 'single') items = [value];
    else throw new ArgError('argType', { name, expected: 'list' });
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item))) {
            throw new ArgError('argType', { name, expected: 'list' });
        }
        const text = options.raw ? String(item).replace(/\r\n?/g, '\n') : String(item).trim();
        if (options.maxLength !== undefined && text.length > options.maxLength) {
            throw new ArgError('argTooLong', { name, max: options.maxLength });
        }
        if (options.unique) {
            const key = text.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
        }
        result.push(text);
    }
    if (options.maxItems !== undefined && result.length > options.maxItems) {
        throw new ArgError('argTooMany', { name, max: options.maxItems });
    }
    return result;
}

export function reqStringList(args: Dict, name: string, options: ListOptions = {}): string[] {
    const value = optStringList(args, name, options);
    if (value === undefined || !value.length) throw new ArgError('argMissing', { name });
    return value;
}

/** An optional JSON object (a string holding a JSON object is parsed: models sometimes send one). */
export function optObject(args: Dict, name: string): Dict | undefined {
    if (!present(args, name)) return undefined;
    let value = args[name];
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            throw new ArgError('argType', { name, expected: 'object' });
        }
    }
    if (!isDict(value)) throw new ArgError('argType', { name, expected: 'object' });
    return value;
}

export function reqObject(args: Dict, name: string): Dict {
    const value = optObject(args, name);
    if (value === undefined) throw new ArgError('argMissing', { name });
    return value;
}

/** Exactly one of two arguments must be given. */
export function exactlyOne(args: Dict, a: string, b: string): 'a' | 'b' {
    const hasA = present(args, a);
    const hasB = present(args, b);
    if (hasA && hasB) throw new ArgError('argOneOf', { a, b });
    if (!hasA && !hasB) throw new ArgError('argNeedOne', { a, b });
    return hasA ? 'a' : 'b';
}

/** Text cut to `max` characters with an ellipsis (for summaries and cards). */
export function clip(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

/** Finds a name in a list: exact, then case-insensitive; null when absent or ambiguous (`ambiguous` set). */
export function pickName(list: readonly string[], wanted: string): { name: string | null; ambiguous: boolean } {
    if (list.includes(wanted)) return { name: wanted, ambiguous: false };
    const lower = wanted.trim().toLowerCase();
    const matches = list.filter((item) => item.toLowerCase() === lower);
    if (matches.length === 1) return { name: matches[0]!, ambiguous: false };
    return { name: null, ambiguous: matches.length > 1 };
}
