// Revision service (plan M8 «Запуск», «Анализ»; §4.5, §9, P14, P15):
// - triggers: ≥ N pending signals, every N committed messages, a finished scene, or by hand. The check runs a moment
//   after the send (never on the send path); a run is a background task (kind 'revision.run', one pending per chat)
//   that the queue starts only in the leader tab, never during a generation, and the LLM client stops at the cap;
// - a run reads committed messages since the last revision, asks the cheap model for changes (strict schema; a cut
//   answer splits the batch, an invalid one is retried once; a partial result is not applied — §4.5), then sends
//   'new' things to the living canon (M26), parks later-stage things as deferred cards and routes known changes;
// - runs, deferred cards and the last revised message live in the chat document 'revision'.
// Without the signals service (task 4.1) the revision counts bus signals and committed messages itself.
import type { RevisionInput } from '../../domain/revision-prompt';
import { buildRevisionMessages, DEFAULT_PROMPT_LIMITS, revisionSchema, splitInput } from '../../domain/revision-prompt';
import { dedupeChanges, looksTruncated, parseRevisionChanges } from '../../domain/revision-parse';
import type { ParsedChange } from '../../domain/revision-parse';
import { formatRejection } from '../../domain/revision-checks';
import type { Rejection } from '../../domain/revision-checks';
import { committedEnd, decideTrigger, pushCapped, revisionRange, sameDeferred } from '../../domain/revision-plan';
import type { TriggerReason } from '../../domain/revision-plan';
import type { App, Logger, Proposal, Signal, Unsubscribe } from '../../shared/contracts';
import type { CalendarApi } from '../calendar/api';
import type { KnowledgeApi } from '../knowledge/api';
import type { SignalBatch, SignalsApi } from '../signals/api';
import type { Entity } from '../world/api';
import type { DeferredCard, RevisionApi, RevisionChange, RevisionRun, RevisionStatus } from './api';
import type { RevisionRoutes } from './routes';
import { REVISION_DEDUPE, REVISION_DOC, REVISION_LLM_TASK, REVISION_TASK } from './settings';
import type { RevisionSettings } from './settings';
import type { RevisionSources } from './sources';

export interface RevisionDoc {
    runs: RevisionRun[];
    deferred: DeferredCard[];
    /** Last message index a successful revision covered (-1: none yet). */
    lastTo: number;
}

export function emptyRevisionDoc(): RevisionDoc {
    return { runs: [], deferred: [], lastTo: -1 };
}

export interface RevisionServiceOptions {
    /** Pause between a trigger event (send, signal batch) and the check: keeps it off the send path. */
    settleMs?: number;
}

const KEEP_RUNS = 20;
const KEEP_DEFERRED = 100;
/** Messages a run reads at most. */
const MAX_MESSAGES = 24;
/** After a failed run, automatic triggers wait for this many more messages. */
const FAIL_BACKOFF_MESSAGES = 2;
const MAX_TOKENS = 2_000;
const MAX_SPLIT_DEPTH = 2;
const TASK_TTL_MS = 60 * 60_000;
const SETTLE_MS = 1_500;
const PUT_ATTEMPTS = 3;
/** Bus signals kept while the signals service is off. */
const MAX_BUFFER = 200;
/** Kinds of the signals this module emits itself (they must not trigger a revision). */
const OWN_SIGNAL_SOURCE = 'revision';

const REASONS: readonly RevisionRun['reason'][] = ['signals', 'interval', 'sceneEnd', 'manual'];

function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Targets that need a known entity of the world model. */
function needsEntity(target: RevisionChange['target']): boolean {
    return target !== 'chronicle.event' && target !== 'places.state' && !target.startsWith('deferred.');
}

interface Analysis {
    changes: ParsedChange[];
    costUsd: number;
    error?: string;
}

