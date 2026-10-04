// M20 «Архитектор промпта», pure helpers for the assembled Chat Completion prompt: where an extension prompt's text
// landed among the final messages (ST trims in-chat injections and substitutes macros, glues injections of one
// depth and role into one message, and may squash system messages), splicing a replacement into it, and the
// short-term memories Qvink injects (chat[i].extra.qvink_memory, research/qvink-nai-studio.md §A1).
// Pure: no DOM, no SillyTavern.

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text parts of a message: [content] for string content, the `text` of each text part for multimodal content. */
export function messageTextParts(message: unknown): string[] {
    if (!isDict(message)) return [];
    const content = message.content;
    if (typeof content === 'string') return [content];
    if (!Array.isArray(content)) return [];
    return content.map((part) => (isDict(part) && typeof part.text === 'string' ? part.text : ''));
}

export interface TextHit {
    message: number;
    /** Index in messageTextParts(). */
    part: number;
    start: number;
    /** The needle that matched (its length is what to replace). */
    needle: string;
}

/**
 * Forms an extension prompt can take in the final prompt, most exact first: as set, trimmed (ST trims in-chat
 * injections), and with macros substituted when it has any.
 */
export function slotNeedles(value: string, substitute?: (text: string) => string): string[] {
    const needles = [value, value.trim()];
    if (substitute && value.includes('{{')) {
        try {
            needles.push(substitute(value.trim()));
        } catch {
            // keep the raw forms
        }
    }
    return [...new Set(needles.filter((needle) => needle.trim().length > 0))];
}

/** First message (from `from`) holding one of the needles. */
export function findInMessages(messages: readonly unknown[], needles: readonly string[], from = 0): TextHit | null {
    for (const needle of needles) {
        for (let index = Math.max(0, from); index < messages.length; index++) {
            const parts = messageTextParts(messages[index]);
            for (let part = 0; part < parts.length; part++) {
                const start = (parts[part] as string).indexOf(needle);
                if (start >= 0) return { message: index, part, start, needle };
            }
        }
    }
    return null;
}

export function spliceText(text: string, start: number, length: number, replacement: string): string {
    return text.slice(0, start) + replacement + text.slice(start + length);
}

/**
 * Short-term memories Qvink injects now, oldest first (its collect_chat_messages('short')): messages with a memory,
 * `include === 'short'` and not lagging.
 */
export function qvinkShortMemories(chat: readonly unknown[]): string[] {
    const result: string[] = [];
    for (const message of chat) {
        if (!isDict(message) || !isDict(message.extra)) continue;
        const record = message.extra.qvink_memory;
        if (!isDict(record) || record.include !== 'short' || record.lagging === true) continue;
        if (typeof record.memory === 'string' && record.memory.trim()) result.push(record.memory);
    }
    return result;
}
