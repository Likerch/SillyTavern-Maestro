// M20 «Архитектор промпта», pure presence/place logic (plan M20 п. 3): lore about characters who are not in the
// scene and about far places is damped unless one of them was mentioned in the last K messages; lore about the
// characters present and about the current place is pinned. "Near" places are the current one, its ancestors, its
// descendants and its siblings (same parent); everything else in the registry is far.
// Pure: no DOM, no SillyTavern.
import { readTypedMeta } from './entry-types';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface PlaceNodeLike {
    id: string;
    parent: string | null;
}

/** Ids of the current place, its ancestors, descendants and siblings; empty without a current place. */
export function nearPlaceIds(places: readonly PlaceNodeLike[], currentId: string | null): Set<string> {
    const near = new Set<string>();
    if (!currentId) return near;
    const byId = new Map(places.map((place) => [place.id, place]));
    const current = byId.get(currentId);
    near.add(currentId);
    if (!current) return near;
    // Ancestors (guarded against cycles in a hand-edited registry).
    let parent = current.parent;
    while (parent && !near.has(parent)) {
        near.add(parent);
        parent = byId.get(parent)?.parent ?? null;
    }
    // Descendants.
    const children = new Map<string, string[]>();
    for (const place of places) {
        if (!place.parent) continue;
        const list = children.get(place.parent) ?? [];
        list.push(place.id);
        children.set(place.parent, list);
    }
    const stack = [...(children.get(currentId) ?? [])];
    while (stack.length) {
        const id = stack.pop() as string;
        if (near.has(id)) continue;
        near.add(id);
        stack.push(...(children.get(id) ?? []));
    }
    // Siblings: only under a common parent (two top-level cities are not neighbours).
    if (current.parent) for (const id of children.get(current.parent) ?? []) near.add(id);
    return near;
}

/** World-model entity id of a registry place. */
export function placeEntityId(placeId: string): string {
    return `place:${placeId}`;
}

/**
 * Messages since each entity was last mentioned: `perMessage` lists the entity ids mentioned in each message,
 * oldest first; the newest message has distance 0.
 */
export function mentionDistances(perMessage: readonly (readonly string[])[]): Map<string, number> {
    const result = new Map<string, number>();
    for (let i = perMessage.length - 1; i >= 0; i--) {
        const distance = perMessage.length - 1 - i;
        for (const id of perMessage[i] ?? []) if (!result.has(id)) result.set(id, distance);
    }
    return result;
}

export interface SubjectRef {
    /** World-model entity id (`character:anna`, `place:<registry id>`). */
    id: string;
    kind: 'character' | 'place';
}

export interface PresenceFacts {
    /** Characters in the scene (last committed DES tracker). */
    present: ReadonlySet<string>;
    /** DES roster characters not in the scene. */
    absent: ReadonlySet<string>;
    /** Entity id of the current place, null when unknown. */
    currentPlace: string | null;
    /** Entity ids of the near places (see nearPlaceIds). */
    nearPlaces: ReadonlySet<string>;
    /** Entity id → messages since its last mention (see mentionDistances). */
    mentions: ReadonlyMap<string, number>;
    /** K: mentions in the last K messages keep an entry. */
    window: number;
}

export type PresenceVerdict =
    { action: 'none' } | { action: 'pin' } | { action: 'damp'; reason: 'absent' | 'farPlace'; sinceMention: number };

/** What the presence rule does with an entry about `subject`. */
export function judgeSubject(subject: SubjectRef, facts: PresenceFacts): PresenceVerdict {
    const since = facts.mentions.get(subject.id);
    const recent = since !== undefined && since < facts.window;
    if (subject.kind === 'character') {
        if (facts.present.has(subject.id)) return { action: 'pin' };
        if (facts.absent.has(subject.id) && !recent) {
            return { action: 'damp', reason: 'absent', sinceMention: since ?? -1 };
        }
        return { action: 'none' };
    }
    if (!facts.currentPlace) return { action: 'none' };
    if (subject.id === facts.currentPlace) return { action: 'pin' };
    if (!facts.nearPlaces.has(subject.id) && !recent) {
        return { action: 'damp', reason: 'farPlace', sinceMention: since ?? -1 };
    }
    return { action: 'none' };
}

