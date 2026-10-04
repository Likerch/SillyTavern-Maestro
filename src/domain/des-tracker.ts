// Doom's Enhancement Suite tracker data: where it sits on a chat message and how to read it into a typed,
// tolerant snapshot. DES stores three JSON strings per message and swipe (quests, infoBox, characterThoughts);
// models and DES versions produce several shapes of each, so every reader here accepts the flat and nested forms
// DES's own renderers accept (research/des.md §1, §8.1; DES 2.6.0 sceneHeaders.js, thoughts.js, characterSheet.js).
// Read-only: nothing here writes back, and parsed objects are never shared with DES.

/** Raw per-swipe record: JSON strings as DES stores them (or already-parsed values, or null). */
export interface DesTrackerStrings {
    quests: unknown;
    infoBox: unknown;
    characterThoughts: unknown;
}

export interface DesStat {
    name: string;
    value: number | string;
}

export interface DesCharacter {
    name: string;
    emoji?: string;
    color?: string;
    /**
     * Per-character fields as stored: `toSnakeCase(field name)` keys for English fields, the field name itself for
     * Cyrillic ones (DES-RU restores them), e.g. `appearance`, `demeanor`, `внешность`. Values flattened to text.
     */
    details: Record<string, string>;
    /** Relationship status (`relationship.status`, a flat `relationship` string or the legacy `Relationship`). */
    relationship?: string;
    stats: DesStat[];
    thoughts?: string;
    /** `present: false`, or thoughts that DES (English phrases) or DES-RU (`(off-scene)`) mark as off-scene. */
    offScene: boolean;
}

export interface DesTime {
    start?: string;
    end?: string;
}

export interface DesWeather {
    emoji?: string;
    forecast?: string;
}

export interface DesTemperature {
    value: number | string;
    unit?: string;
}

export interface DesInfoBox {
    location?: string;
    date?: string;
    time?: DesTime;
    weather?: DesWeather;
    temperature?: DesTemperature;
    /** Usually one or two short strings. */
    recentEvents: string[];
    /** Every other scene field flattened to text: moonPhase, tension, doomTension, custom snake_case keys, … */
    fields: Record<string, string>;
}

export interface DesQuests {
    /** Main quest title; null when DES has none ("None"). */
    main: string | null;
    optional: string[];
}

export interface DesTrackerSnapshot {
    characters: DesCharacter[];
    /** Null when the section is missing or not JSON. */
    infoBox: DesInfoBox | null;
    quests: DesQuests | null;
}

/** DES's English off-scene detector (portraitBar.js getCharacterList); it also matches DES-RU's `(off-scene)`. */
const OFF_SCENE_RE =
    /\b(not\s+(currently\s+)?(in|at|present\s+in|present\s+at)\s+(the\s+)?(scene|area|room|location|vicinity))\b|\b(off[\s-]?scene)\b|\b(not\s+physically\s+present)\b|\b(absent\s+from\s+(the\s+)?(scene|room|area|location))\b|\b(away\s+from\s+(the\s+)?scene)\b/i;
/** Values DES (and DES-RU's "Нет" → "None" fix) use for "no quest". */
const NO_QUEST_RE = /^(?:none|нет)$/i;
const FENCE_RE = /^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i;
const KNOWN_INFO_KEYS = new Set(['location', 'date', 'time', 'weather', 'temperature', 'recentEvents']);

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trims and drops brackets that wrap the whole value (`[Friend]`), as DES's renderers do. */
function clean(value: string): string {
    let result = value.trim();
    while (result.length >= 2 && result.startsWith('[') && result.endsWith(']')) result = result.slice(1, -1).trim();
    return result;
}

/** Text of a scalar or of `{value}` / `{text}` / `{description}`; arrays joined with ", ". Empty → undefined. */
function textOf(value: unknown): string | undefined {
    if (typeof value === 'string') return clean(value) || undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        const parts = value.map(textOf).filter((part): part is string => !!part);
        return parts.length ? parts.join(', ') : undefined;
    }
    if (isDict(value)) {
        for (const key of ['value', 'text', 'description', 'content', 'title']) {
            const inner = textOf(value[key]);
            if (inner) return inner;
        }
    }
    return undefined;
}

/**
 * Parses one tracker section. Strings are JSON (optionally inside a ``` fence); already-parsed values pass
 * through; anything unparseable gives null (DES's legacy text formats are not read).
 */
