// M21m service (plan §14, P15, §4.11-4.12; dev-plan 4.6): collects send-path timings, per-turn lore and prompt
// sizes, cost entries and counters into the per-chat document 'metrics', and answers MetricsApi.
//
// Send path (P15). The hooks there only read a clock and keep references:
// - GENERATION_STARTED (first listener): ST's Generate() began — the start of the whole send window;
// - bus `generation:before`: Maestro's interceptor started (t0); quiet and dry generations are skipped;
// - turn.onIntercept (registered after the other modules' handlers): Maestro's interceptor work is done; the prompt
//   entries array is kept by reference for the Qvink check;
// - fetch gate beforeRequest on the chat-completion generate URL: the request leaves (t1).
// When the turn pipeline reports its own interceptor timing (optional TurnHooks.lastIntercept()), t0 moves to the
// interceptor start, so the ephemeral producers that run before generation:before are counted too.
// Everything else (device class, the Qvink check, the document) runs in a timer started at t1: the gate calls the
// real fetch right after the hook returns, so that work happens after the request is on its way.
//
// Storage: one document per chat (kind 'metrics', src/domain/metrics-doc.ts), written a few seconds after a change
// as batches that are applied once per document, so two tabs never count anything twice.
import { currentTabId } from '../../core/files';
import { ConsoleLogger } from '../../core/logger';
import type { LogLine } from '../../core/logger';
import {
    assistantAtDepth,
    dataLossLines,
    revisionShare,
    sheetSummary,
    turnCounts,
    undoShare,
} from '../../domain/metrics-checks';
import type { PackComparison, RevisionShare } from '../../domain/metrics-checks';
import {
    DOC_LIMITS,
    applyBatch,
    batchIsEmpty,
    copyMetricsDoc,
    emptyBatch,
    emptyMetricsDoc,
    freezeDocBaseline,
    normalizeMetricsDoc,
} from '../../domain/metrics-doc';
import type { MetricsBatch, MetricsDoc, TurnPatch } from '../../domain/metrics-doc';
import { buildCriteria } from '../../domain/metrics-report';
import type { CriteriaInput } from '../../domain/metrics-report';
import { averageLore, costShare, distribution, loreRatio, summarizeLatency } from '../../domain/metrics-stats';
import type {
    CostSample,
    CostShare,
    DeviceClass,
    Distribution,
    LatencySummary,
    LoreWhatIf,
} from '../../domain/metrics-stats';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import type { InspectorApi, InspectorRecord } from '../inspector/api';
import type { LoreJournalApi, TurnLoreRecord } from '../loreJournal/api';
import type { RulesApi } from '../rules/api';
import { METRIC_COUNTERS } from './api';
import type { CriteriaReport, LoreState, MetricsApi } from './api';
import { PackStore } from './packs';
import { renderJson, renderMarkdown } from './report';
import {
    activeLoreRules,
    autonomyCounts,
    costKey,
    droppedInPrompt,
    guardianBlocked,
    guardianState,
    interceptTiming,
    journalRecords,
    livingCounts,
    loreEntries,
    readBookText,
    readDevice,
    recentCosts,
    revisionStats,
    sheetViews,
    toCostSample,
} from './sources';

export const METRICS_KEY = 'metrics';
export const METRICS_DOC_KIND = 'metrics';

