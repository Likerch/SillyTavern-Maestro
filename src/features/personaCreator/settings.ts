// Settings of M41 «Персона для персонажа»: the dialog's checkboxes as the user left them last time («Сделать текущей»
// is never remembered: it starts off every time) and how much lore the model reads.
import { DEFAULT_LORE_CHARS } from '../../domain/persona-create';

export const PERSONA_CREATOR_KEY = 'personaCreator';
export const PERSONA_CREATOR_ID = 'M41';

export interface PersonaCreatorSettings {
    /** «Паспорт NAI» starts checked. */
    passport: boolean;
    /** «Картинка (бесплатно)» starts checked. */
    picture: boolean;
    /** «Связать с этим персонажем» starts checked. */
    link: boolean;
    /** Characters of lore the model reads (entries about the world and the player's role first). */
    loreChars: number;
}

export function defaultPersonaCreatorSettings(): PersonaCreatorSettings {
    return { passport: true, picture: true, link: true, loreChars: DEFAULT_LORE_CHARS };
}

const MIN_LORE_CHARS = 0;
const MAX_LORE_CHARS = 40000;

/** The settings slice with junk values replaced by the defaults (in place). */
export function readPersonaCreatorSettings(slice: Partial<PersonaCreatorSettings>): PersonaCreatorSettings {
    const defaults = defaultPersonaCreatorSettings();
    for (const key of ['passport', 'picture', 'link'] as const) {
        if (typeof slice[key] !== 'boolean') slice[key] = defaults[key];
    }
    const chars = slice.loreChars;
    slice.loreChars =
        typeof chars === 'number' && Number.isFinite(chars)
            ? Math.min(MAX_LORE_CHARS, Math.max(MIN_LORE_CHARS, Math.floor(chars)))
            : defaults.loreChars;
    return slice as PersonaCreatorSettings;
}
