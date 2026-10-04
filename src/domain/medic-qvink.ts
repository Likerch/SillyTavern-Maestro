// "Gaps" of Qvink Memory (plan M3, M22 'qvink.gapGuard'; research/qvink-nai-studio.md §A1). With "Remove Messages"
// on, Qvink drops every message older than its injection threshold from the prompt, summarised or not; a message
// there that Qvink would summarise but has not is lost to the model. Qvink keeps no API: the caller reads
// `extra.qvink_memory` of each message into the view below. Pure.

export interface QvinkMessageView {
    isUser: boolean;
    isSystem: boolean;
    /** Length of the message text (characters). */
    textLength: number;
    /** NAI Studio picture post or another non-story message. */
    skip: boolean;
    /** `extra.qvink_memory`, null when Qvink has no record for the message. */
    record: {
        memory: string;
        exclude: boolean;
        remember: boolean;
        /** Still newer than the threshold (in the prompt as raw text). Undefined when Qvink did not mark it. */
        lagging?: boolean;
    } | null;
}

export interface QvinkGapOptions {
    /** Qvink setting `include_user_messages` (default false). */
    includeUser: boolean;
    /** Qvink setting `include_system_messages` (default false). */
    includeSystem: boolean;
    /** Qvink `message_length_threshold` in tokens (default 10); compared as ~3 characters per token. */
    minTokens: number;
}

export const QVINK_GAP_DEFAULTS: QvinkGapOptions = { includeUser: false, includeSystem: false, minTokens: 10 };

const CHARS_PER_TOKEN = 3;

/**
 * Last index Qvink already dropped from the prompt: the newest message marked `lagging: false`. Qvink computes
 * lagging as `index < threshold`, so everything up to it is outside the prompt. -1 when nothing is.
 */
export function qvinkRemovalBoundary(messages: readonly QvinkMessageView[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.record?.lagging === false) return i;
    }
    return -1;
}

/** Indexes of messages in the removal zone that Qvink would summarise but has no memory for. */
export function findQvinkGaps(
    messages: readonly QvinkMessageView[],
    options: QvinkGapOptions = QVINK_GAP_DEFAULTS,
): number[] {
    const boundary = qvinkRemovalBoundary(messages);
    const gaps: number[] = [];
    const minChars = Math.max(0, options.minTokens) * CHARS_PER_TOKEN;
    for (let i = 0; i <= boundary; i++) {
        const message = messages[i];
        if (!message || message.skip) continue;
        if (message.isSystem && !options.includeSystem) continue;
        if (message.isUser && !options.includeUser) continue;
        if (message.textLength < minChars) continue;
        const record = message.record;
        if (record?.exclude) continue;
        if (record?.memory.trim()) continue;
        gaps.push(i);
    }
    return gaps;
}
