// Settings slice of the director (`extensionSettings.maestro.modules.director`): stall length, how often a director's
// note may be written per mode (plan §12: off in «Экономный», rarely in «Сбалансированный», more often in «Кино»), the
// cheap model for unsure scenes, picture hints and the weight of the user's message in the scene type.
export const DIRECTOR_KEY = 'director';
export const DIRECTOR_ID = 'M13';

export type DirectorMode = 'economy' | 'balanced' | 'cinema';

export const DIRECTOR_MODES: readonly DirectorMode[] = ['economy', 'balanced', 'cinema'];

export interface DirectorSettings {
    /** Committed turns without change that make a stall (M14 п.1). */
    stallTurns: number;
    /** A note at most once in this many committed turns, per mode; 0 = no automatic notes. */
    every: Record<DirectorMode, number>;
    /** Ask the cheap background model when the rules hesitate between two scene types (never in «Экономный»). */
    model: boolean;
    /** Set `maestro_picture_moment` when a picture fits (never in «Экономный»). */
    pictures: boolean;
    /**
     * Weight of the cue of the user's message (the one that commits the turn) against the reply's reading; 0 = ignore
     * it. A strong cue (an attack, a kiss, a time skip) sets the type by itself whenever the weight is above 0.
     */
    userWeight: number;
}

export const STALL_MIN = 2;
export const STALL_MAX = 20;
export const EVERY_MAX = 50;
export const USER_WEIGHT_MAX = 2;

export function defaultDirectorSettings(): DirectorSettings {
    return {
        stallTurns: 4,
        every: { economy: 0, balanced: 6, cinema: 4 },
        model: true,
        pictures: true,
        userWeight: 0.6,
    };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}

/** The live slice, repaired in place (it is the object the pult edits). */
export function readDirectorSettings(slice: Partial<DirectorSettings>): DirectorSettings {
    const defaults = defaultDirectorSettings();
    const stall = intIn(slice.stallTurns, STALL_MIN, STALL_MAX, defaults.stallTurns);
    if (slice.stallTurns !== stall) slice.stallTurns = stall;
    if (!isDict(slice.every)) slice.every = { ...defaults.every };
    const every = slice.every as Record<string, unknown>;
    for (const mode of DIRECTOR_MODES) {
        const value = intIn(every[mode], 0, EVERY_MAX, defaults.every[mode]);
        if (every[mode] !== value) every[mode] = value;
    }
    if (typeof slice.model !== 'boolean') slice.model = defaults.model;
    if (typeof slice.pictures !== 'boolean') slice.pictures = defaults.pictures;
    const weight =
        typeof slice.userWeight === 'number' && Number.isFinite(slice.userWeight)
            ? Math.round(Math.min(USER_WEIGHT_MAX, Math.max(0, slice.userWeight)) * 10) / 10
            : defaults.userWeight;
    if (slice.userWeight !== weight) slice.userWeight = weight;
    return slice as DirectorSettings;
}
