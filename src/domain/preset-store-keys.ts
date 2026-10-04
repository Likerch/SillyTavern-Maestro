// Body keys of a Chat Completion preset (Preset Studio data layer, M34, stage 5). ST 1.19 maps every preset key to a
// settings key and a UI control in `settingsToUpdate` (openai.js:305-409, research/parity-preset.md §4.2): eight
// samplers are named differently in the file (`temperature`) and in `oai_settings` (`temp_openai`). The live table
// is read from openai.js when it is there; PRESET_KEY_TABLE is a copy for an ST whose export is missing.
// Also: the sensitive keys ST asks about on import/export (openai.js:287-299, P-096), the type normalisation ST's
// input handlers apply, and the preset-name rules of the server (sanitize-filename) and of the rename dialog
// (equalsIgnoreCaseAndAccents). Pure: no DOM, network or SillyTavern.

type Dict = Record<string, unknown>;

/** `[selector, settingsKey, isCheckbox, isConnection]` — the shape of ST's settingsToUpdate values. */
export type KeySpec = readonly [selector: string, setting: string, checkbox: boolean, connection: boolean];

export type KeyTable = Readonly<Record<string, KeySpec>>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copy of ST 1.19 `settingsToUpdate` (openai.js:305-409), 103 keys. */
export const PRESET_KEY_TABLE: KeyTable = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    temperature: ['#temp_openai', 'temp_openai', false, false],
    frequency_penalty: ['#freq_pen_openai', 'freq_pen_openai', false, false],
    presence_penalty: ['#pres_pen_openai', 'pres_pen_openai', false, false],
    top_p: ['#top_p_openai', 'top_p_openai', false, false],
    top_k: ['#top_k_openai', 'top_k_openai', false, false],
    top_a: ['#top_a_openai', 'top_a_openai', false, false],
    min_p: ['#min_p_openai', 'min_p_openai', false, false],
    repetition_penalty: ['#repetition_penalty_openai', 'repetition_penalty_openai', false, false],
    max_context_unlocked: ['#oai_max_context_unlocked', 'max_context_unlocked', true, false],
    group_models: ['#cc_group_models', 'group_models', true, true],
    sort_models: ['#cc_sort_models', 'sort_models', false, true],
    openai_model: ['#model_openai_select', 'openai_model', false, true],
    claude_model: ['#model_claude_select', 'claude_model', false, true],
    openrouter_model: ['#model_openrouter_select', 'openrouter_model', false, true],
    openrouter_use_fallback: ['#openrouter_use_fallback', 'openrouter_use_fallback', true, true],
    openrouter_providers: ['#openrouter_providers_chat', 'openrouter_providers', false, true],
    openrouter_quantizations: ['#openrouter_quantizations_chat', 'openrouter_quantizations', false, true],
    openrouter_allow_fallbacks: ['#openrouter_allow_fallbacks', 'openrouter_allow_fallbacks', true, true],
    openrouter_middleout: ['#openrouter_middleout', 'openrouter_middleout', false, true],
    tool_reasoning_mode: ['#tool_reasoning_mode', 'tool_reasoning_mode', false, false],
    ai21_model: ['#model_ai21_select', 'ai21_model', false, true],
    mistralai_model: ['#model_mistralai_select', 'mistralai_model', false, true],
    cohere_model: ['#model_cohere_select', 'cohere_model', false, true],
    perplexity_model: ['#model_perplexity_select', 'perplexity_model', false, true],
    groq_model: ['#model_groq_select', 'groq_model', false, true],
    chutes_model: ['#model_chutes_select', 'chutes_model', false, true],
    siliconflow_model: ['#model_siliconflow_select', 'siliconflow_model', false, true],
    siliconflow_endpoint: ['#siliconflow_endpoint', 'siliconflow_endpoint', false, true],
    minimax_model: ['#model_minimax_select', 'minimax_model', false, true],
    minimax_endpoint: ['#minimax_endpoint', 'minimax_endpoint', false, true],
    electronhub_model: ['#model_electronhub_select', 'electronhub_model', false, true],
    nanogpt_model: ['#model_nanogpt_select', 'nanogpt_model', false, true],
    nanogpt_provider: ['#nanogpt_provider', 'nanogpt_provider', false, true],
    nanogpt_payg_override: ['#nanogpt_payg_override', 'nanogpt_payg_override', true, true],
    deepseek_model: ['#model_deepseek_select', 'deepseek_model', false, true],
    aimlapi_model: ['#model_aimlapi_select', 'aimlapi_model', false, true],
    xai_model: ['#model_xai_select', 'xai_model', false, true],
    pollinations_model: ['#model_pollinations_select', 'pollinations_model', false, true],
    pollinations_endpoint: ['#pollinations_endpoint', 'pollinations_endpoint', false, true],
    moonshot_model: ['#model_moonshot_select', 'moonshot_model', false, true],
    fireworks_model: ['#model_fireworks_select', 'fireworks_model', false, true],
    cometapi_model: ['#model_cometapi_select', 'cometapi_model', false, true],
    custom_model: ['#custom_model_id', 'custom_model', false, true],
    custom_url: ['#custom_api_url_text', 'custom_url', false, true],
    custom_include_body: ['#custom_include_body', 'custom_include_body', false, true],
    custom_exclude_body: ['#custom_exclude_body', 'custom_exclude_body', false, true],
    custom_include_headers: ['#custom_include_headers', 'custom_include_headers', false, true],
    custom_prompt_post_processing: ['#custom_prompt_post_processing', 'custom_prompt_post_processing', false, true],
    google_model: ['#model_google_select', 'google_model', false, true],
    vertexai_model: ['#model_vertexai_select', 'vertexai_model', false, true],
    zai_model: ['#model_zai_select', 'zai_model', false, true],
    zai_endpoint: ['#zai_endpoint', 'zai_endpoint', false, true],
    workers_ai_model: ['#model_workers_ai_select', 'workers_ai_model', false, true],
    workers_ai_account_id: ['#workers_ai_account_id', 'workers_ai_account_id', false, true],
    openai_max_context: ['#openai_max_context', 'openai_max_context', false, false],
    openai_max_tokens: ['#openai_max_tokens', 'openai_max_tokens', false, false],
    names_behavior: ['#names_behavior', 'names_behavior', false, false],
    send_if_empty: ['#send_if_empty_textarea', 'send_if_empty', false, false],
    impersonation_prompt: ['#impersonation_prompt_textarea', 'impersonation_prompt', false, false],
    new_chat_prompt: ['#newchat_prompt_textarea', 'new_chat_prompt', false, false],
    new_group_chat_prompt: ['#newgroupchat_prompt_textarea', 'new_group_chat_prompt', false, false],
    new_example_chat_prompt: ['#newexamplechat_prompt_textarea', 'new_example_chat_prompt', false, false],
    continue_nudge_prompt: ['#continue_nudge_prompt_textarea', 'continue_nudge_prompt', false, false],
    bias_preset_selected: ['#openai_logit_bias_preset', 'bias_preset_selected', false, false],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
    wi_format: ['#wi_format_textarea', 'wi_format', false, false],
    scenario_format: ['#scenario_format_textarea', 'scenario_format', false, false],
    personality_format: ['#personality_format_textarea', 'personality_format', false, false],
    group_nudge_prompt: ['#group_nudge_prompt_textarea', 'group_nudge_prompt', false, false],
    stream_openai: ['#stream_toggle', 'stream_openai', true, false],
    prompts: ['', 'prompts', false, false],
    prompt_order: ['', 'prompt_order', false, false],
    show_external_models: ['#openai_show_external_models', 'show_external_models', true, true],
    proxy_password: ['#openai_proxy_access_key', 'proxy_password', false, true],
    assistant_prefill: ['#claude_assistant_prefill', 'assistant_prefill', false, false],
    assistant_impersonation: ['#claude_assistant_impersonation', 'assistant_impersonation', false, false],
    use_sysprompt: ['#use_sysprompt', 'use_sysprompt', true, false],
    vertexai_auth_mode: ['#vertexai_auth_mode', 'vertexai_auth_mode', false, true],
    vertexai_region: ['#vertexai_region', 'vertexai_region', false, true],
    vertexai_express_project_id: ['#vertexai_express_project_id', 'vertexai_express_project_id', false, true],
    squash_system_messages: ['#squash_system_messages', 'squash_system_messages', true, false],
    media_inlining: ['#openai_media_inlining', 'media_inlining', true, false],
    inline_image_quality: ['#openai_inline_image_quality', 'inline_image_quality', false, false],
    continue_prefill: ['#continue_prefill', 'continue_prefill', true, false],
    continue_postfix: ['#continue_postfix', 'continue_postfix', false, false],
    function_calling: ['#openai_function_calling', 'function_calling', true, false],
    tool_call_recurse_limit: ['#tool_call_recurse_limit', 'tool_call_recurse_limit', false, false],
    show_thoughts: ['#openai_show_thoughts', 'show_thoughts', true, false],
    reasoning_effort: ['#openai_reasoning_effort', 'reasoning_effort', false, false],
    verbosity: ['#openai_verbosity', 'verbosity', false, false],
    enable_web_search: ['#openai_enable_web_search', 'enable_web_search', true, false],
    seed: ['#seed_openai', 'seed', false, false],
    n: ['#n_openai', 'n', false, false],
    bypass_status_check: ['#openai_bypass_status_check', 'bypass_status_check', true, true],
    request_images: ['#openai_request_images', 'request_images', true, false],
    request_image_aspect_ratio: ['#request_image_aspect_ratio', 'request_image_aspect_ratio', false, false],
    request_image_resolution: ['#request_image_resolution', 'request_image_resolution', false, false],
    azure_base_url: ['#azure_base_url', 'azure_base_url', false, true],
    azure_deployment_name: ['#azure_deployment_name', 'azure_deployment_name', false, true],
    azure_api_version: ['#azure_api_version', 'azure_api_version', false, true],
    azure_openai_model: ['#azure_openai_model', 'azure_openai_model', false, true],
    extensions: ['#NULL_SELECTOR', 'extensions', false, false],
};

