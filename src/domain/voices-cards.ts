// M15 «Голоса персонажей», pure card logic: who is in the scene (the DES tracker of the committed reply, P14), what
// each present character wants (DES detail fields that hold goals, open quests that name them), how they feel about
// the persona now (the tracker's status, the M19 history for «was …»), notable attitudes between present characters,
// and the cards themselves — one compact English line per character — fitted to a token budget by dropping goals,
// then attitudes between characters, then shortening speech (plan M15, M19 п. 3, P16).
// Pure: no DOM, no SillyTavern.
import { estimateText } from './architect-text';
import type { TokenCounter } from './architect-text';
import { desSwipeRecord, parseDesTracker, parseTrackerJson } from './des-tracker';
import type { DesCharacter, DesQuests, DesTrackerSnapshot } from './des-tracker';
import { truncate } from './dossier-data';
import { lastCommittedIndex, sameStatus } from './relations-history';
import type { MessageLike } from './relations-history';
import { normalizeName } from './world-names';
import { mbtiText, speechText } from './voices-speech';
import type { ArchiveVoice } from './voices-speech';

/** First line of the injection. */
export const VOICES_HEADER = '[Voice cards: how each present character speaks, feels and what they want right now]';
/** Characters of the Linguistics digest per trimming level; the last level keeps LING labels only. */
export const PROSE_CHARS: readonly number[] = [220, 110, 0];
/** LING labels kept on the last speech level. */
export const MIN_TAGS = 3;
export const GOAL_CHARS = 140;
export const STATE_CHARS = 60;
export const EXTRA_CHARS = 120;
/** A status change this many messages back (or less) is still shown as «was …». */
export const RECENT_CHANGE = 10;
/** Replies looked back for a tracker when the committed one has no character data. */
export const TRACKER_LOOKBACK = 10;
export const MAX_BONDS = 3;

const GOAL_KEY_RE =
    /goals?|objectives?|intent|plans?|motiv|wants?|desires?|agenda|purpose|(?:^|_)aims?(?:_|$)|цел|намерен|план|мотив|желан|стремлен/i;
const STATE_KEY_RE = /demeanou?r|mood|emotion|feeling|(?:^|_)state(?:_|$)|поведени|настроени|состояни|эмоци|чувств/i;
const WORD_RE = /[\p{L}\p{N}_]/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
/** Letters a Cyrillic name may be followed by in running text (a case ending: «Анн|ой»). */
const CYRILLIC_TAIL = 2;

function isAssistant(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false;
    const item = message as MessageLike;
    return !item.is_user && !item.is_system;
}

/* ------------------------------------------------------------------ the scene */

export interface SceneTracker {
    /** Message the tracker was read from. */
    index: number;
    snapshot: DesTrackerSnapshot;
}

/**
 * The DES tracker the next generation's cast comes from: the committed reply (the assistant message before the last
 * user message, P14 — so a swipe or a regeneration of the last reply sees the same scene), or the nearest earlier
 * reply with character data (DES keeps showing its last data when a reply has none), at most `lookBack` replies back.
 */
export function sceneTracker(chat: readonly unknown[], lookBack = TRACKER_LOOKBACK): SceneTracker | null {
    const start = lastCommittedIndex(chat as readonly (MessageLike | null | undefined)[]);
    let seen = 0;
    for (let index = start; index >= 0 && seen <= lookBack; index--) {
        const message = chat[index];
        if (!isAssistant(message)) continue;
        seen++;
        const record = desSwipeRecord(message);
        if (record && parseTrackerJson(record.characterThoughts) !== null) {
            return { index, snapshot: parseDesTracker(record) };
        }
    }
    return null;
}

