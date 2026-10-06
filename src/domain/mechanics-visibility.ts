// M25 «Механики», where a mechanic is seen (plan-2 §6.А «Где и как видны механики»): per mechanic and per attribute a
// visibility — what the model knows (`prompt`: the value, words by thresholds, nothing), how the model may mention
// changes in its text (`mention`), the places the player sees it (HUD, the change line under a reply, narrator
// messages, the status block, under DES portraits, the dossier) and the view there (number, bar, words, icon, hidden).
// Four presets fill every field (В21: new mechanics and templates «Игровой», the relationships template «Книжный»;
// В22: the status block and narrator messages are off in every preset):
//   game   — numbers and bars everywhere, the model gets values and may name numbers;
//   book   — no numbers for the player (words), no HUD values, the model gets values and speaks in words;
//   hidden — the player sees nothing until an event or the user reveals it; the model gets the value (or words);
//   secret — neither the player nor the model: Maestro applies consequences and gives the model only outcomes.
// Also the word bands of a value ("mana: low") and the English lines that tell the model how to mention changes.
// Pure: no DOM, no SillyTavern.

export type VisibilityPreset = 'game' | 'book' | 'hidden' | 'secret';
export type PromptVisibility = 'value' | 'words' | 'none';
export type MentionVisibility = 'none' | 'words' | 'numbers';
export type VisibilityPlace = 'hud' | 'strip' | 'narrator' | 'statusBlock' | 'des' | 'dossier';
export type ValueView = 'number' | 'bar' | 'words' | 'icon' | 'hidden';

/** One band of words: numbers up to `upTo` (inclusive; the last band may leave it out), or one scale level. */
export interface WordLevel {
    upTo?: number;
    level?: string;
    /** English, for the model ("badly hurt"). */
    label: string;
    /** For the player in the UI language («тяжело ранен»); absent → `label`. */
    display?: string;
}

export interface Visibility {
    preset: VisibilityPreset;
    prompt: PromptVisibility;
    mention: MentionVisibility;
    places: Record<VisibilityPlace, boolean>;
    view: ValueView;
    words?: WordLevel[];
}

/** Stored form: any subset; `preset` fills the rest. */
export type VisibilityInput = Partial<Omit<Visibility, 'places'>> & {
    places?: Partial<Record<VisibilityPlace, boolean>>;
};

export const VISIBILITY_PRESETS: readonly VisibilityPreset[] = ['game', 'book', 'hidden', 'secret'];
export const PROMPT_VISIBILITIES: readonly PromptVisibility[] = ['value', 'words', 'none'];
export const MENTION_VISIBILITIES: readonly MentionVisibility[] = ['none', 'words', 'numbers'];
export const VISIBILITY_PLACES: readonly VisibilityPlace[] = [
    'hud',
    'strip',
    'narrator',
    'statusBlock',
    'des',
    'dossier',
];
export const VALUE_VIEWS: readonly ValueView[] = ['number', 'bar', 'words', 'icon', 'hidden'];
export const DEFAULT_PRESET: VisibilityPreset = 'game';

