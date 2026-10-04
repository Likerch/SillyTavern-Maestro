// Relationship history (M19, plan §2.1: «история отношений» lives in a Maestro file per chat). DES writes a
// relationship status per character into every assistant message's tracker; the history keeps only the changes:
// a point is the first committed message where a pair's status became something else. Re-reading a message replaces
// that message's points; consecutive equal statuses collapse onto the earliest one. Pure: no DOM, no SillyTavern.
import type { DesTrackerSnapshot } from './des-tracker';
import { storyTimeOf } from './world-facts';
import { normalizeName } from './world-names';

export type RelationSource = 'des' | 'canon' | 'user';

/** Same shape as `RelationPoint` of the relations API. */
export interface RelationPointData {
    messageIndex: number;
    storyTime?: string;
    status: string;
    source: RelationSource;
    /** `send_date` of the message the point was read from: tells a moved index after deletions in the middle. */
    sent?: string;
}

export interface StoredRelation {
    from: string;
    to: string;
    history: RelationPointData[];
}

/** One status read from one message. */
export interface RelationObservation {
    from: string;
    to: string;
    status: string;
    storyTime?: string;
}

/** The parts of a chat message the commit helpers read. */
export interface MessageLike {
    is_user?: boolean;
    is_system?: boolean;
}

function isAssistantMessage(message: MessageLike | null | undefined): boolean {
    return !!message && !message.is_user && !message.is_system;
}

/** Index of the assistant message committed last: the one before the last user message (P14); -1 if none. */
export function lastCommittedIndex(chat: readonly (MessageLike | null | undefined)[]): number {
    let user = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user) {
            user = i;
            break;
        }
    }
    for (let i = user - 1; i >= 0; i--) if (isAssistantMessage(chat[i])) return i;
    return -1;
}

/** An assistant message is committed once a user message follows it. */
export function isCommittedIndex(chat: readonly (MessageLike | null | undefined)[], index: number): boolean {
    if (!isAssistantMessage(chat[index])) return false;
    for (let i = index + 1; i < chat.length; i++) if (chat[i]?.is_user) return true;
    return false;
}

/** The next assistant message after `index`, -1 if none. */
export function nextAssistantIndex(chat: readonly (MessageLike | null | undefined)[], index: number): number {
    for (let i = index + 1; i < chat.length; i++) if (isAssistantMessage(chat[i])) return i;
    return -1;
}

export function relationKey(from: string, to: string): string {
    return `${normalizeName(from)}\u0000${normalizeName(to)}`;
}

/** Statuses compare without case and extra spaces («Friendly» = «friendly »). */
export function sameStatus(a: string, b: string): boolean {
    return normalizeName(a) === normalizeName(b);
}

/**
 * Sorted by message, one point per message and source (the later one in the list wins), consecutive equal statuses
 * collapsed onto the earliest. Returns a new array.
 */
export function collapseHistory(history: readonly RelationPointData[]): RelationPointData[] {
    const byMessage = new Map<string, RelationPointData>();
    for (const point of history) {
        if (!point || typeof point.status !== 'string' || !point.status.trim()) continue;
        if (!Number.isInteger(point.messageIndex) || point.messageIndex < 0) continue;
        byMessage.set(`${point.messageIndex}\u0000${point.source}`, { ...point });
    }
    const sorted = [...byMessage.values()].sort((a, b) => a.messageIndex - b.messageIndex);
    const out: RelationPointData[] = [];
    for (const point of sorted) {
        const last = out[out.length - 1];
        if (last && sameStatus(last.status, point.status)) continue;
        out.push(point);
    }
    return out;
}

/** Inserts (or replaces) one point and collapses. */
export function recordPoint(history: readonly RelationPointData[], point: RelationPointData): RelationPointData[] {
    return collapseHistory([
        ...history.filter((item) => !(item.messageIndex === point.messageIndex && item.source === point.source)),
        point,
    ]);
}

/** Current status: the last point's, '' without history. */
export function currentStatus(history: readonly RelationPointData[]): string {
    return history[history.length - 1]?.status ?? '';
}

/** Observations of one message: every character with a relationship status toward the persona. */
export function observationsFrom(
    snapshot: DesTrackerSnapshot | null,
    persona: string,
    resolve: (name: string) => string = (name) => name,
): RelationObservation[] {
    if (!snapshot || !persona.trim()) return [];
    const storyTime = storyTimeOf(snapshot.infoBox);
    const out: RelationObservation[] = [];
    for (const character of snapshot.characters) {
        if (!character.relationship) continue;
        const from = resolve(character.name) || character.name;
        if (normalizeName(from) === normalizeName(persona)) continue;
        const observation: RelationObservation = { from, to: persona, status: character.relationship };
        if (storyTime) observation.storyTime = storyTime;
        out.push(observation);
    }
    return out;
}