export function parseTrackerJson(raw: unknown): unknown {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') return raw;
    let source = raw.trim();
    if (!source) return null;
    const fenced = FENCE_RE.exec(source);
    if (fenced?.[1] !== undefined) source = fenced[1].trim();
    try {
        return JSON.parse(source) as unknown;
    } catch {
        return null;
    }
}

function statsOf(raw: unknown): DesStat[] {
    const stats: DesStat[] = [];
    const push = (name: unknown, value: unknown): void => {
        if (typeof name !== 'string' || !name.trim()) return;
        if (typeof value === 'number' && Number.isFinite(value)) stats.push({ name: name.trim(), value });
        else if (typeof value === 'string' && value.trim()) stats.push({ name: name.trim(), value: value.trim() });
    };
    if (Array.isArray(raw)) {
        for (const item of raw) if (isDict(item)) push(item.name, item.value);
    } else if (isDict(raw)) {
        for (const [name, value] of Object.entries(raw)) push(name, isDict(value) ? value.value : value);
    }
    return stats;
}

function detailsOf(raw: unknown): Record<string, string> {
    const details: Record<string, string> = {};
    if (!isDict(raw)) return details;
    for (const [key, value] of Object.entries(raw)) {
        const text = textOf(value);
        if (key && text) details[key] = text;
    }
    return details;
}

function relationshipOf(entry: Dict): string | undefined {
    if (typeof entry.Relationship === 'string') return clean(entry.Relationship) || undefined;
    const relationship = entry.relationship;
    if (isDict(relationship)) return textOf(relationship.status) ?? textOf(relationship);
    return textOf(relationship);
}

function thoughtsOf(entry: Dict): string | undefined {
    const thoughts = entry.thoughts;
    if (isDict(thoughts)) return textOf(thoughts.content) ?? textOf(thoughts);
    return textOf(thoughts);
}

function characterOf(raw: unknown): DesCharacter | null {
    if (!isDict(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const thoughts = thoughtsOf(raw);
    const character: DesCharacter = {
        name: raw.name.trim(),
        details: detailsOf(raw.details),
        stats: statsOf(raw.stats),
        offScene: raw.present === false || (thoughts !== undefined && OFF_SCENE_RE.test(thoughts)),
    };
    if (typeof raw.emoji === 'string' && raw.emoji.trim()) character.emoji = raw.emoji.trim();
    if (typeof raw.color === 'string' && raw.color.trim()) character.color = raw.color.trim();
    const relationship = relationshipOf(raw);
    if (relationship) character.relationship = relationship;
    if (thoughts) character.thoughts = thoughts;
    return character;
}

/** Characters from `characterThoughts`: an array (DES 2.6 parse) or `{characters: [...]}` (legacy, defaults). */
export function parseDesCharacters(raw: unknown): DesCharacter[] {
    const data = parseTrackerJson(raw);
    const list = Array.isArray(data) ? data : isDict(data) && Array.isArray(data.characters) ? data.characters : [];
    const characters: DesCharacter[] = [];
    for (const item of list) {
        const character = characterOf(item);
        if (character) characters.push(character);
    }
    return characters;
}

function timeOf(raw: unknown): DesTime | undefined {
    if (isDict(raw)) {
        const start = textOf(raw.start) ?? textOf(raw.value);
        const end = textOf(raw.end);
        if (!start && !end) return undefined;
        const time: DesTime = {};
        if (start) time.start = start;
        if (end) time.end = end;
        return time;
    }
    const flat = textOf(raw);
    return flat ? { start: flat } : undefined;
}

function weatherOf(raw: unknown): DesWeather | undefined {
    if (isDict(raw)) {
        const emoji = textOf(raw.emoji);
        const forecast = textOf(raw.forecast) ?? textOf(raw.value);
        if (!emoji && !forecast) return undefined;
        const weather: DesWeather = {};
        if (emoji) weather.emoji = emoji;
        if (forecast) weather.forecast = forecast;
        return weather;
    }
    const flat = textOf(raw);
    return flat ? { forecast: flat } : undefined;
}

function temperatureOf(raw: unknown): DesTemperature | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw };
    if (typeof raw === 'string') return raw.trim() ? { value: raw.trim() } : undefined;
    if (!isDict(raw)) return undefined;
    const value = raw.value;
    const temperature: DesTemperature | undefined =
        typeof value === 'number' && Number.isFinite(value)
            ? { value }
            : typeof value === 'string' && value.trim()
              ? { value: value.trim() }
              : undefined;
    const unit = textOf(raw.unit);
    if (temperature && unit) temperature.unit = unit;
    return temperature;
}

