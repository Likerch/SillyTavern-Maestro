// What M4 tracks (plan M4 п. 1, audit A17): a CURATED list of settings, read from the live objects, and how each
// tracked path is written back. Volatile data (DES quests and lastGeneratedData, Qvink profile copies, CK RAG
// chunks, NAI galleries and persona passports, connection secrets) is deliberately left out, otherwise every turn
// would look like drift.
//
// | Path | Source | Restore |
// |---|---|---|
// | preset.name | oai_settings.preset_settings_openai | select that preset (preset manager) |
// | preset.order / preset.toggles | active prompt order (global dummy 100001) | rewrite the live order |
// | preset.roles | role of every Prompt Manager prompt | rewrite live roles |
// | preset.contents | hash of each prompt's text and placement | whole preset body ('ask') |
// | preset.body | hash of the rest of getChatCompletionPreset() (samplers, formats, …) | whole preset body ('ask'): saved to the preset file, then selected |
// | regex.<id> | extension_settings.regex: name, disabled, placement, flags, hashes of find/replace | the stored script |
// | qvink.<key> | extension_settings.qvink_memory, every key except the profile copies | live settings |
// | ck.<key> | extension_settings.CarrotKernel, switches and repo lists (templates hashed) | live settings |
// | nai.<key> | extension_settings.nai_studio sections (prompts hashed; no persona passports) | live settings |
// | des.<key> | DES settings: mode, sections, injection, prompt overrides (hashed) | live settings |
// | worldInfo.<key> | world-info.js getWorldInfoSettings(): budget, cap, depth, recursion, strategy… | updateWorldInfoSettings |
// | worldInfo.globalSelect | active global lorebooks | report only (books are toggled through ST's handler) |
// | profiles.list | Connection Manager profiles (name#id) | report only |
// | extensions.disabled, extensions.versions.* | ST's disabled extensions, neighbour and ST versions | report only |
import { adaptersOf } from '../../adapters';
import { activePromptOrder, GLOBAL_ORDER_ID, promptIndex } from '../../domain/medic-prefill';
import {
    getPath,
    groupOf,
    jsonCopy,
    keysExcept,
    mergeTracked,
    pickTracked,
    setPath,
    valueHash,
} from '../../domain/settings-diff';
import type { DriftEntry, KeySpec, TrackedPart } from '../../domain/settings-diff';
import type { App, Logger } from '../../shared/contracts';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preset fields that hold addresses, keys or passwords: never stored, kept as they are on restore. */
export const PRESET_SECRET_KEYS = [
    'proxy_password',
    'reverse_proxy',
    'custom_url',
    'custom_include_headers',
    'custom_include_body',
    'custom_exclude_body',
    'azure_base_url',
    'vertexai_express_project_id',
    'workers_ai_account_id',
] as const;

/** Qvink keeps full copies of every profile next to the active settings; those change on every profile save. */
export const QVINK_DENY = ['profiles', 'character_profiles', 'chat_profiles'] as const;

export const CK_KEYS: readonly KeySpec[] = [
    { path: 'enabled' },
    { path: 'displayMode' },
    { path: 'sendToAI' },
    { path: 'injectionRole' },
    { path: 'injectionDepth' },
    { path: 'maxCharactersDisplay' },
    { path: 'maxCharactersInject' },
    { path: 'babyBunnyMode' },
    { path: 'autoRescanOnChatLoad' },
    { path: 'bunnymoTagWrapping' },
    { path: 'excludeTagSynthesis' },
    { path: 'selectedLorebooks' },
    { path: 'characterRepoBooks' },
    { path: 'tagLibraries' },
    { path: 'primaryTemplate' },
    { path: 'templates', hash: true },
    { path: 'rag.enabled' },
];

export const NAI_KEYS: readonly KeySpec[] = [
    { path: 'transport' },
    { path: 'generation' },
    { path: 'prompts', hash: true },
    { path: 'modes' },
    { path: 'chat' },
    { path: 'auto' },
    { path: 'anlas' },
    { path: 'inline' },
    { path: 'markers' },
    { path: 'language' },
    { path: 'continuity' },
    { path: 'rawOverride', hash: true },
    { path: 'des', omit: ['saved'] },
    { path: 'scene', omit: ['personaPassports'] },
];

