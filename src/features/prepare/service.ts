// M37 «Подготовить к игре» (plan-2 §7): the service behind PrepareApi — eligibility of a new chat, the estimate, the
// analysis as a user job (app.jobs: progress, «Stop»), the chat's plan document (app.chat 'prepare'), the apply step
// (apply.ts), the saved character-level preparation (a Maestro file per card avatar with the source hashes, the whole
// analysis and the items saved «для персонажа»; their texts live in the card's Maestro book), the «Готово к игре»
// status, and the director's first-scene override released after the first committed turn.
import { adaptersOf } from '../../adapters';
import { createUserJobs } from '../../core/jobs';
import { applyOrder, missingForPlay, selectItems } from '../../domain/prepare-apply';
import type { MissingItem, ReadyFacts, SelectionRow } from '../../domain/prepare-apply';
import { normName } from '../../domain/dossier-names';
import { markExisting, mergeItems, reusePlan } from '../../domain/prepare-merge';
import { clonePlan, isPrepareKind, itemNames, itemTitle } from '../../domain/prepare-plan';
import type { AnyPrepareItem, PlanSource, PreparePlan, PrepareScope } from '../../domain/prepare-plan';
import { diffSources, fingerprintOf, sourceHashes } from '../../domain/prepare-sources';
import type { PrepareSource } from '../../domain/prepare-sources';
import type { App, JournalChange, Logger, Unsubscribe, UserJobHandle, UserJobs } from '../../shared/contracts';
import type { DirectorApi, SceneType } from '../director/api';
import type { PlacesApi } from '../places/api';
import type {
    ApplyLine,
    PrepareApi,
    PrepareApplyOptions,
    PrepareApplySummary,
    PrepareEligibility,
    PrepareEstimateResult,
    PrepareStartOptions,
    PrepareState,
    ReadyStatus,
    SavedPreparationInfo,
} from './api';
import { Applier, newPack } from './apply';
import type { ItemOutcome } from './apply';
import { CardBook } from './card-book';
import type { CardBookItem } from './card-book';
import { Collector, apiOf, currentCard, hasUserMessages, isDict, safely } from './collect';
import type { Collected } from './collect';
import { estimateRun, partsOf, runExtraction } from './extract';
import { PREPARE_DOC, PREPARE_KEY, PREPARE_STEP_TARGET, PREPARE_TAB, SAVED_FILE_KIND } from './settings';
import type { PrepareSettings } from './settings';

/** How often a write re-checks for a generation that ended without `generation:ended`, and how long at most. */
const IDLE_POLL_MS = 2000;
const IDLE_ROUNDS = 60;

/** The chat's document. */
export interface PrepareDoc {
    plan: PreparePlan | null;
    stage: 'none' | 'ready' | 'applied' | 'failed';
    error?: string;
    applied: { itemId: string; journalId?: string; scope: PrepareScope; at: number; text: string }[];
    appliedAt?: number;
    /** The director's override set for the first scene (released after the first committed turn). */
    firstScene?: { type: string; previous: string | null };
}

/** The saved character-level preparation of a card (a Maestro file per avatar). */
export interface SavedFile {
    version: 1;
    avatar: string;
    cardName: string;
    savedAt: number;
    /** The card's Maestro book with the texts. */
    book: string | null;
    /** Source hashes when it was saved, and their labels (for «what changed»). */
    hashes: Record<string, string>;
    labels: Record<string, string>;
    fingerprint: string;
    greeting: number;
    /** Items saved «для персонажа». */
    items: AnyPrepareItem[];
    /** The whole analysis (unchanged parts are reused by the next new chat). */
    analysis: AnyPrepareItem[];
}

export function emptyDoc(): PrepareDoc {
    return { plan: null, stage: 'none', applied: [] };
}

