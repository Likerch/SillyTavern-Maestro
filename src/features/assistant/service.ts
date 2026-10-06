// The assistant's loop (M33): the user's message → the model (task kind 'assistant', its own profile, the offered
// tools as OpenAI functions) → tool calls → results back → … until the model answers. Read tools run with a
// timeout; their output is capped, secrets are redacted and untrusted content is wrapped as <data>. Write tools
// only plan: the plan waits as a before/after card for the user's confirm(), and only an accepted plan is applied.
// A plan may be a pack (several related changes on one card: the user keeps or clears each, one undo) and may offer
// a scope switch («Везде / Этот персонаж / Этот чат»); the user's choice reaches apply().
// Limits per send: 10 tool rounds, 5 cards (single changes or packs) and 20 changes in all; per chat: applied changes
// per hour; one send at a time. While the conversation works on a preset (a block attached from the Preset Studio, or
// preset tools in use) answers may be longer (PRESET_MAX_TOKENS): block texts travel in the calls' arguments.
// Never ST's tool calling (the role-play model would see those tools): requests go through app.llm.
import { TOOL_NAME, argProblems, functionSpec, readToolCalls, wireCall } from '../../domain/assistant-calls';
import type { ParsedCall } from '../../domain/assistant-calls';
import { buildHistory, clip } from '../../domain/assistant-history';
import { capText, redactSecrets, serializeToolData, toolResultText, writesLeft } from '../../domain/assistant-safety';
import type { App, LlmMessage, LlmResult, Logger, Unsubscribe } from '../../shared/contracts';
import { contextKey } from './api';
import type {
    ApplyChoice,
    AssistantApi,
    AssistantContextItem,
    AssistantMessage,
    ScopeOption,
    SettingsAccess,
    ToolCallItem,
    ToolCallRecord,
    ToolContext,
    ToolKind,
    ToolOutput,
    ToolSpec,
    WriteOutcome,
    WritePlan,
} from './api';
import { buildSystemPrompt, earlierSection } from './prompt';
import { ASSISTANT_TAB, ASSISTANT_TASK, ASSISTANT_WINDOW, PRESET_MAX_TOKENS } from './settings';
import type { AssistantSettings } from './settings';
import {
    AssistantStore,
    STORED_FULL_ITEM_CHARS,
    STORED_FULL_VALUE_CHARS,
    STORED_RESULT_CHARS,
    STORED_VALUE_CHARS,
    compactArgs,
    compactValue,
    normalizeContext,
} from './store';

/** Model responses with tool calls per user message. */
export const MAX_ROUNDS = 10;
/** Proposed cards (single changes or packs) per user message. */
export const MAX_WRITES = 5;
/** Proposed changes per user message, the items of packs counted one by one. */
export const MAX_CHANGES = 20;
/** How long a read tool (or a write tool's plan) may take. */
export const TOOL_TIMEOUT_MS = 30_000;
/** Newest turns whose tool calls and results stay in the context. */
export const FULL_TURNS = 3;
/** What the model learns of an applied change's result. */
const APPLIED_RESULT_CHARS = 1000;
/** Attached items per message. */
export const MAX_ATTACHMENTS = 5;
/** Tools of the preset work: using them (now or in the recent turns) puts the conversation in the preset mode. */
const PRESET_TOOL = /^(preset_|neighbour_)/;

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

interface Answer {
    accept: boolean;
    choice?: ApplyChoice;
}

interface Decision {
    promise: Promise<Answer>;
    resolve(answer: Answer): void;
    /** Settles once the loop has applied or closed the card. */
    done: Promise<void>;
    finish(): void;
}

interface Run {
    controller: AbortController;
    /** Chat the send belongs to: writes after a chat switch are dropped. */
    chatId: string | null;
    offered: Map<string, ToolSpec>;
    /** Cards proposed (a pack is one). */
    writes: number;
    /** Changes proposed (a pack counts its items). */
    changes: number;
    /** The conversation works on a preset: longer answers. */
    presetMode: boolean;
}

/** The line the model gets about what the user attached to a message. */
export function contextNote(items: readonly AssistantContextItem[]): string {
    if (!items.length) return '';
    const parts = items.map((item) =>
        item.kind === 'presetBlock'
            ? `the block with identifier "${item.identifier ?? ''}" of the preset "${item.preset}"`
            : `the preset "${item.preset}"`,
    );
    return (
        `[Attached by the user from the Preset Studio: ${parts.join('; ')}. The message is about it: read it with ` +
        'preset_block_read / preset_list (and preset_dry_run, preset_findings) before you answer or propose changes.]'
    );
}

