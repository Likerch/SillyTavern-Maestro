// What the director reads from a reply (M13, M14): computed in the pause after the reply arrived (a draft, P15),
// kept until the reply is committed by the user's next message (P14) and then applied in O(1) on the send path.
// Sources: the reply text (cleaned), the user's message before it, the DES tracker of the reply and of the committed
// reply before it (place, quests, characters, relationships, time), the place registry and the world model for
// identities, the quality check's repetition verdict; twist sources for a note: DES quests, unresolved threads from the
// living canon, the chronicle and Qvink's long memories, and (stage 9+) due promises, offscreen events, mechanics.
import { adaptersOf } from '../../adapters';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { climaxWords, dominantLanguage } from '../../domain/director-flags';
import type { PictureCue } from '../../domain/director-flags';
import { hasUnresolvedWords, shorten, twistKey } from '../../domain/director-note';
import type { TwistKind, TwistSource } from '../../domain/director-note';
import { isRepetitive, topicWords } from '../../domain/director-pacing';
import { classifyScene, presentNames } from '../../domain/director-scene';
import type { SceneInput, SceneVerdict } from '../../domain/director-scene';
import { fnv1a32 } from '../../domain/hash';
import { cleanLabel, normalizePlaceName } from '../../domain/places-label';
import { detectSheetCommand } from '../../domain/sheets';
import { compareLocations, relationshipChanged, sameQuest } from '../../domain/signals-diff';
import { timeJump } from '../../domain/signals-time';
import { cleanForAnalysis, isImagePost } from '../../domain/text-clean';
import { normalizeName } from '../../domain/world-names';
import type { App, Logger } from '../../shared/contracts';
import type { CalendarApi } from '../calendar/api';
import type { ChronicleApi } from '../chronicle/api';
import type { LivingCanonApi } from '../livingCanon/api';
import type { OffscreenApi } from '../offscreen/api';
import type { PlacesApi } from '../places/api';
import type { QualityApi } from '../quality/api';
import type { WorldModelApi } from '../world/api';

/** A story time jump longer than this counts as a time skip. */
const TIME_SKIP_HOURS = 6;
const EXCERPT_CHARS = 2500;
const USER_EXCERPT_CHARS = 600;
const LANGUAGE_MESSAGES = 6;
/** Provisional living-canon facts this many messages old are threads the story may have forgotten. */
const THREAD_AGE = 6;
const MAX_MEMORY_SCAN = 3000;
const MAX_PER_KIND = 5;
const OFFSCREEN_RECENT = 30;

/** Everything the director needs from one reply, computed before it is committed. */
export interface Draft {
    index: number;
    /** Fingerprint of the reply as read (swipe, text, tracker): a changed reply needs a new draft. */
    stamp: string;
    /** Not a story turn (a picture post, a sheet, an empty reply): committed without effect. */
    skip: boolean;
    input: SceneInput;
    verdict: SceneVerdict;
    placeKey: string | null;
    locationLabel: string | null;
    /** Canonical names of the characters present. */
    present: string[];
    /** Normalised names (first appearance). */
    presentKeys: string[];
    /** Own observed changes against the committed reply before (location, quests, characters, relations, time). */
    events: number;
    known: boolean;
    topic: string[];
    repetition: boolean;
    climax: number;
    cues: PictureCue[];
    language: 'ru' | 'en' | null;
    sources: TwistSource[];
    /** For the model: the reply and the user's message, shortened. */
    excerpt: string;
    userExcerpt: string;
}

type Chat = readonly STChatMessage[];

function isStory(message: STChatMessage | undefined): message is STChatMessage {
    return !!message && !message.is_system && !isImagePost(message);
}

/** Fingerprint of a message as the director read it. */
export function stampOf(message: STChatMessage | undefined): string {
    if (!message) return '';
    const text = typeof message.mes === 'string' ? message.mes : '';
    const swipes = message.extra?.['dooms_tracker_swipes'];
    const tracker = swipes !== undefined && swipes !== null ? 1 : 0;
    return `${Number(message.swipe_id ?? 0)}|${text.length}|${fnv1a32(text)}|${tracker}`;
}

