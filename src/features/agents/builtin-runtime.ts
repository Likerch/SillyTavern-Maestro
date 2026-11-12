// Built-in agents at work (plan §4.8, release 1.29): an interceptor of Maestro's LLM client. A request whose task is a
// registered built-in agent gets the user's instruction in place of the default text and his model parameters; with
// nothing changed the request goes out as the very same object (byte for byte as in 1.27). Every request of a
// built-in agent goes to the run log of the chat with its cost, request and answer.
import { builtInAgent } from '../../core/builtin-agents';
import type { BuiltInAgentSpec } from '../../core/builtin-agents';
import { applyInstruction } from '../../domain/agents/builtin';
import type { AgentErrorKind, AgentReasoning, AgentRun } from '../../domain/agents/types';
import type { App, LlmInterceptor, LlmRequest, LlmResult, Unsubscribe } from '../../shared/contracts';
import type { BuiltinRunReport } from './api';
import type { AgentsChatState } from './chat-state';
import type { AgentStore } from './store';

export function builtinName(app: App, spec: BuiltInAgentSpec): string {
    return app.i18n.t(`m44.bi.${spec.id}.title`);
}

function errorOf(result: LlmResult): AgentErrorKind {
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
        default:
            return result.error?.startsWith('transport') || result.error === 'breaker-open' ? 'transport' : 'other';
    }
}

/** The request with the user's changes of a built-in agent; the same object when there are none. */
export function interceptBuiltin(request: LlmRequest, store: AgentStore): LlmRequest {
    const spec = builtInAgent(request.task);
    if (!spec) return request;
    const override = store.builtinOverride(spec.id);
    if (!override) return request;
    let defaults: string[];
    try {
        defaults = spec.defaultInstructions();
    } catch {
        defaults = [];
    }
    const applied = applyInstruction(request.messages, defaults, override);
    const next: LlmRequest = { ...request };
    if (applied.placed !== 'unchanged') next.messages = applied.messages as LlmRequest['messages'];
    if (override.temperature !== undefined) next.temperature = override.temperature;
    if (override.maxTokens !== undefined) next.maxTokens = override.maxTokens;
    if (override.reasoning !== undefined) next.reasoning = override.reasoning;
    return next;
}

/** Release 1.34: the instruction and parameters of a built-in agent on a neighbour's own channel. */
export function ownChannelInstruction(
    store: AgentStore,
    id: string,
    defaultText: string,
): { text: string; temperature?: number; maxTokens?: number; reasoning?: AgentReasoning } {
    const override = builtInAgent(id) ? store.builtinOverride(id) : undefined;
    if (!override) return { text: defaultText };
    const applied = applyInstruction([{ role: 'system', content: defaultText }], [defaultText], override);
    const first = applied.messages[0];
    const out: { text: string; temperature?: number; maxTokens?: number; reasoning?: AgentReasoning } = {
        text: typeof first?.content === 'string' ? first.content : defaultText,
    };
    if (override.temperature !== undefined) out.temperature = override.temperature;
    if (override.maxTokens !== undefined) out.maxTokens = override.maxTokens;
    if (override.reasoning !== undefined) out.reasoning = override.reasoning;
    return out;
}

/** Release 1.34: a neighbour's run on its own channel into the run log. */
export function reportedRun(
    app: App,
    spec: BuiltInAgentSpec,
    report: BuiltinRunReport,
    now: () => number = Date.now,
): AgentRun {
    const ms = Math.max(0, Number(report.ms) || 0);
    const startedAt = now() - ms;
    const run: AgentRun = {
        id: `${startedAt.toString(36)}-n${Math.floor(Math.random() * 1e6).toString(36)}`,
        agentId: spec.id,
        agentName: builtinName(app, spec),
        chatId: app.host.chatId(),
        phase: spec.interactive ? 'manual' : 'schedule',
        reason: 'builtin',
        startedAt,
        ms,
        ok: report.ok === true,
        builtin: true,
    };
    if (!run.ok) run.error = 'other';
    if (typeof report.costUsd === 'number') run.costUsd = report.costUsd;
    if (report.tokens) run.tokens = report.tokens;
    if (Array.isArray(report.request))
        run.request = report.request
            .filter((m) => typeof m?.content === 'string')
            .map((m) => ({ role: String(m.role), content: m.content.slice(0, 20_000) }));
    if (typeof report.raw === 'string') run.raw = report.raw.slice(0, 20_000);
    return run;
}

export function installBuiltinRuntime(
    app: App,
    store: AgentStore,
    state: AgentsChatState,
    now: () => number = Date.now,
): Unsubscribe {
    const interceptor: LlmInterceptor = {
        before: (request) => interceptBuiltin(request, store),
        after: (request, result, ms) => {
            const spec = builtInAgent(request.task);
            if (!spec) return;
            const startedAt = now() - ms;
            const run: AgentRun = {
                id: `${startedAt.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
                agentId: spec.id,
                agentName: builtinName(app, spec),
                chatId: app.host.chatId(),
                phase: spec.interactive ? 'manual' : 'schedule',
                reason: 'builtin',
                startedAt,
                ms,
                ok: result.ok,
                builtin: true,
                request: request.messages.map((message) => ({ role: message.role, content: message.content })),
            };
            if (!result.ok) run.error = errorOf(result);
            if (result.costUsd !== undefined) run.costUsd = result.costUsd;
            if (result.tokens) run.tokens = result.tokens;
            if (result.text !== undefined) run.raw = result.text.slice(0, 20_000);
            if (result.ok && result.data !== undefined && typeof result.data !== 'string') run.result = result.data;
            state.addRun(run);
        },
    };
    return app.llm.addInterceptor?.(interceptor) ?? (() => undefined);
}
