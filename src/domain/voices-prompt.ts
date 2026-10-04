// M15 «Голоса персонажей», CarrotKernel quiet mode on the assembled Chat Completion prompt (plan §2.2 п. 2, M15 п. 4):
// CK writes its «Character Consistency» insert with `/inject id=carrot-consistency position=chat ephemeral=true …`
// (CK index.js:1482), i.e. into the extension prompt slot `script_inject_carrot-consistency`
// (research/bunnymo-carrotkernel.md §2.3 п. 3). While voice cards go out, Maestro takes that text out of the final
// messages — the slot itself and CK's settings stay as CK left them, so without Maestro CK works as before.
// The text is found the way M20 finds neighbour slots (src/domain/architect-prompt.ts): as set, trimmed (ST trims
// in-chat injections) or macro-substituted, inside a message that may also hold other injections of the same depth
// and role or squashed system messages.
// Pure: no DOM, no SillyTavern.
import { findInMessages, messageTextParts, slotNeedles } from './architect-prompt';

/** Extension prompt key of CK's «Character Consistency» insert (`/inject` keys get the `script_inject_` prefix). */
export const CK_CONSISTENCY_SLOT = 'script_inject_carrot-consistency';
/** ST extension_prompt_types.NONE: never injected. */
const POSITION_NONE = -1;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text a slot sends to the model now; '' when it is missing, empty or scan-only. */
export function slotText(prompts: unknown, key: string): string {
    if (!isDict(prompts)) return '';
    const slot = prompts[key];
    if (!isDict(slot) || typeof slot.value !== 'string' || !slot.value.trim()) return '';
    return Number(slot.position) === POSITION_NONE ? '' : slot.value;
}

export interface SlotRemoval {
    removed: boolean;
    /** Characters taken out of the prompt. */
    chars: number;
    /** Index of the message the text was in. */
    message?: number;
    /** The message held nothing else and left the prompt. */
    droppedMessage?: boolean;
}

/** Replaces the text of one part of a message (string content, or a new array with a new text part). */
function setPartText(message: Dict, part: number, text: string): void {
    if (typeof message.content === 'string') {
        message.content = text;
        return;
    }
    if (Array.isArray(message.content)) {
        const parts = [...(message.content as unknown[])];
        const old = parts[part];
        if (!isDict(old)) return;
        parts[part] = { ...old, text };
        message.content = parts;
    }
}

/**
 * Glues the text around a cut: no blank edge where the cut text started or ended the part, one line break where it sat
 * between two.
 */
export function joinAround(text: string, start: number, length: number): string {
    const before = text.slice(0, start);
    const after = text.slice(start + length);
    if (!before.trim()) return after.replace(/^\s+/, '');
    if (!after.trim()) return before.replace(/\s+$/, '');
    if (/\n\s*$/.test(before) && /^\s*\n/.test(after))
        return before.replace(/[ \t]*$/, '') + after.replace(/^\s*\n/, '');
    return before + after;
}

/**
 * Takes a slot's text out of the final messages (first occurrence). A plain message left empty leaves the prompt, as
 * ST's own getChat() drops empty messages. `messages` is changed in place (it is the array ST sends).
 */
export function removeSlotText(messages: unknown[], value: string, substitute?: (text: string) => string): SlotRemoval {
    const hit = findInMessages(messages, slotNeedles(value, substitute));
    if (!hit) return { removed: false, chars: 0 };
    const message = messages[hit.message];
    if (!isDict(message)) return { removed: false, chars: 0 };
    const current = messageTextParts(message)[hit.part] ?? '';
    const next = joinAround(current, hit.start, hit.needle.length);
    setPartText(message, hit.part, next);
    const empty = typeof message.content === 'string' && !next.trim() && !message.tool_calls;
    if (empty) messages.splice(hit.message, 1);
    return { removed: true, chars: hit.needle.length, message: hit.message, droppedMessage: empty };
}