/** The last assistant reply that has a user message after it (the last committed turn), -1 if none. */
export function lastCommittedIndex(chat: Chat): number {
    let sawUser = false;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        if (message.is_user) {
            sawUser = true;
            continue;
        }
        if (sawUser && !isImagePost(message)) return i;
    }
    return -1;
}

/** Index of the user's message right before a reply (system messages skipped), -1 if the reply has none. */
function userBefore(chat: Chat, index: number): number {
    for (let i = index - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        return message.is_user ? i : -1;
    }
    return -1;
}

/** The story reply committed before `index` (the turn the draft compares with), -1 if none. */
function replyBefore(chat: Chat, index: number): number {
    for (let i = index - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || !isStory(message)) continue;
        return i;
    }
    return -1;
}

function trackerAt(app: App, index: number, log: Logger): DesTrackerSnapshot | null {
    if (index < 0) return null;
    try {
        return adaptersOf(app).des.trackerFor(index);
    } catch (error) {
        log.debug('DES tracker is not readable', error);
        return null;
    }
}

function canonicalName(app: App, name: string): string {
    try {
        return app.modules.api<WorldModelApi>('world')?.resolve(name)?.name ?? name;
    } catch {
        return name;
    }
}

/** Place key of a DES location: `place:<id>` when the registry knows it, else the normalised label. */
export function placeKeyOf(app: App, label: string | undefined): string | null {
    const clean = cleanLabel(label);
    if (!clean) return null;
    try {
        const place = app.modules.api<PlacesApi>('places')?.resolve(clean);
        if (place) return `place:${place.id}`;
    } catch {
        // the label is enough
    }
    return normalizePlaceName(clean) || null;
}

function questTitles(tracker: DesTrackerSnapshot | null): string[] | null {
    if (!tracker?.quests) return null;
    return [tracker.quests.main, ...tracker.quests.optional].filter((title): title is string => !!title);
}

function questsDiffer(before: string[], after: string[]): boolean {
    if (before.length !== after.length) return true;
    return before.some((title) => !after.some((other) => sameQuest(title, other)));
}

interface Changes {
    events: number;
    known: boolean;
    locationChanged: boolean;
    timeSkipped: boolean;
}

/** Own comparison of two DES trackers (the signals module does the same with noise suppression, a bit later). */
function changesBetween(previous: DesTrackerSnapshot | null, current: DesTrackerSnapshot | null): Changes {
    const changes: Changes = { events: 0, known: !!previous && !!current, locationChanged: false, timeSkipped: false };
    if (!previous || !current) return changes;
    const before = previous.infoBox?.location;
    const after = current.infoBox?.location;
    if (before && after && compareLocations(before, after) === 'different') {
        changes.events++;
        changes.locationChanged = true;
    }
    const questsBefore = questTitles(previous);
    const questsAfter = questTitles(current);
    if (questsBefore && questsAfter && questsDiffer(questsBefore, questsAfter)) changes.events++;
    const presentBefore = new Set(presentNames(previous).map(normalizeName));
    const presentAfter = new Set(presentNames(current).map(normalizeName));
    if (presentBefore.size !== presentAfter.size || [...presentAfter].some((name) => !presentBefore.has(name))) {
        changes.events++;
    }
    const relationBefore = new Map(previous.characters.map((item) => [normalizeName(item.name), item.relationship]));
    for (const character of current.characters) {
        const was = relationBefore.get(normalizeName(character.name));
        if (was && character.relationship && relationshipChanged(was, character.relationship)) {
            changes.events++;
            break;
        }
    }
    if (previous.infoBox && current.infoBox) {
        const jump = timeJump(
            { date: previous.infoBox.date, start: previous.infoBox.time?.start, end: previous.infoBox.time?.end },
            { date: current.infoBox.date, start: current.infoBox.time?.start, end: current.infoBox.time?.end },
            TIME_SKIP_HOURS,
        );
        if (jump.skipped) {
            changes.events++;
            changes.timeSkipped = true;
        }
    }
    return changes;
}

function qualityRepetition(app: App, index: number): boolean {
    try {
        const verdict = app.modules.api<QualityApi>('quality')?.verdict(index);
        return !!verdict?.defects.some(
            (defect) => defect.kind === 'repetition' && !defect.suspected && defect.status !== 'dismissed',
        );
    } catch {
        return false;
    }
}

