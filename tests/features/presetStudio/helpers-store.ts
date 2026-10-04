// Stand for the Preset Studio store tests: a fake of the parts of SillyTavern 1.19 the store depends on, behaving
// like ST where it matters — openai.js (live `oai_settings`, the preset cache `openai_settings` /
// `openai_setting_names`, `settingsToUpdate`, getChatCompletionPreset, the application promise), Prompt Manager
// (its methods with ST's semantics, strict types left to the caller), the `#settings_preset_openai` select whose
// `change` runs ST's onSettingsPresetChange (BEFORE → keys applied → sanitize → AFTER → PRESET_CHANGED), the drawer
// controls with ST-like `input` handlers, /api/presets/save|delete and /api/files/sanitize-filename on a fake server,
// the regex extension's rename/delete handlers, script.js `is_send_press` and utils.js `download`.
// Tests that use it run in happy-dom.
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { PRESET_KEY_TABLE, sanitizePresetName } from '../../../src/domain/preset-store-keys';
import { DEFAULT_PROMPT_ORDER, GLOBAL_ORDER_ID } from '../../../src/domain/preset-store-prompts';
import { createPresetStore } from '../../../src/features/presetStudio/store';
import type { PresetStoreService } from '../../../src/features/presetStudio/store';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';
import { EVENT_TYPES } from '../../helpers/st-mock';

type Dict = Record<string, unknown>;

/** Raw event name the way the test host resolves keys (st-mock knows only some of ST's keys). */
export function ev(key: string): string {
    return EVENT_TYPES[key] ?? key;
}

