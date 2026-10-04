// Settings slice of M16 «Закулисье» (`extensionSettings.maestro.modules.offscreen`) and the module's constants. Plan
// §12: off in «Экономный» (not configurable), every 15 committed turns in «Сбалансированный», every 10 and at scene ends
// in «Кино»; the user may change the numbers per mode.
import type { ActiveMode } from '../../domain/offscreen-plan';
import { ACTIVE_MODES } from '../../domain/offscreen-plan';
import type { CanonOrigin } from '../canon/api';

export const OFFSCREEN_KEY = 'offscreen';
export const OFFSCREEN_ID = 'M16';
/** Background task kind (app.tasks) and its dedupe key (one pending run per chat). */
export const OFFSCREEN_TASK = 'offscreen.run';
export const OFFSCREEN_DEDUPE = 'offscreen';
/** LLM task (picks the connection profile, labels the cost). */
export const OFFSCREEN_LLM_TASK = 'offscreen';
/** Autonomy and Inbox kind of an event. */
export const OFFSCREEN_KIND = 'offscreen.event';
/** Journal target of an event (undo removes its canon item). */
export const OFFSCREEN_TARGET = 'offscreen.event';
/** Per-chat document: the turn counter, last sightings, events, runs. */
export const OFFSCREEN_DOC = 'offscreen';
export const OFFSCREEN_TAB = 'offscreen';
/** Ephemeral injection key of a rumour (`maestro_offscreen`). */
export const OFFSCREEN_INJECTION = 'offscreen';
/**
 * Canon origin of the events. CanonOrigin has no 'offscreen'; 'backstage' is this module («Закулисье», shown as
 * «закулисье» in the canon tab), so the items read back with their true origin.
 */
export const OFFSCREEN_ORIGIN: CanonOrigin = 'backstage';

export interface OffscreenSettings {
    /** Committed turns between automatic runs per mode; 0 = no automatic runs. «Экономный» never runs. */
    every: Record<ActiveMode, number>;
    /** A finished scene starts a run (plan: «Кино»). */
    sceneEnd: Record<ActiveMode, boolean>;
    /** Characters per run (plan: up to three). */
    maxCharacters: number;
    /** Turns a character must be away from the scene before an event (default 5). */
    minAbsentTurns: number;
    /** Present characters may mention a rumour of an event (one-shot note near the end of the prompt). */
    rumours: boolean;
}

export const EVERY_MAX = 100;
export const MAX_CHARACTERS = 3;
export const ABSENT_MAX = 100;

export function defaultOffscreenSettings(): OffscreenSettings {
    return {
        every: { balanced: 15, cinema: 10 },
        sceneEnd: { balanced: false, cinema: true },
        maxCharacters: 3,
        minAbsentTurns: 5,
        rumours: true,
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
export function readOffscreenSettings(slice: Partial<OffscreenSettings>): OffscreenSettings {
    const defaults = defaultOffscreenSettings();
    if (!isDict(slice.every)) slice.every = { ...defaults.every };
    if (!isDict(slice.sceneEnd)) slice.sceneEnd = { ...defaults.sceneEnd };
    const every = slice.every as Record<string, unknown>;
    const sceneEnd = slice.sceneEnd as Record<string, unknown>;
    for (const mode of ACTIVE_MODES) {
        const value = intIn(every[mode], 0, EVERY_MAX, defaults.every[mode]);
        if (every[mode] !== value) every[mode] = value;
        if (typeof sceneEnd[mode] !== 'boolean') sceneEnd[mode] = defaults.sceneEnd[mode];
    }
    const max = intIn(slice.maxCharacters, 1, MAX_CHARACTERS, defaults.maxCharacters);
    if (slice.maxCharacters !== max) slice.maxCharacters = max;
    const absent = intIn(slice.minAbsentTurns, 1, ABSENT_MAX, defaults.minAbsentTurns);
    if (slice.minAbsentTurns !== absent) slice.minAbsentTurns = absent;
    if (typeof slice.rumours !== 'boolean') slice.rumours = defaults.rumours;
    return slice as OffscreenSettings;
}
