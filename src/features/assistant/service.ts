// The assistant's loop (M33): the user's message → the model (task kind 'assistant', its own profile, the offered
// tools as OpenAI functions) → tool calls → results back → … until the model answers. Read tools run with a
// timeout; their output is capped, secrets are redacted and untrusted content is wrapped as <data>. Write tools
// only plan: the plan waits as a before/after card for the user's confirm(), and only an accepted plan is applied.
// Limits per send: 10 tool rounds, 5 proposed changes; per chat: applied changes per hour; one send at a time.
// Never ST's tool calling (the role-play model would see those tools): requests go through app.llm.
import { TOOL_NAME, argProblems, functionSpec, readToolCalls, wireCall } from '../../domain/assistant-calls';
import type { ParsedCall } from '../../domain/assistant-calls';
import { buildHistory, clip } from '../../domain/assistant-history';
import { capText, redactSecrets, serializeToolData, toolResultText, writesLeft } from '../../domain/assistant-safety';
import type { App, LlmMessage, LlmResult, Logger, Unsubscribe } from '../../shared/contracts';
import type {
    AssistantApi,
    AssistantMessage,
    SettingsAccess,
    ToolCallRecord,
    ToolContext,
    ToolKind,
    ToolOutput,
    ToolSpec,
    WritePlan,
} from './api';
import { buildSystemPrompt, earlierSection } from './prompt';
import { ASSISTANT_TASK } from './settings';
import type { AssistantSettings } from './settings';
import { AssistantStore, STORED_RESULT_CHARS, compactArgs, compactValue } from './store';

/** Model responses with tool calls per user message. */
export const MAX_ROUNDS = 10;
/** Proposed changes (write cards) per user message. */
export const MAX_WRITES = 5;
/** How long a read tool (or a write tool's plan) may take. */
export const TOOL_TIMEOUT_MS = 30_000;
/** Newest turns whose tool calls and results stay in the context. */
export const FULL_TURNS = 3;
/** What the model learns of an applied change's result. */
const APPLIED_RESULT_CHARS = 1000;

export const ROUND_LIMIT_NOTE =
    '[Maestro] Tool round limit for this message reached: do not call tools again; answer the user now with what ' +
    'you have and say what is left to check.';

export interface AssistantDeps {
    app: App;
    log: Logger;
    /** The module's settings (read on every send). */
    settings: () => AssistantSettings;
    access: SettingsAccess;
    now?: () => number;
    toolTimeoutMs?: number;
}

interface Decision {
    promise: Promise<boolean>;
    resolve(accept: boolean): void;
    /** Settles once the loop has applied or closed the card. */
    done: Promise<void>;
    finish(): void;
}

interface Run {
    controller: AbortController;
    /** Chat the send belongs to: writes after a chat switch are dropped. */
    chatId: string | null;
    offered: Map<string, ToolSpec>;
    writes: number;
}

class Stopped extends Error {
    constructor() {
        super('stopped');
        this.name = 'Stopped';
    }
}

class TimedOut extends Error {
    constructor() {
        super('timeout');
        this.name = 'TimedOut';
    }
}

/** Runs `work` until it settles, the timeout passes or the signal aborts (the work itself is not cancelled). */
function guard<T>(work: () => Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
            reject(new Stopped());
            return;
        }
        let settled = false;
        const finish = (settle: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            settle();
        };
        const onAbort = () => finish(() => reject(new Stopped()));
        const timer = setTimeout(() => finish(() => reject(new TimedOut())), ms);
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve()
            .then(work)
            .then(
                (value) => finish(() => resolve(value)),
                (error: unknown) => finish(() => reject(error)),
            );
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asOutput(value: unknown): ToolOutput {
    if (isRecord(value) && 'data' in value) return value as unknown as ToolOutput;
    return { data: value ?? null };
}

function isPlan(value: unknown): value is WritePlan {
    return (
        isRecord(value) &&
        typeof value['summary'] === 'string' &&
        typeof value['target'] === 'string' &&
        typeof value['apply'] === 'function'
    );
}

function dropUndefined<T extends object>(value: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
    return out as Partial<T>;
}

const FINAL: ReadonlySet<ToolCallRecord['status']> = new Set(['ok', 'error', 'applied', 'declined']);

