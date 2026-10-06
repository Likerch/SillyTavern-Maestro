// Maestro's own LLM calls (plan §9, §4.5): through a saved Connection Manager profile, past the chat — no
// lorebooks, interceptors or ToolManager (research/st-world-info.md §9, audit T17).
//
// - profile: settings.core().profiles[task] ?? profiles.default; profiles.fallback once the breaker opens;
// - sendRequest(..., { extractData: false }) returns the raw provider JSON, so `usage` (OpenRouter
//   `usage.cost`) and `tool_calls` survive; every response is recorded in the cost meter as source 'maestro';
// - transport errors: 2 retries with backoff; a refusal is never retried;
// - structured output: json_schema, parse (fences and <think> stripped, outermost {…}), light validation;
//   on failure one more try without json_schema, with the schema as instructions;
// - circuit breaker per profile: 3 failed requests in a row → open for 5 minutes.
import type {
    CostMeter,
    Host,
    LlmClient,
    LlmMessage,
    LlmRequest,
    LlmResult,
    Logger,
    SettingsService,
} from '../shared/contracts';
import { readUsage, tokensOf } from './cost';

/**
 * Tasks the user starts and watches — the assistant, «Подготовить к игре» (task 'prepare', src/domain/prepare-extract.ts;
 * its price is shown before he presses «Начать»): the daily cap of background spending does not stop them.
 */
export const INTERACTIVE_TASKS: ReadonlySet<string> = new Set(['assistant', 'prepare']);

/**
 * Tasks that keep the model's own reasoning (the assistant's conversation). Preparation is interactive but a structured
 * extraction: it stays without reasoning, like every background task, so its price matches the estimate.
 */
export const REASONING_TASKS: ReadonlySet<string> = new Set(['assistant']);

export interface OwnRequestHooks {
    /** Marks a request in flight so the fetch-level meter does not count it twice. */
    beginOwn?(signal?: AbortSignal): void;
    endOwn?(signal?: AbortSignal): void;
}

export interface LlmClientDeps {
    host: Host;
    settings: SettingsService;
    cost: CostMeter & OwnRequestHooks;
    log: Logger;
    /** Pauses before transport retries (default 1 s, 3 s): its length is the retry count. */
    backoffMs?: readonly number[];
    /** Clock for the breaker (tests). */
    now?: () => number;
}

export interface BreakerState {
    failures: number;
    openUntil: number;
}

export interface LlmClientImpl extends LlmClient {
    /** Breaker state of a profile (UI, tests). */
    breaker(profileId: string): BreakerState;
    resetBreakers(): void;
}

export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = [1000, 3000] as const;

type ConnectionManager = STContext['ConnectionManagerRequestService'];

interface WireMessage {
    role: string;
    content: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
}

type SendOutcome = { kind: 'ok'; raw: unknown } | { kind: 'error'; error: unknown } | { kind: 'aborted' };

interface Spent {
    any: boolean;
    usd: number;
    prompt: number;
    completion: number;
}

