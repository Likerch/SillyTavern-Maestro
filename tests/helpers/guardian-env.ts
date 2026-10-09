// Stand for M4 tests: a fake settings.json on the "server" (POST /api/settings/get through the global fetch, and
// /api/settings/save through the fetch gate, which stores the body like ST's endpoint does), a tracked stack
// (preset and connection, regexes, Qvink, CK, NAI, DES, world info) with the content and play state M4 must leave
// alone, and helpers to simulate another tab.
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { FeatureEnv } from './medic-app';

type Dict = Record<string, unknown>;

export interface SettingsServer {
    /** settings.json on the server. */
    settings: Dict;
    gets: number;
    fail: boolean;
}

/** Answers POST /api/settings/get from `server.settings`; other requests go to the previous global fetch. */
export function installSettingsServer(env: FeatureEnv, initial: Dict = {}): SettingsServer {
    const server: SettingsServer = { settings: initial, gets: 0, fail: false };
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/settings/get')) {
            server.gets++;
            if (server.fail) return new Response('error', { status: 500 });
            return new Response(JSON.stringify({ settings: JSON.stringify(server.settings), world_names: [] }), {
                status: 200,
            });
        }
        return previous(input, init);
    }) as typeof fetch;
    // Behind the gate, /api/settings/save stores the body like endpoints/settings.js does.
    env.server.respond = (url: string) => {
        const last = env.server.requests.at(-1);
        if (url.includes('/api/settings/save') && typeof last?.init?.body === 'string') {
            server.settings = JSON.parse(last.init.body) as Dict;
        }
        return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    };
    return server;
}

/** The body ST's saveSettings() sends (the parts the guard compares). */
export function settingsPayload(env: FeatureEnv): Dict {
    const ctx = env.mock.context as unknown as Dict;
    return {
        extension_settings: env.mock.extensionSettings,
        power_user: ctx.powerUserSettings,
        oai_settings: ctx.chatCompletionSettings ?? {},
    };
}

/** ST saving settings from this tab (through the gate). */
export function stSave(env: FeatureEnv): Promise<Response> {
    return env.stFetch('/api/settings/save', { method: 'POST', body: JSON.stringify(settingsPayload(env)) });
}

/** Another tab saves: its stamp and a different power_user value land on the server. */
export function otherTabSaves(server: SettingsServer, seq = 1): void {
    const settings = structuredClone(server.settings);
    const ext = (settings.extension_settings ??= {}) as Dict;
    const maestro = (ext.maestro ??= {}) as Dict;
    const modules = (maestro.modules ??= {}) as Dict;
    const guardian = (modules.guardian ??= {}) as Dict;
    guardian.stamp = { tabId: 'other-tab', seq, at: 1 };
    settings.power_user = { ...((settings.power_user as Dict | undefined) ?? {}), theme: 'other' };
    server.settings = settings;
}

export interface TrackedStack {
    live: Dict & { prompts: Dict[]; prompt_order: Dict[] };
    storedPreset: Dict;
    wi: Dict;
    selected: string[];
    updateWorldInfoSettings: Mock;
    savePreset: Mock;
    selectPreset: Mock;
    render: Mock;
    regex: Dict;
}

