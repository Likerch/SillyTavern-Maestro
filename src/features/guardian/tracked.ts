// What M4 tracks (plan M4 п. 1, audit A17): SYSTEM settings only — how the model is called and how the stack
// behaves — read from the live objects, and how each tracked path is written back. Content and play state stay
// out, otherwise every chat switch or turn would look like drift: which lorebooks are on, copies that follow the
// chat or the character (Qvink's live settings, DES's tracker preset), what panels remember (NAI Studio's picked
// style, the composer's last choices), caches, quests, passports, secrets. SCOPE is the one definition of what is
// system: collection, comparison, acknowledge and restore all go through inScope().
//
// | Path | Source | Restore |
// |---|---|---|
// | preset.name | oai_settings.preset_settings_openai | select that preset (preset manager) |
// | preset.order / preset.toggles | active prompt order (global dummy 100001) | rewrite the live order |
// | preset.roles | role of every Prompt Manager prompt | rewrite live roles |
// | preset.contents | hash of each prompt's text and placement | whole preset body ('ask') |
// | preset.body | hash of the rest of getChatCompletionPreset() (samplers, formats, …) without the api.* fields | whole preset body ('ask'): saved to the preset file, then selected |
// | api.model | chat_completion_source and its model: «deepseek-v4-pro (deepseek)» | whole preset body ('ask'): ST keeps the connection in the preset |
// | api.maxContext / maxTokens / reasoningEffort / showThoughts / stream | oai_settings fields | the field and its ST control |
// | api.mainApi / api.profile | main_api, Connection Manager's selected profile (by name) | report only (switching back is ST's job) |
// | api.instruct / context / sysprompt | Text Completion template names (power_user) | report only |
// | api.reasoningTemplate / reasoningParse / reasoningAddToPrompts | power_user.reasoning | report only |
// | regex.<id> | extension_settings.regex: name, disabled, placement, flags, hashes of find/replace | the stored script |
// | qvink.profiles.<name> | hash of each saved Qvink profile | the profile (and the live settings when it is the active one) |
// | qvink.notify_on_profile_switch | Qvink's global switch | live settings |
// | ck.<key> | CK_KEYS: switches, injection, templates (hashed) | live settings |
// | nai.<key> | NAI_KEYS: sections without the panel's play state (prompts hashed) | live settings |
// | des.<key> | DES_KEYS: mode, sections, injection, prompt overrides (hashed) | live settings |
// | worldInfo.<key> | world-info.js getWorldInfoSettings(): budget, cap, depth, recursion, strategy… | updateWorldInfoSettings |
// | profiles.list | Connection Manager profiles (name#id) | report only |
// | extensions.disabled, extensions.versions.* | ST's disabled extensions, neighbour and ST versions | report only |
import { adaptersOf } from '../../adapters';
import { activePromptOrder, GLOBAL_ORDER_ID, promptIndex } from '../../domain/medic-prefill';
import { connectionFrom } from '../../domain/preset-analysis-hints';
import { normalizeKeyValue, PRESET_KEY_TABLE } from '../../domain/preset-store-keys';
import {
    filterTracked,
    getPath,
    groupOf,
    jsonCopy,
    mergeTracked,
    pathMatches,
    pickTracked,
    setPath,
    trackedValue,
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

/**
 * Qvink's global keys (index.js `global_settings`): everything else at the top level of its settings is a copy of
 * a profile that load_profile overwrites on every chat switch (auto_load_profile → Object.assign).
 */
export const QVINK_GLOBAL_KEYS = [
    'profiles',
    'character_profiles',
    'profile',
    'notify_on_profile_switch',
    'global_toggle_state',
    'disabled_group_characters',
    'memory_edit_interface_settings',
] as const;
/** Saved Qvink profiles, one hashed path per profile name. */
const QVINK_PROFILES = 'qvink.profiles.';
/** Qvink's global behaviour switches; the other global keys are per chat or remembered UI state. */
const QVINK_SWITCHES = ['notify_on_profile_switch'] as const;

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
    { path: 'primaryTemplate' },
    { path: 'templates', hash: true },
    { path: 'rag.enabled' },
];

