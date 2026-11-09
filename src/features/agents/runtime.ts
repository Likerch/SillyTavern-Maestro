// When agents run and what their results do (plan §3.3, §4.4, §4.7):
// - prefetch («заранее»): after the post phase of a reply, in the leader tab; the result waits in the chat document
//   bound to that reply (index + text hash) and goes into the next generation; a stale one (swipe, edit) is skipped;
// - onSend («при отправке»): an ephemeral producer — the generation waits for the agent up to its timeout, «Не ждать»
//   lets it go; cached by the player's message, so a swipe does not ask again;
// - parallel («вместе с ответом»): starts with the generation, never waited for; its note or choices join the reply;
//   an injection waits for the next turn;
// - post («после ответа»): after M12's verdict lets the reply stand (QualityApi.addAfterVerdict: NAI Studio draws after
//   us), or after reply:ready when M12 is off; checks and notes in parallel, rewrites last and one at a time;
// - commit («при фиксации») and schedule: the background queue (leader tab, idle), after turn:committed / events;
// - manual: the user's click, a job with progress.
// Everything a reply led to is per swipe and goes with it; an injection is set for one generation and cleared (P8).
import { rerenderMessage } from '../../host/messages';
import { conditionsHold, eventOfSignal, isBreak, isDue } from '../../domain/agents/cadence';
import type { ConditionContext } from '../../domain/agents/cadence';
import { matchesSchema } from '../../core/llm';
import { proposalReceiver } from '../../core/proposal-receivers';
import { verdictFix } from '../../domain/agents/output';
import type { AgentOutput, ProposalItem } from '../../domain/agents/output';
import { checkRewrite, restore } from '../../domain/agents/rewrite';
import type { AgentDef, AgentEvent, AgentPhase, AgentRun, AgentState, InjectOptions } from '../../domain/agents/types';
import { stableHash } from '../../domain/hash';
import type { App, GenerationInfo, InjectionSpec, Logger, Unsubscribe } from '../../shared/contracts';
import type { DirectorApi } from '../director/api';
import type { QualityApi } from '../quality/api';
import type { AgentsChatState, MessageResult } from './chat-state';
import { gateMessages, GATE_SCHEMA, GATE_TASK } from './gate';
import type { AgentRunner, RunOutcome, RunRequest } from './runner';
import { recentMessages } from './sources';
import type { AgentStore } from './store';

export const RUN_TASK = 'agent.run';
export const FIX_INJECTION = 'agent_fix';
const MAX_PARALLEL = 3;
const POST_FALLBACK_MS = 25_000;
const DEFAULT_BREAK_HOURS = 12;
const FAILURES_TO_NOTIFY = 3;

type Own = (dispose: Unsubscribe | (() => void | Promise<void>)) => void;

function swipeOf(message: STChatMessage | undefined): number {
    return typeof message?.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
}

function textHash(text: unknown): string {
    return stableHash(typeof text === 'string' ? text : '');
}

/** Runs async jobs with at most `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) await job(item);
    });
    await Promise.all(workers);
}

export function injectionSpec(text: string, options: InjectOptions): InjectionSpec {
    const position = options.position === 'top' ? 2 : options.position === 'afterMain' ? 0 : 1;
    const role = options.role === 'user' ? 1 : options.role === 'assistant' ? 2 : 0;
    return { text, position, depth: options.depth, role, scan: false };
}

/** Variable-safe name of an agent for preset blocks: `{{getvar::maestro_agent_<slug>}}`. */
export function agentVarName(def: AgentDef): string {
    return def.id
        .replace(/^u-/, '')
        .replace(/-[a-z0-9]{5}$/, '')
        .replace(/-/g, '_');
}

export class AgentRuntime {
    /** Events seen since the last schedule check. */
    private events = new Set<AgentEvent>();
    /** Post runs in flight per message (aborted when the message changes). */
    private readonly inflight = new Map<number, AbortController>();
    private readonly postDone = new Set<string>();
    private readonly fallbackTimers = new Map<number, ReturnType<typeof setTimeout>>();
    /** onSend results by the player's message (index + hash): a swipe does not ask again. */
    private readonly onSendCache = new Map<
        string,
        { agentId: string; text?: string; flags?: Record<string, string | number | boolean> }[]
    >();
    private pendingFix: string | null = null;
    private autoRedoTurn = -1;
    private readonly failures = new Map<string, number>();
    private skipWait: (() => void) | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly store: AgentStore,
        private readonly state: AgentsChatState,
        private readonly runner: AgentRunner,
        private readonly now: () => number = Date.now,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private isGroup(): boolean {
        try {
            return this.app.host.isGroupChat();
        } catch {
            return true;
        }
    }

    private chat(): STChatMessage[] {
        try {
            return this.app.host.ctx().chat ?? [];
        } catch {
            return [];
        }
    }