/** Keys ST asks about before import and export (openai.js:287-299 `sensitiveFields`, P-096). */
export const SENSITIVE_PRESET_KEYS = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
] as const;

/** Keys the studio handles through Prompt Manager, never through setKeys(). */
export const PROMPT_KEYS = ['prompts', 'prompt_order'] as const;

/** Selectors that are not real UI controls (`''` for prompts, `#NULL_SELECTOR` for extensions). */
export function hasControl(spec: KeySpec): boolean {
    return spec[0] !== '' && spec[0] !== '#NULL_SELECTOR';
}

function isKeySpec(value: unknown): value is KeySpec {
    return (
        Array.isArray(value) &&
        value.length >= 4 &&
        typeof value[0] === 'string' &&
        typeof value[1] === 'string' &&
        value[1] !== '' &&
        typeof value[2] === 'boolean' &&
        typeof value[3] === 'boolean'
    );
}

/** The live `settingsToUpdate` when it looks like ST's table (its entries win), otherwise the copy. */
export function readKeyTable(live: unknown): KeyTable {
    if (!isDict(live)) return PRESET_KEY_TABLE;
    const table: Record<string, KeySpec> = {};
    for (const [key, value] of Object.entries(live)) {
        if (isKeySpec(value)) table[key] = [value[0], value[1], value[2], value[3]];
    }
    return Object.keys(table).length ? table : PRESET_KEY_TABLE;
}

