// Per-scenario parameters (M34 п.7, п.9), pure: the values the user keeps for a scenario (length, temperature, stop
// strings, reasoning, an optional custom message set) merged over the scenario's defaults, turned into the request
// parameters of one generation, and the custom message set expanded: a message that is exactly `{{history}}` becomes
// the recent chat; for `continue` the continued message (and ST's nudge after it) is taken from ST's own prompt once,
// so no prefill or continued text is sent twice.
import type { PromptMessage, ScenarioParams } from './scenario-params';

export interface ScenarioParamValues {
    /** Built-in scenarios are switched on by the user (default off). */
    enabled?: boolean;
    max_tokens?: number;
    temperature?: number;
    /** Stop strings of this request (`{{char}}`, `{{user}}` → names); an empty list removes ST's ones. */
    stop?: string[];
    /** 'off' turns reasoning off for this request; 'keep' leaves the connection's setting. */
    reasoning?: 'keep' | 'off';
    /** A custom message set that replaces the prompt; empty or missing = ST's prompt stays, only parameters change. */
    messages?: PromptMessage[];
    /** Chat messages a `{{history}}` line expands to. */
    historyMessages?: number;
}

/** A message whose whole text is this placeholder becomes the recent chat. */
export const HISTORY_PLACEHOLDER = '{{history}}';
export const DEFAULT_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGES = 200;
const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Keeps only valid values (settings come from settings.json and may be edited by hand). */
export function sanitizeScenarioParams(raw: unknown): ScenarioParamValues {
    if (!isDict(raw)) return {};
    const values: ScenarioParamValues = {};
    if (typeof raw.enabled === 'boolean') values.enabled = raw.enabled;
    if (finite(raw.max_tokens) && raw.max_tokens > 0) values.max_tokens = Math.floor(raw.max_tokens);
    if (finite(raw.temperature) && raw.temperature >= 0 && raw.temperature <= 2) values.temperature = raw.temperature;
    if (Array.isArray(raw.stop)) values.stop = raw.stop.filter((item): item is string => typeof item === 'string');
    if (raw.reasoning === 'keep' || raw.reasoning === 'off') values.reasoning = raw.reasoning;
    if (Array.isArray(raw.messages)) {
        values.messages = raw.messages
            .filter(isDict)
            .filter((message) => typeof message.content === 'string' && ROLES.has(String(message.role)))
            .map((message) => ({ role: message.role as PromptMessage['role'], content: message.content as string }));
    }
    if (finite(raw.historyMessages) && raw.historyMessages >= 0) {
        values.historyMessages = Math.min(MAX_HISTORY_MESSAGES, Math.floor(raw.historyMessages));
    }
    return values;
}

/** The user's values over the defaults (both sanitised). */
export function mergeScenarioParams(defaults: ScenarioParamValues, stored: unknown): ScenarioParamValues {
    return { ...sanitizeScenarioParams(defaults), ...sanitizeScenarioParams(stored) };
}

export interface ChatNames {
    char: string;
    user: string;
}

/** `{{char}}` and `{{user}}` (any case) → the names; other macros stay. */
export function expandNames(text: string, names: ChatNames): string {
    return text.replace(/\{\{\s*(char|user)\s*\}\}/gi, (_match, which: string) =>
        which.toLowerCase() === 'char' ? names.char : names.user,
    );
}

/** Request parameters of one generation; undefined when the scenario changes none. */
export function requestParams(values: ScenarioParamValues, names: ChatNames): ScenarioParams | undefined {
    const params: ScenarioParams = {};
    if (values.max_tokens !== undefined) params.max_tokens = values.max_tokens;
    if (values.temperature !== undefined) params.temperature = values.temperature;
    if (values.stop !== undefined) {
        params.stop = values.stop.map((item) => expandNames(item, names)).filter((item) => item.length > 0);
    }
    if (values.reasoning === 'off') params.reasoning = 'off';
    return Object.keys(params).length ? params : undefined;
}

/** The scenario replaces the prompt with its own messages. */
export function hasCustomMessages(values: ScenarioParamValues): boolean {
    return !!values.messages?.some((message) => message.content.trim() !== '');
}

export interface ChatLike {
    mes?: unknown;
    is_user?: unknown;
    is_system?: unknown;
}

/** The last `limit` visible chat messages as prompt messages (hidden ones skipped), oldest first. */
export function chatExcerpt(
    chat: readonly ChatLike[],
    limit: number,
    options: { skipLast?: boolean } = {},
): PromptMessage[] {
    const end = options.skipLast ? chat.length - 1 : chat.length;
    const result: PromptMessage[] = [];
    for (let i = end - 1; i >= 0 && result.length < limit; i--) {
        const message = chat[i];
        if (!message || message.is_system === true || typeof message.mes !== 'string' || !message.mes.trim()) continue;
        result.push({ role: message.is_user === true ? 'user' : 'assistant', content: message.mes });
    }
    return result.reverse();
}

/**
 * Index of the continued message in ST's prompt: the last message that contains the end of the continued text
 * (ST may prefix the name and append `continue_postfix`); -1 when it is not found.
 */
export function continuedIndex(original: readonly PromptMessage[], continued: string): number {
    const text = continued.trim();
    if (!text) return -1;
    const probe = text.slice(-Math.min(120, text.length));
    for (let i = original.length - 1; i >= 0; i--) {
        if (original[i]?.content.includes(probe)) return i;
    }
    return -1;
}

/** Expands `{{history}}` lines and applies `substitute` to the other messages; empty results are dropped. */
export function expandCustomMessages(
    template: readonly PromptMessage[],
    history: readonly PromptMessage[],
    substitute: (text: string) => string,
): PromptMessage[] {
    const result: PromptMessage[] = [];
    for (const message of template) {
        if (message.content.trim() === HISTORY_PLACEHOLDER) {
            result.push(...history.map((item) => ({ ...item })));
            continue;
        }
        const content = substitute(message.content);
        if (content.trim()) result.push({ role: message.role, content });
    }
    return result;
}