    install(own: Own): void {
        const { app } = this;
        own(app.bus.on('chat:changed', () => void this.onChatChanged()));
        own(app.bus.on('turn:committed', ({ messageIndex }) => this.onCommitted(messageIndex)));
        own(
            app.bus.on('signal', (signal) => {
                const event = eventOfSignal(signal.kind);
                if (event) this.events.add(event);
            }),
        );
        own(app.bus.on('message:invalidated', (payload) => this.onInvalidated(payload)));
        own(app.bus.on('generation:before', (info) => this.onGenerationBefore(info)));
        own(app.bus.on('reply:ready', ({ messageIndex, type }) => this.onReplyReady(messageIndex, type)));
        own(app.ephemeral.addProducer('agents', (gen) => this.produce(gen)));
        own(app.tasks.register(RUN_TASK, (payload) => this.runTask(payload)));
        own(() => {
            for (const controller of this.inflight.values()) controller.abort();
            for (const timer of this.fallbackTimers.values()) clearTimeout(timer);
            this.fallbackTimers.clear();
            this.skipWait?.();
        });
        const quality = app.modules.api<QualityApi>('quality');
        if (quality?.addAfterVerdict) own(quality.addAfterVerdict((index) => this.afterVerdict(index)));
    }

    /* ------------------------------------------------------------ chat */

    async onChatChanged(): Promise<void> {
        this.events = new Set();
        this.onSendCache.clear();
        this.postDone.clear();
        await Promise.all([this.state.load(), this.store.loadScopes()]);
        this.store.changed();
        if (this.isGroup() || !this.app.host.chatId()) return;
        this.events.add('chatOpen');
        const chat = this.chat();
        const last = chat[chat.length - 1];
        const at = last?.send_date ? Date.parse(String(last.send_date)) : NaN;
        for (const { def } of this.store.activeAgents()) {
            if (
                def.trigger.events?.includes('break') &&
                isBreak(Number.isFinite(at) ? at : null, this.now(), def.trigger.breakHours ?? DEFAULT_BREAK_HOURS)
            ) {
                this.events.add('break');
                break;
            }
        }
        this.checkSchedule(chat.length - 1);
    }

    /* ------------------------------------------------------------ conditions */

    private enabledKeys(): Set<string> {
        const keys = new Set<string>();
        try {
            for (const item of this.app.modules.list()) if (item.running) keys.add(item.module.key);
        } catch {
            // older test apps
        }
        for (const [id, adapter] of Object.entries(this.app.adapters ?? {})) {
            try {
                if (adapter?.present()) keys.add(id);
            } catch {
                // a neighbour that cannot tell is treated as absent
            }
        }
        return keys;
    }

    conditionContext(): ConditionContext {
        const director = this.app.modules.api<DirectorApi>('director');
        let scene: string | null = null;
        let stalled: boolean | null = null;
        try {
            scene = director?.scene()?.type ?? null;
            if (director) {
                const turns = this.app.settings.module<{ stallTurns?: number }>('director').stallTurns ?? 4;
                stalled = director.stall().turns >= turns;
            }
        } catch {
            // the director changed under us
        }
        const chat = this.chat();
        const recentTexts = chat.slice(-12).map((message) => (typeof message.mes === 'string' ? message.mes : ''));
        return {
            scene,
            recentTexts,
            mode: this.app.settings.core().mode,
            enabled: this.enabledKeys(),
            isGroup: this.isGroup(),
            stalled,
        };
    }

    /** The agents of a phase that are on and whose conditions hold, in priority order. */
    agentsFor(phase: AgentPhase, ctx = this.conditionContext()): { def: AgentDef; state: AgentState }[] {
        if (ctx.isGroup) return [];
        return this.store
            .activeAgents()
            .filter(({ def }) => def.trigger.phase === phase && conditionsHold(def.trigger.when, ctx))
            .sort((a, b) => (a.def.trigger.priority ?? 0) - (b.def.trigger.priority ?? 0));
    }

    /* ------------------------------------------------------------ results */

    private result(def: AgentDef, index: number, type: MessageResult['type'], data: Record<string, unknown>): void {
        const message = this.chat()[index];
        this.state.putResult({
            agentId: def.id,
            agentName: def.name,
            messageIndex: index,
            swipeId: swipeOf(message),
            type,
            data,
            at: this.now(),
        });
    }

    private noteFailure(def: AgentDef, run: AgentRun): void {
        if (run.ok || run.test || run.error === 'aborted' || run.error === 'limit') {
            if (run.ok) this.failures.delete(def.id);
            return;
        }
        const count = (this.failures.get(def.id) ?? 0) + 1;
        this.failures.set(def.id, count);
        if (count !== FAILURES_TO_NOTIFY) return;
        this.app.ui.notice(
            this.t('m44.failing', { name: def.name, reason: this.t(`m44.error.${run.error ?? 'other'}`) }),
            {
                importance: 'important',
                action: {
                    label: this.t('m44.openLog'),
                    run: () => this.app.ui.openWindow?.('agents', { tab: 'agents-log' }),
                },
            },
        );
    }