export const NAI_KEYS: readonly KeySpec[] = [
    { path: 'transport' },
    // The panel's own prompt and character slots, and the undesired content and UC preset the picked style sets.
    { path: 'generation', omit: ['prompt', 'negativePrompt', 'ucPreset', 'seed', 'characters'] },
    // Prompt templates; the style library, the picked style and per-character prompts are content.
    { path: 'prompts', hash: true, omit: ['styles', 'activeStyle', 'negativeMode', 'characterPrompts'] },
    { path: 'modes' },
    { path: 'chat' },
    { path: 'auto' },
    { path: 'anlas' },
    // The insert dialog remembers its last mode; reading mode is a toggle of the chat view.
    { path: 'inline', omit: ['insertMode', 'readingMode'] },
    { path: 'markers' },
    { path: 'language' },
    { path: 'continuity' },
    { path: 'rawOverride', hash: true },
    { path: 'des', omit: ['saved', 'legacyPortraits'] },
    // The composer remembers its last framing, camera, distance, coordinates and target (composer.ts).
    { path: 'scene', omit: ['personaPassports', 'framing', 'camera', 'distance', 'useCoords', 'target'] },
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
    // Address and key of the external API are secrets (the key lives in localStorage since DES 2.x).
    { path: 'externalApiSettings', omit: ['apiKey', 'baseUrl'] },
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

/** Chat Completion fields with a readable path of their own, written back directly (the field and its control). */
export const API_FIELDS: Readonly<Record<string, string>> = {
    'api.maxContext': 'openai_max_context',
    'api.maxTokens': 'openai_max_tokens',
    'api.reasoningEffort': 'reasoning_effort',
    'api.showThoughts': 'show_thoughts',
    'api.stream': 'stream_openai',
};

/** Every api.* path. */
export const API_PATHS = [
    'api.mainApi',
    'api.profile',
    'api.model',
    ...Object.keys(API_FIELDS),
    'api.instruct',
    'api.context',
    'api.sysprompt',
    'api.reasoningTemplate',
    'api.reasoningParse',
    'api.reasoningAddToPrompts',
] as const;

/** Paths whose restore value is the whole preset: prompt texts, the rest of the body and the model it carries. */
const PRESET_BACKED = ['preset.body', 'preset.contents', 'api.model'];

const NEIGHBOUR_SPECS: readonly (readonly [prefix: string, specs: readonly KeySpec[]])[] = [
    ['ck', CK_KEYS],
    ['nai', NAI_KEYS],
    ['des', DES_KEYS],
];

/* ------------------------------------------------------------------ scope */

/** A group of system settings: exact paths, or `prefix.*` for every path under the prefix. */
export interface ScopeGroup {
    group: string;
    paths: readonly string[];
}

const specPaths = (prefix: string, specs: readonly KeySpec[]): string[] =>
    specs.map((spec) => `${prefix}.${spec.path}`);

/** M4's scope: the system settings it keeps. Anything else is never collected, compared, acknowledged or restored. */
export const SCOPE: readonly ScopeGroup[] = [
    // The active Chat Completion preset: which prompts go into every request, in what order and role, and samplers.
    {
        group: 'preset',
        paths: ['preset.name', 'preset.order', 'preset.toggles', 'preset.roles', 'preset.contents', 'preset.body'],
    },
    // How the model is called: API type, source and model, context and reply size, reasoning, streaming, the
    // connection profile, Text Completion templates.
    { group: 'api', paths: API_PATHS },
    // Global regex scripts rewrite every prompt and reply.
    { group: 'regex', paths: ['regex.*'] },
    // The lorebook engine (budget, depth, recursion…). Which books are on is content: Lore Studio and DES
    // campaigns switch them during play.
    { group: 'worldInfo', paths: WI_KEYS.map((key) => `worldInfo.${key}`) },
    // Saved Qvink profiles define how Qvink summarises and injects; the live copy follows the chat's profile.
    { group: 'qvink', paths: [`${QVINK_PROFILES}*`, ...QVINK_SWITCHES.map((key) => `qvink.${key}`)] },
    // CarrotKernel's switches, injection and templates; its book lists and tag libraries are content it fills itself.
    { group: 'ck', paths: specPaths('ck', CK_KEYS) },
    // NAI Studio's switches and prompt templates; the panel's prompt, picked style and composer choices are play.
    { group: 'nai', paths: specPaths('nai', NAI_KEYS) },
    // DES's mode, sections and prompts; quests and the tracker preset of the current character are play.
    { group: 'des', paths: specPaths('des', DES_KEYS) },
    // The saved ways to connect (Connection Manager).
    { group: 'profiles', paths: ['profiles.list'] },
    // Which extensions are on; versions are shown in the Pult only.
    { group: 'extensions', paths: ['extensions.disabled', 'extensions.versions.*'] },
];

const SCOPE_EXACT = new Set(SCOPE.flatMap((group) => group.paths.filter((path) => !path.endsWith('.*'))));
const SCOPE_PREFIXES = SCOPE.flatMap((group) =>
    group.paths.filter((path) => path.endsWith('.*')).map((path) => path.slice(0, -1)),
);

/** The path is a system setting M4 keeps. */
export function inScope(path: string): boolean {
    return (
        SCOPE_EXACT.has(path) || SCOPE_PREFIXES.some((prefix) => path.length > prefix.length && path.startsWith(prefix))
    );
}

/** `part` without paths outside the scope. */
export function scoped(part: TrackedPart): TrackedPart {
    return filterTracked(part, inScope);
}

/**
 * Removes paths outside the scope from a stored snapshot (in place). True when something was removed.
 */
export function pruneScope(part: TrackedPart): boolean {
    let pruned = false;
    for (const map of [part.values, part.restore]) {
        for (const path of Object.keys(map)) {
            if (inScope(path)) continue;
            delete map[path];
            pruned = true;
        }
    }
    return pruned;
}

/**
 * Patterns of paths schema 1 baselines could not hold. A live value of such a path that the baseline lacks is
 * taken into the baseline silently (once, when the old file is settled), not shown as «added».
 */
export const ADOPT_WHEN_MISSING = ['api', 'qvink.profiles'] as const;

/**
 * acknowledge() patterns with the paths they imply: the preset body carries the connection fields, so whoever
 * acknowledges the preset (or its body) acknowledges api.model and the API_FIELDS too.
 */
export function acknowledgeTargets(patterns: readonly string[]): string[] {
    const covers = patterns.some((pattern) => pathMatches('preset.body', [pattern]));
    return covers ? [...new Set([...patterns, 'api.model', ...Object.keys(API_FIELDS)])] : [...patterns];
}

/* ------------------------------------------------------------------ collection */

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

/** Preset body keys reported by api.* paths instead of the body hash: the source, every model, API_FIELDS. */
function isApiBodyKey(key: string): boolean {
    return key === 'chat_completion_source' || key.endsWith('_model') || Object.values(API_FIELDS).includes(key);
}

/**
 * Hash of a preset body without what other paths track: prompts and their order (preset.*), the connection
 * fields (api.*). The full body stays the restore value of preset.body.
 */
export function presetBodyHash(body: Dict): string {
    const rest: Dict = {};
    for (const [key, value] of Object.entries(body)) {
        if (key !== 'prompts' && key !== 'prompt_order' && !isApiBodyKey(key)) rest[key] = value;
    }
    return valueHash(rest);
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
        part.values['preset.body'] = presetBodyHash(body);
        part.restore['preset.body'] = { name, body };
    }
    return part;
}

