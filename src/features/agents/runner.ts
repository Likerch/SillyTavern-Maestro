// One agent run (plan §4.4 runner, §4.11): limits, the sources, the request (frame → sources → task → answer form),
// Maestro's LLM client with the agent's profile («свой» → «профиль агентов по умолчанию» → default) and reasoning, the
// answer read by its type, the run log. Nothing is applied here: the runtime decides what a result does.
import { storyLanguage } from '../../core/language';
import { DEFAULT_MODEL, REWRITE_MIN_TOKENS } from '../../domain/agents/def';
import { parseAgentOutput } from '../../domain/agents/output';
import type { AgentOutput } from '../../domain/agents/output';
import {
    batchSchema,
    buildBatchMessages,
    BATCH_MAX_TOKENS,
    costShares,
    groupBy,
    splitBatch,
} from '../../domain/agents/batch';
import type { BatchItem } from '../../domain/agents/batch';
import { answerSchema, buildAgentMessages } from '../../domain/agents/request';
import type { AgentMessage, RenderedSource } from '../../domain/agents/request';
import { protect } from '../../domain/agents/rewrite';
import type { Protected } from '../../domain/agents/rewrite';
import type { AgentDef, AgentErrorKind, AgentPhase, AgentRun, AgentState } from '../../domain/agents/types';
import type { App, LlmResult, Logger } from '../../shared/contracts';
import type { AgentsChatState } from './chat-state';
import { agentText as cleanForAnalysis } from './sources';
import type { SourceRegistry } from './sources';

/** Profile row of «профиль агентов по умолчанию» (CoreSettings.profiles, plan В7). */
export const AGENTS_PROFILE_KEY = 'agents';

/** Single runs of one moment at most at the same time (a batch counts as one). */
const MAX_SOLO_PARALLEL = 3;

export function agentTask(id: string): string {
    return `agent.${id}`;
}

export interface RunRequest {
    def: AgentDef;
    state?: AgentState;
    phase: AgentPhase;
    reason: string;
    /** The reply the agent works on (post phase, manual on a message). */
    focusIndex?: number;
    /** A test run: the log says so and the caller applies nothing. */
    test?: boolean;
    /** The user waits for it (manual, test): the background cap does not stop it. */
    interactive?: boolean;
    /** A one-off addition to the task. */
    extra?: string;
    signal?: AbortSignal;
    /** Cut the run after this many ms (onSend). */
    timeoutMs?: number;
}

export interface RunOutcome {
    run: AgentRun;
    output?: AgentOutput;
    /** A rewrite: the reply as it was and without its service blocks. */
    protectedReply?: Protected;
    originalText?: string;
}

/** Builds the request without sending it («Что увидит агент»). */
export interface Preview {
    messages: AgentMessage[];
    chars: number;
    tokens: number;
    sources: { id: string; chars: number }[];
}

