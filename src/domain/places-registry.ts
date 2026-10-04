// M24 «Места»: the chat's place registry as plain data (plan §2.1: owner of a place's identity — id, name, aliases with
// case forms, nesting, history) and every operation on it. The feature stores it as the per-chat document 'places'.
//
// Capture (plan P14, §4.4): each committed assistant reply's DES location moves the current place; a label the
// registry does not know becomes a candidate, and a candidate seen on two consecutive committed turns becomes a place
// unless it resembles a known one (then the feature asks through the Inbox). Every capture leaves a record with what
// it changed (a trace of each touched place, each touched candidate, the previous current place), so a swipe, edit or
// deletion of that message rolls the bookkeeping back exactly, newest record first.
// Pure: no DOM, no SillyTavern; ids and case forms come from the caller.
import { cleanLabel, normalizePlaceName } from './places-label';
import { canSetParent, isAncestor, placeKeys, placeMap, resolvePlaceLabel, similarPlaces } from './places-match';

export interface VisitData {
    /** First and last committed assistant message of the stay; `to` null while it lasts. */
    from: number;
    to: number | null;
    /** Characters present (canonical names). */
    present: string[];
    storyDate?: string;
    events: string[];
}

export interface PlaceData {
    id: string;
    name: string;
    aliases: string[];
    forms: string[];
    parent: string | null;
    createdAt: number;
    firstSeen: number;
    lastSeen: number;
    visits: VisitData[];
    entry?: { world: string; uid: number };
    passportId?: string;
    state?: Record<string, string>;
    background?: string;
}

export interface CandidateData {
    /** Normalised name of the most specific unknown part (the candidate's identity). */
    key: string;
    /** The latest full DES label. */
    label: string;
    /** The most specific unknown part as DES wrote it: the future place's name. */
    name: string;
    /** Committed message indexes where it was seen (latest last). */
    seen: number[];
    /** Known places it resembles (ids); set when it was sent to the Inbox. */
    similar: string[];
    /** The most specific known place of the latest label (the future parent). */
    parent: string | null;
    /** Unknown parts between `name` and `parent`, most specific first (created as containers). */
    chain: string[];
    /** Already sent to the Inbox: not proposed again. */
    proposed?: boolean;
    createdAt: number;
}

/** What a capture may change in an existing place: enough to put it back. */
export interface PlaceTrace {
    firstSeen: number;
    lastSeen: number;
    /** Copy of the last visit before the capture (null when there was none). */
    tail: VisitData | null;
}

export interface CaptureRecord {
    /** The committed assistant message. */
    index: number;
    /** Fingerprint of that message when captured (date, swipe, label): a mismatch means it changed. */
    stamp: string;
    label: string | null;
    /** Key of the candidate this label named, if any (the two-turn rule compares consecutive records). */
    candidate?: string;
    present?: string[];
    storyDate?: string;
    /** Current place after the capture. */
    current: string | null;
    before: {
        current: string | null;
        /** Trace per touched place; null for places this capture created. */
        places: Record<string, PlaceTrace | null>;
        /** Candidates as they were (null: did not exist). */
        candidates: Record<string, CandidateData | null>;
    };
}

export interface PlacesDocData {
    places: PlaceData[];
    candidates: CandidateData[];
    current: string | null;
    /** Capture records, oldest first. */
    log: CaptureRecord[];
    /** Candidate keys the user dismissed («not a place»). */
    dismissed: string[];
}

export const PLACES_LIMITS = {
    log: 100,
    candidates: 30,
    seen: 10,
    events: 8,
    eventChars: 200,
    present: 30,
    visits: 150,
    dismissed: 100,
} as const;

/** Errors of registry edits; the feature translates the code. */
export class PlacesError extends Error {
    constructor(readonly code: 'missing' | 'empty-name' | 'bad-parent' | 'same') {
        super(code);
        this.name = 'PlacesError';
    }
}

export function emptyPlacesDoc(): PlacesDocData {
    return { places: [], candidates: [], current: null, log: [], dismissed: [] };
}

/* ------------------------------------------------------------------ reading stored data */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readVisit(raw: unknown): VisitData | null {
    if (!isDict(raw)) return null;
    const from = num(raw.from, NaN);
    if (!Number.isFinite(from)) return null;
    const visit: VisitData = {
        from,
        to: typeof raw.to === 'number' && Number.isFinite(raw.to) ? raw.to : null,
        present: strings(raw.present),
        events: strings(raw.events),
    };
    if (typeof raw.storyDate === 'string' && raw.storyDate) visit.storyDate = raw.storyDate;
    return visit;
}

function readPlace(raw: unknown): PlaceData | null {
    if (!isDict(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string' || !raw.name.trim()) {
        return null;
    }
    const place: PlaceData = {
        id: raw.id,
        name: raw.name.trim(),
        aliases: strings(raw.aliases),
        forms: strings(raw.forms),
        parent: typeof raw.parent === 'string' && raw.parent ? raw.parent : null,
        createdAt: num(raw.createdAt, 0),
        firstSeen: num(raw.firstSeen, -1),
        lastSeen: num(raw.lastSeen, -1),
        visits: (Array.isArray(raw.visits) ? raw.visits : [])
            .map(readVisit)
            .filter((visit): visit is VisitData => visit !== null)
            .sort((a, b) => a.from - b.from),
    };
    if (isDict(raw.entry) && typeof raw.entry.world === 'string' && typeof raw.entry.uid === 'number') {
        place.entry = { world: raw.entry.world, uid: raw.entry.uid };
    }
    if (typeof raw.passportId === 'string' && raw.passportId) place.passportId = raw.passportId;
    if (isDict(raw.state)) {
        const state: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw.state)) if (typeof value === 'string') state[key] = value;
        place.state = state;
    }
    if (typeof raw.background === 'string' && raw.background) place.background = raw.background;
    return place;
}

