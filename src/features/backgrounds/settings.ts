// Settings slice of M29 «Фоны» (`extensionSettings.maestro.modules.backgrounds`): automatic changes on/off, the score
// a library match needs, and whether time of day and weather pick variants.
import { DEFAULT_THRESHOLD } from '../../domain/backgrounds-score';

export const BACKGROUNDS_KEY = 'backgrounds';
export const BACKGROUNDS_ID = 'M29';
/** Autonomy kind of an automatic chat background change (plan §8: «Само»). */
export const SET_KIND = 'backgrounds.set';
/** Journal kinds of the user's own actions in the pult. */
export const PICK_KIND = 'backgrounds.pick';
export const GENERATE_KIND = 'backgrounds.generate';
/** Journal target of a chat background change (undo restores the previous value or clears it). */
export const CHAT_BG_TARGET = 'chat-background';
/** Chat metadata pointer (`chatMetadata.maestro.pointers.backgrounds`): what Maestro set in this chat. */
export const POINTER = 'backgrounds';

export const THRESHOLD_MIN = 1;
export const THRESHOLD_MAX = 10;

export interface BackgroundsSettings {
    /** Change the chat background by place, time and weather on its own (library only; generation is a button). */
    auto: boolean;
    /** Score a library match needs to be set automatically. */
    threshold: number;
    /** Time of day, weather and season pick variants of a background. */
    variants: boolean;
}

export function defaultBackgroundsSettings(): BackgroundsSettings {
    return { auto: true, threshold: DEFAULT_THRESHOLD, variants: true };
}

/** The live slice, repaired in place (it is the object the pult edits). */
export function readBackgroundsSettings(slice: Partial<BackgroundsSettings>): BackgroundsSettings {
    const defaults = defaultBackgroundsSettings();
    if (typeof slice.auto !== 'boolean') slice.auto = defaults.auto;
    if (typeof slice.variants !== 'boolean') slice.variants = defaults.variants;
    const threshold = slice.threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) slice.threshold = defaults.threshold;
    else if (threshold < THRESHOLD_MIN || threshold > THRESHOLD_MAX) {
        slice.threshold = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, threshold));
    }
    return slice as BackgroundsSettings;
}
