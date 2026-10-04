// M9 «Летопись» — pure parts (plan M9 п. 1–2, M6 п. 7; research/qvink-nai-studio.md §A1).
//
// Qvink walks the chat from the newest message: summaries fill the short-term budget, then only «remember»-ed ones
// fill the long-term budget, and once that budget is full every older remembered memory gets `include: null`
// (Qvink 1.3.29 update_message_inclusion_flags). Such a memory has fallen out of the long-term memory: the chronicle
// keeps it as a canon «chapter». Here:
// - tracking remembered memories per message and noticing the fall-out (identity: send_date + memory hash, so an
//   index shift after a deletion does not chapter a memory twice);
// - grouping consecutive fallen memories about the same participants/place;
// - AND keys: a characteristic participant as the primary key, place / item / second participant (or the event's
//   distinctive words) as the secondary keys — never a lone main-hero key;
// - chapter content (typed entry «chapter», M23), merging small neighbours, archiving under the canon budget.
// Pure: no DOM, no SillyTavern.
import { hasCyrillic, leftBoundaryKey, normalizeForMatch, uniqueStrings } from './canon-keys';
import { TYPED_FIELDS_KEY, composeContent } from './entry-types';
import { stableHash } from './hash';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numbers(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item)) : [];
}

/* ------------------------------------------------------------------ tracking */

export type QvinkInclude = 'short' | 'long' | null;

/** What Qvink says about one message now. */
export interface MemorySnapshot {
    index: number;
    /** send_date of the message (identity). */
    date: string;
    memory: string;
    remember: boolean;
    include: QvinkInclude;
    lagging: boolean;
}

export const MEMORY_STATES = ['tracked', 'fallen', 'proposed', 'chaptered', 'dismissed', 'nokeys'] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

/** States after which a memory is never chaptered again (kept even when the «remember» mark goes away). */
const FINAL_STATES: ReadonlySet<MemoryState> = new Set(['proposed', 'chaptered', 'dismissed', 'nokeys']);

/** A remembered memory the chronicle follows (chat document, by message index). */
export interface TrackedMemory {
    date: string;
    /** Hash of the memory text. */
    hash: string;
    /** Seen with `include: 'long'` at least once. */
    long?: boolean;
    state: MemoryState;
    /** Chapter id once chaptered (or proposed). */
    chapter?: string;
    /** Chat length when the fall-out was noticed (the newest group waits a little for its neighbours). */
    fallenAt?: number;
}

export function memoryHash(text: string): string {
    return stableHash(text.trim());
}

/** Stored tracking records, repaired (unknown fields and broken records dropped). */
export function readTracked(raw: unknown): Record<string, TrackedMemory> {
    const out: Record<string, TrackedMemory> = {};
    if (!isDict(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        if (!/^\d+$/.test(key) || !isDict(value)) continue;
        const state = (MEMORY_STATES as readonly string[]).includes(String(value.state))
            ? (value.state as MemoryState)
            : null;
        if (!state || typeof value.date !== 'string' || typeof value.hash !== 'string') continue;
        const item: TrackedMemory = { date: value.date, hash: value.hash, state };
        if (value.long === true) item.long = true;
        if (typeof value.chapter === 'string' && value.chapter) item.chapter = value.chapter;
        if (typeof value.fallenAt === 'number' && Number.isFinite(value.fallenAt)) item.fallenAt = value.fallenAt;
        out[key] = item;
    }
    return out;
}

export interface TrackResult {
    tracked: Record<string, TrackedMemory>;
    changed: boolean;
    /** Indexes of memories that fell out and wait for a chapter, oldest first. */
    fallen: number[];
}

function sortedJson(records: Record<string, TrackedMemory>): string {
    return JSON.stringify(
        Object.keys(records)
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => [key, records[key]]),
    );
}

