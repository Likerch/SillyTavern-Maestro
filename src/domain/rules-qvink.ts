// Pure parts of M22 «"Дыры" Qvink» (audit T12; research/qvink-nai-studio.md §A1). Qvink's interceptor flags every
// prompt entry older than its threshold with `extra[Symbol.for('ignore')] = true`, summarised or not. The gap guard
// returns only the messages Qvink *would* summarise but has not yet, so these helpers mirror Qvink 1.3.29's
// `check_message_exclusion` and map ST's prompt entries back to live chat indexes for `/qm-summarize`.

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `chat[i].extra.qvink_memory`. */
export const QVINK_MEMORY_KEY = 'qvink_memory';

/** Qvink settings read by the exclusion check (`extension_settings.qvink_memory`), with Qvink's defaults. */
export interface QvinkExclusionSettings {
    include_user_messages?: unknown;
    include_system_messages?: unknown;
    include_narrator_messages?: unknown;
    message_length_threshold?: unknown;
    disabled_group_characters?: unknown;
}

export interface QvinkCheckOptions {
    /** Current group id (`ctx.groupId`); null outside group chats. */
    groupId?: string | null;
    /** Token count of a text (Qvink uses ST's tokenizer). */
    tokenCount: (text: string) => number;
}

function memoryRecord(message: unknown): Dict | null {
    if (!isDict(message) || !isDict(message.extra)) return null;
    const record = message.extra[QVINK_MEMORY_KEY];
    return isDict(record) ? record : null;
}

/** The message already has a Qvink summary (non-empty `memory`). */
export function hasQvinkMemory(message: unknown): boolean {
    const memory = memoryRecord(message)?.memory;
    return typeof memory === 'string' && memory.trim().length > 0;
}

/**
 * Qvink would summarise this message (Qvink 1.3.29 `check_message_exclusion`, index.js:3744-3798): "remember"
 * always counts; "exclude", user messages (unless enabled), thought messages, hidden system messages (unless
 * enabled), narrator messages (unless enabled), disabled group members and messages shorter than the length
 * threshold do not. Context budgets are not part of this check.
 */
export function qvinkWouldSummarize(
    message: unknown,
    settings: QvinkExclusionSettings | null | undefined,
    options: QvinkCheckOptions,
): boolean {
    if (!isDict(message)) return false;
    const record = memoryRecord(message);
    if (record?.is_qvink_system_memory) return false;
    if (record?.remember === true) return true;
    if (record?.exclude === true) return false;
    const s = settings ?? {};
    if (message.is_user === true && s.include_user_messages !== true) return false;
    if (message.is_thoughts === true) return false;
    if (message.is_system === true && s.include_system_messages !== true) return false;
    const extra = isDict(message.extra) ? message.extra : {};
    if (extra.type === 'narrator' && s.include_narrator_messages !== true) return false;
    if (options.groupId && isDict(s.disabled_group_characters)) {
        const disabled = s.disabled_group_characters[options.groupId];
        if (Array.isArray(disabled) && disabled.includes(message.original_avatar)) return false;
    }
    const threshold = typeof s.message_length_threshold === 'number' ? s.message_length_threshold : 10;
    const text = typeof message.mes === 'string' ? message.mes : '';
    return options.tokenCount(text) >= threshold;
}

/**
 * Live chat index of every prompt entry, by position: ST builds the prompt chat as
 * `chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)))` and gives each copy
 * its position as `index` (script.js Generate, coreChat).
 */
export function promptChatIndexes(chat: readonly unknown[], canUseTools: boolean): number[] {
    const indexes: number[] = [];
    chat.forEach((message, index) => {
        if (!isDict(message)) return;
        const tools = canUseTools && isDict(message.extra) && Array.isArray(message.extra.tool_invocations);
        if (message.is_system !== true || tools) indexes.push(index);
    });
    return indexes;
}

function sameMessage(entry: Dict, message: unknown): boolean {
    return (
        isDict(message) &&
        message.send_date === entry.send_date &&
        message.name === entry.name &&
        (message.is_user === true) === (entry.is_user === true)
    );
}

/**
 * Live chat index of one prompt entry: its `index` through the mapping when that message matches (send date, name,
 * author), otherwise the newest live message that matches; -1 when none does.
 */
export function liveIndexOf(entry: unknown, chat: readonly unknown[], mapping: readonly number[]): number {
    if (!isDict(entry)) return -1;
    const position = entry.index;
    if (typeof position === 'number' && Number.isInteger(position)) {
        const candidate = mapping[position];
        if (candidate !== undefined && sameMessage(entry, chat[candidate])) return candidate;
    }
    if (entry.send_date === undefined || entry.send_date === '') return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (sameMessage(entry, chat[i])) return i;
    }
    return -1;
}

/** Sorted unique indexes as inclusive runs: [5, 6, 7, 9] → [[5, 7], [9, 9]]. */
export function contiguousRanges(indexes: readonly number[]): [number, number][] {
    const sorted = [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b);
    const ranges: [number, number][] = [];
    for (const index of sorted) {
        const last = ranges[ranges.length - 1];
        if (last && index === last[1] + 1) last[1] = index;
        else ranges.push([index, index]);
    }
    return ranges;
}

/** STscript range argument: `5` or `5-7`. */
export function rangeArgument(range: readonly [number, number]): string {
    return range[0] === range[1] ? String(range[0]) : `${range[0]}-${range[1]}`;
}