/** What an attribute needs to pick a view and words: its kind and bounds. */
export interface VisibleAttribute {
    kind: 'number' | 'scale' | 'list' | 'text';
    min?: number;
    max?: number;
    levels?: string[];
    visible?: boolean;
    visibility?: VisibilityInput;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
    return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

function bounded(attribute: VisibleAttribute | undefined): boolean {
    return (
        attribute?.kind === 'number' &&
        typeof attribute.min === 'number' &&
        typeof attribute.max === 'number' &&
        attribute.max > attribute.min
    );
}

function places(on: readonly VisibilityPlace[]): Record<VisibilityPlace, boolean> {
    return Object.fromEntries(VISIBILITY_PLACES.map((place) => [place, on.includes(place)])) as Record<
        VisibilityPlace,
        boolean
    >;
}

/** Every field of a preset (the view follows the attribute: bars for bounded numbers in «game»). */
export function presetVisibility(preset: VisibilityPreset, attribute?: VisibleAttribute): Visibility {
    switch (preset) {
        case 'book':
            return {
                preset,
                prompt: 'value',
                mention: 'words',
                places: places(['strip', 'dossier']),
                view: attribute?.kind === 'list' || attribute?.kind === 'text' ? 'number' : 'words',
            };
        case 'hidden':
            // Where it shows once revealed: like «book».
            return {
                preset,
                prompt: 'value',
                mention: 'none',
                places: places(['strip', 'dossier']),
                view: attribute?.kind === 'list' || attribute?.kind === 'text' ? 'number' : 'words',
            };
        case 'secret':
            return { preset, prompt: 'none', mention: 'none', places: places([]), view: 'hidden' };
        default:
            return {
                preset: 'game',
                prompt: 'value',
                mention: 'numbers',
                places: places(['hud', 'strip', 'des', 'dossier']),
                view: bounded(attribute) ? 'bar' : 'number',
            };
    }
}

function normalizeWords(raw: unknown): WordLevel[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: WordLevel[] = [];
    for (const item of raw) {
        if (!isDict(item) || typeof item.label !== 'string' || !item.label.trim()) continue;
        const level: WordLevel = { label: item.label.trim() };
        if (typeof item.upTo === 'number' && Number.isFinite(item.upTo)) level.upTo = item.upTo;
        if (typeof item.level === 'string' && item.level.trim()) level.level = item.level.trim();
        if (typeof item.display === 'string' && item.display.trim()) level.display = item.display.trim();
        out.push(level);
    }
    return out.length ? out : undefined;
}

/** The stored subset, cleaned (unknown fields and values dropped); undefined when nothing is left. */
export function normalizeVisibilityInput(raw: unknown): VisibilityInput | undefined {
    if (typeof raw === 'string') {
        const preset = oneOf(VISIBILITY_PRESETS, raw);
        return preset ? { preset } : undefined;
    }
    if (!isDict(raw)) return undefined;
    const out: VisibilityInput = {};
    const preset = oneOf(VISIBILITY_PRESETS, raw.preset);
    if (preset) out.preset = preset;
    const prompt = oneOf(PROMPT_VISIBILITIES, raw.prompt);
    if (prompt) out.prompt = prompt;
    const mention = oneOf(MENTION_VISIBILITIES, raw.mention);
    if (mention) out.mention = mention;
    const view = oneOf(VALUE_VIEWS, raw.view);
    if (view) out.view = view;
    if (isDict(raw.places)) {
        const placesIn: Partial<Record<VisibilityPlace, boolean>> = {};
        for (const place of VISIBILITY_PLACES) {
            if (typeof raw.places[place] === 'boolean') placesIn[place] = raw.places[place] as boolean;
        }
        if (Object.keys(placesIn).length) out.places = placesIn;
    }
    const words = normalizeWords(raw.words);
    if (words) out.words = words;
    return Object.keys(out).length ? out : undefined;
}

function overlay(base: Visibility, input: VisibilityInput | undefined): Visibility {
    if (!input) return base;
    const out: Visibility = { ...base, places: { ...base.places } };
    if (input.prompt) out.prompt = input.prompt;
    if (input.mention) out.mention = input.mention;
    if (input.view) out.view = input.view;
    for (const place of VISIBILITY_PLACES) {
        const value = input.places?.[place];
        if (typeof value === 'boolean') out.places[place] = value;
    }
    if (input.words) out.words = input.words.map((word) => ({ ...word }));
    return out;
}

/**
 * The effective visibility of an attribute: its own preset (else the mechanic's, else «game») fills every field, then
 * the mechanic's explicit fields (when the attribute has no preset of its own), then the attribute's own fields. An
 * attribute hidden the old way (`visible: false`) is secret. Without an attribute: the mechanic's.
 */
export function resolveVisibility(
    mechanic: { visibility?: VisibilityInput } | undefined,
    attribute?: VisibleAttribute,
): Visibility {
    if (attribute?.visible === false) return presetVisibility('secret', attribute);
    const own = attribute?.visibility;
    const outer = mechanic?.visibility;
    const preset = own?.preset ?? outer?.preset ?? DEFAULT_PRESET;
    let result = presetVisibility(preset, attribute);
    if (!own?.preset) result = overlay(result, { ...outer, preset });
    return overlay(result, own);
}

/** A preset applied to a stored subset: the fields of the preset win (the user picked it now). */
export function withPreset(preset: VisibilityPreset, previous?: VisibilityInput): VisibilityInput {
    const out: VisibilityInput = { preset };
    if (previous?.words) out.words = previous.words.map((word) => ({ ...word }));
    return out;
}

/** The player may see it in this place now (hidden: only once revealed; secret: never). */
export function shownIn(visibility: Visibility, place: VisibilityPlace, revealed = false): boolean {
    if (visibility.preset === 'secret' || visibility.view === 'hidden') return false;
    if (visibility.preset === 'hidden' && !revealed) return false;
    return visibility.places[place] === true;
}

/** The player may see it anywhere (the pult's mechanics window always shows it; this is for the play surfaces). */
export function playerSees(visibility: Visibility, revealed = false): boolean {
    if (visibility.preset === 'secret' || visibility.view === 'hidden') return false;
    return visibility.preset !== 'hidden' || revealed;
}

/** The model may get something about it (value or words). */
export function modelKnows(visibility: Visibility): boolean {
    return visibility.prompt !== 'none';
}

/* ------------------------------------------------------------------ words */

/** Default bands of a bounded number, by share of the range (English for the model). */
export const DEFAULT_WORDS: readonly { share: number; label: string }[] = [
    { share: 0, label: 'none left' },
    { share: 0.2, label: 'very low' },
    { share: 0.45, label: 'low' },
    { share: 0.7, label: 'moderate' },
    { share: 0.95, label: 'high' },
    { share: 1, label: 'full' },
];

export interface WordsOf {
    /** English for the model. */
    label: string;
    /** For the player; absent: the default band (`band` is its index into DEFAULT_WORDS) or the label itself. */
    display?: string;
    band?: number;
}

/**
 * The words of a value: the attribute's bands (numbers by `upTo`, scales by `level`), else for bounded numbers the
 * default bands by share of the range, scales their level, lists and texts as they are; null when there are none.
 */
export function wordsFor(
    attribute: VisibleAttribute,
    visibility: Pick<Visibility, 'words'>,
    value: number | string | string[] | null | undefined,
): WordsOf | null {
    if (value === null || value === undefined) return null;
    const words = visibility.words ?? [];
    if (attribute.kind === 'number') {
        const number = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(number)) return null;
        const bands = words.filter((word) => word.upTo !== undefined).sort((a, b) => (a.upTo ?? 0) - (b.upTo ?? 0));
        const open = words.find((word) => word.upTo === undefined && word.level === undefined);
        if (bands.length || open) {
            const band = bands.find((word) => number <= (word.upTo as number)) ?? open ?? bands[bands.length - 1];
            if (band) return band.display ? { label: band.label, display: band.display } : { label: band.label };
        }
        if (!bounded(attribute)) return null;
        const share = (number - (attribute.min as number)) / ((attribute.max as number) - (attribute.min as number));
        const index = DEFAULT_WORDS.findIndex((band) => share <= band.share + 1e-9);
        const at = index < 0 ? DEFAULT_WORDS.length - 1 : index;
        return { label: (DEFAULT_WORDS[at] as { label: string }).label, band: at };
    }
    if (attribute.kind === 'scale') {
        const level = String(value);
        const word = words.find((item) => item.level !== undefined && item.level.toLowerCase() === level.toLowerCase());
        if (word) return word.display ? { label: word.label, display: word.display } : { label: word.label };
        return { label: level };
    }
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    return text ? { label: text } : null;
}

/* ------------------------------------------------------------------ mentions */

export interface MentionGroup {
    mention: MentionVisibility;
    /** English attribute names. */
    names: string[];
}

const MENTION_TEXT: Record<MentionVisibility, string> = {
    numbers: 'may be stated with numbers (e.g. "-15 mana")',
    words: 'in words only, never as numbers',
    none: 'never mentioned; let them show only through behaviour',
};

/**
 * The English line that tells the model how to mention changes: "Changes: mana, health may be stated with numbers…;
 * attitude in words only, never as numbers." '' when there is nothing to say.
 */
export function mentionLine(groups: readonly MentionGroup[]): string {
    const parts = groups
        .filter((group) => group.names.length)
        .map((group) => `${group.names.join(', ')} ${MENTION_TEXT[group.mention]}`);
    return parts.length ? `Changes: ${parts.join('; ')}.` : '';
}
