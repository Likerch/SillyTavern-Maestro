// Cost meter (M21, stage 0): the real cost from `usage` of every chat-completion response (OpenRouter sends
// `usage.cost`; audit T16), Anlas from NAI Studio picture posts, daily totals per day file, the background
// cap and the optional overall daily limit.
//
// Attribution of a /api/backends/chat-completions/generate request, decided when the request leaves:
// - Maestro's own requests (LlmClient) are skipped: the client records them itself with the task name.
//   They are recognised by their AbortSignal (ST passes custom.signal straight to fetch, custom-request.js),
//   or — for callers that pass no signal — by the beginOwn/endOwn counter;
// - 'main' for the first request after bus generation:before (cleared by generation:ended). The window is
//   consumed by that request because ST emits GENERATION_ENDED only from hideStopButton() (script.js), so a
//   quiet generation without the stop button may never close it;
// - 'qvink' when Qvink Memory is installed (its summaries run between generations);
// - 'other' otherwise (DES tracker generateRaw, other extensions).
//
// Several tabs may write the same day file: each tab keeps the delta it has not written yet and merges it
// into what is on disk at write time, so totals from other tabs are not lost (a tiny read→write race remains).
import type {
    Bus,
    CostEntry,
    CostMeter,
    CostSummary,
    CoreSettings,
    FileStore,
    Host,
    Logger,
    SettingsService,
    Unsubscribe,
} from '../shared/contracts';

const GENERATE_URL = /\/api\/backends\/chat-completions\/generate/;
/** A generation whose request never left (aborted by an interceptor) must not claim later requests. */
const ARM_TTL_MS = 5 * 60_000;
const MAX_RECENT = 200;
const MAX_SEEN = 5000;
const DOC_VERSION = 1;

export type CostSource = CostEntry['source'];

type Attribution = { own: true } | { own: false; source: CostSource; task?: string };

export interface UsageInfo {
    prompt: number;
    completion: number;
    /** Real cost when the provider reports it (OpenRouter `usage.cost`). */
    usd?: number;
    /** Prompt tokens served from the provider's cache (OpenRouter/OpenAI, Anthropic, Google, DeepSeek). */
    cached?: number;
}

export type RecentCost = CostEntry & { anlas?: number };

export interface DayTotals {
    /** Local date, YYYY-MM-DD. */
    date: string;
    totalUsd: number;
    bySource: Record<string, number>;
    byTask: Record<string, number>;
    tokens: { prompt: number; completion: number };
    /** Number of recorded LLM responses. */
    requests: number;
    /** How many of them had no real cost (usd 0, estimated). */
    estimated: number;
    anlas: number;
    /** Last entries, oldest first. */
    recent: RecentCost[];
}

export interface LimitInfo {
    usd: number;
    limit: number;
    action: CoreSettings['dailyLimit']['action'];
}

export interface CostMeterImpl extends CostMeter {
    install(): void;
    dispose(): void;
    /** Marks a Maestro request in flight; pass the AbortSignal given to fetch for exact matching. */
    beginOwn(signal?: AbortSignal): void;
    endOwn(signal?: AbortSignal): void;
    /** Today's totals (read-only view for the UI). */
    today(): Readonly<DayTotals>;
    /** Overall daily limit enabled and reached. */
    dailyLimitReached(): boolean;
    /** Called once per day when the overall daily limit is reached; the UI decides what to show. */
    onLimitReached(listener: (info: LimitInfo) => void): Unsubscribe;
    /** Writes pending totals now. */
    flush(): Promise<void>;
}

export interface CostMeterDeps {
    host: Host;
    settings: SettingsService;
    files: FileStore;
    bus: Bus;
    log: Logger;
    /** Clock (tests). */
    now?: () => number;
    /** Delay before pending totals are written (default 5 s). */
    persistDelayMs?: number;
}

export function costFileName(date: string): string {
    return `maestro-cost-${date}.json`;
}

