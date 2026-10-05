// Offscreen (M16, plan M16, §12): when an automatic run is due (every N committed turns per mode, at a scene end in
// «Кино»; never in «Экономный»), which absent characters get an event (important, absent long enough, not on cooldown,
// weighted by importance and time since last seen), and when the rumour of a saved event may reach the scene (P16:
// one at a time, every third turn after the event, only where a present character could know). Plus the few chat
// readers the module needs (the last committed reply, story time). Pure: no DOM, no SillyTavern.
import { isImagePost } from './text-clean';

export type OffscreenMode = 'economy' | 'balanced' | 'cinema';
/** Modes where the offscreen world may run by itself (plan §12: never in «Экономный»). */
export type ActiveMode = Exclude<OffscreenMode, 'economy'>;
export type RunReason = 'interval' | 'sceneEnd' | 'manual';

export const ACTIVE_MODES: readonly ActiveMode[] = ['balanced', 'cinema'];

export interface CadenceSettings {
    /** Committed turns between automatic runs per mode; 0 = no automatic runs in that mode. */
    every: Record<ActiveMode, number>;
    /** A finished scene starts a run (plan §12: «Кино»). */
    sceneEnd: Record<ActiveMode, boolean>;
}

/** A scene end starts a run only this many turns after the previous one. */
export const MIN_SCENE_GAP = 3;

/** Turns between automatic runs in a mode; null when automatic runs are off (always in «Экономный»). */
export function cadenceOf(mode: OffscreenMode, settings: CadenceSettings): number | null {
    if (mode === 'economy') return null;
    const every = settings.every[mode];
    return typeof every === 'number' && Number.isFinite(every) && every >= 1 ? Math.round(every) : null;
}

export function sceneEndOn(mode: OffscreenMode, settings: CadenceSettings): boolean {
    return mode !== 'economy' && settings.sceneEnd[mode] === true;
}

export interface RunState {
    mode: OffscreenMode;
    /** Committed turns since the last automatic run. */
    turnsSince: number;
    /** A scene ended since the last check. */
    sceneEnded: boolean;
}

/** Why an automatic run is due now (a scene end first, then the interval); null when none is. */
export function decideRun(
    state: RunState,
    settings: CadenceSettings,
    minGap = MIN_SCENE_GAP,
): Exclude<RunReason, 'manual'> | null {
    if (state.mode === 'economy') return null;
    if (state.sceneEnded && sceneEndOn(state.mode, settings) && state.turnsSince >= minGap) return 'sceneEnd';
    const every = cadenceOf(state.mode, settings);
    if (every !== null && state.turnsSince >= every) return 'interval';
    return null;
}

/** Turns until the next automatic run (0 = at the next check); null when automatic runs are off. */
export function turnsUntil(mode: OffscreenMode, settings: CadenceSettings, turnsSince: number): number | null {
    const every = cadenceOf(mode, settings);
    if (every === null) return null;
    return Math.max(0, every - Math.max(0, turnsSince));
}

/* ------------------------------------------------------------------ who gets an event */

/** Sources that make a character important by themselves (plan M16: «важные»). */
export const STRONG_SOURCES: readonly string[] = ['card', 'ck.archive', 'nai.passport', 'lore.entry', 'canon.entry'];

const SOURCE_WEIGHTS: Record<string, number> = {
    card: 3,
    'ck.archive': 2,
    'nai.passport': 2,
    'lore.entry': 2,
    'canon.entry': 1.5,
    'des.character': 1,
};
/** Weak sources (aliases, memories): a little each. */
const OTHER_WEIGHT = 0.5;
/** On DES's roster of this chat. */
export const ROSTER_WEIGHT = 2;
const MAX_IMPORTANCE = 12;
/** Characters that never appeared in this chat (lore only) rank after the ones that did. */
const NEVER_SEEN_FACTOR = 0.5;

/** Importance by the stores that know the character: the first source of a kind counts fully, more a quarter. */
export function importanceOf(sourceKinds: readonly string[], roster: boolean): number {
    let total = roster ? ROSTER_WEIGHT : 0;
    const counted = new Set<string>();
    for (const kind of sourceKinds) {
        const weight = SOURCE_WEIGHTS[kind] ?? OTHER_WEIGHT;
        total += counted.has(kind) ? weight / 4 : weight;
        counted.add(kind);
    }
    return Math.round(Math.min(MAX_IMPORTANCE, total) * 100) / 100;
}

