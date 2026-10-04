import { detectSheetCommand } from '../domain/sheets';
import type { Bus, Ephemeral, GenerationInfo, Host, Logger, TurnHooks, Unsubscribe } from '../shared/contracts';

export interface EphemeralRunner extends Ephemeral {
    /** Clears last turn's values, then runs every producer for this generation. */
    run(info: GenerationInfo): Promise<void>;
}

/** A generation that has not ended after this long is considered finished (lost GENERATION_ENDED). */
const GENERATION_STALE_MS = 5 * 60 * 1000;

type InterceptHandler = (chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>;

/**
 * Translates SillyTavern events into Maestro's turn lifecycle (plan §5):
 * - generate_interceptor (Maestro loads after Qvink, CK and NAI Studio) → ephemeral producers, `generation:before`,
 *   intercept handlers — all before the WI scan and prompt assembly;
 * - MESSAGE_SENT → `turn:committed` for the previous assistant reply (P14);
 * - CHARACTER_MESSAGE_RENDERED (last listener, next tick) → `reply:ready`, after DES, DES-RU and NAI markers;
 * - swipe / delete / edit → `message:invalidated`;
 * - GENERATION_ENDED / STOPPED → ephemeral values cleared.
 */
export class TurnPipeline implements TurnHooks {
    private readonly handlers = new Set<InterceptHandler>();
    private readonly unsubscribers: Unsubscribe[] = [];
    private generation: GenerationInfo | null = null;
    private staleTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly host: Host,
        private readonly bus: Bus,
        private readonly ephemeral: EphemeralRunner,
        private readonly log: Logger,
    ) {}

    install(): void {
        const on = (key: string, handler: (...args: unknown[]) => unknown, order?: 'first' | 'last') => {
            const name = this.host.events.name(key);
            if (!name) {
                this.log.warn(`ST event ${key} is missing`);
                return;
            }
            this.unsubscribers.push(this.host.events.on(name, handler, order ? { order } : undefined));
        };

        on('CHAT_CHANGED', () => {
            this.generation = null;
            this.ephemeral.clearAll();
            void this.bus.emit('chat:changed', { chatId: this.host.chatId() });
        });

        on('MESSAGE_SENT', (messageId) => {
            const index = Number(messageId);
            const committed = this.lastAssistantBefore(Number.isFinite(index) ? index : this.host.ctx().chat.length);
            if (committed >= 0) void this.bus.emit('turn:committed', { messageIndex: committed });
        });

        on(
            'CHARACTER_MESSAGE_RENDERED',
            (messageId, type) => {
                const index = Number(messageId);
                if (!Number.isFinite(index)) return;
                // Next tick: DES-RU's fixes and NAI marker finalisation may still be running in this pass.
                setTimeout(() => {
                    void this.bus.emit('reply:ready', { messageIndex: index, type: String(type ?? 'normal') });
                }, 0);
            },
            'last',
        );

        const ended = (stopped: boolean) => () => {
            const type = this.generation?.type ?? 'normal';
            this.generation = null;
            this.ephemeral.clearAll();
            void this.bus.emit('generation:ended', { type, stopped });
        };
        on('GENERATION_ENDED', ended(false));
        on('GENERATION_STOPPED', ended(true));

        on('MESSAGE_SWIPED', (messageId) => this.invalidate(messageId, 'swiped'));
        on('MESSAGE_DELETED', (messageId) => this.invalidate(messageId, 'deleted'));
        on('MESSAGE_EDITED', (messageId) => this.invalidate(messageId, 'edited'));
    }

    dispose(): void {
        if (this.staleTimer) clearTimeout(this.staleTimer);
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.handlers.clear();
        this.ephemeral.clearAll();
    }

    /** Body of the global generate_interceptor. */
    async intercept(chat: STChatMessage[], type: string): Promise<void> {
        const last = [...chat].reverse().find((message) => message.is_user);
        const info: GenerationInfo = {
            type: type || 'normal',
            dryRun: false,
            quiet: type === 'quiet',
            sheetCommand: type === 'quiet' ? undefined : detectSheetCommand(last?.mes),
        };
        // Quiet generations (other extensions' background calls) do not occupy Maestro: ST may not emit
        // GENERATION_ENDED for them (it comes from hideStopButton), which would block the task queue.
        if (!info.quiet) this.setGeneration(info);
        await this.ephemeral.run(info);
        await this.bus.emit('generation:before', info);
        for (const handler of [...this.handlers]) {
            try {
                await handler(chat, info);
            } catch (error) {
                this.log.error('intercept handler failed', error);
            }
        }
    }

    onIntercept(handler: InterceptHandler): Unsubscribe {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    lastAssistantIndex(): number {
        return this.lastAssistantBefore(this.host.ctx().chat.length);
    }

    current(): GenerationInfo | null {
        return this.generation;
    }

    private setGeneration(info: GenerationInfo): void {
        this.generation = info;
        if (this.staleTimer) clearTimeout(this.staleTimer);
        // Safety net: a generation that never reports its end must not keep Maestro "busy" forever.
        this.staleTimer = setTimeout(() => {
            if (this.generation === info) {
                this.log.warn('generation end not reported, releasing');
                this.generation = null;
                this.ephemeral.clearAll();
            }
        }, GENERATION_STALE_MS);
    }

    private lastAssistantBefore(index: number): number {
        const chat = this.host.ctx().chat;
        for (let i = Math.min(index, chat.length) - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) return i;
        }
        return -1;
    }

    private invalidate(messageId: unknown, reason: 'swiped' | 'deleted' | 'edited'): void {
        const index = Number(messageId);
        if (!Number.isFinite(index)) return;
        void this.bus.emit('message:invalidated', { messageIndex: index, reason });
    }
}
