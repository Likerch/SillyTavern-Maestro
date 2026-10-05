// The assistant's view of the story itself (M33, 1.10.0): the current chat's messages, the character card with its
// starting scenes (the first message and the alternate greetings), and the persona — pure readers the chat_read,
// chat_search, card_read, persona_read and scenario_overview tools build their answers from. Message text is cleaned
// for analysis (text-clean.ts); the DES tracker becomes a compact summary instead of raw JSON (des-tracker.ts); the
// search is word-based for Russian and English (assistant-docs.ts stems, ё = е, case-insensitive). No SillyTavern and
// no DOM: the tools pass the host's objects in.
import { normalizeText, stem, tokenize } from './assistant-docs';
import {
    desSwipeRecord,
    isEmptySnapshot,
    parseDesCharacters,
    parseDesInfoBox,
    parseDesQuests,
    parseDesTracker,
    parseTrackerJson,
} from './des-tracker';
import type { DesInfoBox, DesTrackerSnapshot } from './des-tracker';
import { cleanForAnalysis, isImagePost, stripDesTrackerJson } from './text-clean';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Text cut to `max` characters with «…». */
function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

/* ------------------------------------------------------------------ messages */

export type MessageRole = 'user' | 'char' | 'system';

/** Who wrote a message: the user, a character, or a system message (`extra.type`: narrator, comment…). */
export function messageRole(message: unknown): MessageRole {
    if (!isDict(message)) return 'char';
    if (message.is_user === true) return 'user';
    const extra = isDict(message.extra) ? message.extra : undefined;
    return extra && typeof extra.type === 'string' && extra.type ? 'system' : 'char';
}

export interface MessageView {
    index: number;
    name: string;
    role: MessageRole;
    /** «current/count» (1-based), only when the message has several swipes. */
    swipe?: string;
    date?: string;
    /** `is_system`: the message is hidden from the prompt (ST's /hide, or a system message). */
    hidden?: true;
    /** `extra.type` of a system message (narrator, comment…). */
    system?: string;
    /** A NAI Studio picture post: no story text. */
    image?: true;
    /** The text, cleaned for analysis (or the raw `mes`). */
    text: string;
}

function dateOf(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value).toISOString();
    const text = str(value).trim();
    return text ? clip(text, 40) : undefined;
}

/** A chat message as the assistant sees it; `clean` strips the service noise (cleanForAnalysis). */
export function messageView(message: unknown, index: number, clean = true): MessageView {
    const dict = isDict(message) ? message : {};
    const view: MessageView = {
        index,
        name: clip(str(dict.name).trim() || '?', 60),
        role: messageRole(message),
        text: clean ? cleanForAnalysis(message) : str(dict.mes),
    };
    const swipes = Array.isArray(dict.swipes) ? dict.swipes.length : 0;
    if (swipes > 1) {
        const current = typeof dict.swipe_id === 'number' && dict.swipe_id >= 0 ? dict.swipe_id : 0;
        view.swipe = `${current + 1}/${swipes}`;
    }
    const date = dateOf(dict.send_date);
    if (date) view.date = date;
    if (dict.is_system === true) view.hidden = true;
    const extra = isDict(dict.extra) ? dict.extra : undefined;
    if (view.role === 'system' && extra) view.system = clip(str(extra.type), 30);
    if (isImagePost(message)) view.image = true;
    return view;
}

/* ------------------------------------------------------------------ DES tracker */

/**
 * The tracker JSON that opens a reply in DES's together mode, parsed (an object with quests / infoBox /
 * characterThoughts or characters); null when the text does not open with one or it is not valid JSON.
 */
export function leadingTrackerJson(text: string): Dict | null {
    if (typeof text !== 'string' || !text) return null;
    const rest = stripDesTrackerJson(text);
    if (rest === text) return null;
    // stripDesTrackerJson returns a suffix of the text: what it removed is the head.
    const parsed = parseTrackerJson(text.slice(0, text.length - rest.length).trim());
    return isDict(parsed) ? parsed : null;
}

/**
 * The DES tracker of a message: its per-swipe record (where DES keeps it), else the tracker JSON at the start of its
 * text. Null for user messages and messages without tracker data.
 */
export function messageTracker(message: unknown): DesTrackerSnapshot | null {
    const record = desSwipeRecord(message);
    if (record) {
        const snapshot = parseDesTracker(record);
        if (!isEmptySnapshot(snapshot)) return snapshot;
    }
    if (!isDict(message) || message.is_user === true) return null;
    const json = leadingTrackerJson(str(message.mes));
    if (!json) return null;
    const snapshot: DesTrackerSnapshot = {
        characters: parseDesCharacters(json.characterThoughts ?? json.characters ?? null),
        infoBox: parseDesInfoBox(json.infoBox ?? json.infobox ?? null),
        quests: parseDesQuests(json.quests ?? null),
    };
    return isEmptySnapshot(snapshot) ? null : snapshot;
}