/** A user message as the model reads it: the note about the attached items first. */
function withContext(text: string, items: readonly AssistantContextItem[] | undefined): string {
    const note = contextNote(items ?? []);
    return note ? `${note}\n\n${text}` : text;
}

/** True when the recent turns used the preset tools (the conversation goes on with a preset). */
function usedPresetTools(messages: readonly AssistantMessage[], turns = FULL_TURNS): boolean {
    let seen = 0;
    for (let index = messages.length - 1; index >= 0 && seen < turns; index--) {
        const message = messages[index];
        if (!message) continue;
        if (message.role === 'user') {
            if (message.context?.length) return true;
            seen++;
            continue;
        }
        if ((message.toolCalls ?? []).some((call) => PRESET_TOOL.test(call.name))) return true;
    }
    return false;
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
    if (
        !isRecord(value) ||
        typeof value['summary'] !== 'string' ||
        typeof value['target'] !== 'string' ||
        typeof value['apply'] !== 'function'
    ) {
        return false;
    }
    const items = value['items'];
    if (items === undefined) return true;
    if (!Array.isArray(items) || !items.length) return false;
    const ids = new Set<string>();
    for (const item of items) {
        if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['summary'] !== 'string') return false;
        if (ids.has(item['id'])) return false;
        ids.add(item['id']);
    }
    return true;
}

