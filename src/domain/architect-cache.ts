// M20 «Архитектор промпта», pure cache-friendliness helpers (plan M20 п. 6, P16): provider prompt-cache numbers
// from chat-completion responses (OpenRouter/OpenAI `usage.prompt_tokens_details.cached_tokens`, DeepSeek
// `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, Claude `cache_read_input_tokens`, Gemini
// `cachedContentTokenCount`), cheap per-message hashes of the outgoing prompt, the first message that differs from
// the previous request, and the P16 check «Maestro's volatile injections sit after stable content».
// Pure: no DOM, no SillyTavern.

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export interface CacheUsage {
    /** Prompt tokens of the request (cached ones included). */
    prompt: number;
    /** Prompt tokens served from the provider's cache. */
    cached: number;
}

/** Cache numbers of one parsed response object (or stream chunk); null without a usable `usage`. */
export function readCacheUsage(raw: unknown): CacheUsage | null {
    if (!isDict(raw)) return null;
    const message = isDict(raw.message) ? raw.message : undefined;
    const usage = isDict(raw.usage)
        ? raw.usage
        : isDict(raw.usageMetadata)
          ? raw.usageMetadata
          : message && isDict(message.usage)
            ? message.usage
            : undefined;
    if (!usage) return null;
    const details = isDict(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    // DeepSeek: hit + miss = prompt.
    const hit = num(usage.prompt_cache_hit_tokens);
    const miss = num(usage.prompt_cache_miss_tokens);
    // Claude: input_tokens excludes cache reads and writes.
    const claudeRead = num(usage.cache_read_input_tokens);
    const claudeWrite = num(usage.cache_creation_input_tokens);
    let prompt = num(usage.prompt_tokens) ?? num(usage.promptTokenCount);
    if (prompt === undefined && num(usage.input_tokens) !== undefined) {
        prompt = (num(usage.input_tokens) ?? 0) + (claudeRead ?? 0) + (claudeWrite ?? 0);
    }
    if (prompt === undefined && (hit !== undefined || miss !== undefined)) prompt = (hit ?? 0) + (miss ?? 0);
    if (prompt === undefined) return null;
    const cached = num(details?.cached_tokens) ?? hit ?? claudeRead ?? num(usage.cachedContentTokenCount) ?? 0;
    return { prompt, cached: Math.min(cached, prompt) };
}

/** Most `"usage"` occurrences a streamed body is searched for (from its end). */
const MAX_STREAM_HITS = 8;

/**
 * Cache numbers from a response body: one JSON document, or an SSE stream. Streams are not parsed whole: only the
 * lines holding `"usage"` / `"usageMetadata"` are, from the end (the final chunk carries the totals; Claude splits
 * them between message_start and message_delta, so the biggest numbers win).
 */
export function cacheUsageFromBody(body: string): CacheUsage | null {
    const text = body.trim();
    if (!text) return null;
    if (text.startsWith('{')) {
        try {
            const parsed = readCacheUsage(JSON.parse(text));
            if (parsed) return parsed;
        } catch {
            // Not one JSON document: read it as a stream.
        }
    }
    let result: CacheUsage | null = null;
    let from = text.length;
    for (let hits = 0; hits < MAX_STREAM_HITS && from > 0; hits++) {
        const index = Math.max(text.lastIndexOf('"usage"', from - 1), text.lastIndexOf('"usageMetadata"', from - 1));
        if (index < 0) break;
        const lineStart = text.lastIndexOf('\n', index) + 1;
        const lineEnd = text.indexOf('\n', index);
        const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim();
        from = lineStart;
        const data = line.replace(/^data:\s?/, '').trim();
        if (!data.startsWith('{')) continue;
        try {
            const usage = readCacheUsage(JSON.parse(data));
            if (usage) {
                result = result
                    ? { prompt: Math.max(result.prompt, usage.prompt), cached: Math.max(result.cached, usage.cached) }
                    : usage;
            }
        } catch {
            // A chunk split across lines or not JSON.
        }
    }
    return result;
}

/* ------------------------------------------------------------------ prompt hashes */

/** FNV-1a over UTF-16 code units, mixed with the length (comparisons only, not for storage). */
export function quickHash(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash ^ text.length) >>> 0;
}