/** The latest message (from the end) that carries a tracker, with its index; null when none does. */
export function latestTracker(chat: readonly unknown[]): { index: number; snapshot: DesTrackerSnapshot } | null {
    for (let index = chat.length - 1; index >= 0; index--) {
        const snapshot = messageTracker(chat[index]);
        if (snapshot) return { index, snapshot };
    }
    return null;
}

/** Location, time and who is present: the per-message summary. */
export interface TrackerBrief {
    location?: string;
    time?: string;
    present?: string[];
}

function timeLabel(info: DesInfoBox | null): string | undefined {
    if (!info) return undefined;
    const clock = info.time ? [info.time.start, info.time.end].filter(Boolean).join('–') : '';
    const label = [info.date, clock].filter(Boolean).join(', ');
    return label ? clip(label, 80) : undefined;
}

/** The compact summary of a tracker (null when it says nothing about the scene). */
export function trackerBrief(snapshot: DesTrackerSnapshot | null): TrackerBrief | null {
    if (!snapshot) return null;
    const brief: TrackerBrief = {};
    const location = snapshot.infoBox?.location;
    if (location) brief.location = clip(location, 100);
    const time = timeLabel(snapshot.infoBox);
    if (time) brief.time = time;
    const present = snapshot.characters.filter((character) => !character.offScene).map((item) => item.name);
    if (present.length) brief.present = present.slice(0, 12).map((name) => clip(name, 40));
    return Object.keys(brief).length ? brief : null;
}

/** The scene state of a tracker for the overview: the brief plus weather, characters, quests and recent events. */
export interface TrackerScene extends TrackerBrief {
    weather?: string;
    offScene?: string[];
    characters?: { name: string; relationship?: string; stats?: string }[];
    quests?: { main?: string; optional?: string[] };
    recentEvents?: string[];
    /** Other scene fields (tension, moon phase, custom ones). */
    fields?: Record<string, string>;
}

export function trackerScene(snapshot: DesTrackerSnapshot | null): TrackerScene | null {
    if (!snapshot) return null;
    const scene: TrackerScene = { ...(trackerBrief(snapshot) ?? {}) };
    const info = snapshot.infoBox;
    const weather = [info?.weather?.emoji, info?.weather?.forecast].filter(Boolean).join(' ');
    const temperature = info?.temperature ? `${info.temperature.value}${info.temperature.unit ?? ''}` : '';
    if (weather || temperature) scene.weather = clip([weather, temperature].filter(Boolean).join(', '), 80);
    const off = snapshot.characters.filter((character) => character.offScene).map((item) => item.name);
    if (off.length) scene.offScene = off.slice(0, 10).map((name) => clip(name, 40));
    const characters = snapshot.characters.slice(0, 10).map((character) => {
        const row: { name: string; relationship?: string; stats?: string } = { name: clip(character.name, 40) };
        if (character.relationship) row.relationship = clip(character.relationship, 60);
        if (character.stats.length) {
            const stats = character.stats.slice(0, 8).map((stat) => `${stat.name} ${stat.value}`);
            row.stats = clip(stats.join(', '), 120);
        }
        return row;
    });
    if (characters.some((row) => row.relationship || row.stats)) scene.characters = characters;
    const quests = snapshot.quests;
    if (quests && (quests.main || quests.optional.length)) {
        scene.quests = {};
        if (quests.main) scene.quests.main = clip(quests.main, 160);
        if (quests.optional.length) scene.quests.optional = quests.optional.slice(0, 6).map((q) => clip(q, 120));
    }
    if (info?.recentEvents.length) scene.recentEvents = info.recentEvents.slice(0, 3).map((e) => clip(e, 200));
    const fields = Object.entries(info?.fields ?? {}).slice(0, 6);
    if (fields.length) scene.fields = Object.fromEntries(fields.map(([key, value]) => [key, clip(value, 80)]));
    return Object.keys(scene).length ? scene : null;
}

/* ------------------------------------------------------------------ search */

/** Distinct search stems of a query (lower case, ё → е, stop words dropped), at most 8. */
export function searchTerms(query: string): string[] {
    if (typeof query !== 'string') return [];
    return [...new Set(tokenize(query).map(stem))].filter((term) => term.length >= 2).slice(0, 8);
}

