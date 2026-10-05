// The wardrobe's per-chat document (plan M27, §4.8 «файлы Maestro по чату»): the outfit library (which DES wordings
// each passport outfit was recognised from, when it was first and last seen), the history of changes for the pult and
// undo, and the two-turn bookkeeping of the states Maestro switched on. The outfits and states themselves live in NAI
// Studio's chat-level passports (§2.1); this is only Maestro's memory about them. Pure.
import type { TrackedState } from './wardrobe-states';
import { wordingScore } from './wardrobe-match';

export type OutfitOrigin = 'des' | 'revision' | 'user';

/** What Maestro remembers about one outfit of one passport ('' = the passport's clothing slot). */
export interface OutfitRecord {
    passportId: string;
    character: string;
    name: string;
    /** Tags as written when Maestro made it (the passport is the truth; this is for the library without NAI). */
    tags: string;
    seenAs: string[];
    firstSeen: number;
    lastSeen: number;
    /** Committed message index it was last seen at (-1: by hand). */
    lastIndex: number;
    origin: OutfitOrigin;
    /** Maestro created it in the passport. */
    created?: boolean;
}

export type HistoryKind = 'outfit' | 'character' | 'place';

/** One change Maestro (or the user through the pult) made. */
export interface HistoryEntry {
    /** Operation id: the journal change carries it in `ref.op`. */
    op: string;
    kind: HistoryKind;
    /** Character or place name. */
    subject: string;
    passportId: string;
    /** Outfit name ('' = clothing slot) or state rule id. */
    state: string;
    enabled: boolean;
    /** A new outfit was added to the passport. */
    created?: boolean;
    placeId?: string;
    messageIndex: number;
    at: number;
    origin: OutfitOrigin;
    undone?: boolean;
}

export interface WardrobeDoc {
    version: 1;
    outfits: OutfitRecord[];
    history: HistoryEntry[];
    /** States Maestro switched on: passport id → rule id → tracking. */
    chars: Record<string, Record<string, TrackedState>>;
    /** Place states Maestro switched on: place id → rule id → tracking (with the passport id and tags it added). */
    places: Record<string, Record<string, TrackedState>>;
    /** Last committed message read for states. */
    lastIndex: number;
    /** Passport id → message index of the newest outfit information applied (older deferred cards do not switch). */
    lastOutfit: Record<string, number>;
    /** Revision deferred cards taken in (dismissed there; kept in case dismissing failed). */
    taken: string[];
}

export const KEEP_HISTORY = 200;
export const KEEP_OUTFITS = 300;
export const KEEP_SEEN = 8;
export const KEEP_TAKEN = 500;
/** A wording this close to a remembered one is not stored again. */
const SAME_WORDING = 0.9;