export class AssistantService implements AssistantApi {
    readonly store: AssistantStore;
    private readonly registry = new Map<string, ToolSpec>();
    private readonly pending = new Map<string, Decision>();
    private readonly liveCalls = new Set<string>();
    private readonly listeners = new Set<() => void>();
    private run: Run | null = null;
    private running: Promise<void> | null = null;
    private counter = 0;

    constructor(private readonly deps: AssistantDeps) {
        this.store = new AssistantStore(deps.app, deps.log, () => this.liveCalls);
    }

    /** Subscriptions (owned by the module): store changes, chat switches. */
    start(): Unsubscribe {
        const offStore = this.store.onChange(() => this.emit());
        const offChat = this.deps.app.bus.on('chat:changed', () => {
            this.stop();
            this.store.reset();
        });
        void this.store
            .load()
            .catch((error: unknown) => this.deps.log.warn('assistant conversation not loaded', error));
        return () => {
            offStore();
            offChat();
            this.stop();
            this.listeners.clear();
        };
    }

    /* ---------------------------------------------------------------- AssistantApi */

    conversation(): AssistantMessage[] {
        return [...this.store.current().messages];
    }

    busy(): boolean {
        return this.run !== null;
    }

    /** Whether a write card is waiting for this tab's loop (a stale card from a reload is not). */
    awaiting(callId: string): boolean {
        return this.pending.has(callId);
    }

    tools(): { name: string; kind: ToolKind; description: string }[] {
        return this.offered().map((tool) => ({ name: tool.name, kind: tool.kind, description: tool.description }));
    }

