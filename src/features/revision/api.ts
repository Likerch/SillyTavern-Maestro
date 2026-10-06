// Revision «сюжет → канон» (M8, stage 4): on ≥ 3 signals, every N messages, at scene end or by hand, a background
// task asks the cheap model what changed about KNOWN entities (new things go to M26) and routes each change to its
// owner store (plan M8 routing table) through the autonomy levels and the Inbox. Exposed as
// app.modules.api<RevisionApi>('revision').
import type { Unsubscribe } from '../../shared/contracts';

/** Where an accepted change goes (plan M8 «Маршрутизация»). */
export type RevisionTarget =
    | 'canon.fact'
    | 'ck.tags'
    | 'nai.appearance'
    | 'chat.alias'
    | 'des.alias'
    | 'chronicle.event'
    | 'places.state'
    | 'deferred.outfit'
    | 'deferred.promise'
    | 'deferred.secret';

export interface RevisionChange {
    id: string;
    /** 'known' — M8 handles it; 'new' — handed to M26. */
    class: 'known' | 'new';
    entityId?: string;
    entityName: string;
    target: RevisionTarget;
    /** Short English statement (canon), tag list (CK), passport tags (NAI), alias… */
    value: string;
    /** The change as one short Russian sentence for the user's card (plan-2 §3); the value stays as above. */
    russian?: string;
    /** What it replaces, as read when proposed (checked again before applying, plan §4.6). */
    before?: string;
    /** Quote from the chat that supports it (as written, Russian allowed). */
    evidence: string;
    sourceMessage: number;
    confidence: number;
    // Addition of the M8 implementation (optional so that fakes of the contract stay valid).
    /** Sub-target: the passport slot of 'nai.appearance' (hair, eyes, body, skin, base), the place state key. */
    field?: string;
}

export interface RevisionRun {
    id: string;
    at: number;
    reason: 'signals' | 'interval' | 'sceneEnd' | 'manual';
    fromMessage: number;
    toMessage: number;
    changes: RevisionChange[];
    /** Changes that failed the pre-write checks (bad tag, placeholder, Russian in a tag…), with the reason. */
    rejected: { change: RevisionChange; reason: string }[];
    costUsd: number;
    error?: string;
}

/** Cards that wait for a later stage's owner (outfits — stage 10, promises/secrets — stage 9). */
export interface DeferredCard {
    id: string;
    target: 'deferred.outfit' | 'deferred.promise' | 'deferred.secret';
    entityName: string;
    value: string;
    /** The change in one short Russian sentence, when the model gave one. */
    russian?: string;
    evidence: string;
    sourceMessage: number;
    at: number;
}

export interface RevisionApi {
    /** Queues a revision now (manual / `/maestro-revise`); resolves when the task is queued, not done. */
    run(reason?: RevisionRun['reason']): Promise<void>;
    runs(): RevisionRun[];
    deferred(): DeferredCard[];
    onRun(listener: (run: RevisionRun) => void): Unsubscribe;
    // Additions of the M8 implementation (optional so that fakes of the contract stay valid).
    /** Drops a deferred card (the user dismissed it in the Inbox). */
    dismissDeferred?(id: string): Promise<void>;
    /** Trigger state for the pult. */
    status?(): RevisionStatus;
    /** Fires when runs or deferred cards change (a run finished, a card was dismissed, the chat changed). */
    onChange?(listener: () => void): Unsubscribe;
}

export interface RevisionStatus {
    /** Signals waiting for the next revision. */
    pending: number;
    /** Committed messages since the last revision. */
    messagesSince: number;
    /** A run is queued or running in the background queue. */
    queued: boolean;
    /** The signals service (task 4.1) is on; without it the revision counts messages and bus signals itself. */
    signalsApi: boolean;
}
