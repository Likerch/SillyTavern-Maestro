// M36 «Промпты соседей», pure helpers for the copies applied at generation time: a neighbour's global text, as it went
// into the outgoing Chat Completion messages, is replaced by Maestro's copy for the card or the chat. The text is
// looked for in the forms an extension prompt can take there (as set, trimmed, macro-substituted —
// architect-prompt.ts slotNeedles), inside messages that may hold other text too (ST glues injections of one depth and
// role, a slot may hold several of a neighbour's texts). Messages keep their objects, roles and other keys; only the
// text of the part that held the text changes. Pure: no DOM, no SillyTavern.
import { messageTextParts, slotNeedles } from './architect-prompt';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Texts shorter than this are not looked for: they would match by chance. */
export const MIN_NEEDLE_LENGTH = 12;

/** The forms of a global text worth looking for (too short ones dropped). */
export function textNeedles(text: string, substitute?: (text: string) => string): string[] {
    return slotNeedles(text, substitute).filter((needle) => needle.trim().length >= MIN_NEEDLE_LENGTH);
}

/** Replaces the text of one part of a message in place (string content, or a new parts array with a new part). */
function setPartText(message: Dict, part: number, text: string): void {
    if (typeof message.content === 'string') {
        message.content = text;
        return;
    }
    if (!Array.isArray(message.content)) return;
    const parts = [...(message.content as unknown[])];
    const old = parts[part];
    if (!isDict(old)) return;
    parts[part] = { ...old, text };
    message.content = parts;
}

/**
 * Replaces every occurrence of the first needle form found anywhere in the messages by `replacement`; returns how
 * many were replaced (0 = the text was not there).
 */
export function replaceInMessages(
    messages: readonly unknown[],
    needles: readonly string[],
    replacement: string,
): number {
    for (const needle of needles) {
        if (!needle) continue;
        let count = 0;
        for (const message of messages) {
            if (!isDict(message)) continue;
            const parts = messageTextParts(message);
            parts.forEach((text, part) => {
                if (!text.includes(needle)) return;
                const pieces = text.split(needle);
                count += pieces.length - 1;
                setPartText(message, part, pieces.join(replacement));
            });
        }
        if (count) return count;
    }
    return 0;
}

/** `{name}`-style placeholders of a neighbour filled from `values` (unknown ones stay as they are). */
export function fillBraces(text: string, values: Record<string, string>): string {
    return text.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole));
}

/** `{{name}}`-style placeholders filled from `values` (unknown ones stay for ST's macro engine). */
export function fillDoubleBraces(text: string, values: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key]! : whole));
}
