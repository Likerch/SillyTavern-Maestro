// Calendar and promises (M17, stage 9): agreements and deadlines — who, what, when in story time — extracted during
// the revision (M8 deferred cards of kind 'deferred.promise' are processed here, also the backlog of stages 4–8).
// Story time comes from DES. A due item becomes a reminder through the director's note; overdue or broken ones are a
// reason for consequences. Stored in a Maestro file per chat. Exposed as app.modules.api<CalendarApi>('calendar').
import type { Unsubscribe } from '../../shared/contracts';

export interface StoryMoment {
    /** As DES writes it, e.g. «12 Зимня», "Day 3", "Spring, 1024". */
    label: string;
    /** Parsed ordinal day when the calendar could be understood (for comparisons), else null. */
    day: number | null;
    /** Minutes since midnight when a time is known. */
    minutes?: number;
}

export type PromiseStatus = 'open' | 'due' | 'overdue' | 'done' | 'cancelled' | 'broken';

export interface StoryPromise {
    id: string;
    /** Who promised / agreed (canonical names). */
    who: string[];
    /** To whom (canonical names; the persona included). */
    toWhom: string[];
    /** English, short (the player's language for a promise the preparation of a Russian story made). */
    what: string;
    /**
     * The English statement when `what` is in the story's language (a Russian story's prepared promise): the revision's
     * English statements are matched against it too. Optional: older documents and fakes have none.
     */
    english?: string;
    /** Russian quote from the chat (as written). */
    quote: string;
    due: StoryMoment | null;
    status: PromiseStatus;
    sourceMessage: number;
    createdAt: number;
}

/** A revision statement about a promise (M8 'deferred.promise'): the model's English sentence and its quote. */
export interface PromiseIntake {
    /** Who promised, as the model wrote it (resolved to the canonical name). */
    entityName: string;
    /** One English sentence; may carry the deadline ("by sunset") or an outcome ("Kept her promise to …"). */
    value: string;
    /** Verbatim quote from the chat (Russian allowed); a second place to look for the deadline. */
    evidence: string;
    sourceMessage: number;
}

export interface CalendarApi {
    now(): StoryMoment | null;
    promises(filter?: { status?: PromiseStatus }): StoryPromise[];
    add(promise: Omit<StoryPromise, 'id' | 'createdAt' | 'status'>): Promise<string>;
    setStatus(id: string, status: PromiseStatus): Promise<void>;
    /** Items that became due since the last committed turn (the director turns them into notes). */
    due(): StoryPromise[];
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M17 implementation (optional so that fakes of the contract stay valid).
    /**
     * Takes a revision statement: a new promise (the deadline read from the statement or the quote, relative to the
     * story time of its message), or the outcome of a known one (kept → done, broken, called off → cancelled).
     * Resolves to the promise id, null when nothing was stored (an outcome of an unknown promise, an empty statement).
     */
    intake?(statement: PromiseIntake): Promise<string | null>;
    /** Story moment of a committed message (the DES time of its turn), null when unknown. */
    momentAt?(messageIndex: number): StoryMoment | null;
}
