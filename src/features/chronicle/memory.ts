// M9 п. 3 «Автопамять» (plan M9, §2.2, §8 «отметки Qvink — Само»; audit T13). Maestro is the only owner of Qvink's
// «remember» mark: important moments get it without a click. Sources:
// - the revision (M8) routes «important event» changes here as bus signals of kind 'memory.important'
//   (data: { messageIndex, reason });
// - the signal service: a new quest ('quest.added') and a relationship turn ('relationship.changed');
// - Maestro's own cheap detection on the committed reply: an oath, a revealed secret, a new quest (RU/EN regexes).
// All of it is collected on the send path and handled after the generation (P14, P15), in the leader tab, through
// app.autonomy (kind 'chronicle.remember', default «auto»), journaled with an undo that puts every swipe's flags back.
// A message the user already marked is left alone (it stays the user's); a mark the user removed is not set again.
import { tPlural } from '../../core/labels';
import { detectImportant } from '../../domain/chronicle-recap';
import { cleanForAnalysis, isImagePost } from '../../domain/text-clean';
import type { JournalChange, Signal, Unsubscribe } from '../../shared/contracts';
import type { ChronicleEnv } from './env';
import {
    hasSummary,
    isRemembered,
    readRememberState,
    readStoredState,
    restoreRemember,
    writeRemember,
} from './qvink-flags';
import { CHRONICLE_ID } from './settings';
import { isReasonCode, mergeReasons } from './store';
import type { ReasonCode, RememberReason, RememberRecord } from './store';

export const REMEMBER_KIND = 'chronicle.remember';
export const REMEMBER_TARGET = 'm9.remember';

const FLUSH_DELAY_MS = 1500;
const IDLE_DELAY_MS = 300;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RememberPayload {
    index: number;
    date: string;
    reasons: RememberReason[];
}

