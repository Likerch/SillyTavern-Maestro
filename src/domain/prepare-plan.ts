// «Подготовить к игре» (M37, plan-2 §7): the plan of a new chat — what the background model found in the card, its
// books, the persona and the DES campaign, item by item: characters, the world, places, factions, items, traditions,
// time, promises, secrets, the starting scene, mechanics and direction. Canon texts are English (P6); every item also
// carries one short Russian line for the player (plan-2 §3). Each item knows its sources, whether it already exists
// (canon, places, mechanics, passports) and where it disagrees with the canon. «Язык истории» (1.20): a plan read for a
// Russian story has Russian names (`english` keeps the original spelling), outfits and dates; its secrets and promises
// keep English texts for the model and show the player their Russian lines. Pure types and small helpers.
import { hasCyrillic } from './canon-keys';
import { normName } from './dossier-names';
import { stableHash } from './hash';
import type { StoryLanguage } from './story-language';

/** Sections of the plan, in the order the window lists them and the apply step writes them. */
export const PREPARE_SECTIONS = [
    'world',
    'time',
    'place',
    'faction',
    'character',
    'item',
    'tradition',
    'secret',
    'promise',
    'mechanic',
    'scene',
    'direction',
] as const;

export type PrepareKind = (typeof PREPARE_SECTIONS)[number];

/** Kinds with one item per plan (a starting scene is one item per greeting of the card: `scene:<n>`). */
export const SINGLE_SECTIONS: ReadonlySet<PrepareKind> = new Set(['world', 'time', 'direction']);

/** Kinds identified by a name (merged by names, matched against the canon by names and keys). */
export const NAMED_SECTIONS: ReadonlySet<PrepareKind> = new Set(['character', 'place', 'faction', 'item', 'tradition']);

/** «для чата» (default, plan-2 В20) or «для персонажа»: the whole card, reused by its next new chats. */
export type PrepareScope = 'chat' | 'character';

export const PREPARE_SCOPES: readonly PrepareScope[] = ['chat', 'character'];

/** Director scene types (src/features/director/api.ts SceneType). */
export const FIRST_SCENES = ['dialogue', 'combat', 'intimate', 'exploration', 'timeskip', 'social', 'drama'] as const;
export type FirstScene = (typeof FIRST_SCENES)[number];

export function isFirstScene(value: unknown): value is FirstScene {
    return typeof value === 'string' && (FIRST_SCENES as readonly string[]).includes(value);
}

export const ATTRIBUTE_KINDS = ['number', 'scale', 'list', 'text'] as const;
export type PrepareAttributeKind = (typeof ATTRIBUTE_KINDS)[number];

export const HOLDER_KINDS = ['persona', 'characters', 'named', 'world', 'factions'] as const;
export type PrepareHolderKind = (typeof HOLDER_KINDS)[number];

/**
 * A name as the player reads it (a Russian story: Russian — transliterated or translated; an English story: as the story
 * writes it), its English form for the canon (the original spelling) and its Russian forms.
 */
export interface NamedData {
    name: string;
    english: string;
    /** Russian case forms, short names and nicknames (canon keys). */
    forms: string[];
}

export interface CharacterData extends NamedData {
    role: string;
    appearance: string;
    personality: string;
    /** Manner of speech (goes into the canon entry; voices read CarrotKernel archives, not this). */
    speech: string;
    /** Relations to other characters and to the persona, English. */
    relations: { to: string; relation: string }[];
    /** What the character wears when the story starts (English; Russian in a plan read for a Russian story). */
    outfit: string;
    /** In the starting scene. */
    present: boolean;
    /** The player's own character (the persona): never written as a canon character or passport. */
    persona: boolean;
}

export interface WorldData extends NamedData {
    setting: string;
    era: string;
    tone: string;
    /** Laws of the world: magic, technology, what is possible. */
    laws: string;
    /** Customs and taboos. */
    customs: string;
}

export interface PlaceData extends NamedData {
    /** Name of the place it lies in (city → district → tavern), '' at the top. */
    parent: string;
    kind: string;
    description: string;
    /** Its state when the story starts (ruined, decorated, closed…), English. */
    state: string;
}

export interface FactionData extends NamedData {
    leader: string;
    goals: string;
    description: string;
}

export interface ItemData extends NamedData {
    owner: string;
    description: string;
}