export class AgentRunner {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly sources: SourceRegistry,
        private readonly state: AgentsChatState,
        private readonly now: () => number = Date.now,
    ) {}

    private languageWord(): string {
        try {
            return storyLanguage(this.app) === 'ru' ? 'Russian' : 'English';
        } catch {
            return 'the language of the story';
        }
    }

    private names(): { char: string; user: string } {
        try {
            const ctx = this.app.host.ctx();
            return { char: ctx.name2 || 'the character', user: ctx.name1 || 'the player' };
        } catch {
            return { char: 'the character', user: 'the player' };
        }
    }

    private instructionOf(def: AgentDef, state: AgentState | undefined): string {
        const variant = state?.variant ? def.variants?.find((item) => item.id === state.variant) : undefined;
        const raw = variant?.instruction ?? def.instruction;
        // ST's own macros ({{getvar::…}}, {{time}}…) after ours are left in place by substitute().
        try {
            const ctx = this.app.host.ctx();
            if (typeof ctx.substituteParams === 'function') {
                const guarded = raw.replace(
                    /\{\{\s*(agent\.[^}]+|source:[^}]+|язык_истории|story_language|char|user)\s*\}\}/gi,
                    '⟦maestro:$1⟧',
                );
                return ctx.substituteParams(guarded).replace(/⟦maestro:([^⟧]*)⟧/g, '{{$1}}');
            }
        } catch {
            // the host cannot substitute: our placeholders still work
        }
        return raw;
    }

    /** The rendered sources of a run (and what was cut out of a reply for a rewrite). */
    private async renderFor(request: Omit<RunRequest, 'reason' | 'phase'>): Promise<{
        rendered: RenderedSource[];
        protectedReply?: Protected;
        originalText?: string;
    }> {
        const { def } = request;
        const chat = this.app.host.ctx().chat ?? [];
        let replyText: string | undefined;
        let protectedReply: Protected | undefined;
        let originalText: string | undefined;
        const focus = request.focusIndex;
        if (def.result.type === 'rewrite' && focus !== undefined) {
            const message = chat[focus];
            originalText = typeof message?.mes === 'string' ? message.mes : '';
            protectedReply = protect(originalText);
            replyText = protectedReply.text;
        } else if (focus !== undefined && chat[focus]) {
            replyText = cleanForAnalysis(chat[focus]);
        }
        const refs = [...def.sources];
        if (def.result.type === 'rewrite' && !refs.some((ref) => ref.id === 'reply')) refs.push({ id: 'reply' });
        const rendered = await this.sources.render(refs, {
            app: this.app,
            agentId: def.id,
            focusIndex: focus,
            replyText,
            state: this.state,
        });
        const out: { rendered: RenderedSource[]; protectedReply?: Protected; originalText?: string } = { rendered };
        if (protectedReply) out.protectedReply = protectedReply;
        if (originalText !== undefined) out.originalText = originalText;
        return out;
    }

    /** The messages of a run (and what was cut out of a reply for a rewrite). */
    async build(request: Omit<RunRequest, 'reason' | 'phase'> & { phase?: AgentPhase }): Promise<{
        messages: AgentMessage[];
        protectedReply?: Protected;
        originalText?: string;
        sourceChars: { id: string; chars: number }[];
    }> {
        const { def } = request;
        const { rendered, protectedReply, originalText } = await this.renderFor(request);
        const messages = buildAgentMessages({
            def,
            variantInstruction: this.instructionOf(def, request.state),
            sources: rendered,
            values: { ...this.names(), language: this.languageWord() },
            extra: request.extra,
        });
        return {
            messages,
            protectedReply,
            originalText,
            sourceChars: rendered.map((source) => ({ id: source.id, chars: source.text.length })),
        };
    }

    async preview(def: AgentDef, state?: AgentState, focusIndex?: number): Promise<Preview> {
        const built = await this.build({ def, state, focusIndex });
        const chars = built.messages.reduce((sum, message) => sum + message.content.length, 0);
        return { messages: built.messages, chars, tokens: Math.ceil(chars / 4), sources: built.sourceChars };
    }

    /** Today's spend of an agent from the run log (limits.dailyUsd). */
    spentToday(agentId: string): number {
        const start = new Date(this.now());
        start.setHours(0, 0, 0, 0);
        return this.state
            .runs()
            .filter((run) => run.agentId === agentId && run.startedAt >= start.getTime())
            .reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    }

    private limitHit(request: RunRequest): boolean {
        const limits = request.def.limits;
        if (!limits || request.test || request.interactive) return false;
        if (limits.dailyUsd && this.spentToday(request.def.id) >= limits.dailyUsd) return true;
        if (limits.perTurn) {
            const turn = this.app.host.ctx().chat?.length ?? 0;
            if (this.state.countTurn(request.def.id, turn) > limits.perTurn) return true;
        }
        return false;
    }

    private maxTokensOf(def: AgentDef): number {
        const base =
            def.model.maxTokens ??
            (def.result.type === 'rewrite'
                ? REWRITE_MIN_TOKENS
                : def.result.type === 'memory'
                  ? 1200
                  : DEFAULT_MODEL.maxTokens);
        return def.result.type === 'rewrite' ? Math.max(base, REWRITE_MIN_TOKENS) : base;
    }

    /** Whether a run may share a request with others (plan §4.6): the agent allows it, never a rewrite or a test. */
    static batchable(request: RunRequest): boolean {
        return request.def.batch === true && request.def.result.type !== 'rewrite' && !request.test;
    }

    /** Runs of one moment: batchable agents of the same model in one request each group, the rest one by one. */
    async runMany(requests: readonly RunRequest[]): Promise<RunOutcome[]> {
        const outcomes = new Map<RunRequest, RunOutcome>();
        const solo: RunRequest[] = [];
        const keyOf = (request: RunRequest) =>
            [
                request.state?.profile ?? request.def.model.profile ?? '',
                request.def.model.reasoning ?? DEFAULT_MODEL.reasoning,
                request.phase,
                request.focusIndex ?? '',
                request.interactive === true,
            ].join('|');
        const groups = groupBy(
            requests.filter((request) => AgentRunner.batchable(request)),
            keyOf,
        );
        for (const group of groups) {
            if (group.length < 2) solo.push(...group);
        }
        solo.push(...requests.filter((request) => !AgentRunner.batchable(request)));
        const queue = [...solo];
        const jobs: Promise<void>[] = Array.from({ length: Math.min(MAX_SOLO_PARALLEL, queue.length) }, async () => {
            for (let request = queue.shift(); request !== undefined; request = queue.shift())
                outcomes.set(request, await this.run(request));
        });
        for (const group of groups.filter((list) => list.length >= 2)) {
            jobs.push(
                this.runBatch(group).then((results) => {
                    group.forEach((request, index) => outcomes.set(request, results[index]!));
                }),
            );
        }
        await Promise.all(jobs);
        return requests.map((request) => outcomes.get(request)!);
    }

    /** One batch request; agents it did not answer properly are asked again one by one. */
    async runBatch(group: readonly RunRequest[]): Promise<RunOutcome[]> {
        const startedAt = this.now();
        const allowed = group.filter((request) => !this.limitHit(request));
        const results = new Map<RunRequest, RunOutcome>();
        for (const request of group.filter((item) => !allowed.includes(item))) {
            results.set(request, this.finishRun(this.newRun(request, startedAt), startedAt, {}, 'limit'));
        }
        if (allowed.length < 2) {
            for (const request of allowed) results.set(request, await this.run(request));
            return group.map((request) => results.get(request)!);
        }
        const items: BatchItem[] = [];
        const prepared: { protectedReply?: Protected; originalText?: string }[] = [];
        for (const [index, request] of allowed.entries()) {
            const rendered = await this.renderFor(request);
            prepared.push(rendered);
            const item: BatchItem = {
                key: `a${index + 1}`,
                name: request.def.name,
                instruction: this.instructionOf(request.def, request.state),
                result: request.def.result,
                sources: rendered.rendered,
            };
            if (request.def.vars) item.vars = request.def.vars;
            if (request.extra) item.extra = request.extra;
            items.push(item);
        }
        const messages = buildBatchMessages(items, { ...this.names(), language: this.languageWord() });
        const first = allowed[0]!;
        const controller = new AbortController();
        const forward = () => controller.abort();
        first.signal?.addEventListener('abort', forward, { once: true });
        const timeout = Math.max(0, ...allowed.map((request) => request.timeoutMs ?? 0));
        let timedOut = false;
        const timer = timeout
            ? setTimeout(() => {
                  timedOut = true;
                  controller.abort();
              }, timeout)
            : null;
        let result: LlmResult;
        try {
            result = await this.app.llm.request({
                task: 'agent.batch',
                messages,
                maxTokens: Math.min(
                    BATCH_MAX_TOKENS,
                    allowed.reduce((sum, request) => sum + this.maxTokensOf(request.def), 0),
                ),
                // One request has one temperature: the average of the batch.
                temperature:
                    Math.round(
                        (allowed.reduce(
                            (sum, request) => sum + (request.def.model.temperature ?? DEFAULT_MODEL.temperature),
                            0,
                        ) /
                            allowed.length) *
                            100,
                    ) / 100,
                reasoning: first.def.model.reasoning ?? DEFAULT_MODEL.reasoning,
                schema: batchSchema(items),
                profile: first.state?.profile ?? first.def.model.profile,
                profileKeys: [AGENTS_PROFILE_KEY],
                interactive: allowed.some((request) => request.interactive === true),
                signal: controller.signal,
            });
        } catch (error) {
            this.log.warn('agent batch failed', error);
            result = { ok: false, error: 'transport' };
        } finally {
            if (timer) clearTimeout(timer);
            first.signal?.removeEventListener('abort', forward);
        }
        const batchId = `b${startedAt.toString(36)}`;
        const shares = costShares(items.map((item) => item.instruction.length));
        const parts = result.ok
            ? splitBatch(
                  result.data,
                  items.map((item) => item.key),
              )
            : new Map<string, unknown>();
        const retry: RunRequest[] = [];
        for (const [index, request] of allowed.entries()) {
            const item = items[index]!;
            const run = this.newRun(request, startedAt);
            run.batchId = batchId;
            run.request = messages.map((message) => ({ role: message.role, content: message.content }));
            if (result.costUsd !== undefined) run.costUsd = result.costUsd * shares[index]!;
            if (result.tokens)
                run.tokens = {
                    prompt: Math.round(result.tokens.prompt * shares[index]!),
                    completion: Math.round(result.tokens.completion * shares[index]!),
                };
            if (!result.ok) {
                // A broken batch answer is asked again agent by agent; a transport failure or a timeout is not.
                if (result.error === 'parse' && !timedOut) {
                    retry.push(request);
                    continue;
                }
                results.set(request, this.finishRun(run, startedAt, {}, timedOut ? 'timeout' : errorKind(result)));
                continue;
            }
            const part = parts.get(item.key);
            const parsed =
                part === undefined
                    ? null
                    : parseAgentOutput(request.def.result, part, typeof part === 'string' ? part : undefined);
            if (!parsed || !parsed.ok) {
                retry.push(request);
                continue;
            }
            run.raw = typeof part === 'string' ? part : JSON.stringify(part);
            run.ok = true;
            run.result = parsed.output;
            const outcome: Omit<RunOutcome, 'run'> = { output: parsed.output };
            const extra = prepared[index]!;
            if (extra.protectedReply) outcome.protectedReply = extra.protectedReply;
            if (extra.originalText !== undefined) outcome.originalText = extra.originalText;
            results.set(request, this.finishRun(run, startedAt, outcome));
        }
        for (const request of retry)
            results.set(request, await this.run({ ...request, reason: `${request.reason}:retry` }));
        return group.map((request) => results.get(request)!);
    }

    private newRun(request: RunRequest, startedAt: number): AgentRun {
        const chat = this.app.host.ctx().chat ?? [];
        const focusMessage = request.focusIndex !== undefined ? chat[request.focusIndex] : undefined;
        const run: AgentRun = {
            id: `${startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            agentId: request.def.id,
            agentName: request.def.name,
            chatId: this.app.host.chatId(),
            phase: request.phase,
            reason: request.reason,
            startedAt,
            ms: 0,
            ok: false,
        };
        if (request.focusIndex !== undefined) run.messageIndex = request.focusIndex;
        if (focusMessage && typeof focusMessage.swipe_id === 'number') run.swipeId = focusMessage.swipe_id;
        if (request.test) run.test = true;
        return run;
    }

    private finishRun(
        run: AgentRun,
        startedAt: number,
        outcome: Omit<RunOutcome, 'run'>,
        error?: AgentErrorKind,
    ): RunOutcome {
        if (error) {
            run.ok = false;
            run.error = error;
        }
        run.ms = this.now() - startedAt;
        this.state.addRun(run);
        return { run, ...outcome };
    }

    async run(request: RunRequest): Promise<RunOutcome> {
        const { def } = request;
        const startedAt = this.now();
        const chat = this.app.host.ctx().chat ?? [];
        const focusMessage = request.focusIndex !== undefined ? chat[request.focusIndex] : undefined;
        const run: AgentRun = {
            id: `${startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
            agentId: def.id,
            agentName: def.name,
            chatId: this.app.host.chatId(),
            phase: request.phase,
            reason: request.reason,
            startedAt,
            ms: 0,
            ok: false,
        };
        if (request.focusIndex !== undefined) run.messageIndex = request.focusIndex;
        if (focusMessage && typeof focusMessage.swipe_id === 'number') run.swipeId = focusMessage.swipe_id;
        if (request.test) run.test = true;
        const finish = (outcome: Omit<RunOutcome, 'run'> = {}): RunOutcome => {
            run.ms = this.now() - startedAt;
            this.state.addRun(run);
            return { run, ...outcome };
        };
        if (this.limitHit(request)) {
            run.error = 'limit';
            return finish();
        }

        let built: Awaited<ReturnType<AgentRunner['build']>>;
        try {
            built = await this.build(request);
        } catch (error) {
            this.log.warn(`agent ${def.id}: request not built`, error);
            run.error = 'other';
            return finish();
        }
        run.request = built.messages.map((message) => ({ role: message.role, content: message.content }));

        const controller = new AbortController();
        const outer = request.signal;
        const forward = () => controller.abort();
        outer?.addEventListener('abort', forward, { once: true });
        let timedOut = false;
        const timer =
            request.timeoutMs !== undefined
                ? setTimeout(() => {
                      timedOut = true;
                      controller.abort();
                  }, request.timeoutMs)
                : null;
        const maxTokens =
            def.model.maxTokens ??
            (def.result.type === 'rewrite'
                ? REWRITE_MIN_TOKENS
                : def.result.type === 'memory'
                  ? 1200
                  : DEFAULT_MODEL.maxTokens);
        let result: LlmResult;
        try {
            result = await this.app.llm.request({
                task: agentTask(def.id),
                messages: built.messages,
                maxTokens: def.result.type === 'rewrite' ? Math.max(maxTokens, REWRITE_MIN_TOKENS) : maxTokens,
                temperature: def.model.temperature ?? DEFAULT_MODEL.temperature,
                reasoning: def.model.reasoning ?? DEFAULT_MODEL.reasoning,
                schema: answerSchema(def.result),
                profile: request.state?.profile ?? def.model.profile,
                profileKeys: [AGENTS_PROFILE_KEY],
                interactive: request.interactive === true || request.test === true,
                signal: controller.signal,
            });
        } catch (error) {
            this.log.warn(`agent ${def.id}: request failed`, error);
            result = { ok: false, error: 'transport' };
        } finally {
            if (timer) clearTimeout(timer);
            outer?.removeEventListener('abort', forward);
        }
        if (result.costUsd !== undefined) run.costUsd = result.costUsd;
        if (result.tokens) run.tokens = result.tokens;
        if (result.text !== undefined) run.raw = result.text.slice(0, 20_000);
        if (!result.ok) {
            run.error = timedOut ? 'timeout' : errorKind(result);
            return finish();
        }
        const parsed = parseAgentOutput(def.result, result.data, result.text);
        if (!parsed.ok) {
            run.error = parsed.error;
            return finish();
        }
        run.ok = true;
        run.result = parsed.output;
        const outcome: Omit<RunOutcome, 'run'> = { output: parsed.output };
        if (built.protectedReply) outcome.protectedReply = built.protectedReply;
        if (built.originalText !== undefined) outcome.originalText = built.originalText;
        if (result.truncated && def.result.type === 'rewrite') {
            run.ok = false;
            run.error = 'length';
            delete outcome.output;
        }
        return finish(outcome);
    }
}

function errorKind(result: LlmResult): AgentErrorKind {
    if (result.refusal) return 'refusal';
    switch (result.error) {
        case 'cap':
            return 'cap';
        case 'no-profile':
        case 'no-cm':
            return 'no-profile';
        case 'aborted':
            return 'aborted';
        case 'parse':
            return 'parse';
        case 'length':
            return 'length';
        case 'empty':
            return 'empty';
        case 'refusal':
            return 'refusal';
        default:
            return result.error?.startsWith('transport') || result.error === 'breaker-open' ? 'transport' : 'other';
    }
}