function readDoc(raw: unknown): PrepareDoc {
    const doc = emptyDoc();
    if (!isDict(raw)) return doc;
    if (isDict(raw.plan) && Array.isArray(raw.plan.items)) {
        const plan = raw.plan as unknown as PreparePlan;
        doc.plan = { ...plan, items: plan.items.filter((item) => isDict(item) && isPrepareKind(item.kind)) };
    }
    if (raw.stage === 'ready' || raw.stage === 'applied' || raw.stage === 'failed') doc.stage = raw.stage;
    if (typeof raw.error === 'string') doc.error = raw.error;
    if (Array.isArray(raw.applied)) doc.applied = raw.applied.filter(isDict) as unknown as PrepareDoc['applied'];
    if (typeof raw.appliedAt === 'number') doc.appliedAt = raw.appliedAt;
    if (isDict(raw.firstScene) && typeof raw.firstScene.type === 'string') {
        doc.firstScene = {
            type: raw.firstScene.type,
            previous: typeof raw.firstScene.previous === 'string' ? raw.firstScene.previous : null,
        };
    }
    return doc;
}

function readSavedFile(raw: unknown): SavedFile | null {
    if (!isDict(raw) || raw.version !== 1 || typeof raw.avatar !== 'string') return null;
    const items = Array.isArray(raw.items) ? (raw.items.filter(isDict) as unknown as AnyPrepareItem[]) : [];
    const analysis = Array.isArray(raw.analysis) ? (raw.analysis.filter(isDict) as unknown as AnyPrepareItem[]) : [];
    return {
        version: 1,
        avatar: raw.avatar,
        cardName: typeof raw.cardName === 'string' ? raw.cardName : '',
        savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
        book: typeof raw.book === 'string' && raw.book ? raw.book : null,
        hashes: isDict(raw.hashes) ? (raw.hashes as Record<string, string>) : {},
        labels: isDict(raw.labels) ? (raw.labels as Record<string, string>) : {},
        fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
        greeting: typeof raw.greeting === 'number' ? raw.greeting : 0,
        items: items.filter((item) => isPrepareKind(item.kind)),
        analysis: analysis.filter((item) => isPrepareKind(item.kind)),
    };
}

