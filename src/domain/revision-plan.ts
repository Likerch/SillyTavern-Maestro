// Revision (M8) scheduling and bookkeeping (plan M8 «Запуск», P14): when a run is due (≥ N signals, every N
// messages, scene end), which messages it reads (only committed turns: the reply the user has not answered yet is
// still a draft), and the capped lists the chat document keeps (runs, deferred cards).
// Pure: no DOM, no SillyTavern.

export type TriggerReason = 'signals' | 'interval' | 'sceneEnd';

export interface TriggerSettings {
    /** Pending signals that start a run (plan: 3). */
    signalThreshold: number;
    /** Messages since the last revision that start a run (plan: 10); 0 = off. */
    everyMessages: number;
    /** A finished scene (location change, time skip) starts a run. */
    sceneEnd: boolean;
}

export interface TriggerState {
    pending: number;
    messagesSince: number;
    sceneEnded: boolean;
}

/** Why a run is due now (scene end first, then signals, then the interval); null when none is. */
export function decideTrigger(state: TriggerState, settings: TriggerSettings): TriggerReason | null {
    if (settings.sceneEnd && state.sceneEnded && (state.pending > 0 || state.messagesSince > 0)) return 'sceneEnd';
    if (settings.signalThreshold > 0 && state.pending >= settings.signalThreshold) return 'signals';
    if (settings.everyMessages > 0 && state.messagesSince >= settings.everyMessages) return 'interval';
    return null;
}

export interface ChatLike {
    is_user?: unknown;
    is_system?: unknown;
}

/**
 * Last message index a revision may read (P14): the last user message. Replies after it are not committed yet —
 * the user may still swipe them. -1 when the user has not written anything.
 */
export function committedEnd(chat: readonly ChatLike[]): number {
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message && message.is_user === true && message.is_system !== true) return index;
    }
    return -1;
}

/** Messages of the next run: after the last revised one, at most `maxMessages` back from the end; null when empty. */
export function revisionRange(lastTo: number, end: number, maxMessages: number): { from: number; to: number } | null {
    if (end < 0) return null;
    const from = Math.max(lastTo + 1, end - Math.max(1, maxMessages) + 1, 0);
    return from <= end ? { from, to: end } : null;
}

/** Stage of the plan whose module owns a deferred target (outfits: M27, promises and secrets: M17/M18). */
export function deferredStage(target: string): number {
    return target === 'deferred.outfit' ? 10 : 9;
}

/** Appends and drops the oldest items above the cap (in place); returns the list. */
export function pushCapped<T>(list: T[], item: T, cap: number): T[] {
    list.push(item);
    if (cap >= 0 && list.length > cap) list.splice(0, list.length - cap);
    return list;
}

function norm(text: string): string {
    return text
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\s.,;:!?«»"'“”]+/g, ' ')
        .trim();
}

/** Two deferred cards say the same (the next revision often finds the same promise again). */
export function sameDeferred(
    a: { target: string; entityName: string; value: string },
    b: { target: string; entityName: string; value: string },
): boolean {
    return a.target === b.target && norm(a.entityName) === norm(b.entityName) && norm(a.value) === norm(b.value);
}