export class RevisionService {
    private doc: RevisionDoc | null = null;
    private docChat: string | null = null;
    private loading: Promise<RevisionDoc> | null = null;
    private readonly runListeners = new Set<(run: RevisionRun) => void>();
    private readonly changeListeners = new Set<() => void>();
    /** A 'scene.ended' signal arrived since the last enqueue. */
    private sceneEnded = false;
    /** Bus signals of this chat while the signals service is off. */
    private buffer: Signal[] = [];
    private lastFailedTo = -1;
    /** A trigger fired during a generation: re-checked when it ends. */
    private wanted = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private batchApi: SignalsApi | null = null;
    private batchOff: Unsubscribe | null = null;
    private disposed = false;
    private readonly settleMs: number;

    constructor(
        private readonly app: App,
        private readonly sources: RevisionSources,
        private readonly routes: RevisionRoutes,
        private readonly settings: () => RevisionSettings,
        private readonly log: Logger,
        options: RevisionServiceOptions = {},
    ) {
        this.settleMs = options.settleMs ?? SETTLE_MS;
    }

    install(): Unsubscribe[] {
        const { bus } = this.app;
        this.ensureBatch();
        void this.loadDoc().catch(() => undefined);
        return [
            this.app.tasks.register(REVISION_TASK, (payload) => this.runTask(payload)),
            bus.on('signal', (signal) => this.onSignal(signal)),
            bus.on('turn:committed', () => this.schedule()),
            bus.on('generation:ended', () => {
                if (!this.wanted) return;
                this.wanted = false;
                this.schedule();
            }),
            bus.on('leader:changed', () => this.schedule()),
            bus.on('chat:changed', () => this.onChatChanged()),
            bus.on('message:invalidated', ({ messageIndex }) => this.dropDeferredOf(messageIndex)),
            () => {
                this.disposed = true;
                if (this.timer !== null) clearTimeout(this.timer);
                this.timer = null;
                this.batchOff?.();
                this.batchOff = null;
                this.batchApi = null;
                this.runListeners.clear();
                this.changeListeners.clear();
            },
        ];
    }

    /* ---------------------------------------------------------------- public API */

    api(): RevisionApi {
        return {
            run: (reason) => this.request(reason ?? 'manual'),
            runs: () => this.cachedDoc()?.runs.map((run) => structuredClone(run)) ?? [],
            deferred: () => this.cachedDoc()?.deferred.map((card) => ({ ...card })) ?? [],
            onRun: (listener) => {
                this.runListeners.add(listener);
                return () => this.runListeners.delete(listener);
            },
            dismissDeferred: (id) => this.dismissDeferred(id),
            status: () => this.status(),
            onChange: (listener) => this.onChange(listener),
        };
    }

    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    status(): RevisionStatus {
        const signals = this.sources.signals();
        const chatId = this.app.host.chatId();
        let pending = this.buffer.length;
        let messagesSince = this.fallbackSince();
        try {
            if (signals) {
                pending = signals.pending().length;
                messagesSince = signals.messagesSinceRevision();
            }
        } catch (error) {
            this.log.debug('signals are not readable', error);
        }
        const queued = this.app.tasks
            .list()
            .some(
                (task) =>
                    task.kind === REVISION_TASK &&
                    task.chatId === chatId &&
                    (task.state === 'pending' || task.state === 'running'),
            );
        return { pending, messagesSince, queued, signalsApi: !!signals };
    }