export interface TraditionData extends NamedData {
    when: string;
    practice: string;
    meaning: string;
}

export interface TimeData {
    /** Start date as the story writes it («12 Зимня 1024», "Day 1", "Spring"). */
    date: string;
    /** Start time of day («вечер», "19:40"). */
    time: string;
    /** The story's own calendar, English ('' for the ordinary one). */
    calendar: string;
}

export interface PromiseData {
    who: string[];
    toWhom: string[];
    /** English, short. */
    what: string;
    /** Deadline as written ('' when none). */
    due: string;
}

export interface SecretData {
    /** English statement. */
    text: string;
    /** Whom or what it is about. */
    about: string;
    knownBy: string[];
    hiddenFrom: string[];
}

/** What one character wears when a starting scene begins. */
export interface SceneOutfit {
    /** The character's name as the story writes it. */
    name: string;
    /** What they wear (English; Russian in a plan read for a Russian story). */
    wearing: string;
}

/**
 * One starting scene of the card: in SillyTavern the alternate greetings are the swipes of message 0, so every greeting
 * is a start of its own — where and when it begins, who is there, what they wear, what is going on, the type of the
 * first scene. Characters, the world, places and the rest are common to all starts.
 */
export interface SceneData {
    /** The greeting it belongs to: 0 the first message, n alternate greeting n. */
    greeting: number;
    place: string;
    date: string;
    time: string;
    /** Characters present at the start. */
    present: string[];
    /** What is going on, English. */
    situation: string;
    /** Who wears what at this start (empty: the characters' own `outfit`, older plans). */
    outfits: SceneOutfit[];
    /** Director scene type of this start ('' leaves it to the direction's `firstScene`). */
    firstScene: FirstScene | '';
}

export interface MechanicAttributeData {
    /** Display name in the user's language. */
    name: string;
    /** English name for the model. */
    english: string;
    kind: PrepareAttributeKind;
    min: number | null;
    max: number | null;
    /** Initial value for a new holder, as text ('' none). */
    initial: string;
    levels: string[];
    options: string[];
}

export interface MechanicData {
    /** Display name («Репутация»). */
    name: string;
    english: string;
    summary: string;
    rules: string;
    /** A template id or an existing mechanic's id it builds on ('' a new one). */
    template: string;
    holders: PrepareHolderKind;
    holderNames: string[];
    attributes: MechanicAttributeData[];
    /** Starting values: holder (character name, persona, faction, 'world'), attribute (name or English), value. */
    initial: { holder: string; attribute: string; value: string }[];
}

export interface DirectionData {
    genre: string;
    pacing: string;
    /** Type of the first scene for the director ('' leaves it automatic). */
    firstScene: FirstScene | '';
    notes: string;
}

export interface PrepareDataMap {
    character: CharacterData;
    world: WorldData;
    place: PlaceData;
    faction: FactionData;
    item: ItemData;
    tradition: TraditionData;
    time: TimeData;
    promise: PromiseData;
    secret: SecretData;
    scene: SceneData;
    mechanic: MechanicData;
    direction: DirectionData;
}

/** Where an item already lives. */
export type ExistsWhere = 'canon' | 'places' | 'mechanics' | 'passport' | 'persona' | 'calendar' | 'knowledge';

export interface ExistsInfo {
    where: ExistsWhere;
    /** Title as the store shows it. */
    label: string;
    /** Locator in the store (canon uid, place id, mechanic id, passport id). */
    ref?: string | number;
}

/** The plan says one thing, the canon another (a field of the typed entry). */
export interface ConflictInfo {
    /** Typed field id ('appearance', 'role', …). */
    field: string;
    /** Canon entry title. */
    with: string;
    existing: string;
    proposed: string;
}

/** What an item is already bound to (filled by markExisting, used by the apply step to skip done parts). */
export interface ItemLinks {
    canonUid?: number;
    placeId?: string;
    mechanicId?: string;
    passportId?: string;
}

