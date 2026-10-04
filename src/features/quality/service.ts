// M12 «Контроль качества ответа» (plan M12, §8, §11, §12, P14, P15; dev-plan stage 6). On reply:ready (after DES,
// DES-RU and NAI markers) the reply is checked before NAI Studio draws:
//   1. input  — the reply as stored, the last 10 story messages (cleaned), names, the expected language, DES
//               together mode, the finish reason of the main request, the enabled boundary rules;
//   2. rules  — runFreeChecks (src/domain/quality-checks.ts), plus the early-cutoff hit of this reply;
//   3. judge  — only when a rule is not sure (confidence < JUDGE_THRESHOLD): one direct request, leader tab only,
//               under the background cap, 15 s at most; never in «Экономный» or with the judge switched off;
//   4. act    — per kind off / auto / notify («Экономный»: notify only): one auto-swipe per turn with a one-shot
//               «[Fix for this reply: …]» injection, clean (DES JSON and NAI markers kept), /continue, the DES tracker
//               repair of M3; notify = message badges «Переделать» / «Не брак»;
//   5. signal — the verdict is stored per message and swipe, 'reply:ok' goes out when nothing is left, and NAI
//               Studio's wait resolves (true = draw, false = the reply is being redone; 20 s at most → true).
// Group chats sleep (plan §4.14); quiet generations, sheets, picture posts and first messages are skipped.
import { adaptersOf } from '../../adapters';
import { stableHash } from '../../domain/hash';
import { runFreeChecks } from '../../domain/quality-checks';
import { JUDGE_THRESHOLD } from '../../domain/quality-types';
import type { QualityInput, QualityMessage } from '../../domain/quality-types';
import { detectSheetCommand } from '../../domain/sheets';
import { cleanForAnalysis, isImagePost } from '../../domain/text-clean';
import type {
    App,
    AutonomyLevel,
    Decision,
    GenerationInfo,
    JournalChange,
    Logger,
    Proposal,
    Unsubscribe,
} from '../../shared/contracts';
import type { MetricsApi } from '../metrics/api';
import type { TreasurerApi } from '../treasurer/api';
import type { SheetsApi } from '../sheets/api';
import { StActions, swipeIdOf } from './actions';
import type { BoundaryRule, Defect, DefectAction, DefectKind, QualityApi, QualityStats, QualityVerdict } from './api';
import { buildJudgeMessages, JUDGE_MAX_TOKENS, JUDGE_SCHEMA, JUDGE_TASK, parseJudge } from './judge';
import type { JudgeItem } from './judge';
import {
    expectedLanguage,
    fixNote,
    gateValue,
    isOk,
    planActions,
    removeQuotes,
    safeClean,
    shortQuote,
    verdictAction,
} from './logic';
import type { InstructionContext } from './logic';
import { copyRules, DEFECT_KINDS, QUALITY_ID, QUALITY_KEY, readRule } from './settings';
import type { QualitySettings } from './settings';
import { StatsStore, VerdictStore } from './store';
import type { StoredVerdict } from './store';
import { StreamWatch } from './stream';
import type { CutoffInfo } from './stream';

export const TEXT_TARGET = 'quality-text';
export const SWIPE_TARGET = 'quality-swipe';
export const CONTINUE_TARGET = 'quality-continue';
export const FIX_INJECTION = 'quality_fix';
export const BADGE_PREFIX = 'maestro-qc-';

/** Reply types that come from a real generation of the story (others: first_message, command, quiet, …). */
const CHECKED_TYPES = new Set(['normal', 'swipe', 'regenerate', 'continue']);
/** Generation types the early cutoff may stop (a continue keeps its first part: it is cleaned afterwards). */
const CUTOFF_TYPES = new Set(['normal', 'swipe', 'regenerate']);
const HISTORY_MESSAGES = 10;
/** Unconfirmed rule hits below this are dropped instead of shown as «possible». */
export const SUSPICION_FLOOR = 0.5;

export interface QualityTimings {
    /** The judge answers within this or is ignored. */
    judgeMs: number;
    /** NAI Studio never waits longer than this (then: draw). */
    gateMs: number;
    /** NAI Studio asked before reply:ready arrived: start the check ourselves after this. */
    gateKickMs: number;
    /** A generation ended without a rendered reply: stop expecting one after this. */
    expectGraceMs: number;
    /** Wait for the response body (finish reason) at most this long. */
    finishWaitMs: number;
    pollMs: number;
    /** Longest wait for ST to become idle before an automatic swipe. */
    idleMs: number;
    /** The one-shot fix note is dropped if no swipe generation starts within this. */
    fixTtlMs: number;
    /** How often the NAI Studio gate registration is looked at (NAI Studio switched off and on again). */
    naiSyncMs: number;
}

export const DEFAULT_TIMINGS: QualityTimings = {
    judgeMs: 15_000,
    gateMs: 20_000,
    gateKickMs: 1_500,
    expectGraceMs: 5_000,
    finishWaitMs: 300,
    pollMs: 100,
    idleMs: 10_000,
    fixTtlMs: 60_000,
    naiSyncMs: 5_000,
};

type Mode = 'auto' | 'gate' | 'manual';

type QualityGate = (messageIndex: number) => Promise<boolean>;

/** The parts of the NAI adapter M12 uses (NaiAdapter.setQualityGate, NAI Studio 0.11.0+); duck-typed for fakes. */
interface NaiGateHost {
    setQualityGate?(gate: QualityGate): () => void;
    api?(): { registerQualityGate?: unknown } | undefined;
}

/** What M12 needs from M3 «Медик» (optional until medic exposes it). */
export interface MedicRepairApi {
    repairTracker?(messageIndex: number): Promise<boolean>;
}

interface Waiter {
    resolve(value: boolean): void;
    kick: ReturnType<typeof setTimeout> | null;
}

interface PendingFix {
    chatId: string | null;
    index: number;
    text: string;
    expires: number;
}

interface Snapshot {
    chatId: string;
    index: number;
    message: STChatMessage;
    swipeId: number;
    text: string;
    hash: string;
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            },
        );
    });
}

function emptyVerdict(index: number, swipeId = 0): QualityVerdict {
    return {
        messageIndex: index,
        swipeId,
        ok: true,
        defects: [],
        judged: false,
        action: 'none',
        costUsd: 0,
        at: Date.now(),
    };
}

