// Living canon (M26, stage 4): what the model invented (a tradition, a holiday, a family history, a tavern's name)
// becomes provisional canon after the turn is committed, and is confirmed only by the rules of plan M26 п.4.
// Storage is the chat canon (M6 items with origin 'living', status 'provisional' → 'active').
// Exposed as app.modules.api<LivingCanonApi>('livingCanon').
import type { Unsubscribe } from '../../shared/contracts';

export type ConfirmReason = 'userMentioned' | 'userAccepted' | 'resurfaced' | 'survived';

export interface LivingFact {
    /** Canon item uid once saved. */
    uid?: number;
    name: string;
    type: string;
    /** Russian quote as the model wrote it (cheap path). */
    quote: string;
    /** English canon text (filled by the batch extraction). */
    text?: string;
    keys: string[];
    sourceMessage: number;
    status: 'draft' | 'provisional' | 'active' | 'disputed' | 'dropped';
    survivedTurns: number;
    confirmedBy?: ConfirmReason;
}

/** A new fact handed over by another module (the revision's class 'new', plan M8 «Анализ»). */
export interface LivingProposal {
    name: string;
    /** Supporting quote from a committed message, as written (Russian allowed). */
    quote: string;
    sourceMessage: number;
    type?: string;
    /** English canon text, when the proposer already has one. */
    text?: string;
    /** The fact as one short Russian sentence for the user, when the proposer has one. */
    russian?: string;
}

export interface LivingCanonApi {
    /** Draft facts of the reply not yet committed (P14). */
    drafts(): LivingFact[];
    provisional(): LivingFact[];
    /** Explicit acceptance by the user (confirms when the contradiction check is clean). */
    accept(uid: number): Promise<boolean>;
    drop(uid: number): Promise<void>;
    /** Queues the batch extraction now (normally every N messages). */
    extractNow(): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M26 implementation (optional so that fakes of the stage-4 contract stay valid).
    /**
     * A new fact from another module (the revision hands class 'new' changes over here; the bus signal 'fact.new'
     * with the same data works too). Goes through the same rules: known names, K per turn, contradictions, autonomy.
     * True when it was saved, merged, queued or sent to the Inbox as disputed.
     */
    propose?(fact: LivingProposal): Promise<boolean>;
    /** Every living fact that is not dropped (provisional, confirmed, disputed). */
    facts?(): LivingFact[];
    /**
     * Counters for the R3 metrics (since the chat started using M26), kept in the chat document: provisional facts
     * ever created, facts the user dropped himself (drop(), the pult, a rejected Inbox card — not swipe/edit
     * removals), facts that became confirmed, and confirmed facts that later got a contradiction (a conflict card).
     */
    stats?(): { provisional: number; droppedByUser: number; confirmed: number; contradictedAfterConfirm: number };
}
