// Settings slice of M32 «Стиль сообщений» (`extensionSettings.maestro.modules.messageStyle`): on/off, the preset the
// rules came from, the rules, the player's look and the model hint. Repaired in place on every read, so the editor
// always works on valid data; objects are replaced only when they were broken (the editor keeps its references).
import {
    DEFAULT_PRESET,
    defaultPlayerStyle,
    isPresetId,
    normalizePlayer,
    normalizeRules,
    presetRules,
} from '../../domain/message-style';
import type { PlayerStyle, PresetId, StyleRule } from '../../domain/message-style';

export const MESSAGE_STYLE_KEY = 'messageStyle';
export const MESSAGE_STYLE_ID = 'M32m';

export interface MessageStyleSettings {
    /** Style messages at all (the page class, the stylesheet and the formatter hook). */
    enabled: boolean;
    /** The preset the rules came from («changed» is shown when they differ from it). */
    preset: PresetId;
    rules: StyleRule[];
    player: PlayerStyle;
    /** Tell the model the format (an ephemeral system note at depth 1). Off by default: it changes the prompt. */
    hint: boolean;
}

export function defaultMessageStyleSettings(): MessageStyleSettings {
    return {
        enabled: true,
        preset: DEFAULT_PRESET,
        rules: presetRules(DEFAULT_PRESET),
        player: defaultPlayerStyle(),
        hint: false,
    };
}

/** The live slice, repaired in place (it is the object the editor edits). */
export function readMessageStyleSettings(slice: Partial<MessageStyleSettings>): MessageStyleSettings {
    if (typeof slice.enabled !== 'boolean') slice.enabled = true;
    if (!isPresetId(slice.preset)) slice.preset = DEFAULT_PRESET;
    if (!Array.isArray(slice.rules)) {
        slice.rules = presetRules(slice.preset);
    } else {
        const rules = normalizeRules(slice.rules);
        if (JSON.stringify(rules) !== JSON.stringify(slice.rules)) slice.rules = rules;
    }
    const player = normalizePlayer(slice.player);
    if (JSON.stringify(player) !== JSON.stringify(slice.player)) slice.player = player;
    if (typeof slice.hint !== 'boolean') slice.hint = false;
    return slice as MessageStyleSettings;
}