export function createCostMeter(deps: CostMeterDeps): CostMeterImpl {
    const { host, settings, files, bus, log } = deps;
    const now = deps.now ?? Date.now;
    const persistDelay = deps.persistDelayMs ?? 5000;

    let doc = emptyDay(dateKey(now()));
    let pending = emptyDay(doc.date);
    let chain: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let limitNotifiedFor: string | null = null;

    const changeListeners = new Set<() => void>();
    const limitListeners = new Set<(info: LimitInfo) => void>();
    const unsubscribers: Unsubscribe[] = [];
    const ownSignals = new Set<AbortSignal>();
    let unmarkedOwn = 0;
    /** Armed by generation:before, consumed by the next generate request. */
    let generation: { type: string; at: number } | null = null;
    const attributions = new WeakMap<RequestInit, Attribution>();
    const seenAnlas = new Set<string>();

    function enqueue(op: () => Promise<void>): Promise<void> {
        chain = chain.then(op).catch((error: unknown) => log.warn('cost file operation failed', error));
        return chain;
    }

    function rollIfNeeded(): void {
        const key = dateKey(now());
        if (key === doc.date) return;
        const previous = pending;
        if (!isEmptyDay(previous)) void enqueue(() => writeDelta(previous));
        doc = emptyDay(key);
        pending = emptyDay(key);
        void enqueue(() => loadFromDisk(key));
    }

    async function loadFromDisk(date: string): Promise<void> {
        const stored = await files.read<unknown>(costFileName(date));
        if (doc.date !== date) return;
        doc = addDays(sanitizeDay(stored, date), pending);
        notify();
    }

    async function writeDelta(delta: DayTotals): Promise<void> {
        const name = costFileName(delta.date);
        const onDisk = sanitizeDay(await files.read<unknown>(name), delta.date);
        const merged = addDays(onDisk, delta);
        await files.write(name, { version: DOC_VERSION, ...merged });
        if (doc.date === delta.date) {
            doc = addDays(merged, pending);
            notify();
        }
    }

    function persistNow(): Promise<void> {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        return enqueue(async () => {
            const delta = pending;
            if (isEmptyDay(delta)) return;
            pending = emptyDay(delta.date);
            try {
                await writeDelta(delta);
            } catch (error) {
                // Keep the totals for the next attempt (only while still on the same day).
                if (pending.date === delta.date) pending = addDays(delta, pending);
                throw error;
            }
        });
    }

    function schedulePersist(): void {
        // At most one write per window: steady activity cannot postpone the write forever.
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            void persistNow();
        }, persistDelay);
    }

    function notify(): void {
        for (const listener of [...changeListeners]) {
            try {
                listener();
            } catch (error) {
                log.error('cost listener failed', error);
            }
        }
        const limit = settings.core().dailyLimit;
        if (limitNotifiedFor !== doc.date && limitReached(limit, doc.totalUsd)) {
            limitNotifiedFor = doc.date;
            const info: LimitInfo = { usd: doc.totalUsd, limit: limit.usd, action: limit.action };
            for (const listener of [...limitListeners]) {
                try {
                    listener(info);
                } catch (error) {
                    log.error('daily limit listener failed', error);
                }
            }
        }
    }

    function safeChatId(): string | null {
        try {
            return host.chatId();
        } catch {
            return null;
        }
    }

    function add(entry: RecentCost): void {
        applyEntry(doc, entry);
        applyEntry(pending, entry);
        schedulePersist();
        notify();
    }

    function isOwn(init: RequestInit | undefined): boolean {
        const signal = init?.signal;
        if (signal && ownSignals.has(signal)) return true;
        return unmarkedOwn > 0;
    }

    /** Decided when the request leaves; the first generate request after generation:before is the main one. */
    function attribute(init: RequestInit | undefined): Attribution {
        if (isOwn(init)) return { own: true };
        const armed = generation;
        if (armed) {
            generation = null;
            if (now() - armed.at <= ARM_TTL_MS) return { own: false, source: 'main', task: armed.type };
        }
        // NAI Studio's background calls carry their own JSON schema names (nai_passports, nai_translate, …).
        if (typeof init?.body === 'string' && NAI_SCHEMA_RE.test(init.body)) return { own: false, source: 'nai' };
        if (qvinkInstalled()) return { own: false, source: 'qvink' };
        return { own: false, source: 'other' };
    }

    function onGenerateRequest(_url: string, init: RequestInit | undefined): void {
        if (init) attributions.set(init, attribute(init));
    }

    function onGenerateResponse(_url: string, response: Response, init?: RequestInit): void {
        const attribution = (init && attributions.get(init)) ?? attribute(init);
        if (attribution.own || !response.ok) return;
        const { source, task } = attribution;
        const chatId = safeChatId();
        // text() must start synchronously: the fetch gate cancels copies nobody reads.
        response
            .text()
            .then((text) => {
                const usage = usageFromBody(text);
                if (!usage) return;
                meter.record({
                    source,
                    task,
                    usd: usage.usd ?? 0,
                    tokens: tokensOf(usage),
                    estimated: usage.usd === undefined,
                    chatId,
                });
            })
            .catch((error: unknown) => log.debug('could not read usage from a generate response', error));
    }

    function onReplyReady(messageIndex: number): void {
        const message = host.ctx().chat?.[messageIndex];
        const extra: unknown = message?.extra;
        if (!message || !isRecord(extra)) return;
        const chatId = safeChatId() ?? '';
        const remember = (key: string): boolean => {
            if (seenAnlas.has(key)) return false;
            seenAnlas.add(key);
            if (seenAnlas.size > MAX_SEEN) {
                for (const old of [...seenAnlas].slice(0, MAX_SEEN / 5)) seenAnlas.delete(old);
            }
            return true;
        };

        // A picture post carries the batch cost in extra.nai_studio and the same number again on every
        // media item (NAI Studio output.ts): count the post once.
        const post = isRecord(extra['nai_studio']) ? extra['nai_studio'] : undefined;
        const postCost = post ? positiveNumber(post['cost']) : undefined;
        const mediaRaw: unknown = extra['media'];
        const media = Array.isArray(mediaRaw) ? mediaRaw.filter(isRecord) : [];
        if (postCost !== undefined) {
            if (remember(`${chatId}|post|${messageIndex}|${String(message.send_date)}`)) meter.recordAnlas(postCost);
            for (const item of media)
                if (typeof item['url'] === 'string') seenAnlas.add(`${chatId}|media|${item['url']}`);
            return;
        }
        // Inline pictures attached to a reply: one cost per generation batch (correlationId), else per image.
        for (const item of media) {
            const meta = isRecord(item['nai_studio']) ? item['nai_studio'] : undefined;
            const cost = meta ? positiveNumber(meta['cost']) : undefined;
            if (cost === undefined || !meta) continue;
            const batch = typeof meta['correlationId'] === 'string' ? meta['correlationId'] : undefined;
            const key = batch ? `${chatId}|batch|${batch}` : `${chatId}|media|${String(item['url'])}`;
            if (remember(key)) meter.recordAnlas(cost);
        }
    }

    const meter: CostMeterImpl = {
        record(entry: Omit<CostEntry, 'at'>): void {
            rollIfNeeded();
            const full: RecentCost = {
                ...entry,
                usd: nonNegative(entry.usd),
                at: now(),
                chatId: entry.chatId === undefined ? safeChatId() : entry.chatId,
            };
            if (full.task === undefined) delete full.task;
            add(full);
        },

        recordAnlas(amount: number): void {
            const value = nonNegative(amount);
            if (value <= 0) return;
            rollIfNeeded();
            add({ source: 'nai', usd: 0, anlas: value, at: now(), chatId: safeChatId() });
        },

        summary(): CostSummary {
            rollIfNeeded();
            return {
                todayUsd: doc.totalUsd,
                todayBySource: { ...doc.bySource },
                backgroundTodayUsd: doc.bySource['maestro'] ?? 0,
                anlasToday: doc.anlas,
            };
        },

        backgroundCapReached(): boolean {
            rollIfNeeded();
            const core = settings.core();
            const cap = core.backgroundDailyCapUsd;
            if (cap > 0 && (doc.bySource['maestro'] ?? 0) >= cap) return true;
            // The overall limit with action "stop background tasks" stops Maestro's own work, never the chat.
            return core.dailyLimit.action === 'stopBackground' && limitReached(core.dailyLimit, doc.totalUsd);
        },

        dailyLimitReached(): boolean {
            rollIfNeeded();
            return limitReached(settings.core().dailyLimit, doc.totalUsd);
        },

        onChange(listener: () => void): Unsubscribe {
            changeListeners.add(listener);
            return () => {
                changeListeners.delete(listener);
            };
        },

        onLimitReached(listener: (info: LimitInfo) => void): Unsubscribe {
            limitListeners.add(listener);
            return () => {
                limitListeners.delete(listener);
            };
        },

        today(): Readonly<DayTotals> {
            rollIfNeeded();
            return doc;
        },

        recent(): readonly CostEntry[] {
            rollIfNeeded();
            return doc.recent.slice();
        },

        beginOwn(signal?: AbortSignal): void {
            if (signal) ownSignals.add(signal);
            else unmarkedOwn++;
        },

        endOwn(signal?: AbortSignal): void {
            if (signal) ownSignals.delete(signal);
            else unmarkedOwn = Math.max(0, unmarkedOwn - 1);
        },

        install(): void {
            if (unsubscribers.length > 0) return;
            unsubscribers.push(host.fetchGate.beforeRequest(GENERATE_URL, onGenerateRequest));
            unsubscribers.push(host.fetchGate.afterResponse(GENERATE_URL, onGenerateResponse));
            unsubscribers.push(
                bus.on('generation:before', (info) => {
                    generation = { type: info.type, at: now() };
                }),
            );
            unsubscribers.push(
                bus.on('generation:ended', () => {
                    generation = null;
                }),
            );
            unsubscribers.push(
                bus.on('chat:changed', () => {
                    generation = null;
                }),
            );
            unsubscribers.push(bus.on('reply:ready', ({ messageIndex }) => onReplyReady(messageIndex)));
            void enqueue(() => loadFromDisk(doc.date));
        },

        dispose(): void {
            for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
            generation = null;
            void persistNow();
        },

        flush(): Promise<void> {
            return persistNow();
        },
    };
    return meter;
}

