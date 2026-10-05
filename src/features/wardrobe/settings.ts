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
} as const;

/** Journal kind of an outfit put on by hand in the pult. */
export const WARDROBE_WEAR_KIND = 'wardrobe.wear';

/** Journal target of every passport change of the wardrobe (one undo handler). */
export const WARDROBE_UNDO_TARGET = 'wardrobe.passport';

export interface WardrobeSettings {
    /** New outfits from the DES tracker and the revision's deferred cards become named outfits and are put on. */
    outfits: boolean;
    /** Character states (wet, wounded, tired …) follow the tracker. */
    states: boolean;
    /** Place states (ruined, on fire, night, rain …) go to the location passport. */
    places: boolean;
}

export function defaultWardrobeSettings(): WardrobeSettings {
    return { outfits: true, states: true, places: true };
}

/** The live slice, repaired in place (it is the object the pult edits). */
export function readWardrobeSettings(slice: Partial<WardrobeSettings>): WardrobeSettings {
    const defaults = defaultWardrobeSettings();
    for (const key of Object.keys(defaults) as (keyof WardrobeSettings)[]) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    return slice as WardrobeSettings;
}
