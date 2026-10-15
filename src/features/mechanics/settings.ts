// Settings slice of M25 «Механики» (`extensionSettings.maestro.modules.mechanics`): the book of new definitions, auto
// checks, the widgets strip, the prompt budget, where the rules go and the depth of the state, the background parse,
// rolls the model asks for and (1.27) whether the same reply continues with their result. Read and repaired in place
// (the returned object is the live slice the pult edits).
// Migrations run once by `settingsRev` (release 1.27, rev 1: the old default budget of 400 tokens — too small for the
// rules and the state of two mechanics — becomes 1200; the old `depth` of the one block is no longer read: the state
// starts at depth 0, the rules at the top of the prompt).
import { DEFAULT_MECHANICS_BOOK, DEFAULT_MECHANICS_SETTINGS, MECHANICS_SETTINGS_REV } from './parts';
import type { MechanicsSettings } from './parts';

/** Limits of the numeric settings. */
export const PROMPT_BUDGET_LIMITS = { min: 50, max: 4000 } as const;
export const DEPTH_LIMITS = { min: 0, max: 20 } as const;
export const RELEVANCE_LIMITS = { min: 1, max: 20 } as const;
/** The default budget before release 1.27 (a saved one is raised to the new default once). */
export const OLD_DEFAULT_BUDGET = 400;

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

/** Runs the migrations a slice of an older revision has not had yet (once: the revision is stored with it). */
function migrate(slice: Partial<MechanicsSettings>): void {
    const rev = typeof slice.settingsRev === 'number' && Number.isFinite(slice.settingsRev) ? slice.settingsRev : 0;
    if (rev >= MECHANICS_SETTINGS_REV) return;
    if (rev < 1 && slice.promptBudget === OLD_DEFAULT_BUDGET)
        slice.promptBudget = DEFAULT_MECHANICS_SETTINGS.promptBudget;
    slice.settingsRev = MECHANICS_SETTINGS_REV;
}

/** The live slice with every field repaired (wrong types → defaults, numbers clamped, an empty book → the default). */
export function readMechanicsSettings(slice: Partial<MechanicsSettings>): MechanicsSettings {
    const defaults = defaultMechanicsSettings();
    migrate(slice);
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
    if (slice.rulesPlace !== 'top' && slice.rulesPlace !== 'end') slice.rulesPlace = defaults.rulesPlace;
    slice.stateDepth = clampInt(slice.stateDepth, DEPTH_LIMITS.min, DEPTH_LIMITS.max, defaults.stateDepth);
    for (const key of ['modelRolls', 'autoCombat'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    if (typeof slice.rollContinue !== 'boolean') slice.rollContinue = defaults.rollContinue;
    if (slice.personaFallback !== 'background' && slice.personaFallback !== 'block') {
        slice.personaFallback = defaults.personaFallback;
    }
    slice.relevance = clampInt(slice.relevance, RELEVANCE_LIMITS.min, RELEVANCE_LIMITS.max, defaults.relevance);
    for (const key of ['hud', 'desPersona'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    if (slice.hudPlacement !== 'chat' && slice.hudPlacement !== 'left' && slice.hudPlacement !== 'right') {
        slice.hudPlacement = defaults.hudPlacement;
    }
    if (slice.hudSideView !== 'compact' && slice.hudSideView !== 'full') slice.hudSideView = defaults.hudSideView;
    for (const key of ['hudAttrs', 'hudHolders', 'desAttrs'] as const) {
        const clean = pins(slice[key]);
        if (!Array.isArray(slice[key]) || clean.length !== slice[key].length) slice[key] = clean;
    }
    return slice as MechanicsSettings;
}
