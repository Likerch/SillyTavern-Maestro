// Body keys the Preset Studio's «Параметры» tab edits (research/parity-preset.md §4.2, P-085…P-092), by preset key
// (`temperature`, not the settings key `temp_openai`, P-085). Limits are ST's own (index.html). Connection keys
// (P-094) and `extensions` (P-150) are not here: they stay with ST's drawer and their owners.

export type ParamGroup = 'samplers' | 'context' | 'reasoning' | 'misc';

export const PARAM_GROUPS: readonly ParamGroup[] = ['samplers', 'context', 'reasoning', 'misc'];

interface BaseSpec {
    key: string;
    group: ParamGroup;
}

export type ParamSpec =
    | (BaseSpec & { type: 'number'; min: number; max: number; step: number; integer?: boolean })
    | (BaseSpec & { type: 'boolean' })
    | (BaseSpec & { type: 'select'; options: readonly (string | number)[] })
    | (BaseSpec & { type: 'text' | 'textarea' });

const num = (key: string, group: ParamGroup, min: number, max: number, step: number, integer = false): ParamSpec => ({
    key,
    group,
    type: 'number',
    min,
    max,
    step,
    integer,
});

export const PARAMS: readonly ParamSpec[] = [
    num('temperature', 'samplers', 0, 2, 0.01),
    num('frequency_penalty', 'samplers', -2, 2, 0.01),
    num('presence_penalty', 'samplers', -2, 2, 0.01),
    num('top_p', 'samplers', 0, 1, 0.01),
    num('top_k', 'samplers', 0, 500, 1, true),
    num('top_a', 'samplers', 0, 1, 0.001),
    num('min_p', 'samplers', 0, 1, 0.001),
    num('repetition_penalty', 'samplers', 1, 2, 0.01),
    num('seed', 'samplers', -1, 2147483647, 1, true),
    num('n', 'samplers', 1, 16, 1, true),
    num('openai_max_context', 'context', 512, 4_000_000, 1, true),
    num('openai_max_tokens', 'context', 1, 1_000_000, 1, true),
    { key: 'max_context_unlocked', group: 'context', type: 'boolean' },
    { key: 'stream_openai', group: 'context', type: 'boolean' },
    { key: 'show_thoughts', group: 'reasoning', type: 'boolean' },
    {
        key: 'reasoning_effort',
        group: 'reasoning',
        type: 'select',
        options: ['auto', 'min', 'low', 'medium', 'high', 'max'],
    },
    { key: 'verbosity', group: 'reasoning', type: 'select', options: ['auto', 'low', 'medium', 'high'] },
    { key: 'function_calling', group: 'reasoning', type: 'boolean' },
    num('tool_call_recurse_limit', 'reasoning', 1, 50, 1, true),
    { key: 'enable_web_search', group: 'reasoning', type: 'boolean' },
    { key: 'request_images', group: 'reasoning', type: 'boolean' },
    { key: 'names_behavior', group: 'misc', type: 'select', options: [-1, 0, 1, 2] },
    { key: 'squash_system_messages', group: 'misc', type: 'boolean' },
    { key: 'continue_prefill', group: 'misc', type: 'boolean' },
    { key: 'continue_postfix', group: 'misc', type: 'select', options: ['', ' ', '\n', '\n\n'] },
    { key: 'use_sysprompt', group: 'misc', type: 'boolean' },
    { key: 'assistant_prefill', group: 'misc', type: 'textarea' },
    { key: 'assistant_impersonation', group: 'misc', type: 'textarea' },
    { key: 'wi_format', group: 'misc', type: 'text' },
    { key: 'scenario_format', group: 'misc', type: 'text' },
    { key: 'personality_format', group: 'misc', type: 'text' },
    { key: 'impersonation_prompt', group: 'misc', type: 'textarea' },
    { key: 'new_chat_prompt', group: 'misc', type: 'textarea' },
    { key: 'new_group_chat_prompt', group: 'misc', type: 'textarea' },
    { key: 'new_example_chat_prompt', group: 'misc', type: 'textarea' },
    { key: 'continue_nudge_prompt', group: 'misc', type: 'textarea' },
    { key: 'group_nudge_prompt', group: 'misc', type: 'textarea' },
    { key: 'send_if_empty', group: 'misc', type: 'textarea' },
];