function readCandidate(raw: unknown): CandidateData | null {
    if (!isDict(raw) || typeof raw.key !== 'string' || !raw.key || typeof raw.name !== 'string') return null;
    const candidate: CandidateData = {
        key: raw.key,
        label: typeof raw.label === 'string' ? raw.label : raw.name,
        name: raw.name,
        seen: (Array.isArray(raw.seen) ? raw.seen : []).filter(
            (item): item is number => typeof item === 'number' && Number.isFinite(item),
        ),
        similar: strings(raw.similar),
        parent: typeof raw.parent === 'string' && raw.parent ? raw.parent : null,
        chain: strings(raw.chain),
        createdAt: num(raw.createdAt, 0),
    };
    if (raw.proposed === true) candidate.proposed = true;
    return candidate;
}

function readTrace(raw: unknown): PlaceTrace | null {
    if (!isDict(raw)) return null;
    return { firstSeen: num(raw.firstSeen, -1), lastSeen: num(raw.lastSeen, -1), tail: readVisit(raw.tail) };
}

function readRecord(raw: unknown): CaptureRecord | null {
    if (!isDict(raw) || typeof raw.index !== 'number' || !isDict(raw.before)) return null;
    const before = raw.before;
    const places: Record<string, PlaceTrace | null> = {};
    if (isDict(before.places)) {
        for (const [id, trace] of Object.entries(before.places)) places[id] = trace === null ? null : readTrace(trace);
    }
    const candidates: Record<string, CandidateData | null> = {};
    if (isDict(before.candidates)) {
        for (const [key, value] of Object.entries(before.candidates)) {
            candidates[key] = value === null ? null : readCandidate(value);
        }
    }
    const record: CaptureRecord = {
        index: raw.index,
        stamp: typeof raw.stamp === 'string' ? raw.stamp : '',
        label: typeof raw.label === 'string' ? raw.label : null,
        current: typeof raw.current === 'string' ? raw.current : null,
        before: {
            current: typeof before.current === 'string' ? before.current : null,
            places,
            candidates,
        },
    };
    if (typeof raw.candidate === 'string' && raw.candidate) record.candidate = raw.candidate;
    if (Array.isArray(raw.present)) record.present = strings(raw.present);
    if (typeof raw.storyDate === 'string' && raw.storyDate) record.storyDate = raw.storyDate;
    return record;
}

/**
 * A clean copy of a stored document: unknown shapes dropped, missing parents cleared, cycles broken, only the current
 * place's last visit left open. Never shares objects with `raw`.
 */
export function normalizePlacesDoc(raw: unknown): PlacesDocData {
    const source = isDict(raw) ? raw : {};
    const places: PlaceData[] = [];
    const ids = new Set<string>();
    for (const item of Array.isArray(source.places) ? source.places : []) {
        const place = readPlace(item);
        if (place && !ids.has(place.id)) {
            ids.add(place.id);
            places.push(place);
        }
    }
    for (const place of places) if (place.parent !== null && !ids.has(place.parent)) place.parent = null;
    // Break cycles: walk up from each place; a revisit means the edge into it closes a loop.
    for (const place of places) {
        const seen = new Set<string>([place.id]);
        let cursor: PlaceData | undefined = place;
        while (cursor?.parent) {
            if (seen.has(cursor.parent)) {
                cursor.parent = null;
                break;
            }
            seen.add(cursor.parent);
            cursor = places.find((item) => item.id === cursor?.parent);
        }
    }
    const current = typeof source.current === 'string' && ids.has(source.current) ? source.current : null;
    for (const place of places) {
        place.visits.forEach((visit, index) => {
            const last = index === place.visits.length - 1;
            if (visit.to === null && (!last || place.id !== current)) visit.to = Math.max(visit.from, place.lastSeen);
        });
    }
    const candidates: CandidateData[] = [];
    for (const item of Array.isArray(source.candidates) ? source.candidates : []) {
        const candidate = readCandidate(item);
        if (candidate && !candidates.some((other) => other.key === candidate.key)) candidates.push(candidate);
    }
    const log = (Array.isArray(source.log) ? source.log : [])
        .map(readRecord)
        .filter((record): record is CaptureRecord => record !== null)
        .sort((a, b) => a.index - b.index);
    return { places, candidates, current, log, dismissed: strings(source.dismissed) };
}

/* ------------------------------------------------------------------ names */

