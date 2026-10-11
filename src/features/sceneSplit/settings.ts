// Settings slice of M43 «Сцена и вокруг» (`extensionSettings.maestro.modules.sceneSplit`) and the module's constants.
export const SCENE_SPLIT_KEY = 'sceneSplit';
export const SCENE_SPLIT_ID = 'M43';
/** Ephemeral injection key of the instruction (`maestro_sceneSplit`). */
export const SCENE_SPLIT_INJECTION = 'sceneSplit';
/** Recent replies that keep their block in the prompt, at most. */
export const KEEP_MAX = 10;
/** Longest label of the folded box. */
export const LABEL_MAX = 40;

export interface SceneSplitSettings {
    /** The instruction, the folded box, the prompt cleanup and departures. */
    enabled: boolean;
    /** Recent assistant replies whose block stays in the prompt as one bracket line (older ones lose it). */
    keepRecent: number;
    /** The summary of the folded box ('' = «Вокруг» / «Around» in the interface language). */
    label: string;
}

export function defaultSceneSplitSettings(): SceneSplitSettings {
    return { enabled: true, keepRecent: 2, label: '' };
}

/** The live slice, repaired in place (it is the object the settings section edits). */
export function readSceneSplitSettings(slice: Partial<SceneSplitSettings>): SceneSplitSettings {
    const defaults = defaultSceneSplitSettings();
    if (typeof slice.enabled !== 'boolean') slice.enabled = defaults.enabled;
    const keep =
        typeof slice.keepRecent === 'number' && Number.isFinite(slice.keepRecent)
            ? Math.min(KEEP_MAX, Math.max(0, Math.round(slice.keepRecent)))
            : defaults.keepRecent;
    if (slice.keepRecent !== keep) slice.keepRecent = keep;
    if (typeof slice.label !== 'string') slice.label = defaults.label;
    else if (slice.label.length > LABEL_MAX) slice.label = slice.label.slice(0, LABEL_MAX);
    return slice as SceneSplitSettings;
}
