// Settings slice of M15 (`extensionSettings.maestro.modules.voices`). The token cap applies only while the architect
// (M20) has no 'voices' budget; goals and attitudes between present characters can be left out of the cards.
export const VOICES_KEY = 'voices';
export const VOICES_ID = 'M15';
export const DEFAULT_CAP = 600;
export const MIN_CAP = 100;
export const MAX_CAP = 4000;

export interface VoicesSettings {
    /** Tokens for all cards together when the architect has no 'voices' budget. */
    cap: number;
    /** Notable attitudes between present characters (M19), at most three lines. */
    npcAttitudes: boolean;
    /** Current goals (DES detail fields, open quests that name the character). */
    goals: boolean;
}

export function defaultVoicesSettings(): VoicesSettings {
    return { cap: DEFAULT_CAP, npcAttitudes: true, goals: true };
}

export function cleanCap(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CAP;
    return Math.max(MIN_CAP, Math.min(MAX_CAP, Math.round(value)));
}

/** The stored slice, repaired in place (a hand-edited settings file never breaks the module). */
export function readVoicesSettings(slice: Partial<VoicesSettings>): VoicesSettings {
    const defaults = defaultVoicesSettings();
    const raw = slice as Record<string, unknown>;
    if (raw.cap !== cleanCap(raw.cap)) raw.cap = cleanCap(raw.cap);
    if (typeof raw.npcAttitudes !== 'boolean') raw.npcAttitudes = defaults.npcAttitudes;
    if (typeof raw.goals !== 'boolean') raw.goals = defaults.goals;
    return slice as VoicesSettings;
}
