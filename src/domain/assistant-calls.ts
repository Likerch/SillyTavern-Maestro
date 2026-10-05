// Tool calls of Maestro's assistant (M33): reading the provider's tool_calls (OpenAI shape; the LLM client converts
// Claude tool_use blocks to it), tolerant parsing of the arguments, a light check against the tool's JSON schema
// and the function specs offered to the model. Pure.

/** Tool names: snake_case, as most providers require (^[a-zA-Z0-9_-]{1,64}$, stricter here). */
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A name the provider accepts when it comes back in the history (the model may have sent garbage). */
export function safeToolName(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'unknown_tool';
}

export interface ParsedCall {
    /** Provider id when it is usable, otherwise a generated one. */
    id: string;
    name: string;
    /** Arguments as the model sent them (for the error message when they could not be parsed). */
    rawArgs: string;
    /** Parsed arguments (an empty object when parsing failed). */
    args: Record<string, unknown>;
    /** Why the arguments could not be parsed. */
    error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
    try {
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
        return { ok: false };
    }
}

/** Second chance for sloppy JSON: code fences, prose around the object, trailing commas. */
function repairJson(text: string): string | undefined {
    const unfenced = text
        .replace(/```[a-zA-Z]*\s*/g, '')
        .replace(/```/g, '')
        .trim();
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    return unfenced.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
}

export type ArgsParse = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** Arguments of a tool call: an object, a JSON string (repaired when sloppy), or nothing (= no arguments). */
export function parseArgs(raw: unknown): ArgsParse {
    if (raw === undefined || raw === null) return { ok: true, args: {} };
    if (isRecord(raw)) return { ok: true, args: raw };
    if (typeof raw !== 'string') return { ok: false, error: 'arguments must be a JSON object' };
    const text = raw.trim();
    if (!text) return { ok: true, args: {} };
    let parsed = tryJson(text);
    if (!parsed.ok) {
        const repaired = repairJson(text);
        if (repaired !== undefined) parsed = tryJson(repaired);
    }
    if (!parsed.ok) return { ok: false, error: 'arguments are not valid JSON' };
    if (!isRecord(parsed.value)) return { ok: false, error: 'arguments must be a JSON object' };
    return { ok: true, args: parsed.value };
}

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Normalises the provider's tool calls. Items without a function name are kept (with an empty name) so the model
 * is told about its mistake instead of being ignored. Ids are kept when usable and unique, otherwise generated.
 */
export function readToolCalls(raw: readonly unknown[] | undefined, makeId: () => string): ParsedCall[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const calls: ParsedCall[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        const fn = isRecord(item['function']) ? item['function'] : item;
        const name = typeof fn['name'] === 'string' ? fn['name'].trim() : '';
        const rawArgs = fn['arguments'] ?? fn['input'] ?? fn['args'];
        const providerId = typeof item['id'] === 'string' ? item['id'] : '';
        const id = PROVIDER_ID.test(providerId) && !seen.has(providerId) ? providerId : makeId();
        seen.add(id);
        const parsed = parseArgs(rawArgs);
        const text = typeof rawArgs === 'string' ? rawArgs : rawArgs === undefined ? '{}' : safeStringify(rawArgs);
        calls.push(
            parsed.ok
                ? { id, name, rawArgs: text, args: parsed.args }
                : { id, name, rawArgs: text, args: {}, error: parsed.error },
        );
    }
    return calls;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '{}';
    } catch {
        return '{}';
    }
}

/**
 * The call as it goes back to the provider inside the assistant message. Always valid JSON (the parsed arguments,
 * `{}` when they could not be parsed): some backends parse it again (Claude tool_use input) and would fail.
 */
export function wireCall(call: { id: string; name: string; args: Record<string, unknown> }): {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
} {
    return {
        id: call.id,
        type: 'function',
        function: { name: safeToolName(call.name), arguments: safeStringify(call.args) },
    };
}

/** OpenAI function spec of a tool. */
export function functionSpec(tool: { name: string; description: string; parameters: Record<string, unknown> }): {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
} {
    const parameters = isRecord(tool.parameters) ? tool.parameters : {};
    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters:
                parameters['type'] === 'object' ? parameters : { type: 'object', properties: {}, ...parameters },
        },
    };
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'array':
            return Array.isArray(value);
        case 'object':
            return isRecord(value);
        case 'null':
            return value === null;
        default:
            return true;
    }
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/**
 * Top-level problems of the arguments against the tool's schema: missing required properties, wrong types,
 * values outside an enum. Nested shapes are the tool's business. Messages are English (for the model).
 */
export function argProblems(args: Record<string, unknown>, schema: unknown): string[] {
    if (!isRecord(schema)) return [];
    const problems: string[] = [];
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    for (const key of required) {
        if (typeof key === 'string' && (args[key] === undefined || args[key] === null))
            problems.push(`"${key}" is required`);
    }
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    for (const [key, sub] of Object.entries(properties)) {
        const value = args[key];
        if (value === undefined || !isRecord(sub)) continue;
        const type = sub['type'];
        const types =
            typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((t) => typeof t === 'string') : [];
        if (types.length && !types.some((item) => matchesType(value, item as string))) {
            problems.push(`"${key}" must be ${types.join(' or ')}, got ${describe(value)}`);
            continue;
        }
        const options = sub['enum'];
        if (Array.isArray(options) && !options.some((option) => option === value))
            problems.push(`"${key}" must be one of ${options.map((option) => JSON.stringify(option)).join(', ')}`);
    }
    if (schema['additionalProperties'] === false) {
        for (const key of Object.keys(args)) {
            if (!Object.hasOwn(properties, key)) problems.push(`"${key}" is not a known argument`);
        }
    }
    return problems;
}