export const DES_KEYS: readonly KeySpec[] = [
    { path: 'enabled' },
    { path: 'generationMode' },
    { path: 'autoUpdate' },
    { path: 'updateDepth' },
    { path: 'connectionProfile' },
    { path: 'promptInjection' },
    { path: 'showInfoBox' },
    { path: 'showCharacterThoughts' },
    { path: 'showQuests' },
    { path: 'compactPrompts' },
    { path: 'narratorMode' },
    { path: 'enableHtmlPrompt' },
    { path: 'enableDialogueColoring' },
    { path: 'skipInjectionsForGuided' },
    { path: 'historyPersistence' },
    { path: 'externalApiSettings' },
    { path: 'autoPortraitMode' },
    { path: 'autoGenerateAvatars' },
    { path: 'portraitEnhancementMode' },
    { path: 'lorebook.enabled' },
    { path: 'lorebook.autoLinkByName' },
    { path: 'doomCounter.enabled' },
    { path: 'customTrackerPrompt', hash: true },
    { path: 'customTrackerInstructionsPrompt', hash: true },
    { path: 'customTrackerContinuationPrompt', hash: true },
    { path: 'customHtmlPrompt', hash: true },
    { path: 'customDialogueColoringPrompt', hash: true },
    { path: 'customNarratorPrompt', hash: true },
    { path: 'customContextInstructionsPrompt', hash: true },
];

/** world-info.js settings (getWorldInfoSettings / updateWorldInfoSettings). */
export const WI_KEYS = [
    'world_info_depth',
    'world_info_min_activations',
    'world_info_min_activations_depth_max',
    'world_info_budget',
    'world_info_include_names',
    'world_info_recursive',
    'world_info_overflow_alert',
    'world_info_case_sensitive',
    'world_info_match_whole_words',
    'world_info_character_strategy',
    'world_info_budget_cap',
    'world_info_use_group_scoring',
    'world_info_max_recursion_steps',
] as const;

const NEIGHBOUR_GROUPS = ['des', 'qvink', 'ck', 'nai'] as const;
type NeighbourGroup = (typeof NEIGHBOUR_GROUPS)[number];

function empty(): TrackedPart {
    return { values: {}, restore: {} };
}

function liveOai(app: App): Dict | null {
    const settings = (app.host.ctx() as unknown as { chatCompletionSettings?: unknown }).chatCompletionSettings;
    return isDict(settings) ? settings : null;
}

function withoutKeys(source: Dict, keys: readonly string[]): Dict {
    const copy: Dict = { ...source };
    for (const key of keys) delete copy[key];
    return copy;
}

/** The live preset body without secrets (openai.js getChatCompletionPreset), or null. */
async function livePresetBody(app: App, log: Logger): Promise<Dict | null> {
    if (!app.host.caps.has('st.oai.promptManager')) return null;
    try {
        const openai = await app.host.modules.openai();
        const get = openai.getChatCompletionPreset;
        const body = typeof get === 'function' ? (get as () => unknown)() : null;
        return isDict(body) ? (jsonCopy(withoutKeys(body, PRESET_SECRET_KEYS)) as Dict) : null;
    } catch (error) {
        log.debug('preset body unavailable', error);
        return null;
    }
}

async function presetPart(app: App, log: Logger): Promise<TrackedPart> {
    const part = empty();
    const oai = liveOai(app);
    if (!oai || !app.host.isChatCompletion()) return part;
    const name = typeof oai.preset_settings_openai === 'string' ? oai.preset_settings_openai : '';
    part.values['preset.name'] = name;
    const order = activePromptOrder(oai.prompt_order);
    part.values['preset.order'] = order.map((entry) => entry.identifier);
    part.values['preset.toggles'] = Object.fromEntries(order.map((entry) => [entry.identifier, entry.enabled]));
    const prompts = Array.isArray(oai.prompts) ? oai.prompts.filter(isDict) : [];
    const ids = prompts.filter((prompt) => typeof prompt.identifier === 'string');
    part.values['preset.roles'] = Object.fromEntries(
        ids.map((prompt) => [prompt.identifier as string, typeof prompt.role === 'string' ? prompt.role : 'system']),
    );
    part.values['preset.contents'] = Object.fromEntries(
        ids
            .filter((prompt) => prompt.marker !== true)
            .map((prompt) => [
                prompt.identifier as string,
                valueHash({
                    name: prompt.name ?? null,
                    content: prompt.content ?? null,
                    position: prompt.injection_position ?? null,
                    depth: prompt.injection_depth ?? null,
                    order: prompt.injection_order ?? null,
                }),
            ]),
    );
    const body = await livePresetBody(app, log);
    if (body) {
        // Prompts and their order are tracked above; the body hash covers everything else.
        part.values['preset.body'] = valueHash(withoutKeys(body, ['prompts', 'prompt_order']));
        part.restore['preset.body'] = { name, body };
    }
    return part;
}