/** Aliases without blanks, repeats and the name itself (compared normalised). */
export function cleanAliases(name: string, aliases: readonly string[]): string[] {
    const seen = new Set<string>([normalizePlaceName(name)]);
    const out: string[] = [];
    for (const alias of aliases) {
        const text = alias.replace(/\s+/g, ' ').trim();
        const key = normalizePlaceName(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

/** Case forms of the name and aliases (from `forms`), plus `keep`, without repeats and without the names themselves. */
export function collectForms(
    name: string,
    aliases: readonly string[],
    forms: (name: string) => readonly string[],
    keep: readonly string[] = [],
): string[] {
    const names = new Set([name, ...aliases].map(normalizePlaceName));
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (form: unknown) => {
        if (typeof form !== 'string') return;
        const text = form.trim();
        const key = normalizePlaceName(text);
        if (!key || names.has(key) || seen.has(key)) return;
        seen.add(key);
        out.push(text);
    };
    for (const source of [name, ...aliases]) {
        let list: readonly string[];
        try {
            list = forms(source);
        } catch {
            list = [];
        }
        for (const form of Array.isArray(list) ? list : []) add(form);
    }
    for (const form of keep) add(form);
    return out;
}

/* ------------------------------------------------------------------ tree */

export interface PlaceNode {
    place: PlaceData;
    depth: number;
    children: PlaceNode[];
}

/** The places as a forest, each level sorted by name. */
export function placeTree(places: readonly PlaceData[]): PlaceNode[] {
    const byParent = new Map<string | null, PlaceData[]>();
    const ids = new Set(places.map((place) => place.id));
    for (const place of places) {
        const parent = place.parent !== null && ids.has(place.parent) ? place.parent : null;
        const list = byParent.get(parent) ?? [];
        list.push(place);
        byParent.set(parent, list);
    }
    const seen = new Set<string>();
    const build = (parent: string | null, depth: number): PlaceNode[] =>
        (byParent.get(parent) ?? [])
            .filter((place) => !seen.has(place.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((place) => {
                seen.add(place.id);
                return { place, depth, children: build(place.id, depth + 1) };
            });
    return build(null, 0);
}

/** The forest in display order (parents before children). */
export function flattenTree(nodes: readonly PlaceNode[]): PlaceNode[] {
    const out: PlaceNode[] = [];
    const walk = (list: readonly PlaceNode[]) => {
        for (const node of list) {
            out.push(node);
            walk(node.children);
        }
    };
    walk(nodes);
    return out;
}

/* ------------------------------------------------------------------ chat */

/** What committedIndices needs of a chat message. */
export interface ChatLine {
    is_user?: boolean;
    is_system?: boolean;
}

/**
 * Committed assistant replies (P14): for every user message, the last assistant message before it — exactly what the
 * turn pipeline reports as `turn:committed` when that user message is sent. Hidden user messages still count.
 */
export function committedIndices(chat: readonly (ChatLine | null | undefined)[]): number[] {
    const out: number[] = [];
    let lastAssistant = -1;
    chat.forEach((message, index) => {
        if (!message) return;
        if (message.is_user) {
            if (lastAssistant >= 0 && out[out.length - 1] !== lastAssistant) out.push(lastAssistant);
        } else if (!message.is_system) {
            lastAssistant = index;
        }
    });
    return out;
}

/* ------------------------------------------------------------------ capture */

export interface CaptureInput {
    index: number;
    stamp: string;
    /** DES `infoBox.location` of the committed message (null when DES wrote none). */
    label: string | null;
    present: readonly string[];
    storyDate?: string;
    events: readonly string[];
    now: number;
}

export interface CaptureDeps {
    /** A new place id, unique in the document. */
    newId(): string;
    /** Russian case forms of a name (DES-RU), [] when unknown. */
    forms(name: string): readonly string[];
}

/** A candidate that resembles known places: the feature sends it to the Inbox (kind 'places.merge'). */
export interface MergeProposalData {
    key: string;
    label: string;
    name: string;
    parent: string | null;
    similar: string[];
    index: number;
}

export interface CaptureResult {
    changed: boolean;
    /** Places created by this capture (promoted candidates and their containers). */
    created: string[];
    proposals: MergeProposalData[];
}

function copyVisit(visit: VisitData): VisitData {
    const copy: VisitData = { from: visit.from, to: visit.to, present: [...visit.present], events: [...visit.events] };
    if (visit.storyDate !== undefined) copy.storyDate = visit.storyDate;
    return copy;
}

function copyCandidate(candidate: CandidateData): CandidateData {
    return { ...candidate, seen: [...candidate.seen], similar: [...candidate.similar], chain: [...candidate.chain] };
}

function traceOf(place: PlaceData): PlaceTrace {
    const tail = place.visits[place.visits.length - 1];
    return { firstSeen: place.firstSeen, lastSeen: place.lastSeen, tail: tail ? copyVisit(tail) : null };
}

function clip(text: string): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length > PLACES_LIMITS.eventChars ? `${value.slice(0, PLACES_LIMITS.eventChars - 1)}…` : value;
}

function mergeUnique(target: string[], items: readonly string[], cap: number, keepLatest: boolean): string[] {
    const out = [...target];
    for (const item of items) {
        const text = clip(item);
        if (text && !out.includes(text)) out.push(text);
    }
    if (out.length <= cap) return out;
    return keepLatest ? out.slice(out.length - cap) : out.slice(0, cap);
}

interface VisitInput {
    present: readonly string[];
    storyDate?: string;
    events: readonly string[];
}

function openVisit(place: PlaceData, from: number, input: VisitInput): void {
    const visit: VisitData = {
        from,
        to: null,
        present: mergeUnique([], input.present, PLACES_LIMITS.present, false),
        events: mergeUnique([], input.events, PLACES_LIMITS.events, true),
    };
    if (input.storyDate) visit.storyDate = input.storyDate;
    place.visits.push(visit);
    if (place.visits.length > PLACES_LIMITS.visits) place.visits.splice(0, place.visits.length - PLACES_LIMITS.visits);
}

function extendVisit(place: PlaceData, index: number, input: VisitInput): void {
    const visit = place.visits[place.visits.length - 1];
    if (!visit || visit.to !== null) {
        openVisit(place, index, input);
        return;
    }
    visit.present = mergeUnique(visit.present, input.present, PLACES_LIMITS.present, false);
    visit.events = mergeUnique(visit.events, input.events, PLACES_LIMITS.events, true);
    if (!visit.storyDate && input.storyDate) visit.storyDate = input.storyDate;
}

function closeVisit(place: PlaceData): void {
    const visit = place.visits[place.visits.length - 1];
    if (visit && visit.to === null) visit.to = Math.max(visit.from, place.lastSeen);
}

/** Touch-tracking for one record: the first touch keeps what to restore. */
class Touches {
    constructor(private readonly record: CaptureRecord) {}

    place(place: PlaceData): void {
        if (!(place.id in this.record.before.places)) this.record.before.places[place.id] = traceOf(place);
    }

    created(id: string): void {
        if (!(id in this.record.before.places)) this.record.before.places[id] = null;
    }

    candidate(key: string, current: CandidateData | undefined): void {
        if (!(key in this.record.before.candidates)) {
            this.record.before.candidates[key] = current ? copyCandidate(current) : null;
        }
    }
}

/** Moves the current place to `target` at `index` (closing the stay at the previous place), or extends the stay. */
function enter(
    doc: PlacesDocData,
    target: PlaceData | null,
    index: number,
    from: number,
    input: VisitInput,
    touch: Touches,
) {
    const previous = doc.current ? doc.places.find((place) => place.id === doc.current) : undefined;
    if (previous && target && previous.id === target.id) {
        touch.place(target);
        extendVisit(target, index, input);
        target.lastSeen = Math.max(target.lastSeen, index);
        return;
    }
    if (previous) {
        touch.place(previous);
        closeVisit(previous);
    }
    doc.current = target?.id ?? null;
    if (!target) return;
    touch.place(target);
    closeVisit(target);
    openVisit(target, from, input);
    target.lastSeen = Math.max(target.lastSeen, index);
    if (target.firstSeen < 0) target.firstSeen = from;
}

function newPlace(
    doc: PlacesDocData,
    name: string,
    parent: string | null,
    deps: CaptureDeps,
    now: number,
    seen: { first: number; last: number },
): PlaceData {
    const place: PlaceData = {
        id: uniqueId(doc, deps),
        name: name.replace(/\s+/g, ' ').trim(),
        aliases: [],
        forms: [],
        parent,
        createdAt: now,
        firstSeen: seen.first,
        lastSeen: seen.last,
        visits: [],
    };
    place.forms = collectForms(place.name, [], deps.forms);
    doc.places.push(place);
    return place;
}

function uniqueId(doc: PlacesDocData, deps: CaptureDeps): string {
    for (let attempt = 0; attempt < 20; attempt++) {
        const id = deps.newId();
        if (id && !doc.places.some((place) => place.id === id)) return id;
    }
    let n = doc.places.length + 1;
    while (doc.places.some((place) => place.id === `p${n}`)) n++;
    return `p${n}`;
}

/**
 * Creates the candidate's containers (general first; a container that resembles a known place is skipped rather than
 * duplicated) and the place itself; drops the candidate. Returns the new place and every created id.
 */
function createFromCandidate(
    doc: PlacesDocData,
    candidate: CandidateData,
    deps: CaptureDeps,
    now: number,
    lastSeen: number,
    touch: Touches | null,
): { place: PlaceData; created: string[] } {
    const created: string[] = [];
    const first = candidate.seen.length ? Math.min(...candidate.seen) : lastSeen;
    let parent =
        candidate.parent !== null && doc.places.some((place) => place.id === candidate.parent)
            ? candidate.parent
            : null;
    for (const part of [...candidate.chain].reverse()) {
        const key = normalizePlaceName(part);
        const existing = doc.places.find((place) => place.parent === parent && placeKeys(place).includes(key));
        if (existing) {
            parent = existing.id;
            continue;
        }
        if (!key || similarPlaces(doc.places, part, parent).length) continue;
        const container = newPlace(doc, part, parent, deps, now, { first, last: lastSeen });
        touch?.created(container.id);
        created.push(container.id);
        parent = container.id;
    }
    const place = newPlace(doc, candidate.name, parent, deps, now, { first, last: lastSeen });
    touch?.created(place.id);
    created.push(place.id);
    removeCandidate(doc, candidate.key, touch);
    return { place, created };
}

function removeCandidate(doc: PlacesDocData, key: string, touch: Touches | null): void {
    const index = doc.candidates.findIndex((candidate) => candidate.key === key);
    if (index < 0) return;
    touch?.candidate(key, doc.candidates[index]);
    doc.candidates.splice(index, 1);
}

/** The latest record that carried a label (records without one are transparent for the two-turn rule). */
function lastLabeled(doc: PlacesDocData): CaptureRecord | undefined {
    for (let i = doc.log.length - 1; i >= 0; i--) {
        const record = doc.log[i] as CaptureRecord;
        if (record.label !== null) return record;
    }
    return undefined;
}

function recordChanged(doc: PlacesDocData, record: CaptureRecord): boolean {
    return (
        Object.keys(record.before.places).length > 0 ||
        Object.keys(record.before.candidates).length > 0 ||
        record.before.current !== doc.current
    );
}

/**
 * Applies one committed reply to the registry (mutates `doc`). Records at or after `input.index` are rolled back first,
 * so a message is never counted twice. Without a label the current place just goes on (its visit gains the present
 * characters and events). A resolved label moves the current place; an unresolved one makes or advances a candidate
 * and puts the current place at the most specific known container (null when none).
 */
export function applyCapture(doc: PlacesDocData, input: CaptureInput, deps: CaptureDeps): CaptureResult {
    if (doc.log.some((record) => record.index >= input.index)) rollbackFrom(doc, input.index);
    const label = cleanLabel(input.label);
    const previous = lastLabeled(doc);
    const record: CaptureRecord = {
        index: input.index,
        stamp: input.stamp,
        label,
        current: doc.current,
        before: { current: doc.current, places: {}, candidates: {} },
    };
    if (input.present.length) record.present = [...input.present];
    if (input.storyDate) record.storyDate = input.storyDate;
    const touch = new Touches(record);
    const result: CaptureResult = { changed: false, created: [], proposals: [] };
    const byId = (id: string | null) => (id ? doc.places.find((place) => place.id === id) : undefined);

    if (label === null) {
        const current = byId(doc.current);
        if (current) enter(doc, current, input.index, input.index, input, touch);
    } else {
        const resolution = resolvePlaceLabel(doc.places, label, { current: doc.current });
        let target: PlaceData | null;
        let from = input.index;
        if (resolution.match) {
            target = byId(resolution.match) ?? null;
            // DES often drops the room for a turn («Tavern, Main Hall» → «Tavern»): a container of the current place
            // keeps the stay where it is instead of bouncing the visit (and NAI's continuity) up and back.
            if (target && doc.current && isAncestor(placeMap(doc.places), target.id, doc.current)) {
                target = byId(doc.current) ?? target;
            }
            const key = normalizePlaceName(resolution.parts[0] ?? label);
            removeCandidate(doc, key, touch);
        } else {
            target = byId(resolution.deepest) ?? null;
            const name = resolution.unknown[0] ?? label;
            const key = normalizePlaceName(name);
            if (key && !doc.dismissed.includes(key)) {
                record.candidate = key;
                let candidate = doc.candidates.find((item) => item.key === key);
                touch.candidate(key, candidate);
                if (!candidate) {
                    candidate = {
                        key,
                        label,
                        name,
                        seen: [],
                        similar: [],
                        parent: null,
                        chain: [],
                        createdAt: input.now,
                    };
                    doc.candidates.push(candidate);
                }
                candidate.label = label;
                candidate.name = name;
                candidate.parent = resolution.deepest;
                candidate.chain = resolution.unknown.slice(1);
                candidate.seen = [...candidate.seen.filter((index) => index < input.index), input.index].slice(
                    -PLACES_LIMITS.seen,
                );
                const consecutive = previous !== undefined && previous.candidate === key;
                if (consecutive && !candidate.proposed) {
                    const similar = similarPlaces(doc.places, name, resolution.deepest);
                    if (similar.length) {
                        candidate.similar = similar;
                        candidate.proposed = true;
                        result.proposals.push({
                            key,
                            label,
                            name,
                            parent: resolution.deepest,
                            similar,
                            index: input.index,
                        });
                    } else {
                        const promoted = createFromCandidate(doc, candidate, deps, input.now, input.index, touch);
                        result.created.push(...promoted.created);
                        target = promoted.place;
                        from = previous.index;
                    }
                }
                pruneCandidates(doc, touch);
            }
        }
        enter(doc, target, input.index, from, input, touch);
    }

    record.current = doc.current;
    result.changed = recordChanged(doc, record);
    if (result.changed) {
        doc.log.push(record);
        if (doc.log.length > PLACES_LIMITS.log) doc.log.splice(0, doc.log.length - PLACES_LIMITS.log);
    }
    return result;
}

/** Keeps at most PLACES_LIMITS.candidates, dropping the ones seen longest ago (never one sent to the Inbox first). */
function pruneCandidates(doc: PlacesDocData, touch: Touches): void {
    while (doc.candidates.length > PLACES_LIMITS.candidates) {
        const lastSeen = (candidate: CandidateData) => candidate.seen[candidate.seen.length - 1] ?? -1;
        const pool = doc.candidates.filter((candidate) => !candidate.proposed);
        const victims = [...(pool.length ? pool : doc.candidates)].sort((a, b) => lastSeen(a) - lastSeen(b));
        const victim = victims[0];
        if (!victim) return;
        removeCandidate(doc, victim.key, touch);
    }
}

/**
 * Undoes every record at or after `index`, newest first: places it created disappear, touched places get their
 * first/last seen and last visit back (visits opened by it go), candidates and the current place are restored.
 * A created place the user has invested in since (renamed, other names, a description entry, a passport, state or
 * background) stays, unvisited: undoing a turn must not throw away the user's work or an id NAI Studio is bound to.
 */
export function rollbackFrom(doc: PlacesDocData, index: number): { count: number; earliest: number | null } {
    let count = 0;
    let earliest: number | null = null;
    while (doc.log.length && (doc.log[doc.log.length - 1] as CaptureRecord).index >= index) {
        const record = doc.log.pop() as CaptureRecord;
        count++;
        earliest = record.index;
        const kept: PlaceData[] = [];
        for (const [id, trace] of Object.entries(record.before.places)) {
            if (trace === null) {
                const created = doc.places.find((item) => item.id === id);
                if (created && invested(created)) {
                    created.visits = [];
                    created.firstSeen = -1;
                    created.lastSeen = -1;
                    kept.push(created);
                } else {
                    dropPlace(doc, id);
                }
                continue;
            }
            const place = doc.places.find((item) => item.id === id);
            if (!place) continue;
            place.firstSeen = trace.firstSeen;
            place.lastSeen = trace.lastSeen;
            place.visits = place.visits.filter((visit) => visit.from < record.index);
            if (trace.tail) {
                const tail = trace.tail;
                const at = place.visits.findIndex((visit) => visit.from === tail.from);
                if (at >= 0) place.visits[at] = copyVisit(tail);
            }
        }
        for (const [key, candidate] of Object.entries(record.before.candidates)) {
            const at = doc.candidates.findIndex((item) => item.key === key);
            if (candidate === null) {
                if (at >= 0) doc.candidates.splice(at, 1);
            } else if (at >= 0) doc.candidates[at] = copyCandidate(candidate);
            else doc.candidates.push(copyCandidate(candidate));
        }
        for (const place of kept) {
            const keys = placeKeys(place);
            doc.candidates = doc.candidates.filter((candidate) => !keys.includes(candidate.key));
        }
        const restored = record.before.current;
        doc.current = restored !== null && doc.places.some((place) => place.id === restored) ? restored : null;
    }
    return { count, earliest };
}

/** The user (or another module) put something into this place beyond what capture made. */
function invested(place: PlaceData): boolean {
    return !!(place.entry || place.passportId || place.aliases.length || place.state || place.background);
}

/** Removes a place without journal bookkeeping (rollback of a capture that created it). */
function dropPlace(doc: PlacesDocData, id: string): void {
    const index = doc.places.findIndex((place) => place.id === id);
    if (index < 0) return;
    const [removed] = doc.places.splice(index, 1);
    for (const place of doc.places) if (place.parent === id) place.parent = removed?.parent ?? null;
    if (doc.current === id) doc.current = null;
}

/** The earliest record whose message changed (stamp differs or the message is gone), or null. */
export function firstStaleRecord(
    doc: PlacesDocData,
    stampAt: (index: number) => string | null,
    recent = Infinity,
): number | null {
    const start = Math.max(0, doc.log.length - recent);
    for (let i = start; i < doc.log.length; i++) {
        const record = doc.log[i] as CaptureRecord;
        if (stampAt(record.index) !== record.stamp) return record.index;
    }
    return null;
}

/** Index of the latest capture record, -1 when none. */
export function lastRecordIndex(doc: PlacesDocData): number {
    return doc.log.length ? (doc.log[doc.log.length - 1] as CaptureRecord).index : -1;
}

/* ------------------------------------------------------------------ user edits */

export interface PlaceFields {
    name: string;
    parent?: string | null;
    aliases?: readonly string[];
}

/** Adds a place by hand (not seen yet: first and last seen are -1). */
export function addPlace(doc: PlacesDocData, fields: PlaceFields, deps: CaptureDeps, now: number): PlaceData {
    const name = fields.name.replace(/\s+/g, ' ').trim();
    if (!name) throw new PlacesError('empty-name');
    const parent = fields.parent ?? null;
    if (parent !== null && !doc.places.some((place) => place.id === parent)) throw new PlacesError('bad-parent');
    const place = newPlace(doc, name, parent, deps, now, { first: -1, last: -1 });
    if (fields.aliases?.length) {
        place.aliases = cleanAliases(name, fields.aliases);
        place.forms = collectForms(name, place.aliases, deps.forms);
    }
    return place;
}

/** Fields a user (or another module) may change; `id` and `visits` stay. */
export type PlacePatch = Partial<Omit<PlaceData, 'id' | 'visits'>>;

export function copyPlace(place: PlaceData): PlaceData {
    const copy: PlaceData = {
        ...place,
        aliases: [...place.aliases],
        forms: [...place.forms],
        visits: place.visits.map(copyVisit),
    };
    if (place.entry) copy.entry = { ...place.entry };
    if (place.state) copy.state = { ...place.state };
    return copy;
}

/**
 * Changes a place. A new name or aliases recompute the case forms (unless `forms` is given); the old name of a renamed
 * place stays as an alias, so DES labels that still use it resolve.
 */
export function updatePlace(
    doc: PlacesDocData,
    id: string,
    patch: PlacePatch,
    deps: Pick<CaptureDeps, 'forms'>,
): { before: PlaceData; after: PlaceData } {
    const place = doc.places.find((item) => item.id === id);
    if (!place) throw new PlacesError('missing');
    const before = copyPlace(place);
    if (patch.parent !== undefined && patch.parent !== place.parent) {
        if (!canSetParent(doc.places, id, patch.parent)) throw new PlacesError('bad-parent');
        place.parent = patch.parent;
    }
    let names = false;
    if (patch.name !== undefined) {
        const name = patch.name.replace(/\s+/g, ' ').trim();
        if (!name) throw new PlacesError('empty-name');
        if (name !== place.name) {
            const old = place.name;
            place.name = name;
            place.aliases = cleanAliases(name, [...(patch.aliases ?? place.aliases), old]);
            names = true;
        }
    }
    if (patch.aliases !== undefined && !names) {
        place.aliases = cleanAliases(place.name, patch.aliases);
        names = true;
    }
    if (patch.forms !== undefined) place.forms = collectForms(place.name, place.aliases, () => [], patch.forms);
    else if (names) place.forms = collectForms(place.name, place.aliases, deps.forms);
    for (const key of ['createdAt', 'firstSeen', 'lastSeen'] as const) {
        const value = patch[key];
        if (typeof value === 'number' && Number.isFinite(value)) place[key] = value;
    }
    if ('entry' in patch) {
        if (patch.entry) place.entry = { world: patch.entry.world, uid: patch.entry.uid };
        else delete place.entry;
    }
    if ('passportId' in patch) {
        if (patch.passportId) place.passportId = patch.passportId;
        else delete place.passportId;
    }
    if ('state' in patch) {
        if (patch.state) place.state = { ...patch.state };
        else delete place.state;
    }
    if ('background' in patch) {
        if (patch.background) place.background = patch.background;
        else delete place.background;
    }
    return { before, after: copyPlace(place) };
}

export interface RemoveOutcome {
    removed: PlaceData;
    /** Children moved up to the removed place's parent: as they were. */
    reparented: PlaceData[];
    currentBefore: string | null;
}

/** Removes a place: its children move up to its parent, candidates and records forget it. */
export function removePlace(doc: PlacesDocData, id: string): RemoveOutcome {
    const index = doc.places.findIndex((place) => place.id === id);
    if (index < 0) throw new PlacesError('missing');
    const removed = copyPlace(doc.places[index] as PlaceData);
    const currentBefore = doc.current;
    const reparented: PlaceData[] = [];
    doc.places.splice(index, 1);
    for (const place of doc.places) {
        if (place.parent !== id) continue;
        reparented.push(copyPlace(place));
        place.parent = removed.parent;
    }
    for (const candidate of doc.candidates) {
        if (candidate.parent === id) candidate.parent = removed.parent;
        candidate.similar = candidate.similar.filter((other) => other !== id);
    }
    forgetInLog(doc, id, null);
    if (doc.current === id) doc.current = null;
    return { removed, reparented, currentBefore };
}

/** Records stop restoring `id`; references to it as the current place point to `replacement`. */
function forgetInLog(doc: PlacesDocData, id: string, replacement: string | null): void {
    for (const record of doc.log) {
        delete record.before.places[id];
        if (record.before.current === id) record.before.current = replacement;
        if (record.current === id) record.current = replacement;
        for (const candidate of Object.values(record.before.candidates)) {
            if (!candidate) continue;
            if (candidate.parent === id) candidate.parent = replacement;
            candidate.similar = [
                ...new Set(candidate.similar.map((other) => (other === id ? replacement : other))),
            ].filter((other): other is string => other !== null);
        }
    }
}

export interface MergeOutcome {
    keepBefore: PlaceData;
    keepAfter: PlaceData;
    merged: PlaceData;
    reparented: PlaceData[];
    currentBefore: string | null;
    /** `from` of the visits moved from the merged place (undo takes them out again). */
    movedVisits: number[];
}

/**
 * Merges `mergeId` into `keepId`: names become aliases, visits join (sorted), seen ranges widen, the description entry
 * and passport are kept from `keep` when it has them, children move over, the current place follows.
 */
export function mergePlaces(
    doc: PlacesDocData,
    keepId: string,
    mergeId: string,
    deps: Pick<CaptureDeps, 'forms'>,
): MergeOutcome {
    if (keepId === mergeId) throw new PlacesError('same');
    const keep = doc.places.find((place) => place.id === keepId);
    const merge = doc.places.find((place) => place.id === mergeId);
    if (!keep || !merge) throw new PlacesError('missing');
    const keepBefore = copyPlace(keep);
    const merged = copyPlace(merge);
    const currentBefore = doc.current;
    const reparented: PlaceData[] = [];
    const byId = placeMap(doc.places);
    // keep under merge: lift keep out first so moving merge's children under keep cannot close a loop.
    let walker = keep.parent;
    const guard = new Set<string>();
    while (walker !== null && !guard.has(walker)) {
        guard.add(walker);
        if (walker === mergeId) {
            keep.parent = merge.parent === keepId ? null : merge.parent;
            break;
        }
        walker = byId.get(walker)?.parent ?? null;
    }
    for (const place of doc.places) {
        if (place.parent !== mergeId || place.id === keepId) continue;
        reparented.push(copyPlace(place));
        place.parent = keepId;
    }
    keep.aliases = cleanAliases(keep.name, [...keep.aliases, merge.name, ...merge.aliases]);
    keep.forms = collectForms(keep.name, keep.aliases, deps.forms, [...keep.forms, ...merge.forms]);
    const mergeWasCurrent = doc.current === mergeId;
    if (mergeWasCurrent) closeVisit(keep);
    else closeVisit(merge);
    keep.visits = [...keep.visits, ...merge.visits.map(copyVisit)].sort((a, b) => a.from - b.from);
    for (let i = 0; i < keep.visits.length - 1; i++) {
        const visit = keep.visits[i] as VisitData;
        if (visit.to === null) visit.to = Math.max(visit.from, (keep.visits[i + 1] as VisitData).from);
    }
    const seen = [keep.firstSeen, merge.firstSeen].filter((value) => value >= 0);
    keep.firstSeen = seen.length ? Math.min(...seen) : -1;
    keep.lastSeen = Math.max(keep.lastSeen, merge.lastSeen);
    const created = [keep.createdAt, merge.createdAt].filter((value) => value > 0);
    keep.createdAt = created.length ? Math.min(...created) : 0;
    if (!keep.entry && merge.entry) keep.entry = { ...merge.entry };
    if (!keep.passportId && merge.passportId) keep.passportId = merge.passportId;
    if (!keep.state && merge.state) keep.state = { ...merge.state };
    if (!keep.background && merge.background) keep.background = merge.background;
    doc.places.splice(doc.places.indexOf(merge), 1);
    for (const candidate of doc.candidates) {
        if (candidate.parent === mergeId) candidate.parent = keepId;
        if (candidate.similar.includes(mergeId)) {
            candidate.similar = [...new Set(candidate.similar.map((other) => (other === mergeId ? keepId : other)))];
        }
    }
    forgetInLog(doc, mergeId, keepId);
    if (mergeWasCurrent) doc.current = keepId;
    return {
        keepBefore,
        keepAfter: copyPlace(keep),
        merged,
        reparented,
        currentBefore,
        movedVisits: merged.visits.map((visit) => visit.from),
    };
}

/* ------------------------------------------------------------------ candidates */

/**
 * The latest record that named this candidate, while it is still the latest labeled one and its fallback is still
 * current: resolving the candidate then also moves the current place (and the record learns how to undo it).
 */
function liveRecord(doc: PlacesDocData, key: string): CaptureRecord | undefined {
    const record = lastLabeled(doc);
    if (!record || record.candidate !== key || record.current !== doc.current) return undefined;
    return record;
}

function enterAtRecord(doc: PlacesDocData, place: PlaceData, record: CaptureRecord): void {
    const touch = new Touches(record);
    enter(
        doc,
        place,
        record.index,
        record.index,
        { present: record.present ?? [], storyDate: record.storyDate, events: [] },
        touch,
    );
    record.current = doc.current;
}

/** Creates the candidate as a new place (the user's «Create»): containers too; it becomes current if DES is there. */
export function createCandidatePlace(
    doc: PlacesDocData,
    key: string,
    deps: CaptureDeps,
    now: number,
): { place: PlaceData; created: string[] } {
    const candidate = doc.candidates.find((item) => item.key === key);
    if (!candidate) throw new PlacesError('missing');
    const record = liveRecord(doc, key);
    const last = candidate.seen[candidate.seen.length - 1] ?? -1;
    const outcome = createFromCandidate(doc, candidate, deps, now, last, null);
    if (record) enterAtRecord(doc, outcome.place, record);
    return outcome;
}

/** The candidate is another name of a known place (the Inbox «merge» or the user's choice): its name becomes an alias. */
export function mergeCandidate(
    doc: PlacesDocData,
    key: string,
    targetId: string,
    deps: Pick<CaptureDeps, 'forms'>,
): { before: PlaceData; after: PlaceData } {
    const candidate = doc.candidates.find((item) => item.key === key);
    const target = doc.places.find((place) => place.id === targetId);
    if (!candidate || !target) throw new PlacesError('missing');
    const before = copyPlace(target);
    target.aliases = cleanAliases(target.name, [...target.aliases, candidate.name]);
    target.forms = collectForms(target.name, target.aliases, deps.forms, target.forms);
    const seen = candidate.seen.filter((index) => index >= 0);
    if (seen.length && (target.firstSeen < 0 || Math.min(...seen) < target.firstSeen))
        target.firstSeen = Math.min(...seen);
    const record = liveRecord(doc, key);
    removeCandidate(doc, key, null);
    if (record) enterAtRecord(doc, target, record);
    return { before, after: copyPlace(target) };
}

/** «Not a place»: the candidate goes and its name is never collected again. */
export function dismissCandidate(doc: PlacesDocData, key: string): boolean {
    const index = doc.candidates.findIndex((item) => item.key === key);
    if (index < 0) return false;
    doc.candidates.splice(index, 1);
    if (!doc.dismissed.includes(key)) doc.dismissed.push(key);
    if (doc.dismissed.length > PLACES_LIMITS.dismissed)
        doc.dismissed.splice(0, doc.dismissed.length - PLACES_LIMITS.dismissed);
    return true;
}

/* ------------------------------------------------------------------ undo of user edits */

/** Puts back the user-editable fields of a place from a journal snapshot; visits moved in by a merge go out again. */
export function restorePlaceFields(
    doc: PlacesDocData,
    snapshot: PlaceData,
    movedVisits: readonly number[] = [],
): boolean {
    const place = doc.places.find((item) => item.id === snapshot.id);
    if (!place) return false;
    place.name = snapshot.name;
    place.aliases = [...snapshot.aliases];
    place.forms = [...snapshot.forms];
    place.parent = canSetParent(doc.places, place.id, snapshot.parent) ? snapshot.parent : null;
    if (snapshot.entry) place.entry = { ...snapshot.entry };
    else delete place.entry;
    if (snapshot.passportId) place.passportId = snapshot.passportId;
    else delete place.passportId;
    if (snapshot.state) place.state = { ...snapshot.state };
    else delete place.state;
    if (snapshot.background) place.background = snapshot.background;
    else delete place.background;
    if (movedVisits.length) {
        const moved = new Set(movedVisits);
        place.visits = place.visits.filter((visit) => !moved.has(visit.from));
        place.firstSeen = snapshot.firstSeen;
        place.lastSeen = Math.max(snapshot.lastSeen, place.visits[place.visits.length - 1]?.to ?? -1);
    }
    return true;
}

/** Brings back a removed or merged place from its snapshot (no-op when the id is taken again). */
export function reinsertPlace(doc: PlacesDocData, snapshot: PlaceData): boolean {
    if (doc.places.some((place) => place.id === snapshot.id)) return false;
    const place = copyPlace(snapshot);
    if (place.parent !== null && !doc.places.some((item) => item.id === place.parent)) place.parent = null;
    for (const visit of place.visits) if (visit.to === null) visit.to = Math.max(visit.from, place.lastSeen);
    doc.places.push(place);
    return true;
}