    registerTool(tool: ToolSpec): Unsubscribe {
        const valid =
            isRecord(tool) &&
            typeof tool.name === 'string' &&
            TOOL_NAME.test(tool.name) &&
            ((tool.kind === 'read' && typeof tool.run === 'function') ||
                (tool.kind === 'write' && typeof tool.plan === 'function'));
        if (!valid) {
            this.deps.log.warn('assistant tool rejected (name, kind and run/plan are required)', tool?.name);
            return () => {};
        }
        if (this.registry.has(tool.name)) this.deps.log.warn(`assistant tool ${tool.name} registered again; replaced`);
        this.registry.set(tool.name, tool);
        this.emit();
        return () => {
            if (this.registry.get(tool.name) !== tool) return;
            this.registry.delete(tool.name);
            this.emit();
        };
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async send(text: string): Promise<void> {
        const question = typeof text === 'string' ? text.trim() : '';
        if (!question) return;
        if (this.run) {
            this.deps.log.debug('assistant is busy; message ignored');
            return;
        }
        const run: Run = {
            controller: new AbortController(),
            chatId: this.deps.app.host.chatId(),
            offered: new Map(this.offered().map((tool) => [tool.name, tool])),
            writes: 0,
        };
        this.run = run;
        let finished!: () => void;
        this.running = new Promise<void>((resolve) => (finished = resolve));
        this.emit();
        try {
            const previous = [...(await this.store.load()).messages];
            await this.append(run, { role: 'user', text: question });
            await this.loop(run, previous, question);
        } catch (error) {
            this.deps.log.error('assistant loop failed', error);
            await this.notice(run, this.t('m33.error.internal')).catch(() => undefined);
        } finally {
            for (const decision of [...this.pending.values()]) decision.resolve(false);
            this.run = null;
            this.running = null;
            finished();
            this.emit();
        }
    }

    stop(): void {
        const run = this.run;
        if (!run) return;
        run.controller.abort();
        for (const decision of [...this.pending.values()]) decision.resolve(false);
        this.emit();
    }

    async confirm(callId: string, accept: boolean): Promise<void> {
        const decision = this.pending.get(callId);
        if (decision) {
            decision.resolve(accept === true);
            await decision.done;
            return;
        }
        // A card left by an earlier session (or a second tap): nothing can apply it any more.
        await this.store.mutate((doc) => {
            for (const message of doc.messages) {
                const record = message.toolCalls?.find((call) => call.id === callId);
                if (record?.status === 'waiting' && !this.liveCalls.has(callId)) record.status = 'declined';
            }
        });
    }

    async clear(): Promise<void> {
        if (this.run) {
            this.stop();
            await this.running;
        }
        await this.store.clear();
    }

    /* ---------------------------------------------------------------- the loop */

    private async loop(run: Run, previous: AssistantMessage[], question: string): Promise<void> {
        const { app } = this.deps;
        const settings = this.deps.settings();
        const signal = run.controller.signal;
        const history = buildHistory(previous, { budgetTokens: settings.historyTokens, fullTurns: FULL_TURNS });
        const system = [
            buildSystemPrompt({
                locale: app.i18n.locale(),
                chatOpen: run.chatId !== null,
                stVersion: app.host.version(),
                mode: app.settings.core().mode,
            }),
            earlierSection(history.earlier, history.omitted),
        ]
            .filter(Boolean)
            .join('\n\n');
        const messages: LlmMessage[] = [
            { role: 'system', content: system },
            ...history.messages,
            { role: 'user', content: question },
        ];
        const specs = [...run.offered.values()].map(functionSpec);
        let rounds = 0;
        for (;;) {
            if (signal.aborted) {
                await this.notice(run, this.t('m33.notice.stopped'));
                return;
            }
            const result = await app.llm.request({
                task: ASSISTANT_TASK,
                messages,
                maxTokens: settings.maxTokens,
                tools: specs.length ? specs : undefined,
                signal,
            });
            const cost = typeof result.costUsd === 'number' ? result.costUsd : undefined;
            if (signal.aborted || result.error === 'aborted') {
                await this.notice(run, this.t('m33.notice.stopped'), cost);
                return;
            }
            const text = (result.text ?? '').trim();
            // A "refusal" with text is just an answer here (the assistant is not role-play).
            if (!result.ok && !(result.refusal && text)) {
                await this.notice(run, this.errorText(result), cost);
                return;
            }
            const calls = result.ok ? readToolCalls(result.toolCalls, () => this.id('call_')) : [];
            if (!calls.length) {
                if (text) await this.append(run, { role: 'assistant', text, costUsd: cost });
                else await this.notice(run, this.t('m33.error.empty'), cost);
                return;
            }
            rounds++;
            const messageId = this.id('m_');
            await this.append(run, {
                id: messageId,
                role: 'assistant',
                text,
                costUsd: cost,
                toolCalls: calls.map((call) => ({
                    id: call.id,
                    name: call.name || 'unknown_tool',
                    args: compactArgs(call.args),
                    status: 'running',
                })),
            });
            messages.push({ role: 'assistant', content: text, tool_calls: calls.map(wireCall) });
            if (rounds > MAX_ROUNDS) {
                for (const call of calls)
                    await this.patchCall(run, messageId, call.id, {
                        status: 'error',
                        error: this.t('m33.error.roundLimit'),
                    });
                await this.notice(run, this.t('m33.notice.roundLimit', { count: MAX_ROUNDS }));
                return;
            }
            for (const call of calls) {
                const content = signal.aborted
                    ? await this.closeCall(run, messageId, call, this.t('m33.error.stopped'), 'Not run: stopped.')
                    : await this.runCall(run, messageId, call);
                messages.push({ role: 'tool', tool_call_id: call.id, content });
            }
            const last = messages[messages.length - 1];
            if (rounds === MAX_ROUNDS && last) last.content += `\n\n${ROUND_LIMIT_NOTE}`;
        }
    }

    private async runCall(run: Run, messageId: string, call: ParsedCall): Promise<string> {
        const tool = run.offered.get(call.name);
        if (!tool) {
            const names = [...run.offered.keys()].join(', ') || 'none';
            return this.closeCall(
                run,
                messageId,
                call,
                this.t('m33.error.unknownTool', { name: call.name || '?' }),
                `Error: there is no tool named "${call.name}". Available tools: ${names}.`,
            );
        }
        if (call.error) {
            return this.closeCall(
                run,
                messageId,
                call,
                this.t('m33.error.badArgs'),
                `Error: ${call.error}. Call ${tool.name} again with a JSON object that matches its parameters.`,
            );
        }
        const problems = argProblems(call.args, tool.parameters);
        if (problems.length) {
            return this.closeCall(
                run,
                messageId,
                call,
                this.t('m33.error.badArgs'),
                `Error: invalid arguments for ${tool.name}: ${problems.join('; ')}.`,
            );
        }
        return tool.kind === 'write'
            ? this.runWrite(run, messageId, call, tool)
            : this.runRead(run, messageId, call, tool);
    }

    private async runRead(run: Run, messageId: string, call: ParsedCall, tool: ToolSpec): Promise<string> {
        const signal = run.controller.signal;
        try {
            const output = asOutput(
                await guard(() => tool.run!(call.args, this.context(signal)), this.timeout, signal),
            );
            const settings = this.deps.settings();
            const forModel = toolResultText(output, tool.name, settings.resultChars);
            await this.patchCall(run, messageId, call.id, {
                status: 'ok',
                summary: typeof output.summary === 'string' ? clip(output.summary, 200) : undefined,
                result: capText(redactSecrets(serializeToolData(output.data)), STORED_RESULT_CHARS),
                untrusted: output.untrusted === true ? true : undefined,
            });
            return forModel;
        } catch (error) {
            const message = this.failure(error);
            return this.closeCall(run, messageId, call, message, `Error: ${message}`);
        }
    }

    private async runWrite(run: Run, messageId: string, call: ParsedCall, tool: ToolSpec): Promise<string> {
        const signal = run.controller.signal;
        if (run.writes >= MAX_WRITES) {
            return this.closeCall(
                run,
                messageId,
                call,
                this.t('m33.error.writeLimit', { count: MAX_WRITES }),
                `Not done: the limit of ${MAX_WRITES} proposed changes per user message is reached. Do not propose ` +
                    'more changes now: summarise what was done and ask the user whether to continue.',
            );
        }
        const limit = this.deps.settings().writesPerHour;
        if (this.rateLimited(limit)) return this.rateLimitHit(run, messageId, call, limit);
        let plan: WritePlan;
        try {
            const planned = await guard(() => tool.plan!(call.args, this.context(signal)), this.timeout, signal);
            if (!isPlan(planned)) throw new Error(this.t('m33.error.badPlan'));
            plan = planned;
        } catch (error) {
            const message = this.failure(error);
            return this.closeCall(run, messageId, call, message, `Error: ${message} Nothing was changed.`);
        }
        // Only cards count: a plan the tool refused can be fixed and proposed again.
        run.writes++;
        await this.patchCall(run, messageId, call.id, {
            status: 'waiting',
            summary: clip(plan.summary, 300),
            target: clip(plan.target, 200),
            before: compactValue(plan.before),
            after: compactValue(plan.after),
        });
        const decision = this.waitFor(call.id, signal);
        try {
            const accepted = await decision.promise;
            if (!accepted) {
                await this.patchCall(run, messageId, call.id, { status: 'declined' });
                return signal.aborted
                    ? 'The user stopped the assistant before confirming. Nothing was changed.'
                    : 'The user declined this change. Nothing was changed. Do not propose it again unless the user asks.';
            }
            if (this.rateLimited(limit)) return await this.rateLimitHit(run, messageId, call, limit);
            let result: string | undefined;
            try {
                const outcome = await plan.apply();
                const value = isRecord(outcome) ? outcome['result'] : undefined;
                result =
                    value === undefined
                        ? undefined
                        : capText(redactSecrets(serializeToolData(value)), APPLIED_RESULT_CHARS);
            } catch (error) {
                const message = this.failure(error);
                return await this.closeCall(
                    run,
                    messageId,
                    call,
                    message,
                    `Error while applying: ${message} The change may not have been made; check before retrying.`,
                );
            }
            const stamp = this.now();
            await this.patchCall(run, messageId, call.id, { status: 'applied', result }, (doc, record) => {
                if (record.status !== 'applied') doc.writes.push(stamp);
            });
            return `Applied: ${plan.summary}${result ? `\nResult: ${result}` : ''}`;
        } finally {
            decision.finish();
        }
    }

    private rateLimited(limit: number): boolean {
        return writesLeft(this.store.current().writes, this.now(), limit) <= 0;
    }

    private rateLimitHit(run: Run, messageId: string, call: ParsedCall, limit: number): Promise<string> {
        return this.closeCall(
            run,
            messageId,
            call,
            this.t('m33.error.rateLimit', { count: limit }),
            `Not done: ${limit} changes were already applied in this chat during the last hour (the limit). Tell ` +
                "the user; they can wait or raise the limit in the assistant's settings.",
        );
    }

    /* ---------------------------------------------------------------- confirmations */

    private waitFor(callId: string, signal: AbortSignal): Decision {
        let resolve!: (accept: boolean) => void;
        let finish!: () => void;
        const promise = new Promise<boolean>((done) => (resolve = done));
        const done = new Promise<void>((settle) => (finish = settle));
        const decision: Decision = {
            promise,
            done,
            finish,
            resolve: (accept) => {
                if (this.pending.get(callId) === decision) this.pending.delete(callId);
                resolve(accept);
            },
        };
        this.pending.set(callId, decision);
        if (signal.aborted) decision.resolve(false);
        this.emit();
        return decision;
    }

    /* ---------------------------------------------------------------- conversation writes */

    private async append(run: Run, message: Omit<AssistantMessage, 'id' | 'at'> & { id?: string }): Promise<void> {
        const full = dropUndefined({ ...message, id: message.id ?? this.id('m_'), at: this.now() }) as AssistantMessage;
        for (const call of full.toolCalls ?? []) if (!FINAL.has(call.status)) this.liveCalls.add(call.id);
        await this.store.mutate((doc) => {
            if (!doc.messages.some((item) => item.id === full.id)) doc.messages.push(structuredClone(full));
        }, run.chatId);
    }

    private notice(run: Run, text: string, costUsd?: number): Promise<void> {
        return this.append(run, { role: 'notice', text, costUsd });
    }

    private async patchCall(
        run: Run,
        messageId: string,
        callId: string,
        patch: Partial<ToolCallRecord>,
        also?: (doc: { writes: number[] }, record: ToolCallRecord) => void,
    ): Promise<void> {
        const clean = dropUndefined(patch);
        await this.store.mutate((doc) => {
            const record = doc.messages
                .find((message) => message.id === messageId)
                ?.toolCalls?.find((call) => call.id === callId);
            if (!record) return;
            also?.(doc, record);
            Object.assign(record, clean);
        }, run.chatId);
        if (patch.status && FINAL.has(patch.status)) this.liveCalls.delete(callId);
    }

    /** Ends a call with an error: the chip shows `error`, the model gets `forModel`. */
    private async closeCall(
        run: Run,
        messageId: string,
        call: ParsedCall,
        error: string,
        forModel: string,
    ): Promise<string> {
        await this.patchCall(run, messageId, call.id, { status: 'error', error: clip(error, 300) });
        return forModel;
    }

    /* ---------------------------------------------------------------- helpers */

    private offered(): ToolSpec[] {
        return [...this.registry.values()].filter((tool) => {
            try {
                return tool.available ? tool.available(this.deps.app) === true : true;
            } catch (error) {
                this.deps.log.debug(`assistant tool ${tool.name}: available() failed`, error);
                return false;
            }
        });
    }

    private context(signal: AbortSignal): ToolContext {
        const { app, log, access } = this.deps;
        return { app, log, signal, locale: app.i18n.locale(), settings: access };
    }

    private get timeout(): number {
        return this.deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private id(prefix: string): string {
        this.counter += 1;
        const random = Math.floor(Math.random() * 36 ** 4).toString(36);
        return `${prefix}${this.now().toString(36)}${this.counter.toString(36)}${random}`;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.app.i18n.t(key, params);
    }

    /** A tool's failure in the user's language (tools throw user-language errors). */
    private failure(error: unknown): string {
        if (error instanceof Stopped) return this.t('m33.error.stopped');
        if (error instanceof TimedOut) return this.t('m33.error.timeout');
        const message = error instanceof Error ? error.message : String(error);
        return clip(redactSecrets(message || this.t('m33.error.toolFailed')), 300);
    }

    private errorText(result: LlmResult): string {
        const error = result.error ?? '';
        switch (error) {
            case 'no-profile':
                return this.t('m33.error.noProfile');
            case 'no-cm':
                return this.t('m33.error.noCm');
            case 'breaker-open':
                return this.t('m33.error.paused');
            case 'cap':
                return this.t('m33.error.cap');
            case 'refusal':
                return this.t('m33.error.refusal');
            case 'empty':
            case 'parse':
                return this.t('m33.error.empty');
            default:
                if (error.startsWith('transport:'))
                    return this.t('m33.error.transport', {
                        detail: clip(redactSecrets(error.slice('transport:'.length)), 160),
                    });
                return this.t('m33.error.failed', { detail: clip(redactSecrets(error || '?'), 160) });
        }
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.deps.log.error('assistant listener failed', error);
            }
        }
    }
}