/* ------------------------------------------------------------------ entry subjects */

export interface SubjectName {
    name: string;
    /** The entry type says what the name is ('character' / 'place'); undefined = any kind. */
    kind?: 'character' | 'place';
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** First primary key that is a plain word or name (regex keys `/…/flags` are skipped). */
export function firstPlainKey(entry: Dict): string {
    if (!Array.isArray(entry.key)) return '';
    for (const raw of entry.key) {
        const key = text(raw);
        if (key && !/^\/.+\/[a-z]*$/i.test(key)) return key;
    }
    return '';
}

/** Typed metadata of an entry: `extensions.maestro` (Maestro and canon books) or the given sidecar record. */
export function typedMetaOf(entry: Dict, sidecar?: unknown): { type: string; fields: Record<string, string> } | null {
    const extensions = isDict(entry.extensions) ? entry.extensions : undefined;
    return readTypedMeta(extensions?.maestro) ?? readTypedMeta(sidecar);
}

/**
 * Names an entry may be about, best first: the typed name (with the kind its type gives), then the comment, then the
 * first plain key. A typed entry of another type (item, rule, chapter…) is about no character or place: [].
 */
export function subjectNames(
    entry: Dict,
    typed?: { type: string; fields: Record<string, string> } | null,
): SubjectName[] {
    const names: SubjectName[] = [];
    if (typed) {
        if (typed.type !== 'character' && typed.type !== 'place') return [];
        const kind = typed.type;
        const name = text(typed.fields.name);
        if (name) names.push({ name, kind });
        const comment = text(entry.comment);
        if (comment) names.push({ name: comment, kind });
        const key = firstPlainKey(entry);
        if (key) names.push({ name: key, kind });
        return dedupe(names);
    }
    const comment = text(entry.comment);
    if (comment) names.push({ name: comment });
    const key = firstPlainKey(entry);
    if (key) names.push({ name: key });
    return dedupe(names);
}

function dedupe(names: SubjectName[]): SubjectName[] {
    const seen = new Set<string>();
    return names.filter((item) => {
        const id = `${item.kind ?? ''}\u0000${item.name.toLowerCase()}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

/** Cache key of an entry's subject: everything the resolution reads (identity, comment, first key, type marker). */
export function subjectCacheKey(entry: Dict): string {
    const extensions = isDict(entry.extensions) ? entry.extensions : undefined;
    const maestro = isDict(extensions?.maestro) ? extensions.maestro : undefined;
    const typed = maestro ? `${String(maestro.type ?? '')}:${JSON.stringify(maestro.typeFields ?? '')}` : '';
    return `${String(entry.world)}#${String(entry.uid)}#${text(entry.comment)}#${firstPlainKey(entry)}#${typed}`;
}

/**
 * Entries the pin rule may force into the scan: enabled, not constant (already active), with text, and without
 * gates ST would check (character filter, generation triggers, probability, recursion delay) — forcing must not
 * bypass a condition the author set.
 */
export function isPinnable(entry: Dict): boolean {
    if (entry.disable === true || entry.constant === true) return false;
    if (typeof entry.content !== 'string' || !entry.content.trim()) return false;
    if (Array.isArray(entry.triggers) && entry.triggers.length) return false;
    const filter = isDict(entry.characterFilter) ? entry.characterFilter : undefined;
    if (filter) {
        const names = Array.isArray(filter.names) ? filter.names.length : 0;
        const tags = Array.isArray(filter.tags) ? filter.tags.length : 0;
        if (names || tags) return false;
    }
    if (entry.useProbability === true && typeof entry.probability === 'number' && entry.probability < 100) return false;
    const delay = entry.delayUntilRecursion;
    return !(delay === true || (typeof delay === 'number' && delay > 0));
}
