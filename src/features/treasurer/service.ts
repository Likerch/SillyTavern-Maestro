// M21 «Казначей» service: attributes the core cost meter's entries to turns, adds NAI Studio Anlas the core does not
// see, keeps the per-chat turn document ('treasurer'), answers summaries for a turn, the session and days, and
// handles the overall daily limit (warn / «Экономный» until tomorrow / stop background — never the main chat).
//
// Send path (P15): generation:before only reads the clock and queues the event; everything else runs on reply:ready,
// generation:ended, cost meter changes (coalesced) and NAI Studio's imageReady.
import { costFileName } from '../../core/cost';
import { TurnLedger } from '../../domain/treasurer-ledger';
import type { Assignment, Classified } from '../../domain/treasurer-ledger';
import { isReply, lastReply, naiRecords, newAnlas, turnOfMessage } from '../../domain/treasurer-anlas';
import type { AnlasTrigger } from '../../domain/treasurer-anlas';
import {
    REDO_TYPES,
    addAutoDay,
    addToLines,
    applyOp,
    dayKey,
    daySummary,
    emptyDoc,
    lastDays,
    mergeAutoDays,
    readAutoDays,
    readDay,
    sanitizeDoc,
    summaryOf,
    toSpendLines,
    turnList,
} from '../../domain/treasurer-spend';
import type {
    AutoDay,
    AutoDaysDoc,
    DayData,
    DocOp,
    LedgerEntry,
    LineMap,
    TreasurerDoc,
} from '../../domain/treasurer-spend';
import type { NaiImageReadyDetail } from '../../adapters/nai';
import type { App, CoreSettings, GenerationInfo, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import { formatUsd, tOr } from '../../ui/views/format';
import type { QualityApi, QualityVerdict } from '../quality/api';
import type { SpendSummary, TreasurerApi, TurnSpend } from './api';

export const TREASURER_KEY = 'treasurer';
export const TREASURER_ID = 'M21';
/** app.chat document kind of the per-turn spend. */
export const TREASURER_DOC_KIND = 'treasurer';
/** File kind of the auto-swipe share per day (`maestro-treasurer-days.json`). */
export const AUTO_DAYS_FILE_KIND = 'treasurer-days';
/** Journal target of the «Экономный» switch on the daily limit (undo puts the previous mode back). */
export const MODE_TARGET = 'treasurer.mode';
export const ECONOMY_KIND = 'treasurer.economy';

export interface TreasurerSettings {
    /** Turns in the pult table. */
    tableTurns: number;
    /** Days in the pult chart. */
    chartDays: number;
    /** Date (YYYY-MM-DD) the overall daily limit was handled on: one notice and one switch per day. */
    limitDate: string;
    /** Mode the daily limit switched away from; put back the next day ('' = nothing to restore). */
    modeBeforeLimit: '' | CoreSettings['mode'];
}

export function defaultTreasurerSettings(): TreasurerSettings {
    return { tableTurns: 30, chartDays: 14, limitDate: '', modeBeforeLimit: '' };
}

export interface TreasurerDeps {
    /** Wall clock (tests). */
    now?: () => number;
    /** Coalescing of cost meter changes (default 300 ms). */
    ingestDelayMs?: number;
    /** Debounce of the per-chat document (default 2 s). */
    saveDelayMs?: number;
    /** Debounce of the auto-swipe day notes (default 5 s). */
    daysSaveDelayMs?: number;
    /** How long an ended generation waits for its reply (default 1.5 s). */
    graceMs?: number;
    /** How long an auto-swipe note waits for its generation (default 2 min). */
    autoTtlMs?: number;
}

/** Messages examined for new inline pictures after each reply when NAI Studio sends no events. */
const SWEEP_MESSAGES = 6;

type MeterExtras = Partial<{
    today(): unknown;
    recent(): readonly unknown[];
    dailyLimitReached(): boolean;
}>;

type NaiLike = Partial<{
    api(): unknown;
    on(event: 'imageReady', listener: (detail: NaiImageReadyDetail) => void): () => void;
}>;

interface ChatState {
    chatId: string;
    doc: TreasurerDoc | null;
    /** Changes not saved yet (replayed over a newer copy written by another tab). */
    unsaved: DocOp[];
    counted: Set<string>;
    /** NAI records present when the chat was opened or a message rendered (the core's, or history). */
    baseline: Set<string>;
    /** Looks at messages that wait for the document (the counted keys must be known first). */
    waiting: { index: number; trigger: AnlasTrigger }[];
    saveTimer: ReturnType<typeof setTimeout> | null;
    saving: Promise<void>;
}

type QueuedEvent =
    | { kind: 'begin'; type: string; auto: boolean; at: number }
    | { kind: 'reply'; turn: number; at: number }
    | { kind: 'end'; at: number };

function isDict(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toLedgerEntry(raw: unknown): LedgerEntry | null {
    if (!isDict(raw) || typeof raw['at'] !== 'number' || typeof raw['source'] !== 'string') return null;
    if (typeof raw['usd'] !== 'number') return null;
    return raw as unknown as LedgerEntry;
}

export class TreasurerService implements TreasurerApi {
    private readonly now: () => number;
    private readonly ingestDelay: number;
    private readonly saveDelay: number;
    private readonly daysSaveDelay: number;
    private readonly autoTtl: number;
    private readonly graceMs: number;
    private readonly ledger: TurnLedger;
    private readonly startedAt: number;

    private state: ChatState | null = null;
    private readonly events: QueuedEvent[] = [];
    private autoArm: { at: number; via: 'hook' | 'verdict'; messageIndex?: number } | null = null;

    private sessionFrom: number;
    private sessionLines: LineMap = {};

    private autoDays: AutoDaysDoc = { version: 1, days: {} };
    private autoDelta: Record<string, AutoDay> = {};
    private autoLoaded: Promise<void> = Promise.resolve();
    private autoTimer: ReturnType<typeof setTimeout> | null = null;
    private autoChain: Promise<void> = Promise.resolve();

    private readonly dayCache = new Map<string, Promise<DayData | null>>();
    private dayCacheFor = '';

    private ingestTimer: ReturnType<typeof setTimeout> | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private scanTimer: ReturnType<typeof setTimeout> | null = null;
    private links: {
        quality?: { api: unknown; off: Unsubscribe };
        nai?: { api: unknown; off: () => void };
    } = {};
    private readonly listeners = new Set<() => void>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly settings: TreasurerSettings,
        private readonly log: Logger,
        deps: TreasurerDeps = {},
    ) {
        this.now = deps.now ?? Date.now;
        this.ingestDelay = deps.ingestDelayMs ?? 300;
        this.saveDelay = deps.saveDelayMs ?? 2000;
        this.daysSaveDelay = deps.daysSaveDelayMs ?? 5000;
        this.autoTtl = deps.autoTtlMs ?? 120_000;
        this.graceMs = deps.graceMs ?? 1500;
        this.startedAt = this.now();
        this.sessionFrom = this.startedAt;
        this.ledger = new TurnLedger({
            chatId: this.safeChatId(),
            turn: this.lastReplyIndex(),
            since: this.startedAt,
            graceMs: this.graceMs,
        });
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe) => void): void {
        const { app } = this;
        own(app.bus.on('generation:before', (info) => this.onBefore(info)));
        own(app.bus.on('reply:ready', ({ messageIndex }) => this.onReply(messageIndex)));
        own(app.bus.on('generation:ended', () => this.onEnded()));
        own(app.bus.on('chat:changed', ({ chatId }) => this.onChatChanged(chatId)));
        if (typeof app.cost?.onChange === 'function') own(app.cost.onChange(() => this.scheduleProcess()));
        if (typeof app.cost?.onLimitReached === 'function') {
            own(app.cost.onLimitReached((info) => this.onLimit(info)));
        }
        try {
            app.journal.registerUndo(MODE_TARGET, (change) => this.undoMode(change));
        } catch (error) {
            this.log.debug('journal undo for the mode switch not registered', error);
        }
        own(() => this.dispose());
        this.link();
        const chatId = this.safeChatId();
        if (chatId) this.open(chatId);
        this.autoLoaded = this.loadAutoDays();
        this.restoreMode();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const timer of [this.ingestTimer, this.settleTimer, this.scanTimer]) if (timer) clearTimeout(timer);
        this.ingestTimer = this.settleTimer = this.scanTimer = null;
        this.links.quality?.off();
        this.links.nai?.off();
        this.links = {};
        if (this.state) void this.saveNow(this.state);
        void this.flushAutoDays();
        this.listeners.clear();
    }

    /** Resolves when pending writes are done (tests). */
    async flush(): Promise<void> {
        this.process();
        if (this.state) await this.saveNow(this.state);
        await this.flushAutoDays();
    }

    /* ---------------------------------------------------------------- TreasurerApi */

    summary(period: 'turn' | 'session' | 'day'): SpendSummary {
        const now = this.now();
        if (period === 'session') return summaryOf('session', this.sessionFrom, now, toSpendLines(this.sessionLines));
        if (period === 'turn') {
            const turns = this.state?.doc?.turns ?? [];
            const last = turns[turns.length - 1];
            if (!last) return summaryOf('turn', now, now, []);
            return summaryOf('turn', last.at, last.last, toSpendLines(last.lines));
        }
        const date = dayKey(now);
        return daySummary(this.liveDay(date), date, this.autoDayOf(date));
    }

    turns(limit?: number): TurnSpend[] {
        const doc = this.state?.doc;
        if (!doc) return [];
        return turnList(doc, limit ?? this.settings.tableTurns ?? 30);
    }

    async days(limit?: number): Promise<SpendSummary[]> {
        const count = Math.min(60, Math.max(1, Math.floor(limit ?? this.settings.chartDays ?? 14)));
        const now = this.now();
        const today = dayKey(now);
        if (this.dayCacheFor !== today) {
            this.dayCache.clear();
            this.dayCacheFor = today;
        }
        await this.autoLoaded;
        return Promise.all(
            lastDays(now, count).map(async (date) => {
                if (date === today) return daySummary(this.liveDay(date), date, this.autoDayOf(date));
                return daySummary(await this.storedDay(date), date, this.autoDayOf(date));
            }),
        );
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    noteAutoSwipe(): void {
        this.autoArm = { at: this.now(), via: 'hook' };
    }

    /** Session start (pult). */
    sessionStart(): number {
        return this.sessionFrom;
    }

    /** Overall daily limit enabled and reached (CostMeterImpl.dailyLimitReached, duck-typed). */
    limitReached(): boolean {
        try {
            return (this.app.cost as MeterExtras).dailyLimitReached?.() === true;
        } catch {
            return false;
        }
    }

    /* ---------------------------------------------------------------- bus events */

    /** Send path: a clock read and a queued record, nothing else (P15). */
    private onBefore(info: GenerationInfo): void {
        if (info.dryRun || info.quiet) return;
        const at = this.now();
        const arm = this.autoArm;
        this.autoArm = null;
        const auto = arm !== null && REDO_TYPES.has(info.type) && at - arm.at <= this.autoTtl;
        this.events.push({ kind: 'begin', type: info.type, auto, at });
    }

    private onReply(messageIndex: number): void {
        if (this.disposed) return;
        const at = this.now();
        const message = this.chat()[messageIndex];
        if (isReply(message)) this.events.push({ kind: 'reply', turn: messageIndex, at });
        // Hints first: the core has just counted the pictures of this message in its own reply:ready listener.
        this.examine(messageIndex, 'reply');
        this.sweep(messageIndex);
        this.process();
        this.link();
    }

    private onEnded(): void {
        if (this.disposed) return;
        this.events.push({ kind: 'end', at: this.now() });
        this.process();
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            this.process();
        }, this.graceMs + 100);
        this.link();
        this.restoreMode();
    }

    private onChatChanged(chatId: string | null): void {
        if (this.disposed) return;
        this.process();
        const previous = this.state;
        const leftovers = this.ledger.reset(chatId, this.lastReplyIndex(), this.now());
        if (previous) {
            for (const item of leftovers) this.assign(previous, item);
            void this.saveNow(previous);
        }
        this.state = null;
        this.sessionFrom = this.now();
        this.sessionLines = {};
        this.autoArm = null;
        if (chatId) this.open(chatId);
        this.link();
        this.changed();
    }

    private onImage(detail: NaiImageReadyDetail): void {
        if (this.disposed || !isDict(detail) || typeof detail.messageIndex !== 'number') return;
        const kinds: AnlasTrigger[] = ['message', 'swipe', 'tool', 'inline', 'marker'];
        const trigger = kinds.includes(detail.kind as AnlasTrigger) ? (detail.kind as AnlasTrigger) : 'inline';
        this.examine(detail.messageIndex, trigger);
        this.process();
    }

    private onVerdict(verdict: QualityVerdict): void {
        if (verdict.action === 'swiped') {
            this.autoArm = { at: this.now(), via: 'verdict', messageIndex: verdict.messageIndex };
        } else if (this.autoArm?.via === 'verdict' && this.autoArm.messageIndex === verdict.messageIndex) {
            // The swipe did not happen (refused, queued in the Inbox, ST busy): a later swipe is the user's.
            this.autoArm = null;
        }
    }

    /** M12's verdicts and NAI Studio's events; modules and NAI Studio may appear after this one starts. */
    private link(): void {
        if (this.disposed) return;
        try {
            const quality = this.app.modules.api<QualityApi>('quality');
            if (quality !== this.links.quality?.api) {
                this.links.quality?.off();
                this.links.quality =
                    quality && typeof quality.onVerdict === 'function'
                        ? { api: quality, off: quality.onVerdict((verdict) => this.onVerdict(verdict)) }
                        : undefined;
            }
        } catch (error) {
            this.log.debug('quality verdicts unavailable', error);
        }
        try {
            const nai = this.app.adapters?.nai as NaiLike | undefined;
            const api = typeof nai?.api === 'function' ? nai.api() : undefined;
            if (api !== this.links.nai?.api) {
                this.links.nai?.off();
                this.links.nai =
                    api && typeof nai?.on === 'function'
                        ? { api, off: nai.on('imageReady', (detail) => this.onImage(detail)) }
                        : undefined;
            }
        } catch (error) {
            this.log.debug('NAI Studio events unavailable', error);
        }
    }

    /* ---------------------------------------------------------------- attribution */

    private scheduleProcess(): void {
        if (this.ingestTimer || this.disposed) return;
        this.ingestTimer = setTimeout(() => {
            this.ingestTimer = null;
            this.process();
        }, this.ingestDelay);
    }

    /** Drains queued events into the ledger, then takes the meter's new entries. */
    process(): void {
        if (this.disposed) return;
        for (const event of this.events.splice(0)) {
            if (event.kind === 'begin') this.ledger.begin(event.type, event.auto, event.at);
            else if (event.kind === 'reply') this.ledger.reply(event.turn, event.at);
            else this.ledger.end(event.at);
        }
        const now = this.now();
        this.ledger.settle(now);
        const { fresh, assigned } = this.ledger.ingest(this.recentEntries(), now);
        for (const item of fresh) this.count(item);
        const state = this.state;
        if (state) for (const item of assigned) this.assign(state, item);
        if (fresh.length || assigned.length) this.changed();
    }

    private recentEntries(): LedgerEntry[] {
        const meter = this.app.cost as MeterExtras;
        let raw: unknown;
        try {
            if (typeof meter.recent === 'function') raw = meter.recent();
            else if (typeof meter.today === 'function') raw = (meter.today() as { recent?: unknown })?.recent;
        } catch (error) {
            this.log.debug('cost entries unavailable', error);
        }
        if (!Array.isArray(raw)) return [];
        return raw.map(toLedgerEntry).filter((entry): entry is LedgerEntry => entry !== null);
    }

    /** Session totals and the auto-swipe day notes take every new entry of this chat. */
    private count(item: Classified): void {
        if (item.entry.at >= this.sessionFrom) addToLines(this.sessionLines, item.source, item.entry);
        if (item.source === 'autoSwipe') {
            addAutoDay(this.autoDelta, dayKey(item.entry.at), item.entry);
            this.scheduleAutoDays();
        }
    }

    private assign(state: ChatState, item: Assignment): void {
        if (item.turn < 0) return;
        this.apply(state, { kind: 'spend', turn: item.turn, source: item.source, entry: item.entry });
    }

    /* ---------------------------------------------------------------- NAI Studio Anlas */

    /** Looks at one message's NAI Studio records: counts what the core meter cannot see, hints what it counted. */
    private examine(index: number, trigger: AnlasTrigger): void {
        const state = this.state;
        if (!state) return;
        if (!state.doc) {
            state.waiting.push({ index, trigger });
            return;
        }
        const chat = this.chat();
        const message = chat[index];
        if (!isDict(message)) return;
        const records = naiRecords(message);
        if (!records.length) return;
        const now = this.now();
        const turn = turnOfMessage(chat, index);
        const found = newAnlas(records, {
            trigger,
            isUser: message['is_user'] === true,
            counted: state.counted,
            baseline: state.baseline,
            countFrom: this.startedAt,
        });
        if (trigger === 'reply') {
            // The core counted this message at reply:ready: the post once, else each media batch.
            const unseen = records.filter((record) => record.kind !== 'inline' && !state.baseline.has(record.key));
            const post = unseen.find((record) => record.kind === 'post');
            for (const record of post ? [post] : unseen) this.ledger.hint(record.anlas, turn, now);
        }
        for (const record of records) state.baseline.add(record.key);
        for (const record of found) {
            state.counted.add(record.key);
            this.apply(state, { kind: 'anlasKey', key: record.key });
            this.ledger.hint(record.anlas, turn, now);
            try {
                this.app.cost.recordAnlas(record.anlas);
            } catch (error) {
                this.log.warn('could not record Anlas', error);
            }
        }
    }

    /** New inline pictures of the latest messages (NAI Studio without events, pictures finished between turns). */
    private sweep(index: number): void {
        const chat = this.chat();
        for (let i = Math.max(0, chat.length - SWEEP_MESSAGES); i < chat.length; i++) {
            if (i !== index) this.examine(i, 'sweep');
        }
    }

    /**
     * The whole chat once its document is loaded: first the looks that waited for it (their pictures are new), then
     * everything else is history (or already counted).
     */
    private scan(state: ChatState): void {
        if (this.state !== state || !state.doc) return;
        for (const look of state.waiting.splice(0)) this.examine(look.index, look.trigger);
        const chat = this.chat();
        for (let i = 0; i < chat.length; i++) this.examine(i, 'scan');
        this.process();
    }

    /* ---------------------------------------------------------------- per-chat document */

    private open(chatId: string): void {
        const state: ChatState = {
            chatId,
            doc: null,
            unsaved: [],
            counted: new Set(),
            baseline: new Set(),
            waiting: [],
            saveTimer: null,
            saving: Promise.resolve(),
        };
        this.state = state;
        void this.load(state);
    }

    private async load(state: ChatState): Promise<void> {
        try {
            const raw = await this.app.chat.getFor<TreasurerDoc>(state.chatId, TREASURER_DOC_KIND, emptyDoc);
            this.adopt(state, raw);
        } catch (error) {
            this.log.warn('treasurer document could not be read; starting empty', error);
            this.adopt(state, emptyDoc());
        }
        if (this.disposed || this.state !== state) return;
        // Off the CHAT_CHANGED path: the scan touches every message once.
        this.scanTimer = setTimeout(() => {
            this.scanTimer = null;
            this.scan(state);
        }, 0);
        this.changed();
    }

    /** Takes a document from the store and replays the changes made while it was loading. */
    private adopt(state: ChatState, raw: TreasurerDoc): void {
        const doc = sanitizeDoc(raw);
        for (const op of state.unsaved) applyOp(doc, op);
        for (const key of doc.anlasKeys) state.counted.add(key);
        state.doc = doc;
    }

    private apply(state: ChatState, op: DocOp): void {
        state.unsaved.push(op);
        if (state.doc) applyOp(state.doc, op);
        this.scheduleSave(state);
    }

    private scheduleSave(state: ChatState): void {
        if (state.saveTimer || this.disposed) return;
        state.saveTimer = setTimeout(() => {
            state.saveTimer = null;
            void this.saveNow(state);
        }, this.saveDelay);
    }

    private saveNow(state: ChatState): Promise<void> {
        if (state.saveTimer) {
            clearTimeout(state.saveTimer);
            state.saveTimer = null;
        }
        state.saving = state.saving
            .then(() => this.write(state))
            .catch((error: unknown) => {
                this.log.warn('treasurer document not saved', error);
            });
        return state.saving;
    }

    private async write(state: ChatState): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const doc = state.doc;
            const sent = state.unsaved.length;
            if (!doc || sent === 0) return;
            if (await this.app.chat.put(TREASURER_DOC_KIND, doc)) {
                state.unsaved.splice(0, sent);
                return;
            }
            // Another tab wrote a newer copy: take it and replay what this tab has not saved yet.
            const fresh = await this.app.chat.getFor<TreasurerDoc>(state.chatId, TREASURER_DOC_KIND, emptyDoc);
            if (fresh === doc) return;
            this.adopt(state, fresh);
            this.changed();
        }
    }

    /* ---------------------------------------------------------------- days */

    private liveDay(date: string): DayData {
        const meter = this.app.cost as MeterExtras;
        try {
            const day = readDay(meter.today?.(), date);
            if (day) return day;
        } catch (error) {
            this.log.debug('today totals unavailable', error);
        }
        const summary = this.app.cost.summary();
        return {
            date,
            totalUsd: summary.todayUsd,
            bySource: { ...summary.todayBySource },
            byTask: {},
            anlas: summary.anlasToday,
            recent: this.recentEntries().filter((entry) => dayKey(entry.at) === date),
        };
    }

    private storedDay(date: string): Promise<DayData | null> {
        let pending = this.dayCache.get(date);
        if (!pending) {
            pending = this.app.files
                .read<unknown>(costFileName(date))
                .then((raw) => readDay(raw, date))
                .catch((error: unknown) => {
                    this.log.debug(`cost file of ${date} unreadable`, error);
                    this.dayCache.delete(date);
                    return null;
                });
            this.dayCache.set(date, pending);
        }
        return pending;
    }

    private autoDayOf(date: string): AutoDay | undefined {
        const stored = this.autoDays.days[date];
        const delta = this.autoDelta[date];
        if (!stored && !delta) return undefined;
        return mergeAutoDays({ version: 1, days: stored ? { [date]: stored } : {} }, delta ? { [date]: delta } : {})
            .days[date];
    }

    private async loadAutoDays(): Promise<void> {
        try {
            this.autoDays = readAutoDays(await this.app.files.read<unknown>(this.autoDaysFile()));
        } catch (error) {
            this.log.debug('auto-swipe day notes unreadable', error);
        }
    }

    private autoDaysFile(): string {
        return this.app.files.fileName(AUTO_DAYS_FILE_KIND);
    }

    private scheduleAutoDays(): void {
        if (this.autoTimer || this.disposed) return;
        this.autoTimer = setTimeout(() => {
            this.autoTimer = null;
            void this.flushAutoDays();
        }, this.daysSaveDelay);
    }

    /** Merges this tab's delta into what is on disk (other tabs write the same file). */
    private flushAutoDays(): Promise<void> {
        if (this.autoTimer) {
            clearTimeout(this.autoTimer);
            this.autoTimer = null;
        }
        this.autoChain = this.autoChain
            .then(async () => {
                const delta = this.autoDelta;
                if (!Object.keys(delta).length) return;
                this.autoDelta = {};
                try {
                    const name = this.autoDaysFile();
                    const merged = mergeAutoDays(
                        readAutoDays(await this.app.files.read<unknown>(name, { fresh: true })),
                        delta,
                    );
                    await this.app.files.write(name, merged);
                    this.autoDays = merged;
                } catch (error) {
                    this.autoDelta = mergeAutoDays({ version: 1, days: delta }, this.autoDelta).days;
                    throw error;
                }
            })
            .catch((error: unknown) => this.log.warn('auto-swipe day notes not saved', error));
        return this.autoChain;
    }

    /* ---------------------------------------------------------------- daily limit */

    private onLimit(info: { usd: number; limit: number; action: CoreSettings['dailyLimit']['action'] }): void {
        const today = dayKey(this.now());
        // One reaction per day: the meter fires again after a page reload, the user may have switched back.
        if (this.settings.limitDate === today) return;
        this.settings.limitDate = today;
        const i18n = this.app.i18n;
        const params = { spent: formatUsd(info.usd, i18n), limit: formatUsd(info.limit, i18n) };
        if (info.action === 'economy') this.switchToEconomy(params, today);
        else if (info.action === 'stopBackground') {
            this.app.ui.notice(i18n.t('m21.limit.stopBackground', params), { urgent: true, level: 'warn' });
        } else this.app.ui.notice(i18n.t('m21.limit.warn', params), { urgent: true, level: 'warn' });
        this.saveSettings('limitDate');
    }

    private switchToEconomy(params: { spent: string; limit: string }, today: string): void {
        const i18n = this.app.i18n;
        const core = this.app.settings.core();
        const previous = core.mode;
        if (previous === 'economy') {
            this.app.ui.notice(i18n.t('m21.limit.economyAlready', params), { urgent: true, level: 'warn' });
            return;
        }
        core.mode = 'economy';
        this.settings.modeBeforeLimit = previous;
        this.app.settings.save();
        this.app.settings.notify('core.mode');
        this.app.ui.notice(i18n.t('m21.limit.economy', params), {
            urgent: true,
            level: 'warn',
            action: {
                label: i18n.t('m21.limit.restore', { mode: this.modeName(previous) }),
                run: () => this.putModeBack(previous),
            },
        });
        try {
            void this.app.journal
                .record({
                    module: TREASURER_ID,
                    kind: ECONOMY_KIND,
                    summary: i18n.t('m21.journal.economy', { limit: params.limit }),
                    changes: [
                        {
                            target: MODE_TARGET,
                            ref: { path: 'core.mode', date: today },
                            before: previous,
                            after: 'economy',
                        },
                    ],
                })
                .catch((error: unknown) => this.log.warn('mode switch not journaled', error));
        } catch (error) {
            this.log.warn('mode switch not journaled', error);
        }
    }

    /** Notice button and journal undo: the mode the limit switched away from, if the user kept «Экономный». */
    private putModeBack(previous: CoreSettings['mode']): boolean {
        const core = this.app.settings.core();
        this.settings.modeBeforeLimit = '';
        if (core.mode !== 'economy') {
            this.saveSettings('modeBeforeLimit');
            return core.mode === previous;
        }
        core.mode = previous;
        this.app.settings.save();
        this.app.settings.notify('core.mode');
        this.saveSettings('modeBeforeLimit');
        return true;
    }

    private async undoMode(change: JournalChange): Promise<boolean> {
        const before = change.before;
        if (before !== 'balanced' && before !== 'cinema' && before !== 'economy') return false;
        return this.putModeBack(before);
    }

    /** A new day after the limit switched to «Экономный»: the previous mode comes back (unless the user chose one). */
    private restoreMode(): void {
        const previous = this.settings.modeBeforeLimit;
        if (!previous || this.settings.limitDate === dayKey(this.now())) return;
        let core: CoreSettings;
        try {
            core = this.app.settings.core();
        } catch {
            return;
        }
        const wasEconomy = core.mode === 'economy';
        if (this.putModeBack(previous) && wasEconomy) {
            this.app.ui.notice(this.app.i18n.t('m21.limit.restored', { mode: this.modeName(previous) }), {
                level: 'info',
            });
        }
    }

    private modeName(mode: CoreSettings['mode']): string {
        return tOr(this.app.i18n, `m21.mode.${mode}`, mode);
    }

    private saveSettings(field: keyof TreasurerSettings): void {
        try {
            this.app.settings.save();
            this.app.settings.notify(`modules.${TREASURER_KEY}.${field}`);
        } catch (error) {
            this.log.debug('settings not saved', error);
        }
    }

    /* ---------------------------------------------------------------- helpers */

    private chat(): STChatMessage[] {
        try {
            const chat = this.app.host.ctx().chat;
            return Array.isArray(chat) ? chat : [];
        } catch {
            return [];
        }
    }

    private lastReplyIndex(): number {
        return lastReply(this.chat());
    }

    private safeChatId(): string | null {
        try {
            return this.app.host.chatId();
        } catch {
            return null;
        }
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('treasurer listener failed', error);
            }
        }
    }
}