/** Quality's repetition verdict of a committed reply (it may arrive after the draft). */
export function repetitionByQuality(app: App, index: number): boolean {
    return qualityRepetition(app, index);
}

export interface DraftContext {
    /** Normalised names already seen in this chat. */
    seen: ReadonlySet<string>;
    /** Place key of the last committed turn. */
    lastPlace: string | null;
}

/** Reads one reply into a draft (async: the twist sources ask other modules). */
export async function computeDraft(app: App, index: number, context: DraftContext, log: Logger): Promise<Draft> {
    const ctx = app.host.ctx();
    const chat = ctx.chat ?? [];
    const message = chat[index];
    const userIndex = userBefore(chat, index);
    const userRaw = userIndex >= 0 ? (chat[userIndex]?.mes ?? '') : '';
    const text = isStory(message) && !message.is_user ? cleanForAnalysis(message) : '';
    const userText = userIndex >= 0 ? cleanForAnalysis(chat[userIndex]) : '';
    const tracker = text ? trackerAt(app, index, log) : null;
    const previousIndex = replyBefore(chat, userIndex >= 0 ? userIndex : index);
    const previous = trackerAt(app, previousIndex, log);
    const changes = changesBetween(previous, tracker);
    const input: SceneInput = { text, userText, tracker, locationChanged: changes.locationChanged };
    if (changes.timeSkipped) input.timeSkipped = true;
    const verdict = classifyScene(input);

    const present = presentNames(tracker).map((name) => canonicalName(app, name));
    const presentKeys = [...new Set(present.map(normalizeName).filter(Boolean))];
    const locationLabel = tracker?.infoBox?.location ?? null;
    const placeKey = placeKeyOf(app, locationLabel ?? undefined);

    const earlier: string[] = [];
    for (let i = previousIndex; i >= 0 && earlier.length < 2; i = replyBefore(chat, i)) {
        const clean = cleanForAnalysis(chat[i]);
        if (clean) earlier.push(clean);
    }
    const persona = (ctx.name1 ?? '').trim();
    const topic = topicWords(`${userText}\n${text}`, 10, [...present, ...(persona ? [persona] : [])]);
    const repetition = (!!text && isRepetitive(text, earlier)) || qualityRepetition(app, index);

    const cues: PictureCue[] = [];
    if (presentKeys.some((key) => !context.seen.has(key))) cues.push('firstAppearance');
    // The registry may know a move DES wrote in similar words (two rooms of one inn): both ids must be known.
    const registryMove =
        !!placeKey?.startsWith('place:') && !!context.lastPlace?.startsWith('place:') && placeKey !== context.lastPlace;
    if (changes.locationChanged || registryMove) cues.push('placeChange');
    const climax = climaxWords(text);
    if (climax > 0) cues.push('climax');

    const recentTexts: string[] = [];
    for (let i = index; i >= 0 && recentTexts.length < LANGUAGE_MESSAGES; i--) {
        const item = chat[i];
        if (!isStory(item)) continue;
        const clean = cleanForAnalysis(item);
        if (clean) recentTexts.push(clean);
    }

    const skip = !text || !!detectSheetCommand(userRaw);
    const sources = skip ? [] : await collectTwistSources(app, index, tracker, log);
    return {
        index,
        stamp: stampOf(message),
        skip,
        input,
        verdict,
        placeKey,
        locationLabel,
        present,
        presentKeys,
        events: changes.events,
        known: changes.known,
        topic,
        repetition,
        climax,
        cues,
        language: dominantLanguage(recentTexts),
        sources,
        excerpt: text.slice(0, EXCERPT_CHARS),
        userExcerpt: userText.slice(0, USER_EXCERPT_CHARS),
    };
}

/* ------------------------------------------------------------------ twist sources */

function source(kind: TwistKind, text: string, weight: number): TwistSource {
    const short = shorten(text, 220);
    return { kind, text: short, weight, key: twistKey(kind, short) };
}

/** Optional mechanics API of stage 11 (duck-typed until its contract exists). */
interface MechanicsTwists {
    twists?(): unknown;
}

/**
 * Twist sources for a director's note at a committed reply: open DES quests (optional first), unresolved threads
 * (provisional living-canon facts the story left behind, chronicle chapters and Qvink long memories with open
 * business), due or overdue promises (M17), recent offscreen events (M16) and mechanics (M25) when those exist.
 */