export interface PrepareItem<K extends PrepareKind = PrepareKind> {
    /** `${kind}:${normalised name}` for named kinds, the kind for single ones, `${kind}:${hash}` otherwise. */
    id: string;
    kind: K;
    data: PrepareDataMap[K];
    /** One short Russian line for the player. */
    russian: string;
    /** Source ids (prepare-sources.ts) the item was read from. */
    sources: string[];
    /** Proposed scope: 'chat', or 'character' for an item of the saved character-level preparation. */
    scope: PrepareScope;
    exists?: ExistsInfo;
    conflicts?: ConflictInfo[];
    links?: ItemLinks;
    /** Taken from the saved character-level preparation (not analysed again). */
    saved?: boolean;
}

export type AnyPrepareItem = { [K in PrepareKind]: PrepareItem<K> }[PrepareKind];

/** A source as the plan remembers it (labels for «Подробнее», hashes for the reuse check). */
export interface PlanSource {
    id: string;
    label: string;
    hash: string;
}

export interface PreparePlan {
    version: 1;
    createdAt: number;
    /** The card it was made for. */
    card: { avatar: string; name: string };
    /** Starting scene the chat opened with: 0 the first message, n an alternate greeting. */
    greeting: number;
    /** The first words of every greeting of the card (index = greeting number), for the review's scene cards. */
    openings?: string[];
    items: AnyPrepareItem[];
    sources: PlanSource[];
    /** Sources left out (budget). */
    skipped: PlanSource[];
    /** Fingerprint of the card and its books (stableHash of the source hashes). */
    fingerprint: string;
    chunks: number;
    failedChunks: number;
    /** The analysis was stopped before every part was read. */
    partial?: boolean;
    /** «Язык истории» it was read for (missing: a plan of 1.19 or older, names as the story writes them). */
    language?: StoryLanguage;
    costUsd?: number;
    /** The saved character-level preparation was reused (only changed sources were read). */
    reused?: boolean;
}

/* ------------------------------------------------------------------ helpers */

export function isPrepareKind(value: unknown): value is PrepareKind {
    return typeof value === 'string' && (PREPARE_SECTIONS as readonly string[]).includes(value);
}

export function isPrepareScope(value: unknown): value is PrepareScope {
    return value === 'chat' || value === 'character';
}

export function sectionOrder(kind: PrepareKind): number {
    return PREPARE_SECTIONS.indexOf(kind);
}

function namedData(item: AnyPrepareItem): NamedData | null {
    return NAMED_SECTIONS.has(item.kind) || item.kind === 'world' ? (item.data as NamedData) : null;
}

/**
 * The text of a secret or a promise as the player reads it: in a Russian story its Russian line (the texts are English
 * for the model and the revision), unless the text is Russian already (an edit); else the text.
 */
export function playerText(item: PrepareItem<'secret'> | PrepareItem<'promise'>, language?: StoryLanguage): string {
    const text = item.kind === 'secret' ? item.data.text : item.data.what;
    if (language !== 'ru' || hasCyrillic(text) || !item.russian.trim()) return text;
    return item.russian.trim();
}

/** The item's title: its name, else a short text (a secret's or a promise's in the story's language). */
export function itemTitle(item: AnyPrepareItem, language?: StoryLanguage): string {
    const named = namedData(item);
    if (named) return named.name || named.english;
    switch (item.kind) {
        case 'mechanic':
            return item.data.name || item.data.english;
        case 'secret':
            return item.data.about || playerText(item, language);
        case 'promise':
            return playerText(item, language);
        case 'time':
            return [item.data.date, item.data.time].filter(Boolean).join(', ');
        case 'scene':
            return item.data.place;
        case 'direction':
            return item.data.genre;
        default:
            return '';
    }
}

/** Every name the item answers to (name, English name, forms), unique, as written. */
export function itemNames(item: AnyPrepareItem): string[] {
    const named = namedData(item);
    if (named) return uniqueNames([named.name, named.english, ...named.forms]);
    if (item.kind === 'mechanic') return uniqueNames([item.data.name, item.data.english]);
    return [];
}