function copyVerdict(verdict: QualityVerdict): QualityVerdict {
    const copy = structuredClone(verdict) as QualityVerdict & { hash?: string; invalidated?: string };
    delete copy.hash;
    return copy;
}

/** DES asks for a tracker at all (its defaults: info box and characters on, quests off). */
function expectsTracker(settings: Record<string, unknown> | null): boolean {
    if (!settings) return true;
    return settings.showInfoBox !== false || settings.showCharacterThoughts !== false || settings.showQuests === true;
}

export class QualityService implements QualityApi {
    readonly verdicts: VerdictStore;
    readonly statsStore: StatsStore;
    readonly actions: StActions;
    readonly stream: StreamWatch;
    private readonly listeners = new Set<(verdict: QualityVerdict) => void>();
    private readonly changeListeners = new Set<() => void>();
    private readonly inflight = new Map<string, Promise<StoredVerdict | null>>();
    private readonly inflightByIndex = new Map<number, Promise<StoredVerdict | null>>();
    private readonly waiters = new Map<number, Waiter[]>();
    private readonly badges = new Map<number, Unsubscribe[]>();
    private expecting: { chatId: string | null; at: number } | null = null;
    private expectTimer: ReturnType<typeof setTimeout> | null = null;
    /** Turn counter: +1 when the user sends a message or the chat changes. */
    private turn = 0;
    /** The turn whose one automatic swipe is used. */
    private autoSwipedTurn = -1;
    /** The turn whose one automatic /continue is used (a reply cut again is only reported). */
    private autoContinuedTurn = -1;
    private pendingFix: PendingFix | null = null;
    private cutoff: CutoffInfo | null = null;
    /** Our own text rewrite: an 'edited' invalidation of it is not the user's edit. */
    private ownEdit: { index: number; until: number } | null = null;
    /** Unregistration of the gate set in NAI Studio, while it is registered. */
    private naiGateOff: (() => void) | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => QualitySettings,
        private readonly timings: QualityTimings = DEFAULT_TIMINGS,
    ) {
        this.verdicts = new VerdictStore(app, log.scope('store'));
        this.statsStore = new StatsStore(app, log.scope('stats'));
        this.actions = new StActions(app, log.scope('st'), { pollMs: timings.pollMs, idleMs: timings.idleMs });
        this.stream = new StreamWatch(app, log.scope('stream'), (info) => this.onCutoff(info));
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ------------------------------------------------------------ lifecycle */

    install(own: (dispose: Unsubscribe) => void): void {
        const { app } = this;
        own(app.bus.on('reply:ready', ({ messageIndex, type }) => this.onReplyReady(messageIndex, type)));
        own(app.bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)));
        own(app.bus.on('chat:changed', () => this.onChatChanged()));
        own(
            app.bus.on('turn:committed', () => {
                this.turn++;
            }),
        );
        own(app.bus.on('generation:before', (info) => this.onGenerationBefore(info)));
        own(app.bus.on('generation:ended', () => this.onGenerationEnded()));
        own(app.ephemeral.addProducer('quality.fix', (gen) => this.produceFix(gen)));
        for (const off of this.stream.install()) own(off);
        own(this.statsStore.onChange(() => this.changed()));

        // Boundary actions are never promoted to «Само» (plan §8, M12 table).
        app.autonomy.neverAuto('quality.boundary');
        // Journal undo works even after the module is switched off (records outlive it).
        app.journal.registerUndo(TEXT_TARGET, (change) => this.undoText(change));
        app.journal.registerUndo(SWIPE_TARGET, (change) => this.undoSwipe(change));
        app.journal.registerUndo(CONTINUE_TARGET, (change) => this.undoContinue(change));

        // NAI Studio drops its gates when it is switched off and republishes its API when it comes back: the gate is
        // set again whenever registerQualityGate (re)appears — at APP_READY and on a cheap periodic look.
        this.syncNaiGate();
        const ready = app.host.events.name('APP_READY');
        if (ready) own(app.host.events.on(ready, () => this.syncNaiGate()));
        const timer = setInterval(() => this.syncNaiGate(), this.timings.naiSyncMs);
        own(() => clearInterval(timer));
        own(() => {
            const off = this.naiGateOff;
            this.naiGateOff = null;
            off?.();
        });
        void this.verdicts.load().then(() => this.restoreBadges());
        own(() => this.dispose());
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.releaseAll(true);
        for (const index of [...this.badges.keys()]) this.clearBadges(index);
        if (this.expectTimer !== null) clearTimeout(this.expectTimer);
        this.expectTimer = null;
        this.pendingFix = null;
        this.stream.end();
        this.verdicts.dispose();
        void this.statsStore.flush();
        this.listeners.clear();
        this.changeListeners.clear();
    }

    /* ------------------------------------------------------------ state helpers */

    private isActive(): boolean {
        return !this.disposed && this.app.host.chatId() !== null && !this.app.host.isGroupChat();
    }

    private economy(): boolean {
        try {
            return this.app.settings.core()?.mode === 'economy';
        } catch {
            return false;
        }
    }

    /** The chosen action of a kind: the user's autonomy level for 'quality.<kind>' over the module default. */
    configuredAction(kind: DefectKind): DefectAction {
        const base = this.settings().actions[kind] ?? 'notify';
        let level: AutonomyLevel;
        try {
            level = this.app.autonomy.level(`quality.${kind}`, base);
        } catch {
            level = base;
        }
        const action: DefectAction = level === 'off' ? 'off' : level === 'auto' ? 'auto' : 'notify';
        return action === 'auto' && kind === 'boundary' ? 'notify' : action;
    }

    /** The action that applies now: «Экономный» turns every «Само» into «Уведомить» (plan §12). */
    action(kind: DefectKind): DefectAction {
        const action = this.configuredAction(kind);
        return action === 'auto' && this.economy() ? 'notify' : action;
    }

    isEconomy(): boolean {
        return this.economy();
    }

    /** Sets the action of a kind (pult): the module slice and the autonomy level stay in step. */
    setAction(kind: DefectKind, action: DefectAction): void {
        const next: DefectAction = kind === 'boundary' && action === 'auto' ? 'notify' : action;
        this.settings().actions[kind] = next;
        this.app.settings.notify(`modules.${QUALITY_KEY}.actions.${kind}`);
        this.app.settings.save();
        try {
            this.app.autonomy.setLevel?.(`quality.${kind}`, next);
        } catch (error) {
            this.log.debug('autonomy level not set', error);
        }
        this.changed();
    }

    swipeBudget(): boolean {
        return this.autoSwipedTurn !== this.turn;
    }

    private sheet(index: number): boolean {
        const chat = this.app.host.ctx().chat;
        const message = chat[index];
        const maestro = message?.extra?.maestro;
        if (isDict(maestro) && maestro.sheet) return true;
        try {
            if (this.app.modules.api<SheetsApi>('sheets')?.isSheetMessage(index)) return true;
        } catch {
            // the sheets module may be mid-restart
        }
        for (let i = index - 1; i >= 0; i--) {
            const earlier = chat[i];
            if (earlier?.is_user) return detectSheetCommand(earlier.mes) !== undefined;
        }
        return false;
    }

    /** A story reply the checks apply to (type: the reply:ready type when known). */
    checkable(index: number, type?: string): boolean {
        if (type !== undefined && !CHECKED_TYPES.has(type || 'normal')) return false;
        const message = this.app.host.ctx().chat[index];
        if (!message || message.is_user || message.is_system) return false;
        if (isImagePost(message)) return false;
        return !this.sheet(index);
    }

    private snapshot(index: number): Snapshot | null {
        const chatId = this.app.host.chatId();
        const message = this.app.host.ctx().chat[index];
        if (!chatId || !message) return null;
        const text = typeof message.mes === 'string' ? message.mes : '';
        return { chatId, index, message, swipeId: swipeIdOf(message), text, hash: stableHash(text) };
    }

    private same(snapshot: Snapshot): boolean {
        const message = this.app.host.ctx().chat[snapshot.index];
        return (
            !this.disposed &&
            this.app.host.chatId() === snapshot.chatId &&
            message === snapshot.message &&
            swipeIdOf(message) === snapshot.swipeId &&
            message.mes === snapshot.text
        );
    }

    private ruleTitles(): Record<string, string> {
        const titles: Record<string, string> = {};
        for (const rule of this.settings().boundary) titles[rule.id] = rule.title || rule.id;
        return titles;
    }

    private desTogether(): boolean {
        try {
            const des = adaptersOf(this.app).des;
            return (
                des.present() && des.enabled() && des.generationMode() === 'together' && expectsTracker(des.settings())
            );
        } catch {
            return false;
        }
    }

    private languageLock(): boolean {
        try {
            const desru = adaptersOf(this.app).desru;
            if (!desru.present() || !desru.moduleEnabled('bunnymo')) return false;
            const modules = desru.settings()?.modules;
            const bunnymo = isDict(modules) ? modules.bunnymo : undefined;
            return !isDict(bunnymo) || bunnymo.languageLock !== false;
        } catch {
            return false;
        }
    }

    /** The checks' input for a reply (`text` replaces the stored text: the pult's test mode). */
    private async buildInput(index: number, mode: Mode, text?: string): Promise<QualityInput> {
        const ctx = this.app.host.ctx();
        const chat = ctx.chat;
        const message = chat[index];
        const history: QualityMessage[] = [];
        for (let i = Math.min(index, chat.length) - 1; i >= 0 && history.length < HISTORY_MESSAGES; i--) {
            const earlier = chat[i];
            if (!earlier || earlier.is_system || isImagePost(earlier) || this.sheet(i)) continue;
            const clean = cleanForAnalysis(earlier);
            if (!clean) continue;
            history.unshift({ index: i, isUser: earlier.is_user, name: earlier.name ?? '', text: clean });
        }
        const charName = (message && !message.is_user ? message.name : '') || ctx.name2 || '';
        const language = expectedLanguage({
            lock: this.languageLock(),
            userTexts: history.filter((item) => item.isUser).map((item) => item.text),
            allTexts: history.map((item) => item.text),
            fallback: this.app.i18n.locale(),
        });
        const finishReason =
            mode !== 'manual' && text === undefined && this.actions.isLast(index)
                ? await this.stream.reason(this.timings.finishWaitMs)
                : undefined;
        const input: QualityInput = {
            reply: {
                index,
                isUser: false,
                name: charName,
                text: text ?? (typeof message?.mes === 'string' ? message.mes : ''),
            },
            history,
            userName: ctx.name1 || 'User',
            charName,
            language,
            desTogether: this.desTogether(),
            boundary: this.boundaryInput(this.settings().boundary),
        };
        if (finishReason !== undefined) input.finishReason = finishReason;
        return input;
    }

    private boundaryInput(rules: readonly BoundaryRule[]): { id: string; patterns: string[] }[] {
        return rules
            .filter((rule) => rule.enabled && rule.patterns.length)
            .map((rule) => ({ id: rule.id, patterns: [...rule.patterns] }));
    }

    private instructionContext(input: Pick<QualityInput, 'userName' | 'language'>): InstructionContext {
        return { userName: input.userName, language: input.language, rules: this.ruleTitles() };
    }

    private freeChecks(input: QualityInput): Defect[] {
        let found: Defect[];
        try {
            found = runFreeChecks(input);
        } catch (error) {
            this.log.warn('free checks failed', error);
            return [];
        }
        if (!Array.isArray(found)) return [];
        return found
            .filter((defect) => isDict(defect) && DEFECT_KINDS.includes(defect.kind))
            .map((defect) => ({
                ...defect,
                confidence: Number.isFinite(defect.confidence) ? Math.max(0, Math.min(1, defect.confidence)) : 0,
                quote: shortQuote(typeof defect.quote === 'string' ? defect.quote : ''),
                by: typeof defect.by === 'string' ? defect.by : 'rule',
            }));
    }

    /* ------------------------------------------------------------ the flow */

    private onReplyReady(index: number, type: string): void {
        if (!this.isActive() || !this.checkable(index, type)) {
            this.release(index, true);
            return;
        }
        this.expecting = null;
        void this.run(index, 'auto').catch((error: unknown) => {
            this.log.error('quality check failed', error);
            this.release(index, true);
        });
    }

    /** Checks a reply once per text (auto, gate) or again (manual). */
    run(index: number, mode: Mode): Promise<StoredVerdict | null> {
        const snapshot = this.snapshot(index);
        if (!snapshot) return Promise.resolve(null);
        if (mode !== 'manual') {
            const existing = this.verdicts.live(index, snapshot.swipeId);
            if (existing && existing.hash === snapshot.hash) {
                this.release(index, gateValue(existing));
                return Promise.resolve(existing);
            }
        }
        const key = `${snapshot.chatId}:${index}:${snapshot.swipeId}:${snapshot.hash}:${mode === 'manual' ? 'm' : 'a'}`;
        const running = this.inflight.get(key);
        if (running) return running;
        const job = this.evaluate(snapshot, mode).finally(() => {
            this.inflight.delete(key);
            if (this.inflightByIndex.get(index) === job) this.inflightByIndex.delete(index);
        });
        this.inflight.set(key, job);
        this.inflightByIndex.set(index, job);
        return job;
    }

    private async evaluate(snapshot: Snapshot, mode: Mode): Promise<StoredVerdict | null> {
        const { index } = snapshot;
        const input = await this.buildInput(index, mode);
        let defects = this.freeChecks(input);

        const cutoff = this.cutoff;
        if (cutoff && cutoff.chatId === snapshot.chatId && cutoff.index === index && mode !== 'manual') {
            this.cutoff = null;
            defects.unshift({ kind: 'junk', confidence: 1, quote: cutoff.token, by: 'cutoff', fix: { kind: 'swipe' } });
        }
        defects = defects.filter((defect) => this.action(defect.kind) !== 'off');

        let judged = false;
        let costUsd = 0;
        const suspicions = defects.filter((defect) => defect.confidence < JUDGE_THRESHOLD);
        if (suspicions.length) {
            const items: JudgeItem[] = suspicions.map((defect, i) => ({ id: i + 1, defect }));
            const outcome = this.judgeAllowed() ? await this.judge(input, items) : null;
            costUsd = outcome?.cost ?? 0;
            const answer = outcome?.answer ?? null;
            judged = answer !== null;
            defects = defects.flatMap((defect) => {
                const item = items.find((candidate) => candidate.defect === defect);
                if (!item) return [defect];
                const confirmed = answer?.confirmed.get(item.id);
                if (confirmed) return [confirmed];
                if (answer?.denied.includes(item.id)) return [];
                return defect.confidence >= SUSPICION_FLOOR ? [{ ...defect, suspected: true }] : [];
            });
            if (
                answer?.tooAgreeable &&
                this.action('softening') !== 'off' &&
                !defects.some((defect) => defect.kind === 'softening' && !defect.suspected)
            ) {
                defects.push({ kind: 'softening', confidence: 0.9, quote: '', by: 'judge:tooAgreeable' });
            }
        }

        if (!this.same(snapshot)) {
            this.log.debug(`reply #${index} changed during its check; verdict dropped`);
            this.release(index, true);
            return null;
        }

        const auto = mode !== 'manual';
        const canSwipe = auto && this.swipeBudget() && this.actions.canSwipe() && this.actions.isLast(index);
        const plan = planActions({
            defects,
            action: (kind) => {
                const action = this.action(kind);
                return auto || action === 'off' ? action : 'notify';
            },
            canSwipe,
        });
        const verdict: StoredVerdict = {
            messageIndex: index,
            swipeId: snapshot.swipeId,
            ok: false,
            defects,
            judged,
            action: 'none',
            costUsd,
            at: Date.now(),
            hash: snapshot.hash,
        };
        const previous = this.verdicts.live(index, snapshot.swipeId);
        if (auto && !(previous && previous.hash === snapshot.hash)) {
            for (const defect of defects) this.statsStore.bump(defect.kind, 'detected');
        }

        if (plan.swipe.length) {
            // The reply is redone: NAI Studio must not draw for it, and the turn's one auto-swipe is taken now.
            for (const defect of defects) defect.status = 'swiped';
            this.autoSwipedTurn = this.turn;
            this.finish(verdict);
            void this.autoSwipe(verdict, plan.swipe, input);
            return verdict;
        }

        if (plan.clean.length) await this.clean(verdict, plan.clean, snapshot);
        const canContinue =
            plan.continue.length > 0 &&
            this.autoContinuedTurn !== this.turn &&
            this.actions.canContinue() &&
            this.actions.isLast(index) &&
            this.actions.sendBoxEmpty();
        for (const defect of plan.continue) defect.status = canContinue ? 'continued' : 'notified';
        if (plan.repair.length) this.repair(verdict, plan.repair);
        for (const defect of plan.notify) defect.status = 'notified';
        this.finish(verdict);
        if (canContinue) {
            this.autoContinuedTurn = this.turn;
            void this.autoContinue(verdict, plan.continue);
        }
        return verdict;
    }

    /** Stores the verdict and tells everyone: listeners, badges, 'reply:ok', NAI Studio's wait. */
    private finish(verdict: StoredVerdict): void {
        verdict.ok = isOk(verdict.defects);
        verdict.action = verdictAction(verdict.defects);
        this.verdicts.put(verdict);
        this.showBadges(verdict);
        this.emitVerdict(verdict);
        if (verdict.ok) void this.app.bus.emit('reply:ok', { messageIndex: verdict.messageIndex });
        this.release(verdict.messageIndex, gateValue(verdict));
    }

    private emitVerdict(verdict: QualityVerdict): void {
        const copy = copyVerdict(verdict);
        for (const listener of [...this.listeners]) {
            try {
                listener(copy);
            } catch (error) {
                this.log.error('verdict listener failed', error);
            }
        }
        this.changed();
    }

    /** Re-evaluates ok/action after a late change (dismiss, fallback, repair done) and saves. */
    private update(verdict: StoredVerdict): void {
        verdict.ok = isOk(verdict.defects);
        verdict.action = verdictAction(verdict.defects);
        this.verdicts.changed();
        this.showBadges(verdict);
        this.emitVerdict(verdict);
    }

    /* ------------------------------------------------------------ judge */

    judgeAllowed(): boolean {
        const { app } = this;
        if (!this.settings().judge || this.economy()) return false;
        try {
            if (!app.leader.isLeader()) return false;
            if (!app.llm.available(JUDGE_TASK)) return false;
            if (app.cost.backgroundCapReached()) return false;
        } catch {
            return false;
        }
        return true;
    }

    private async judge(
        input: QualityInput,
        items: JudgeItem[],
    ): Promise<{ answer: ReturnType<typeof parseJudge>; cost: number } | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timings.judgeMs);
        try {
            const request = this.app.llm.request({
                task: JUDGE_TASK,
                messages: buildJudgeMessages(input, items, this.ruleTitles()),
                maxTokens: JUDGE_MAX_TOKENS,
                temperature: 0,
                schema: { name: 'quality_judge', schema: JUDGE_SCHEMA },
                signal: controller.signal,
            });
            const result = await withTimeout(request, this.timings.judgeMs + 500, null);
            if (!result) return null;
            const cost = result.costUsd ?? 0;
            if (!result.ok) {
                this.log.debug(`judge gave no answer: ${result.error ?? 'unknown'}`);
                return { answer: null, cost };
            }
            return { answer: parseJudge(result.data, items), cost };
        } catch (error) {
            this.log.warn('judge failed', error);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /* ------------------------------------------------------------ actions */

    private kindsText(defects: readonly Defect[]): string {
        return [...new Set(defects.map((defect) => this.t(`m12.kind.${defect.kind}`)))].join(', ');
    }

    private primaryKind(defects: readonly Defect[], fallback: DefectKind): DefectKind {
        return defects.find((defect) => this.action(defect.kind) === 'auto')?.kind ?? defects[0]?.kind ?? fallback;
    }

    private async decide(proposal: Proposal<Record<string, never>>): Promise<Decision> {
        try {
            return await this.app.autonomy.decide(proposal, 'auto');
        } catch (error) {
            this.log.warn(`${proposal.kind}: decide failed`, error);
            return 'skipped';
        }
    }

    private async clean(verdict: StoredVerdict, defects: Defect[], snapshot: Snapshot): Promise<void> {
        const before = snapshot.text;
        const candidates = defects
            .map((defect) => defect.fix?.cleaned)
            .filter((text): text is string => typeof text === 'string')
            .sort((a, b) => a.length - b.length);
        let after: string | null = null;
        for (const candidate of candidates) {
            after = safeClean(before, candidate);
            if (after) break;
        }
        after ??= safeClean(
            before,
            removeQuotes(
                before,
                defects.map((defect) => defect.quote),
            ),
        );
        const fallback = () => {
            for (const defect of defects) defect.status = 'notified';
        };
        if (!after) {
            fallback();
            return;
        }
        const cleaned = after;
        const { index, swipeId, chatId } = snapshot;
        const kinds = [...new Set(defects.map((defect) => defect.kind))];
        const change: JournalChange = {
            target: TEXT_TARGET,
            ref: { chatId, messageIndex: index, swipeId, kinds },
            before: { text: before },
            after: { text: cleaned },
        };
        const decision = await this.decide({
            module: QUALITY_ID,
            kind: `quality.${this.primaryKind(defects, 'junk')}`,
            title: this.t('m12.journal.clean', { index: index + 1, kinds: this.kindsText(defects) }),
            changes: [change],
            payload: {},
            sourceMessage: index,
            stillValid: async () => this.same(snapshot),
            apply: async () => {
                this.ownEdit = { index, until: Date.now() + 2_000 };
                if (!(await this.actions.writeText(index, swipeId, before, cleaned))) {
                    throw new Error('the reply changed; nothing cleaned');
                }
            },
        });
        if (decision !== 'applied') {
            fallback();
            return;
        }
        verdict.hash = stableHash(cleaned);
        // A defect counts as cleaned when its cleaned text was used or its quote is gone; the rest stay a notice.
        const covered = (defect: Defect): boolean => {
            if (typeof defect.fix?.cleaned === 'string') return true;
            const quote = defect.quote.replace(/…$/, '').trim();
            return quote.length > 0 && before.includes(quote) && !cleaned.includes(quote);
        };
        for (const defect of defects) defect.status = covered(defect) ? 'cleaned' : 'notified';
        for (const kind of new Set(defects.filter(covered).map((defect) => defect.kind))) {
            this.statsStore.bump(kind, 'autoActions');
        }
    }

    private repair(verdict: StoredVerdict, defects: Defect[]): void {
        const { app } = this;
        const medic = app.modules.api<MedicRepairApi>('medic');
        if (typeof medic?.repairTracker === 'function') {
            for (const defect of defects) defect.status = 'delegated';
            const index = verdict.messageIndex;
            void medic
                .repairTracker(index)
                .then((done) => {
                    if (!done || verdict.invalidated) return;
                    for (const defect of defects) defect.status = 'repaired';
                    this.statsStore.bump('missingTracker', 'autoActions');
                    this.update(verdict);
                })
                .catch((error: unknown) => this.log.warn('tracker repair failed', error));
            return;
        }
        let medicRepairs: boolean;
        try {
            medicRepairs =
                app.settings.isModuleEnabled('medic') &&
                app.settings.module<{ trackerRepair?: boolean }>('medic').trackerRepair !== false;
        } catch {
            medicRepairs = false;
        }
        // M3 repairs a missing tracker on reply:ready by itself (and reports failures): no second notice.
        for (const defect of defects) defect.status = medicRepairs ? 'delegated' : 'notified';
    }

    private async autoSwipe(verdict: StoredVerdict, defects: Defect[], input: QualityInput): Promise<void> {
        const index = verdict.messageIndex;
        const chatId = this.app.host.chatId();
        const note = fixNote(defects, this.instructionContext(input));
        const kinds = [...new Set(defects.map((defect) => defect.kind))];
        const decision = await this.decide({
            module: QUALITY_ID,
            kind: `quality.${this.primaryKind(defects, 'refusal')}`,
            title: this.t('m12.journal.swipe', { index: index + 1, kinds: this.kindsText(defects) }),
            changes: [
                {
                    target: SWIPE_TARGET,
                    ref: { chatId, messageIndex: index, swipeId: verdict.swipeId, kinds },
                    before: { swipeId: verdict.swipeId },
                    after: { note },
                },
            ],
            payload: {},
            sourceMessage: index,
            apply: async () => {
                if (!(await this.startSwipe(index, note, true))) throw new Error('the swipe did not start');
            },
        });
        if (decision === 'applied') {
            for (const kind of kinds) this.statsStore.bump(kind, 'autoActions');
            return;
        }
        // No swipe happened: the turn keeps its auto-swipe, the defects become a notice.
        if (this.autoSwipedTurn === this.turn) this.autoSwipedTurn = -1;
        if (verdict.invalidated) return;
        for (const defect of verdict.defects) defect.status = 'notified';
        this.update(verdict);
    }

    private async autoContinue(verdict: StoredVerdict, defects: Defect[]): Promise<void> {
        const index = verdict.messageIndex;
        const chatId = this.app.host.chatId();
        const message = this.app.host.ctx().chat[index];
        const before = typeof message?.mes === 'string' ? message.mes : '';
        const decision = await this.decide({
            module: QUALITY_ID,
            kind: 'quality.truncated',
            title: this.t('m12.journal.continue', { index: index + 1 }),
            changes: [
                {
                    target: CONTINUE_TARGET,
                    ref: { chatId, messageIndex: index, swipeId: verdict.swipeId, kinds: ['truncated'] },
                    before: { text: before },
                    after: null,
                },
            ],
            payload: {},
            sourceMessage: index,
            apply: async () => {
                if (!(await this.actions.continueLast(index))) throw new Error('/continue did not start');
            },
        });
        if (decision === 'applied') {
            this.statsStore.bump('truncated', 'autoActions');
            return;
        }
        if (this.autoContinuedTurn === this.turn) this.autoContinuedTurn = -1;
        if (verdict.invalidated) return;
        for (const defect of defects) defect.status = 'notified';
        this.update(verdict);
    }

    /** Swipes with the one-shot fix note armed for that generation only. */
    private startSwipe(index: number, note: string, auto: boolean): Promise<boolean> {
        const chatId = this.app.host.chatId();
        return this.actions.swipe(index, () => {
            this.pendingFix = note ? { chatId, index, text: note, expires: Date.now() + this.timings.fixTtlMs } : null;
            if (auto) {
                try {
                    this.app.modules.api<MetricsApi>('metrics')?.noteAutoSwipe();
                } catch (error) {
                    this.log.debug('metrics did not take the auto-swipe note', error);
                }
                try {
                    this.app.modules.api<TreasurerApi>('treasurer')?.noteAutoSwipe?.();
                } catch (error) {
                    this.log.debug('treasurer did not take the auto-swipe note', error);
                }
            }
        });
    }

    /** Ephemeral producer: the fix note goes into the next swipe generation only (depth 0, system). */
    private produceFix(gen: GenerationInfo): void {
        const fix = this.pendingFix;
        if (!fix || gen.quiet || gen.dryRun) return;
        this.pendingFix = null;
        if (gen.type !== 'swipe' || fix.chatId !== this.app.host.chatId() || Date.now() > fix.expires) return;
        this.app.ephemeral.setInjection(FIX_INJECTION, { text: fix.text, position: 1, depth: 0, role: 0, scan: false });
    }

    /* ------------------------------------------------------------ badges */

    private showBadges(verdict: StoredVerdict): void {
        const index = verdict.messageIndex;
        this.clearBadges(index);
        const open = verdict.defects.filter((defect) => defect.status === 'notified');
        if (!open.length || verdict.invalidated) return;
        const possible = open.every((defect) => defect.suspected);
        const offs = [
            this.app.ui.messageBadge(index, {
                id: `${BADGE_PREFIX}${index}`,
                text: this.t(possible ? 'm12.badge.possible' : 'm12.badge.text', { kinds: this.kindsText(open) }),
                action: { label: this.t('m12.badge.redo'), run: () => void this.redo(index) },
            }),
            this.app.ui.messageBadge(index, {
                id: `${BADGE_PREFIX}${index}-ok`,
                text: this.t('m12.badge.falseText'),
                action: { label: this.t('m12.badge.dismiss'), run: () => void this.dismissAll(index) },
            }),
        ];
        this.badges.set(index, offs);
    }

    private clearBadges(index: number): void {
        const offs = this.badges.get(index);
        if (!offs) return;
        this.badges.delete(index);
        for (const off of offs) {
            try {
                off();
            } catch (error) {
                this.log.debug('badge removal failed', error);
            }
        }
    }

    /** After a reload: the badges of the newest reply come back. */
    private restoreBadges(): void {
        if (!this.isActive()) return;
        const chat = this.app.host.ctx().chat;
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system || isImagePost(message)) {
                if (message?.is_user) return;
                continue;
            }
            const verdict = this.verdicts.live(i, swipeIdOf(message));
            if (verdict && !this.badges.has(i)) this.showBadges(verdict);
            return;
        }
    }

    /* ------------------------------------------------------------ NAI Studio's wait */

    /** Sets the gate when NAI Studio's API offers registerQualityGate and ours is not registered there. */
    syncNaiGate(): void {
        if (this.disposed) return;
        const nai = adaptersOf(this.app).nai as unknown as NaiGateHost | undefined;
        if (typeof nai?.setQualityGate !== 'function') return;
        let available: boolean;
        try {
            available = typeof nai.api?.()?.registerQualityGate === 'function';
        } catch {
            available = false;
        }
        if (!available) {
            // NAI Studio is off or gone: it dropped our registration itself.
            this.naiGateOff = null;
            return;
        }
        if (this.naiGateOff) return;
        try {
            this.naiGateOff = nai.setQualityGate((index) => this.gate(index));
            this.log.debug('NAI Studio quality gate set');
        } catch (error) {
            this.log.warn('NAI Studio quality gate could not be set', error);
        }
    }

    /** The gate is registered with NAI Studio (pult). */
    naiGateActive(): boolean {
        return this.naiGateOff !== null;
    }

    gate(index: number): Promise<boolean> {
        return withTimeout(this.gateInner(index), this.timings.gateMs, true);
    }

    private async gateInner(index: number): Promise<boolean> {
        if (!this.isActive()) return true;
        const message = this.app.host.ctx().chat[index];
        if (!message || !this.checkable(index)) return true;
        const verdict = this.verdicts.live(index, swipeIdOf(message));
        if (verdict) return gateValue(verdict);
        const running = this.inflightByIndex.get(index);
        if (running) {
            const result = await running;
            return result ? gateValue(result) : true;
        }
        if (!this.expectingFor(index)) return true;
        return new Promise<boolean>((resolve) => {
            const waiter: Waiter = { resolve, kick: null };
            // NAI Studio may hold ST's event chain while it waits (then reply:ready comes late): check it ourselves.
            waiter.kick = setTimeout(() => {
                waiter.kick = null;
                this.kick(index);
            }, this.timings.gateKickMs);
            const list = this.waiters.get(index) ?? [];
            list.push(waiter);
            this.waiters.set(index, list);
        });
    }

    private expectingFor(index: number): boolean {
        const expecting = this.expecting;
        if (!expecting || expecting.chatId !== this.app.host.chatId()) return false;
        return index >= this.app.host.ctx().chat.length - 1;
    }

    private kick(index: number): void {
        if (!this.waiters.get(index)?.length || this.inflightByIndex.has(index) || !this.isActive()) return;
        if (!this.checkable(index)) {
            this.release(index, true);
            return;
        }
        void this.run(index, 'gate').catch((error: unknown) => {
            this.log.error('quality check failed', error);
            this.release(index, true);
        });
    }

    private release(index: number, value: boolean): void {
        const list = this.waiters.get(index);
        if (!list) return;
        this.waiters.delete(index);
        for (const waiter of list) {
            if (waiter.kick !== null) clearTimeout(waiter.kick);
            waiter.resolve(value);
        }
    }

    private releaseAll(value: boolean, from = 0): void {
        for (const index of [...this.waiters.keys()]) if (index >= from) this.release(index, value);
    }

    /* ------------------------------------------------------------ host events */

    private onGenerationBefore(info: GenerationInfo): void {
        if (info.quiet || info.dryRun) return;
        if (this.expectTimer !== null) clearTimeout(this.expectTimer);
        this.expectTimer = null;
        const active = this.isActive();
        // An impersonation writes the user's message: no reply of the character to wait for.
        const replies = active && !info.sheetCommand && info.type !== 'impersonate';
        this.expecting = replies ? { chatId: this.app.host.chatId(), at: Date.now() } : null;
        const cutoff =
            active &&
            !info.sheetCommand &&
            CUTOFF_TYPES.has(info.type) &&
            this.settings().earlyCutoff &&
            this.action('junk') === 'auto' &&
            this.swipeBudget() &&
            this.actions.canSwipe();
        this.stream.begin(info, cutoff);
    }

    private onGenerationEnded(): void {
        this.stream.end();
        if (!this.expecting) return;
        if (this.expectTimer !== null) clearTimeout(this.expectTimer);
        this.expectTimer = setTimeout(() => {
            this.expectTimer = null;
            if (!this.expecting) return;
            // The generation ended without a reply to check (error, empty reply): nobody should keep waiting.
            this.expecting = null;
            for (const index of [...this.waiters.keys()]) {
                if (!this.inflightByIndex.has(index)) this.release(index, true);
            }
        }, this.timings.expectGraceMs);
    }

    private onCutoff(info: CutoffInfo): void {
        if (!this.isActive() || !this.swipeBudget()) return;
        this.cutoff = info;
        this.actions.stop();
    }

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (reason === 'edited' && this.ownEdit && this.ownEdit.index === index && Date.now() < this.ownEdit.until) {
            return;
        }
        const match =
            reason === 'deleted'
                ? (verdict: StoredVerdict) => verdict.messageIndex >= index
                : (verdict: StoredVerdict) => verdict.messageIndex === index;
        this.verdicts.invalidate(match, reason);
        for (const badge of [...this.badges.keys()]) {
            if (reason === 'deleted' ? badge >= index : badge === index) this.clearBadges(badge);
        }
        if (reason === 'deleted') this.releaseAll(false, index);
        else this.release(index, reason === 'edited');
        if (this.cutoff && this.cutoff.index === index && reason !== 'swiped') this.cutoff = null;
        this.changed();
    }

    private onChatChanged(): void {
        this.turn++;
        this.releaseAll(true);
        for (const index of [...this.badges.keys()]) this.clearBadges(index);
        this.pendingFix = null;
        this.cutoff = null;
        this.expecting = null;
        if (this.expectTimer !== null) clearTimeout(this.expectTimer);
        this.expectTimer = null;
        void this.verdicts.load().then(() => {
            this.restoreBadges();
            this.changed();
        });
        this.changed();
    }

    /* ------------------------------------------------------------ undo */

    private undoRef(change: JournalChange): { index: number; swipeId: number; kinds: DefectKind[] } | null {
        const ref = isDict(change.ref) ? change.ref : {};
        if (ref.chatId !== this.app.host.chatId()) return null;
        if (typeof ref.messageIndex !== 'number' || typeof ref.swipeId !== 'number') return null;
        const kinds = Array.isArray(ref.kinds)
            ? ref.kinds.filter((kind): kind is DefectKind => DEFECT_KINDS.includes(kind as DefectKind))
            : [];
        return { index: ref.messageIndex, swipeId: ref.swipeId, kinds };
    }

    private falsePositive(kinds: readonly DefectKind[]): void {
        for (const kind of new Set(kinds)) this.statsStore.bump(kind, 'falsePositives');
    }

    private async undoText(change: JournalChange): Promise<boolean> {
        const ref = this.undoRef(change);
        const before = isDict(change.before) ? change.before.text : undefined;
        const after = isDict(change.after) ? change.after.text : undefined;
        if (!ref || typeof before !== 'string' || typeof after !== 'string') return false;
        this.ownEdit = { index: ref.index, until: Date.now() + 2_000 };
        if (!(await this.actions.writeText(ref.index, ref.swipeId, after, before))) return false;
        this.verdicts.invalidate((verdict) => verdict.messageIndex === ref.index, 'edited');
        this.falsePositive(ref.kinds);
        this.changed();
        return true;
    }

    private async undoSwipe(change: JournalChange): Promise<boolean> {
        const ref = this.undoRef(change);
        if (!ref || !(await this.actions.swipeBack(ref.index, ref.swipeId))) return false;
        this.falsePositive(ref.kinds);
        return true;
    }

    private async undoContinue(change: JournalChange): Promise<boolean> {
        const ref = this.undoRef(change);
        const before = isDict(change.before) ? change.before.text : undefined;
        if (!ref || typeof before !== 'string') return false;
        const message = this.app.host.ctx().chat[ref.index];
        const current = typeof message?.mes === 'string' ? message.mes : undefined;
        if (current === undefined || current === before || !current.startsWith(before.trimEnd())) return false;
        this.ownEdit = { index: ref.index, until: Date.now() + 2_000 };
        if (!(await this.actions.writeText(ref.index, ref.swipeId, current, before))) return false;
        this.verdicts.invalidate((verdict) => verdict.messageIndex === ref.index, 'edited');
        this.falsePositive(['truncated']);
        this.changed();
        return true;
    }

    /* ------------------------------------------------------------ QualityApi */

    verdict(messageIndex: number): QualityVerdict | undefined {
        const message = this.app.host.ctx().chat[messageIndex];
        if (!message) return undefined;
        const verdict = this.verdicts.live(messageIndex, swipeIdOf(message));
        return verdict ? copyVerdict(verdict) : undefined;
    }

    async check(messageIndex: number): Promise<QualityVerdict> {
        const message = this.app.host.ctx().chat[messageIndex];
        if (!this.isActive() || !this.checkable(messageIndex)) return emptyVerdict(messageIndex, swipeIdOf(message));
        await this.verdicts.ready();
        const verdict = await this.run(messageIndex, 'manual');
        return verdict ? copyVerdict(verdict) : emptyVerdict(messageIndex, swipeIdOf(message));
    }

    async dismiss(messageIndex: number, kind: DefectKind): Promise<void> {
        const message = this.app.host.ctx().chat[messageIndex];
        if (!message) return;
        const verdict = this.verdicts.live(messageIndex, swipeIdOf(message));
        if (!verdict) return;
        let hit = false;
        for (const defect of verdict.defects) {
            if (defect.kind === kind && defect.status !== 'dismissed') {
                defect.status = 'dismissed';
                hit = true;
            }
        }
        if (!hit) return;
        this.statsStore.bump(kind, 'falsePositives');
        try {
            this.app.autonomy.record(`quality.${kind}`, 'rejected');
        } catch (error) {
            this.log.debug('autonomy record failed', error);
        }
        this.update(verdict);
        if (verdict.ok) await this.app.bus.emit('reply:ok', { messageIndex });
    }

    /** «Не брак» on the badge: every open defect of the reply. */
    async dismissAll(messageIndex: number): Promise<void> {
        const message = this.app.host.ctx().chat[messageIndex];
        const verdict = message ? this.verdicts.live(messageIndex, swipeIdOf(message)) : undefined;
        if (!verdict) return;
        const kinds = new Set(
            verdict.defects.filter((defect) => defect.status === 'notified').map((defect) => defect.kind),
        );
        for (const kind of kinds) await this.dismiss(messageIndex, kind);
    }

    async redo(messageIndex: number): Promise<void> {
        const message = this.app.host.ctx().chat[messageIndex];
        if (!message || !this.isActive()) return;
        const verdict = this.verdicts.live(messageIndex, swipeIdOf(message));
        const defects = (verdict?.defects ?? []).filter((defect) => defect.status !== 'dismissed');
        if (!this.actions.isLast(messageIndex)) {
            this.app.ui.notice(this.t('m12.redo.notLast'), { level: 'warn' });
            return;
        }
        for (const kind of new Set(defects.map((defect) => defect.kind))) {
            try {
                this.app.autonomy.record(`quality.${kind}`, 'accepted');
            } catch (error) {
                this.log.debug('autonomy record failed', error);
            }
        }
        this.clearBadges(messageIndex);
        const ctx = this.app.host.ctx();
        const input = { userName: ctx.name1 || 'User', language: this.currentLanguage(messageIndex) };
        const note = fixNote(defects, this.instructionContext(input));
        if (!(await this.startSwipe(messageIndex, note, false))) {
            this.app.ui.notice(this.t('m12.redo.failed'), { level: 'warn' });
            if (verdict) this.showBadges(verdict);
        }
    }

    private currentLanguage(index: number): string {
        const chat = this.app.host.ctx().chat;
        const texts = chat
            .slice(Math.max(0, index - HISTORY_MESSAGES), index)
            .filter((message) => !message.is_system && !isImagePost(message))
            .map((message) => ({ user: message.is_user, text: cleanForAnalysis(message) }));
        return expectedLanguage({
            lock: this.languageLock(),
            userTexts: texts.filter((item) => item.user).map((item) => item.text),
            allTexts: texts.map((item) => item.text),
            fallback: this.app.i18n.locale(),
        });
    }

    boundary(): BoundaryRule[] {
        return copyRules(this.settings().boundary);
    }

    async setBoundary(rules: BoundaryRule[]): Promise<void> {
        const clean = (Array.isArray(rules) ? rules : [])
            .map(readRule)
            .filter((rule): rule is BoundaryRule => rule !== null);
        const seen = new Set<string>();
        const unique = clean.filter((rule) => !seen.has(rule.id) && seen.add(rule.id));
        this.settings().boundary = unique;
        this.app.settings.notify(`modules.${QUALITY_KEY}.boundary`);
        this.app.settings.save();
        this.changed();
    }

    stats(): QualityStats[] {
        return this.statsStore.list();
    }

    onVerdict(listener: (verdict: QualityVerdict) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** «Тестовый режим»: the free checks over a pasted text as the next reply of this chat; nothing is acted on. */
    test(text: string, boundary?: BoundaryRule[]): Defect[] {
        const ctx = this.app.host.ctx();
        const chat = ctx.chat;
        const history: QualityMessage[] = [];
        for (let i = chat.length - 1; i >= 0 && history.length < HISTORY_MESSAGES; i--) {
            const earlier = chat[i];
            if (!earlier || earlier.is_system || isImagePost(earlier)) continue;
            const clean = cleanForAnalysis(earlier);
            if (clean) history.unshift({ index: i, isUser: earlier.is_user, name: earlier.name ?? '', text: clean });
        }
        const input: QualityInput = {
            reply: { index: chat.length, isUser: false, name: ctx.name2 || '', text },
            history,
            userName: ctx.name1 || 'User',
            charName: ctx.name2 || '',
            language: expectedLanguage({
                lock: this.languageLock(),
                userTexts: history.filter((item) => item.isUser).map((item) => item.text),
                allTexts: history.map((item) => item.text),
                fallback: this.app.i18n.locale(),
            }),
            desTogether: this.desTogether(),
            boundary: this.boundaryInput(boundary ?? this.settings().boundary),
        };
        return this.freeChecks(input);
    }

    history(): QualityVerdict[] {
        return [...this.verdicts.all()].reverse().map((verdict) => {
            const copy = copyVerdict(verdict) as QualityVerdict & { invalidated?: string };
            return copy;
        });
    }

    /** Pult refresh hook (verdicts, stats, settings). */
    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    private changed(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('quality change listener failed', error);
            }
        }
    }
}