export async function collectTwistSources(
    app: App,
    index: number,
    tracker: DesTrackerSnapshot | null,
    log: Logger,
): Promise<TwistSource[]> {
    const sources: TwistSource[] = [];
    const guard = async (what: string, run: () => void | Promise<void>): Promise<void> => {
        try {
            await run();
        } catch (error) {
            log.debug(`twist source ${what} failed`, error);
        }
    };

    for (const title of (tracker?.quests?.optional ?? []).slice(0, MAX_PER_KIND))
        sources.push(source('quest', title, 3));
    if (tracker?.quests?.main) sources.push(source('quest', tracker.quests.main, 1.5));

    await guard('living canon', () => {
        const living = app.modules.api<LivingCanonApi>('livingCanon');
        const facts = living?.provisional() ?? [];
        let count = 0;
        for (const fact of facts) {
            if (count >= MAX_PER_KIND) break;
            if (fact.status !== 'provisional' || fact.confirmedBy || fact.sourceMessage > index - THREAD_AGE) continue;
            const text = fact.text?.trim() || `${fact.name}: ${fact.quote}`;
            sources.push(source('thread', text, 2));
            count++;
        }
    });

    await guard('chronicle', async () => {
        const chronicle = app.modules.api<ChronicleApi>('chronicle');
        if (!chronicle) return;
        const chapters = await chronicle.chapters();
        let count = 0;
        for (const chapter of [...chapters].reverse()) {
            if (count >= MAX_PER_KIND) break;
            if (!hasUnresolvedWords(chapter.title)) continue;
            sources.push(source('thread', chapter.title, 1.5));
            count++;
        }
    });

    await guard('qvink', () => {
        const qvink = adaptersOf(app).qvink;
        if (!qvink.present()) return;
        let count = 0;
        const stop = Math.max(0, index - MAX_MEMORY_SCAN);
        for (let i = index; i >= stop && count < MAX_PER_KIND; i--) {
            const memory = qvink.memoryOf(i);
            if (!memory?.memory || (memory.include !== 'long' && !memory.remember)) continue;
            if (!hasUnresolvedWords(memory.memory)) continue;
            sources.push(source('thread', memory.memory, 1.8));
            count++;
        }
    });

    await guard('calendar', () => {
        const calendar = app.modules.api<CalendarApi>('calendar');
        if (!calendar) return;
        const fresh = calendar.due().slice(0, MAX_PER_KIND);
        for (const promise of fresh) {
            sources.push(
                source('deadline', promise.who.length ? `${promise.who.join(', ')}: ${promise.what}` : promise.what, 4),
            );
        }
        // Still due during the grace window (not only on the turn it became due), a little weaker.
        const freshIds = new Set(fresh.map((promise) => promise.id));
        for (const promise of calendar.promises({ status: 'due' }).filter((item) => !freshIds.has(item.id))) {
            if (sources.filter((item) => item.kind === 'deadline').length >= MAX_PER_KIND * 2) break;
            sources.push(source('deadline', promise.what, 3));
        }
        for (const promise of calendar.promises({ status: 'overdue' }).slice(0, MAX_PER_KIND)) {
            sources.push(source('deadline', promise.what, 3.5));
        }
    });

    await guard('offscreen', () => {
        const offscreen = app.modules.api<OffscreenApi>('offscreen');
        if (!offscreen) return;
        for (const event of offscreen.events(MAX_PER_KIND)) {
            if (event.status !== 'saved' || event.messageIndex < index - OFFSCREEN_RECENT) continue;
            sources.push(source('offscreen', `${event.character}: ${event.text}`, 2.5));
        }
    });

    await guard('mechanics', () => {
        const mechanics = app.modules.api<MechanicsTwists>('mechanics');
        const twists = typeof mechanics?.twists === 'function' ? mechanics.twists() : undefined;
        if (!Array.isArray(twists)) return;
        for (const twist of twists.slice(0, MAX_PER_KIND)) {
            const text = typeof twist === 'string' ? twist : (twist as { text?: unknown } | null)?.text;
            if (typeof text === 'string' && text.trim()) sources.push(source('mechanic', text, 2));
        }
    });

    return sources;
}