export function createLlmClient(deps: LlmClientDeps): LlmClientImpl {
    const { host, settings, cost, log } = deps;
    const backoff = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    const now = deps.now ?? Date.now;
    const breakers = new Map<string, BreakerState>();

    function connectionManager(): ConnectionManager | undefined {
        const context: Partial<STContext> = host.ctx();
        const service = context.ConnectionManagerRequestService;
        if (!service || typeof service.sendRequest !== 'function') return undefined;
        const disabled = context.extensionSettings?.disabledExtensions;
        if (Array.isArray(disabled) && disabled.includes('connection-manager')) return undefined;
        return service;
    }

    /** The API of a Connection Manager profile ('openrouter', 'openai', …), undefined when unknown. */
    function profileApi(profileId: string): string | undefined {
        const context: Partial<STContext> = host.ctx();
        const manager = context.extensionSettings?.connectionManager as { profiles?: unknown } | undefined;
        const list = Array.isArray(manager?.profiles) ? (manager.profiles as Record<string, unknown>[]) : [];
        const api = list.find((profile) => profile?.id === profileId)?.api;
        return typeof api === 'string' ? api : undefined;
    }

    function candidates(task: string): string[] {
        const profiles = settings.core().profiles ?? {};
        const primary = nonEmpty(profiles[task]) ?? nonEmpty(profiles['default']);
        const fallback = nonEmpty(profiles['fallback']);
        const list: string[] = [];
        for (const id of [primary, fallback]) if (id && !list.includes(id)) list.push(id);
        return list;
    }

    function isOpen(profileId: string): boolean {
        const state = breakers.get(profileId);
        return state !== undefined && state.openUntil > now();
    }

    function failed(profileId: string): void {
        const state = breakers.get(profileId) ?? { failures: 0, openUntil: 0 };
        state.failures += 1;
        if (state.failures >= BREAKER_FAILURES) {
            state.openUntil = now() + BREAKER_OPEN_MS;
            log.warn(`profile ${profileId} failed ${state.failures} times in a row; paused for 5 minutes`);
        }
        breakers.set(profileId, state);
    }

    function succeeded(profileId: string): void {
        breakers.delete(profileId);
    }

    function recordCost(task: string, raw: unknown, spent: Spent): void {
        const usage = readUsage(raw);
        const usd = usage?.usd ?? 0;
        const tokens = usage ? tokensOf(usage) : undefined;
        cost.record(
            dropUndefined({ source: 'maestro' as const, task, usd, tokens, estimated: usage?.usd === undefined }),
        );
        spent.any = true;
        spent.usd += usd;
        spent.prompt += tokens?.prompt ?? 0;
        spent.completion += tokens?.completion ?? 0;
    }

    async function sendOnce(
        service: ConnectionManager,
        profileId: string,
        request: LlmRequest,
        useSchema: boolean,
        spent: Spent,
    ): Promise<SendOutcome> {
        // Our own controller per attempt: its signal identifies this request at the fetch level.
        const controller = new AbortController();
        const outer = request.signal;
        const forward = () => controller.abort(outer?.reason);
        outer?.addEventListener('abort', forward, { once: true });
        cost.beginOwn?.(controller.signal);
        try {
            const raw = await service.sendRequest(
                profileId,
                buildMessages(request, useSchema),
                maxTokensFor(request),
                {
                    stream: false,
                    signal: controller.signal,
                    extractData: false,
                    includePreset: false,
                    includeInstruct: true,
                },
                buildOverride(request, useSchema, profileApi(profileId)),
            );
            recordCost(request.task, raw, spent);
            return { kind: 'ok', raw };
        } catch (error) {
            if (outer?.aborted || isAbortError(error)) return { kind: 'aborted' };
            return { kind: 'error', error };
        } finally {
            cost.endOwn?.(controller.signal);
            outer?.removeEventListener('abort', forward);
        }
    }

    async function sendWithRetries(
        service: ConnectionManager,
        profileId: string,
        request: LlmRequest,
        useSchema: boolean,
        spent: Spent,
    ): Promise<SendOutcome> {
        for (let attempt = 0; ; attempt++) {
            if (request.signal?.aborted) return { kind: 'aborted' };
            const outcome = await sendOnce(service, profileId, request, useSchema, spent);
            if (outcome.kind !== 'error') return outcome;
            const delay = backoff[attempt];
            if (delay === undefined || !retryable(outcome.error, useSchema)) return outcome;
            log.debug(
                `request ${request.task} via ${profileId} failed, retry ${attempt + 1}`,
                errorText(outcome.error),
            );
            if (!(await sleep(delay, request.signal))) return { kind: 'aborted' };
        }
    }

    /** One profile: transport retries, then the structured-output fallback. `final` = do not try another profile. */
    async function viaProfile<T>(
        service: ConnectionManager,
        profileId: string,
        request: LlmRequest,
        spent: Spent,
    ): Promise<{ final: boolean; result: LlmResult<T> }> {
        let useSchema = Boolean(request.schema);
        for (let pass = 0; pass < 2; pass++) {
            const sent = await sendWithRetries(service, profileId, request, useSchema, spent);
            if (sent.kind === 'aborted') return { final: true, result: { ok: false, error: 'aborted' } };
            if (sent.kind === 'error') {
                if (useSchema && pass === 0 && schemaRejected(sent.error)) {
                    log.debug(`profile ${profileId} rejected json_schema; asking with instructions only`);
                    useSchema = false;
                    continue;
                }
                failed(profileId);
                log.warn(`request ${request.task} via ${profileId} failed`, errorText(sent.error));
                return { final: false, result: { ok: false, error: `transport: ${errorText(sent.error)}` } };
            }

            const reply = extractReply(sent.raw);
            const text = stripThinking(reply.text).trim();

            if (request.tools && request.tools.length > 0 && reply.toolCalls.length > 0) {
                succeeded(profileId);
                return {
                    final: true,
                    result: dropUndefined({ ok: true, text: text || undefined, toolCalls: reply.toolCalls }),
                };
            }

            if (request.schema) {
                const parsed = parseStructured(reply, request.schema);
                if (parsed.ok) {
                    succeeded(profileId);
                    return { final: true, result: { ok: true, data: parsed.value as T, text } };
                }
                if (reply.refusal || looksLikeRefusal(text)) {
                    succeeded(profileId);
                    return { final: true, result: { ok: false, refusal: true, error: 'refusal', text } };
                }
                if (pass === 0) {
                    log.debug(`request ${request.task}: unparsable JSON, retrying without json_schema`);
                    useSchema = false;
                    continue;
                }
                failed(profileId);
                return { final: false, result: { ok: false, error: 'parse', text } };
            }

            if (reply.refusal || looksLikeRefusal(text)) {
                succeeded(profileId);
                return { final: true, result: { ok: false, refusal: true, error: 'refusal', text } };
            }
            if (!text) {
                failed(profileId);
                return { final: false, result: { ok: false, error: 'empty' } };
            }
            succeeded(profileId);
            return { final: true, result: { ok: true, text, data: text as T } };
        }
        return { final: false, result: { ok: false, error: 'parse' } };
    }

    return {
        async request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
            if (!INTERACTIVE_TASKS.has(request.task) && cost.backgroundCapReached()) return { ok: false, error: 'cap' };
            const service = connectionManager();
            if (!service) return { ok: false, error: 'no-cm' };
            const profiles = candidates(request.task);
            if (profiles.length === 0) return { ok: false, error: 'no-profile' };
            const usable = profiles.filter((id) => !isOpen(id));
            if (usable.length === 0) return { ok: false, error: 'breaker-open' };

            const spent: Spent = { any: false, usd: 0, prompt: 0, completion: 0 };
            let result: LlmResult<T> = { ok: false, error: 'breaker-open' };
            for (const profileId of usable) {
                const outcome = await viaProfile<T>(service, profileId, request, spent);
                result = outcome.result;
                // The fallback profile is used only once the primary's breaker is open.
                if (outcome.final || !isOpen(profileId)) break;
            }
            if (spent.any) {
                result.costUsd = spent.usd;
                result.tokens = { prompt: spent.prompt, completion: spent.completion };
            }
            return result;
        },

        available(task: string): boolean {
            if (!connectionManager()) return false;
            return candidates(task).some((id) => !isOpen(id));
        },

        breaker(profileId: string): BreakerState {
            const state = breakers.get(profileId);
            return state ? { ...state } : { failures: 0, openUntil: 0 };
        },

        resetBreakers(): void {
            breakers.clear();
        },
    };
}