    /**
     * Applies an output (plan §4.7). `index`: the reply the run was about (post, parallel, commit, manual on a message);
     * undefined for prefetch / schedule without a reply.
     */
    async apply(def: AgentDef, outcome: RunOutcome, index: number | undefined, phase: AgentPhase): Promise<string[]> {
        const output = outcome.output;
        if (!output || output.type === 'none') return [];
        const applied: string[] = [];
        switch (output.type) {
            case 'inject':
            case 'flags':
                applied.push(...this.applyInjection(def, output, phase));
                break;
            case 'memory': {
                const changed = this.state.updateMemory(def.id, output.fields, this.now());
                if (changed.length) {
                    applied.push(this.t('m44.applied.memory', { count: changed.length }));
                    if (index !== undefined) this.result(def, index, 'memory', { fields: changed });
                }
                break;
            }
            case 'note':
                if (index !== undefined) this.result(def, index, 'note', { text: output.text });
                if (def.result.type === 'note' && def.result.options.show === 'toast')
                    this.app.ui.notice(`${def.name}: ${output.text}`, {
                        importance: 'info',
                        group: `agent-note-${def.id}`,
                    });
                applied.push(this.t('m44.applied.note'));
                break;
            case 'choices':
                if (index !== undefined) this.result(def, index, 'choices', { choices: output.choices });
                applied.push(this.t('m44.applied.choices', { count: output.choices.length }));
                break;
            case 'verdict':
                if (index !== undefined) applied.push(...(await this.applyVerdict(def, output, index)));
                break;
            case 'rewrite':
                if (index !== undefined) applied.push(...(await this.applyRewrite(def, outcome, index)));
                break;
            case 'proposals':
                applied.push(...(await this.applyProposals(def, output.items, index)));
                break;
        }
        return applied;
    }

    /** Proposals (release 1.31): each item through its receiver to autonomy and the Inbox. */
    private async applyProposals(
        def: AgentDef,
        items: readonly ProposalItem[],
        index: number | undefined,
    ): Promise<string[]> {
        let applied = 0;
        let queued = 0;
        let refused = 0;
        for (const item of items) {
            const receiver = proposalReceiver(item.kind);
            if (!receiver || !matchesSchema(item.data, receiver.schema)) {
                refused += 1;
                continue;
            }
            try {
                const context: { agentName: string; messageIndex?: number } = { agentName: def.name };
                if (index !== undefined) context.messageIndex = index;
                const proposal = await receiver.toProposal(item.data, context);
                if (!proposal) {
                    refused += 1;
                    continue;
                }
                if (item.why && !proposal.description) proposal.description = item.why;
                proposal.details = [proposal.details, this.t('m44.proposal.by', { name: def.name })]
                    .filter(Boolean)
                    .join('\n');
                if (index !== undefined && proposal.sourceMessage === undefined) proposal.sourceMessage = index;
                const decision = await this.app.autonomy.decide(proposal, receiver.defaultAutonomy);
                if (decision === 'applied' || decision === 'notified') applied += 1;
                else if (decision === 'queued') queued += 1;
            } catch (error) {
                this.log.warn(`proposal ${item.kind} failed`, error);
                refused += 1;
            }
        }
        const out: string[] = [];
        if (applied) out.push(this.t('m44.applied.proposalsDone', { count: applied }));
        if (queued) out.push(this.t('m44.applied.proposalsInbox', { count: queued }));
        if (refused) out.push(this.t('m44.applied.proposalsRefused', { count: refused }));
        return out;
    }

    private applyInjection(def: AgentDef, output: AgentOutput, phase: AgentPhase): string[] {
        const text = output.type === 'inject' ? output.text : undefined;
        const flags = output.type === 'flags' ? output.flags : undefined;
        const lifetime = def.result.type === 'inject' ? def.result.options.lifetime : 'turn';
        if (phase === 'prefetch' || (lifetime === 'turn' && phase !== 'schedule' && phase !== 'commit')) {
            const anchor = this.anchorNext();
            const item = { agentId: def.id, anchor: anchor.index, hash: anchor.hash, at: this.now() };
            this.state.setPrepared(text !== undefined ? { ...item, text } : { ...item, flags: flags ?? {} });
            return [this.t('m44.applied.injectTurn')];
        }
        this.state.setStanding(def.id, text ?? JSON.stringify(flags ?? {}), this.now());
        return [this.t('m44.applied.injectStanding')];
    }

