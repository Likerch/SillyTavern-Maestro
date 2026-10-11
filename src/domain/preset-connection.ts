// An automatic preset switch that keeps the connection (M34 bindings, M42 «Мастерская»). With ST's «Bind presets to API
// connections» on, a Chat Completion preset file carries its source, model, providers and the like (openai.js
// settingsToUpdate: `[selector, setting, isCheckbox, isConnection]`, applied after OAI_PRESET_CHANGED_BEFORE whose
// listeners may alter the preset). Writing the live values into the incoming preset's connection keys leaves the
// model the user chose in place. Pure: no DOM, no SillyTavern.

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copy(value: unknown): unknown {
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * Sets every connection key of `preset` to the live value from `settings` (in place); returns the keys set. Keys the
 * live settings do not have are left as the preset has them.
 */
export function keepConnection(preset: unknown, settingsToUpdate: unknown, settings: unknown): string[] {
    if (!isDict(preset) || !isDict(settingsToUpdate) || !isDict(settings)) return [];
    const kept: string[] = [];
    for (const [key, spec] of Object.entries(settingsToUpdate)) {
        if (!Array.isArray(spec) || spec[3] !== true) continue;
        const setting = typeof spec[1] === 'string' ? spec[1] : key;
        if (!Object.hasOwn(settings, setting) || settings[setting] === undefined) continue;
        preset[key] = copy(settings[setting]);
        kept.push(key);
    }
    return kept;
}
