// Offscreen (M16): reading the model's answer item by item (a broken item does not spoil the others), the rules'
// safety net for «drastic» events (plan M16 п.5: never kill or remove an important character without the Inbox — the
// model's own flag is not trusted alone, P4), and the canon entry an event becomes: «Offscreen (<story time>): <text>»
// with the character's name and Russian forms as keys. Pure: no DOM, no SillyTavern.
import { uniqueStrings } from './canon-keys';
import { invalidKeys } from './revision-checks';
import { normalizeName } from './world-names';

export interface ParsedOffscreen {
    /** Canonical name (one of the requested ones). */
    character: string;
    /** English, 1–3 sentences. */
    text: string;
    /** New whereabouts, when the character moved. */
    location?: string;
    rumour?: string;
    /** The model's flag or the rules' verdict. */
    drastic: boolean;
    /** The rules found a drastic event the model did not flag. */
    drasticByRules: boolean;
}

export interface OffscreenParseResult {
    events: ParsedOffscreen[];
    /** Items that could not be read (unknown character, empty text, not an object, a second item of one character). */
    invalid: number;
}

export const MAX_TEXT_CHARS = 600;
export const MAX_SENTENCES = 3;
const MAX_LOCATION = 120;
const MAX_RUMOUR = 240;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** «true», "yes", 1 → true; anything else false. */
export function readFlag(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    return typeof value === 'string' && /^(true|yes|1)$/i.test(value.trim());
}