/** Preset keys flagged as connection data (exported only on request, P-070/P-094). */
export function connectionKeys(table: KeyTable): string[] {
    return Object.entries(table)
        .filter(([, spec]) => spec[3])
        .map(([key]) => key);
}

/** JSON copy without undefined values (what /api/presets/save would store). */
export function jsonClean<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The preset body of a settings object, like openai.js getChatCompletionPreset (OAI:4582-4588), but as JSON:
 * keys whose setting is undefined are left out (a spread of such a body would otherwise erase cached values).
 */
export function bodyFromSettings(settings: Dict, table: KeyTable = PRESET_KEY_TABLE): Dict {
    const body: Dict = {};
    for (const [key, spec] of Object.entries(table)) {
        const value = settings[spec[1]];
        if (value !== undefined) body[key] = value;
    }
    return jsonClean(body);
}

/** A copy of `body` without `keys`. */
export function withoutKeys(body: Dict, keys: readonly string[]): Dict {
    const copy: Dict = { ...body };
    for (const key of keys) delete copy[key];
    return copy;
}

/** The values of `keys` that `body` holds (undefined ones are skipped). */
export function pickKeys(body: Dict | null | undefined, keys: readonly string[]): Dict {
    const picked: Dict = {};
    if (!body) return picked;
    for (const key of keys) if (body[key] !== undefined) picked[key] = body[key];
    return picked;
}