export function emptyWardrobeDoc(): WardrobeDoc {
    return { version: 1, outfits: [], history: [], chars: {}, places: {}, lastIndex: -1, lastOutfit: {}, taken: [] };
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const ORIGINS: readonly OutfitOrigin[] = ['des', 'revision', 'user'];
const KINDS: readonly HistoryKind[] = ['outfit', 'character', 'place'];

function origin(value: unknown): OutfitOrigin {
    return ORIGINS.find((item) => item === value) ?? 'des';
}

function outfitOf(raw: unknown): OutfitRecord | null {
    if (!isDict(raw) || !str(raw.passportId)) return null;
    const record: OutfitRecord = {
        passportId: str(raw.passportId),
        character: str(raw.character),
        name: str(raw.name),
        tags: str(raw.tags),
        seenAs: strings(raw.seenAs).slice(-KEEP_SEEN),
        firstSeen: num(raw.firstSeen, 0),
        lastSeen: num(raw.lastSeen, 0),
        lastIndex: num(raw.lastIndex, -1),
        origin: origin(raw.origin),
    };
    if (raw.created === true) record.created = true;
    return record;
}

function historyOf(raw: unknown): HistoryEntry | null {
    if (!isDict(raw) || !str(raw.op)) return null;
    const kind = KINDS.find((item) => item === raw.kind);
    if (!kind) return null;
    const entry: HistoryEntry = {
        op: str(raw.op),
        kind,
        subject: str(raw.subject),
        passportId: str(raw.passportId),
        state: str(raw.state),
        enabled: raw.enabled !== false,
        messageIndex: num(raw.messageIndex, -1),
        at: num(raw.at, 0),
        origin: origin(raw.origin),
    };
    if (raw.created === true) entry.created = true;
    if (raw.undone === true) entry.undone = true;
    if (str(raw.placeId)) entry.placeId = str(raw.placeId);
    return entry;
}

function trackedOf(raw: unknown): TrackedState | null {
    if (!isDict(raw)) return null;
    const entry: TrackedState = {
        since: num(raw.since, -1),
        missing: Math.max(0, num(raw.missing, 0)),
        stateId: str(raw.stateId),
    };
    if (raw.suppressed === true) entry.suppressed = true;
    const added = strings(raw.added);
    if (added.length) entry.added = added;
    if (str(raw.passportId)) entry.passportId = str(raw.passportId);
    return entry;
}

function trackedMap(raw: unknown, needsPassport: boolean): Record<string, Record<string, TrackedState>> {
    const out: Record<string, Record<string, TrackedState>> = {};
    if (!isDict(raw)) return out;
    for (const [owner, states] of Object.entries(raw)) {
        if (!owner || !isDict(states)) continue;
        const inner: Record<string, TrackedState> = {};
        for (const [id, value] of Object.entries(states)) {
            const entry = trackedOf(value);
            if (id && entry && (!needsPassport || entry.passportId)) inner[id] = entry;
        }
        if (Object.keys(inner).length) out[owner] = inner;
    }
    return out;
}

/** A stored document repaired (hand edits, older versions); unknown fields are dropped. */
export function normalizeWardrobeDoc(raw: unknown): WardrobeDoc {
    const doc = emptyWardrobeDoc();
    if (!isDict(raw)) return doc;
    doc.outfits = (Array.isArray(raw.outfits) ? raw.outfits : [])
        .map(outfitOf)
        .filter((item): item is OutfitRecord => item !== null)
        .slice(-KEEP_OUTFITS);
    doc.history = (Array.isArray(raw.history) ? raw.history : [])
        .map(historyOf)
        .filter((item): item is HistoryEntry => item !== null)
        .slice(-KEEP_HISTORY);
    doc.chars = trackedMap(raw.chars, false);
    doc.places = trackedMap(raw.places, true);
    doc.lastIndex = num(raw.lastIndex, -1);
    if (isDict(raw.lastOutfit)) {
        for (const [id, index] of Object.entries(raw.lastOutfit)) {
            if (typeof index === 'number' && Number.isFinite(index)) doc.lastOutfit[id] = index;
        }
    }
    doc.taken = strings(raw.taken).slice(-KEEP_TAKEN);
    return doc;
}

/* ------------------------------------------------------------------ the library */

export function findOutfit(doc: WardrobeDoc, passportId: string, name: string): OutfitRecord | undefined {
    const key = name.trim().toLowerCase();
    return doc.outfits.find((item) => item.passportId === passportId && item.name.trim().toLowerCase() === key);
}

/** Some outfit of this passport was already seen with this wording (or a close one). */
export function knowsWording(doc: WardrobeDoc, passportId: string, wording: string): boolean {
    const text = wording.replace(/\s+/g, ' ').trim();
    return doc.outfits.some(
        (item) =>
            item.passportId === passportId && item.seenAs.some((seen) => wordingScore(seen, text) >= SAME_WORDING),
    );
}

/** Remembers a wording of an outfit unless a close one is there; the oldest goes beyond KEEP_SEEN. */
export function addSeen(record: OutfitRecord, wording: string): boolean {
    const text = wording.replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (record.seenAs.some((seen) => wordingScore(seen, text) >= SAME_WORDING)) return false;
    record.seenAs.push(text);
    if (record.seenAs.length > KEEP_SEEN) record.seenAs.splice(0, record.seenAs.length - KEEP_SEEN);
    return true;
}

export interface SeenInput {
    passportId: string;
    character: string;
    name: string;
    tags?: string;
    wording?: string;
    messageIndex: number;
    origin: OutfitOrigin;
    at: number;
    created?: boolean;
}

/** The outfit's record, created when missing, with this sighting added (wording, last seen). */
export function noteOutfit(doc: WardrobeDoc, input: SeenInput): OutfitRecord {
    let record = findOutfit(doc, input.passportId, input.name);
    if (!record) {
        record = {
            passportId: input.passportId,
            character: input.character,
            name: input.name,
            tags: input.tags ?? '',
            seenAs: [],
            firstSeen: input.at,
            lastSeen: input.at,
            lastIndex: input.messageIndex,
            origin: input.origin,
        };
        doc.outfits.push(record);
        if (doc.outfits.length > KEEP_OUTFITS) doc.outfits.splice(0, doc.outfits.length - KEEP_OUTFITS);
    }
    if (input.created) record.created = true;
    if (input.tags && !record.tags) record.tags = input.tags;
    if (input.character) record.character = input.character;
    if (input.wording) addSeen(record, input.wording);
    record.lastSeen = Math.max(record.lastSeen, input.at);
    record.lastIndex = Math.max(record.lastIndex, input.messageIndex);
    return record;
}

export function dropOutfit(doc: WardrobeDoc, passportId: string, name: string): void {
    const key = name.trim().toLowerCase();
    doc.outfits = doc.outfits.filter(
        (item) => item.passportId !== passportId || item.name.trim().toLowerCase() !== key,
    );
}

/* ------------------------------------------------------------------ history */

export function pushHistory(doc: WardrobeDoc, entry: HistoryEntry): void {
    doc.history.push(entry);
    if (doc.history.length > KEEP_HISTORY) doc.history.splice(0, doc.history.length - KEEP_HISTORY);
}

/** Marks the entries of an operation undone; true when one was found. */
export function markUndone(doc: WardrobeDoc, op: string): boolean {
    let found = false;
    for (const entry of doc.history) {
        if (entry.op !== op) continue;
        entry.undone = true;
        found = true;
    }
    return found;
}

/** History, newest first, optionally filtered. */
export function recentHistory(
    doc: WardrobeDoc,
    filter: { kind?: HistoryKind | 'state'; passportId?: string; placeId?: string; limit?: number } = {},
): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (let i = doc.history.length - 1; i >= 0; i--) {
        const entry = doc.history[i] as HistoryEntry;
        if (filter.kind === 'state' ? entry.kind === 'outfit' : filter.kind && entry.kind !== filter.kind) continue;
        if (filter.passportId && entry.passportId !== filter.passportId) continue;
        if (filter.placeId && entry.placeId !== filter.placeId) continue;
        out.push(entry);
        if (filter.limit !== undefined && out.length >= filter.limit) break;
    }
    return out;
}