/**
 * Updates the tracking with Qvink's current flags. A remembered memory with a text has fallen out of the long-term
 * budget when Qvink gives it no slot (`include: null`), it is not lagging (its raw message left the prompt) and the
 * flags are known to be computed past it: it was seen in the long-term memory before, or a newer message has a slot.
 * A fallen memory that gets a slot again goes back to «tracked». Finished records (chaptered, proposed, dismissed,
 * no keys) stay while their message exists, so the same memory is never chaptered twice.
 */
export function trackMemories(
    previous: Record<string, TrackedMemory>,
    snapshots: readonly MemorySnapshot[],
    chatLength: number,
): TrackResult {
    const unclaimed = new Map(Object.entries(previous));
    const byIdentity = new Map<string, string>();
    for (const [key, record] of unclaimed) byIdentity.set(`${record.date}\u0000${record.hash}`, key);
    const sorted = [...snapshots].sort((a, b) => a.index - b.index);
    const newerIncluded = new Set<number>();
    let seenSlot = false;
    for (let i = sorted.length - 1; i >= 0; i--) {
        const snapshot = sorted[i] as MemorySnapshot;
        if (seenSlot) newerIncluded.add(snapshot.index);
        if (snapshot.include === 'short' || snapshot.include === 'long') seenSlot = true;
    }
    const next: Record<string, TrackedMemory> = {};
    for (const snapshot of sorted) {
        const key = String(snapshot.index);
        const text = snapshot.memory.trim();
        const hash = memoryHash(text);
        let record: TrackedMemory | undefined;
        const atIndex = unclaimed.get(key);
        if (atIndex && atIndex.date === snapshot.date) {
            record = atIndex;
            unclaimed.delete(key);
        } else {
            const movedKey = byIdentity.get(`${snapshot.date}\u0000${hash}`);
            const moved = movedKey !== undefined ? unclaimed.get(movedKey) : undefined;
            if (moved && movedKey !== undefined) {
                record = moved;
                unclaimed.delete(movedKey);
            }
        }
        if (!snapshot.remember || !text) {
            if (record && FINAL_STATES.has(record.state)) next[key] = { ...record };
            continue;
        }
        const item: TrackedMemory = record ? { ...record } : { date: snapshot.date, hash, state: 'tracked' };
        item.date = snapshot.date;
        if (snapshot.include === 'long') item.long = true;
        const out =
            snapshot.include === null && !snapshot.lagging && (item.long === true || newerIncluded.has(snapshot.index));
        if (item.state === 'tracked' || item.state === 'fallen') {
            item.hash = hash;
            if (out && item.state === 'tracked') {
                item.state = 'fallen';
                item.fallenAt = chatLength;
            } else if (!out && item.state === 'fallen') {
                item.state = 'tracked';
                delete item.fallenAt;
            }
        }
        next[key] = item;
    }
    const fallen = Object.entries(next)
        .filter(([, record]) => record.state === 'fallen')
        .map(([key]) => Number(key))
        .sort((a, b) => a - b);
    return { tracked: next, changed: sortedJson(next) !== sortedJson(previous), fallen };
}

/* ------------------------------------------------------------------ grouping */

/** A participant, place or item of a memory, with the keys that name it (name, aliases, Russian forms). */
export interface ChapterTerm {
    id: string;
    name: string;
    keys: string[];
    /** A main hero: the persona or a card character (mentioned nearly every turn). */
    main?: boolean;
}

export interface ChapterMemory {
    index: number;
    text: string;
    participants: ChapterTerm[];
    place: ChapterTerm | null;
    items: ChapterTerm[];
    fallenAt?: number;
}

export interface MemoryGroup {
    memories: ChapterMemory[];
    /** Characters of the event lines. */
    chars: number;
    /** False for the newest group while it is small and fresh: it may still grow. */
    ready: boolean;
}

export interface GroupOptions {
    /** Most characters of a chapter's events (the chapter cap). */
    maxChars: number;
    maxMemories?: number;
    /** Most messages between two memories of one chapter. */
    maxGap?: number;
    /** A newest group under this size waits for neighbours… */
    smallChars?: number;
    /** …until this many messages were added since its fall-out was noticed. */
    holdMessages?: number;
    chatLength?: number;
}