function regexPart(app: App): TrackedPart {
    const part = empty();
    const scripts = app.host.ctx().extensionSettings.regex;
    if (!Array.isArray(scripts)) return part;
    for (const script of scripts) {
        if (!isDict(script) || typeof script.id !== 'string' || !script.id) continue;
        const path = `regex.${script.id}`;
        part.values[path] = {
            name: typeof script.scriptName === 'string' ? script.scriptName : '',
            disabled: script.disabled === true,
            placement: Array.isArray(script.placement) ? [...script.placement].sort() : [],
            promptOnly: script.promptOnly === true,
            markdownOnly: script.markdownOnly === true,
            find: valueHash(script.findRegex ?? ''),
            replace: valueHash(script.replaceString ?? ''),
        };
        part.restore[path] = jsonCopy(script);
    }
    return part;
}

async function worldInfoPart(app: App, log: Logger): Promise<TrackedPart> {
    const part = empty();
    if (!app.host.caps.has('st.wi.module')) return part;
    try {
        const wi = await app.host.modules.worldInfo();
        const get = wi.getWorldInfoSettings;
        const settings = typeof get === 'function' ? (get as () => unknown)() : null;
        if (isDict(settings)) {
            for (const key of WI_KEYS) if (settings[key] !== undefined) part.values[`worldInfo.${key}`] = settings[key];
        }
        if (Array.isArray(wi.selected_world_info)) {
            part.values['worldInfo.globalSelect'] = wi.selected_world_info
                .filter((item) => typeof item === 'string')
                .sort();
        }
    } catch (error) {
        log.debug('world info settings unavailable', error);
    }
    return part;
}

function profilesPart(app: App): TrackedPart {
    const part = empty();
    const profiles = getPath(app.host.ctx().extensionSettings, 'connectionManager.profiles');
    if (!Array.isArray(profiles)) return part;
    part.values['profiles.list'] = profiles
        .filter(isDict)
        .map((profile) => `${String(profile.name ?? '')}#${String(profile.id ?? '')}`)
        .sort();
    return part;
}

function extensionsPart(app: App): TrackedPart {
    const part = empty();
    const disabled = app.host.ctx().extensionSettings.disabledExtensions;
    if (Array.isArray(disabled)) {
        part.values['extensions.disabled'] = disabled.filter((item) => typeof item === 'string').sort();
    }
    const version = app.host.version();
    if (version) part.values['extensions.versions.st'] = version;
    for (const adapter of Object.values(app.adapters)) {
        const value = adapter.version();
        if (value) part.values[`extensions.versions.${adapter.id}`] = value;
    }
    return part;
}

/** Live settings object of a neighbour (written in place on restore). */
function neighbourSettings(app: App, group: NeighbourGroup): Dict | null {
    const adapters = adaptersOf(app);
    switch (group) {
        case 'des':
            return adapters.des.settings();
        case 'qvink':
            return adapters.qvink.settings();
        case 'ck':
            return adapters.ck.settings();
        case 'nai':
            return adapters.nai.settings();
    }
}

/** Snapshot of every tracked path, read from the live objects now. */
export async function collectTracked(app: App, log: Logger): Promise<TrackedPart> {
    const qvink = neighbourSettings(app, 'qvink');
    return mergeTracked(
        await presetPart(app, log),
        regexPart(app),
        pickTracked(qvink, keysExcept(qvink, QVINK_DENY), 'qvink'),
        pickTracked(neighbourSettings(app, 'ck'), CK_KEYS, 'ck'),
        pickTracked(neighbourSettings(app, 'nai'), NAI_KEYS, 'nai'),
        pickTracked(neighbourSettings(app, 'des'), DES_KEYS, 'des'),
        await worldInfoPart(app, log),
        profilesPart(app),
        extensionsPart(app),
    );
}