/* ------------------------------------------------------------------ request building */

const SCHEMA_INSTRUCTION =
    'Reply with exactly one JSON value and nothing else: no prose, no markdown code fences. It must match this JSON schema:\n';

function buildMessages(request: LlmRequest, useSchema: boolean): WireMessage[] {
    const messages = request.messages.map(toWire);
    if (request.schema && !useSchema) {
        messages.push({ role: 'system', content: SCHEMA_INSTRUCTION + JSON.stringify(request.schema.schema) });
    }
    return messages;
}

function toWire(message: LlmMessage): WireMessage {
    return dropUndefined({
        role: message.role,
        content: message.content,
        tool_calls: message.tool_calls,
        tool_call_id: message.tool_call_id,
    });
}

/**
 * Background tasks do not reason: the profile's preset is not applied (includePreset: false), so a reasoning model
 * (DeepSeek V4 on OpenRouter) thinks by default and a short task spends its whole budget on thoughts and answers
 * nothing. OpenRouter takes the effort as given ('none'); other APIs keep their own default.
 */
export function reasoningOverride(task: string, api: string | undefined): string | undefined {
    if (REASONING_TASKS.has(task)) return undefined;
    return api === 'openrouter' ? 'none' : undefined;
}

/** Structured answers get room even when a provider still reasons a little (a director verdict asked for 80). */
export const SCHEMA_MIN_TOKENS = 200;

export function maxTokensFor(request: LlmRequest): number {
    return request.schema ? Math.max(request.maxTokens, SCHEMA_MIN_TOKENS) : request.maxTokens;
}

function buildOverride(request: LlmRequest, useSchema: boolean, api?: string): Record<string, unknown> {
    const tools = request.tools && request.tools.length > 0 ? request.tools : undefined;
    return dropUndefined({
        temperature: request.temperature,
        reasoning_effort: reasoningOverride(request.task, api),
        json_schema:
            useSchema && request.schema
                ? { name: request.schema.name, strict: true, value: request.schema.schema }
                : undefined,
        tools,
        tool_choice: tools ? 'auto' : undefined,
        // The profile's prompt post-processing may merge or strip tool messages.
        custom_prompt_post_processing: tools ? '' : undefined,
    });
}