function isRememberPayload(value: unknown): value is RememberPayload {
    return (
        isDict(value) &&
        Number.isInteger(value.index) &&
        typeof value.date === 'string' &&
        Array.isArray(value.reasons) &&
        value.reasons.every((reason) => isDict(reason) && isReasonCode(reason.code))
    );
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function reason(code: ReasonCode, detail?: string): RememberReason {
    return detail ? { code, text: detail } : { code };
}

export class AutoMemory {
    /** Reasons per message index, waiting for the generation to end. */
    private readonly pending = new Map<number, RememberReason[]>();
    /** Committed replies to look at with the cheap detection. */
    private readonly detect = new Set<number>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private waitingForIdle = false;
    private chain: Promise<unknown> = Promise.resolve();
    private disposed = false;

    constructor(private readonly env: ChronicleEnv) {}

    private get app() {
        return this.env.app;
    }

    install(): Unsubscribe[] {
        const { app } = this;
        app.journal.registerUndo(REMEMBER_TARGET, (change) => this.undo(change));
        return [
            app.bus.on('signal', (signal) => this.onSignal(signal)),
            app.bus.on('turn:committed', ({ messageIndex }) => {
                const settings = this.env.settings();
                if (!settings.autoMemory || !settings.keywords) return;
                // P15: only the index here; the text is read after the generation.
                this.detect.add(messageIndex);
                this.arm(FLUSH_DELAY_MS);
            }),
            app.bus.on('chat:changed', () => {
                this.pending.clear();
                this.detect.clear();
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason: why }) => {
                // A deleted message shifts the ones after it: their queued reasons no longer point at them.
                for (const map of [this.pending, this.detect]) {
                    for (const index of [...map.keys()]) {
                        if (index === messageIndex || (why === 'deleted' && index > messageIndex)) map.delete(index);
                    }
                }
            }),
            app.bus.on('generation:ended', () => {
                if (!this.waitingForIdle) return;
                this.waitingForIdle = false;
                this.arm(IDLE_DELAY_MS);
            }),
            app.inbox.registerApplier(
                REMEMBER_KIND,
                async (payload) => {
                    if (!isRememberPayload(payload)) throw new Error('bad chronicle card');
                    await this.apply(payload);
                },
                async (payload) => isRememberPayload(payload) && this.canRemember(payload),
            ),
            () => this.dispose(),
        ];
    }

    private dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.pending.clear();
        this.detect.clear();
    }

    /* ---------------------------------------------------------------- collecting */

    private onSignal(signal: Signal): void {
        if (!this.env.settings().autoMemory) return;
        if (signal.chatId && signal.chatId !== this.app.host.chatId()) return;
        const data = isDict(signal.data) ? signal.data : {};
        let index: unknown = signal.messageIndex;
        let found: RememberReason;
        switch (signal.kind) {
            case 'memory.important':
                if (Number.isInteger(data.messageIndex)) index = data.messageIndex;
                found = reason('important', text(data.reason));
                break;
            case 'quest.added':
                found = reason('quest', text(signal.entity) ?? text(data.title) ?? text(data.name));
                break;
            case 'relationship.changed':
                found = reason('relationship', text(signal.entity));
                break;
            default:
                return;
        }
        if (!Number.isInteger(index) || (index as number) < 0) return;
        this.queue(index as number, [found]);
    }

    /** Queues reasons for a message; they are handled after the generation, in the leader tab. */
    queue(index: number, reasons: RememberReason[]): void {
        const list = this.pending.get(index) ?? [];
        mergeReasons(list, reasons);
        this.pending.set(index, list);
        this.arm(FLUSH_DELAY_MS);
    }

    private arm(delay: number): void {
        if (this.disposed) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delay);
    }

    /** Handles everything queued (serialised). */
    flush(): Promise<void> {
        const run = () => this.flushNow().catch((error: unknown) => this.env.log.warn('auto-memory failed', error));
        const next = this.chain.then(run, run);
        this.chain = next;
        return next;
    }

    private async flushNow(): Promise<void> {
        if (this.disposed) return;
        if (this.app.turn.current() !== null) {
            this.waitingForIdle = true;
            return;
        }
        if (!this.app.leader.isLeader()) {
            this.pending.clear();
            this.detect.clear();
            return;
        }
        const chat = this.app.host.ctx().chat ?? [];
        for (const index of this.detect) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) continue;
            const codes = detectImportant(cleanForAnalysis(message));
            if (codes.length) {
                const list = this.pending.get(index) ?? [];
                mergeReasons(
                    list,
                    codes.map((code) => reason(code)),
                );
                this.pending.set(index, list);
            }
        }
        this.detect.clear();
        const work = [...this.pending].sort((a, b) => a[0] - b[0]);
        this.pending.clear();
        for (const [index, reasons] of work) await this.remember(index, reasons);
    }

    /* ---------------------------------------------------------------- the mark */

    /** Sets «remember» on a message (all swipes) through autonomy; returns the decision or null when not needed. */
    async remember(index: number, reasons: RememberReason[]): Promise<string | null> {
        const { app, env } = this;
        if (!env.settings().autoMemory || !reasons.length) return null;
        if (!app.leader.isLeader() || !env.qvinkReady()) return null;
        const message = app.host.ctx().chat?.[index];
        if (!message || isImagePost(message)) return null;
        const date = String(message.send_date ?? '');
        const doc = await env.store.load();
        const own = doc?.remembered.find((record) => record.index === index && record.date === date);
        if (isRemembered(message)) {
            // Already long-term: Maestro's own mark collects the new reasons; the user's mark stays the user's.
            if (own) {
                await env.store.mutate((current) => {
                    const record = current.remembered.find((item) => item.index === index && item.date === date);
                    return !!record && mergeReasons(record.reasons, reasons);
                });
            }
            return null;
        }
        // Maestro set it once and the user took it off: not again.
        if (own) return null;
        if (app.autonomy.level(REMEMBER_KIND, 'auto') === 'off') return null;
        const payload: RememberPayload = { index, date, reasons };
        const why = this.reasonText(reasons);
        const change: JournalChange = {
            target: REMEMBER_TARGET,
            ref: { index, date },
            before: readRememberState(message),
            after: { remember: true },
        };
        return app.autonomy.decide<RememberPayload>(
            {
                module: CHRONICLE_ID,
                kind: REMEMBER_KIND,
                title: env.t('m9.remember.proposal', { index, reason: why }),
                description: env.t('m9.remember.description', { index, reason: why }),
                appliedNotice: {
                    text: env.t('m9.remember.applied', { index, reason: why }),
                    group: 'm9.remember.applied',
                    groupText: (count) => tPlural(app.i18n, 'm9.remember.appliedMany', count),
                },
                changes: [change],
                payload,
                stillValid: async () => this.canRemember(payload),
                apply: (value) => this.apply(value),
            },
            'auto',
        );
    }

    /** The message is still there (same send_date) and not marked yet. */
    private canRemember(payload: RememberPayload): boolean {
        const message = this.app.host.ctx().chat?.[payload.index];
        return !!message && String(message.send_date ?? '') === payload.date && !isRemembered(message);
    }

    async apply(payload: RememberPayload): Promise<void> {
        const { app, env } = this;
        const message = app.host.ctx().chat?.[payload.index];
        if (!message || String(message.send_date ?? '') !== payload.date)
            throw new Error(env.t('m9.error.messageGone'));
        const summarize = !hasSummary(message);
        writeRemember(message);
        await this.afterWrite(payload.index, summarize);
        await env.store.mutate((doc) => {
            const existing = doc.remembered.find((item) => item.index === payload.index && item.date === payload.date);
            if (existing) return mergeReasons(existing.reasons, payload.reasons);
            const record: RememberRecord = {
                index: payload.index,
                date: payload.date,
                reasons: payload.reasons.map((item) => ({ ...item })),
                at: Date.now(),
            };
            doc.remembered.push(record);
            doc.remembered.sort((a, b) => a.index - b.index);
            return true;
        });
    }

    /** Qvink recomputes its flags, injections and icons; the chat is saved; a message without a summary gets one. */
    private async afterWrite(index: number, summarize: boolean): Promise<void> {
        const { env } = this;
        if (summarize && env.slashExists('qm-summarize')) {
            // Qvink's own toggle does the same; it is a background request of Qvink's, not awaited here.
            env.runSlash(`/qm-summarize show_progress=false ${index}`).catch((error: unknown) =>
                env.log.warn(`Qvink did not summarise message ${index}`, error),
            );
        }
        if (env.slashExists('qm-refresh')) {
            try {
                await env.runSlash('/qm-refresh');
            } catch (error) {
                env.log.warn('Qvink refresh failed', error);
            }
        }
        try {
            await this.app.host.ctx().saveChat();
        } catch (error) {
            env.log.warn('the chat was not saved after the «remember» mark', error);
        }
    }

    private async undo(change: JournalChange): Promise<boolean> {
        const index = change.ref.index;
        const date = change.ref.date;
        const before = readStoredState(change.before);
        if (typeof index !== 'number' || typeof date !== 'string' || !before) return false;
        const message = this.app.host.ctx().chat?.[index];
        if (!message || String(message.send_date ?? '') !== date) return false;
        restoreRemember(message, before);
        await this.afterWrite(index, false);
        await this.env.store.mutate((doc) => {
            const kept = doc.remembered.filter((item) => !(item.index === index && item.date === date));
            if (kept.length === doc.remembered.length) return false;
            doc.remembered = kept;
            return true;
        });
        return true;
    }

    /* ---------------------------------------------------------------- reading */

    reasonText(reasons: readonly RememberReason[]): string {
        return reasons
            .map((item) => {
                const label = this.env.t(`m9.reason.${item.code}`);
                return item.text ? this.env.t('m9.reason.withText', { reason: label, text: item.text }) : label;
            })
            .join('; ');
    }

    /** Messages Maestro marked that are still marked (the user may have taken a mark off), oldest first. */
    remembered(): { messageIndex: number; reason: string }[] {
        const chat = this.app.host.ctx().chat ?? [];
        return (this.env.store.peek()?.remembered ?? [])
            .filter((record) => {
                const message = chat[record.index];
                return !!message && String(message.send_date ?? '') === record.date && isRemembered(message);
            })
            .map((record) => ({ messageIndex: record.index, reason: this.reasonText(record.reasons) }));
    }
}