/** Paths whose restore value is the whole preset (body and prompt texts). */
export function isPresetBodyPath(path: string): boolean {
    return path === 'preset.body' || path === 'preset.contents';
}

/** The full value used to write a path back (hash-tracked paths keep it in `restore`). */
export function fullValue(part: TrackedPart, path: string): unknown {
    if (isPresetBodyPath(path)) return part.restore['preset.body'];
    return Object.hasOwn(part.restore, path) ? part.restore[path] : part.values[path];
}

/** Maestro can write the baseline value of this drift entry back. */
export function isRestorable(entry: DriftEntry, baseline: TrackedPart): boolean {
    const group = groupOf(entry.path);
    if (group === 'preset') {
        if (isPresetBodyPath(entry.path)) return isDict(baseline.restore['preset.body']);
        return entry.baseline !== undefined;
    }
    if (group === 'worldInfo') return entry.path !== 'worldInfo.globalSelect' && entry.baseline !== undefined;
    if (group === 'regex') return entry.kind !== 'added';
    if ((NEIGHBOUR_GROUPS as readonly string[]).includes(group)) return entry.kind !== 'added';
    return false;
}

/* ------------------------------------------------------------------ writing values back */

async function presetManager(app: App): Promise<Dict | null> {
    if (!app.host.caps.has('st.presetManager')) return null;
    const module = await app.host.modules.presetManager();
    const get = module.getPresetManager;
    const manager = typeof get === 'function' ? (get as (apiId: string) => unknown)('openai') : null;
    return isDict(manager) ? manager : null;
}

async function rerenderPrompts(app: App, log: Logger): Promise<void> {
    if (!app.host.caps.has('st.oai.promptManager')) return;
    try {
        const openai = await app.host.modules.openai();
        const manager = openai.promptManager;
        if (isDict(manager) && typeof manager.render === 'function') {
            (manager.render as (after?: boolean) => void).call(manager, false);
        }
    } catch (error) {
        log.debug('prompt manager render failed', error);
    }
}

function globalOrderEntry(oai: Dict): Dict | null {
    const lists = Array.isArray(oai.prompt_order) ? oai.prompt_order.filter(isDict) : [];
    return lists.find((item) => String(item.character_id) === String(GLOBAL_ORDER_ID)) ?? lists[0] ?? null;
}

/** Saves the body into the preset file through ST's preset manager, which then selects and applies it. */
async function writePresetBody(app: App, value: unknown): Promise<boolean> {
    if (!isDict(value) || typeof value.name !== 'string' || !value.name || !isDict(value.body)) return false;
    const manager = await presetManager(app);
    if (!manager || typeof manager.savePreset !== 'function') return false;
    let secrets: Dict = {};
    if (app.host.caps.has('st.oai.promptManager')) {
        const openai = await app.host.modules.openai();
        const names = openai.openai_setting_names;
        const list = openai.openai_settings;
        const slot = isDict(names) ? names[value.name] : undefined;
        const stored = Array.isArray(list) && typeof slot === 'number' ? list[slot] : undefined;
        const source = isDict(stored)
            ? stored
            : typeof openai.getChatCompletionPreset === 'function'
              ? (openai.getChatCompletionPreset as () => unknown)()
              : null;
        if (isDict(source)) {
            for (const key of PRESET_SECRET_KEYS) if (source[key] !== undefined) secrets[key] = source[key];
        }
    }
    secrets = { ...secrets, ...value.body };
    await (manager.savePreset as (name: string, body: unknown) => Promise<void>).call(manager, value.name, secrets);
    return true;
}