/** The scope options a plan offers (malformed ones dropped). */
function scopeOptions(plan: WritePlan): ScopeOption[] {
    return (plan.scopes ?? []).filter(
        (option) => isRecord(option) && typeof option.value === 'string' && typeof option.label === 'string',
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
    /** What the next message carries (chips in the composer). */
    private attached: AssistantContextItem[] = [];

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

    attach(item: AssistantContextItem): void {
        const clean = normalizeContext(item);
        if (!clean) {
            this.deps.log.debug('assistant: attachment rejected', item);
            return;
        }
        const key = contextKey(clean);
        this.attached = [...this.attached.filter((other) => contextKey(other) !== key), clean].slice(-MAX_ATTACHMENTS);
        this.emit();
    }

    detach(key: string): void {
        const next = this.attached.filter((item) => contextKey(item) !== key);
        if (next.length === this.attached.length) return;
        this.attached = next;
        this.emit();
    }

    attachments(): AssistantContextItem[] {
        return this.attached.map((item) => ({ ...item }));
    }

    /** Attaches the item and brings the assistant forward: its window when windows exist, else the pult's tab. */
    discuss(item: AssistantContextItem): void {
        this.attach(item);
        const ui = this.deps.app.ui;
        try {
            if (typeof ui.openWindow === 'function') ui.openWindow(ASSISTANT_WINDOW, { tab: ASSISTANT_TAB });
            else ui.openPult(ASSISTANT_TAB);
        } catch (error) {
            this.deps.log.warn('assistant could not be opened', error);
        }
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
            changes: 0,
            presetMode: false,
        };
        this.run = run;
        // The chips go with this message.
        const context = this.attached;
        this.attached = [];
        let finished!: () => void;
        this.running = new Promise<void>((resolve) => (finished = resolve));
        this.emit();
        try {
            const previous = [...(await this.store.load()).messages];
            await this.append(run, { role: 'user', text: question, context: context.length ? context : undefined });
            await this.loop(run, previous, question, context);
        } catch (error) {
            this.deps.log.error('assistant loop failed', error);
            await this.notice(run, this.t('m33.error.internal')).catch(() => undefined);
        } finally {
            for (const decision of [...this.pending.values()]) decision.resolve({ accept: false });
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
        for (const decision of [...this.pending.values()]) decision.resolve({ accept: false });
        this.emit();
    }

    async confirm(callId: string, accept: boolean, choice?: ApplyChoice): Promise<void> {
        const decision = this.pending.get(callId);
        if (decision) {
            decision.resolve({ accept: accept === true, choice });
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

    private async loop(
        run: Run,
        previous: AssistantMessage[],
        question: string,
        context: readonly AssistantContextItem[],
    ): Promise<void> {
        const { app } = this.deps;
        const settings = this.deps.settings();
        const signal = run.controller.signal;
        run.presetMode = context.length > 0 || usedPresetTools(previous);
        const earlier = previous.map((message) =>
            message.role === 'user' && message.context?.length
                ? { ...message, text: withContext(message.text, message.context) }
                : message,
        );
        const history = buildHistory(earlier, { budgetTokens: settings.historyTokens, fullTurns: FULL_TURNS });
        const system = [
            buildSystemPrompt({
                locale: app.i18n.locale(),
                chatOpen: run.chatId !== null,
                stVersion: app.host.version(),
                mode: app.settings.core().mode,
                presets: run.presetMode,
            }),
            earlierSection(history.earlier, history.omitted),
        ]
            .filter(Boolean)
            .join('\n\n');
        const messages: LlmMessage[] = [
            { role: 'system', content: system },
            ...history.messages,
            { role: 'user', content: withContext(question, context) },
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
                maxTokens: run.presetMode ? Math.max(settings.maxTokens, PRESET_MAX_TOKENS) : settings.maxTokens,
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
            if (calls.some((call) => PRESET_TOOL.test(call.name))) run.presetMode = true;
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
                `Not done: the limit of ${MAX_WRITES} proposed cards (single changes or packs) per user message is ` +
                    'reached. Do not propose more changes now: summarise what was done and ask the user whether to ' +
                    'continue.',
            );
        }
        if (run.changes >= MAX_CHANGES) return this.changeLimitHit(run, messageId, call, 1);
        const limit = this.deps.settings().writesPerHour;
        if (this.rateLimited(limit, 1)) return this.rateLimitHit(run, messageId, call, limit);
        let plan: WritePlan;
        try {
            const planned = await guard(() => tool.plan!(call.args, this.context(signal)), this.timeout, signal);
            if (!isPlan(planned)) throw new Error(this.t('m33.error.badPlan'));
            plan = planned;
        } catch (error) {
            const message = this.failure(error);
            return this.closeCall(run, messageId, call, message, `Error: ${message} Nothing was changed.`);
        }
        const size = plan.items ? plan.items.length : 1;
        if (run.changes + size > MAX_CHANGES) return this.changeLimitHit(run, messageId, call, size);
        // Only cards count: a plan the tool refused can be fixed and proposed again.
        run.writes++;
        run.changes += size;
        const max = plan.full ? STORED_FULL_VALUE_CHARS : STORED_VALUE_CHARS;
        const itemMax = plan.full ? STORED_FULL_ITEM_CHARS : STORED_VALUE_CHARS;
        const items: ToolCallItem[] | undefined = plan.items?.map(
            (item) =>
                dropUndefined({
                    id: item.id,
                    summary: clip(item.summary, 300),
                    target: typeof item.target === 'string' ? clip(item.target, 200) : undefined,
                    before: compactValue(item.before, itemMax),
                    after: compactValue(item.after, itemMax),
                }) as ToolCallItem,
        );
        const scopes = scopeOptions(plan);
        await this.patchCall(run, messageId, call.id, {
            status: 'waiting',
            summary: clip(plan.summary, 300),
            target: clip(plan.target, 200),
            before: compactValue(plan.before, max),
            after: compactValue(plan.after, max),
            items,
            scope: typeof plan.scope === 'string' ? plan.scope : undefined,
            scopes: scopes.length ? scopes : undefined,
        });
        const decision = this.waitFor(call.id, signal);
        try {
            const answer = await decision.promise;
            const choice = this.choiceOf(plan, answer.choice);
            if (!answer.accept || (plan.items && !choice.selected?.length)) {
                await this.patchCall(run, messageId, call.id, { status: 'declined' });
                return signal.aborted
                    ? 'The user stopped the assistant before confirming. Nothing was changed.'
                    : 'The user declined this change. Nothing was changed. Do not propose it again unless the user asks.';
            }
            const count = plan.items ? (choice.selected?.length ?? 0) : 1;
            if (this.rateLimited(limit, count)) return await this.rateLimitHit(run, messageId, call, limit);
            let outcome: WriteOutcome;
            try {
                const raw: unknown = await plan.apply(choice);
                outcome = isRecord(raw) ? (raw as WriteOutcome) : {};
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
            const value = outcome.result;
            const result =
                value === undefined
                    ? undefined
                    : capText(redactSecrets(serializeToolData(value)), APPLIED_RESULT_CHARS);
            const fates = items ? this.fatesOf(items, choice.selected ?? [], outcome) : undefined;
            const applied = fates ? fates.filter((item) => item.status === 'applied').length : 1;
            const scope = choice.scope !== plan.scope ? choice.scope : undefined;
            if (fates && !applied) {
                const error = fates.find((item) => item.error)?.error ?? this.t('m33.error.toolFailed');
                await this.patchCall(run, messageId, call.id, {
                    status: 'error',
                    error: clip(error, 300),
                    items: fates,
                });
                return `Error while applying: none of the changes of this pack was made (${error}). Check before retrying.`;
            }
            const forModel = this.appliedText(plan, fates, scope ? this.scopeLabel(plan, scope) : undefined, result);
            const stamp = this.now();
            await this.patchCall(
                run,
                messageId,
                call.id,
                {
                    status: 'applied',
                    result: fates ? capText(forModel, APPLIED_RESULT_CHARS) : result,
                    items: fates,
                    scope,
                },
                (doc, record) => {
                    if (record.status !== 'applied') for (let i = 0; i < applied; i++) doc.writes.push(stamp);
                },
            );
            return forModel;
        } finally {
            decision.finish();
        }
    }

    /** The user's choice made safe: items of this plan only (all by default), a scope the plan offers. */
    private choiceOf(plan: WritePlan, raw: ApplyChoice | undefined): ApplyChoice {
        const choice: ApplyChoice = {};
        if (plan.items) {
            const ids = plan.items.map((item) => item.id);
            choice.selected = Array.isArray(raw?.selected) ? ids.filter((id) => raw.selected!.includes(id)) : [...ids];
        }
        const offered = scopeOptions(plan).map((option) => option.value);
        const wanted = raw?.scope;
        if (typeof wanted === 'string' && offered.includes(wanted)) choice.scope = wanted;
        else if (typeof plan.scope === 'string') choice.scope = plan.scope;
        return choice;
    }

    /** What happened to every item of a pack: the tool's report, else applied when kept and skipped when cleared. */
    private fatesOf(items: ToolCallItem[], selected: readonly string[], outcome: WriteOutcome): ToolCallItem[] {
        const reported = new Map((Array.isArray(outcome.items) ? outcome.items : []).map((item) => [item.id, item]));
        return items.map((item) => {
            const report = reported.get(item.id);
            const status = report?.status ?? (selected.includes(item.id) ? 'applied' : 'skipped');
            const fate: ToolCallItem = { ...item, status };
            if (report?.error) fate.error = clip(redactSecrets(report.error), 300);
            return fate;
        });
    }

    private scopeLabel(plan: WritePlan, scope: string): string {
        return scopeOptions(plan).find((option) => option.value === scope)?.label ?? scope;
    }

    /** What the model learns of an applied card: the pack's fates item by item, the scope the user picked. */
    private appliedText(
        plan: WritePlan,
        fates: ToolCallItem[] | undefined,
        scope: string | undefined,
        result: string | undefined,
    ): string {
        const lines: string[] = [];
        if (!fates) lines.push(`Applied: ${plan.summary}`);
        else {
            const applied = fates.filter((item) => item.status === 'applied');
            const skipped = fates.filter((item) => item.status === 'skipped');
            const failed = fates.filter((item) => item.status === 'error');
            lines.push(`Applied ${applied.length} of ${fates.length} changes of the pack «${plan.summary}»:`);
            for (const item of applied) lines.push(`- ${item.summary}`);
            if (skipped.length) {
                lines.push('Left out by the user (not changed; do not propose them again unless asked):');
                for (const item of skipped) lines.push(`- ${item.summary}`);
            }
            if (failed.length) {
                lines.push('Failed (not changed):');
                for (const item of failed) lines.push(`- ${item.summary}: ${item.error ?? 'error'}`);
            }
        }
        if (scope) lines.push(`The user chose where it applies: ${scope}.`);
        if (result) lines.push(`Result: ${result}`);
        return lines.join('\n');
    }

    private changeLimitHit(run: Run, messageId: string, call: ParsedCall, size: number): Promise<string> {
        const left = Math.max(0, MAX_CHANGES - run.changes);
        return this.closeCall(
            run,
            messageId,
            call,
            this.t('m33.error.changeLimit', { count: MAX_CHANGES }),
            left > 0 && size > 1
                ? `Not done: this pack has ${size} changes, only ${left} more fit into this message (${MAX_CHANGES} ` +
                      'changes per user message). Propose a smaller pack, or summarise and ask the user to continue.'
                : `Not done: the limit of ${MAX_CHANGES} proposed changes per user message is reached. Do not ` +
                      'propose more changes now: summarise what was done and ask the user whether to continue.',
        );
    }

    /** True when `count` more applied changes would pass the hourly limit. */
    private rateLimited(limit: number, count: number): boolean {
        return writesLeft(this.store.current().writes, this.now(), limit) < Math.max(1, count);
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
        let resolve!: (answer: Answer) => void;
        let finish!: () => void;
        const promise = new Promise<Answer>((done) => (resolve = done));
        const done = new Promise<void>((settle) => (finish = settle));
        const decision: Decision = {
            promise,
            done,
            finish,
            resolve: (answer) => {
                if (this.pending.get(callId) === decision) this.pending.delete(callId);
                resolve(answer);
            },
        };
        this.pending.set(callId, decision);
        if (signal.aborted) decision.resolve({ accept: false });
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
        const resultChars = this.deps.settings().resultChars;
        return { app, log, signal, locale: app.i18n.locale(), settings: access, resultChars };
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