    /** The reply the next generation follows: the last assistant message before the last player's message. */
    anchorNow(): { index: number; hash: string } {
        const chat = this.chat();
        let lastUser = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) {
                lastUser = i;
                break;
            }
        }
        const end = lastUser >= 0 ? lastUser : chat.length;
        for (let i = end - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) return { index: i, hash: textHash(message.mes) };
        }
        return { index: -1, hash: '' };
    }

    /** The reply the next turn will follow: the last assistant message of the chat now. */
    anchorNext(): { index: number; hash: string } {
        const chat = this.chat();
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) return { index: i, hash: textHash(message.mes) };
        }
        return { index: -1, hash: '' };
    }

    /** Where prefetch results are bound to right after a reply: that reply itself. */
    private anchorOfReply(index: number): { index: number; hash: string } {
        return { index, hash: textHash(this.chat()[index]?.mes) };
    }

    private async applyVerdict(
        def: AgentDef,
        output: Extract<AgentOutput, { type: 'verdict' }>,
        index: number,
    ): Promise<string[]> {
        if (output.ok) {
            this.result(def, index, 'verdict', { ok: true, problems: [] });
            return [this.t('m44.applied.verdictOk')];
        }
        const action = def.result.type === 'verdict' ? def.result.options.action : 'mark';
        this.result(def, index, 'verdict', { ok: false, problems: output.problems, action });
        const turn = this.chat().length;
        if ((action === 'swipe' || action === 'continue') && this.autoRedoTurn !== turn) {
            this.autoRedoTurn = turn;
            if (action === 'swipe') {
                await this.redo(index, def.name, output.problems);
                return [this.t('m44.applied.swiped')];
            }
            await this.continueReply();
            return [this.t('m44.applied.continued')];
        }
        return [this.t('m44.applied.verdict', { count: output.problems.length })];
    }

    /** «Переделать»: swipe with a one-shot fix instruction (the agent's problems). */
    async redo(
        index: number,
        agentName: string,
        problems: readonly { quote: string; issue: string; fix: string }[],
    ): Promise<boolean> {
        const ctx = this.app.host.ctx() as unknown as {
            swipe?: { right?: (event: null, options: { message: unknown }) => unknown; isAllowed?: () => boolean };
        };
        const chat = this.chat();
        const message = chat[index];
        if (!message || index !== chat.length - 1 || typeof ctx.swipe?.right !== 'function') return false;
        if (ctx.swipe.isAllowed && !ctx.swipe.isAllowed()) return false;
        this.pendingFix = verdictFix(agentName, problems);
        try {
            const result = ctx.swipe.right(null, { message });
            if (result instanceof Promise) result.catch((error: unknown) => this.log.warn('swipe failed', error));
            return true;
        } catch (error) {
            this.pendingFix = null;
            this.log.warn('swipe failed', error);
            return false;
        }
    }

    private async continueReply(): Promise<void> {
        try {
            const ctx = this.app.host.ctx() as unknown as {
                executeSlashCommandsWithOptions?: (text: string) => Promise<unknown>;
            };
            await ctx.executeSlashCommandsWithOptions?.('/continue');
        } catch (error) {
            this.log.warn('continue failed', error);
        }
    }

    private async applyRewrite(def: AgentDef, outcome: RunOutcome, index: number): Promise<string[]> {
        const output = outcome.output;
        if (output?.type !== 'rewrite' || !outcome.protectedReply || outcome.originalText === undefined) return [];
        const check = checkRewrite(outcome.protectedReply.text, output.editedText, output.changes, false);
        if (!check.ok) {
            if (check.reason !== 'same') {
                outcome.run.ok = false;
                outcome.run.error = check.reason;
            }
            return [];
        }
        const after = restore(outcome.protectedReply, output.editedText);
        const ok = await this.writeText(index, outcome.originalText, after);
        if (!ok) return [];
        this.result(def, index, 'rewrite', { original: outcome.originalText, changes: output.changes });
        try {
            await this.app.journal.record({
                module: 'agents',
                kind: 'agents.rewrite',
                summary: this.t('m44.journal.rewrite', { name: def.name, count: output.changes.length }),
                changes: [
                    {
                        target: 'message.text',
                        ref: { index, swipeId: swipeOf(this.chat()[index]) },
                        before: outcome.originalText,
                        after,
                    },
                ],
                sourceMessage: index,
            });
        } catch (error) {
            this.log.debug('journal record failed', error);
        }
        return [this.t('m44.applied.rewrite', { count: Math.max(1, output.changes.length) })];
    }

    /** Writes a reply's text when it is still `before` (message, swipe copy, screen, chat file). */
    async writeText(index: number, before: string, after: string): Promise<boolean> {
        const ctx = this.app.host.ctx();
        const message = ctx.chat[index];
        if (!message || message.is_user || message.mes !== before) return false;
        const swipeId = swipeOf(message);
        message.mes = after;
        const swipes = message.swipes;
        if (Array.isArray(swipes) && typeof swipes[swipeId] === 'string') swipes[swipeId] = after;
        await rerenderMessage(this.app.host, index, message, { log: this.log });
        try {
            await ctx.saveChat();
        } catch (error) {
            this.log.warn('saveChat failed', error);
        }
        return true;
    }

    /** Undo of a rewrite (journal target 'message.text'): the text goes back when nobody changed it since. */
    async undoText(ref: Record<string, unknown>, before: unknown, after: unknown): Promise<boolean> {
        const index = typeof ref.index === 'number' ? ref.index : -1;
        if (index < 0 || typeof before !== 'string' || typeof after !== 'string') return false;
        return this.writeText(index, after, before);
    }

    /* ------------------------------------------------------------ one run */

    async runAgent(
        def: AgentDef,
        state: AgentState | undefined,
        phase: AgentPhase,
        reason: string,
        options: {
            focusIndex?: number;
            signal?: AbortSignal;
            interactive?: boolean;
            extra?: string;
            timeoutMs?: number;
        } = {},
    ): Promise<RunOutcome> {
        if (!options.interactive && !(await this.passGate(def, options.focusIndex, phase)))
            return this.skipped(def, phase);
        const outcome = await this.runner.run({ def, state, phase, reason, ...options });
        await this.finishOutcome(def, outcome, options.focusIndex, phase);
        return outcome;
    }

    /** Applies a finished run, marks the counter, notes failures. */
    private async finishOutcome(
        def: AgentDef,
        outcome: RunOutcome,
        index: number | undefined,
        phase: AgentPhase,
    ): Promise<void> {
        if (outcome.run.ok) {
            const applied = await this.apply(def, outcome, index, phase);
            if (applied.length) outcome.run.applied = applied;
            if (outcome.run.ok) this.state.markOk(def.id, index ?? this.chat().length - 1, this.now());
            this.state.log.changed();
            this.state.notify();
        }
        this.noteFailure(def, outcome.run);
    }

    /**
     * Agents of one moment together (release 1.30): the cheap model's «is it needed now?» first for agents that ask it,
     * then the runner — batchable agents of one model in one request.
     */
    private async runSet(
        list: readonly { def: AgentDef; state: AgentState }[],
        base: {
            phase: AgentPhase;
            reason: string;
            focusIndex?: number;
            signal?: AbortSignal;
            timeoutMs?: (def: AgentDef) => number | undefined;
        },
    ): Promise<{ def: AgentDef; state: AgentState; outcome: RunOutcome }[]> {
        const passed: { def: AgentDef; state: AgentState }[] = [];
        await pool(list, MAX_PARALLEL, async (item) => {
            if (await this.passGate(item.def, base.focusIndex, base.phase)) passed.push(item);
            else this.skipped(item.def, base.phase);
        });
        const ordered = list.filter((item) => passed.includes(item));
        const requests: RunRequest[] = ordered.map(({ def, state }) => {
            const request: RunRequest = { def, state, phase: base.phase, reason: base.reason };
            if (base.focusIndex !== undefined) request.focusIndex = base.focusIndex;
            if (base.signal) request.signal = base.signal;
            const timeout = base.timeoutMs?.(def);
            if (timeout !== undefined) request.timeoutMs = timeout;
            return request;
        });
        const outcomes = await this.runner.runMany(requests);
        return ordered.map((item, index) => ({ ...item, outcome: outcomes[index]! }));
    }

    /** «Спросить дешёвую модель» (release 1.30): false only when the model clearly says the agent is not needed. */
    async passGate(def: AgentDef, focusIndex: number | undefined, phase: AgentPhase): Promise<boolean> {
        if (!def.gate || phase === 'manual') return true;
        const recent = recentMessages(this.app, focusIndex !== undefined ? focusIndex + 1 : this.chat().length, 4).join(
            '\n\n',
        );
        try {
            const result = await this.app.llm.request<{ run?: unknown }>({
                task: GATE_TASK,
                messages: gateMessages(def, recent),
                maxTokens: 60,
                temperature: 0,
                reasoning: 'off',
                schema: GATE_SCHEMA,
                profileKeys: [GATE_TASK, 'agents'],
            });
            return !(result.ok && result.data?.run === false);
        } catch {
            return true;
        }
    }

    private skipped(def: AgentDef, phase: AgentPhase): RunOutcome {
        const at = this.now();
        const run: AgentRun = {
            id: `${at.toString(36)}-g${Math.floor(Math.random() * 1e6).toString(36)}`,
            agentId: def.id,
            agentName: def.name,
            chatId: this.app.host.chatId(),
            phase,
            reason: 'gate',
            startedAt: at,
            ms: 0,
            ok: true,
            applied: [this.t('m44.gate.skipped')],
        };
        this.state.addRun(run);
        return { run };
    }

    /* ------------------------------------------------------------ post */

    private onReplyReady(index: number, type: string): void {
        if (type === 'quiet' || type === 'impersonate' || this.isGroup()) return;
        if (!this.agentsFor('post').length && !this.agentsFor('prefetch').length && !this.agentsFor('parallel').length)
            return;
        const quality = this.app.modules.api<QualityApi>('quality');
        const gated = Boolean(quality?.addAfterVerdict) && this.app.settings.isModuleEnabled('quality');
        if (!gated) {
            void this.afterVerdict(index);
            return;
        }
        // M12 calls us after its verdict; a reply it does not check (or a lost hook) still gets its agents.
        const old = this.fallbackTimers.get(index);
        if (old) clearTimeout(old);
        this.fallbackTimers.set(
            index,
            setTimeout(() => {
                this.fallbackTimers.delete(index);
                void this.afterVerdict(index);
            }, POST_FALLBACK_MS),
        );
    }

    /** The post phase of a reply, then the prefetch of the next turn. Runs once per reply text. */
    async afterVerdict(index: number): Promise<void> {
        const timer = this.fallbackTimers.get(index);
        if (timer) {
            clearTimeout(timer);
            this.fallbackTimers.delete(index);
        }
        const message = this.chat()[index];
        if (!message || message.is_user || this.isGroup()) return;
        const key = `${index}:${swipeOf(message)}:${textHash(message.mes)}`;
        if (this.postDone.has(key)) return;
        this.postDone.add(key);
        const leader = this.app.leader.isLeader();
        if (!leader) return;
        const controller = new AbortController();
        this.inflight.get(index)?.abort();
        this.inflight.set(index, controller);
        try {
            const agents = this.agentsFor('post');
            const rewrites = agents.filter(({ def }) => def.result.type === 'rewrite');
            const others = agents.filter(({ def }) => def.result.type !== 'rewrite');
            const hold = rewrites.some(({ def }) => def.result.type === 'rewrite' && def.result.options.holdReply);
            if (hold) this.holdReply(index, rewrites[0]?.def.name ?? '', true);
            try {
                const done = await this.runSet(others, {
                    phase: 'post',
                    reason: 'reply',
                    focusIndex: index,
                    signal: controller.signal,
                });
                for (const { def, outcome } of done) {
                    if (controller.signal.aborted) break;
                    await this.finishOutcome(def, outcome, index, 'post');
                }
                for (const { def, state } of rewrites) {
                    if (controller.signal.aborted) break;
                    await this.runAgent(def, state, 'post', 'reply', { focusIndex: index, signal: controller.signal });
                }
            } finally {
                if (hold) this.holdReply(index, '', false);
            }
        } finally {
            if (this.inflight.get(index) === controller) this.inflight.delete(index);
        }
        if (!controller.signal.aborted) void this.prefetch(index);
    }

    /** «Придержать ответ»: the reply is veiled while a rewrite works on it. */
    private holdReply(index: number, name: string, on: boolean): void {
        if (typeof document === 'undefined') return;
        try {
            const block = document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"]`);
            if (!block) return;
            block.classList.toggle('maestro-agent-hold', on);
            if (on) block.dataset.maestroHold = this.t('m44.hold', { name });
            else delete block.dataset.maestroHold;
        } catch {
            // the chat was redrawn
        }
    }

    /* ------------------------------------------------------------ prefetch */

    async prefetch(index: number): Promise<void> {
        if (!this.app.leader.isLeader()) return;
        const agents = this.agentsFor('prefetch');
        if (!agents.length) return;
        const anchor = this.anchorOfReply(index);
        const done = await this.runSet(agents, { phase: 'prefetch', reason: 'prefetch' });
        for (const { def, outcome } of done) {
            if (outcome.run.reason === 'gate') continue;
            if (outcome.run.ok && outcome.output && outcome.output.type !== 'none') {
                const item = { agentId: def.id, anchor: anchor.index, hash: anchor.hash, at: this.now() };
                if (outcome.output.type === 'inject') this.state.setPrepared({ ...item, text: outcome.output.text });
                else if (outcome.output.type === 'flags')
                    this.state.setPrepared({ ...item, flags: outcome.output.flags });
                else await this.apply(def, outcome, undefined, 'prefetch');
                outcome.run.applied = [this.t('m44.applied.injectTurn')];
                this.state.markOk(def.id, index, this.now());
            } else if (outcome.run.ok) {
                this.state.dropPrepared(def.id);
            }
            this.noteFailure(def, outcome.run);
        }
    }

    /** «Пересчитать» of one agent in «Вставки хода». */
    async recompute(agentId: string): Promise<void> {
        const def = this.store.get(agentId);
        if (!def) return;
        const state = this.store.states().get(agentId);
        const anchor = this.anchorNext();
        const outcome = await this.runner.run({ def, state, phase: 'prefetch', reason: 'manual', interactive: true });
        if (outcome.run.ok && outcome.output?.type === 'inject')
            this.state.setPrepared({
                agentId,
                anchor: anchor.index,
                hash: anchor.hash,
                at: this.now(),
                text: outcome.output.text,
            });
        else if (outcome.run.ok && outcome.output?.type === 'flags')
            this.state.setPrepared({
                agentId,
                anchor: anchor.index,
                hash: anchor.hash,
                at: this.now(),
                flags: outcome.output.flags,
            });
        else if (outcome.run.ok) await this.apply(def, outcome, undefined, 'prefetch');
    }

    /* ------------------------------------------------------------ generation */

    private onGenerationBefore(info: GenerationInfo): void {
        if (info.dryRun || info.quiet || this.isGroup()) return;
        const agents = this.agentsFor('parallel');
        if (!agents.length || !this.app.leader.isLeader()) return;
        const chat = this.chat();
        const target = info.type === 'normal' || info.type === 'impersonate' ? chat.length : chat.length - 1;
        void this.runSet(agents, { phase: 'parallel', reason: 'generation' }).then(async (done) => {
            for (const { def, outcome } of done) {
                if (!outcome.run.ok || !outcome.output || outcome.output.type === 'none') continue;
                if (outcome.output.type === 'note' || outcome.output.type === 'choices') {
                    await this.waitIdle();
                    const index = Math.min(target, this.chat().length - 1);
                    const applied = await this.apply(def, outcome, index, 'parallel');
                    outcome.run.applied = applied;
                } else {
                    outcome.run.applied = await this.apply(def, outcome, undefined, 'schedule');
                }
                this.state.markOk(def.id, target, this.now());
            }
        });
    }

    private async waitIdle(): Promise<void> {
        for (let i = 0; i < 240 && this.app.turn.current(); i++)
            await new Promise((resolve) => setTimeout(resolve, 500));
    }

    /** The ephemeral producer: prepared, standing and memory injections, flags, onSend agents, a pending fix. */
    async produce(gen: GenerationInfo): Promise<void> {
        if (gen.dryRun || this.isGroup()) return;
        if (this.pendingFix) {
            this.app.ephemeral.setInjection(FIX_INJECTION, { text: this.pendingFix, position: 1, depth: 0, role: 0 });
            this.pendingFix = null;
        }
        if (gen.quiet) return;
        const active = this.store.activeAgents();
        if (!active.length) return;
        const anchor = this.anchorNow();
        const doc = this.state.doc;
        const stale: AgentDef[] = [];
        for (const { def } of active) {
            const prepared = doc.prepared[def.id];
            const standing = doc.standing[def.id];
            const injectOpts =
                def.result.type === 'inject'
                    ? def.result.options
                    : def.result.type === 'memory'
                      ? def.result.options.injectOptions
                      : null;
            if (prepared) {
                if (prepared.anchor === anchor.index && prepared.hash === anchor.hash) {
                    if (prepared.text && injectOpts) this.inject(def, prepared.text, injectOpts);
                    if (prepared.flags) this.setFlags(prepared.flags);
                } else {
                    stale.push(def);
                }
            }
            if (standing) {
                if (def.result.type === 'flags') {
                    try {
                        this.setFlags(JSON.parse(standing.text) as Record<string, string | number | boolean>);
                    } catch {
                        // a broken standing value: skipped
                    }
                } else if (injectOpts) this.inject(def, standing.text, injectOpts);
            }
            if (def.result.type === 'memory' && def.result.options.inject) {
                const memory = this.state.memory(def.id);
                const text = Object.entries(memory.fields)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join('\n');
                if (text) this.inject(def, text, def.result.options.injectOptions);
            }
        }
        if (stale.length && this.app.leader.isLeader() && anchor.index >= 0) {
            // The chat changed under the prepared results (swipe, edit): ready for the next turn at least.
            for (const def of stale) this.state.dropPrepared(def.id);
        }
        await this.runOnSend(gen);
    }

    private inject(def: AgentDef, text: string, options: InjectOptions): void {
        this.app.ephemeral.setInjection(`agent_${def.id}`, injectionSpec(text, options));
        this.app.ephemeral.setFlag(`maestro_agent_${agentVarName(def)}`, text);
    }

    private setFlags(flags: Record<string, string | number | boolean>): void {
        for (const [name, value] of Object.entries(flags)) this.app.ephemeral.setFlag(`maestro_a_${name}`, value);
    }

    /** «При отправке» agents: the generation waits for them (their timeout, «Не ждать»). */
    private async runOnSend(gen: GenerationInfo): Promise<void> {
        const agents = this.agentsFor('onSend');
        if (!agents.length) return;
        const chat = this.chat();
        let userIndex = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) {
                userIndex = i;
                break;
            }
        }
        const key = `${userIndex}:${textHash(chat[userIndex]?.mes)}`;
        let results = this.onSendCache.get(key);
        if (!results || gen.type === 'normal') {
            const controller = new AbortController();
            const timeout = Math.max(...agents.map(({ def }) => def.trigger.onSendTimeoutMs ?? 6000));
            const indicator = this.showIndicator(
                agents.map(({ def }) => def.name),
                () => controller.abort(),
            );
            const collected: { agentId: string; text?: string; flags?: Record<string, string | number | boolean> }[] =
                [];
            try {
                const done = await this.runSet(agents, {
                    phase: 'onSend',
                    reason: 'send',
                    signal: controller.signal,
                    timeoutMs: (def) => def.trigger.onSendTimeoutMs ?? timeout,
                });
                for (const { def, outcome } of done) {
                    if (outcome.run.reason === 'gate') continue;
                    this.noteFailure(def, outcome.run);
                    const output = outcome.output;
                    if (!outcome.run.ok || !output) continue;
                    if (output.type === 'inject') collected.push({ agentId: def.id, text: output.text });
                    else if (output.type === 'flags') collected.push({ agentId: def.id, flags: output.flags });
                    else await this.apply(def, outcome, undefined, 'schedule');
                }
            } finally {
                indicator();
            }
            results = collected;
            this.onSendCache.set(key, results);
        }
        for (const item of results) {
            const def = this.store.get(item.agentId);
            if (!def) continue;
            if (item.text && def.result.type === 'inject') this.inject(def, item.text, def.result.options);
            if (item.flags) this.setFlags(item.flags);
        }
    }

    /** The «агент работает» line at the send box with «Не ждать»; returns its remover. */
    private showIndicator(names: string[], skip: () => void): () => void {
        if (typeof document === 'undefined') return () => undefined;
        const form = document.querySelector('#send_form');
        if (!form) return () => undefined;
        const box = document.createElement('div');
        box.className = 'maestro-agent-wait';
        const label = document.createElement('span');
        label.textContent = this.t('m44.waiting', { names: names.join(', ') });
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button maestro-btn';
        button.textContent = this.t('m44.dontWait');
        button.addEventListener('click', () => skip());
        box.append(label, button);
        form.prepend(box);
        this.skipWait = skip;
        return () => {
            box.remove();
            if (this.skipWait === skip) this.skipWait = null;
        };
    }

    /* ------------------------------------------------------------ commit and schedule */

    private onCommitted(index: number): void {
        if (this.isGroup() || !this.app.leader.isLeader()) return;
        for (const { def } of this.agentsFor('commit')) {
            void this.app.tasks.enqueue({
                kind: RUN_TASK,
                dedupeKey: `agent:${def.id}:${index}`,
                payload: { agentId: def.id, phase: 'commit', reason: 'commit', focusIndex: index },
                ttlMs: 10 * 60_000,
            });
        }
        this.checkSchedule(index);
    }

    /** Queues the scheduled agents that are due (counter or event). */
    checkSchedule(index: number): void {
        if (this.isGroup() || !this.app.leader.isLeader()) return;
        const events = this.events;
        this.events = new Set();
        const batched: { id: string; reason: string }[] = [];
        for (const { def } of this.agentsFor('schedule')) {
            const last = this.state.doc.lastOk[def.id];
            const since = last ? index - last.index : index + 1;
            const due = isDue(def.trigger, { sinceLastOk: since, events });
            if (!due.due) continue;
            if (def.batch === true && def.result.type !== 'rewrite') {
                batched.push({ id: def.id, reason: due.reason ?? 'schedule' });
                continue;
            }
            void this.app.tasks.enqueue({
                kind: RUN_TASK,
                dedupeKey: `agent:${def.id}`,
                payload: {
                    agentId: def.id,
                    phase: 'schedule',
                    reason: due.reason ?? 'schedule',
                    focusIndex: index >= 0 ? index : undefined,
                },
                ttlMs: 30 * 60_000,
            });
        }
        if (batched.length) {
            void this.app.tasks.enqueue({
                kind: RUN_TASK,
                dedupeKey: `agents:${batched.map((item) => item.id).join(',')}`,
                payload: {
                    agentIds: batched.map((item) => item.id),
                    phase: 'schedule',
                    reason: batched[0]!.reason,
                    focusIndex: index >= 0 ? index : undefined,
                },
                ttlMs: 30 * 60_000,
            });
        }
    }

    private async runTask(payload: Record<string, unknown>): Promise<void> {
        if (Array.isArray(payload.agentIds)) {
            const phase = (typeof payload.phase === 'string' ? payload.phase : 'schedule') as AgentPhase;
            const focus = typeof payload.focusIndex === 'number' ? payload.focusIndex : undefined;
            const message = focus !== undefined ? this.chat()[focus] : undefined;
            const focusIndex = message && !message.is_user ? focus : undefined;
            const states = this.store.states();
            const list = payload.agentIds
                .filter((id): id is string => typeof id === 'string')
                .map((id) => ({ def: this.store.get(id), state: states.get(id) }))
                .filter((item): item is { def: AgentDef; state: AgentState } => Boolean(item.def && item.state?.on));
            const base: { phase: AgentPhase; reason: string; focusIndex?: number } = {
                phase,
                reason: String(payload.reason ?? phase),
            };
            if (focusIndex !== undefined) base.focusIndex = focusIndex;
            const done = await this.runSet(list, base);
            for (const { def, outcome } of done) {
                if (outcome.run.reason !== 'gate') await this.finishOutcome(def, outcome, focusIndex, phase);
            }
            return;
        }
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
        const def = this.store.get(agentId);
        if (!def) return;
        const state = this.store.states().get(agentId);
        if (!state?.on) return;
        const phase = (typeof payload.phase === 'string' ? payload.phase : 'schedule') as AgentPhase;
        const focus = typeof payload.focusIndex === 'number' ? payload.focusIndex : undefined;
        const message = focus !== undefined ? this.chat()[focus] : undefined;
        const focusIndex = message && !message.is_user ? focus : undefined;
        await this.runAgent(def, state, phase, String(payload.reason ?? phase), { focusIndex });
    }

    /* ------------------------------------------------------------ manual */

    /** «Запустить» (button, menu, slash command): a job with progress; on a message or at the end of the chat. */
    async runManual(
        agentId: string,
        options: { messageIndex?: number; extra?: string } = {},
    ): Promise<RunOutcome | null> {
        const def = this.store.get(agentId);
        if (!def) return null;
        const state = this.store.states().get(agentId);
        const chat = this.chat();
        let focusIndex = options.messageIndex;
        if (focusIndex === undefined) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i] && !chat[i]?.is_user && !chat[i]?.is_system) {
                    focusIndex = i;
                    break;
                }
            }
        }
        const job = this.app.jobs?.start({
            key: `agent:${agentId}`,
            title: this.t('m44.job', { name: def.name }),
            module: 'agents',
            cancellable: true,
        });
        if (this.app.jobs && !job) return null;
        try {
            const outcome = await this.runAgent(def, state, 'manual', 'manual', {
                focusIndex,
                interactive: true,
                extra: options.extra,
                signal: job?.signal,
            });
            if (outcome.run.ok) job?.finish(outcome.run.applied?.join(', ') || this.t('m44.job.nothing'));
            else job?.fail(this.t(`m44.error.${outcome.run.error ?? 'other'}`));
            if (outcome.run.ok && def.result.type === 'inject' && outcome.output?.type === 'inject') {
                // A manual injection is for the next turn.
                const anchor = this.anchorNext();
                this.state.setPrepared({
                    agentId,
                    anchor: anchor.index,
                    hash: anchor.hash,
                    at: this.now(),
                    text: outcome.output.text,
                });
            }
            return outcome;
        } catch (error) {
            job?.fail(String(error));
            throw error;
        }
    }

    /** «Пробный запуск»: the model answers, nothing is applied; the caller shows what would be done. */
    async test(def: AgentDef, focusIndex?: number): Promise<RunOutcome> {
        const state = this.store.states().get(def.id);
        return this.runner.run({
            def,
            state,
            phase: def.trigger.phase,
            reason: 'test',
            test: true,
            interactive: true,
            focusIndex,
        });
    }

    /* ------------------------------------------------------------ invalidation */

    private onInvalidated(payload: {
        messageIndex: number;
        reason: 'swiped' | 'deleted' | 'edited';
        removedAt?: number;
        removed?: number;
    }): void {
        const { messageIndex, reason } = payload;
        for (const [index, controller] of this.inflight) if (index >= messageIndex) controller.abort();
        const timer = this.fallbackTimers.get(messageIndex);
        if (timer) {
            clearTimeout(timer);
            this.fallbackTimers.delete(messageIndex);
        }
        this.state.invalidate(messageIndex, reason, payload.removedAt, payload.removed);
        for (const [agentId, prepared] of Object.entries(this.state.doc.prepared)) {
            if (prepared.anchor >= messageIndex && reason !== 'swiped') this.state.dropPrepared(agentId);
        }
    }

    /** Test helper and the view: the pending fix of an agent swipe. */
    pendingFixText(): string | null {
        return this.pendingFix;
    }
}