export const SMALL_CHAPTER_CHARS = 400;
const DEFAULT_MAX_MEMORIES = 8;
const DEFAULT_MAX_GAP = 40;
const DEFAULT_HOLD_MESSAGES = 20;

/** Characters one memory adds to the event list («- text» and a line break). */
export function eventChars(text: string): number {
    return text.trim().length + 3;
}

function nonMainIds(terms: readonly ChapterTerm[]): Set<string> {
    return new Set(terms.filter((term) => !term.main).map((term) => term.id));
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    for (const value of a) if (b.has(value)) return true;
    return false;
}

interface OpenGroup {
    memories: ChapterMemory[];
    chars: number;
    place: string | null;
    people: Set<string>;
}

interface Limits {
    maxChars: number;
    maxMemories: number;
    maxGap: number;
    smallChars: number;
    holdMessages: number;
}

function fits(group: OpenGroup, memory: ChapterMemory, limits: Limits): boolean {
    const last = group.memories[group.memories.length - 1] as ChapterMemory;
    if (memory.index - last.index > limits.maxGap) return false;
    if (group.memories.length >= limits.maxMemories) return false;
    if (group.chars + eventChars(memory.text) > limits.maxChars) return false;
    const place = memory.place?.id ?? null;
    if (group.place && place && group.place !== place) return false;
    const people = nonMainIds(memory.participants);
    if (intersects(group.people, people)) return true;
    if (!group.people.size && !people.size) return true;
    return !!group.place && group.place === place;
}

/**
 * Consecutive fallen memories about the same participants/place form one group: no other place, a shared
 * characteristic (non-main) participant — or only main heroes on both sides, or the same known place — within the
 * size, count and gap limits. The newest group is not ready while it is small and was noticed recently.
 */
export function groupMemories(memories: readonly ChapterMemory[], options: GroupOptions): MemoryGroup[] {
    const limits: Limits = {
        maxChars: Math.max(1, options.maxChars),
        maxMemories: options.maxMemories ?? DEFAULT_MAX_MEMORIES,
        maxGap: options.maxGap ?? DEFAULT_MAX_GAP,
        smallChars: options.smallChars ?? SMALL_CHAPTER_CHARS,
        holdMessages: options.holdMessages ?? DEFAULT_HOLD_MESSAGES,
    };
    const sorted = [...memories].filter((memory) => memory.text.trim()).sort((a, b) => a.index - b.index);
    const groups: OpenGroup[] = [];
    for (const memory of sorted) {
        const current = groups[groups.length - 1];
        if (current && fits(current, memory, limits)) {
            current.memories.push(memory);
            current.chars += eventChars(memory.text);
            current.place ??= memory.place?.id ?? null;
            for (const id of nonMainIds(memory.participants)) current.people.add(id);
            continue;
        }
        groups.push({
            memories: [memory],
            chars: eventChars(memory.text),
            place: memory.place?.id ?? null,
            people: nonMainIds(memory.participants),
        });
    }
    const chatLength = options.chatLength;
    return groups.map((group, position) => {
        let ready = true;
        if (position === groups.length - 1 && group.chars < limits.smallChars && chatLength !== undefined) {
            const noticed = Math.min(...group.memories.map((memory) => memory.fallenAt ?? chatLength));
            ready = chatLength - noticed >= limits.holdMessages;
        }
        return { memories: group.memories, chars: group.chars, ready };
    });
}

/* ------------------------------------------------------------------ keys */

export type KeyBasis = 'place' | 'item' | 'participant' | 'words' | 'mainHero';

export interface ChapterKeySet {
    /** Primary keys: the forms of ONE characteristic term. */
    primary: string[];
    /** Secondary keys (AND ANY): place, items, other participants, the event's words. */
    secondary: string[];
    /** Id of the primary term. */
    primaryId: string;
    /** What the secondary keys are made of. */
    basis: KeyBasis;
}