/** Characters in the scene: not off-scene, not hidden in DES («removedCharacters»), each name once. */
export function presentCharacters(characters: readonly DesCharacter[], hidden: readonly string[] = []): DesCharacter[] {
    const skip = new Set(hidden.map(normalizeName));
    const seen = new Set<string>();
    return characters.filter((character) => {
        const key = normalizeName(character.name);
        if (!key || character.offScene || skip.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Values of DES detail fields that hold goals («goals», «current_goal», «цели», …). */
export function detailGoals(details: Readonly<Record<string, string>>): string[] {
    return Object.entries(details)
        .filter(([key, value]) => GOAL_KEY_RE.test(key) && value.trim())
        .map(([, value]) => value.trim());
}

/** The character's state now: the DES «demeanor» field (or mood, emotional state, «поведение», …). */
export function detailState(details: Readonly<Record<string, string>>): string | undefined {
    for (const [key, value] of Object.entries(details)) if (STATE_KEY_RE.test(key) && value.trim()) return value.trim();
    return undefined;
}

/**
 * A name occurs in a text: case-insensitive, left word boundary; Latin names need a right boundary too («Ann» is not
 * in «Annual»), Cyrillic ones may carry a short case ending («Анной»).
 */
export function mentionsName(text: string, needles: readonly string[]): boolean {
    const haystack = normalizeName(text);
    for (const raw of needles) {
        const needle = normalizeName(raw);
        if (needle.length < 2) continue;
        for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
            if (at > 0 && WORD_RE.test(haystack[at - 1] ?? '')) continue;
            const tail = /^[\p{L}\p{N}_]*/u.exec(haystack.slice(at + needle.length))?.[0] ?? '';
            if (!tail) return true;
            if (CYRILLIC_RE.test(needle) && tail.length <= CYRILLIC_TAIL && /^\p{Script=Cyrillic}+$/u.test(tail))
                return true;
        }
    }
    return false;
}

/** Open DES quests (main first) that name the character. */
export function questsFor(quests: DesQuests | null, needles: readonly string[]): string[] {
    if (!quests) return [];
    return [quests.main, ...quests.optional].filter(
        (quest): quest is string => typeof quest === 'string' && mentionsName(quest, needles),
    );
}

/* ------------------------------------------------------------------ attitudes */

/** A relation as M19 reports it (RelationsApi.all()). */
export interface RelationLike {
    from: string;
    to: string;
    current: string;
    history: readonly { messageIndex: number; status: string }[];
}

export interface Attitude {
    status: string;
    /** The status before a recent change. */
    was?: string;
}

/** The relation from one name to another (normalised names). */
export function relationOf(relations: readonly RelationLike[], from: string, to: string): RelationLike | undefined {
    const a = normalizeName(from);
    const b = normalizeName(to);
    return relations.find((relation) => normalizeName(relation.from) === a && normalizeName(relation.to) === b);
}

/**
 * Attitude toward the persona now: the status in the scene's tracker, else M19's current status. «was» is the status
 * before a change: M19's current one when the tracker already says something else (M19 records the committed reply a
 * little later), else the previous point when the last change is at most `recent` messages before `base`.
 */
export function attitudeNow(
    tracker: string | undefined,
    relation: RelationLike | undefined,
    base: number,
    recent = RECENT_CHANGE,
): Attitude | null {
    const now = tracker?.trim() || relation?.current.trim() || '';
    if (!now) return null;
    if (relation?.current.trim() && !sameStatus(relation.current, now)) return { status: now, was: relation.current };
    const history = relation?.history ?? [];
    const last = history[history.length - 1];
    const before = history[history.length - 2];
    if (last && before && sameStatus(last.status, now) && last.messageIndex >= base - recent) {
        return { status: now, was: before.status };
    }
    return { status: now };
}

export interface VoiceBond {
    from: string;
    to: string;
    status: string;
}

/**
 * Notable attitudes between present characters (not the persona): pairs whose both ends are present, most recently
 * changed first, at most `max`.
 */
export function presentBonds(
    relations: readonly RelationLike[],
    present: readonly string[],
    persona: string,
    max = MAX_BONDS,
): VoiceBond[] {
    const names = new Set(present.map(normalizeName));
    const self = normalizeName(persona);
    names.delete(self);
    const lastIndex = (relation: RelationLike) => relation.history[relation.history.length - 1]?.messageIndex ?? -1;
    return relations
        .filter((relation) => {
            const from = normalizeName(relation.from);
            const to = normalizeName(relation.to);
            return from !== to && names.has(from) && names.has(to) && !!relation.current.trim();
        })
        .map((relation, order) => ({ relation, order }))
        .sort((a, b) => lastIndex(b.relation) - lastIndex(a.relation) || a.order - b.order)
        .slice(0, Math.max(0, max))
        .map(({ relation }) => ({ from: relation.from, to: relation.to, status: relation.current.trim() }));
}

export function bondLine(bond: VoiceBond): string {
    return `[Bond] ${bond.from} → ${bond.to}: ${bond.status}`;
}

/* ------------------------------------------------------------------ cards */

/** Everything one card is made of. */
export interface VoiceInput {
    /** Canonical name (world model) or the name DES uses. */
    name: string;
    entityId?: string;
    /** Other names of the character (aliases): dropped as the subject of Linguistics sentences. */
    aliases?: readonly string[];
    voice: ArchiveVoice | null;
    /** The state now (DES demeanor). */
    state?: string;
    /** Persona name for «Toward …». */
    persona: string;
    attitude?: Attitude | null;
    goals: readonly string[];
    /** Stage 9 (M18): what the character does not know. */
    unknown?: string;
    /** Stage 11 (M25): stats. */
    stats?: string;
}

/** A rendered card (the same fields as the VoicesApi card). */
export interface VoiceCardData {
    name: string;
    entityId?: string;
    speech: string;
    mbti?: string;
    attitude?: string;
    goals?: string;
    unknown?: string;
    stats?: string;
    text: string;
    tokens: number;
}

/** How much of each card is shown. */
export interface CardLevel {
    goals: boolean;
    /** Characters of the Linguistics digest (0 = LING labels only). */
    prose: number;
    maxTags?: number;
    /** The state now (DES demeanor) next to MBTI. */
    state: boolean;
    /** Later-stage fields (what the character does not know, stats). */
    extras: boolean;
}

export interface VoicesLevel extends CardLevel {
    bonds: boolean;
    /** Cards kept (from the start of the list). */
    cards: number;
}

/** One card; null when there is nothing to say about the character at this level. */
export function renderCard(
    input: VoiceInput,
    level: CardLevel,
    count: TokenCounter = estimateText,
): VoiceCardData | null {
    const speech = speechText(input.voice, {
        proseChars: level.prose,
        ...(level.maxTags !== undefined ? { maxTags: level.maxTags } : {}),
        names: [input.name, ...(input.aliases ?? [])],
    });
    const state = level.state && input.state?.trim() ? input.state : undefined;
    const mbti = mbtiText(input.voice?.mbti ?? null, state, STATE_CHARS);
    const persona = input.persona.trim() || 'the user';
    const attitude = input.attitude?.status
        ? `${input.attitude.status}${input.attitude.was ? ` (was ${input.attitude.was})` : ''}`
        : '';
    const unknown = level.extras && input.unknown?.trim() ? truncate(input.unknown, EXTRA_CHARS) : '';
    const stats = level.extras && input.stats?.trim() ? truncate(input.stats, EXTRA_CHARS) : '';
    const goals = level.goals && input.goals.length ? truncate(input.goals.join('; '), GOAL_CHARS) : '';

    const parts: string[] = [];
    if (speech) parts.push(`Speech: ${speech}`);
    if (mbti) parts.push(`MBTI: ${mbti}`);
    else if (state) parts.push(`Now: ${truncate(state, STATE_CHARS)}`);
    if (attitude) parts.push(`Toward ${persona}: ${attitude}`);
    if (unknown) parts.push(`Unaware of: ${unknown}`);
    if (stats) parts.push(`Stats: ${stats}`);
    if (goals) parts.push(`Goals: ${goals}`);
    if (!parts.length) return null;

    const text = `[Voice: ${input.name}] ${parts.join(' | ')}`;
    const card: VoiceCardData = { name: input.name, speech, text, tokens: count(text) };
    if (input.entityId) card.entityId = input.entityId;
    if (mbti) card.mbti = mbti;
    if (attitude) card.attitude = attitude;
    if (goals) card.goals = goals;
    if (unknown) card.unknown = unknown;
    if (stats) card.stats = stats;
    return card;
}

export interface RenderedVoices {
    cards: VoiceCardData[];
    bonds: string[];
    /** The injection: header, cards, bonds; '' without cards. */
    text: string;
}

export function renderVoices(
    inputs: readonly VoiceInput[],
    bonds: readonly VoiceBond[],
    level: VoicesLevel,
    count: TokenCounter = estimateText,
    header = VOICES_HEADER,
): RenderedVoices {
    const cards = inputs
        .slice(0, Math.max(0, level.cards))
        .map((input) => renderCard(input, level, count))
        .filter((card): card is VoiceCardData => card !== null);
    if (!cards.length) return { cards: [], bonds: [], text: '' };
    const lines = level.bonds ? bonds.map(bondLine) : [];
    return { cards, bonds: lines, text: [header, ...cards.map((card) => card.text), ...lines].join('\n') };
}

/** Trimming steps in the order they are applied. */
export type TrimStep = 'goals' | 'bonds' | 'speech' | 'state' | 'extras' | 'cards';

/** Levels from the full cards down to none, with the step that produced each. */
export function* trimLevels(start: VoicesLevel): Generator<[TrimStep | null, VoicesLevel]> {
    let level = start;
    yield [null, level];
    if (level.goals) {
        level = { ...level, goals: false };
        yield ['goals', level];
    }
    if (level.bonds) {
        level = { ...level, bonds: false };
        yield ['bonds', level];
    }
    for (const prose of PROSE_CHARS) {
        if (prose >= level.prose) continue;
        level = { ...level, prose };
        yield ['speech', level];
    }
    if (level.maxTags === undefined || level.maxTags > MIN_TAGS) {
        level = { ...level, maxTags: MIN_TAGS };
        yield ['speech', level];
    }
    if (level.state) {
        level = { ...level, state: false };
        yield ['state', level];
    }
    if (level.extras) {
        level = { ...level, extras: false };
        yield ['extras', level];
    }
    while (level.cards > 0) {
        level = { ...level, cards: level.cards - 1 };
        yield ['cards', level];
    }
}

export interface FitOptions {
    /** Tokens for the whole injection; ≤ 0 = no limit. */
    budget: number;
    /** Include goals (the user's setting). */
    goals?: boolean;
    /** Include attitudes between present characters (the user's setting). */
    bonds?: boolean;
    count?: TokenCounter;
    header?: string;
}

export interface FittedVoices extends RenderedVoices {
    tokens: number;
    budget: number;
    /** Steps that changed the text, in order. */
    trimmed: TrimStep[];
    /** Characters whose cards did not fit at all. */
    dropped: string[];
}

/**
 * Cards within the budget: full first; then without goals, without attitudes between characters, with shorter speech
 * (shorter digest, LING labels only, at most three labels), without the state, without later-stage fields, and at last
 * with cards dropped from the end of the list.
 */
export function fitVoices(
    inputs: readonly VoiceInput[],
    bonds: readonly VoiceBond[],
    options: FitOptions,
): FittedVoices {
    const count = options.count ?? estimateText;
    const start: VoicesLevel = {
        goals: options.goals !== false,
        bonds: options.bonds !== false && bonds.length > 0,
        prose: PROSE_CHARS[0] ?? 0,
        state: true,
        extras: true,
        cards: inputs.length,
    };
    const trimmed: TrimStep[] = [];
    let previous: string | null = null;
    let result: RenderedVoices = { cards: [], bonds: [], text: '' };
    let used: VoicesLevel = start;
    for (const [step, level] of trimLevels(start)) {
        result = renderVoices(inputs, bonds, level, count, options.header);
        used = level;
        if (step && previous !== null && result.text !== previous && !trimmed.includes(step)) trimmed.push(step);
        previous = result.text;
        if (options.budget <= 0 || count(result.text) <= options.budget) break;
    }
    const kept = new Set(result.cards.map((card) => card.name));
    const dropped = inputs
        .slice(used.cards)
        .filter((input) => !kept.has(input.name) && renderCard(input, start, count) !== null)
        .map((input) => input.name);
    return { ...result, tokens: result.text ? count(result.text) : 0, budget: options.budget, trimmed, dropped };
}