/** On the DES roster or known to a real store (card, archive, passport, lore or canon entry). */
export function isImportant(sourceKinds: readonly string[], roster: boolean): boolean {
    return roster || sourceKinds.some((kind) => STRONG_SOURCES.includes(kind));
}

export interface CandidateInput {
    /** Canonical name. */
    name: string;
    /** Normalised name (identity). */
    key: string;
    sourceKinds: readonly string[];
    /** On DES's roster of this chat. */
    roster: boolean;
    /** The chat's own card character: a candidate only after it was seen in a scene (a narrator card never is). */
    main?: boolean;
    persona?: boolean;
    /** Present in the last committed scene. */
    present: boolean;
    /** Hidden from DES «Present Characters» by the user. */
    removed?: boolean;
    /** Turn counter when last present; null when never seen in this chat. */
    lastSeenTurn: number | null;
    /** Turn counter of the character's latest offscreen event; null when none. */
    lastEventTurn: number | null;
    /** An event of this character waits in the Inbox. */
    pendingInbox?: boolean;
    /**
     * The character belongs to this chat's story: on its DES roster, seen in a scene, named in its messages, or known
     * from the card, the chat canon, or a book of this chat or card. A character known only to global stores (a shared
     * CK character repository, global lorebooks, another card's passport) never gets an event here. Absent: local.
     */
    local?: boolean;
}

export interface RankedCandidate extends CandidateInput {
    importance: number;
    /** Turns since last seen (never seen: the turns of the chat so far). */
    absence: number;
    score: number;
}

export interface PickOptions {
    /** The chat's committed turn counter now. */
    now: number;
    /** Turns a character must be away (plan default 5). */
    minAbsent: number;
    /** Turns after an event before the same character gets another one. */
    cooldown: number;
    max: number;
}

export function absenceOf(candidate: Pick<CandidateInput, 'lastSeenTurn'>, now: number): number {
    return candidate.lastSeenTurn === null ? Math.max(0, now) : Math.max(0, now - candidate.lastSeenTurn);
}

function eligible(candidate: CandidateInput, options: PickOptions): boolean {
    if (candidate.persona || candidate.present || candidate.removed || candidate.pendingInbox) return false;
    if (!candidate.name.trim() || !candidate.key) return false;
    if (!isImportant(candidate.sourceKinds, candidate.roster)) return false;
    if (candidate.local === false) return false;
    if (candidate.main && candidate.lastSeenTurn === null) return false;
    // Roster characters seen before this chat was counted are long gone; lore-only ones count from the start.
    const absence = candidate.lastSeenTurn === null && candidate.roster ? Infinity : absenceOf(candidate, options.now);
    if (absence < options.minAbsent) return false;
    if (candidate.lastEventTurn !== null && options.now - candidate.lastEventTurn < options.cooldown) return false;
    return true;
}

