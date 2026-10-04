// Provider and model hints of the Preset Studio (M34 п.3, п.9), pure: which connection is active (Chat Completion
// source + model, read from oai_settings) and what the preset should keep in mind for it. A small table, extended by
// hand. Facts from ST 1.19 sources (openai.js getReasoningEffort/createGenerationParameters,
// endpoints/backends/chat-completions.js): through OpenRouter ST sends `reasoning: {exclude: !show_thoughts,
// effort}` — «Request model reasoning» off only hides the reasoning; effort Minimum with it off is sent as 'none'
// (reasoning off); Auto sends no effort. DeepSeek's own API gets `thinking: enabled|disabled` from show_thoughts and
// a final assistant message as a prefix. User's live notes (DeepSeek V4 via OpenRouter): an assistant prefill at the
// end is closed by EOS (the reply ends at once); system messages in the middle of the history are merged into the
// neighbouring turns by the provider. Temperature ranges are a starting point to verify live.

export type ModelQuirk =
    /** An assistant message at the end (prefill) is closed by EOS: the reply comes back empty. */
    | 'prefillEos'
    /** System messages inside the history are merged into the neighbouring turns. */
    | 'systemMerge'
    /** Assistant messages injected at a depth read as the model's own earlier replies. */
    | 'assistantDepth';

export interface ModelProfile {
    id: string;
    label: string;
    match: RegExp;
    /** Quirks by Chat Completion source; '*' applies to every source. */
    quirks: Partial<Record<string, readonly ModelQuirk[]>>;
    /** Starting temperature ranges: through a router that passes the value as is, and DeepSeek's own API scale. */
    temperature: { routed: [number, number]; direct: [number, number] };
    /** Reasoning can be switched on and off. */
    reasoningOptional: boolean;
}

export const MODEL_PROFILES: readonly ModelProfile[] = [
    {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        match: /deepseek[-_./]?v4[-_.]?pro/i,
        quirks: { openrouter: ['prefillEos', 'systemMerge', 'assistantDepth'], '*': ['systemMerge', 'assistantDepth'] },
        temperature: { routed: [0.6, 1.0], direct: [1.0, 1.5] },
        reasoningOptional: true,
    },
    {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        match: /deepseek[-_./]?v4(?![-_.]?pro)/i,
        quirks: { openrouter: ['prefillEos', 'systemMerge', 'assistantDepth'], '*': ['systemMerge', 'assistantDepth'] },
        temperature: { routed: [0.6, 1.0], direct: [1.0, 1.5] },
        reasoningOptional: true,
    },
];

/** oai_settings key of the model, by `chat_completion_source` (openai.js getChatCompletionModel). */
const MODEL_KEYS: Record<string, string> = {
    openai: 'openai_model',
    claude: 'claude_model',
    makersuite: 'google_model',
    vertexai: 'vertexai_model',
    openrouter: 'openrouter_model',
    ai21: 'ai21_model',
    mistralai: 'mistralai_model',
    custom: 'custom_model',
    cohere: 'cohere_model',
    perplexity: 'perplexity_model',
    groq: 'groq_model',
    siliconflow: 'siliconflow_model',
    minimax: 'minimax_model',
    electronhub: 'electronhub_model',
    chutes: 'chutes_model',
    nanogpt: 'nanogpt_model',
    deepseek: 'deepseek_model',
    aimlapi: 'aimlapi_model',
    xai: 'xai_model',
    pollinations: 'pollinations_model',
    cometapi: 'cometapi_model',
    moonshot: 'moonshot_model',
    fireworks: 'fireworks_model',
    azure_openai: 'azure_openai_model',
    zai: 'zai_model',
    workers_ai: 'workers_ai_model',
};

/** OpenRouter's "use the website's model" placeholder. */
const OPENROUTER_WEBSITE_MODEL = 'OR_Website';

export interface ConnectionInfo {
    source: string;
    /** '' when unknown. */
    model: string;
    reasoningEffort: string;
    showThoughts: boolean;
    temperature: number | null;
    /** OpenRouter provider order (empty = OpenRouter routes freely). */
    providers: string[];
    continuePrefill: boolean;
}