/** Text of a chat-completion message: string content, or the text parts of multimodal content. */
export function messageContentText(message: unknown): string {
    if (!isDict(message)) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => (isDict(part) && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
}

/** One hash per message: role, name and text. */
export function hashMessages(messages: readonly unknown[]): number[] {
    return messages.map((message) => {
        const role = isDict(message) && typeof message.role === 'string' ? message.role : '';
        const name = isDict(message) && typeof message.name === 'string' ? message.name : '';
        return quickHash(`${role}\u0001${name}\u0001${messageContentText(message)}`);
    });
}

/** Message hashes of an outgoing chat-completion request body; null for other bodies (text completion). */
export function requestMessageHashes(body: unknown): number[] | null {
    if (typeof body !== 'string' || !body.includes('"messages"')) return null;
    try {
        const parsed: unknown = JSON.parse(body);
        return isDict(parsed) && Array.isArray(parsed.messages) ? hashMessages(parsed.messages) : null;
    } catch {
        return null;
    }
}

/**
 * Index of the first message that differs from the previous request (a cache can serve everything before it);
 * null without a previous request. Identical prompts give their length.
 */
export function firstChangeIndex(previous: readonly number[] | null, current: readonly number[]): number | null {
    if (!previous) return null;
    const length = Math.min(previous.length, current.length);
    for (let i = 0; i < length; i++) if (previous[i] !== current[i]) return i;
    return length;
}

/* ------------------------------------------------------------------ statistics */

export interface CacheSample {
    at: number;
    /** Null when the response had no usage numbers. */
    prompt: number | null;
    cached: number | null;
    firstChangeAt: number | null;
}

export interface CacheSummary {
    requests: number;
    cachedTokens: number;
    promptTokens: number;
    hitRate: number;
    firstChangeAt: number | null;
}

export function median(values: readonly number[]): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? (sorted[middle] as number)
        : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Totals over the newest `window` samples; the first change point is the median. */
export function summarizeCache(samples: readonly CacheSample[], window = 50): CacheSummary {
    const recent = samples.slice(-window);
    let cachedTokens = 0;
    let promptTokens = 0;
    for (const sample of recent) {
        if (sample.prompt === null) continue;
        promptTokens += sample.prompt;
        cachedTokens += sample.cached ?? 0;
    }
    const changes = recent.map((sample) => sample.firstChangeAt).filter((value): value is number => value !== null);
    return {
        requests: recent.length,
        cachedTokens,
        promptTokens,
        hitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
        firstChangeAt: median(changes),
    };
}

/* ------------------------------------------------------------------ P16 */

/** ST extension_prompt_types. */
const IN_PROMPT = 0;
const BEFORE_PROMPT = 2;

export interface LocatedSlot {
    key: string;
    /** Message index the injection was found in. */
    index: number;
    position: number;
    depth: number;
}

export interface OrderViolation {
    key: string;
    messageIndex: number;
    /** Messages after the injection that were already in the previous request (stable content). */
    stableAfter: number;
    position: number;
    depth: number;
}

/**
 * P16: a volatile injection must not sit before stable content — every message after it that the previous request
 * already had (same hash anywhere in it) would be re-billed. Without a previous request only injections in the
 * prompt's head (in-prompt / before-prompt positions) with messages after them are reported.
 */
export function findOrderViolations(
    slots: readonly LocatedSlot[],
    hashes: readonly number[],
    previous: ReadonlySet<number> | null,
): OrderViolation[] {
    const violations: OrderViolation[] = [];
    for (const slot of slots) {
        if (slot.index < 0 || slot.index >= hashes.length) continue;
        let stableAfter = 0;
        if (previous) {
            for (let i = slot.index + 1; i < hashes.length; i++) if (previous.has(hashes[i] as number)) stableAfter++;
        } else if (slot.position === IN_PROMPT || slot.position === BEFORE_PROMPT) {
            stableAfter = hashes.length - slot.index - 1;
        }
        if (stableAfter > 0) {
            violations.push({
                key: slot.key,
                messageIndex: slot.index,
                stableAfter,
                position: slot.position,
                depth: slot.depth,
            });
        }
    }
    return violations;
}