async function writePreset(app: App, log: Logger, path: string, value: unknown): Promise<boolean> {
    if (isPresetBodyPath(path)) return writePresetBody(app, value);
    if (path === 'preset.name') {
        if (typeof value !== 'string' || !value) return false;
        const manager = await presetManager(app);
        if (!manager || typeof manager.findPreset !== 'function' || typeof manager.selectPreset !== 'function')
            return false;
        const option = (manager.findPreset as (name: string) => unknown).call(manager, value);
        if (option === undefined || option === null) return false;
        await (manager.selectPreset as (value: unknown) => Promise<void>).call(manager, option);
        return true;
    }
    const oai = liveOai(app);
    if (!oai) return false;
    if (path === 'preset.roles') {
        if (!isDict(value) || !Array.isArray(oai.prompts)) return false;
        for (const [identifier, role] of Object.entries(value)) {
            const index = promptIndex(oai.prompts, identifier);
            if (index >= 0 && typeof role === 'string') (oai.prompts[index] as Dict).role = role;
        }
    } else if (path === 'preset.toggles' || path === 'preset.order') {
        const entry = globalOrderEntry(oai);
        if (!entry || !Array.isArray(entry.order)) return false;
        const items = entry.order.filter(isDict);
        if (path === 'preset.toggles') {
            if (!isDict(value)) return false;
            for (const item of items) {
                const enabled = value[String(item.identifier)];
                if (typeof enabled === 'boolean') item.enabled = enabled;
            }
        } else {
            if (!Array.isArray(value)) return false;
            const rank = new Map(value.map((identifier, index) => [String(identifier), index]));
            const known = items.filter((item) => rank.has(String(item.identifier)));
            const extra = items.filter((item) => !rank.has(String(item.identifier)));
            known.sort((a, b) => (rank.get(String(a.identifier)) ?? 0) - (rank.get(String(b.identifier)) ?? 0));
            entry.order = [...known, ...extra];
        }
    } else {
        return false;
    }
    await rerenderPrompts(app, log);
    return true;
}

function writeRegex(app: App, path: string, value: unknown): boolean {
    const id = path.slice('regex.'.length);
    const settings = app.host.ctx().extensionSettings;
    const scripts = Array.isArray(settings.regex) ? settings.regex : [];
    settings.regex = scripts;
    const index = scripts.findIndex((script) => isDict(script) && script.id === id);
    if (value === undefined || value === null) {
        if (index >= 0) scripts.splice(index, 1);
        return true;
    }
    if (!isDict(value) || value.id !== id) return false;
    if (index >= 0) scripts[index] = jsonCopy(value);
    else scripts.push(jsonCopy(value));
    return true;
}

async function writeWorldInfo(app: App, path: string, value: unknown): Promise<boolean> {
    const key = path.slice('worldInfo.'.length);
    if (!(WI_KEYS as readonly string[]).includes(key) || value === undefined) return false;
    if (!app.host.caps.has('st.wi.module')) return false;
    const wi = await app.host.modules.worldInfo();
    const update = wi.updateWorldInfoSettings;
    if (typeof update !== 'function') return false;
    (update as (settings: Dict) => void)({ [key]: value });
    return true;
}

function writeNeighbour(app: App, group: NeighbourGroup, path: string, value: unknown): boolean {
    const target = neighbourSettings(app, group);
    if (!target) return false;
    setPath(target, path.slice(group.length + 1), value === undefined ? undefined : jsonCopy(value));
    if (group === 'des') {
        // DES's own saveSettings stores its live object under extension_settings[<folder>] (persistence.js).
        const name = adaptersOf(app).des.extensionName();
        if (name) app.host.ctx().extensionSettings[name] = target;
    }
    return true;
}

/**
 * Writes one tracked path (its full value; undefined removes it where that makes sense). Settings are saved by
 * the caller (one save per batch). Returns false when the path cannot be written.
 */
export async function writeTracked(app: App, log: Logger, path: string, value: unknown): Promise<boolean> {
    const group = groupOf(path);
    try {
        if (group === 'preset') return await writePreset(app, log, path, value);
        if (group === 'regex') return writeRegex(app, path, value);
        if (group === 'worldInfo') return await writeWorldInfo(app, path, value);
        if ((NEIGHBOUR_GROUPS as readonly string[]).includes(group)) {
            return writeNeighbour(app, group as NeighbourGroup, path, value);
        }
    } catch (error) {
        log.warn(`could not restore ${path}`, error);
    }
    return false;
}
