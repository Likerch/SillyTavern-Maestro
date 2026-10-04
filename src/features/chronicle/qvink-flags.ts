// Qvink's «remember» mark, written the way Qvink 1.3.29 writes it (research/qvink-nai-studio.md §A1, audit T13).
// Qvink has no API: `remember_message_toggle` is module-private and `/qm-toggle-remember` only toggles (and does not
// await). Its `set_data` writes `chat[i].extra.qvink_memory[key]` and copies the whole record into
// `swipe_info[swipe_id].extra.qvink_memory` — but only when `swipe_id` is truthy, so the swipe-0 copy is never
// updated. Maestro owns the mark (plan M9 п. 3): it writes `remember: true` and `exclude: false` (Qvink's toggle
// clears «exclude» too) on the live record and on EVERY swipe's copy, then asks Qvink to refresh (`/qm-refresh`:
// inclusion flags, injections, brain icons) and saves the chat. A message without a summary yet is summarised
// (`/qm-summarize`), as Qvink's own toggle does.
import { QVINK_KEY } from '../../adapters/qvink';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The two flags of one Qvink record; null when the record did not exist. */
export interface FlagState {
    remember: boolean;
    exclude: boolean;
}

/** Flags of the live record and of each swipe's copy (index = swipe id), as they were before Maestro wrote. */
export interface RememberState {
    live: FlagState | null;
    swipes: (FlagState | null)[];
}

function flagsOf(extra: unknown): FlagState | null {
    const record = isDict(extra) ? extra[QVINK_KEY] : undefined;
    if (!isDict(record)) return null;
    return { remember: record.remember === true, exclude: record.exclude === true };
}

function swipeInfos(message: STChatMessage): unknown[] {
    return Array.isArray(message.swipe_info) ? (message.swipe_info as unknown[]) : [];
}

function currentSwipe(message: STChatMessage): number {
    return typeof message.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
}

export function readRememberState(message: STChatMessage): RememberState {
    return {
        live: flagsOf(message.extra),
        swipes: swipeInfos(message).map((info) => (isDict(info) ? flagsOf(info.extra) : null)),
    };
}

export function isRemembered(message: STChatMessage | undefined): boolean {
    return !!message && flagsOf(message.extra)?.remember === true;
}

export function hasSummary(message: STChatMessage | undefined): boolean {
    const record = message?.extra?.[QVINK_KEY];
    return isDict(record) && typeof record.memory === 'string' && record.memory.trim().length > 0;
}

/** The record of an `extra` object, created when missing. */
function recordIn(holder: Dict): Dict {
    const extra = isDict(holder.extra) ? holder.extra : (holder.extra = {});
    const record = isDict(extra[QVINK_KEY]) ? (extra[QVINK_KEY] as Dict) : (extra[QVINK_KEY] = {});
    return record as Dict;
}

/** Sets or restores the flags of a record; `null` removes the flags (the record goes when nothing else is left). */
function setFlags(holder: Dict, state: FlagState | null): void {
    if (state) {
        const record = recordIn(holder);
        record.remember = state.remember;
        record.exclude = state.exclude;
        return;
    }
    const extra = isDict(holder.extra) ? holder.extra : null;
    const record = extra && isDict(extra[QVINK_KEY]) ? (extra[QVINK_KEY] as Dict) : null;
    if (!extra || !record) return;
    delete record.remember;
    delete record.exclude;
    if (!Object.keys(record).length) delete extra[QVINK_KEY];
}

/**
 * «Remember» on the live record and on every swipe's copy. The current swipe's copy is the live record itself
 * (Qvink's set_data copies it whole); other swipes keep their own summaries and only get the flags.
 */
export function writeRemember(message: STChatMessage): void {
    setFlags(message as unknown as Dict, { remember: true, exclude: false });
    const live = (message.extra as Dict)[QVINK_KEY] as Dict;
    const current = currentSwipe(message);
    swipeInfos(message).forEach((info, index) => {
        if (!isDict(info)) return;
        if (index === current) {
            const extra = isDict(info.extra) ? info.extra : (info.extra = {});
            (extra as Dict)[QVINK_KEY] = structuredClone(live);
            return;
        }
        setFlags(info, { remember: true, exclude: false });
    });
}

/** Puts the flags back as they were before (undo). */
export function restoreRemember(message: STChatMessage, before: RememberState): void {
    setFlags(message as unknown as Dict, before.live);
    swipeInfos(message).forEach((info, index) => {
        if (isDict(info)) setFlags(info, before.swipes[index] ?? null);
    });
}

/** A stored RememberState (journal JSON) or null. */
export function readStoredState(raw: unknown): RememberState | null {
    if (!isDict(raw) || !Array.isArray(raw.swipes)) return null;
    const flags = (value: unknown): FlagState | null =>
        isDict(value) ? { remember: value.remember === true, exclude: value.exclude === true } : null;
    return { live: flags(raw.live), swipes: raw.swipes.map(flags) };
}