export function paramsOf(group: ParamGroup): ParamSpec[] {
    return PARAMS.filter((spec) => spec.group === group);
}

export function paramSpec(key: string): ParamSpec | undefined {
    return PARAMS.find((spec) => spec.key === key);
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false; error: 'notNumber' | 'range' | 'option' };

/** A form value → the stored value with ST's type and limits. */
export function coerceParam(spec: ParamSpec, raw: string | boolean): CoerceResult {
    switch (spec.type) {
        case 'boolean':
            return { ok: true, value: raw === true || raw === 'true' };
        case 'number': {
            const text = String(raw).trim().replace(',', '.');
            const value = text === '' ? NaN : Number(text);
            if (!Number.isFinite(value)) return { ok: false, error: 'notNumber' };
            if (value < spec.min || value > spec.max) return { ok: false, error: 'range' };
            return { ok: true, value: spec.integer ? Math.round(value) : value };
        }
        case 'select': {
            const match = spec.options.find((option) => String(option) === String(raw));
            return match === undefined ? { ok: false, error: 'option' } : { ok: true, value: match };
        }
        default:
            return { ok: true, value: String(raw) };
    }
}

/** How a select option is labelled when its value is whitespace (continue_postfix). */
export function optionKey(value: string | number): string {
    if (value === '') return 'none';
    if (value === ' ') return 'space';
    if (value === '\n') return 'newline';
    if (value === '\n\n') return 'doubleNewline';
    return String(value);
}

/**
 * Connection keys of a Chat Completion preset (P-094, OAI:306-407 with the «connection» flag): source, models,
 * addresses, provider routing. A migration from a reference file may turn them into layer operations; the studio
 * shows them apart and unticked.
 */
export const CONNECTION_KEYS: ReadonlySet<string> = new Set([
    'chat_completion_source',
    'openai_model',
    'claude_model',
    'openrouter_model',
    'ai21_model',
    'mistralai_model',
    'cohere_model',
    'perplexity_model',
    'groq_model',
    'chutes_model',
    'siliconflow_model',
    'minimax_model',
    'electronhub_model',
    'nanogpt_model',
    'deepseek_model',
    'aimlapi_model',
    'xai_model',
    'pollinations_model',
    'moonshot_model',
    'fireworks_model',
    'cometapi_model',
    'custom_model',
    'google_model',
    'vertexai_model',
    'zai_model',
    'workers_ai_model',
    'azure_openai_model',
    'custom_url',
    'siliconflow_endpoint',
    'minimax_endpoint',
    'pollinations_endpoint',
    'zai_endpoint',
    'azure_base_url',
    'azure_deployment_name',
    'azure_api_version',
    'vertexai_auth_mode',
    'vertexai_region',
    'vertexai_express_project_id',
    'workers_ai_account_id',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'custom_prompt_post_processing',
    'openrouter_use_fallback',
    'openrouter_providers',
    'openrouter_quantizations',
    'openrouter_allow_fallbacks',
    'openrouter_middleout',
    'nanogpt_provider',
    'nanogpt_payg_override',
    'reverse_proxy',
    'proxy_password',
    'group_models',
    'sort_models',
    'show_external_models',
    'bypass_status_check',
]);

export function isConnectionKey(key: string): boolean {
    return CONNECTION_KEYS.has(key);
}

/** Stop strings as editable lines: one per line, a line break inside a stop written as `\n` (and `\` as `\\`). */
export function stopsToText(stops: readonly string[]): string {
    return stops.map((stop) => stop.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')).join('\n');
}

/** The inverse of stopsToText; empty lines are dropped. */
export function textToStops(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line !== '')
        .map((line) => line.replace(/\\(\\|n)/g, (_match, escaped: string) => (escaped === 'n' ? '\n' : '\\')));
}
