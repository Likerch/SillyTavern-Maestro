// Settings slice of the wardrobe (`extensionSettings.maestro.modules.wardrobe`): which parts work by themselves.
// How a change is confirmed (auto, Inbox, …) is the autonomy level of its kind in the core settings.
export const WARDROBE_KEY = 'wardrobe';
export const WARDROBE_ID = 'M27';
/** Per-chat document kind. */
export const WARDROBE_DOC = 'wardrobe';

/** Autonomy kinds (plan §8 «Наряды и состояния в паспортах уровня чата — Само»). */
export const WARDROBE_KINDS = {
    outfit: 'wardrobe.outfit',
    state: 'wardrobe.state',
    place: 'wardrobe.placeState',
    /** The «Одежда» field in DES's tracker: it changes another extension's settings, so it asks by default. */
    desField: 'wardrobe.desField',
} as const;

/** Journal kind of an outfit put on by hand in the pult. */
export const WARDROBE_WEAR_KIND = 'wardrobe.wear';

/** Journal kind of «Переодеть сейчас» (by hand, from a message, from the model). */
export const WARDROBE_WEAR_NOW_KIND = 'wardrobe.wearNow';

/** Journal target of «что надето сейчас» changed by «Переодеть сейчас». */
export const WARDROBE_CURRENT_TARGET = 'wardrobe.current';

/** Journal target of every passport change of the wardrobe (one undo handler). */
export const WARDROBE_UNDO_TARGET = 'wardrobe.passport';

/** Journal target of the DES tracker field Maestro added. */
export const DES_FIELD_UNDO_TARGET = 'wardrobe.desField';

/** Background task: what the user's character wears, from the chat (strict JSON). */
export const PERSONA_TASK = 'wardrobe.persona';

/** Background task: what the people of a change of clothes a message said wear now (strict JSON). */
export const CHANGE_TASK = 'wardrobe.change';

/** «Что надето сейчас» record key of the user's character. */
export const PERSONA_KEY = 'persona';

/** Ephemeral injection key of the prompt line (extension prompt slot `maestro_wardrobe`). */
export const WARDROBE_INJECTION = 'wardrobe';

export interface WardrobeSettings {
    /** New outfits from the DES tracker and the revision's deferred cards become named outfits and are put on. */
    outfits: boolean;
    /** Character states (wet, wounded, tired …) follow the tracker. */
    states: boolean;
    /** Place states (ruined, on fire, night, rain …) go to the location passport. */
    places: boolean;
    /** A short line «who wears what» near the end of the prompt (present characters and the persona). */
    promptLine: boolean;
    /** In-chat depth of that line. */
    promptDepth: number;
    /** NAI Studio redraws the DES portrait when a character's outfit changes. */
    redrawPortrait: boolean;
    /** The background model reads what the user's character wears (only when the chat speaks of clothes). */
    persona: boolean;
    /** At most every this many committed turns (only while «Переодевание по сообщениям» is off). */
    personaEvery: number;
    /**
     * «Переодевание по сообщениям»: a change of clothes the player's message or the narration says is applied at once
     * (the reply is written in the new clothes); what the text does not tell, the model reads after the reply.
     */
    triggers: boolean;
    /** «Записывать одежду в трекер DES»: the clothing field (or the appearance with clothes) of the character. */
    desWrite: boolean;
    /** «Переодеться» at the Maestro button at the message box. */
    composer: boolean;
}

export function defaultWardrobeSettings(): WardrobeSettings {
    return {
        outfits: true,
        states: true,
        places: true,
        promptLine: true,
        promptDepth: 1,
        redrawPortrait: true,
        persona: true,
        personaEvery: 6,
        triggers: true,
        desWrite: true,
        composer: true,
    };
}

const NUMBERS: Readonly<Partial<Record<keyof WardrobeSettings, readonly [number, number]>>> = {
    promptDepth: [0, 20],
    personaEvery: [1, 50],
};

/** The live slice, repaired in place (it is the object the pult edits). */
export function readWardrobeSettings(slice: Partial<WardrobeSettings>): WardrobeSettings {
    const defaults = defaultWardrobeSettings();
    const target = slice as Record<string, unknown>;
    for (const key of Object.keys(defaults) as (keyof WardrobeSettings)[]) {
        const fallback = defaults[key];
        const range = NUMBERS[key];
        if (range) {
            const value = target[key];
            target[key] =
                typeof value === 'number' && Number.isFinite(value)
                    ? Math.min(range[1], Math.max(range[0], Math.round(value)))
                    : fallback;
        } else if (typeof target[key] !== 'boolean') target[key] = fallback;
    }
    return slice as WardrobeSettings;
}