/** Every eligible candidate, the strongest first: importance × (1 + log2(1 + turns away)). */
export function rankCandidates(list: readonly CandidateInput[], options: PickOptions): RankedCandidate[] {
    const seen = new Set<string>();
    const ranked: RankedCandidate[] = [];
    for (const candidate of list) {
        if (seen.has(candidate.key)) continue;
        seen.add(candidate.key);
        if (!eligible(candidate, options)) continue;
        const importance = importanceOf(candidate.sourceKinds, candidate.roster);
        const absence = absenceOf(candidate, options.now);
        const neverSeen = candidate.lastSeenTurn === null && !candidate.roster;
        const score = importance * (1 + Math.log2(1 + absence)) * (neverSeen ? NEVER_SEEN_FACTOR : 1);
        ranked.push({ ...candidate, importance, absence, score: Math.round(score * 1000) / 1000 });
    }
    return ranked.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The characters of a run: the strongest `max` eligible ones. */
export function pickCandidates(list: readonly CandidateInput[], options: PickOptions): RankedCandidate[] {
    return rankCandidates(list, options).slice(0, Math.max(0, Math.floor(options.max)));
}

/* ------------------------------------------------------------------ rumours */

/** A rumour may come up on the 1st, 4th and 7th turn after its event (one turn in three), then it is old news. */
export const RUMOUR_EVERY = 3;
export const RUMOUR_WINDOW = 9;

export function rumourDue(turnsSince: number, every = RUMOUR_EVERY, window = RUMOUR_WINDOW): boolean {
    return turnsSince >= 1 && turnsSince <= window && (turnsSince - 1) % Math.max(1, every) === 0;
}

export interface RumourEvent {
    id: string;
    /** Normalised name of the event's character. */
    characterKey: string;
    rumour?: string;
    /** Turn counter when the event was made. */
    turn: number;
    status: string;
    /** Place key of the event (where the character is now), when known. */
    placeKey?: string | null;
    rumourUsed?: boolean;
}

export interface RumourScene {
    /** Normalised names of the characters present (the persona excluded). */
    presentKeys: readonly string[];
    /** Place key of the scene. */
    placeKey: string | null;
    /** Characters with a relationship to someone present (relations graph). */
    related: ReadonlySet<string>;
}

/** A present character could know: same place as the event, or a relationship with the event's character. */
export function rumourPlausible(event: Pick<RumourEvent, 'characterKey' | 'placeKey'>, scene: RumourScene): boolean {
    if (scene.presentKeys.includes(event.characterKey)) return false;
    if (!scene.presentKeys.length) return false;
    if (event.placeKey && scene.placeKey && event.placeKey === scene.placeKey) return true;
    return scene.related.has(event.characterKey);
}

/** The rumour for this generation (at most one): the newest saved, unused, due and plausible one. */
export function pickRumour<T extends RumourEvent>(events: readonly T[], scene: RumourScene, now: number): T | null {
    const newest = [...events].reverse().sort((a, b) => b.turn - a.turn);
    for (const event of newest) {
        if (event.status !== 'saved' || event.rumourUsed || !event.rumour?.trim()) continue;
        if (!rumourDue(now - event.turn)) continue;
        if (rumourPlausible(event, scene)) return event;
    }
    return null;
}

/* ------------------------------------------------------------------ chat readers */

export interface ChatMessageLike {
    is_user?: unknown;
    is_system?: unknown;
    mes?: unknown;
    extra?: unknown;
}

function isStoryReply(message: ChatMessageLike | undefined): boolean {
    return !!message && message.is_user !== true && message.is_system !== true && !isImagePost(message);
}

/** Story replies the user already answered (P14), oldest first. */
export function committedReplies(chat: readonly (ChatMessageLike | undefined)[]): number[] {
    let lastUser = -1;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message?.is_user === true && message.is_system !== true) {
            lastUser = index;
            break;
        }
    }
    const out: number[] = [];
    for (let index = 0; index < lastUser; index++) if (isStoryReply(chat[index])) out.push(index);
    return out;
}

/** The newest story reply, committed or not, -1 if none. */
export function lastStoryReply(chat: readonly (ChatMessageLike | undefined)[]): number {
    for (let index = chat.length - 1; index >= 0; index--) if (isStoryReply(chat[index])) return index;
    return -1;
}

/** The last story reply with a user message after it (the last committed turn), -1 if none. */
export function lastCommittedReply(chat: readonly (ChatMessageLike | undefined)[]): number {
    let sawUser = false;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_system === true) continue;
        if (message.is_user === true) {
            sawUser = true;
            continue;
        }
        if (sawUser && isStoryReply(message)) return index;
    }
    return -1;
}

export interface StoryTimeLike {
    date?: string;
    time?: { start?: string; end?: string };
}

function clean(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** DES date and time as one label («3 марта, 14:00–15:30»); undefined when DES wrote neither. */
export function storyTimeLabel(info: StoryTimeLike | null | undefined): string | undefined {
    const date = clean(info?.date);
    const start = clean(info?.time?.start);
    const end = clean(info?.time?.end);
    const time = start && end && start !== end ? `${start}–${end}` : start || end;
    const parts = [date, time].filter(Boolean);
    return parts.length ? parts.join(', ') : undefined;
}

/** Plural category for «N ходов»: Russian one/few/many, English one/many. */
export function pluralForm(count: number, locale: 'ru' | 'en'): 'one' | 'few' | 'many' {
    const value = Math.abs(Math.floor(count));
    if (locale === 'en') return value === 1 ? 'one' : 'many';
    const ten = value % 10;
    const hundred = value % 100;
    if (ten === 1 && hundred !== 11) return 'one';
    if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'few';
    return 'many';
}

/** Appends and drops the oldest items above the cap (in place); returns the list. */
export function pushCapped<T>(list: T[], item: T, cap: number): T[] {
    list.push(item);
    if (cap >= 0 && list.length > cap) list.splice(0, list.length - cap);
    return list;
}
