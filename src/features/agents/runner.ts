// One agent run (plan §4.4 runner, §4.11): limits, the sources, the request (frame → sources → task → answer form),
// Maestro's LLM client with the agent's profile («свой» → «профиль агентов по умолчанию» → default) and reasoning, the
// answer read by its type, the run log. Nothing is applied here: the runtime decides what a result does.
import { storyLanguage } from '../../core/language';
import { DEFAULT_MODEL, REWRITE_MIN_TOKENS } from '../../domain/agents/def';
import { parseAgentOutput } from '../../domain/agents/output';
import type { AgentOutput } from '../../domain/agents/output';
import { answerSchema, buildAgentMessages } from '../../domain/agents/request';
import type { AgentMessage } from '../../domain/agents/request';
import { protect } from '../../domain/agents/rewrite';
import type { Protected } from '../../domain/agents/rewrite';
import type { AgentDef, AgentErrorKind, AgentPhase, AgentRun, AgentState } from '../../domain/agents/types';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { App, LlmResult, Logger } from '../../shared/contracts';
import type { AgentsChatState } from './chat-state';
import type { SourceRegistry } from './sources';

/** Profile row of «профиль агентов по умолчанию» (CoreSettings.profiles, plan В7). */
export const AGENTS_PROFILE_KEY = 'agents';

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

    /** The messages of a run (and what was cut out of a reply for a rewrite). */
    async build(request: Omit<RunRequest, 'reason' | 'phase'> & { phase?: AgentPhase }): Promise<{
        messages: AgentMessage[];
        protectedReply?: Protected;
        originalText?: string;
        sourceChars: { id: string; chars: number }[];
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
