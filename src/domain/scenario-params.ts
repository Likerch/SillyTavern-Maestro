// Pure parts of the generation-scenario engine (M34 п. 7): turning a scenario plan into Chat Completion
// messages and applying its per-request parameters to ST's request body. See research/parity-preset.md
// P-123…P-128 and §10.4 (г): the prompt is replaced in place, the body is edited in place, `stream` never changes.

export type PromptRole = 'system' | 'user' | 'assistant';

export interface PromptMessage {
    role: PromptRole;
    content: string;
}

/** Per-request parameters a scenario may set (keys of ST's `generate_data`, OAI:2803-2827). */
export interface ScenarioParams {
    max_tokens?: number;
    temperature?: number;
    /** An empty array removes ST's stop strings; undefined leaves them as they are. */
    stop?: string[];
    reasoning_effort?: string;
    include_reasoning?: boolean;
    /**
     * 'off' turns reasoning off for this request: `include_reasoning: false` everywhere (DeepSeek's own API: thinking
     * disabled) and, through OpenRouter, `reasoning_effort: 'none'` — what ST itself sends for effort Minimum with
     * «Request model reasoning» off (openai.js getReasoningEffort). Wins over the two keys above.
     */
    reasoning?: 'off';
}

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant']);

/** Text of a Chat Completion `content`: a string, or the text parts of a multimodal array. */
export function promptText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
                    return (part as { text: string }).text;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

/** A role ST's prompt may hold, mapped onto the three plain roles (tool results read as user turns). */
export function promptRole(role: unknown): PromptRole {
    if (typeof role === 'string' && ROLES.has(role)) return role as PromptRole;
    return role === 'tool' ? 'user' : 'system';
}

/**
 * Fresh `{role, content}` objects for the prompt. Messages with empty text are dropped: ST drops them on output
 * anyway (P-117) and some providers reject them.
 */
export function toPromptMessages(messages: readonly { role: unknown; content: unknown }[]): PromptMessage[] {
    const result: PromptMessage[] = [];
    for (const message of messages) {
        const content = promptText(message?.content);
        if (!content.trim()) continue;
        result.push({ role: promptRole(message?.role), content });
    }
    return result;
}

/** Read-only copy of ST's assembled prompt for a scenario's `build()`. */
export function snapshotPrompt(chat: readonly unknown[]): PromptMessage[] {
    return chat.map((entry) => {
        const message = (entry && typeof entry === 'object' ? entry : {}) as { role?: unknown; content?: unknown };
        return Object.freeze({ role: promptRole(message.role), content: promptText(message.content) });
    });
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Applies a scenario's parameters to ST's request body in place and returns the keys it changed.
 * `stream` and the source are never touched: ST parses the reply with a local `stream` computed earlier
 * (OAI:2785, 3160; P-128).
 */
export function applyScenarioParams(data: Record<string, unknown>, params: ScenarioParams | undefined): string[] {
    if (!params) return [];
    const changed: string[] = [];
    const set = (key: string, value: unknown): void => {
        if (data[key] === value) return;
        data[key] = value;
        if (!changed.includes(key)) changed.push(key);
    };
    if (finiteNumber(params.max_tokens) && params.max_tokens > 0) set('max_tokens', Math.floor(params.max_tokens));
    if (finiteNumber(params.temperature) && params.temperature >= 0) set('temperature', params.temperature);
    if (Array.isArray(params.stop)) {
        const stop = params.stop.filter((item): item is string => typeof item === 'string' && item.length > 0);
        if (stop.length) set('stop', stop);
        else if ('stop' in data) {
            delete data.stop;
            changed.push('stop');
        }
    }
    if (typeof params.reasoning_effort === 'string' && params.reasoning_effort) {
        set('reasoning_effort', params.reasoning_effort);
    }
    if (typeof params.include_reasoning === 'boolean') set('include_reasoning', params.include_reasoning);
    if (params.reasoning === 'off') {
        if (data.chat_completion_source === 'openrouter') set('reasoning_effort', 'none');
        set('include_reasoning', false);
    }
    return changed;
}