    /** Queues a run (manual, `/maestro-revise`, pult button). */
    async request(reason: RevisionRun['reason']): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) throw new Error(this.app.i18n.t('m8.error.noChat'));
        if (this.app.host.isGroupChat()) throw new Error(this.app.i18n.t('m8.error.group'));
        await this.enqueue(REASONS.includes(reason) ? reason : 'manual');
    }

    /* ---------------------------------------------------------------- triggers */

    private ensureBatch(): void {
        const api = this.sources.signals() ?? null;
        if (api === this.batchApi) return;
        this.batchOff?.();
        this.batchOff = null;
        this.batchApi = api;
        if (!api) return;
        try {
            this.batchOff = api.onBatch((batch) => this.onBatch(batch));
        } catch (error) {
            this.log.debug('signals batches are not available', error);
        }
    }

    private onBatch(batch: SignalBatch): void {
        if (batch.signals.some((signal) => signal.kind === 'scene.ended')) this.sceneEnded = true;
        this.schedule();
    }

    private onSignal(signal: Signal): void {
        // Signals other modules emit (revision, calendar, …) carry a source; only the observations of the turn count.
        if (signal.data?.source !== undefined) return;
        const chatId = this.app.host.chatId();
        if (signal.chatId !== null && signal.chatId !== chatId) return;
        if (signal.kind === 'scene.ended') this.sceneEnded = true;
        this.ensureBatch();
        if (!this.batchApi) pushCapped(this.buffer, signal, MAX_BUFFER);
        this.schedule();
    }

    private onChatChanged(): void {
        this.buffer = [];
        this.sceneEnded = false;
        this.lastFailedTo = -1;
        this.wanted = false;
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.emitChange();
        void this.loadDoc().catch(() => undefined);
    }

    private schedule(): void {
        if (this.disposed || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.evaluate().catch((error: unknown) => this.log.warn('revision trigger check failed', error));
        }, this.settleMs);
    }

    /** Messages since the last revision without the signals service: committed end minus the last revised one. */
    private fallbackSince(): number {
        const end = committedEnd(this.sources.chat());
        const lastTo = this.cachedDoc()?.lastTo ?? -1;
        return Math.max(0, end - lastTo);
    }

    /** Checks the triggers and queues a run when one is due (leader only; after a generation, never during it). */
    async evaluate(): Promise<TriggerReason | null> {
        this.ensureBatch();
        const { host, leader } = this.app;
        if (this.disposed || !host.chatId() || host.isGroupChat() || !leader.isLeader()) return null;
        await this.loadDoc();
        const state = this.status();
        if (state.queued) return null;
        const reason = decideTrigger(
            { pending: state.pending, messagesSince: state.messagesSince, sceneEnded: this.sceneEnded },
            this.settings(),
        );
        if (!reason) return null;
        const end = committedEnd(this.sources.chat());
        if (this.lastFailedTo >= 0 && end < this.lastFailedTo + FAIL_BACKOFF_MESSAGES) return null;
        if (this.app.cost.backgroundCapReached() || !this.app.llm.available(REVISION_LLM_TASK)) {
            this.log.debug(`revision due (${reason}) but the background model is not available`);
            return null;
        }
        if (this.app.turn.current()) {
            this.wanted = true;
            return null;
        }
        await this.enqueue(reason);
        return reason;
    }

    private async enqueue(reason: RevisionRun['reason']): Promise<void> {
        await this.app.tasks.enqueue({
            kind: REVISION_TASK,
            dedupeKey: REVISION_DEDUPE,
            payload: { reason },
            ttlMs: TASK_TTL_MS,
        });
        this.sceneEnded = false;
        this.app.tasks.kick();
        this.emitChange();
    }

    /* ---------------------------------------------------------------- the run */

    /** Task runner: never throws (a bad answer is not worth the queue's retries; transport retries are the client's). */
    private async runTask(payload: Record<string, unknown>): Promise<void> {
        const reason = REASONS.find((item) => item === payload.reason) ?? 'manual';
        try {
            await this.execute(reason);
        } catch (error) {
            this.log.error('revision run failed', error);
        }
    }

    /** One revision of the committed messages since the last one. Null when there was nothing to do. */
    async execute(reason: RevisionRun['reason']): Promise<RevisionRun | null> {
        const { host } = this.app;
        const chatId = host.chatId();
        if (!chatId || host.isGroupChat()) return null;
        const doc = await this.loadDoc();
        const end = committedEnd(this.sources.chat());
        const range = revisionRange(doc.lastTo, end, MAX_MESSAGES);
        const signalsApi = this.sources.signals();
        let pending: Signal[] = this.buffer;
        try {
            if (signalsApi) pending = signalsApi.pending();
        } catch (error) {
            this.log.debug('signals are not readable', error);
        }
        pending = pending.filter((signal) => signal.messageIndex === undefined || signal.messageIndex <= end);
        const run: RevisionRun = {
            id: newId('rev'),
            at: Date.now(),
            reason,
            fromMessage: range?.from ?? end + 1,
            toMessage: range?.to ?? end,
            changes: [],
            rejected: [],
            costUsd: 0,
        };
        const messages = range ? this.sources.messages(range.from, range.to) : [];
        if (!range || !messages.length) {
            // Nothing new to read: what is pending is covered. Only a manual run is shown (as «nothing new»).
            if (reason === 'manual') run.error = 'empty';
            await this.finish(chatId, run, { success: true, store: reason === 'manual', deferred: [] });
            return reason === 'manual' ? run : null;
        }

        const entities = this.sources.involved(pending, messages);
        const briefs = await Promise.all(entities.map((entity) => this.sources.brief(entity)));
        const input: RevisionInput = {
            from: range.from,
            to: range.to,
            messages,
            signals: pending.map((signal) => {
                const item: RevisionInput['signals'][number] = { kind: signal.kind };
                if (signal.messageIndex !== undefined) item.messageIndex = signal.messageIndex;
                if (signal.entity) item.entity = signal.entity;
                if (signal.data) item.data = signal.data;
                return item;
            }),
            memories: this.sources.memories(range.from, range.to),
            entities: briefs,
        };
        if (briefs.some((brief) => brief.ckTags?.length)) {
            const vocabulary = await this.sources.vocabulary();
            if (vocabulary) input.vocabulary = vocabulary;
        }

        const analysis = await this.analyze(input, 0);
        run.costUsd += analysis.costUsd;
        if (analysis.error) {
            run.error = analysis.error;
            this.lastFailedTo = range.to;
            await this.finish(chatId, run, { success: false, store: true, deferred: [] });
            return run;
        }
        const deferred: DeferredCard[] = [];
        for (const parsed of analysis.changes) {
            if (host.chatId() !== chatId) {
                this.log.warn('chat changed during a revision; the rest of the run was dropped');
                return run;
            }
            const change: RevisionChange = { id: newId('chg'), ...parsed };
            await this.handle(change, run, entities, deferred);
        }
        await this.finish(chatId, run, { success: true, store: true, deferred });
        return run;
    }

    /** Asks the model; splits the batch when the answer was cut off, retries once on invalid JSON. */
    private async analyze(input: RevisionInput, depth: number): Promise<Analysis> {
        const messages = buildRevisionMessages(input, DEFAULT_PROMPT_LIMITS);
        let costUsd = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await this.app.llm.request<unknown>({
                task: REVISION_LLM_TASK,
                messages,
                maxTokens: MAX_TOKENS,
                temperature: 0,
                schema: revisionSchema(),
            });
            costUsd += result.costUsd ?? 0;
            if (result.ok) {
                const parsed = parseRevisionChanges(result.data, { from: input.from, to: input.to });
                if (parsed) return { changes: parsed.changes, costUsd };
            } else if (result.refusal) {
                return { changes: [], costUsd, error: 'refusal' };
            } else if (result.error !== 'parse') {
                return { changes: [], costUsd, error: result.error ?? 'failed' };
            }
            if (looksTruncated(result.text) && depth < MAX_SPLIT_DEPTH) {
                const halves = splitInput(input);
                if (halves) {
                    const first = await this.analyze(halves[0], depth + 1);
                    const second = await this.analyze(halves[1], depth + 1);
                    const total = costUsd + first.costUsd + second.costUsd;
                    // A partial result is never applied (plan §4.5): one failed half fails the run.
                    const error = first.error ?? second.error;
                    if (error) return { changes: [], costUsd: total, error };
                    return { changes: dedupeChanges([...first.changes, ...second.changes]), costUsd: total };
                }
            }
        }
        return { changes: [], costUsd, error: 'parse' };
    }

    private reject(run: RevisionRun, change: RevisionChange, rejection: Rejection): void {
        run.rejected.push({ change, reason: formatRejection(rejection) });
    }

    /** One change: the living canon, a deferred card, or a checked proposal through autonomy / the Inbox. */
    private async handle(
        change: RevisionChange,
        run: RevisionRun,
        entities: readonly Entity[],
        deferred: DeferredCard[],
    ): Promise<void> {
        if (change.confidence < this.settings().minConfidence) {
            this.reject(run, change, { code: 'lowConfidence', detail: change.confidence.toFixed(2) });
            return;
        }
        if (change.class === 'new') {
            await this.handToLivingCanon(change);
            run.changes.push(change);
            return;
        }
        if (change.target.startsWith('deferred.')) {
            // Stage 9: promises go to the calendar (M17), secrets to «кто что знает» (M18) when they run; otherwise the
            // change waits as a deferred card, which those modules pick up when they are turned on.
            if (await this.routeDeferred(change)) {
                run.changes.push(change);
                return;
            }
            const card: DeferredCard = {
                id: newId('def'),
                target: change.target as DeferredCard['target'],
                entityName: change.entityName,
                value: change.value,
                evidence: change.evidence,
                sourceMessage: change.sourceMessage,
                at: Date.now(),
            };
            if (!deferred.some((item) => sameDeferred(item, card))) deferred.push(card);
            run.changes.push(change);
            return;
        }
        const entity = this.sources.resolve(change.entityName, entities);
        if (entity) change.entityId = entity.id;
        if (!entity && needsEntity(change.target)) {
            this.reject(run, change, { code: 'unknownEntity', detail: change.entityName });
            return;
        }
        const planned = await this.routes.plan(change, entity);
        run.costUsd += planned.costUsd;
        if (!planned.ok) {
            this.reject(run, change, planned.rejection);
            return;
        }
        try {
            if (planned.forceInbox) {
                await this.app.inbox.add(planned.proposal as Proposal);
            } else {
                const decision = await this.app.autonomy.decide(planned.proposal, planned.level);
                if (decision === 'skipped') {
                    this.reject(run, change, { code: 'failed', detail: 'skipped' });
                    return;
                }
            }
        } catch (error) {
            this.log.warn(`revision: routing ${change.target} failed`, error);
            this.reject(run, change, {
                code: 'failed',
                detail: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        run.changes.push(change);
    }

    /** M26 owns new things: its intake when it has one, else a 'fact.new' signal on the bus. */
    /** The owner's intake of a later-stage change (optional in their contracts); false when it is off or refused. */
    private async routeDeferred(change: RevisionChange): Promise<boolean> {
        const statement = {
            entityName: change.entityName,
            value: change.value,
            evidence: change.evidence,
            sourceMessage: change.sourceMessage,
        };
        try {
            if (change.target === 'deferred.promise') {
                const calendar = this.app.modules.api<CalendarApi>('calendar');
                if (typeof calendar?.intake !== 'function') return false;
                return (await calendar.intake(statement)) !== null;
            }
            if (change.target === 'deferred.secret') {
                const knowledge = this.app.modules.api<KnowledgeApi>('knowledge');
                if (typeof knowledge?.intakeSecret !== 'function') return false;
                return (await knowledge.intakeSecret(statement)) !== null;
            }
        } catch (error) {
            this.log.warn(`revision: ${change.target} was not taken; it waits as a deferred card`, error);
        }
        return false;
    }

    private async handToLivingCanon(change: RevisionChange): Promise<void> {
        const fact = {
            name: change.entityName,
            quote: change.evidence,
            text: change.value,
            sourceMessage: change.sourceMessage,
        };
        const living = this.sources.livingCanon();
        if (typeof living?.propose === 'function') {
            try {
                await living.propose(fact);
                return;
            } catch (error) {
                this.log.warn('living canon did not take the fact; sent as a signal', error);
            }
        }
        await this.app.bus.emit('signal', {
            kind: 'fact.new',
            chatId: this.app.host.chatId(),
            messageIndex: change.sourceMessage,
            entity: change.entityName,
            data: { ...fact, source: OWN_SIGNAL_SOURCE },
            at: Date.now(),
        });
    }

    /** Stores the run (and the deferred cards), moves the revised mark and consumes the signals on success. */
    private async finish(
        chatId: string,
        run: RevisionRun,
        options: { success: boolean; store: boolean; deferred: DeferredCard[] },
    ): Promise<void> {
        if (this.app.host.chatId() !== chatId) return;
        await this.mutateDoc((doc) => {
            if (options.store) pushCapped(doc.runs, structuredClone(run), KEEP_RUNS);
            for (const card of options.deferred) {
                if (!doc.deferred.some((item) => sameDeferred(item, card)))
                    pushCapped(doc.deferred, card, KEEP_DEFERRED);
            }
            if (options.success) doc.lastTo = Math.max(doc.lastTo, run.toMessage);
        });
        if (options.success) {
            this.lastFailedTo = -1;
            this.buffer = this.buffer.filter(
                (signal) => signal.messageIndex !== undefined && signal.messageIndex > run.toMessage,
            );
            try {
                await this.sources.signals()?.consume(run.toMessage);
            } catch (error) {
                this.log.warn('signals were not consumed', error);
            }
        }
        if (options.store) {
            for (const listener of [...this.runListeners]) {
                try {
                    listener(structuredClone(run));
                } catch (error) {
                    this.log.error('revision listener failed', error);
                }
            }
        }
        this.emitChange();
    }

    /* ---------------------------------------------------------------- deferred cards */

    private async dismissDeferred(id: string): Promise<void> {
        await this.mutateDoc((doc) => {
            doc.deferred = doc.deferred.filter((card) => card.id !== id);
        });
        this.emitChange();
    }

    /** A swiped, deleted or edited message takes its deferred cards with it (its Inbox cards go in core). */
    private async dropDeferredOf(messageIndex: number): Promise<void> {
        const doc = this.cachedDoc();
        if (!doc?.deferred.some((card) => card.sourceMessage === messageIndex)) return;
        await this.mutateDoc((fresh) => {
            fresh.deferred = fresh.deferred.filter((card) => card.sourceMessage !== messageIndex);
        });
        this.emitChange();
    }

    /* ---------------------------------------------------------------- the chat document */

    private cachedDoc(): RevisionDoc | null {
        const chatId = this.app.host.chatId();
        if (!chatId) return null;
        if (this.docChat !== chatId || !this.doc) {
            void this.loadDoc().catch(() => undefined);
            return null;
        }
        return this.doc;
    }

    private normalise(doc: RevisionDoc): RevisionDoc {
        if (!Array.isArray(doc.runs)) doc.runs = [];
        if (!Array.isArray(doc.deferred)) doc.deferred = [];
        if (typeof doc.lastTo !== 'number' || !Number.isFinite(doc.lastTo)) doc.lastTo = -1;
        return doc;
    }

    async loadDoc(): Promise<RevisionDoc> {
        const chatId = this.app.host.chatId();
        if (!chatId) return emptyRevisionDoc();
        if (this.docChat === chatId && this.doc) return this.doc;
        if (this.loading && this.docChat === chatId) return this.loading;
        this.docChat = chatId;
        const loading = this.app.chat
            .get<RevisionDoc>(REVISION_DOC, emptyRevisionDoc)
            .then((doc) => {
                const ready = this.normalise(doc);
                if (this.app.host.chatId() === chatId && this.docChat === chatId) {
                    this.doc = ready;
                    this.emitChange();
                }
                return ready;
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    private async mutateDoc(change: (doc: RevisionDoc) => void): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            const doc = this.normalise(await this.app.chat.get<RevisionDoc>(REVISION_DOC, emptyRevisionDoc));
            if (this.app.host.chatId() !== chatId) return;
            change(doc);
            if (await this.app.chat.put(REVISION_DOC, doc)) {
                this.doc = doc;
                this.docChat = chatId;
                return;
            }
        }
        this.log.warn(`revision document could not be saved after ${PUT_ATTEMPTS} attempts`);
    }

    private emitChange(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('revision listener failed', error);
            }
        }
    }
}