const GENERATE_RE = /\/api\/backends\/chat-completions\/generate/;
const SAVE_RE = /\/api\/(?:settings\/save|presets\/save|worldinfo\/edit)(?:[?#]|$)/;
/** A generation whose request never left must not claim a later request. */
const ARM_TTL_MS = 5 * 60_000;
/** GENERATION_STARTED older than this is not the start of the current generation. */
const WINDOW_START_MAX_MS = 60_000;
const RECENT_LIMIT = 40;
const IDLE_LIMIT = 100;
const LOSS_SAMPLES = 5;
const COST_INGEST_DELAY_MS = 500;
const RETRY_FACTOR = 5;
const LABEL_RE = /[^\w.:-]/g;

export interface MetricsSettings {
    /** Turns in the cost window (plan §14 п. 2: 100 turns). */
    windowTurns: number;
    /** Turns averaged into the lore baseline. */
    baselineTurns: number;
    /** Autonomy kinds that are revision proposals (M8): 'prefix.' / 'prefix*' or exact kinds. */
    revisionKinds: string[];
}

/** RevisionTarget kinds of M8 (src/features/revision/api.ts) plus anything M8 files under 'revision.'. */
export const REVISION_KINDS = [
    'revision.',
    'canon.fact',
    'ck.tags',
    'nai.appearance',
    'chat.alias',
    'des.alias',
    'chronicle.event',
    'places.state',
];

export function defaultMetricsSettings(): MetricsSettings {
    return { windowTurns: 100, baselineTurns: 50, revisionKinds: [...REVISION_KINDS] };
}

export interface MetricsDeps {
    /** Monotonic clock, ms (performance.now). */
    clock?: () => number;
    /** Wall clock, ms. */
    now?: () => number;
    device?: () => DeviceClass;
    /** A lorebook as the server reads it now (text), null when unreadable. */
    readBook?: (name: string) => Promise<string | null>;
    /** Warnings and errors of this page (the logger's ring buffer). */
    logLines?: () => readonly LogLine[];
    tabId?: string;
    saveDelayMs?: number;
    /** Delay before the first pack fingerprints are taken; < 0 = never automatically. */
    packDelayMs?: number;
    /** Runs work after the current task (after the request left). */
    defer?: (run: () => void) => void;
}

interface InFlight {
    id: string;
    chatId: string;
    type: string;
    auto: boolean;
    t0: number;
    started?: number;
    intercepted?: number;
    t1?: number;
    at?: number;
    armedAt: number;
    modules: Record<string, number>;
    chat?: STChatMessage[];
}

interface OpenBatch {
    batch: MetricsBatch;
    turns: Map<string, TurnPatch>;
}

interface RecentSample {
    id: string;
    chatId: string;
    at: number;
    lore?: boolean;
    inspector?: boolean;
    messageIndex?: number;
}

export interface MetricsSnapshot {
    report: CriteriaReport;
    input: CriteriaInput;
    latency: LatencySummary;
    cost: CostShare;
    lore: LoreState;
    /** Module timings booked outside a generation. */
    idle: Record<string, Distribution>;
    /** Last data-loss lines seen in this page. */
    losses: string[];
    packsCheckedAt?: number;
    counters: Record<string, number>;
    chatId: string | null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export class MetricsService implements MetricsApi {
    private readonly clock: () => number;
    private readonly now: () => number;
    private readonly deviceFn: () => DeviceClass;
    private readonly readBook: (name: string) => Promise<string | null>;
    private readonly logLines: () => readonly LogLine[];
    private readonly tab: string;
    private readonly saveDelay: number;
    private readonly packDelay: number;
    private readonly defer: (run: () => void) => void;

    private currentChat: string | null = null;
    private group = false;
    private startedAt: number | undefined;
    private flight: InFlight | null = null;
    private autoNext = false;
    private sampleSeq = 0;
    private lastSeq = 0;

    private readonly open = new Map<string, OpenBatch>();
    private readonly sealed = new Map<string, MetricsBatch[]>();
    private readonly views = new Map<string, MetricsDoc>();
    private readonly loading = new Map<string, Promise<void>>();
    private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private saving: Promise<void> = Promise.resolve();
    private cached: { chatId: string | null; doc: MetricsDoc } | null = null;

    private readonly recent: RecentSample[] = [];
    private readonly idle = new Map<string, number[]>();
    private readonly losses: string[] = [];
    private logCursor: number;
    private lastGuardState: string | undefined;

    private costCursor = 0;
    private cursorKeys = new Set<string>();
    private lastBySource: Record<string, number> | undefined;
    private costTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly packs: PackStore;
    private packTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly listeners = new Set<() => void>();
    private subs: {
        lore?: { api: LoreJournalApi; off: Unsubscribe };
        inspector?: { api: InspectorApi; off: Unsubscribe };
    } = {};
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly settings: MetricsSettings,
        private readonly log: Logger,
        deps: MetricsDeps = {},
    ) {
        this.clock = deps.clock ?? nowMs;
        this.now = deps.now ?? Date.now;
        this.deviceFn = deps.device ?? readDevice;
        this.readBook = deps.readBook ?? ((name) => readBookText(app, name));
        this.logLines = deps.logLines ?? (() => ConsoleLogger.recent());
        this.tab = deps.tabId ?? currentTabId();
        this.saveDelay = deps.saveDelayMs ?? 3000;
        this.packDelay = deps.packDelayMs ?? 20_000;
        this.defer = deps.defer ?? ((run) => void setTimeout(run, 0));
        this.packs = new PackStore(app, { readBook: this.readBook, now: this.now });
        // Lines logged before this module started belong to an earlier session of it (re-enable).
        this.logCursor = this.now();
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe) => void): void {
        const { app } = this;
        this.currentChat = app.host.chatId();
        this.group = app.host.isGroupChat();
        const started = app.host.events.name('GENERATION_STARTED');
        if (started) {
            own(app.host.events.on(started, (_type, _options, dryRun) => this.onStarted(dryRun), { order: 'first' }));
        }
        own(app.bus.on('generation:before', (info) => this.onBefore(info)));
        own(app.turn.onIntercept((chat, info) => this.onIntercept(chat, info)));
        own(app.host.fetchGate.beforeRequest(GENERATE_RE, () => this.onRequest()));
        // After the response: a save the guard vetoed never gets here (the gate returns the veto first).
        own(app.host.fetchGate.afterResponse(SAVE_RE, () => this.onSaved()));
        own(app.bus.on('generation:ended', () => this.onEnded()));
        own(app.bus.on('chat:changed', ({ chatId }) => this.onChatChanged(chatId)));
        if (typeof app.cost?.onChange === 'function') own(app.cost.onChange(() => this.scheduleCostIngest()));
        this.subscribe();
        if (this.packDelay >= 0) {
            this.packTimer = setTimeout(() => {
                this.packTimer = null;
                void this.capturePacks().catch((error: unknown) => this.log.debug('pack fingerprints', error));
            }, this.packDelay);
        }
        own(() => this.dispose());
        if (this.currentChat) void this.ensureView(this.currentChat);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.subs.lore?.off();
        this.subs.inspector?.off();
        this.subs = {};
        if (this.packTimer) clearTimeout(this.packTimer);
        if (this.costTimer) clearTimeout(this.costTimer);
        for (const timer of this.saveTimers.values()) clearTimeout(timer);
        this.saveTimers.clear();
        this.flight = null;
        for (const chatId of new Set([...this.open.keys(), ...this.sealed.keys()])) void this.save(chatId);
        this.listeners.clear();
    }

    /** Resolves when pending writes are done (tests, export). */
    async flush(): Promise<void> {
        for (const chatId of new Set([...this.open.keys(), ...this.sealed.keys()])) await this.save(chatId);
        await this.saving;
    }

    /* ---------------------------------------------------------------- send path (P15: clock reads only) */

    private onStarted(dryRun: unknown): void {
        if (dryRun === true) return;
        this.startedAt = this.clock();
    }

    private onBefore(info: GenerationInfo): void {
        if (info.quiet || info.dryRun) return;
        const chatId = this.currentChat;
        if (!chatId || this.group) return;
        const t0 = this.clock();
        const started =
            this.startedAt !== undefined && t0 - this.startedAt <= WINDOW_START_MAX_MS ? this.startedAt : undefined;
        this.startedAt = undefined;
        this.flight = {
            id: `${this.tab}:${++this.sampleSeq}`,
            chatId,
            type: info.type,
            auto: this.autoNext,
            t0,
            started,
            armedAt: this.now(),
            modules: {},
        };
        this.autoNext = false;
    }

    private onIntercept(chat: STChatMessage[], info: GenerationInfo): void {
        const flight = this.flight;
        if (!flight || info.quiet || info.dryRun || flight.t1 !== undefined) return;
        flight.intercepted = this.clock();
        flight.chat = chat;
    }

    private onRequest(): void {
        const flight = this.flight;
        if (!flight || flight.t1 !== undefined) return;
        this.flight = null;
        flight.t1 = this.clock();
        flight.at = this.now();
        if (flight.at - flight.armedAt > ARM_TTL_MS) return;
        this.defer(() => this.finish(flight));
    }

    /* ---------------------------------------------------------------- after the request left */

    private finish(flight: InFlight): void {
        if (this.disposed || flight.t1 === undefined || flight.at === undefined) return;
        const moduleTotal = Object.values(flight.modules).reduce((sum, ms) => sum + ms, 0);
        let start = flight.t0;
        let intercept = flight.intercepted !== undefined ? flight.intercepted - flight.t0 : 0;
        // The pipeline's own timing, when it reports one for this generation, starts earlier (producers included).
        const timing = interceptTiming(this.app);
        const earliest = flight.started ?? flight.t0 - WINDOW_START_MAX_MS;
        let whole: number | undefined;
        if (timing && timing.startedAt <= flight.t0 && timing.startedAt >= earliest && timing.endedAt <= flight.t1) {
            start = timing.startedAt;
            whole = timing.endedAt - timing.startedAt;
            intercept = whole;
        }
        const sample: TurnPatch = {
            id: flight.id,
            at: flight.at,
            type: flight.type,
            device: this.deviceFn(),
            sendMs: round2(flight.t1 - start),
            maestroMs: round2(intercept + moduleTotal),
        };
        if (whole !== undefined) sample.interceptMs = round2(whole);
        if (flight.started !== undefined) sample.windowMs = round2(flight.t1 - flight.started);
        const modules = Object.entries(flight.modules).slice(0, DOC_LIMITS.modules);
        if (modules.length) sample.modules = Object.fromEntries(modules.map(([label, ms]) => [label, round2(ms)]));
        if (flight.auto) sample.auto = true;
        try {
            const mode = this.app.settings.core().mode;
            if (typeof mode === 'string') sample.mode = mode;
        } catch {
            // settings unavailable (tests)
        }
        try {
            const dropped = droppedInPrompt(this.app, flight.chat);
            if (dropped !== undefined) sample.dropped = dropped;
        } catch (error) {
            this.log.debug('qvink check failed', error);
        }
        flight.chat = undefined;
        this.patch(flight.chatId, sample);
        if (flight.auto) this.countFor(flight.chatId, METRIC_COUNTERS.autoSwipes, 1);
        this.recent.push({ id: flight.id, chatId: flight.chatId, at: flight.at });
        if (this.recent.length > RECENT_LIMIT) this.recent.splice(0, this.recent.length - RECENT_LIMIT);
        this.changed();
    }

    private onEnded(): void {
        if (this.flight && this.flight.t1 === undefined) this.flight = null;
        this.defer(() => {
            if (this.disposed) return;
            this.subscribe();
            this.scanLogs();
            this.pollGuardian();
        });
    }

    private onSaved(): void {
        if (guardianState(this.app) === 'stale') this.count(METRIC_COUNTERS.staleSaves);
    }

    private onChatChanged(chatId: string | null): void {
        const previous = this.currentChat;
        this.currentChat = chatId;
        this.group = this.app.host.isGroupChat();
        this.flight = null;
        this.startedAt = undefined;
        if (previous && previous !== chatId) void this.save(previous);
        this.subscribe();
        this.changed();
        if (chatId) void this.ensureView(chatId).then(() => this.changed());
    }

    /* ---------------------------------------------------------------- lore and prompt of the turn */

    private subscribe(): void {
        if (this.disposed) return;
        const lore = this.app.modules.api<LoreJournalApi>('loreJournal');
        if (lore !== this.subs.lore?.api) {
            this.subs.lore?.off();
            this.subs.lore = lore ? { api: lore, off: lore.onTurn((record) => this.onLore(record)) } : undefined;
        }
        const inspector = this.app.modules.api<InspectorApi>('inspector');
        if (inspector !== this.subs.inspector?.api) {
            this.subs.inspector?.off();
            this.subs.inspector = inspector
                ? { api: inspector, off: inspector.onTurn((record) => this.onInspector(record)) }
                : undefined;
        }
    }

    /** The newest sample of the chat that started before `at`, if it still lacks what `missing` checks. */
    private sampleFor(chatId: string, at: number, missing: (sample: RecentSample) => boolean): RecentSample | null {
        for (let i = this.recent.length - 1; i >= 0; i--) {
            const sample = this.recent[i]!;
            if (sample.chatId !== chatId || sample.at > at) continue;
            return missing(sample) ? sample : null;
        }
        return null;
    }

    private onLore(record: TurnLoreRecord): void {
        const chatId = this.currentChat;
        if (!chatId || record.simulated || record.messageIndex < 0 || record.generationType === 'quiet') return;
        const sample = this.sampleFor(chatId, record.at, (item) => !item.lore);
        if (!sample) return;
        sample.lore = true;
        sample.messageIndex = record.messageIndex;
        this.patch(chatId, {
            id: sample.id,
            messageIndex: record.messageIndex,
            loreChars: record.totalChars,
            loreEntries: loreEntries(record.activations),
            assistantDepth: assistantAtDepth(record.activations),
            loreRules: activeLoreRules(this.app).length,
        });
        this.changed();
    }

    private onInspector(record: InspectorRecord): void {
        const chatId = this.currentChat;
        if (!chatId) return;
        const sample = this.sampleFor(
            chatId,
            record.at,
            (item) => !item.inspector && (item.messageIndex === undefined || item.messageIndex === record.messageIndex),
        );
        if (!sample) return;
        sample.inspector = true;
        const loreTokens = record.sources
            .filter((source) => source.kind === 'lore')
            .reduce((sum, source) => sum + (Number.isFinite(source.tokens) ? source.tokens : 0), 0);
        this.patch(chatId, {
            id: sample.id,
            messageIndex: record.messageIndex,
            promptTokens: record.totalTokens,
            loreTokens,
        });
        this.changed();
    }

    /* ---------------------------------------------------------------- costs */

    private scheduleCostIngest(): void {
        if (this.costTimer || this.disposed) return;
        this.costTimer = setTimeout(() => {
            this.costTimer = null;
            this.ingestCosts();
        }, COST_INGEST_DELAY_MS);
    }

    /** New entries of today's cost meter, each into the document of the chat it belongs to. */
    ingestCosts(): void {
        if (this.disposed) return;
        const rows = recentCosts(this.app);
        if (!rows) {
            this.ingestSummary();
            return;
        }
        let touched = false;
        for (const row of [...rows].sort((a, b) => a.at - b.at)) {
            if (row.at < this.costCursor) continue;
            const key = costKey(row);
            if (row.at === this.costCursor) {
                if (this.cursorKeys.has(key)) continue;
                this.cursorKeys.add(key);
            } else {
                this.costCursor = row.at;
                this.cursorKeys = new Set([key]);
            }
            const chatId = typeof row.chatId === 'string' && row.chatId ? row.chatId : null;
            const sample = chatId ? toCostSample(row) : null;
            if (!chatId || !sample) continue;
            this.openBatch(chatId).batch.costs.push(sample);
            this.scheduleSave(chatId);
            touched = true;
        }
        if (touched) this.changed();
    }

    /** Fallback without per-entry access: today's totals by source, the growth since the last look. */
    private ingestSummary(): void {
        let bySource: Record<string, number>;
        try {
            bySource = { ...this.app.cost.summary().todayBySource };
        } catch {
            return;
        }
        const previous = this.lastBySource;
        this.lastBySource = bySource;
        const chatId = this.currentChat;
        if (!previous || !chatId) return;
        const at = this.now();
        const samples: CostSample[] = [];
        for (const [source, usd] of Object.entries(bySource)) {
            const delta = usd - (previous[source] ?? 0);
            if (delta > 1e-12) samples.push({ at, source, usd: delta });
        }
        if (!samples.length) return;
        this.openBatch(chatId).batch.costs.push(...samples);
        this.scheduleSave(chatId);
        this.changed();
    }

    /* ---------------------------------------------------------------- counters, logs, guardian */

    private scanLogs(): void {
        let lines: readonly LogLine[];
        try {
            lines = this.logLines();
        } catch {
            return;
        }
        const fresh = dataLossLines(lines, this.logCursor).filter((line) => !/metrics$/i.test(line.scope));
        const newest = lines.reduce((max, line) => Math.max(max, line.at), this.logCursor);
        this.logCursor = newest;
        if (!fresh.length) return;
        for (const line of fresh) this.losses.push(`${line.scope}: ${line.text}`);
        if (this.losses.length > LOSS_SAMPLES) this.losses.splice(0, this.losses.length - LOSS_SAMPLES);
        this.count(METRIC_COUNTERS.dataLosses, fresh.length);
    }

    private pollGuardian(): void {
        const state = guardianState(this.app);
        if (state === 'stale' && this.lastGuardState !== 'stale') this.count(METRIC_COUNTERS.staleEpisodes);
        this.lastGuardState = state;
    }

    /* ---------------------------------------------------------------- document */

    private nextSeq(): number {
        this.lastSeq = Math.max(this.now(), this.lastSeq + 1);
        return this.lastSeq;
    }

    private openBatch(chatId: string): OpenBatch {
        let open = this.open.get(chatId);
        if (!open) {
            open = { batch: emptyBatch(this.tab, this.nextSeq()), turns: new Map() };
            this.open.set(chatId, open);
        }
        return open;
    }

    private patch(chatId: string, patch: TurnPatch): void {
        const open = this.openBatch(chatId);
        open.turns.set(patch.id, { ...(open.turns.get(patch.id) ?? {}), ...patch });
        this.scheduleSave(chatId);
    }

    private countFor(chatId: string, counter: string, delta: number): void {
        if (!Number.isFinite(delta) || delta === 0) return;
        const counters = this.openBatch(chatId).batch.counters;
        counters[counter] = (counters[counter] ?? 0) + delta;
        this.scheduleSave(chatId);
    }

    private scheduleSave(chatId: string, delay = this.saveDelay): void {
        this.cached = null;
        if (this.saveTimers.has(chatId) || this.disposed) return;
        this.saveTimers.set(
            chatId,
            setTimeout(() => {
                this.saveTimers.delete(chatId);
                void this.save(chatId);
            }, delay),
        );
    }

    /** Seals the open batch and writes every batch of the chat (one write at a time). */
    save(chatId: string): Promise<void> {
        const timer = this.saveTimers.get(chatId);
        if (timer) {
            clearTimeout(timer);
            this.saveTimers.delete(chatId);
        }
        const open = this.open.get(chatId);
        if (open) {
            this.open.delete(chatId);
            open.batch.turns = [...open.turns.values()];
            if (!batchIsEmpty(open.batch)) this.sealed.set(chatId, [...(this.sealed.get(chatId) ?? []), open.batch]);
        }
        this.saving = this.saving
            .then(() => this.write(chatId))
            .catch((error: unknown) => {
                this.log.debug('metrics write failed', error);
            });
        return this.saving;
    }

    private async write(chatId: string): Promise<void> {
        const batches = this.sealed.get(chatId);
        if (!batches?.length) return;
        for (let attempt = 0; attempt < 2; attempt++) {
            const raw = await this.app.chat.getFor<Record<string, unknown>>(
                chatId,
                METRICS_DOC_KIND,
                () => emptyMetricsDoc(this.now()) as unknown as Record<string, unknown>,
            );
            const doc = normalizeMetricsDoc(raw, this.now());
            for (const batch of batches) applyBatch(doc, batch);
            freezeDocBaseline(doc, this.settings.baselineTurns, this.now());
            if (await this.app.chat.put(METRICS_DOC_KIND, doc)) {
                // Batches added while this write ran stay queued.
                const left = (this.sealed.get(chatId) ?? []).filter((batch) => !batches.includes(batch));
                if (left.length) this.sealed.set(chatId, left);
                else this.sealed.delete(chatId);
                this.views.set(chatId, copyMetricsDoc(doc));
                this.changed();
                return;
            }
        }
        // Another tab keeps writing: try again later (the batches stay queued; they are applied once).
        this.log.info('metrics: another tab wrote the document; retrying later');
        if (!this.disposed) this.scheduleSave(chatId, this.saveDelay * RETRY_FACTOR);
    }

    private ensureView(chatId: string): Promise<void> {
        if (this.views.has(chatId)) return Promise.resolve();
        let pending = this.loading.get(chatId);
        if (!pending) {
            pending = (async () => {
                const raw = await this.app.chat.getFor<Record<string, unknown>>(
                    chatId,
                    METRICS_DOC_KIND,
                    () => emptyMetricsDoc(this.now()) as unknown as Record<string, unknown>,
                );
                if (!this.views.has(chatId)) {
                    this.views.set(chatId, copyMetricsDoc(normalizeMetricsDoc(raw, this.now())));
                    this.cached = null;
                }
            })()
                .catch((error: unknown) => this.log.debug('could not load metrics', error))
                .finally(() => this.loading.delete(chatId));
            this.loading.set(chatId, pending);
        }
        return pending;
    }

    /** The current chat's document with everything not written yet (a copy; memoised until the next change). */
    current(): MetricsDoc {
        const chatId = this.currentChat;
        if (this.cached && this.cached.chatId === chatId) return this.cached.doc;
        const base = chatId ? this.views.get(chatId) : undefined;
        const doc = base ? copyMetricsDoc(base) : emptyMetricsDoc(this.now());
        if (chatId) {
            for (const batch of this.sealed.get(chatId) ?? []) applyBatch(doc, batch);
            const open = this.open.get(chatId);
            if (open) applyBatch(doc, { ...open.batch, seq: Number.MAX_SAFE_INTEGER, turns: [...open.turns.values()] });
            freezeDocBaseline(doc, this.settings.baselineTurns, this.now());
        }
        this.cached = { chatId, doc };
        return doc;
    }

    private changed(): void {
        this.cached = null;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.warn('metrics listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- BunnyMo pack fingerprints */

    /** Fingerprints BunnyMo books seen for the first time (also runs once after start). */
    capturePacks(): Promise<number> {
        return this.disposed ? Promise.resolve(0) : this.packs.capture();
    }

    async checkPacks(): Promise<PackComparison | null> {
        const comparison = await this.packs.check();
        this.changed();
        return comparison;
    }

    async acceptPacks(): Promise<void> {
        await this.packs.accept();
        this.changed();
    }

    /* ---------------------------------------------------------------- MetricsApi */

    time<T>(label: string, fn: () => T): T {
        const start = this.clock();
        let result: T;
        try {
            result = fn();
        } catch (error) {
            this.record(label, this.clock() - start);
            throw error;
        }
        if (result && typeof (result as { then?: unknown }).then === 'function') {
            return (result as unknown as Promise<unknown>).then(
                (value) => {
                    this.record(label, this.clock() - start);
                    return value;
                },
                (error: unknown) => {
                    this.record(label, this.clock() - start);
                    throw error;
                },
            ) as T;
        }
        this.record(label, this.clock() - start);
        return result;
    }

    record(label: string, ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) return;
        const key = String(label).replace(LABEL_RE, '_').slice(0, 48) || 'unnamed';
        const flight = this.flight;
        if (flight && flight.t1 === undefined) {
            flight.modules[key] = (flight.modules[key] ?? 0) + ms;
            return;
        }
        let list = this.idle.get(key);
        if (!list) this.idle.set(key, (list = []));
        list.push(ms);
        if (list.length > IDLE_LIMIT) list.splice(0, list.length - IDLE_LIMIT);
    }

    count(counter: string, delta = 1): void {
        const chatId = this.currentChat;
        if (!chatId || typeof counter !== 'string' || !counter) return;
        this.countFor(chatId, counter, delta);
        this.changed();
    }

    noteAutoSwipe(): void {
        this.autoNext = true;
    }

    device(): DeviceClass {
        return this.deviceFn();
    }

    /** Turns the lore baseline is frozen from. */
    baselineSize(): number {
        return this.settings.baselineTurns;
    }

    latency(): LatencySummary {
        return summarizeLatency(this.current().turns);
    }

    costShare(): CostShare {
        const doc = this.current();
        return costShare(
            doc.costs,
            doc.turns.map((turn) => ({ at: turn.at, auto: turn.auto })),
            this.settings.windowTurns,
        );
    }

    lore(): LoreState {
        const doc = this.current();
        const from = doc.baseline ? doc.baseline.to + 1 : (doc.baselineFrom ?? 0);
        const current = averageLore(
            doc.turns.filter((turn) => turn.at >= from),
            this.settings.windowTurns,
        );
        const state: LoreState = {
            current,
            ratio: loreRatio({ whatIf: doc.whatIf, baseline: doc.baseline, current }),
        };
        if (doc.baseline) state.baseline = doc.baseline;
        if (doc.whatIf) state.whatIf = doc.whatIf;
        return state;
    }

    async compareLore(): Promise<LoreWhatIf | null> {
        const rules = this.app.modules.api<RulesApi>('rules');
        const chatId = this.currentChat;
        if (!rules || !chatId) return null;
        const ruleIds = activeLoreRules(this.app);
        const impact = await rules.compare(ruleIds);
        const whatIf: LoreWhatIf = {
            at: this.now(),
            before: impact.before.totalChars,
            after: impact.after.totalChars,
            ruleIds,
            removed: impact.removed.length,
        };
        this.openBatch(chatId).batch.whatIf = whatIf;
        this.scheduleSave(chatId);
        this.changed();
        return whatIf;
    }

    async resetBaseline(): Promise<void> {
        const chatId = this.currentChat;
        if (!chatId) return;
        const batch = this.openBatch(chatId).batch;
        batch.baseline = null;
        batch.baselineFrom = this.now();
        this.changed();
        await this.save(chatId);
    }

    /** Everything the tab and the export show; refreshes logs, guardian state and costs first. */
    async snapshot(): Promise<MetricsSnapshot> {
        this.scanLogs();
        this.pollGuardian();
        this.ingestCosts();
        const chatId = this.currentChat;
        if (chatId) await this.ensureView(chatId);
        const doc = this.current();
        const latency = summarizeLatency(doc.turns);
        const cost = this.costShare();
        const lore = this.lore();
        const counters = { ...doc.counters };
        const revisionOwn = revisionStats(this.app);
        const revision: RevisionShare = revisionOwn
            ? {
                  ...revisionOwn,
                  share: revisionOwn.decisions > 0 ? revisionOwn.acceptedAsIs / revisionOwn.decisions : undefined,
              }
            : revisionShare(autonomyCounts(this.app), this.settings.revisionKinds);
        const views = sheetViews(this.app);
        const input: CriteriaInput = {
            latency,
            cost,
            lore: {
                ratio: lore.ratio,
                current: lore.current,
                ...(lore.baseline ? { baseline: lore.baseline } : {}),
                ...(lore.whatIf ? { whatIf: lore.whatIf } : {}),
            },
            dropped: turnCounts(doc.turns.map((turn) => turn.dropped)),
            assistantDepth: turnCounts(doc.turns.map((turn) => turn.assistantDepth)),
            tabs: {
                observedTurns: doc.turns.length,
                staleSaves: counters[METRIC_COUNTERS.staleSaves] ?? 0,
                blocked: guardianBlocked(this.app),
                staleEpisodes: counters[METRIC_COUNTERS.staleEpisodes] ?? 0,
                dataLosses: counters[METRIC_COUNTERS.dataLosses] ?? 0,
            },
            revision,
            undo: undoShare(journalRecords(this.app)),
            living: livingCounts(this.app, counters),
            sheets: views.sheets.length ? sheetSummary(views.sheets, views.lastUserIndex, views.tagsShown) : null,
            packs: this.packs.lastCheck()?.comparison ?? null,
        };
        const idle: Record<string, Distribution> = {};
        for (const [label, list] of [...this.idle].sort((a, b) => a[0].localeCompare(b[0]))) {
            idle[label] = distribution(list);
        }
        const report: CriteriaReport = {
            generatedAt: this.now(),
            turns: doc.turns.length,
            startedAt: doc.startedAt,
            device: this.deviceFn(),
            rows: buildCriteria(input),
        };
        const snapshot: MetricsSnapshot = {
            report,
            input,
            latency,
            cost,
            lore,
            idle,
            losses: [...this.losses],
            counters,
            chatId,
        };
        const packCheck = this.packs.lastCheck();
        if (packCheck) snapshot.packsCheckedAt = packCheck.at;
        return snapshot;
    }

    async criteria(): Promise<CriteriaReport> {
        return (await this.snapshot()).report;
    }

    async exportReport(format: 'json' | 'markdown'): Promise<string> {
        const snapshot = await this.snapshot();
        return format === 'json' ? renderJson(snapshot, this.app.i18n) : renderMarkdown(snapshot, this.app.i18n);
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}