function eventsOf(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(textOf).filter((event): event is string => !!event);
    if (isDict(raw) && raw.events !== undefined && raw.value === undefined) return eventsOf(raw.events);
    const flat = textOf(raw);
    return flat ? [flat] : [];
}

/** Scene data from `infoBox`; null when the section is missing or not a JSON object. */
export function parseDesInfoBox(raw: unknown): DesInfoBox | null {
    const data = parseTrackerJson(raw);
    if (!isDict(data)) return null;
    const info: DesInfoBox = { recentEvents: eventsOf(data.recentEvents), fields: {} };
    const location = textOf(data.location);
    if (location) info.location = location;
    const date = textOf(data.date);
    if (date) info.date = date;
    const time = timeOf(data.time);
    if (time) info.time = time;
    const weather = weatherOf(data.weather);
    if (weather) info.weather = weather;
    const temperature = temperatureOf(data.temperature);
    if (temperature) info.temperature = temperature;
    for (const [key, value] of Object.entries(data)) {
        if (KNOWN_INFO_KEYS.has(key)) continue;
        const text = textOf(value);
        if (text) info.fields[key] = text;
    }
    return info;
}

/** A quest title from a string, `{title}`, `{value}` (nested) or `{description}`; "None" → null. */
function questOf(raw: unknown): string | null {
    let value = raw;
    while (isDict(value) && value.value !== undefined) value = value.value;
    const title = isDict(value) ? (textOf(value.title) ?? textOf(value.description)) : textOf(value);
    return title && !NO_QUEST_RE.test(title) ? title : null;
}

/** Quests from `quests`: `{main, optional[]}` with string or `{title}` items. Null when missing. */
export function parseDesQuests(raw: unknown): DesQuests | null {
    const data = parseTrackerJson(raw);
    if (!isDict(data)) return null;
    const optional = Array.isArray(data.optional)
        ? data.optional.map(questOf).filter((quest): quest is string => quest !== null)
        : [];
    return { main: questOf(data.main), optional };
}

/** Parses a raw per-swipe record into a snapshot. */
export function parseDesTracker(strings: Partial<DesTrackerStrings>): DesTrackerSnapshot {
    return {
        characters: parseDesCharacters(strings.characterThoughts),
        infoBox: parseDesInfoBox(strings.infoBox),
        quests: parseDesQuests(strings.quests),
    };
}

function swipeRecordOf(swipes: unknown, swipeId: number): DesTrackerStrings | null {
    const record = Array.isArray(swipes) ? swipes[swipeId] : isDict(swipes) ? swipes[String(swipeId)] : undefined;
    if (!isDict(record)) return null;
    const { quests = null, infoBox = null, characterThoughts = null } = record;
    if (quests === null && infoBox === null && characterThoughts === null) return null;
    return { quests, infoBox, characterThoughts };
}

/**
 * The raw tracker record of a chat message for its current swipe: `extra.dooms_tracker_swipes[swipe_id]`, with
 * `swipe_info[swipe_id].extra.dooms_tracker_swipes[swipe_id]` as the fallback DES itself uses
 * (persistence.js, injector.js). Null for user messages and messages without tracker data (a reply without JSON
 * stores an all-null record).
 */
export function desSwipeRecord(message: unknown): DesTrackerStrings | null {
    if (!isDict(message) || message.is_user === true) return null;
    const swipeId = typeof message.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
    const extra = isDict(message.extra) ? message.extra : undefined;
    const direct = swipeRecordOf(extra?.dooms_tracker_swipes, swipeId);
    if (direct) return direct;
    const info = Array.isArray(message.swipe_info) ? (message.swipe_info[swipeId] as unknown) : undefined;
    const infoExtra = isDict(info) && isDict(info.extra) ? info.extra : undefined;
    return swipeRecordOf(infoExtra?.dooms_tracker_swipes, swipeId);
}

/** True when the snapshot holds nothing at all. */
export function isEmptySnapshot(snapshot: DesTrackerSnapshot): boolean {
    return !snapshot.characters.length && snapshot.infoBox === null && snapshot.quests === null;
}
