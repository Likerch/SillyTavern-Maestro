import { detectSheetCommand } from '../domain/sheets';
import type { Bus, Ephemeral, GenerationInfo, Host, Logger, TurnHooks, Unsubscribe } from '../shared/contracts';

export interface EphemeralRunner extends Ephemeral {
    /** Clears last turn's values, then runs every producer for this generation. */
    run(info: GenerationInfo): Promise<void>;
}

/** A generation that has not ended after this long is considered finished (lost GENERATION_ENDED). */
const GENERATION_STALE_MS = 5 * 60 * 1000;
/** Characters of a message's text in its fingerprint. */
const PRINT_TEXT = 40;

/** A light fingerprint of a chat message: who wrote it, when, and how its text starts (release 1.26). */
export function messageFingerprint(message: STChatMessage | null | undefined): string {
    if (!message) return '-';
    const who = message.is_user ? 'u' : message.is_system ? 's' : 'a';
    const text = typeof message.mes === 'string' ? message.mes.slice(0, PRINT_TEXT) : '';
    return `${who}|${typeof message.send_date === 'string' ? message.send_date : ''}|${text}`;
}

/** The loose form of a fingerprint: who and when (the text may have changed without an event). */
function looseFingerprint(print: string | undefined): string {
    const parts = (print ?? '').split('|');
    return `${parts[0] ?? ''}|${parts[1] ?? ''}`;
}

/**
 * Which messages a deletion took (release 1.26): the fingerprints before against the chat now — the common prefix,
 * then the rest of the chat must equal the old tail after the gap (checked with the full fingerprints, else with who
 * and when). Null when it cannot tell (nothing went, or the lists do not line up).
 */
export function removedRange(
    before: readonly string[],
    after: readonly string[],
): { at: number; count: number } | null {
    const count = before.length - after.length;
    if (count <= 0) return null;
    for (const key of [(print: string | undefined) => print ?? '', looseFingerprint]) {
        let at = 0;
        while (at < after.length && key(before[at]) === key(after[at])) at++;
        let lined = true;
        for (let i = at; i < after.length && lined; i++) lined = key(before[i + count]) === key(after[i]);
        if (lined) return { at, count };
    }
    return null;
}

type InterceptHandler = (chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>;

/**
 * Translates SillyTavern events into Maestro's turn lifecycle (plan §5):
 * - generate_interceptor (Maestro loads after Qvink, CK and NAI Studio) → ephemeral producers, `generation:before`,
 *   intercept handlers — all before the WI scan and prompt assembly;
 * - MESSAGE_SENT → `turn:committed` for the previous assistant reply (P14);
 * - CHARACTER_MESSAGE_RENDERED (last listener, next tick) → `reply:ready`, after DES, DES-RU and NAI markers;
 * - swipe / delete / edit → `message:invalidated`; a deletion says which messages went (`removedAt`, `removed`) when
 *   a light fingerprint list of the chat (refreshed on chat changes, sent / received / edited / swiped / updated /
 *   rendered messages and after deletions) tells — ST only gives the new chat length (release 1.26);
 * - GENERATION_ENDED / STOPPED → ephemeral values cleared.
 */
export class TurnPipeline implements TurnHooks {
    private interceptTiming: { type: string; startedAt: number; endedAt: number } | null = null;
    private readonly handlers = new Set<InterceptHandler>();
    private readonly unsubscribers: Unsubscribe[] = [];
    private generation: GenerationInfo | null = null;
    private staleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Fingerprints of the chat's messages as last seen (a deletion is found against them). */
    private prints: string[] = [];

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
            this.refreshPrints();
            this.generation = null;
            this.ephemeral.clearAll();
            void this.bus.emit('chat:changed', { chatId: this.host.chatId() });
        });

        on('MESSAGE_SENT', (messageId) => {
            this.refreshPrints();
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

        on('MESSAGE_SWIPED', (messageId) => {
            this.touchPrint(messageId);
            this.invalidate(messageId, 'swiped');
        });
        on('MESSAGE_DELETED', (messageId) => this.deleted(messageId));
        on('MESSAGE_EDITED', (messageId) => {
            this.touchPrint(messageId);
            this.invalidate(messageId, 'edited');
        });
        // The fingerprints follow every change of the chat that has an event (older ST without one: no warning).
        for (const key of [
            'MESSAGE_RECEIVED',
            'MESSAGE_UPDATED',
            'CHARACTER_MESSAGE_RENDERED',
            'USER_MESSAGE_RENDERED',
        ]) {
            const name = this.host.events.name(key);
            if (name) this.unsubscribers.push(this.host.events.on(name, (messageId) => this.touchPrint(messageId)));
        }
        this.refreshPrints();
    }

    /** The chat's fingerprints now. */
    private printsNow(): string[] {
        try {
            return (this.host.ctx().chat ?? []).map(messageFingerprint);
        } catch {
            return [];
        }
    }

    private refreshPrints(): void {
        this.prints = this.printsNow();
    }

    /**
     * One message changed (received, edited, swiped, updated, rendered): its fingerprint alone while the chat kept its
     * length — ST renders every visible message on a chat load —, the whole list otherwise.
     */
    private touchPrint(messageId: unknown): void {
        try {
            const chat = this.host.ctx().chat ?? [];
            const index = Number(messageId);
            if (chat.length === this.prints.length && Number.isInteger(index) && index >= 0 && index < chat.length) {
                this.prints[index] = messageFingerprint(chat[index]);
                return;
            }
        } catch {
            // the whole list below
        }
        this.refreshPrints();
    }

    /**
     * MESSAGE_DELETED gives the new chat length (not the deleted index): `messageIndex` stays that for every listener;
     * where the deleted messages were comes along when the fingerprints tell (release 1.26).
     */
    private deleted(messageId: unknown): void {
        const index = Number(messageId);
        const after = this.printsNow();
        const range = removedRange(this.prints, after);
        this.prints = after;
        if (!Number.isFinite(index)) return;
        void this.bus.emit('message:invalidated', {
            messageIndex: index,
            reason: 'deleted',
            ...(range ? { removedAt: range.at, removed: range.count } : {}),
        });
    }

    dispose(): void {
        if (this.staleTimer) clearTimeout(this.staleTimer);
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.handlers.clear();
        this.ephemeral.clearAll();
    }

    /** Body of the global generate_interceptor. */
    async intercept(chat: STChatMessage[], type: string): Promise<void> {
        const startedAt = performance.now();
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
        this.interceptTiming = { type: info.type, startedAt, endedAt: performance.now() };
    }

    lastIntercept(): { type: string; startedAt: number; endedAt: number } | null {
        return this.interceptTiming;
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
