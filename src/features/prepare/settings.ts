// Settings slice of M37 «Подготовить к игре» (`extensionSettings.maestro.modules.prepare`) and the module's constants.
import type { PrepareScope } from '../../domain/prepare-plan';

export const PREPARE_KEY = 'prepare';
export const PREPARE_ID = 'M37';
export const PREPARE_TAB = 'prepare';
/** Per-chat document: the plan and what was applied. */
export const PREPARE_DOC = 'prepare';
/** Kind of a Maestro file of the saved character-level preparation (one per card avatar). */
export const SAVED_FILE_KIND = 'prepare-card';
/** Journal target of one step of an applied item (canon entry, place, passport, mechanic…). */
export const PREPARE_STEP_TARGET = 'prepare.step';
/** Journal kinds: one applied item; one item of the saved preparation applied to a new chat. */
export const APPLY_KIND = 'prepare.apply';
export const IMPORT_KIND = 'prepare.import';
/** Book name prefix of the card's Maestro book («для персонажа»). */
export const CARD_BOOK_PREFIX = 'Maestro · подготовка · ';

export interface PrepareSettings {
    /** Offer preparation in new chats (the strip under the greeting, second wave). */
    offer: boolean;
    /** Scope of a new item (plan-2 В20: «для чата»). */
    defaultScope: PrepareScope;
    /** Characters of sources per request. */
    chunkChars: number;
    /** Requests per run at most. */
    maxChunks: number;
    /** Characters of one book entry at most. */
    entryChars: number;
    /** Answer tokens per request. */
    maxTokens: number;
    /** Generate NAI passports (text, never Anlas) for characters without one. */
    passports: boolean;
    /** Put the prepared starting scenes into DES's tracker of the greetings (release 1.18). */
    desSeed: boolean;
}

export const LIMITS = {
    chunkChars: { min: 4000, max: 80000 },
    maxChunks: { min: 1, max: 30 },
    entryChars: { min: 300, max: 8000 },
    maxTokens: { min: 1000, max: 16000 },
} as const;

export function defaultPrepareSettings(): PrepareSettings {
    return {
        offer: true,
        defaultScope: 'chat',
        chunkChars: 24000,
        maxChunks: 8,
        entryChars: 2500,
        maxTokens: 6000,
        passports: true,
        desSeed: true,
    };
}

function clamp(value: unknown, limit: { min: number; max: number }, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(limit.min, Math.min(limit.max, Math.round(value)));
}

/** The stored slice, repaired in place (a hand-edited settings file never breaks the module). */
export function readPrepareSettings(slice: Partial<PrepareSettings>): PrepareSettings {
    const raw = slice as Record<string, unknown>;
    const defaults = defaultPrepareSettings();
    if (typeof raw.offer !== 'boolean') raw.offer = defaults.offer;
    if (raw.defaultScope !== 'chat' && raw.defaultScope !== 'character') raw.defaultScope = defaults.defaultScope;
    for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
        const value = clamp(raw[key], LIMITS[key], defaults[key]);
        if (raw[key] !== value) raw[key] = value;
    }
    if (typeof raw.passports !== 'boolean') raw.passports = defaults.passports;
    if (typeof raw.desSeed !== 'boolean') raw.desSeed = defaults.desSeed;
    return slice as PrepareSettings;
}
