// Who knows what (M18, stage 9, experimental — off by default): scene participants know the scene's events (by the
// DES cast at the time of the event) without AI; secrets are marked during the revision (M8 deferred cards of kind
// 'deferred.secret' are processed here). Voice cards of present characters get «does not know: …» only when the
// topic came up. Stored in a Maestro file per chat. Exposed as app.modules.api<KnowledgeApi>('knowledge').
import type { Unsubscribe } from '../../shared/contracts';

export interface KnowledgeFact {
    id: string;
    /** English, short (the player's language for a secret the preparation of a Russian story made). */
    text: string;
    /**
     * The English statement when `text` is in the story's language (a Russian story's prepared secret): the revision's
     * English statements of the same secret find it. Optional: older documents and fakes have none.
     */
    english?: string;
    /** Topic words (RU/EN) used to decide whether the topic «came up». */
    topics: string[];
    /** Canonical names of characters who know it. */
    knownBy: string[];
    secret: boolean;
    sourceMessage: number;
    at: number;
    // Addition of the M18 implementation (optional so that fakes of the contract stay valid).
    /** The sentence of the reply (or the revision's quote) the fact came from, as written. */
    quote?: string;
}

/** A secret as the revision finds it (the fields of its 'deferred.secret' card). */
export interface SecretIntake {
    /** The entity the secret is about. */
    entityName: string;
    /** Short English statement, e.g. «Anna is a spy for the Duke; Kai does not know». */
    value: string;
    /** Quote from the chat (Russian allowed). */
    evidence: string;
    sourceMessage: number;
}

export interface KnowledgeApi {
    facts(): KnowledgeFact[];
    /** What a character does not know among the facts whose topic came up in the recent messages. */
    unknownFor(character: string, recentText: string): KnowledgeFact[];
    markKnown(factId: string, character: string): Promise<void>;
    addSecret(fact: Omit<KnowledgeFact, 'id' | 'at' | 'secret'>): Promise<string>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M18 implementation (optional so that fakes of the contract stay valid).
    /**
     * A secret straight from the revision: knowers are read from the statement («X knows», «Y does not know») or are
     * the cast of the source turn; topics are the names it mentions. Resolves the fact id, or null without a chat.
     */
    intakeSecret?(secret: SecretIntake): Promise<string | null>;
    /** The pult's «знает» toggle switched off (journaled, undoable like markKnown). */
    markUnknown?(factId: string, character: string): Promise<void>;
}