/** How the model is called, in readable values. */
function apiPart(app: App): TrackedPart {
    const part = empty();
    const ctx = app.host.ctx();
    if (typeof ctx.mainApi === 'string' && ctx.mainApi) part.values['api.mainApi'] = ctx.mainApi;
    const manager = ctx.extensionSettings.connectionManager;
    if (isDict(manager) && typeof manager.selectedProfile === 'string' && manager.selectedProfile) {
        const id = manager.selectedProfile;
        const profile = Array.isArray(manager.profiles)
            ? manager.profiles.filter(isDict).find((item) => item.id === id)
            : undefined;
        part.values['api.profile'] = typeof profile?.name === 'string' && profile.name ? profile.name : id;
    }
    const power = isDict(ctx.powerUserSettings) ? ctx.powerUserSettings : {};
    if (app.host.isChatCompletion()) {
        const oai = liveOai(app);
        const connection = connectionFrom(oai);
        if (connection) {
            part.values['api.model'] = connection.model
                ? `${connection.model} (${connection.source})`
                : connection.source;
        }
        if (oai) {
            for (const [path, key] of Object.entries(API_FIELDS)) {
                if (oai[key] !== undefined && oai[key] !== null) part.values[path] = jsonCopy(oai[key]);
            }
        }
    } else {
        // Text Completion: the templates that shape the prompt (an instruct or system prompt that is off is absent).
        const { instruct, context, sysprompt } = power;
        if (isDict(instruct) && instruct.enabled === true && typeof instruct.preset === 'string') {
            part.values['api.instruct'] = instruct.preset;
        }
        if (isDict(context) && typeof context.preset === 'string') part.values['api.context'] = context.preset;
        if (isDict(sysprompt) && sysprompt.enabled !== false && typeof sysprompt.name === 'string') {
            part.values['api.sysprompt'] = sysprompt.name;
        }
    }
    const reasoning = power.reasoning;
    if (isDict(reasoning)) {
        if (typeof reasoning.name === 'string') part.values['api.reasoningTemplate'] = reasoning.name;
        if (typeof reasoning.auto_parse === 'boolean') part.values['api.reasoningParse'] = reasoning.auto_parse;
        if (typeof reasoning.add_to_prompts === 'boolean') {
            part.values['api.reasoningAddToPrompts'] = reasoning.add_to_prompts;
        }
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

/** Qvink: each saved profile (hashed) and the global switches, never the live copy of the chat's profile. */
function qvinkPart(app: App): TrackedPart {
    const part = empty();
    const qvink = neighbourSettings(app, 'qvink');
    if (!qvink) return part;
    if (isDict(qvink.profiles)) {
        for (const [name, profile] of Object.entries(qvink.profiles)) {
            if (!isDict(profile)) continue;
            const tracked = trackedValue(profile, { path: name, hash: true });
            if (!tracked) continue;
            part.values[`${QVINK_PROFILES}${name}`] = tracked.value;
            part.restore[`${QVINK_PROFILES}${name}`] = tracked.restore;
        }
    }
    return mergeTracked(
        part,
        pickTracked(
            qvink,
            QVINK_SWITCHES.map((key) => ({ path: key })),
            'qvink',
        ),
    );
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

/** Snapshot of every tracked path (system settings only), read from the live objects now. */
export async function collectTracked(app: App, log: Logger): Promise<TrackedPart> {
    return scoped(
        mergeTracked(
            await presetPart(app, log),
            apiPart(app),
            regexPart(app),
            qvinkPart(app),
            pickTracked(neighbourSettings(app, 'ck'), CK_KEYS, 'ck'),
            pickTracked(neighbourSettings(app, 'nai'), NAI_KEYS, 'nai'),
            pickTracked(neighbourSettings(app, 'des'), DES_KEYS, 'des'),
            await worldInfoPart(app, log),
            profilesPart(app),
            extensionsPart(app),
        ),
    );
}

/**
 * A snapshot stored by M4 1.x (baseline schema 1) under today's rules: values re-derived where the rules changed
 * (omitted keys, hashes, the preset body hash without the api.* fields) and paths outside the scope dropped.
 * Pure; paths the old snapshot could not hold are not invented here (ADOPT_WHEN_MISSING).
 */
export function migrateTracked(part: TrackedPart): TrackedPart {
    const values: Dict = { ...part.values };
    const restore: Dict = { ...part.restore };
    for (const [prefix, specs] of NEIGHBOUR_SPECS) {
        for (const spec of specs) {
            const path = `${prefix}.${spec.path}`;
            if (!Object.hasOwn(values, path)) continue;
            // A hashed key keeps its full value in `restore`: derive both again from it.
            const full = spec.hash ? restore[path] : values[path];
            if (full === undefined) continue;
            const tracked = trackedValue(full, spec);
            if (!tracked) continue;
            values[path] = tracked.value;
            if (spec.hash) restore[path] = tracked.restore;
        }
    }
    const preset = restore['preset.body'];
    if (Object.hasOwn(values, 'preset.body') && isDict(preset) && isDict(preset.body)) {
        values['preset.body'] = presetBodyHash(preset.body);
    }
    return scoped({ values, restore });
}

/** Paths whose restore value is the whole preset (body, prompt texts, the model it carries). */
export function isPresetBodyPath(path: string): boolean {
    return PRESET_BACKED.includes(path);
}

/** The full value used to write a path back (hash-tracked paths keep it in `restore`). */
export function fullValue(part: TrackedPart, path: string): unknown {
    if (isPresetBodyPath(path)) return part.restore['preset.body'];
    return Object.hasOwn(part.restore, path) ? part.restore[path] : part.values[path];
}

/** Maestro can write the baseline value of this drift entry back. */
export function isRestorable(entry: DriftEntry, baseline: TrackedPart): boolean {
    if (!inScope(entry.path)) return false;
    if (isPresetBodyPath(entry.path)) return isDict(baseline.restore['preset.body']);
    const group = groupOf(entry.path);
    if (group === 'preset' || group === 'worldInfo') return entry.baseline !== undefined;
    if (group === 'api') return Object.hasOwn(API_FIELDS, entry.path) && entry.baseline !== undefined;
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

interface JQueryLike {
    (selector: string): {
        length: number;
        val(value: unknown): unknown;
        prop(name: string, value: unknown): unknown;
        trigger(type: string): unknown;
    };
}

/**
 * Sets an ST drawer control and fires its `input` handler, as ST does when it applies a preset (openai.js
 * onSettingsPresetChange): the handler keeps counters and dependent controls in step.
 */
function setControl(selector: string, value: unknown, checkbox: boolean): void {
    const candidate = (globalThis as { jQuery?: unknown }).jQuery;
    if (typeof candidate !== 'function') return;
    const element = (candidate as JQueryLike)(selector);
    if (!element.length) return;
    if (checkbox) element.prop('checked', Boolean(value));
    else element.val(value);
    element.trigger('input');
}

/** One Chat Completion field of API_FIELDS: the live setting, then its control (ST's handler reads it back). */
function writeApi(app: App, path: string, value: unknown): boolean {
    const key = API_FIELDS[path];
    const spec = key ? PRESET_KEY_TABLE[key] : undefined;
    if (!spec || value === undefined || value === null) return false;
    const oai = liveOai(app);
    if (!oai || !app.host.isChatCompletion()) return false;
    const [selector, setting, checkbox] = spec;
    oai[setting] = normalizeKeyValue(value, oai[setting], checkbox);
    setControl(selector, oai[setting], checkbox);
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

/**
 * One saved Qvink profile (a name may hold dots, so no dotted path). The active profile is also loaded into the
 * live settings the way Qvink's load_profile does, so it applies at once rather than on the next chat switch.
 */
function writeQvinkProfile(app: App, path: string, value: unknown): boolean {
    const target = neighbourSettings(app, 'qvink');
    const name = path.slice(QVINK_PROFILES.length);
    if (!target || !name) return false;
    const profiles: Dict = isDict(target.profiles) ? target.profiles : {};
    target.profiles = profiles;
    if (value === undefined || value === null) {
        delete profiles[name];
        return true;
    }
    if (!isDict(value)) return false;
    profiles[name] = jsonCopy(value);
    if (target.profile === name) Object.assign(target, withoutKeys(jsonCopy(value), QVINK_GLOBAL_KEYS));
    return true;
}

function writeNeighbour(app: App, group: NeighbourGroup, path: string, value: unknown): boolean {
    if (path.startsWith(QVINK_PROFILES)) return writeQvinkProfile(app, path, value);
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
 * the caller (one save per batch). Returns false when the path cannot be written or is outside the scope.
 */
export async function writeTracked(app: App, log: Logger, path: string, value: unknown): Promise<boolean> {
    if (!inScope(path)) return false;
    const group = groupOf(path);
    try {
        if (group === 'preset' || isPresetBodyPath(path)) return await writePreset(app, log, path, value);
        if (group === 'api') return writeApi(app, path, value);
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