type Dict = Record<string, unknown>;

/** The active Chat Completion connection from `oai_settings`; null when there is none. */
export function connectionFrom(settings: Dict | null | undefined): ConnectionInfo | null {
    if (!settings || typeof settings.chat_completion_source !== 'string' || !settings.chat_completion_source) {
        return null;
    }
    const source = settings.chat_completion_source;
    const key = MODEL_KEYS[source];
    const raw = key ? settings[key] : undefined;
    const model = typeof raw === 'string' && raw !== OPENROUTER_WEBSITE_MODEL ? raw : '';
    const temperature = Number(settings.temp_openai);
    return {
        source,
        model,
        reasoningEffort: typeof settings.reasoning_effort === 'string' ? settings.reasoning_effort : 'auto',
        showThoughts: settings.show_thoughts === true,
        temperature: settings.temp_openai === undefined || !Number.isFinite(temperature) ? null : temperature,
        providers: Array.isArray(settings.openrouter_providers)
            ? settings.openrouter_providers.filter((item): item is string => typeof item === 'string')
            : [],
        continuePrefill: settings.continue_prefill === true,
    };
}

export function modelProfile(model: string): ModelProfile | null {
    if (!model) return null;
    return MODEL_PROFILES.find((profile) => profile.match.test(model)) ?? null;
}

/** Quirks of the connection's model on its source. */
export function modelQuirks(connection: ConnectionInfo | null): Set<ModelQuirk> {
    const profile = connection ? modelProfile(connection.model) : null;
    if (!connection || !profile) return new Set();
    return new Set([...(profile.quirks['*'] ?? []), ...(profile.quirks[connection.source] ?? [])]);
}

/** One hint line: the feature translates `key` with `params` (i18n `m34.an.hint.<key>`). */
export interface HintLine {
    model: string;
    key: string;
    params?: Record<string, string | number>;
}

function reasoningHint(connection: ConnectionInfo, model: string): HintLine {
    if (connection.source === 'openrouter') {
        if (connection.reasoningEffort === 'min' && !connection.showThoughts) return { model, key: 'reasoningOff' };
        if (connection.reasoningEffort === 'auto') return { model, key: 'reasoningAuto' };
        if (!connection.showThoughts) {
            return { model, key: 'reasoningHiddenOnly', params: { effort: connection.reasoningEffort } };
        }
        return { model, key: 'reasoningOn', params: { effort: connection.reasoningEffort } };
    }
    if (connection.source === 'deepseek') {
        return { model, key: connection.showThoughts ? 'thinkingOnDirect' : 'thinkingOffDirect' };
    }
    return { model, key: 'reasoningOther' };
}

/** Hints for the active connection, most important first. */
export function providerHints(connection: ConnectionInfo | null): HintLine[] {
    if (!connection) return [];
    const lines: HintLine[] = [];
    const profile = modelProfile(connection.model);
    const model = connection.model || connection.source;
    if (profile) {
        const quirks = modelQuirks(connection);
        if (profile.reasoningOptional) lines.push(reasoningHint(connection, model));
        if (quirks.has('prefillEos')) {
            lines.push({ model, key: connection.continuePrefill ? 'prefillEosContinue' : 'prefillEos' });
        } else if (connection.source === 'deepseek') lines.push({ model, key: 'prefillDirect' });
        if (quirks.has('systemMerge')) lines.push({ model, key: 'systemMerge' });
        if (quirks.has('assistantDepth')) lines.push({ model, key: 'assistantDepth' });
        const direct = connection.source === 'deepseek';
        const [min, max] = direct ? profile.temperature.direct : profile.temperature.routed;
        const params: Record<string, string | number> = { min, max, model: profile.label };
        if (connection.temperature !== null) params.current = connection.temperature;
        const outside =
            connection.temperature !== null && (connection.temperature < min || connection.temperature > max);
        lines.push({
            model,
            key: outside ? 'temperatureOutside' : direct ? 'temperatureDirect' : 'temperature',
            params,
        });
    }
    if (connection.source === 'openrouter' && !connection.providers.length) {
        lines.push({ model: 'openrouter', key: 'openrouterProvider' });
    }
    return lines;
}
