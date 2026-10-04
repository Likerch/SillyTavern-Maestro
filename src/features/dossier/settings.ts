// Settings slice of M7 «Досье» (extensionSettings.maestro.modules.dossier).

export interface DossierSettings {
    /** Qvink memories shown besides the long-term ones (plan M7: «only long-term + last 10»). */
    memories: number;
    /** Assistant messages searched back for the character's last DES tracker entry. */
    trackerLookback: number;
    /** Characters of stored text sent to the AI comparison (split between the stores). */
    compareMaxChars: number;
}

export const DOSSIER_KEY = 'dossier';
export const DOSSIER_ID = 'M7';

export function defaultDossierSettings(): DossierSettings {
    return { memories: 10, trackerLookback: 40, compareMaxChars: 6000 };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}

/** Repairs a stored slice in place (hand-edited or older settings) and returns it. */
export function readDossierSettings(slice: Partial<DossierSettings>): DossierSettings {
    const defaults = defaultDossierSettings();
    slice.memories = clampInt(slice.memories, 0, 100, defaults.memories);
    slice.trackerLookback = clampInt(slice.trackerLookback, 1, 500, defaults.trackerLookback);
    slice.compareMaxChars = clampInt(slice.compareMaxChars, 1000, 40000, defaults.compareMaxChars);
    return slice as DossierSettings;
}