/** Fills the mock with a stack the guardian tracks. */
export function trackedStack(env: FeatureEnv): TrackedStack {
    const ext = env.mock.extensionSettings;
    const regex = {
        id: 'r1',
        scriptName: 'Clean HTML',
        findRegex: '/<[^>]+>/g',
        replaceString: '',
        placement: [2],
        disabled: false,
        promptOnly: true,
        markdownOnly: false,
    };
    ext.regex = [structuredClone(regex)];
    // Qvink (index.js): the live top level is a copy of the chat's profile next to the global keys.
    ext.qvink_memory = {
        auto_summarize: true,
        prompt: 'Summarise',
        profile: 'Default',
        notify_on_profile_switch: false,
        global_toggle_state: true,
        character_profiles: {},
        disabled_group_characters: {},
        memory_edit_interface_settings: {},
        profiles: {
            Default: { auto_summarize: true, prompt: 'Summarise' },
            Short: { auto_summarize: false, prompt: 'Brief' },
        },
    };
    ext.CarrotKernel = {
        enabled: true,
        selectedLorebooks: ['Pack'],
        characterRepoBooks: ['Archive'],
        tagLibraries: ['Tags'],
        templates: { a: 'long template' },
        rag: { enabled: false, libraries: { global: { c: { h: { text: 'chunk' } } } } },
        scannedCache: { x: 1 },
    };
    ext.nai_studio = {
        generation: { model: 'nai-diffusion-4-5-full', steps: 23, prompt: 'a cat', ucPreset: 'heavy', seed: 7 },
        prompts: { prefix: 'best quality', activeStyle: 'Ink', styles: [{ name: 'Ink' }], characterPrompts: {} },
        inline: { saveToServer: true, insertMode: 'face', readingMode: false },
        markers: { enabled: true, depth: 1 },
        scene: { allowNsfw: false, framing: 'auto', camera: 'front', personaPassports: { me: { id: 'p1' } } },
        des: { enabled: true, saved: { autoPortraitMode: 'state_changed' }, legacyPortraits: { Kai: 'kai.png' } },
        vibes: { items: [1, 2, 3] },
    };
    ext.connectionManager = {
        selectedProfile: 'p1',
        profiles: [{ id: 'p1', name: 'Flash', api: 'openai', secret: 'x' }],
    };
    ext.disabledExtensions = [];
    env.adapters.des.settings = {
        enabled: true,
        generationMode: 'together',
        showInfoBox: true,
        quests: { main: 'Find the key' },
        historyPersistence: { enabled: false, messageCount: 5 },
        externalApiSettings: { baseUrl: 'http://tracker', apiKey: 'sk-tracker', model: 'small', maxTokens: 8192 },
        customTrackerPrompt: 'A long custom prompt',
        lorebook: { enabled: true, campaigns: { c1: {} } },
    };
    (env.mock.context as unknown as Dict).powerUserSettings = {
        instruct: { enabled: false, preset: 'Alpaca' },
        context: { preset: 'Default' },
        sysprompt: { enabled: true, name: 'Neutral - Chat' },
        reasoning: { name: 'DeepSeek', auto_parse: true, add_to_prompts: false },
    };
    const prompts = (): Dict[] => [
        { identifier: 'main', name: 'Main', role: 'system', content: 'Main prompt' },
        { identifier: 'chatHistory', marker: true },
        { identifier: 'jb', name: 'JB', role: 'system', content: 'Stay in character' },
    ];
    const live = {
        preset_settings_openai: 'Marinara',
        temp_openai: 1,
        proxy_password: 'secret',
        chat_completion_source: 'deepseek',
        deepseek_model: 'deepseek-v4-flash',
        openai_max_context: 65536,
        openai_max_tokens: 300,
        reasoning_effort: 'auto',
        show_thoughts: true,
        stream_openai: true,
        prompts: prompts(),
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                    { identifier: 'jb', enabled: true },
                ],
            },
        ],
    };
    (env.mock.context as unknown as Dict).chatCompletionSettings = live;
    const storedPreset: Dict = { temperature: 1, proxy_password: 'file-secret', reverse_proxy: 'http://proxy' };
    const savePreset = vi.fn(async () => {});
    const selectPreset = vi.fn(async () => {});
    const render = vi.fn();
    env.stModules.openai = {
        getChatCompletionPreset: () => ({
            temperature: live.temp_openai,
            proxy_password: live.proxy_password,
            reverse_proxy: 'http://proxy',
            chat_completion_source: live.chat_completion_source,
            deepseek_model: live.deepseek_model,
            openai_max_context: live.openai_max_context,
            openai_max_tokens: live.openai_max_tokens,
            reasoning_effort: live.reasoning_effort,
            show_thoughts: live.show_thoughts,
            stream_openai: live.stream_openai,
            prompts: structuredClone(live.prompts),
            prompt_order: structuredClone(live.prompt_order),
        }),
        openai_setting_names: { Marinara: 0 },
        openai_settings: [storedPreset],
        promptManager: { render },
    };
    env.stModules.presetManager = {
        getPresetManager: () => ({
            savePreset,
            selectPreset,
            findPreset: (name: string) => (name === 'Marinara' || name === 'Other' ? name : undefined),
        }),
    };
    const wi: Dict = { world_info_budget: 25, world_info_depth: 2, world_info_recursive: true };
    const selected = ['World'];
    const updateWorldInfoSettings = vi.fn((settings: Dict) => Object.assign(wi, settings));
    env.stModules.worldInfo = {
        getWorldInfoSettings: () => ({ world_info: { globalSelect: selected }, ...wi }),
        updateWorldInfoSettings,
        get selected_world_info() {
            return selected;
        },
    };
    return { live, storedPreset, wi, selected, updateWorldInfoSettings, savePreset, selectPreset, render, regex };
}
