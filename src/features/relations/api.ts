// Relationship graph (M19): data at stage 3 (DES tracker per committed turn + canon facts), prompt use at stage 8
// (voice cards). Stored in a Maestro file per chat (plan §2.1: history of relationships).
// Exposed as app.modules.api<RelationsApi>('relations').
import type { Unsubscribe } from '../../shared/contracts';

export interface RelationPoint {
    messageIndex: number;
    storyTime?: string;
    /** As DES stores it (`relationship.status`), e.g. "Friendly", "Romantic interest", «Недоверие». */
    status: string;
    source: 'des' | 'canon' | 'user';
}

export interface Relation {
    /** Canonical names (world model ids when resolved). */
    from: string;
    to: string;
    current: string;
    history: RelationPoint[];
}

/**
 * A stance of Dramatis's personality engine (release 1.17): what one character thinks of another now, NPC → the
 * player's persona and NPC ↔ NPC, with the engine's reasons. Read live from DRAMATIS_API; Maestro stores nothing.
 */
export interface EngineStance {
    /** Canonical names (world model) when resolved. */
    from: string;
    to: string;
    /** −3 … +3. */
    stance: number;
    /** The engine's ladder word in the UI language («Враждебен»). */
    label: string;
    reasons: string[];
    /** Toward the user's persona (else between two characters). */
    toPersona: boolean;
    source: 'dramatis';
}

export interface RelationsApi {
    all(): Relation[];
    of(name: string): Relation[];
    between(from: string, to: string): Relation | undefined;
    /** Re-reads every committed DES tracker of the chat (cheap; used after import or a long gap). */
    rebuild(): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    // Addition of release 1.17 (optional so that fakes stay valid).
    /** Dramatis's stances (empty without Dramatis); onChange fires when they change. */
    engine?(): EngineStance[];
}
