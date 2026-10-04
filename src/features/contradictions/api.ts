// Contradiction check (M26 п.5, stage 4): a shared service — rules first (names, numbers, dates, explicit negations),
// the cheap model only on suspicion. Used by the living canon (M26), the revision (M8) and later the quality
// check (M12). Exposed as app.modules.api<ContradictionsApi>('contradictions').

export interface ContradictionInput {
    /** The new statement (English canon text or a Russian quote). */
    statement: string;
    /** Entity names it is about (world model names). */
    entities: string[];
    /** Texts it must not contradict: canon items, base entries, dossier bits; each with a label for the report. */
    against: { label: string; text: string }[];
}

export interface Contradiction {
    label: string;
    /** Short quotes of both sides. */
    statement: string;
    conflicting: string;
    kind: 'name' | 'number' | 'date' | 'negation' | 'ai';
    confidence: number;
}

export interface ContradictionResult {
    clean: boolean;
    /** True when the rules found something suspicious and the model was asked. */
    askedAi: boolean;
    contradictions: Contradiction[];
    costUsd: number;
    // Additions of the M26c implementation (optional so that fakes of the contract stay valid).
    /**
     * Why the model was not asked although the rules were not sure: 'noChat', 'group', 'notLeader', 'noProfile'
     * (no background profile or its breaker is open), 'cap' (daily background cap reached).
     */
    skipped?: 'noChat' | 'group' | 'notLeader' | 'noProfile' | 'cap';
    /**
     * The model was asked but gave no usable answer: 'timeout', 'aborted', 'parse' (malformed JSON), 'refusal',
     * 'enqueue', 'disabled' or the client's error text. The rule hits are returned as they are (askedAi false).
     */
    error?: string;
}

// Addition of the M26c implementation (optional so that callers of the stage-4 contract stay valid).
export interface CheckOptions {
    /**
     * Ask the model directly instead of through the background queue. Required when the caller itself runs inside a
     * background task (M8 'revision.run', M26 'living.extract'): the queue runs one task at a time, so waiting for a
     * queued check there would never end. check() also switches to inline by itself when a task of this chat is
     * running. Still leader-only and under the daily background cap; one request (the client's single retry for
     * invalid JSON included), bounded by `timeoutMs`.
     */
    inline?: boolean;
    /** Upper bound of the inline request, ms (default 25 000, so a 30 s caller timeout is not hit). */
    timeoutMs?: number;
    /** Aborts the inline request (the result is then the rule result with error 'aborted'). */
    signal?: AbortSignal;
}

export interface ContradictionsApi {
    /** Rules only (synchronous-cheap; safe after every reply). */
    quick(input: ContradictionInput): Contradiction[];
    /** Rules, then the cheap model on suspicion (background task, or inline — see CheckOptions; leader only). */
    check(input: ContradictionInput, options?: CheckOptions): Promise<ContradictionResult>;
}