/**
 * Applies what one message says: its earlier points of `source` are replaced by the observations; pairs left without
 * history are dropped. Returns new relations (inputs are not changed).
 */
export function applyMessage(
    relations: readonly StoredRelation[],
    messageIndex: number,
    observations: readonly RelationObservation[],
    source: RelationSource = 'des',
    sent?: string,
): StoredRelation[] {
    const map = new Map<string, StoredRelation>();
    for (const relation of relations) {
        map.set(relationKey(relation.from, relation.to), {
            from: relation.from,
            to: relation.to,
            history: relation.history.filter(
                (point) => !(point.messageIndex === messageIndex && point.source === source),
            ),
        });
    }
    for (const observation of observations) {
        const key = relationKey(observation.from, observation.to);
        const relation = map.get(key) ?? { from: observation.from, to: observation.to, history: [] };
        const point: RelationPointData = { messageIndex, status: observation.status.trim(), source };
        if (observation.storyTime) point.storyTime = observation.storyTime;
        if (sent) point.sent = sent;
        relation.history.push(point);
        map.set(key, relation);
    }
    const out: StoredRelation[] = [];
    for (const relation of map.values()) {
        const history = collapseHistory(relation.history);
        if (history.length) out.push({ ...relation, history });
    }
    return out;
}

/**
 * Drops points of a message that is no longer what it was: `at` (swipe, edit) drops the points of that message,
 * `from` (deletion) drops that message's points and every later one.
 */
export function dropPoints(
    relations: readonly StoredRelation[],
    messageIndex: number,
    mode: 'at' | 'from',
): StoredRelation[] {
    const out: StoredRelation[] = [];
    for (const relation of relations) {
        const history = collapseHistory(
            relation.history.filter((point) =>
                mode === 'at' ? point.messageIndex !== messageIndex : point.messageIndex < messageIndex,
            ),
        );
        if (history.length) out.push({ ...relation, history });
    }
    return out;
}

/**
 * True when some DES point no longer sits on the message it was read from (messages were deleted in the middle):
 * `valid` checks the message at the point's index (an assistant message, the same `send_date`).
 */
export function needsRepair(
    relations: readonly StoredRelation[],
    valid: (point: RelationPointData) => boolean,
): boolean {
    return relations.some((relation) => relation.history.some((point) => point.source === 'des' && !valid(point)));
}

/** A point as the API shows it (without the bookkeeping `sent`). */
export function publicPoint(point: RelationPointData): RelationPointData {
    const copy = { ...point };
    delete copy.sent;
    return copy;
}

/** Relations merged by canonical names (the world model may learn later that «Лиза» is «Elizabeth»). */
export function mergeByName(
    relations: readonly StoredRelation[],
    canonical: (name: string) => string,
): StoredRelation[] {
    const map = new Map<string, StoredRelation>();
    for (const relation of relations) {
        const from = canonical(relation.from) || relation.from;
        const to = canonical(relation.to) || relation.to;
        const key = relationKey(from, to);
        const known = map.get(key);
        if (known) known.history.push(...relation.history);
        else map.set(key, { from, to, history: [...relation.history] });
    }
    const out: StoredRelation[] = [];
    for (const relation of map.values()) {
        const history = collapseHistory(relation.history);
        if (history.length) out.push({ ...relation, history });
    }
    return out;
}

/** A stored document's relations, with junk dropped (files may be edited by hand or come from an old version). */
export function readRelations(value: unknown): StoredRelation[] {
    if (!Array.isArray(value)) return [];
    const out: StoredRelation[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        if (typeof raw.from !== 'string' || typeof raw.to !== 'string' || !raw.from.trim() || !raw.to.trim()) continue;
        const history: RelationPointData[] = [];
        for (const point of Array.isArray(raw.history) ? raw.history : []) {
            if (!point || typeof point !== 'object') continue;
            const p = point as Record<string, unknown>;
            if (typeof p.messageIndex !== 'number' || typeof p.status !== 'string') continue;
            const source: RelationSource = p.source === 'canon' || p.source === 'user' ? p.source : 'des';
            const data: RelationPointData = { messageIndex: p.messageIndex, status: p.status, source };
            if (typeof p.storyTime === 'string' && p.storyTime) data.storyTime = p.storyTime;
            if (typeof p.sent === 'string' && p.sent) data.sent = p.sent;
            history.push(data);
        }
        const collapsed = collapseHistory(history);
        if (collapsed.length) out.push({ from: raw.from, to: raw.to, history: collapsed });
    }
    return out;
}
