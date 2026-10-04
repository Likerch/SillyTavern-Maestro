// Provider prompt-cache measurement (plan M20 п. 6). The main generation's request is recognised by M20 itself:
// CHAT_COMPLETION_PROMPT_READY of a real turn arms the meter and the next chat-completion request takes the arm
// (ST sends it right after the event). Its body is hashed per message after it left (a timer, not on the send
// path) to find where the prompt first differs from the previous main request; the response (a clone from the
// fetch gate: streams are tee'd) is scanned for the provider's cache numbers. The last 50 requests make the stats.
import {
    cacheUsageFromBody,
    firstChangeIndex,
    requestMessageHashes,
    summarizeCache,
} from '../../domain/architect-cache';
import type { CacheSample } from '../../domain/architect-cache';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { CacheStats } from './api';

export const GENERATE_URL = /\/api\/backends\/chat-completions\/generate/;
/** An arm the request never claimed (aborted generation) expires. */
const ARM_TTL_MS = 60_000;
export const CACHE_WINDOW = 50;
const KEEP_SAMPLES = CACHE_WINDOW * 2;

interface Pending {
    at: number;
    chatId: string | null;
    firstChangeAt: number | null;
    /** Hashing finished (it runs on a timer after the request left). */
    hashed: boolean;
    response: { prompt: number | null; cached: number | null } | null;
}

export class CacheMeter {
    private armedAt: number | null = null;
    private readonly pending = new WeakMap<object, Pending>();
    private samples: CacheSample[] = [];
    private previous: { chatId: string | null; hashes: number[] } | null = null;
    private readonly listeners = new Set<() => void>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly enabled: () => boolean,
        private readonly log: Logger,
        private readonly now: () => number = Date.now,
    ) {}

    install(): Unsubscribe[] {
        const gate = this.app.host.fetchGate;
        return [
            gate.beforeRequest(GENERATE_URL, (_url, init) => {
                this.onRequest(init);
            }),
            gate.afterResponse(GENERATE_URL, (_url, response, init) => this.onResponse(response, init)),
            () => {
                this.disposed = true;
                this.listeners.clear();
            },
        ];
    }

    /** The next chat-completion request is the main generation's. */
    arm(): void {
        if (this.enabled()) this.armedAt = this.now();
    }

    disarm(): void {
        this.armedAt = null;
    }

    /** A new chat: the first change is measured against requests of this chat only. */
    reset(): void {
        this.previous = null;
        this.armedAt = null;
    }

    stats(): CacheStats {
        return summarizeCache(this.samples, CACHE_WINDOW);
    }

    samplesCount(): number {
        return this.samples.length;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private onRequest(init: RequestInit | undefined): void {
        const armed = this.armedAt;
        if (armed === null || !init || this.disposed) return;
        this.armedAt = null;
        if (this.now() - armed > ARM_TTL_MS) return;
        const pending: Pending = {
            at: this.now(),
            chatId: this.app.host.chatId(),
            firstChangeAt: null,
            hashed: false,
            response: null,
        };
        this.pending.set(init, pending);
        const body = init.body;
        // The body string is immutable: hash it once the request is on its way.
        setTimeout(() => {
            try {
                const hashes = requestMessageHashes(body);
                if (hashes) {
                    const previous =
                        this.previous && this.previous.chatId === pending.chatId ? this.previous.hashes : null;
                    pending.firstChangeAt = firstChangeIndex(previous, hashes);
                    this.previous = { chatId: pending.chatId, hashes };
                }
            } catch (error) {
                this.log.debug('request body could not be hashed', error);
            }
            pending.hashed = true;
            if (pending.response) this.commit(pending);
        }, 0);
    }

    private onResponse(response: Response, init: RequestInit | undefined): void {
        const pending = init ? this.pending.get(init) : undefined;
        if (!pending || !init) return;
        this.pending.delete(init);
        if (!response.ok) return;
        // text() must start synchronously: the fetch gate cancels copies nobody reads.
        response
            .text()
            .then((text) => {
                const usage = cacheUsageFromBody(text);
                pending.response = { prompt: usage?.prompt ?? null, cached: usage?.cached ?? null };
                if (pending.hashed) this.commit(pending);
            })
            .catch((error: unknown) => this.log.debug('could not read the cache numbers of a response', error));
    }

    private commit(pending: Pending): void {
        if (this.disposed || !pending.response) return;
        this.samples.push({
            at: pending.at,
            prompt: pending.response.prompt,
            cached: pending.response.cached,
            firstChangeAt: pending.firstChangeAt,
        });
        if (this.samples.length > KEEP_SAMPLES) this.samples = this.samples.slice(-CACHE_WINDOW);
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('cache listener failed', error);
            }
        }
    }
}