/** ST's default prompts (PromptManager.js chatCompletionDefaultPrompts, trimmed to what the tests need). */
export const DEFAULT_PROMPTS: Dict[] = [
    { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'Write the reply.' },
    { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '' },
    { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
    { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '' },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    {
        identifier: 'enhanceDefinitions',
        name: 'Enhance Definitions',
        system_prompt: true,
        marker: false,
        role: 'system',
        content: 'Enhance.',
    },
    { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
];

/** Fake of ST's PromptManager with the semantics of PromptManager.js (1.19) for the methods the store uses. */
export class FakePromptManager {
    activeCharacter: { id: number } = { id: GLOBAL_ORDER_ID };
    renders: boolean[] = [];
    saves = 0;
    quickEdits: string[] = [];
    counts: Record<string, unknown> = {};
    tokenHandler = { getCounts: () => this.counts };

    constructor(
        public serviceSettings: Dict,
        private readonly saveSettings: () => void,
    ) {
        this.sanitizeServiceSettings();
    }

    private get prompts(): Dict[] {
        return this.serviceSettings.prompts as Dict[];
    }

    private get lists(): Dict[] {
        return this.serviceSettings.prompt_order as Dict[];
    }

    getPromptById(identifier: string): Dict | null {
        return this.prompts.find((item) => item && item.identifier === identifier) ?? null;
    }

    getPromptIndexById(identifier: string): number {
        return this.prompts.findIndex((item) => item.identifier === identifier);
    }

    getPromptOrderForCharacter(character: { id: number | string } | null): Dict[] {
        return !character
            ? []
            : ((this.lists.find((list) => String(list.character_id) === String(character.id))?.order as Dict[]) ?? []);
    }

    getPromptOrderEntry(character: { id: number | string }, identifier: string): Dict | null {
        return this.getPromptOrderForCharacter(character).find((entry) => entry.identifier === identifier) ?? null;
    }

    addPrompt(prompt: Dict, identifier: string): void {
        if (typeof prompt !== 'object' || prompt === null) throw new Error('Object is not a prompt');
        this.prompts.push({ identifier, system_prompt: false, enabled: false, marker: false, ...prompt });
    }

    appendPrompt(prompt: Dict, character: { id: number }): void {
        const order = this.getPromptOrderForCharacter(character);
        if (order.findIndex((entry) => entry.identifier === prompt.identifier) === -1) {
            order.unshift({ identifier: prompt.identifier, enabled: false });
        }
    }

    detachPrompt(prompt: Dict, character: { id: number }): void {
        const order = this.getPromptOrderForCharacter(character);
        const index = order.findIndex((entry) => entry.identifier === prompt.identifier);
        if (index !== -1) order.splice(index, 1);
    }

    removePromptOrderForCharacter(character: { id: number | string }): void {
        const index = this.lists.findIndex((list) => String(list.character_id) === String(character.id));
        if (index !== -1) this.lists.splice(index, 1);
    }

    addPromptOrderForCharacter(character: { id: number | string }, order: unknown[]): void {
        this.lists.push({ character_id: character.id, order: JSON.parse(JSON.stringify(order)) });
    }

    /** PromptManager.js:1006-1035 (with checkForMissingPrompts). */
    sanitizeServiceSettings(): void {
        this.serviceSettings.prompts = (this.serviceSettings.prompts as Dict[] | undefined) ?? [];
        this.serviceSettings.prompt_order = (this.serviceSettings.prompt_order as Dict[] | undefined) ?? [];
        if (this.getPromptOrderForCharacter(this.activeCharacter).length === 0) {
            this.addPromptOrderForCharacter(this.activeCharacter, [...DEFAULT_PROMPT_ORDER]);
        }
        for (const prompt of DEFAULT_PROMPTS) {
            if (!this.prompts.some((item) => item.identifier === prompt.identifier)) this.prompts.push({ ...prompt });
        }
        const order = this.getPromptOrderForCharacter(this.activeCharacter);
        for (let i = order.length - 1; i >= 0; i--) {
            const reference = order[i];
            if (reference && !this.prompts.some((prompt) => prompt.identifier === reference.identifier)) {
                order.splice(i, 1);
            }
        }
    }

    saveServiceSettings(): Promise<void> {
        this.saves++;
        this.saveSettings();
        return Promise.resolve();
    }

    render(afterTryGenerate = true): void {
        this.renders.push(afterTryGenerate);
    }

    updateQuickEdit(identifier: string): string {
        this.quickEdits.push(identifier);
        return `${identifier}_prompt_quick_edit_textarea`;
    }
}

/** A preset body with ST's keys, an unknown key, a foreign extension field and a custom block. */
export function marinaraBody(): Dict {
    return {
        chat_completion_source: 'openrouter',
        openrouter_model: 'deepseek/deepseek-v4',
        temperature: 1,
        top_p: 0.9,
        openai_max_context: 64000,
        openai_max_tokens: 1024,
        stream_openai: true,
        names_behavior: 0,
        bias_preset_selected: 'Default (none)',
        proxy_password: 'secret',
        reverse_proxy: 'http://proxy.local',
        marinara_version: '7.2',
        extensions: { regex_scripts: [{ id: 'r1', scriptName: 'Strip' }], other_ext: { keep: true } },
        prompts: [
            {
                identifier: 'main',
                name: 'Main Prompt',
                system_prompt: true,
                role: 'system',
                content: 'You are the GM.',
            },
            { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
            {
                identifier: 'jailbreak',
                name: 'Post-History Instructions',
                system_prompt: true,
                role: 'system',
                content: 'Stay sharp.',
            },
            {
                identifier: 'style',
                name: 'Style',
                system_prompt: false,
                marker: false,
                role: 'system',
                content: 'Write vividly.',
                injection_position: 0,
                injection_depth: 4,
                mystery_field: 'kept',
            },
            {
                identifier: 'depth',
                name: 'Depth note',
                system_prompt: false,
                marker: false,
                role: 'user',
                content: 'Remember the plot.',
                injection_position: 1,
                injection_depth: 2,
                injection_order: 100,
            },
        ],
        prompt_order: [
            {
                character_id: GLOBAL_ORDER_ID,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'style', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                    { identifier: 'depth', enabled: false },
                    { identifier: 'jailbreak', enabled: true },
                ],
            },
        ],
    };
}

export function otherBody(): Dict {
    return {
        temperature: 0.7,
        openai_max_tokens: 400,
        prompts: [{ identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'Other.' }],
        prompt_order: [{ character_id: GLOBAL_ORDER_ID, order: [{ identifier: 'main', enabled: true }] }],
    };
}

export interface FakeServer {
    /** Preset files by name (what /api/presets/save wrote). */
    files: Map<string, Dict>;
    saves: { name: string; preset: Dict; apiId: string; headers: unknown }[];
    deletes: string[];
    /** Status to answer the next saves with (0 = ok). */
    failSave: number;
    failDelete: number;
}

export interface StoreEnv {
    env: FeatureEnv;
    store: PresetStoreService;
    oai: Dict;
    cache: { list: Dict[]; names: Record<string, number> };
    pm: FakePromptManager;
    openai: Dict;
    manager: {
        selectPreset: Mock;
        savePreset: Mock;
        updatePreset: Mock;
        renamePreset: Mock;
        deletePreset: Mock;
    };
    server: FakeServer;
    /** ST events emitted (raw names, in order) with their payloads. */
    events: { name: string; data: unknown }[];
    /** The savePreset ST passes in OAI_PRESET_CHANGED_BEFORE: the store must never call it (P-078). */
    eventSavePreset: Mock;
    generating: { value: boolean };
    downloads: { text: string; name: string; type: string }[];
    acknowledge: Mock;
    select: HTMLSelectElement;
    controls: { inputs: string[]; changes: string[] };
    stop(): Promise<void>;
}

export interface StoreEnvOptions {
    presets?: Record<string, Dict>;
    current?: string;
    /** The regex extension listens to PRESET_RENAMED_BEFORE / PRESET_DELETED (default true). */
    regexExtension?: boolean;
    /** No Prompt Manager (Chat Completion not opened yet). */
    withoutPromptManager?: boolean;
}

/** Puts a preset body into settings like onSettingsPresetChange does (keys by settingsToUpdate). */
export function applyBodyToSettings(oai: Dict, preset: Dict): void {
    for (const [key, spec] of Object.entries(PRESET_KEY_TABLE)) {
        if (key === 'extensions') {
            oai.extensions = structuredClone(preset.extensions ?? {});
            continue;
        }
        if (preset[key] !== undefined) oai[spec[1]] = structuredClone(preset[key]);
    }
}

function addControl(html: string): HTMLElement {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    const element = holder.firstElementChild as HTMLElement;
    document.body.append(element);
    return element;
}

export async function createStoreEnv(options: StoreEnvOptions = {}): Promise<StoreEnv> {
    document.body.innerHTML = '';
    const env = await createFeatureEnv();
    const presets = options.presets ?? { Marinara: marinaraBody(), Other: otherBody() };
    const current = options.current ?? 'Marinara';
    const names = Object.keys(presets);
    const cache = {
        list: names.map((name) => structuredClone(presets[name] as Dict)),
        names: Object.fromEntries(names.map((name, index) => [name, index])) as Record<string, number>,
    };
    const ctx = env.mock.context as unknown as Dict;
    const oai: Dict = { preset_settings_openai: current, bind_preset_to_connection: true, seed: -1 };
    applyBodyToSettings(oai, cache.list[cache.names[current] as number] as Dict);
    ctx.chatCompletionSettings = oai;
    const saveSettings = () => env.mock.context.saveSettingsDebounced();
    const pm = new FakePromptManager(oai, saveSettings);

    const events: { name: string; data: unknown }[] = [];
    const originalEmit = env.mock.eventSource.emit.bind(env.mock.eventSource);
    env.mock.eventSource.emit = async (name: string, ...args: unknown[]) => {
        events.push({ name, data: args[0] });
        await originalEmit(name, ...args);
    };

    /* ---------------------------------------------------------------- DOM: the select and drawer controls */
    const select = addControl(`<select id="settings_preset_openai"></select>`) as HTMLSelectElement;
    names.forEach((name, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.text = name;
        option.selected = name === current;
        select.append(option);
    });
    const controls = { inputs: [] as string[], changes: [] as string[] };
    const temp = addControl(`<input id="temp_openai" type="number" step="0.01">`) as HTMLInputElement;
    temp.addEventListener('input', () => {
        controls.inputs.push('temp_openai');
        oai.temp_openai = Number(temp.value);
    });
    const stream = addControl(`<input id="stream_toggle" type="checkbox">`) as HTMLInputElement;
    stream.addEventListener('input', () => controls.inputs.push('stream_toggle'));
    const maxTokens = addControl(`<input id="openai_max_tokens" type="number">`) as HTMLInputElement;
    maxTokens.addEventListener('input', () => {
        controls.inputs.push('openai_max_tokens');
        oai.openai_max_tokens = Number(maxTokens.value);
    });
    const source = addControl(
        `<select id="chat_completion_source"><option value="openrouter">OpenRouter</option><option value="deepseek">DeepSeek</option></select>`,
    );
    source.addEventListener('input', () => controls.inputs.push('chat_completion_source'));
    source.addEventListener('change', () => controls.changes.push('chat_completion_source'));
    const bias = addControl(`<select id="openai_logit_bias_preset"><option value="x">x</option></select>`);
    bias.addEventListener('change', () => controls.changes.push('openai_logit_bias_preset'));

    /* ---------------------------------------------------------------- openai.js */
    const eventSavePreset = vi.fn();
    let applicationPromise: Promise<void> = Promise.resolve();
    const openai: Dict = {
        get promptManager() {
            return options.withoutPromptManager ? null : pm;
        },
        openai_settings: cache.list,
        openai_setting_names: cache.names,
        settingsToUpdate: PRESET_KEY_TABLE,
        getChatCompletionPreset(settings: Dict = oai) {
            const body: Dict = {};
            for (const [key, spec] of Object.entries(PRESET_KEY_TABLE)) body[key] = settings[spec[1]];
            return structuredClone(body);
        },
        getPresetApplicationPromise: () => applicationPromise,
    };
    // onSettingsPresetChange (OAI:5020-5081).
    const onPresetChange = () => {
        const presetNameBefore = oai.preset_settings_openai;
        const presetName = select.selectedOptions[0]?.text ?? '';
        oai.preset_settings_openai = presetName;
        const preset = structuredClone(cache.list[cache.names[presetName] as number] ?? {}) as Dict;
        applicationPromise = env.mock.eventSource
            .emit(ev('OAI_PRESET_CHANGED_BEFORE'), {
                preset,
                presetName,
                settingsToUpdate: PRESET_KEY_TABLE,
                settings: oai,
                savePreset: eventSavePreset,
                presetNameBefore,
            })
            .finally(async () => {
                applyBodyToSettings(oai, preset);
                pm.sanitizeServiceSettings();
                env.mock.context.saveSettingsDebounced();
                await env.mock.eventSource.emit(ev('OAI_PRESET_CHANGED_AFTER'));
                await env.mock.eventSource.emit(ev('PRESET_CHANGED'), { apiId: 'openai', name: presetName });
            });
    };
    select.addEventListener('change', onPresetChange);
    env.stModules.openai = openai;

    /* ---------------------------------------------------------------- preset-manager.js */
    const manager = {
        selectPreset: vi.fn(async (value: string) => {
            select.value = value;
            select.dispatchEvent(new Event('change'));
            await applicationPromise;
        }),
        savePreset: vi.fn(),
        updatePreset: vi.fn(),
        renamePreset: vi.fn(),
        deletePreset: vi.fn(),
    };
    env.stModules.presetManager = { getPresetManager: () => manager };

    /* ---------------------------------------------------------------- script.js, utils.js */
    const generating = { value: false };
    const downloads: { text: string; name: string; type: string }[] = [];
    const modules = env.host.modules as unknown as Dict;
    modules.script = async () => ({
        get is_send_press() {
            return generating.value;
        },
    });
    modules.utils = async () => ({
        download: (text: string, name: string, type: string) => downloads.push({ text, name, type }),
    });

    /* ---------------------------------------------------------------- the server */
    const server: FakeServer = {
        files: new Map(names.map((name) => [name, structuredClone(presets[name] as Dict)])),
        saves: [],
        deletes: [],
        failSave: 0,
        failDelete: 0,
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Dict) : {};
        if (url.includes('/api/presets/save')) {
            if (server.failSave) return new Response('error', { status: server.failSave });
            const name = sanitizePresetName(String(body.name ?? ''));
            server.saves.push({
                name,
                preset: body.preset as Dict,
                apiId: String(body.apiId),
                headers: init?.headers,
            });
            server.files.set(name, structuredClone(body.preset as Dict));
            return new Response(JSON.stringify({ name }), { status: 200 });
        }
        if (url.includes('/api/presets/delete')) {
            const name = String(body.name ?? '');
            server.deletes.push(name);
            if (server.failDelete) return new Response('error', { status: server.failDelete });
            if (!server.files.delete(name)) return new Response('', { status: 404 });
            return new Response('', { status: 200 });
        }
        if (url.includes('/api/files/sanitize-filename')) {
            return new Response(JSON.stringify({ fileName: sanitizePresetName(String(body.fileName ?? '')) }), {
                status: 200,
            });
        }
        return previousFetch(input, init);
    }) as typeof fetch;

    /* ---------------------------------------------------------------- the regex extension */
    const ext = env.mock.extensionSettings;
    const listeners: Unsubscribe[] = [];
    if (options.regexExtension !== false) {
        const onRenamed = (data: unknown) => {
            const { oldName, newName } = data as { oldName: string; newName: string };
            const list = ((ext.preset_allowed_regex as Dict | undefined)?.openai as string[] | undefined) ?? [];
            const index = list.indexOf(oldName);
            if (index >= 0) {
                list.splice(index, 1);
                list.push(newName);
            }
        };
        const onDeleted = (data: unknown) => {
            const { name } = data as { name: string };
            const list = ((ext.preset_allowed_regex as Dict | undefined)?.openai as string[] | undefined) ?? [];
            const index = list.indexOf(name);
            if (index >= 0) list.splice(index, 1);
        };
        env.mock.eventSource.on(ev('PRESET_RENAMED_BEFORE'), onRenamed);
        env.mock.eventSource.on(ev('PRESET_DELETED'), onDeleted);
        listeners.push(() => env.mock.eventSource.removeListener(ev('PRESET_RENAMED_BEFORE'), onRenamed));
        listeners.push(() => env.mock.eventSource.removeListener(ev('PRESET_DELETED'), onDeleted));
    }

    /* ---------------------------------------------------------------- guardian, store */
    const acknowledge = vi.fn(async () => {});
    env.apis.set('guardian', { acknowledge });
    const store = createPresetStore(env.app, env.app.log);
    const disposers = store.install();
    await store.ready();
    await store.whenIdle();

    return {
        env,
        store,
        oai,
        cache,
        pm,
        openai,
        manager,
        server,
        events,
        eventSavePreset,
        generating,
        downloads,
        acknowledge,
        select,
        controls,
        async stop() {
            await store.whenIdle();
            for (const dispose of disposers) dispose();
            for (const dispose of listeners) dispose();
            globalThis.fetch = previousFetch;
            await flush(2);
        },
    };
}

/** Raw names of ST events emitted since `from`. */
export function eventNames(stand: StoreEnv, from = 0): string[] {
    return stand.events.slice(from).map((item) => item.name);
}

/** The versions file of a preset as stored (parsed JSON), or undefined. */
export function versionsFile(stand: StoreEnv, name: string): Dict | undefined {
    const text = stand.env.mock.files.get(stand.store.history.fileName(name));
    return text === undefined ? undefined : (JSON.parse(text) as Dict);
}
