// M42 «Служебный режим» (ex-«Мастерская», renamed in 1.24; the key stays `workshop`): the public face of the module
// (app.modules.api<WorkshopApi>('workshop'), MAESTRO_API.workshop).
import { DEFAULT_WORKSHOP_TAGS, WORKSHOP_LORE_MODES, migrateWorkshopTags } from '../../domain/workshop';
import type { WorkshopLore } from '../../domain/workshop';
import type { Unsubscribe } from '../../shared/contracts';

export const WORKSHOP_KEY = 'workshop';
export const WORKSHOP_ID = 'M42';

/**
 * Modules that keep running in a workshop chat: tools and looks, nothing that reads or shapes the story. Every other
 * module (a later one too) is paused there — it starts again when a story chat opens.
 */
export const WORKSHOP_KEEPS: readonly string[] = [
    WORKSHOP_KEY,
    'theme',
    'dock',
    'messageStyle',
    'presetStudio',
    'neighbourPrompts',
    'promptAudit',
    'assistant',
    'loreStudio',
    'bookRoles',
    'guardian',
    'treasurer',
    'wizard',
    'personaCreator',
];

export interface WorkshopSettings {
    /** Tag names that make a card a service card; the first is the one the button sets. */
    tags: string[];
    /**
     * The tag list was checked against the defaults of this version (WORKSHOP_TAGS_VERSION): the old default
     * «мастерская, workshop» became «служебная, мастерская, workshop» once. Not in defaults(): fillDefaults would add it
     * to an older stored slice before the check.
     */
    tagsVersion?: number;
    /** The preset a workshop chat switches to ('' = the preset stays as it is). */
    preset: string;
    /** Lorebooks left in a workshop chat. */
    lore: WorkshopLore;
    /** Qvink is switched off for workshop chats (its per-chat switch); back on when the card leaves the workshop. */
    qvink: boolean;
    /** A short notice when a workshop chat opens. */
    notice: boolean;
}

/** The co-author preset (presets/Мастерская.json; Officina's co-author chat uses it too): its name did not change. */
export const DEFAULT_WORKSHOP_PRESET = 'Мастерская';
/** Version of the default tag list (2: «служебная» first, release 1.24). */
export const WORKSHOP_TAGS_VERSION = 2;

export function defaultWorkshopSettings(): WorkshopSettings {
    return {
        tags: [...DEFAULT_WORKSHOP_TAGS],
        preset: DEFAULT_WORKSHOP_PRESET,
        lore: 'own',
        qvink: true,
        notice: true,
    };
}

/** Repairs the stored slice in place (older or hand-edited settings) and returns it typed. */
export function readWorkshopSettings(slice: Partial<WorkshopSettings>): WorkshopSettings {
    const tags = Array.isArray(slice.tags)
        ? slice.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : [];
    slice.tags = tags.length ? tags : [...DEFAULT_WORKSHOP_TAGS];
    // Once: the old default list becomes the new one; the user's own list stays (it is saved with ST's next save).
    if (slice.tagsVersion !== WORKSHOP_TAGS_VERSION) {
        slice.tags = migrateWorkshopTags(slice.tags);
        slice.tagsVersion = WORKSHOP_TAGS_VERSION;
    }
    if (typeof slice.preset !== 'string') slice.preset = DEFAULT_WORKSHOP_PRESET;
    if (!WORKSHOP_LORE_MODES.includes(slice.lore as WorkshopLore)) slice.lore = 'own';
    if (typeof slice.qvink !== 'boolean') slice.qvink = true;
    if (typeof slice.notice !== 'boolean') slice.notice = true;
    return slice as WorkshopSettings;
}

export interface WorkshopApi {
    /** The chat open now belongs to a workshop card. */
    active(): boolean;
    /** The preset a workshop chat switches to: the setting while active, else null. */
    preset(): string | null;
    /** The card (avatar file) carries a service tag. */
    isWorkshopCard(avatar: string): boolean;
    /**
     * Sets or removes the service tag of a card; false when ST did not take it. `by`: the journal module of the change
     * (default M42; MAESTRO_API passes the neighbour's), `quiet`: no notice when ST refuses (the caller reports it).
     */
    setCard(avatar: string, on: boolean, options?: { by?: string; quiet?: boolean }): Promise<boolean>;
    /** Called when `active()` flips (a promise is awaited up to WORKSHOP_LISTENER_TIMEOUT_MS on a chat switch). */
    onChange(listener: (active: boolean) => void | Promise<void>): Unsubscribe;
}

/** How long a chat switch waits for a listener of a flip (Dramatis pausing its modules). */
export const WORKSHOP_LISTENER_TIMEOUT_MS = 1500;
