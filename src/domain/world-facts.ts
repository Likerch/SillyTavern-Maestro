// Structured facts of the world model at stage 3 (M7, plan §4.2): DES tracker fields (relationship and appearance)
// as provisional facts tied to the message and in-story time they come from, and chat canon items as facts with the
// item's status. Stage 4 adds revision facts. Pure: no DOM, no SillyTavern.
import type { DesCharacter, DesInfoBox } from './des-tracker';
import type { WorldSource } from './world-identity';

export type WorldFactStatus = 'provisional' | 'active' | 'stale' | 'disputed';

/** Same shape as `Fact` of the world API. */
export interface WorldFact {
    entity: string;
    text: string;
    source: WorldSource;
    storyTime?: string;
    messageIndex?: number;
    confidence: number;
    status: WorldFactStatus;
}

/** The part of a canon item a fact needs (src/features/canon/api.ts CanonItem). */
export interface CanonItemLike {
    uid: number;
    meta: { status: string };
    entry: Record<string, unknown>;
}

/** Per-character DES fields that describe looks (English snake_case keys and DES-RU's Russian ones). */
const APPEARANCE_FIELD_RE = /appear|look|outfit|cloth|wear|attire|внешн|облик|одежд|наряд/i;
const DES_CONFIDENCE = 0.5;
const CANON_CONFIDENCE: Record<string, number> = { active: 0.9, provisional: 0.5, archived: 0.3 };

/** «date, time» (or «date, start–end») of a DES scene; undefined when DES has neither. */
export function storyTimeOf(info: DesInfoBox | null | undefined): string | undefined {
    if (!info) return undefined;
    const time = info.time
        ? info.time.start && info.time.end && info.time.end !== info.time.start
            ? `${info.time.start}–${info.time.end}`
            : (info.time.start ?? info.time.end)
        : undefined;
    const parts = [info.date, time].filter((part): part is string => !!part && !!part.trim());
    return parts.length ? parts.join(', ') : undefined;
}

/** Relationship and appearance fields of one DES character as provisional facts. */
export function desFacts(
    entity: string,
    character: DesCharacter,
    messageIndex: number,
    storyTime?: string,
): WorldFact[] {
    const source: WorldSource = {
        kind: 'des.character',
        ref: `${messageIndex}#${character.name}`,
        label: character.name,
        messageIndex,
    };
    const facts: WorldFact[] = [];
    const push = (text: string) => {
        const fact: WorldFact = {
            entity,
            text,
            source: { ...source },
            messageIndex,
            confidence: DES_CONFIDENCE,
            status: 'provisional',
        };
        if (storyTime) fact.storyTime = storyTime;
        facts.push(fact);
    };
    if (character.relationship) push(`relationship: ${character.relationship}`);
    for (const [field, value] of Object.entries(character.details)) {
        if (APPEARANCE_FIELD_RE.test(field) && value.trim()) push(`${field}: ${value.trim()}`);
    }
    return facts;
}

/** A canon item as a fact: active items are active facts, provisional ones provisional, archived ones stale. */
export function canonFact(entity: string, item: CanonItemLike, book: string): WorldFact | null {
    const content = typeof item.entry.content === 'string' ? item.entry.content.trim() : '';
    if (!content) return null;
    const comment = typeof item.entry.comment === 'string' ? item.entry.comment.trim() : '';
    const status = item.meta.status === 'active' ? 'active' : item.meta.status === 'archived' ? 'stale' : 'provisional';
    return {
        entity,
        text: content,
        source: {
            kind: 'canon.entry',
            ref: `${book}#${item.uid}`,
            label: comment || `#${item.uid}`,
            world: book,
            uid: item.uid,
        },
        confidence: CANON_CONFIDENCE[item.meta.status] ?? CANON_CONFIDENCE.provisional ?? 0.5,
        status,
    };
}
