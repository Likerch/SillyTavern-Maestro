// «Трекер сцены» (plan docs/agents-plan.md §3.16, release 1.32): with the medic's «separateTracker» on, DES's tracker
// instruction and its example leave the assembled prompt of a real generation (CHAT_COMPLETION_PROMPT_READY, DES's own
// settings untouched — ARCHITECTURE «suppress at prompt assembly»); the reply comes without the tracker JSON and the
// medic's repair makes it with DES's own update prompt, parser and rendering. DES's HTML and dialogue colouring stay.
import { removeSlotText, slotText } from '../../domain/voices-prompt';
import type { App, Logger } from '../../shared/contracts';

/** DES's slots of together mode that carry the tracker (systems/generation/injector.js). */
export const DES_TRACKER_SLOTS = ['dooms-tracker-inject', 'dooms-tracker-example'] as const;

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Takes DES's tracker instruction out of the final messages; returns how many slots were removed. */
export function removeTrackerInstruction(app: App, data: unknown, log: Logger): number {
    if (!isDict(data) || data.dryRun !== false || !Array.isArray(data.chat)) return 0;
    const messages = data.chat as unknown[];
    let removed = 0;
    for (const slot of DES_TRACKER_SLOTS) {
        try {
            const ctx = app.host.ctx() as unknown as {
                extensionPrompts?: unknown;
                substituteParams?: (text: string) => string;
            };
            const value = slotText(ctx.extensionPrompts, slot);
            if (!value) continue;
            const result = removeSlotText(messages, value, (text) => {
                try {
                    return typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text;
                } catch {
                    return text;
                }
            });
            if (result.removed) removed += 1;
        } catch (error) {
            log.warn(`DES slot ${slot} could not be removed`, error);
        }
    }
    return removed;
}