/* ------------------------------------------------------------------ usage parsing */

/**
 * Reads `usage` from a chat-completion response object: OpenAI/OpenRouter (prompt_tokens, completion_tokens,
 * cost), Claude (input_tokens, output_tokens; also nested in a stream's message_start) and Gemini
 * (usageMetadata).
 */
export function readUsage(raw: unknown): UsageInfo | undefined {
    if (!isRecord(raw)) return undefined;
    const nested = isRecord(raw['message']) ? raw['message'] : undefined;
    const usage = isRecord(raw['usage'])
        ? raw['usage']
        : isRecord(raw['usageMetadata'])
          ? raw['usageMetadata']
          : nested && isRecord(nested['usage'])
            ? nested['usage']
            : undefined;
    if (!usage) return undefined;
    const prompt = firstNumber(usage['prompt_tokens'], usage['input_tokens'], usage['promptTokenCount']) ?? 0;
    const completion =
        firstNumber(usage['completion_tokens'], usage['output_tokens'], usage['candidatesTokenCount']) ?? 0;
    const usd = firstNumber(usage['cost'], usage['total_cost']);
    const details = isRecord(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : {};
    const cached = firstNumber(
        details['cached_tokens'],
        usage['cache_read_input_tokens'],
        usage['cachedContentTokenCount'],
        usage['prompt_cache_hit_tokens'],
    );
    const info: UsageInfo = { prompt, completion };
    if (cached !== undefined && cached > 0) info.cached = cached;
    if (usd !== undefined) info.usd = usd;
    return info;
}

/** Token counts of a usage for a cost entry (`cached` only when the provider reported a cache hit). */
export function tokensOf(usage: UsageInfo): { prompt: number; completion: number; cached?: number } {
    const tokens: { prompt: number; completion: number; cached?: number } = {
        prompt: usage.prompt,
        completion: usage.completion,
    };
    if (usage.cached !== undefined) tokens.cached = usage.cached;
    return tokens;
}

/** Usage from a response body: a JSON object, or SSE text whose chunks carry usage (last/biggest wins). */
export function usageFromBody(text: string): UsageInfo | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('{')) {
        try {
            return readUsage(JSON.parse(trimmed));
        } catch {
            // Not a single JSON document: try SSE below.
        }
    }
    let result: UsageInfo | undefined;
    for (const line of trimmed.split(/\r?\n/)) {
        const match = /^data:\s?(.*)$/.exec(line);
        const data = match?.[1]?.trim();
        if (!data || data === '[DONE]' || !data.includes('usage')) continue;
        try {
            const usage = readUsage(JSON.parse(data));
            if (usage) result = mergeUsage(result, usage);
        } catch {
            // A partial or non-JSON chunk.
        }
    }
    return result;
}