export class PrepareService {
    private doc: PrepareDoc | null = null;
    private docChat: string | null = null;
    private loading: Promise<PrepareDoc> | null = null;
    private running: { key: string; chatId: string; done: Promise<void> } | null = null;
    private ownJobs: UserJobs | null = null;
    private watchers = 0;
    private readonly listeners = new Set<() => void>();
    private readonly collector: Collector;
    private readonly applier: Applier;
    private readonly cardBook: CardBook;
    private writeChain: Promise<unknown> = Promise.resolve();
    /** Opens the preparation window (the job's «Открыть», the notice after applying); set by the module's face. */
    private openView: () => void = () => this.app.ui.openPult(PREPARE_TAB);

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => PrepareSettings,
    ) {
        this.collector = new Collector(app, log, settings);
        this.applier = new Applier(app, log, (avatar, itemId) => this.forgetSavedItem(avatar, itemId));
        this.cardBook = new CardBook(app, log);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        this.app.journal.registerUndo(PREPARE_STEP_TARGET, (change: JournalChange) => this.applier.undo(change));
        offs.push(
            this.app.bus.on('chat:changed', () => {
                this.doc = null;
                this.docChat = null;
                this.loading = null;
                this.emit();
                void this.load().catch((error: unknown) => this.log.debug('prepare: the plan did not load', error));
            }),
        );
        offs.push(this.app.bus.on('turn:committed', () => this.releaseFirstScene()));
        offs.push(() => {
            if (this.running) this.jobs().cancel(this.running.key);
            this.listeners.clear();
        });
        return offs;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('prepare: listener failed', error);
            }
        }
    }

    /** Where «Открыть» of the job and of the applied notice leads (the window, or the pult tab without windows). */
    setOpener(open: () => void): void {
        this.openView = open;
    }

    /** Views showing the job right now (a job nobody watches reports its end with a notice). */
    watch(): Unsubscribe {
        this.watchers++;
        let done = false;
        return () => {
            if (done) return;
            done = true;
            this.watchers = Math.max(0, this.watchers - 1);
        };
    }

    private jobs(): UserJobs {
        if (this.app.jobs) return this.app.jobs;
        this.ownJobs ??= createUserJobs({
            log: this.log,
            notice: (text, options) => this.app.ui.notice(text, options),
        });
        return this.ownJobs;
    }

    /* ---------------------------------------------------------------- the chat's document */

    async load(): Promise<PreparePlan | null> {
        return (await this.loadDoc()).plan;
    }

    private loadDoc(): Promise<PrepareDoc> {
        const chatId = this.app.host.chatId();
        if (!chatId) return Promise.resolve(emptyDoc());
        if (this.doc && this.docChat === chatId) return Promise.resolve(this.doc);
        if (this.loading) return this.loading;
        const job = (async () => {
            let raw: unknown = null;
            try {
                raw = await this.app.chat.get<Record<string, unknown>>(PREPARE_DOC, () => ({}));
            } catch (error) {
                this.log.debug('prepare: the document did not load', error);
            }
            const doc = readDoc(raw);
            if (this.app.host.chatId() === chatId) {
                this.doc = doc;
                this.docChat = chatId;
                this.emit();
            }
            return doc;
        })();
        this.loading = job.finally(() => {
            this.loading = null;
        });
        return this.loading;
    }

    private async saveDoc(doc: PrepareDoc, chatId: string): Promise<void> {
        if (this.app.host.chatId() !== chatId) return;
        this.doc = doc;
        this.docChat = chatId;
        const write = this.writeChain.then(async () => {
            const ok = await this.app.chat.put(PREPARE_DOC, clonePlan(doc) as unknown as Record<string, unknown>);
            if (!ok) this.log.warn('prepare: another tab wrote the plan; this one is kept in memory');
        });
        this.writeChain = write.catch((error: unknown) => this.log.warn('prepare: the plan was not saved', error));
        await this.writeChain;
        this.emit();
    }

    /* ---------------------------------------------------------------- reads */

    eligibility(): PrepareEligibility {
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!chatId) return { ok: false, reason: 'noChat' };
        if (safely(() => this.app.host.isGroupChat() || !!this.app.host.ctx().groupId, false)) {
            return { ok: false, reason: 'group' };
        }
        if (!currentCard(this.app)) return { ok: false, reason: 'noCard' };
        const chat = safely(() => this.app.host.ctx().chat ?? [], [] as STChatMessage[]);
        if (hasUserMessages(chat)) return { ok: false, reason: 'started' };
        return { ok: true };
    }

    isNewChat(): boolean {
        return this.eligibility().ok;
    }

    state(): PrepareState {
        const chatId = this.app.host.chatId();
        if (this.running && this.running.chatId === chatId) return { stage: 'running', jobKey: this.running.key };
        const doc = this.docChat === chatId ? this.doc : null;
        const state: PrepareState = { stage: doc?.stage ?? 'none', jobKey: chatId ? jobKey(chatId) : null };
        if (doc?.error) state.error = doc.error;
        if (doc?.appliedAt) state.appliedAt = doc.appliedAt;
        return state;
    }

    plan(): PreparePlan | null {
        const chatId = this.app.host.chatId();
        return this.docChat === chatId && this.doc?.plan ? clonePlan(this.doc.plan) : null;
    }

    describe(item: AnyPrepareItem): string {
        if (item.russian) return item.russian;
        const title = itemTitle(item);
        return this.t(`m37.describe.${item.kind}`, { name: title || this.t(`m37.section.${item.kind}`) });
    }

    /** The user's label of a source («Описание карточки», «Книга · запись»). */
    sourceLabel(source: Pick<PrepareSource, 'field' | 'origin' | 'label'>): string {
        if (source.field) return this.t(`m37.source.${source.field}`);
        if (source.origin === 'persona') return this.t('m37.source.persona');
        return source.label;
    }

    /* ---------------------------------------------------------------- saved character-level preparation */

    private savedName(avatar: string): string {
        return this.app.files.fileName(SAVED_FILE_KIND, avatar);
    }

    async readSaved(avatar: string): Promise<SavedFile | null> {
        if (!avatar) return null;
        try {
            return readSavedFile(await this.app.files.read<unknown>(this.savedName(avatar), { fresh: true }));
        } catch (error) {
            this.log.debug('prepare: the saved preparation did not load', error);
            return null;
        }
    }

    private async writeSaved(file: SavedFile): Promise<void> {
        await this.app.files.write(this.savedName(file.avatar), file);
    }

    private async forgetSavedItem(avatar: string, itemId: string): Promise<void> {
        const saved = await this.readSaved(avatar);
        if (!saved) return;
        const items = saved.items.filter((item) => item.id !== itemId);
        if (items.length === saved.items.length) return;
        await this.writeSaved({ ...saved, items, savedAt: Date.now() });
    }

    async savedFor(avatar?: string): Promise<SavedPreparationInfo | null> {
        const card = currentCard(this.app);
        const key = avatar ?? card?.avatar ?? '';
        const saved = await this.readSaved(key);
        if (!saved || !saved.items.length) return null;
        let changed: string[] = [];
        if (card && card.avatar === key) {
            const collected = await this.collector.collect();
            if (collected) {
                const diff = diffSources(saved.hashes, sourceHashes(collected.sources));
                const labels = new Map(collected.sources.map((item) => [item.id, this.sourceLabel(item)]));
                changed = [...diff.changed, ...diff.added, ...diff.removed].map(
                    (id) => labels.get(id) ?? saved.labels[id] ?? id,
                );
            }
        }
        return {
            avatar: saved.avatar,
            cardName: saved.cardName,
            savedAt: saved.savedAt,
            items: clonePlan(saved.items),
            book: saved.book,
            changed,
        };
    }

    /* ---------------------------------------------------------------- estimate and the analysis */

    /** The sources a run reads: all, or (reuse) the changed ones of the saved preparation and the items they touch. */
    private async runSources(
        collected: Collected,
        reuse: boolean,
    ): Promise<{ sources: PrepareSource[]; kept: AnyPrepareItem[]; saved: SavedFile | null }> {
        const saved = reuse ? await this.readSaved(collected.card.avatar) : null;
        if (!saved || !saved.analysis.length) return { sources: collected.sources, kept: [], saved };
        const savedIds = new Set(saved.items.map((item) => item.id));
        const analysis = saved.analysis.map((item) =>
            savedIds.has(item.id) ? { ...item, scope: 'character' as const } : item,
        );
        const diff = diffSources(saved.hashes, sourceHashes(collected.sources));
        const plan = reusePlan(
            analysis,
            diff,
            collected.sources.map((item) => item.id),
        );
        const reread = new Set(plan.reread);
        return { sources: collected.sources.filter((item) => reread.has(item.id)), kept: plan.kept, saved };
    }

    async estimate(options: PrepareStartOptions = {}): Promise<PrepareEstimateResult> {
        const collected = await this.collector.collect();
        if (!collected) throw new Error(this.t('m37.error.noCard'));
        const settings = this.settings();
        const { sources, saved } = await this.runSources(collected, options.reuse === true);
        const parts = partsOf(sources, settings);
        const estimate = estimateRun(collected, parts, settings);
        const byId = new Map(collected.sources.map((item) => [item.id, item]));
        const read = new Set(parts.chunks.flatMap((chunk) => chunk.sourceIds));
        const label = (id: string) => {
            const item = byId.get(id);
            return item ? this.sourceLabel(item) : id;
        };
        return {
            ...estimate,
            labels: [...read].map(label),
            skippedLabels: parts.skipped.map(label),
            reuse: !!saved,
        };
    }

    whenDone(): Promise<void> {
        return this.running?.done ?? Promise.resolve();
    }

    cancel(): boolean {
        return this.running ? this.jobs().cancel(this.running.key) : false;
    }

    async start(options: PrepareStartOptions = {}): Promise<string | null> {
        const eligibility = this.eligibility();
        if (!eligibility.ok && !(options.force && eligibility.reason === 'started')) return null;
        const chatId = this.app.host.chatId();
        const card = currentCard(this.app);
        if (!chatId || !card) return null;
        const key = jobKey(chatId);
        const handle = this.jobs().start({
            key,
            title: this.t('m37.job.title', { card: card.name }),
            module: PREPARE_KEY,
            cancellable: true,
            visible: () => this.watchers > 0,
            open: { label: this.t('m37.job.open'), run: () => this.openView() },
        });
        if (!handle) return null;
        let resolve: () => void = () => {};
        const done = new Promise<void>((next) => {
            resolve = next;
        });
        this.running = { key, chatId, done };
        this.emit();
        void this.run(handle, options, chatId)
            .catch((error: unknown) => {
                this.log.error('prepare: the analysis failed unexpectedly', error);
                handle.fail(this.t('m37.job.error', { error: error instanceof Error ? error.message : String(error) }));
            })
            .finally(() => {
                if (this.running?.key === key) this.running = null;
                resolve();
                this.emit();
            });
        return key;
    }

    private async run(handle: UserJobHandle, options: PrepareStartOptions, chatId: string): Promise<void> {
        handle.phase('running', this.t('m37.job.collecting'));
        const collected = await this.collector.collect();
        if (!collected) {
            handle.fail(this.t('m37.error.noCard'));
            return;
        }
        const settings = this.settings();
        const { sources, kept, saved } = await this.runSources(collected, options.reuse === true);
        const outcome = sources.length
            ? await runExtraction(this.app, this.log, {
                  collected,
                  sources,
                  settings,
                  signal: handle.signal,
                  onProgress: ({ done, total }) => {
                      handle.progress(done, total, this.t('m37.job.progress', { done, total }));
                  },
              })
            : { items: [], chunks: 0, failedChunks: 0, costUsd: 0, partial: false, skipped: [], errors: [] };
        if (this.app.host.chatId() !== chatId) {
            handle.fail(this.t('m37.job.chatChanged'));
            return;
        }
        const doc = clonePlan(await this.loadDoc());
        if (outcome.chunks && outcome.failedChunks === outcome.chunks && !outcome.partial) {
            const reason = outcome.errors[0] ?? '—';
            const error = reason === 'cap' ? this.t('m37.job.cap') : this.t('m37.job.failed', { error: reason });
            doc.stage = doc.plan ? doc.stage : 'failed';
            doc.error = error;
            await this.saveDoc(doc, chatId);
            handle.fail(error);
            return;
        }
        const savedIds = new Set((saved?.items ?? []).map((item) => item.id));
        const merged = mergeItems([outcome.items, kept]).map((item) =>
            savedIds.has(item.id) ? { ...item, scope: 'character' as const } : item,
        );
        const items = markExisting(merged, collected.snapshot);
        const byId = new Map(collected.sources.map((item) => [item.id, item]));
        const planSource = (item: PrepareSource): PlanSource => ({
            id: item.id,
            label: this.sourceLabel(item),
            hash: item.hash,
        });
        const plan: PreparePlan = {
            version: 1,
            createdAt: Date.now(),
            card: { avatar: collected.card.avatar, name: collected.view.name },
            greeting: collected.greeting,
            items,
            sources: collected.sources.map(planSource),
            skipped: outcome.skipped.flatMap((id) => {
                const item = byId.get(id);
                return item ? [planSource(item)] : [];
            }),
            fingerprint: fingerprintOf(sourceHashes(collected.sources)),
            chunks: outcome.chunks,
            failedChunks: outcome.failedChunks,
            costUsd: outcome.costUsd,
        };
        if (outcome.partial) plan.partial = true;
        if (saved) plan.reused = true;
        doc.plan = plan;
        doc.stage = 'ready';
        delete doc.error;
        await this.saveDoc(doc, chatId);
        const summary = this.t('m37.job.done', { count: items.length });
        if (outcome.partial) handle.finish(this.t('m37.job.stopped', { count: items.length }), { cancelled: true });
        else handle.finish(summary, { warn: outcome.failedChunks > 0 });
    }

    /* ---------------------------------------------------------------- apply */

    async apply(
        selection: readonly SelectionRow[] | 'all',
        options: PrepareApplyOptions = {},
    ): Promise<PrepareApplySummary> {
        const chatId = this.app.host.chatId();
        if (!chatId) throw new Error(this.t('m37.error.noChat'));
        const doc = clonePlan(await this.loadDoc());
        if (!doc.plan) throw new Error(this.t('m37.error.noPlan'));
        const chosen = selectItems(doc.plan.items, selection, this.settings().defaultScope);
        return this.applyItems(chosen, doc, chatId, 'apply', options);
    }

    async applySaved(options: PrepareApplyOptions = {}): Promise<PrepareApplySummary> {
        const chatId = this.app.host.chatId();
        const card = currentCard(this.app);
        if (!chatId || !card) throw new Error(this.t('m37.error.noCard'));
        const saved = await this.readSaved(card.avatar);
        if (!saved || !saved.items.length) throw new Error(this.t('m37.error.noSaved'));
        const entries = saved.book ? await this.cardBook.items(saved.book) : [];
        const imported = new Map<string, CardBookItem>(entries.map((entry) => [entry.itemId, entry]));
        const snapshot = await this.collector.snapshot();
        const items = markExisting(
            saved.items.map((item) => ({ ...clonePlan(item), scope: 'character' as const, saved: true })),
            snapshot,
        );
        const doc = clonePlan(await this.loadDoc());
        if (!doc.plan) {
            doc.plan = {
                version: 1,
                createdAt: Date.now(),
                card: { avatar: card.avatar, name: saved.cardName || card.name },
                greeting: saved.greeting,
                items,
                sources: [],
                skipped: [],
                fingerprint: saved.fingerprint,
                chunks: 0,
                failedChunks: 0,
                reused: true,
            };
        }
        const chosen = applyOrder(
            items.filter((item) => !item.exists || (item.kind === 'mechanic' && item.data.initial.length > 0)),
        );
        return this.applyItems(chosen, doc, chatId, 'import', { ...options, confirmed: true }, imported);
    }

    private async applyItems(
        chosen: AnyPrepareItem[],
        doc: PrepareDoc,
        chatId: string,
        mode: 'apply' | 'import',
        options: PrepareApplyOptions,
        imported?: ReadonlyMap<string, CardBookItem>,
    ): Promise<PrepareApplySummary> {
        const summary: PrepareApplySummary = { done: [], skipped: [], failed: [], proposals: [] };
        const card = currentCard(this.app);
        if (!card) throw new Error(this.t('m37.error.noCard'));
        if (!chosen.length) return summary;
        const forCard = mode === 'apply' ? chosen.filter((item) => item.scope === 'character') : [];
        await this.idle();
        if (forCard.length && !options.confirmed) {
            const ok = await this.app.ui.confirm(
                this.t('m37.confirm.title'),
                this.t('m37.confirm.body', { count: forCard.length, card: card.name }),
            );
            if (!ok) return { ...summary, cancelled: true };
        }
        const saved = await this.readSaved(card.avatar);
        const book = this.cardBook.nameFor(card.name, saved?.book);
        const pack = newPack();
        const env = {
            card,
            cardBook: book,
            passports: options.passports ?? this.settings().passports,
            mode,
            ...(imported ? { imported } : {}),
            plan: doc.plan?.items ?? chosen,
        };
        const outcomes: { item: AnyPrepareItem; outcome: ItemOutcome }[] = [];
        for (const item of chosen) {
            if (this.app.host.chatId() !== chatId) break;
            const outcome = await this.applier.applyItem(item, env, pack);
            outcomes.push({ item, outcome });
            this.report(summary, outcome);
            if (outcome.journalId || outcome.done.length) {
                doc.applied.push({
                    itemId: item.id,
                    ...(outcome.journalId ? { journalId: outcome.journalId } : {}),
                    scope: mode === 'import' ? 'chat' : item.scope,
                    at: Date.now(),
                    text: this.lineText(outcome),
                });
            }
        }
        summary.proposals.push(...pack.proposals);
        if (pack.firstScene) doc.firstScene = pack.firstScene;
        if (summary.done.length) {
            doc.stage = 'applied';
            doc.appliedAt = Date.now();
        }
        if (doc.plan) {
            const snapshot = await this.collector.snapshot();
            doc.plan.items = markExisting(doc.plan.items, snapshot);
        }
        await this.saveDoc(doc, chatId);
        const cardItems = outcomes.filter(
            ({ item, outcome }) => mode === 'apply' && item.scope === 'character' && outcome.done.length,
        );
        if (cardItems.length)
            await this.saveForCard(
                card,
                book,
                doc,
                cardItems.map(({ item }) => item),
                saved,
            );
        if (summary.done.length || summary.failed.length) {
            this.app.ui.notice(
                this.t(summary.failed.length ? 'm37.notice.appliedWithErrors' : 'm37.notice.applied', {
                    count: summary.done.length,
                    failed: summary.failed.length,
                }),
                {
                    importance: summary.failed.length ? 'important' : 'info',
                    level: summary.failed.length ? 'warn' : 'info',
                    action: { label: this.t('m37.job.open'), run: () => this.openView() },
                },
            );
        }
        return summary;
    }

    /** Writes wait for the generation in progress (P8); re-checked in case its end event was lost. */
    private async idle(): Promise<void> {
        for (let round = 0; round < IDLE_ROUNDS && safely(() => this.app.turn.current() !== null, false); round++) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    off();
                    resolve();
                }, IDLE_POLL_MS);
                const off = this.app.bus.on('generation:ended', () => {
                    clearTimeout(timer);
                    off();
                    resolve();
                });
            });
        }
    }

    private lineText(outcome: ItemOutcome): string {
        if (outcome.done.length) {
            const failed = outcome.failed.length
                ? ` ${this.t('m37.result.partly', { parts: outcome.failed.join('; ') })}`
                : '';
            return `${outcome.title}: ${outcome.done.join(', ')}${failed}`;
        }
        if (outcome.failed.length) return `${outcome.title}: ${outcome.failed.join('; ')}`;
        return `${outcome.title}: ${outcome.skipped.join('; ') || this.t('m37.skip.nothing')}`;
    }

    private report(summary: PrepareApplySummary, outcome: ItemOutcome): void {
        const line = (): ApplyLine => ({
            itemId: outcome.itemId,
            kind: outcome.kind,
            text: this.lineText(outcome),
            ...(outcome.journalId ? { journalId: outcome.journalId } : {}),
        });
        if (outcome.done.length) summary.done.push(line());
        else if (outcome.failed.length) summary.failed.push(line());
        else summary.skipped.push(line());
        if (outcome.done.length && outcome.failed.length) {
            summary.failed.push({
                itemId: outcome.itemId,
                kind: outcome.kind,
                text: `${outcome.title}: ${outcome.failed.join('; ')}`,
            });
        }
    }

    /** Remembers the items applied «для персонажа» (and the whole analysis) for the card's next new chats. */
    private async saveForCard(
        card: { avatar: string; name: string },
        book: string,
        doc: PrepareDoc,
        items: readonly AnyPrepareItem[],
        previous: SavedFile | null,
    ): Promise<void> {
        const plan = doc.plan;
        const kept = (previous?.items ?? []).filter((item) => !items.some((candidate) => candidate.id === item.id));
        const hashes: Record<string, string> = {};
        const labels: Record<string, string> = {};
        for (const source of plan?.sources ?? []) {
            hashes[source.id] = source.hash;
            labels[source.id] = source.label;
        }
        const file: SavedFile = {
            version: 1,
            avatar: card.avatar,
            cardName: card.name,
            savedAt: Date.now(),
            book,
            hashes: Object.keys(hashes).length ? hashes : (previous?.hashes ?? {}),
            labels: Object.keys(labels).length ? labels : (previous?.labels ?? {}),
            fingerprint: plan?.fingerprint || previous?.fingerprint || '',
            greeting: plan?.greeting ?? 0,
            items: [...kept, ...items.map((item) => ({ ...clonePlan(item), scope: 'character' as const }))],
            analysis: plan?.items.length ? clonePlan(plan.items) : (previous?.analysis ?? []),
        };
        try {
            await this.writeSaved(file);
        } catch (error) {
            this.log.warn('prepare: the character-level preparation was not saved', error);
        }
    }

    async undoItem(itemId: string): Promise<boolean> {
        const chatId = this.app.host.chatId();
        if (!chatId) return false;
        const doc = clonePlan(await this.loadDoc());
        const record = [...doc.applied].reverse().find((row) => row.itemId === itemId && row.journalId);
        if (!record?.journalId) return false;
        const ok = await this.app.journal.undo(record.journalId);
        if (!ok) return false;
        doc.applied = doc.applied.filter((row) => row !== record && row.journalId !== record.journalId);
        if (doc.plan) doc.plan.items = markExisting(doc.plan.items, await this.collector.snapshot());
        if (!doc.applied.length && doc.stage === 'applied') doc.stage = doc.plan ? 'ready' : 'none';
        await this.saveDoc(doc, chatId);
        return true;
    }

    async discard(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        this.cancel();
        await this.saveDoc(emptyDoc(), chatId);
    }

    /* ---------------------------------------------------------------- «Готово к игре» */

    async status(): Promise<ReadyStatus> {
        const doc = await this.loadDoc();
        const items = doc.plan?.items ?? [];
        const passports = safely(() => adaptersOf(this.app).nai.chatPassports(), []);
        const passportNames = new Set(
            passports.flatMap((passport) => [passport.name, ...passport.aliases]).map((name) => normName(name)),
        );
        const desSettings = safely(() => adaptersOf(this.app).des.settings(), null);
        const avatars =
            isDict(desSettings) && isDict(desSettings.npcAvatars) ? Object.keys(desSettings.npcAvatars) : [];
        const portraitNames = new Set(avatars.map((name) => normName(name)));
        const places = apiOf<PlacesApi>(this.app, 'places');
        const facts: ReadyFacts = {
            applied: doc.stage === 'applied',
            characters: items
                .filter((item): item is AnyPrepareItem & { kind: 'character' } => item.kind === 'character')
                .filter((item) => !item.data.persona)
                .map((item) => {
                    const names = itemNames(item).map((name) => normName(name));
                    return {
                        name: item.data.name,
                        present: item.data.present,
                        passport: !!item.links?.passportId || names.some((name) => passportNames.has(name)),
                        portrait: names.some((name) => portraitNames.has(name)),
                    };
                }),
            places: items
                .filter((item): item is AnyPrepareItem & { kind: 'place' } => item.kind === 'place')
                .map((item) => {
                    const place = places ? safely(() => places.resolve(item.data.name), undefined) : undefined;
                    const background =
                        !!place?.background || Object.keys(place?.state ?? {}).some((key) => key.startsWith('bg'));
                    return { name: item.data.name, registered: !!place, background };
                }),
        };
        const missing: MissingItem[] = doc.plan ? missingForPlay(facts) : [{ kind: 'plan', name: '' }];
        return {
            ready: !missing.some((item) => item.kind === 'plan' || item.kind === 'place' || item.kind === 'passport'),
            missing,
            lines: missing.map((item) => this.t(`m37.ready.${item.kind}`, { name: item.name })),
        };
    }

    /* ---------------------------------------------------------------- the director's first scene */

    private releaseFirstScene(): void {
        const chatId = this.app.host.chatId();
        const doc = this.docChat === chatId ? this.doc : null;
        if (!chatId || !doc?.firstScene) return;
        const first = doc.firstScene;
        const director = apiOf<DirectorApi>(this.app, 'director');
        const next = clonePlan(doc);
        delete next.firstScene;
        void (async () => {
            try {
                if (director && safely(() => director.override?.() ?? null, null) === first.type) {
                    await director.setScene((first.previous as SceneType | null) ?? null);
                }
            } catch (error) {
                this.log.debug('prepare: the first scene was not released', error);
            }
            await this.saveDoc(next, chatId);
        })();
    }

    api(): PrepareApi {
        return {
            isNewChat: () => this.isNewChat(),
            eligibility: () => this.eligibility(),
            state: () => this.state(),
            plan: () => this.plan(),
            load: () => this.load(),
            estimate: (options) => this.estimate(options),
            start: (options) => this.start(options),
            whenDone: () => this.whenDone(),
            cancel: () => this.cancel(),
            apply: (selection, options) => this.apply(selection, options),
            undoItem: (itemId) => this.undoItem(itemId),
            savedFor: (avatar) => this.savedFor(avatar),
            applySaved: (options) => this.applySaved(options),
            discard: () => this.discard(),
            status: () => this.status(),
            describe: (item) => this.describe(item),
            onChange: (listener) => this.onChange(listener),
        };
    }
}

export function jobKey(chatId: string): string {
    return `prepare:${chatId}`;
}
