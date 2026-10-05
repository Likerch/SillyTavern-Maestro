// The chat document 'offscreen' (plan §2.1: Maestro data per chat lives in Maestro files): the committed-turn counter
// and the turn of the last automatic run, where and when each character was last seen in a scene, the recent events
// (with their rumour state) and the recent runs. Small by design: everything is capped.
import type { RunReason } from '../../domain/offscreen-plan';
import type { OffscreenEvent } from './api';

export const EVENTS_KEPT = 60;
export const RUNS_KEPT = 10;
export const SEEN_KEPT = 300;

/** A character's last sighting in a committed scene. */
export interface SeenRecord {
    /** Canonical name. */
    name: string;
    /** Turn counter of the sighting. */
    turn: number;
    /** Committed message index. */
    index: number;
    /** DES location label of that scene. */
    place?: string;
    /** DES story time of that scene. */
    time?: string;
}

export interface StoredEvent extends OffscreenEvent {
    /** Turn counter when the event was made (cooldown, rumour timing). */
    turn: number;
    /** Normalised character name. */
    characterKey: string;
    /** Place key where the character is (the event's location, else the last sighting): rumours. */
    placeKey?: string | null;
}

export interface OffscreenRun {
    at: number;
    reason: RunReason;
    /** Characters asked about. */
    characters: string[];
    /** Events made. */
    events: number;
    costUsd: number;
    /** 'noCandidates', 'cap', 'noProfile', 'noCanon', 'parse', 'refusal' or the client's error. */
    error?: string;
}

export interface OffscreenDoc {
    /** Committed turns counted in this chat. */
    turns: number;
    /** Last committed message index counted (-1: none). */
    lastCommitted: number;
    /** Turn counter at the last automatic run (or at the first look at the chat). */
    lastRunTurn: number;
    /** Last sightings by normalised name. */
    seen: Record<string, SeenRecord>;
    events: StoredEvent[];
    runs: OffscreenRun[];
    /** The chat's history was read once (counter and sightings of a chat that started before the module). */
    bootstrapped: boolean;
    /** Events of characters from outside this chat's story (1.10.3) were looked for and taken back once. */
    localChecked?: boolean;
}

export function emptyOffscreenDoc(): OffscreenDoc {
    return { turns: 0, lastCommitted: -1, lastRunTurn: 0, seen: {}, events: [], runs: [], bootstrapped: false };
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

const STATUSES: readonly OffscreenEvent['status'][] = ['saved', 'inbox', 'rejected'];
const REASONS: readonly RunReason[] = ['interval', 'sceneEnd', 'manual'];

function seenOf(value: unknown): SeenRecord | null {
    if (!isDict(value) || typeof value.name !== 'string' || !value.name.trim()) return null;
    const record: SeenRecord = { name: value.name, turn: num(value.turn, 0), index: num(value.index, -1) };
    const place = text(value.place);
    if (place) record.place = place;
    const time = text(value.time);
    if (time) record.time = time;
    return record;
}

function eventOf(value: unknown): StoredEvent | null {
    if (!isDict(value) || typeof value.id !== 'string' || typeof value.character !== 'string') return null;
    if (typeof value.text !== 'string' || typeof value.characterKey !== 'string') return null;
    const status = STATUSES.find((item) => item === value.status) ?? 'rejected';
    const event: StoredEvent = {
        id: value.id,
        character: value.character,
        characterKey: value.characterKey,
        text: value.text,
        messageIndex: num(value.messageIndex, -1),
        status,
        at: num(value.at, 0),
        turn: num(value.turn, 0),
    };
    for (const field of ['storyTime', 'rumour', 'location', 'conflict'] as const) {
        const item = text(value[field]);
        if (item) event[field] = item;
    }
    if (typeof value.canonUid === 'number' && Number.isFinite(value.canonUid)) event.canonUid = value.canonUid;
    if (value.drastic === true) event.drastic = true;
    if (value.rumourUsed === true) event.rumourUsed = true;
    if (typeof value.placeKey === 'string' && value.placeKey) event.placeKey = value.placeKey;
    return event;
}

function runOf(value: unknown): OffscreenRun | null {
    if (!isDict(value)) return null;
    const reason = REASONS.find((item) => item === value.reason);
    if (!reason) return null;
    const run: OffscreenRun = {
        at: num(value.at, 0),
        reason,
        characters: Array.isArray(value.characters)
            ? value.characters.filter((item): item is string => typeof item === 'string')
            : [],
        events: Math.max(0, Math.floor(num(value.events, 0))),
        costUsd: Math.max(0, num(value.costUsd, 0)),
    };
    const error = text(value.error);
    if (error) run.error = error;
    return run;
}

/** Repairs a stored document in place (hand-edited, older or broken) and returns it typed. */
export function readOffscreenDoc(raw: Record<string, unknown>): OffscreenDoc {
    const doc = raw as unknown as OffscreenDoc & Dict;
    doc.turns = Math.max(0, Math.floor(num(raw.turns, 0)));
    doc.lastCommitted = Math.floor(num(raw.lastCommitted, -1));
    doc.lastRunTurn = Math.min(doc.turns, Math.max(0, Math.floor(num(raw.lastRunTurn, 0))));
    const seen: Record<string, SeenRecord> = {};
    if (isDict(raw.seen)) {
        for (const [key, value] of Object.entries(raw.seen)) {
            const record = seenOf(value);
            if (record) seen[key] = record;
        }
    }
    doc.seen = seen;
    doc.events = (Array.isArray(raw.events) ? raw.events : [])
        .map(eventOf)
        .filter((item): item is StoredEvent => item !== null)
        .slice(-EVENTS_KEPT);
    doc.runs = (Array.isArray(raw.runs) ? raw.runs : [])
        .map(runOf)
        .filter((item): item is OffscreenRun => item !== null)
        .slice(-RUNS_KEPT);
    doc.bootstrapped = raw.bootstrapped === true;
    if (raw.localChecked === true) doc.localChecked = true;
    return doc;
}

/** Drops the oldest sightings above the cap (in place). */
export function trimSeen(seen: Record<string, SeenRecord>, cap = SEEN_KEPT): void {
    const keys = Object.keys(seen);
    if (keys.length <= cap) return;
    const oldest = keys.sort((a, b) => (seen[a]?.turn ?? 0) - (seen[b]?.turn ?? 0)).slice(0, keys.length - cap);
    for (const key of oldest) delete seen[key];
}

/** The public copy of an event (internal bookkeeping fields dropped). */
export function publicEvent(event: StoredEvent): OffscreenEvent {
    const copy: OffscreenEvent & { turn?: number; characterKey?: string; placeKey?: string | null } = { ...event };
    delete copy.turn;
    delete copy.characterKey;
    delete copy.placeKey;
    return copy;
}