export interface TermMatch {
    /** How many of the terms the text has. */
    matched: number;
    /** Character index of the first matching word. */
    at: number;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;

/**
 * A stem without a final й/ь, and a three-letter Russian word without its final vowel (the stemmer leaves words that
 * short alone): «Кай», «Кая», «Каю» all give «ка».
 */
function soft(stemmed: string): string {
    if (stemmed.length >= 3 && /[йь]$/.test(stemmed)) return stemmed.slice(0, -1);
    if (stemmed.length === 3 && /^[а-я]+$/.test(stemmed) && /[аяоеыиую]$/.test(stemmed)) return stemmed.slice(0, -1);
    return stemmed;
}

/**
 * Which search terms a text contains: a word matches a term when their stems agree (a final й/ь aside), or (terms of
 * four letters and more) when the word or its stem starts with the term — «Анну», «Анной» find «Анна», «Кая» finds
 * «Кай», «убедила» finds «убедить».
 */
export function matchTerms(text: string, terms: readonly string[]): TermMatch | null {
    if (typeof text !== 'string' || !text || !terms.length) return null;
    const found = new Set<string>();
    let at = -1;
    for (const match of normalizeText(text).matchAll(WORD_RE)) {
        const word = match[0];
        const wordStem = stem(word);
        for (const term of terms) {
            if (found.has(term)) continue;
            const hit =
                soft(wordStem) === soft(term) ||
                (term.length >= 4 && (wordStem.startsWith(term) || word.startsWith(term)));
            if (!hit) continue;
            found.add(term);
            if (at < 0) at = match.index;
        }
        if (found.size === terms.length) break;
    }
    return found.size ? { matched: found.size, at: Math.min(Math.max(0, at), text.length) } : null;
}

/** About `radius` characters on each side of `at`, on word boundaries, on one line, with «…» where cut. */
export function snippetAround(text: string, at: number, radius = 100): string {
    if (typeof text !== 'string' || !text) return '';
    const centre = Math.min(Math.max(0, at), text.length);
    let start = Math.max(0, centre - radius);
    let end = Math.min(text.length, centre + radius);
    for (let step = 0; start > 0 && step < 20 && /\S/.test(text[start - 1] ?? ''); step++) start--;
    for (let step = 0; end < text.length && step < 20 && /\S/.test(text[end] ?? ''); step++) end++;
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/* ------------------------------------------------------------------ character card */

export interface CardBookEntry {
    title: string;
    keys: string[];
    enabled: boolean;
}

export interface CardView {
    name: string;
    avatar: string;
    description: string;
    personality: string;
    scenario: string;
    firstMessage: string;
    /** The «starting scenes» besides the first message, in the card's order (alternate greeting n = item n - 1). */
    alternateGreetings: string[];
    examples: string;
    creatorNotes: string;
    systemPrompt: string;
    postHistory: string;
    depthPrompt: { text: string; depth?: number; role?: string } | null;
    tags: string[];
    /** The linked World Info book (`data.extensions.world`). */
    world?: string;
    /** The embedded character book. */
    book: { name?: string; entries: CardBookEntry[] } | null;
    creator?: string;
    version?: string;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
        : [];
}

function bookOf(raw: unknown): CardView['book'] {
    if (!isDict(raw)) return null;
    const list = Array.isArray(raw.entries) ? raw.entries : isDict(raw.entries) ? Object.values(raw.entries) : [];
    const entries: CardBookEntry[] = [];
    for (const item of list) {
        if (!isDict(item)) continue;
        const keys = strings(item.keys ?? item.key);
        const title = str(item.comment).trim() || str(item.name).trim() || keys[0] || `#${entries.length + 1}`;
        entries.push({ title, keys, enabled: item.enabled !== false && item.disable !== true });
    }
    const book: NonNullable<CardView['book']> = { entries };
    const name = str(raw.name).trim();
    if (name) book.name = name;
    return entries.length || name ? book : null;
}

/**
 * The fields of a character card as SillyTavern uses them: the top-level fields (ST keeps them in sync with the V2
 * `data`) with `data` as the fallback, and the V2-only fields from `data`. Null for anything that is not a card.
 */
export function cardView(character: unknown): CardView | null {
    if (!isDict(character)) return null;
    const data = isDict(character.data) ? character.data : {};
    const extensions = isDict(data.extensions) ? data.extensions : {};
    const field = (top: string, inData = top) => (str(character[top]) || str(data[inData])).trim();
    const depth = isDict(extensions.depth_prompt) ? extensions.depth_prompt : null;
    const depthText = depth ? str(depth.prompt).trim() : '';
    const card: CardView = {
        name: field('name') || '?',
        avatar: str(character.avatar),
        description: field('description'),
        personality: field('personality'),
        scenario: field('scenario'),
        firstMessage: field('first_mes'),
        alternateGreetings: strings(data.alternate_greetings).map((text) => text.trim()),
        examples: field('mes_example'),
        creatorNotes: str(data.creator_notes).trim() || str(character.creatorcomment).trim(),
        systemPrompt: str(data.system_prompt).trim(),
        postHistory: str(data.post_history_instructions).trim(),
        depthPrompt: null,
        tags: [...new Set([...strings(character.tags), ...strings(data.tags)].map((tag) => tag.trim()))],
        book: bookOf(data.character_book),
    };
    if (depthText) {
        card.depthPrompt = { text: depthText };
        if (depth && typeof depth.depth === 'number') card.depthPrompt.depth = depth.depth;
        if (depth && typeof depth.role === 'string' && depth.role) card.depthPrompt.role = depth.role;
    }
    const world = str(extensions.world).trim();
    if (world) card.world = world;
    const creator = str(data.creator).trim();
    if (creator) card.creator = creator;
    const version = str(data.character_version).trim();
    if (version) card.version = version;
    return card;
}

/** Letters and digits only, lower case, ё → е: a comparable form of a text. */
function letters(text: string): string {
    return normalizeText(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Which starting scene the chat opened with: 0 = the first message, n = alternate greeting n. ST keeps the greetings
 * as swipes of the opening message, so its swipe id tells when the swipes line up with the card; otherwise the text is
 * compared (macros like {{user}} are already replaced in the chat, so a macro-free piece of each greeting is looked
 * for). Undefined when the chat does not open with one of the card's greetings.
 */
export function greetingInChat(chat: readonly unknown[], card: CardView): number | undefined {
    const first = chat[0];
    if (!isDict(first) || first.is_user === true) return undefined;
    const greetings = [card.firstMessage, ...card.alternateGreetings];
    const swipes = Array.isArray(first.swipes) ? first.swipes.length : 0;
    const swipeId = typeof first.swipe_id === 'number' ? first.swipe_id : 0;
    if (greetings.length > 1 && swipes === greetings.length && swipeId >= 0 && swipeId < swipes) return swipeId;
    const opening = letters(str(first.mes));
    if (!opening) return undefined;
    const index = greetings.findIndex((greeting) => {
        const piece = greeting
            .split(/\{\{[^}]*\}\}/)
            .map(letters)
            .find((part) => part.length >= 20);
        return !!piece && opening.includes(piece.slice(0, 60));
    });
    return index >= 0 ? index : undefined;
}

/* ------------------------------------------------------------------ persona */

/** `power_user.persona_description_position` (personas.js persona_description_positions). */
export const PERSONA_POSITIONS: Readonly<Record<number, string>> = {
    0: 'in the prompt (after the card)',
    1: 'in the prompt (after the card)',
    2: "top of the author's note",
    3: "bottom of the author's note",
    4: 'in the chat at a depth',
    9: 'not sent',
};

/** Extension prompt roles (`persona_description_role`). */
export const PROMPT_ROLES: Readonly<Record<number, string>> = { 0: 'system', 1: 'user', 2: 'assistant' };

/** The avatar id of a persona by its name (`power_user.personas` maps avatar → name); only when unique. */
export function personaAvatarByName(power: unknown, name: string): string | undefined {
    if (!isDict(power) || !isDict(power.personas) || !name.trim()) return undefined;
    const wanted = name.trim();
    const avatars = Object.entries(power.personas)
        .filter(([, value]) => typeof value === 'string' && value.trim() === wanted)
        .map(([avatar]) => avatar);
    return avatars.length === 1 ? avatars[0] : undefined;
}

export interface PersonaLock {
    /** This chat always uses the persona (`chat_metadata.persona`). */
    chat: boolean;
    /** The persona is connected to the current character or group (`persona_descriptions[avatar].connections`). */
    character: boolean;
    /** It is the default persona (`power_user.default_persona`). */
    default: boolean;
}

/** The lock states of a persona as ST's isPersonaLocked() computes them. */
export function personaLock(
    power: unknown,
    chatMetadata: unknown,
    avatar: string,
    target: { characterAvatar?: string; groupId?: string | null },
): PersonaLock {
    const lock: PersonaLock = { chat: false, character: false, default: false };
    if (!avatar) return lock;
    const settings = isDict(power) ? power : {};
    const metadata = isDict(chatMetadata) ? chatMetadata : {};
    lock.chat = metadata.persona === avatar;
    lock.default = settings.default_persona === avatar;
    const descriptions = isDict(settings.persona_descriptions) ? settings.persona_descriptions : {};
    const descriptor = descriptions[avatar];
    const connections = isDict(descriptor) && Array.isArray(descriptor.connections) ? descriptor.connections : [];
    lock.character = connections.some((connection) => {
        if (!isDict(connection)) return false;
        if (target.groupId) return connection.type === 'group' && connection.id === target.groupId;
        return connection.type === 'character' && !!target.characterAvatar && connection.id === target.characterAvatar;
    });
    return lock;
}
