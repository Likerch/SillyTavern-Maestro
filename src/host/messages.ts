// Showing a chat message again after Maestro changed its text (M12 cleaning and its undo, a trimmed sheet, a stripped
// mechanics block).
//
// SillyTavern's own message editor re-renders .mes_text and then emits MESSAGE_UPDATED (script.js messageEditDone /
// messageEditCancel, ST 1.19); the extensions that decorate the rendered text redo their work on that event.
// updateMessageBlock() alone leaves them behind: Doom's Enhancement Suite keeps its "bubbles applied" attribute on
// .mes_text (the element outlives the re-render), so the reply stays without its speaker cards and inline thoughts,
// and Silly Sim Tracker cards vanish the same way, until the user opens and closes the editor. MESSAGE_EDITED is not
// sent: Maestro's turn pipeline reads it as the player's edit (`message:invalidated`) and Qvink summarises the
// message again.
import type { Host, Logger } from '../shared/contracts';

export interface RerenderOptions {
    /**
     * Emit MESSAGE_UPDATED after the re-render (default). Off where ST is about to announce the message itself: inside
     * MESSAGE_RECEIVED (CHARACTER_MESSAGE_RENDERED follows) and MESSAGE_EDITED (ST re-renders after it and emits
     * MESSAGE_UPDATED).
     */
    announce?: boolean;
    log?: Logger;
}

/** The message has a block in the chat on screen (not above «Show more messages», not another chat). */
function isRendered(index: number): boolean {
    if (typeof document === 'undefined') return false;
    try {
        return document.querySelector(`#chat .mes[mesid="${index}"]`) !== null;
    } catch {
        return false;
    }
}

/** ST's message editor (or its reasoning editor) is open on this message: its textarea sits inside the block. */
export function isEditing(index: number): boolean {
    if (typeof document === 'undefined') return false;
    try {
        const block = `#chat .mes[mesid="${index}"]`;
        return document.querySelector(`${block} .edit_textarea, ${block} .reasoning_edit_textarea`) !== null;
    } catch {
        return false;
    }
}

/**
 * Re-renders message `index` (updateMessageBlock runs synchronously, before the first await) and, when the message is
 * on screen, announces it with MESSAGE_UPDATED. Never throws. Not while the user edits that message: the re-render
 * would replace the editor and lose what he typed; ST re-renders the message from the chat when the editor closes.
 */
export async function rerenderMessage(
    host: Host,
    index: number,
    message: STChatMessage,
    options: RerenderOptions = {},
): Promise<void> {
    const { announce = true, log } = options;
    if (isEditing(index)) {
        log?.debug(`message ${index} is being edited: shown when the editor closes`);
        return;
    }
    try {
        const ctx = host.ctx();
        if (typeof ctx.updateMessageBlock !== 'function') return;
        ctx.updateMessageBlock(index, message);
    } catch (error) {
        log?.warn('updateMessageBlock failed', error);
        return;
    }
    if (!announce || !isRendered(index)) return;
    const event = host.events.name('MESSAGE_UPDATED');
    if (!event) return;
    try {
        await host.events.emit(event, index);
    } catch (error) {
        log?.warn('MESSAGE_UPDATED listeners failed', error);
    }
}