/** Non-empty names, trimmed, once each (case and ё ignored). */
export function uniqueNames(values: Iterable<unknown>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const name = value.trim();
        const key = normName(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

/** Stable id of an item. */
export function itemIdOf(kind: PrepareKind, data: PrepareDataMap[PrepareKind]): string {
    if (SINGLE_SECTIONS.has(kind)) return kind;
    if (kind === 'scene') return sceneId((data as SceneData).greeting);
    if (NAMED_SECTIONS.has(kind)) {
        const named = data as NamedData;
        return `${kind}:${normName(named.english || named.name)}`;
    }
    if (kind === 'mechanic') {
        const mechanic = data as MechanicData;
        return `mechanic:${normName(mechanic.english || mechanic.name || mechanic.template)}`;
    }
    const text = kind === 'secret' ? (data as SecretData).text : (data as PromiseData).what;
    return `${kind}:${stableHash(normName(text))}`;
}

/** Empty data of a kind (single sections start empty; the schema reader fills it). */
export function emptyData<K extends PrepareKind>(kind: K): PrepareDataMap[K] {
    const named = { name: '', english: '', forms: [] as string[] };
    const map: PrepareDataMap = {
        character: {
            ...named,
            role: '',
            appearance: '',
            personality: '',
            speech: '',
            relations: [],
            outfit: '',
            present: false,
            persona: false,
        },
        world: { ...named, setting: '', era: '', tone: '', laws: '', customs: '' },
        place: { ...named, parent: '', kind: '', description: '', state: '' },
        faction: { ...named, leader: '', goals: '', description: '' },
        item: { ...named, owner: '', description: '' },
        tradition: { ...named, when: '', practice: '', meaning: '' },
        time: { date: '', time: '', calendar: '' },
        promise: { who: [], toWhom: [], what: '', due: '' },
        secret: { text: '', about: '', knownBy: [], hiddenFrom: [] },
        scene: { greeting: 0, place: '', date: '', time: '', present: [], situation: '', outfits: [], firstScene: '' },
        mechanic: {
            name: '',
            english: '',
            summary: '',
            rules: '',
            template: '',
            holders: 'characters',
            holderNames: [],
            attributes: [],
            initial: [],
        },
        direction: { genre: '', pacing: '', firstScene: '', notes: '' },
    };
    return map[kind];
}

/** True when a single section says nothing (every text empty). */
export function isEmptyData(data: PrepareDataMap[PrepareKind]): boolean {
    for (const value of Object.values(data as unknown as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) return false;
        if (Array.isArray(value) && value.length) return false;
    }
    return true;
}

/** Counts per section («Персонажи (7) · Места (5) · …»). */
export function sectionCounts(items: readonly AnyPrepareItem[]): Partial<Record<PrepareKind, number>> {
    const counts: Partial<Record<PrepareKind, number>> = {};
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
}

/** Id of the starting scene of a greeting. */
export function sceneId(greeting: number): string {
    return `scene:${greeting}`;
}

/** The greeting of a scene item (0 for anything else). */
export function sceneGreeting(item: AnyPrepareItem): number {
    return item.kind === 'scene' && Number.isInteger(item.data.greeting) ? item.data.greeting : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stored plans of 1.15 had one starting scene (id 'scene', no greeting): it becomes the scene of the greeting the
 * chat opened with (`greeting`), with no outfits of its own and no type (the characters' outfits and the direction's
 * type stay its fallbacks). Scenes of this version get their missing fields filled. Other items are kept as they are.
 */
export function migrateScenes(items: readonly AnyPrepareItem[], greeting: number): AnyPrepareItem[] {
    return items.map((item) => {
        if (item.kind !== 'scene') return item;
        const raw = (isRecord(item.data) ? item.data : {}) as Record<string, unknown>;
        const number =
            typeof raw.greeting === 'number' && Number.isInteger(raw.greeting) && raw.greeting >= 0
                ? raw.greeting
                : Math.max(0, Math.floor(greeting) || 0);
        const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
        const data: SceneData = {
            greeting: number,
            place: text('place'),
            date: text('date'),
            time: text('time'),
            present: Array.isArray(raw.present)
                ? raw.present.filter((name): name is string => typeof name === 'string')
                : [],
            situation: text('situation'),
            outfits: Array.isArray(raw.outfits)
                ? raw.outfits
                      .filter(isRecord)
                      .map((row) => ({
                          name: typeof row.name === 'string' ? row.name : '',
                          wearing: typeof row.wearing === 'string' ? row.wearing : '',
                      }))
                      .filter((row) => row.name && row.wearing)
                : [],
            firstScene: isFirstScene(raw.firstScene) ? raw.firstScene : '',
        };
        return { ...item, id: sceneId(number), data };
    });
}

/** A deep copy (plans are JSON). */
export function clonePlan<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