/** The first `max` sentences, at most `maxChars` (whitespace collapsed, wrapping quotes dropped). */
export function cleanEventText(text: string, max = MAX_SENTENCES, maxChars = MAX_TEXT_CHARS): string {
    const value = str(text)
        .replace(/^["“«'](.*)["”»']$/s, '$1')
        .trim();
    if (!value) return '';
    const sentences = value.split(/(?<=[.!?…])\s+(?=["“«(]?[A-ZА-ЯЁ0-9])/u);
    return clip(sentences.slice(0, Math.max(1, max)).join(' '), maxChars);
}

/** Empty-ish values the model writes instead of "": «none», «n/a», «unchanged», «-». */
function meaningful(value: string): string {
    return /^(none|n\/a|na|null|nothing|unchanged|same|same place|-+|—)$/i.test(value) ? '' : value;
}

const DRASTIC_RES: readonly RegExp[] = [
    // death
    /\b(died|dies|has died|is dead|was found dead|perished|passed away|drowned|bled out|took (?:his|her|their) own life)\b/i,
    /\b(?:was|were|got|has been|had been|is being)\s+(?:\w+\s+)?(killed|murdered|slain|executed|assassinated|hanged|beheaded|burned at the stake|poisoned to death)\b/i,
    // captivity
    /\b(?:was|were|got|has been|had been|is being)\s+(?:\w+\s+)?(imprisoned|jailed|arrested|captured|kidnapped|abducted|enslaved|taken prisoner|locked up|sentenced|thrown into (?:a |the )?(?:cell|dungeon|prison))\b/i,
    /\b(in (?:prison|jail|chains|a dungeon|the dungeons|captivity))\b/i,
    // removal from the story
    /\b(vanished|disappeared|went missing|never to return|for good|left (?:the city|town|the country|the kingdom|the realm) forever)\b/i,
    /\b(?:was|were|has been|had been)\s+(exiled|banished|outlawed)\b/i,
    // radical change
    /\b(turned into|transformed into|was turned|became (?:a |an )?(?:vampire|werewolf|ghoul|undead|lich|demon))\b/i,
    /\blost (?:his|her|their) (?:\w+ )?(?:arm|leg|hand|eye|eyes|sight|voice|mind|memory|memories)\b/i,
    /\b(maimed|crippled|blinded)\b/i,
    /\b(betrayed (?:his|her|their) (?:friends|allies|comrades|order|guild|lord|lady|king|queen|people)|defected|joined the enemy)\b/i,
];

/** The rules' verdict: the text kills, imprisons, removes or radically changes someone (a safety net for the flag). */
export function looksDrastic(text: string): boolean {
    const value = str(text);
    return !!value && DRASTIC_RES.some((re) => re.test(value));
}

/** Identity table: every requested name and its aliases (normalised) → the canonical name. */
export function nameTable(
    names: readonly string[],
    aliases: Record<string, readonly string[]> = {},
): Map<string, string> {
    const table = new Map<string, string>();
    for (const name of names) {
        const key = normalizeName(name);
        if (key && !table.has(key)) table.set(key, name);
    }
    for (const name of names) {
        for (const alias of aliases[name] ?? []) {
            const key = normalizeName(alias);
            if (key && !table.has(key)) table.set(key, name);
        }
    }
    return table;
}

/** One item of `events`; null when it cannot be used. */
export function readOffscreenItem(raw: unknown, table: ReadonlyMap<string, string>): ParsedOffscreen | null {
    if (!isDict(raw)) return null;
    const character = table.get(normalizeName(str(raw.character ?? raw.name)));
    if (!character) return null;
    const text = cleanEventText(str(raw.text ?? raw.event));
    if (!text) return null;
    const flagged = readFlag(raw.drastic);
    const byRules = !flagged && looksDrastic(text);
    const event: ParsedOffscreen = { character, text, drastic: flagged || byRules, drasticByRules: byRules };
    const location = meaningful(clip(str(raw.location), MAX_LOCATION));
    if (location) event.location = location;
    const rumour = meaningful(clip(str(raw.rumour ?? raw.rumor), MAX_RUMOUR));
    if (rumour) event.rumour = rumour;
    return event;
}

/** `{events: [...]}` (or a bare array) → the readable events, one per character; null when it is not that shape. */
export function parseOffscreenAnswer(
    data: unknown,
    names: readonly string[],
    aliases: Record<string, readonly string[]> = {},
): OffscreenParseResult | null {
    let value = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }
    const list = Array.isArray(value) ? value : isDict(value) && Array.isArray(value.events) ? value.events : null;
    if (!list) return null;
    const table = nameTable(names, aliases);
    const events: ParsedOffscreen[] = [];
    let invalid = 0;
    for (const raw of list) {
        const event = readOffscreenItem(raw, table);
        if (!event || events.some((item) => item.character === event.character)) invalid++;
        else events.push(event);
    }
    return { events, invalid };
}

/* ------------------------------------------------------------------ the canon entry */

/** Comment (title) of a character's offscreen canon items. */
export function offscreenComment(character: string): string {
    return `Offscreen: ${character}`;
}

/**
 * The character of an offscreen canon title («Offscreen: Mira» → «Mira»), null for any other title. The stored title
 * stays English (offscreen finds its items by it); notices and the journal show it in the user's words.
 */
export function offscreenCharacterOf(comment: string): string | null {
    const match = /^Offscreen: (.+)$/.exec(comment.trim());
    return match?.[1]?.trim() || null;
}

/** «Offscreen (3 марта, 14:00): Mira sold her shop. Whereabouts now: the capital.» */
export function offscreenContent(text: string, storyTime?: string, location?: string): string {
    const body = str(text);
    const time = str(storyTime);
    const where = str(location);
    const head = time ? `Offscreen (${time}):` : 'Offscreen:';
    const tail = where && !body.toLowerCase().includes(where.toLowerCase()) ? ` Whereabouts now: ${where}.` : '';
    return `${head} ${body}${tail}`.trim();
}

/** Keys of an event entry: the name, its Russian forms (plain or one regex key) and a few aliases; no broken keys. */
export function offscreenKeys(name: string, extra: readonly string[] = []): string[] {
    return uniqueStrings([name, ...extra]).filter((key) => key.length <= 300 && !invalidKeys([key]).length);
}