/** Claude streams input tokens in message_start and output tokens in message_delta: keep the max of each. */
function mergeUsage(a: UsageInfo | undefined, b: UsageInfo): UsageInfo {
    if (!a) return b;
    const usd = b.usd ?? a.usd;
    const merged: UsageInfo = {
        prompt: Math.max(a.prompt, b.prompt),
        completion: Math.max(a.completion, b.completion),
    };
    const cached = Math.max(a.cached ?? 0, b.cached ?? 0);
    if (cached > 0) merged.cached = cached;
    if (usd !== undefined) merged.usd = usd;
    return merged;
}

/* ------------------------------------------------------------------ day totals */

export function dateKey(ms: number): string {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function emptyDay(date: string): DayTotals {
    return {
        date,
        totalUsd: 0,
        bySource: {},
        byTask: {},
        tokens: { prompt: 0, completion: 0 },
        requests: 0,
        estimated: 0,
        anlas: 0,
        recent: [],
    };
}

function isEmptyDay(day: DayTotals): boolean {
    return day.requests === 0 && day.anlas === 0 && day.totalUsd === 0 && day.recent.length === 0;
}

function applyEntry(day: DayTotals, entry: RecentCost): void {
    if (entry.anlas !== undefined) {
        day.anlas += entry.anlas;
    } else {
        day.totalUsd += entry.usd;
        day.bySource[entry.source] = (day.bySource[entry.source] ?? 0) + entry.usd;
        if (entry.task) day.byTask[entry.task] = (day.byTask[entry.task] ?? 0) + entry.usd;
        day.tokens.prompt += entry.tokens?.prompt ?? 0;
        day.tokens.completion += entry.tokens?.completion ?? 0;
        day.requests += 1;
        if (entry.estimated) day.estimated += 1;
    }
    day.recent.push(entry);
    if (day.recent.length > MAX_RECENT) day.recent.splice(0, day.recent.length - MAX_RECENT);
}

function addDays(a: DayTotals, b: DayTotals): DayTotals {
    const sum = (x: Record<string, number>, y: Record<string, number>) => {
        const out = { ...x };
        for (const [key, value] of Object.entries(y)) out[key] = (out[key] ?? 0) + value;
        return out;
    };
    return {
        date: a.date,
        totalUsd: a.totalUsd + b.totalUsd,
        bySource: sum(a.bySource, b.bySource),
        byTask: sum(a.byTask, b.byTask),
        tokens: { prompt: a.tokens.prompt + b.tokens.prompt, completion: a.tokens.completion + b.tokens.completion },
        requests: a.requests + b.requests,
        estimated: a.estimated + b.estimated,
        anlas: a.anlas + b.anlas,
        recent: [...a.recent, ...b.recent].sort((x, y) => x.at - y.at).slice(-MAX_RECENT),
    };
}

/** Accepts whatever is on disk (other versions, hand edits) and returns valid totals for that date. */
function sanitizeDay(raw: unknown, date: string): DayTotals {
    const day = emptyDay(date);
    if (!isRecord(raw) || raw['date'] !== date) return day;
    day.totalUsd = nonNegative(raw['totalUsd']);
    day.bySource = numberMap(raw['bySource']);
    day.byTask = numberMap(raw['byTask']);
    const tokens = isRecord(raw['tokens']) ? raw['tokens'] : {};
    day.tokens = { prompt: nonNegative(tokens['prompt']), completion: nonNegative(tokens['completion']) };
    day.requests = nonNegative(raw['requests']);
    day.estimated = nonNegative(raw['estimated']);
    day.anlas = nonNegative(raw['anlas']);
    day.recent = Array.isArray(raw['recent'])
        ? raw['recent']
              .filter(
                  (entry): entry is RecentCost =>
                      isRecord(entry) && typeof entry['at'] === 'number' && typeof entry['source'] === 'string',
              )
              .slice(-MAX_RECENT)
        : [];
    return day;
}

function limitReached(limit: CoreSettings['dailyLimit'] | undefined, totalUsd: number): boolean {
    return Boolean(limit?.enabled) && (limit?.usd ?? 0) > 0 && totalUsd >= (limit?.usd ?? 0);
}

/** A JSON schema named by NAI Studio in a request body. */
const NAI_SCHEMA_RE = /"name"\s*:\s*"nai_/;

function qvinkInstalled(): boolean {
    // Qvink Memory registers its generate interceptor as a global (docs/research/qvink-nai-studio.md §A).
    return typeof (globalThis as Record<string, unknown>)['memory_intercept_messages'] === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstNumber(...values: unknown[]): number | undefined {
    for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
}

function nonNegative(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function positiveNumber(value: unknown): number | undefined {
    const n = nonNegative(value);
    return n > 0 ? n : undefined;
}

function numberMap(value: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!isRecord(value)) return out;
    for (const [key, item] of Object.entries(value)) {
        const n = nonNegative(item);
        if (n > 0) out[key] = n;
    }
    return out;
}