export interface KeyOptions {
    /** Distinctive words of the event (proper nouns in the chat's language). */
    words?: readonly string[];
    maxPrimary?: number;
    maxSecondary?: number;
}

interface Counted {
    term: ChapterTerm;
    count: number;
    first: number;
}

/** Terms by how many memories name them, then by first appearance; one entry per id. */
export function countTerms(lists: readonly (readonly ChapterTerm[])[]): ChapterTerm[] {
    const counted = new Map<string, Counted>();
    lists.forEach((terms, position) => {
        const seen = new Set<string>();
        for (const term of terms) {
            if (seen.has(term.id)) continue;
            seen.add(term.id);
            const existing = counted.get(term.id);
            if (existing) existing.count++;
            else counted.set(term.id, { term, count: 1, first: position });
        }
    });
    return [...counted.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((item) => item.term);
}

/** Keys that name a term: its own keys (or the name), never macros, at least two characters. */
export function termKeys(term: ChapterTerm): string[] {
    const keys = term.keys.length ? term.keys : [term.name];
    return uniqueStrings(keys).filter((key) => key.length >= 2 && !key.includes('{{'));
}

/** Keys of a distinctive word: the word, plus a left-boundary stem key for Russian words (case endings). */
export function wordKeys(word: string): string[] {
    const trimmed = word.trim();
    if (!trimmed) return [];
    const regex = hasCyrillic(trimmed) ? leftBoundaryKey(trimmed) : null;
    return regex ? [trimmed, regex] : [trimmed];
}

function limitKeys(keys: readonly string[], exclude: readonly string[], max: number): string[] {
    const taken = new Set(exclude.map((key) => normalizeForMatch(key)));
    const out: string[] = [];
    for (const key of uniqueStrings(keys)) {
        const normalized = normalizeForMatch(key);
        if (taken.has(normalized)) continue;
        taken.add(normalized);
        out.push(key);
        if (out.length >= max) break;
    }
    return out;
}

interface Candidate {
    basis: KeyBasis;
    keys: string[];
}

/** The kind of the first non-empty list: what the combined secondary keys are mainly made of. */
function basisOf(lists: readonly [KeyBasis, readonly ChapterTerm[]][]): KeyBasis {
    for (const [basis, terms] of lists) if (terms.length) return basis;
    return lists[0]?.[0] ?? 'place';
}

/**
 * AND keys of a chapter (plan M9 п. 1): the primary key is the most frequent characteristic participant (a main hero
 * only when nobody else takes part); the secondary keys (any of them) are the place, the items and the other
 * characteristic participants; without them the event's distinctive words, and — only behind a characteristic
 * primary — the main heroes. A main hero is never paired with another main hero alone. Without a participant the
 * place (or an item) is primary when something else can be secondary. Null when no valid pair exists.
 */
export function chapterKeys(memories: readonly ChapterMemory[], options: KeyOptions = {}): ChapterKeySet | null {
    const maxPrimary = options.maxPrimary ?? 12;
    const maxSecondary = options.maxSecondary ?? 24;
    const participants = countTerms(memories.map((memory) => memory.participants));
    const places = countTerms(memories.map((memory) => (memory.place ? [memory.place] : [])));
    const items = countTerms(memories.map((memory) => memory.items));
    const characteristic = participants.filter((term) => !term.main);
    const heroes = participants.filter((term) => term.main);
    const words = (options.words ?? []).flatMap((word) => wordKeys(word));
    const keysOf = (terms: readonly ChapterTerm[]) => terms.flatMap((term) => termKeys(term));

    const build = (term: ChapterTerm, candidates: Candidate[]): ChapterKeySet | null => {
        const primary = limitKeys(termKeys(term), [], maxPrimary);
        if (!primary.length) return null;
        for (const candidate of candidates) {
            const secondary = limitKeys(candidate.keys, primary, maxSecondary);
            if (secondary.length) return { primary, secondary, primaryId: term.id, basis: candidate.basis };
        }
        return null;
    };
    const combined = (lists: [KeyBasis, readonly ChapterTerm[]][]): Candidate => ({
        basis: basisOf(lists),
        keys: lists.flatMap(([, terms]) => keysOf(terms)),
    });
    const wordCandidate: Candidate = { basis: 'words', keys: words };

    const lead = characteristic[0];
    if (lead) {
        return build(lead, [
            combined([
                ['place', places],
                ['item', items],
                ['participant', characteristic.slice(1)],
            ]),
            wordCandidate,
            { basis: 'mainHero', keys: keysOf(heroes) },
        ]);
    }
    const hero = heroes[0];
    const heroSet = hero
        ? build(hero, [
              combined([
                  ['place', places],
                  ['item', items],
              ]),
              wordCandidate,
          ])
        : null;
    if (heroSet) return heroSet;
    const place = places[0];
    const placeSet = place ? build(place, [combined([['item', items]]), wordCandidate]) : null;
    if (placeSet) return placeSet;
    const item = items[0];
    return item ? build(item, [combined([['item', items.slice(1)]]), wordCandidate]) : null;
}

/* ------------------------------------------------------------------ distinctive words */

const SENTENCE_END_RE = /[.!?…:"«»“”()\n]\s*$/;
const PROPER_RE = /\p{Lu}[\p{Ll}\p{M}'’-]{3,}/gu;

/**
 * Proper nouns of the event that are not known names: capitalised words of four or more letters that do not open
 * a sentence (Excalibur, Ривенделл), most frequent first. `exclude` holds names already used as keys.
 */
export function distinctiveWords(texts: readonly string[], exclude: readonly string[], limit = 3): string[] {
    // Every word of a known name counts («Lake» of «Silver Lake»).
    const excluded = exclude
        .flatMap((name) => normalizeForMatch(name).split(/[^\p{L}\p{N}]+/u))
        .filter((word) => word.length >= 3);
    const counts = new Map<string, { word: string; count: number; first: number }>();
    let order = 0;
    for (const text of texts) {
        for (const match of text.matchAll(PROPER_RE)) {
            const word = match[0].replace(/['’-]+$/, '');
            const start = match.index ?? 0;
            const before = text.slice(0, start);
            if (!before.trim() || SENTENCE_END_RE.test(before)) continue;
            if (/[\p{L}\p{N}]$/u.test(before)) continue;
            const normalized = normalizeForMatch(word);
            if (excluded.some((name) => normalized.startsWith(name) || name.startsWith(normalized))) continue;
            const existing = counts.get(normalized);
            if (existing) existing.count++;
            else counts.set(normalized, { word, count: 1, first: order++ });
        }
    }
    return [...counts.values()]
        .sort((a, b) => b.count - a.count || a.first - b.first)
        .slice(0, Math.max(0, limit))
        .map((item) => item.word);
}

/** The main language of a text by letters: Cyrillic or Latin (null without letters). */
export function textLanguage(text: string): 'ru' | 'en' | null {
    let cyrillic = 0;
    let latin = 0;
    for (const char of text) {
        if (/\p{Script=Cyrillic}/u.test(char)) cyrillic++;
        else if (/[A-Za-z]/.test(char)) latin++;
    }
    if (!cyrillic && !latin) return null;
    return cyrillic >= latin ? 'ru' : 'en';
}

/* ------------------------------------------------------------------ title and content */

const MAX_TITLE_NAMES = 3;

/** «Alice, Bob — Tavern»; «Tavern»; «Messages 12–20» when nothing names the chapter. */
export function chapterTitle(names: readonly string[], place: string | null, from: number, to: number): string {
    const shown = uniqueStrings(names).slice(0, MAX_TITLE_NAMES);
    const people = shown.join(', ');
    if (people && place) return `${people} — ${place}`;
    if (people || place) return people || (place as string);
    return from === to ? `Message ${from}` : `Messages ${from}–${to}`;
}

/** One line per event (Qvink memories are one-liners, but edited ones may hold line breaks). */
export function eventLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Typed-entry fields of a chapter (M23 «chapter» template): title, events, characters. */
export function chapterFields(title: string, events: readonly string[], characters: readonly string[]): Dict {
    const lines = events.map(eventLine).filter(Boolean);
    return {
        name: title,
        events: lines.length > 1 ? lines.map((line) => `- ${line}`).join('\n') : (lines[0] ?? ''),
        characters: uniqueStrings(characters).join(', '),
    };
}

/** Chapter content as the typed template writes it («Chapter: …», «Key events: …», «Characters: …»). */
export function chapterContent(title: string, events: readonly string[], characters: readonly string[]): string {
    const fields = chapterFields(title, events, characters) as Record<string, string>;
    return composeContent({ type: 'chapter', fields });
}

/** Event lines back from the typed field (one per line, list dashes dropped). */
export function eventsFromField(text: unknown): string[] {
    if (typeof text !== 'string') return [];
    return text
        .split('\n')
        .map((line) => line.replace(/^\s*[-•*]\s*/, '').trim())
        .filter(Boolean);
}

/** Stable chapter id from the messages it covers. */
export function chapterId(indexes: readonly number[], dates: readonly string[]): string {
    return `ch-${stableHash(`${indexes.join(',')}|${dates.join('|')}`)}`;
}

/* ------------------------------------------------------------------ stored chapters */

/** What the chronicle keeps in a chapter's canon meta (`extensions.maestro.chronicle`). */
export interface ChronicleMeta {
    id: string;
    from: number;
    to: number;
    indexes: number[];
    /** Participant ids (world model) by frequency; `primary` is the primary key's term. */
    participants: string[];
    primary: string | null;
    place: string | null;
    /** Display names of the participants (the «Characters» field). */
    characters: string[];
}

export function readChronicleMeta(raw: unknown): ChronicleMeta | null {
    if (!isDict(raw) || typeof raw.id !== 'string' || !raw.id) return null;
    if (!Number.isInteger(raw.from) || !Number.isInteger(raw.to)) return null;
    return {
        id: raw.id,
        from: raw.from as number,
        to: raw.to as number,
        indexes: numbers(raw.indexes),
        participants: strings(raw.participants),
        primary: typeof raw.primary === 'string' && raw.primary ? raw.primary : null,
        place: typeof raw.place === 'string' && raw.place ? raw.place : null,
        characters: strings(raw.characters),
    };
}

/** A chronicle chapter as read from the canon. */
export interface ChapterInfo extends ChronicleMeta {
    uid: number;
    /** The entry's comment (what the user sees). */
    title: string;
    /** The English title of the typed fields («Chapter: …» line). */
    name: string;
    status: string;
    chars: number;
    events: string[];
    keys: string[];
    secondary: string[];
}

/** A canon item (uid, meta, entry) as a chronicle chapter; null for anything else. */
export function chapterInfoOf(item: { uid: number; meta: unknown; entry: Dict }): ChapterInfo | null {
    const meta = isDict(item.meta) ? item.meta : {};
    if (meta.type !== 'chapter' || meta.origin !== 'chronicle') return null;
    const chronicle = readChronicleMeta(meta.chronicle);
    if (!chronicle) return null;
    const fields = isDict(meta[TYPED_FIELDS_KEY]) ? (meta[TYPED_FIELDS_KEY] as Dict) : {};
    const content = typeof item.entry.content === 'string' ? item.entry.content : '';
    const comment = typeof item.entry.comment === 'string' ? item.entry.comment.trim() : '';
    return {
        ...chronicle,
        uid: item.uid,
        title: comment || (typeof fields.name === 'string' ? fields.name : '') || `#${item.uid}`,
        name: typeof fields.name === 'string' ? fields.name : '',
        status: typeof meta.status === 'string' ? meta.status : 'active',
        chars: content.length,
        events: eventsFromField(fields.events),
        keys: strings(item.entry.key),
        secondary: strings(item.entry.keysecondary),
    };
}

/* ------------------------------------------------------------------ budget */

/** Most characters of one chapter: the setting, and at most a quarter of the canon budget (when it has one). */
export function chapterCap(limitChars: number, maxChapterChars: number): number {
    const own = Math.max(100, Math.floor(maxChapterChars) || 0);
    if (!(limitChars > 0)) return own;
    return Math.max(100, Math.min(own, Math.floor(limitChars / 4)));
}

/** Active chapters may take at most half of the canon budget; older ones go to the archive (return on mention). */
export function chapterShare(limitChars: number): number {
    return limitChars > 0 ? Math.floor(limitChars / 2) : Number.POSITIVE_INFINITY;
}

/** Uids of the oldest active chapters to archive so the active ones fit the share; the newest one always stays. */
export function planArchive(chapters: readonly ChapterInfo[], share: number): number[] {
    const active = chapters.filter((chapter) => chapter.status === 'active').sort((a, b) => a.to - b.to);
    let total = active.reduce((sum, chapter) => sum + chapter.chars, 0);
    const out: number[] = [];
    for (const chapter of active.slice(0, -1)) {
        if (total <= share) break;
        out.push(chapter.uid);
        total -= chapter.chars;
    }
    return out;
}

/* ------------------------------------------------------------------ merging */

export interface MergeOptions {
    smallChars?: number;
    maxChars: number;
    maxGap?: number;
}

export interface MergePlan {
    keep: ChapterInfo;
    drop: ChapterInfo;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    const left = new Set(a);
    const right = new Set(b);
    return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Neighbouring small chapters about the same thing (plan M9 п. 2): both active and under `smallChars`, the same place,
 * the same primary participant (or the same participants), close in the chat, and together within the chapter cap.
 * Pairs do not overlap; a later pass can merge the result again.
 */
export function planMerges(chapters: readonly ChapterInfo[], options: MergeOptions): MergePlan[] {
    const small = options.smallChars ?? SMALL_CHAPTER_CHARS;
    const maxGap = options.maxGap ?? DEFAULT_MAX_GAP * 2;
    const sorted = [...chapters].sort((a, b) => a.from - b.from || a.uid - b.uid);
    const plans: MergePlan[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i] as ChapterInfo;
        const b = sorted[i + 1] as ChapterInfo;
        const ok =
            a.status === 'active' &&
            b.status === 'active' &&
            a.chars < small &&
            b.chars < small &&
            a.place === b.place &&
            ((a.primary !== null && a.primary === b.primary) || sameSet(a.participants, b.participants)) &&
            b.from - a.to <= maxGap &&
            a.chars + b.chars <= options.maxChars;
        if (!ok) continue;
        plans.push({ keep: a, drop: b });
        i++;
    }
    return plans;
}

/**
 * Keys of two merged chapters: the kept chapter's primary keys; its secondary keys joined with the other's (and with
 * the other's primary keys when its primary participant differs).
 */
export function mergedKeys(
    keep: Pick<ChapterInfo, 'keys' | 'secondary' | 'primary'>,
    drop: Pick<ChapterInfo, 'keys' | 'secondary' | 'primary'>,
    maxSecondary = 24,
): { primary: string[]; secondary: string[] } {
    const primary = uniqueStrings(keep.keys);
    const extra = keep.primary === drop.primary ? [] : drop.keys;
    return { primary, secondary: limitKeys([...keep.secondary, ...drop.secondary, ...extra], primary, maxSecondary) };
}

/** The chronicle meta of two merged chapters. */
export function mergedMeta(keep: ChronicleMeta, drop: ChronicleMeta): ChronicleMeta {
    return {
        id: keep.id,
        from: Math.min(keep.from, drop.from),
        to: Math.max(keep.to, drop.to),
        indexes: [...new Set([...keep.indexes, ...drop.indexes])].sort((a, b) => a - b),
        participants: uniqueStrings([...keep.participants, ...drop.participants]),
        primary: keep.primary ?? drop.primary,
        place: keep.place ?? drop.place,
        characters: uniqueStrings([...keep.characters, ...drop.characters]),
    };
}
