// Signals and commit-on-send (stage 4, task 4.1; plan §4.4, §5 phase 1, P14, P15): when the user sends a message the
// previous assistant reply is final, and the signal service compares its DES tracker and Qvink memory with the turn
// before → signals on app.bus ('signal'). No AI, nothing heavy on the send path: the comparison runs right after
// the send in a microtask/idle slot. Exposed as app.modules.api<SignalsApi>('signals').
import type { Signal, Unsubscribe } from '../../shared/contracts';

/** Signal kinds of stage 4 (Signal.kind). Later stages add their own (quality, outfit, promise…). */
export type SignalKind =
    | 'relationship.changed'
    | 'appearance.changed'
    | 'location.changed'
    | 'time.skipped'
    | 'scene.ended'
    | 'quest.added'
    | 'quest.removed'
    | 'character.appeared'
    | 'character.left'
    | 'alias.added'
    | 'memory.long'
    | 'memory.added'
    | 'name.new'
    | 'fact.new';

export interface SignalBatch {
    /** Assistant message index the signals were committed for. */
    messageIndex: number;
    signals: Signal[];
    /** Same-kind signals of one entity folded into one (plan §4.4 «свёртка»). */
    folded: number;
    // Addition of the S4 implementation (optional so that fakes of the contract stay valid).
    /**
     * Signals added to a turn that was already read: the place registry (M24) reported the move after the comparison
     * ran. Such a batch carries only the added signals (location.changed and, if new, scene.ended).
     */
    late?: boolean;
}

export interface SignalsApi {
    /** Signals not yet consumed by a revision (oldest first). */
    pending(): Signal[];
    /** Marks signals up to this message index consumed (called by the revision after a run). */
    consume(upToMessageIndex: number): Promise<void>;
    /** Last committed batch (pult, tests). */
    last(): SignalBatch | null;
    /** Messages since the last revision (the «every N messages» trigger). */
    messagesSinceRevision(): number;
    onBatch(listener: (batch: SignalBatch) => void): Unsubscribe;
}
