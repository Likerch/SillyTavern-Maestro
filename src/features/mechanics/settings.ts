// Settings slice of M25 «Механики» (`extensionSettings.maestro.modules.mechanics`): the book of new definitions, auto
// checks, the widgets strip, the prompt budget and depth, the background parse. Read and repaired in place (the
// returned object is the live slice the pult edits).
import { DEFAULT_MECHANICS_BOOK, DEFAULT_MECHANICS_SETTINGS } from './parts';
import type { MechanicsSettings } from './parts';

/** Limits of the numeric settings. */
export const PROMPT_BUDGET_LIMITS = { min: 50, max: 4000 } as const;
export const DEPTH_LIMITS = { min: 0, max: 20 } as const;
export const RELEVANCE_LIMITS = { min: 1, max: 20 } as const;

/** Pinned attributes and characters kept at most. */
export const PIN_LIMIT = 40;

export function defaultMechanicsSettings(): MechanicsSettings {
    return {
        ...DEFAULT_MECHANICS_SETTINGS,
        hudAttrs: [...DEFAULT_MECHANICS_SETTINGS.hudAttrs],
        hudHolders: [...DEFAULT_MECHANICS_SETTINGS.hudHolders],
        desAttrs: [...DEFAULT_MECHANICS_SETTINGS.desAttrs],
    };
}

/** Unique non-empty strings (pins), at most PIN_LIMIT. */
function pins(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || !item.trim() || out.includes(item.trim())) continue;
        out.push(item.trim());
        if (out.length >= PIN_LIMIT) break;
    }
    return out;
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
    for (const key of ['modelRolls', 'autoCombat'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    if (slice.personaFallback !== 'background' && slice.personaFallback !== 'block') {
        slice.personaFallback = defaults.personaFallback;
    }
    slice.relevance = clampInt(slice.relevance, RELEVANCE_LIMITS.min, RELEVANCE_LIMITS.max, defaults.relevance);
    for (const key of ['hud', 'desPersona'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    for (const key of ['hudAttrs', 'hudHolders', 'desAttrs'] as const) {
        const clean = pins(slice[key]);
        if (!Array.isArray(slice[key]) || clean.length !== slice[key].length) slice[key] = clean;
    }
    return slice as MechanicsSettings;
}
