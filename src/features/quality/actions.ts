// What M12 asks SillyTavern to do (ST 1.19, public/scripts/st-context.js):
// - rewrite a reply: chat[i].mes + swipes[swipe_id], updateMessageBlock(), saveChat();
// - swipe: ctx.swipe.right(null, { message }) — an overswipe on the last message regenerates it (script.js swipe(),
//   OVERSWIPE_BEHAVIOR.REGENERATE); only when ctx.swipe.isAllowed() (no generation, no swipe in progress);
// - swipe back (undo): ctx.swipe.to(null, 'left', { forceMesId, forceSwipeId });
// - continue: `/continue` (slash-commands.js continueChatCallback waits for the generation lock itself; it clears
//   the send box, so it runs only while the box is empty);
// - stop: ctx.stopGeneration() (script.js; the partial reply is still saved and rendered).
import type { App, Logger } from '../../shared/contracts';

interface StSwipeApi {
    right?(event: unknown, options?: Record<string, unknown>): unknown;
    to?(event: unknown, direction: 'left' | 'right', options?: Record<string, unknown>): unknown;
    isAllowed?(): boolean;
}

/** Parts of ST 1.19's context that global.d.ts does not declare. */
interface StExtras {
    swipe?: StSwipeApi;
    stopGeneration?(): boolean;
}

export interface ActionTimings {
    /** How often the idle state is polled. */
    pollMs: number;
    /** Longest wait for ST to finish the previous generation before a swipe. */
    idleMs: number;
}

export function swipeIdOf(message: STChatMessage | undefined): number {
    const id = message?.swipe_id;
    return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : 0;
}

export class StActions {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly timings: ActionTimings,
    ) {}

    private extras(): StExtras {
        return this.app.host.ctx() as unknown as StExtras;
    }

    /** This ST can swipe from code. */
    canSwipe(): boolean {
        const swipe = this.extras().swipe;
        return typeof swipe?.right === 'function' && typeof swipe.isAllowed === 'function';
    }

    canContinue(): boolean {
        return typeof this.app.host.ctx().executeSlashCommandsWithOptions === 'function';
    }

    isLast(index: number): boolean {
        return index === this.app.host.ctx().chat.length - 1;
    }

    /** ST is idle: no generation of Maestro's turn pipeline and ST would accept a swipe. */
    idle(): boolean {
        if (this.app.turn.current() !== null) return false;
        const allowed = this.extras().swipe?.isAllowed;
        try {
            return typeof allowed === 'function' ? allowed() : true;
        } catch {
            return false;
        }
    }

    /** Waits until idle(), at most `idleMs`; false when ST stayed busy. */
    async waitIdle(limitMs = this.timings.idleMs): Promise<boolean> {
        const until = Date.now() + limitMs;
        while (!this.idle()) {
            if (Date.now() >= until) return false;
            await new Promise((resolve) => setTimeout(resolve, this.timings.pollMs));
        }
        return true;
    }

    /** The send box holds nothing the user typed (a /continue would clear it). */
    sendBoxEmpty(): boolean {
        try {
            const box = typeof document === 'undefined' ? null : document.querySelector('#send_textarea');
            return !(box instanceof HTMLTextAreaElement) || !box.value.trim();
        } catch {
            return true;
        }
    }

    /**
     * Rewrites the text of a reply swipe when it is still `before`: the message, its swipe copy, the DOM, the chat
     * file. False when the reply changed meanwhile.
     */
    async writeText(index: number, swipeId: number, before: string, after: string): Promise<boolean> {
        const ctx = this.app.host.ctx();
        const message = ctx.chat[index];
        if (!message || message.is_user || swipeIdOf(message) !== swipeId || message.mes !== before) return false;
        message.mes = after;
        const swipes = message.swipes;
        if (Array.isArray(swipes) && typeof swipes[swipeId] === 'string') swipes[swipeId] = after;
        try {
            if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, message);
        } catch (error) {
            this.log.warn('updateMessageBlock failed', error);
        }
        await ctx.saveChat();
        return true;
    }

    /**
     * Swipes the last message to a new generation. `onStart` runs right before ST is asked (the one-shot fix note is
     * armed there). Does not wait for the new reply. False when ST cannot swipe now.
     */
    async swipe(index: number, onStart?: () => void): Promise<boolean> {
        if (!this.canSwipe()) return false;
        const chatId = this.app.host.chatId();
        if (!(await this.waitIdle())) {
            this.log.info('swipe skipped: SillyTavern stayed busy');
            return false;
        }
        const ctx = this.app.host.ctx();
        const message = ctx.chat[index];
        if (this.app.host.chatId() !== chatId || !message || !this.isLast(index) || message.is_user) return false;
        onStart?.();
        const swipe = this.extras().swipe;
        try {
            // Not awaited: ST resolves the swipe only after the whole new generation.
            const result = swipe?.right?.(null, { message });
            if (result instanceof Promise) result.catch((error: unknown) => this.log.warn('swipe failed', error));
        } catch (error) {
            this.log.warn('swipe failed', error);
            return false;
        }
        return true;
    }

    /** Undo of an automatic swipe: shows the swipe the reply had before. */
    async swipeBack(index: number, swipeId: number): Promise<boolean> {
        const swipe = this.extras().swipe;
        if (typeof swipe?.to !== 'function' || !this.isLast(index)) return false;
        const message = this.app.host.ctx().chat[index];
        const count = Array.isArray(message?.swipes) ? message.swipes.length : 0;
        if (!message || swipeId >= count) return false;
        if (!(await this.waitIdle())) return false;
        try {
            await swipe.to(null, 'left', { message, forceMesId: index, forceSwipeId: swipeId });
            return true;
        } catch (error) {
            this.log.warn('swipe back failed', error);
            return false;
        }
    }

    /** `/continue` on the last message (only with an empty send box). False when it cannot run. */
    async continueLast(index: number): Promise<boolean> {
        if (!this.canContinue() || !this.isLast(index) || !this.sendBoxEmpty()) return false;
        const ctx = this.app.host.ctx();
        try {
            // Not awaited (no await=true): the command waits for the generation lock and returns at once.
            const result = ctx.executeSlashCommandsWithOptions('/continue', { handleExecutionErrors: true });
            if (result instanceof Promise) result.catch((error: unknown) => this.log.warn('/continue failed', error));
            return true;
        } catch (error) {
            this.log.warn('/continue failed', error);
            return false;
        }
    }

    /** Stops the streaming generation (early cutoff). */
    stop(): boolean {
        const stop = this.extras().stopGeneration;
        if (typeof stop !== 'function') return false;
        try {
            stop();
            return true;
        } catch (error) {
            this.log.warn('stopGeneration failed', error);
            return false;
        }
    }
}
