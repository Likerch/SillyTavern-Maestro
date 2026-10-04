// What refers to a Chat Completion preset by name (Preset Studio data layer, M34, stage 5): the regex extension's
// permission list `extension_settings.preset_allowed_regex.openai` (regex/engine.js isPresetScriptsAllowed, P-154)
// and Connection Manager profiles (`extension_settings.connectionManager.profiles[].preset`, P-082). Neither
// follows a rename or a delete on its own (the regex extension does on ST's events). Pure: no DOM or SillyTavern.

type Dict = Record<string, unknown>;

export const REGEX_API_ID = 'openai';

export interface ProfileRef {
    id: string;
    name: string;
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The allow-list of preset names for regex scripts of an API (a live array, or null). */
export function regexAllowList(extensionSettings: Dict, apiId = REGEX_API_ID): string[] | null {
    const lists = extensionSettings.preset_allowed_regex;
    if (!isDict(lists)) return null;
    const list = lists[apiId];
    return Array.isArray(list) ? (list as string[]) : null;
}

export function isRegexAllowed(extensionSettings: Dict, name: string, apiId = REGEX_API_ID): boolean {
    return Boolean(name) && (regexAllowList(extensionSettings, apiId)?.includes(name) ?? false);
}

/** Adds `name` to the allow-list (creates it like allowPresetScripts does); true when something changed. */
export function allowRegex(extensionSettings: Dict, name: string, apiId = REGEX_API_ID): boolean {
    if (!name) return false;
    if (!isDict(extensionSettings.preset_allowed_regex)) extensionSettings.preset_allowed_regex = {};
    const lists = extensionSettings.preset_allowed_regex as Dict;
    if (!Array.isArray(lists[apiId])) lists[apiId] = [];
    const list = lists[apiId] as string[];
    if (list.includes(name)) return false;
    list.push(name);
    return true;
}

/** Removes `name` from the allow-list; true when something changed. */
export function disallowRegex(extensionSettings: Dict, name: string, apiId = REGEX_API_ID): boolean {
    const list = regexAllowList(extensionSettings, apiId);
    const index = list ? list.indexOf(name) : -1;
    if (!list || index < 0) return false;
    list.splice(index, 1);
    return true;
}

/** Moves the permission from `oldName` to `newName` (what regex's onPresetRenamed does); true when moved. */
export function moveRegexPermission(
    extensionSettings: Dict,
    oldName: string,
    newName: string,
    apiId = REGEX_API_ID,
): boolean {
    if (!isRegexAllowed(extensionSettings, oldName, apiId)) return false;
    disallowRegex(extensionSettings, oldName, apiId);
    allowRegex(extensionSettings, newName, apiId);
    return true;
}

/** Live Connection Manager profiles (`extension_settings.connectionManager.profiles`). */
export function connectionProfiles(extensionSettings: Dict): Dict[] {
    const manager = extensionSettings.connectionManager;
    if (!isDict(manager) || !Array.isArray(manager.profiles)) return [];
    return manager.profiles.filter(isDict);
}

/** Chat Completion profiles whose `preset` is `name` (Text Completion profiles name other presets). */
export function profilesUsing(extensionSettings: Dict, name: string): Dict[] {
    return connectionProfiles(extensionSettings).filter(
        (profile) => profile.mode !== 'tc' && typeof profile.preset === 'string' && profile.preset === name,
    );
}

export function profileRef(profile: Dict): ProfileRef {
    return {
        id: typeof profile.id === 'string' ? profile.id : String(profile.id ?? ''),
        name: typeof profile.name === 'string' ? profile.name : '',
    };
}

/** Points the given profiles (by id) from `from` to `to`; returns the ids that were changed. */
export function repointProfiles(extensionSettings: Dict, ids: readonly string[], from: string, to: string): string[] {
    const changed: string[] = [];
    for (const profile of connectionProfiles(extensionSettings)) {
        const ref = profileRef(profile);
        if (!ids.includes(ref.id) || profile.preset !== from) continue;
        profile.preset = to;
        changed.push(ref.id);
    }
    return changed;
}