/** Sensitive keys that carry a value (ST asks only about those). */
export function presentSensitiveKeys(body: Dict): string[] {
    return SENSITIVE_PRESET_KEYS.filter((key) => Boolean(body[key]));
}

function numeric(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * A value for a settings key, typed like ST's input handlers type it: checkboxes become booleans (`'false'` is
 * false), numeric settings stay numbers when the new value is numeric. Anything else is copied as JSON.
 */
export function normalizeKeyValue(value: unknown, current: unknown, checkbox: boolean): unknown {
    if (checkbox) {
        if (typeof value === 'string') return !['', 'false', 'off', '0'].includes(value.trim().toLowerCase());
        return Boolean(value);
    }
    if (typeof current === 'number') {
        const parsed = numeric(value);
        if (parsed !== null) return parsed;
    }
    return jsonClean(value);
}

/* ------------------------------------------------------------------ preset names */

const ILLEGAL_RE = /[/?<>\\:*|"]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED_RE = /^\.+$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_TRAILING_RE = /[. ]+$/;
const MAX_NAME_BYTES = 255;

function utf8Length(codePoint: number): number {
    if (codePoint < 0x80) return 1;
    if (codePoint < 0x800) return 2;
    if (codePoint < 0x10000) return 3;
    return 4;
}

/** What the server's sanitize-filename does to a preset name (src/endpoints/presets.js; the server answer wins). */
export function sanitizePresetName(name: string): string {
    const cleaned = name
        .replace(ILLEGAL_RE, '')
        .replace(CONTROL_RE, '')
        .replace(RESERVED_RE, '')
        .replace(WINDOWS_RESERVED_RE, '')
        .replace(WINDOWS_TRAILING_RE, '');
    let bytes = 0;
    let result = '';
    for (const char of cleaned) {
        bytes += utf8Length(char.codePointAt(0) ?? 0);
        if (bytes > MAX_NAME_BYTES) break;
        result += char;
    }
    return result;
}

function folded(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** ST's equalsIgnoreCaseAndAccents (utils.js:2243-2276): file names that collide on case-insensitive disks. */
export function sameNameLoosely(a: string, b: string): boolean {
    if (!a || !b) return a === b;
    return folded(a) === folded(b);
}

/** The existing name that collides with `name` (exact match first, then case/accents), or null. */
export function collidingName(names: readonly string[], name: string, except?: string): string | null {
    if (names.includes(name) && name !== except) return name;
    return names.find((item) => item !== except && sameNameLoosely(item, name)) ?? null;
}
