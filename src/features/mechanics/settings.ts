// Settings slice of M25 «Механики» (`extensionSettings.maestro.modules.mechanics`): the book of new definitions, auto
// checks, the widgets strip, the prompt budget and depth, the background parse. Read and repaired in place (the
// returned object is the live slice the pult edits).
import { DEFAULT_MECHANICS_BOOK, DEFAULT_MECHANICS_SETTINGS } from './parts';
import type { MechanicsSettings } from './parts';

/** Limits of the numeric settings. */
export const PROMPT_BUDGET_LIMITS = { min: 50, max: 4000 } as const;
export const DEPTH_LIMITS = { min: 0, max: 20 } as const;

export function defaultMechanicsSettings(): MechanicsSettings {
    return { ...DEFAULT_MECHANICS_SETTINGS };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/** The live slice with every field repaired (wrong types → defaults, numbers clamped, an empty book → the default). */
export function readMechanicsSettings(slice: Partial<MechanicsSettings>): MechanicsSettings {
    const defaults = defaultMechanicsSettings();
    slice.book = typeof slice.book === 'string' && slice.book.trim() ? slice.book.trim() : DEFAULT_MECHANICS_BOOK;
    for (const key of ['autoChecks', 'strip', 'background'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    slice.promptBudget = clampInt(
        slice.promptBudget,
        PROMPT_BUDGET_LIMITS.min,
        PROMPT_BUDGET_LIMITS.max,
        defaults.promptBudget,
    );
    slice.depth = clampInt(slice.depth, DEPTH_LIMITS.min, DEPTH_LIMITS.max, defaults.depth);
    return slice as MechanicsSettings;
}