/* ------------------------------------------------------------------ response reading */

export interface ExtractedReply {
    text: string;
    /** OpenAI-style tool calls (Claude tool_use blocks are converted). */
    toolCalls: unknown[];
    /** Claude tool_use inputs by tool name (structured output on Claude arrives this way). */
    toolInputs: { name: string; input: unknown }[];
    /** The provider flagged a refusal (message.refusal, finish_reason content_filter). */
    refusal: boolean;
}

/** Reads the raw response of ChatCompletionService/TextCompletionService (extractData: false). */
export function extractReply(raw: unknown): ExtractedReply {
    const reply: ExtractedReply = { text: '', toolCalls: [], toolInputs: [], refusal: false };
    if (typeof raw === 'string') {
        reply.text = raw;
        return reply;
    }
    if (!isRecord(raw)) return reply;

    const choices = raw['choices'];
    const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
    if (choice) {
        const message = isRecord(choice['message']) ? choice['message'] : undefined;
        if (message) {
            reply.text = contentText(message['content']);
            if (Array.isArray(message['tool_calls'])) reply.toolCalls = [...(message['tool_calls'] as unknown[])];
            if (typeof message['refusal'] === 'string' && message['refusal'].trim()) {
                reply.refusal = true;
                if (!reply.text) reply.text = message['refusal'];
            }
        }
        if (!reply.text && typeof choice['text'] === 'string') reply.text = choice['text'];
        if (choice['finish_reason'] === 'content_filter') reply.refusal = true;
        return reply;
    }

    // Claude (content blocks), Cohere (message.content[0].text), Gemini (candidates[0].content.parts).
    if (Array.isArray(raw['content'])) {
        const blocks = (raw['content'] as unknown[]).filter(isRecord);
        reply.text = blocks
            .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
            .map((block) => String(block['text']))
            .join('\n\n');
        for (const block of blocks) {
            if (block['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue;
            reply.toolInputs.push({ name: block['name'], input: block['input'] });
            reply.toolCalls.push({
                id: block['id'],
                type: 'function',
                function: { name: block['name'], arguments: JSON.stringify(block['input'] ?? {}) },
            });
        }
        if (raw['stop_reason'] === 'refusal') reply.refusal = true;
        return reply;
    }
    const message = isRecord(raw['message']) ? raw['message'] : undefined;
    if (message) {
        reply.text = contentText(message['content']);
        return reply;
    }
    const candidates = raw['candidates'];
    const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : undefined;
    const content = candidate && isRecord(candidate['content']) ? candidate['content'] : undefined;
    if (content) reply.text = contentText(content['parts']);
    if (typeof raw['text'] === 'string' && !reply.text) reply.text = raw['text'];
    return reply;
}

function contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(isRecord)
        .filter((part) => typeof part['text'] === 'string' && (part['type'] === undefined || part['type'] === 'text'))
        .map((part) => String(part['text']))
        .join('');
}

/** Removes reasoning blocks; text before a lone closing tag is reasoning too. */
export function stripThinking(text: string): string {
    let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
    const close = out.search(/<\/(think|thinking|reasoning)>/i);
    if (close >= 0) out = out.slice(out.indexOf('>', close) + 1);
    return out;
}

/** Parses a JSON value from model text: no fences, no reasoning, the outermost {…} (or […]). */
export function parseJsonText(text: string): unknown {
    const cleaned = stripThinking(text)
        .replace(/```[a-zA-Z]*\s*/g, '')
        .replace(/```/g, '')
        .trim();
    if (!cleaned) return undefined;
    const attempts = [cleaned, outermost(cleaned, '{', '}'), outermost(cleaned, '[', ']')];
    for (const attempt of attempts) {
        if (!attempt) continue;
        try {
            return JSON.parse(attempt) as unknown;
        } catch {
            // next candidate
        }
    }
    return undefined;
}

function outermost(text: string, open: string, close: string): string | undefined {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function parseStructured(
    reply: ExtractedReply,
    schema: { name: string; schema: Record<string, unknown> },
): { ok: true; value: unknown } | { ok: false } {
    const fromTool = reply.toolInputs.find((tool) => tool.name === schema.name);
    if (fromTool && matchesSchema(fromTool.input, schema.schema)) return { ok: true, value: fromTool.input };
    const value = parseJsonText(reply.text);
    if (value !== undefined && matchesSchema(value, schema.schema)) return { ok: true, value };
    return { ok: false };
}

/**
 * A light JSON-schema check (type, enum, required, properties, items): enough to reject a wrong shape
 * before a feature applies it. Unknown keywords are ignored.
 */
export function matchesSchema(value: unknown, schema: unknown, depth = 0): boolean {
    if (!isRecord(schema) || depth > 32) return true;
    const enumValues = schema['enum'];
    if (Array.isArray(enumValues) && !enumValues.some((item) => item === value)) return false;
    const type = schema['type'];
    if (typeof type === 'string' && !matchesType(value, type)) return false;
    if (Array.isArray(type) && !type.some((item) => typeof item === 'string' && matchesType(value, item))) return false;

    if (isRecord(value)) {
        const required = schema['required'];
        if (Array.isArray(required) && required.some((key) => typeof key === 'string' && !(key in value))) return false;
        const properties = schema['properties'];
        if (isRecord(properties)) {
            for (const [key, sub] of Object.entries(properties)) {
                if (key in value && !matchesSchema(value[key], sub, depth + 1)) return false;
            }
        }
    }
    if (Array.isArray(value) && isRecord(schema['items'])) {
        const items = schema['items'];
        if (!value.every((item) => matchesSchema(item, items, depth + 1))) return false;
    }
    return true;
}

function matchesType(value: unknown, type: string): boolean {
    switch (type) {
        case 'object':
            return isRecord(value);
        case 'array':
            return Array.isArray(value);
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'null':
            return value === null;
        default:
            return true;
    }
}

/* ------------------------------------------------------------------ refusals and errors */

const VERBS_EN =
    'help|assist|comply|provide|continue|create|write|fulfil|fulfill|generate|engage|produce|participate|do that|do this';
const REFUSAL_PATTERNS: RegExp[] = [
    new RegExp(`\\b(?:i|we) (?:can't|cannot|can not|won't|will not) (?:${VERBS_EN})`),
    new RegExp(`\\bi(?:'m| am) (?:unable|not able) to (?:${VERBS_EN})`),
    /\bas an ai\b/,
    /\bi must (?:decline|refuse)\b/,
    /\bi(?:'m| am) sorry,? but i (?:can't|cannot|won't)\b/,
    /не могу (?:с этим )?(?:помочь|выполнить|продолжить|создать|написать|сгенерировать|участвовать)/,
    /(?:^|[^а-яё])я не могу(?:[^а-яё]|$)/,
    /(?:^|[^а-яё])как (?:ии|искусственный интеллект|языковая модель)(?:[^а-яё]|$)/,
    /вынужден[аы]? отказаться/,
    /извините, но я не/,
];

/**
 * Refusal heuristics (en/ru). A refusal opens the reply: the phrase must sit in the first 80 characters of a
 * short reply with no quotation mark before it, so story text like `"I can't help it," she said` is not one.
 */
export function looksLikeRefusal(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[’`]/g, "'");
    if (!normalized || normalized.length > 1500) return false;
    const head = normalized.slice(0, 300);
    return REFUSAL_PATTERNS.some((pattern) => {
        const match = pattern.exec(head);
        return match !== null && match.index <= 80 && !/["«»“”„]/.test(head.slice(0, match.index));
    });
}

/** Messages of an error and its causes (ST wraps failures as Error('API request failed', { cause })). */
function errorText(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
        if (current instanceof Error) {
            if (current.message) parts.push(current.message);
            current = (current as Error & { cause?: unknown }).cause;
        } else {
            parts.push(String(current));
            break;
        }
    }
    return parts.join(': ') || 'unknown error';
}

function isAbortError(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
        if (current.name === 'AbortError') return true;
        current = (current as Error & { cause?: unknown }).cause;
    }
    return false;
}

/** Configuration errors do not get better with retries. */
function retryable(error: unknown, useSchema: boolean): boolean {
    const text = errorText(error);
    if (/Profile not found|Connection Manager is not available|does not support|Unknown API type/i.test(text))
        return false;
    return !(useSchema && schemaRejected(error));
}

function schemaRejected(error: unknown): boolean {
    return /json_schema|response_format|structured output|schema/i.test(errorText(error));
}

/* ------------------------------------------------------------------ helpers */

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function nonEmpty(value: string | undefined): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function dropUndefined<T extends object>(value: T): T {
    const out = { ...value } as Record<string, unknown>;
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    return out as T;
}
