// One wrapper around window.fetch for the tab guard (M4) and the cost meter (M21), installed once at load
// and never removed during a generation (plan §10.11, audit T11/T16).
//
// DES swaps window.fetch temporarily inside safeGenerateRaw and then restores the reference it captured
// (vendor/des/src/utils/responseExtractor.js). That reference may be our wrapper, so dispose() must never
// leave a dead function behind: when window.fetch is no longer ours we only switch the wrapper into
// pass-through mode.
import type { FetchGate, Logger, Unsubscribe } from '../shared/contracts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type BeforeHook = (url: string, init: RequestInit | undefined) => Promise<Response | void> | Response | void;
type AfterHook = (url: string, response: Response, init?: RequestInit) => void;

interface HookEntry<T> {
    match: RegExp;
    fn: T;
}

/** Where window.fetch lives (window in the browser; a fake in tests). */
export interface FetchTarget {
    fetch: FetchFn;
}

export interface FetchGateImpl extends FetchGate {
    /** Wraps target.fetch once; later calls are no-ops. */
    install(): void;
    /** Restores the original fetch if nobody wrapped it after us, otherwise turns the wrapper into a pass-through. */
    dispose(): void;
    installed(): boolean;
    /** The fetch that was in place before install (for requests that must bypass every hook). */
    original(): FetchFn | undefined;
}

/** Marks Maestro's wrapper so diagnostics can tell who owns window.fetch. */
export const MAESTRO_FETCH = Symbol.for('maestro.fetchGate');

/** Statuses whose responses must not carry a body (new Response(body, {status}) throws for them). */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export function createFetchGate(log: Logger, target: FetchTarget = globalThis): FetchGateImpl {
    const before = new Set<HookEntry<BeforeHook>>();
    const after = new Set<HookEntry<AfterHook>>();
    let original: FetchFn | undefined;
    let wrapper: FetchFn | undefined;
    let passThrough = false;

    async function gated(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const base = original;
        if (!base) throw new Error('Maestro fetch gate has no original fetch');
        if (passThrough) return base.call(globalThis, input, init);

        const url = requestUrl(input);
        for (const hook of [...before]) {
            if (!matches(hook.match, url)) continue;
            try {
                const result = await hook.fn(url, init);
                if (result instanceof Response) return result;
            } catch (error) {
                log.warn('fetch beforeRequest hook failed', error);
            }
        }

        const response = await base.call(globalThis, input, init);
        if (passThrough) return response;
        const hooks = [...after].filter((hook) => matches(hook.match, url));
        if (hooks.length === 0) return response;
        return deliver(response, url, init, hooks);
    }

    function deliver(
        response: Response,
        url: string,
        init: RequestInit | undefined,
        hooks: HookEntry<AfterHook>[],
    ): Response {
        let forCaller = response;
        let forHooks: Response;
        try {
            if (
                response.body &&
                isStreaming(response, init) &&
                !NULL_BODY_STATUS.has(response.status) &&
                response.status >= 200
            ) {
                // Streams are tee'd: the caller keeps reading at full speed, hooks read their own branch.
                const [callerBranch, hookBranch] = response.body.tee();
                const options: ResponseInit = {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                };
                forCaller = new Response(callerBranch, options);
                forHooks = new Response(hookBranch, options);
            } else {
                forHooks = response.clone();
            }
        } catch (error) {
            log.warn('fetch gate could not copy a response for hooks', error);
            return response;
        }

        // Every hook gets its own copy; clones are taken before any hook starts reading.
        const copies = hooks.map((_, index) => (index < hooks.length - 1 ? forHooks.clone() : forHooks));
        hooks.forEach((hook, index) => {
            const copy = copies[index] as Response;
            try {
                const result: unknown = hook.fn(url, copy, init);
                if (result instanceof Promise) {
                    result.catch((error: unknown) => log.warn('fetch afterResponse hook failed', error));
                }
            } catch (error) {
                log.warn('fetch afterResponse hook failed', error);
            }
            release(copy);
        });
        return forCaller;
    }

    return {
        beforeRequest(match: RegExp, hook: BeforeHook): Unsubscribe {
            const entry = { match, fn: hook };
            before.add(entry);
            return () => {
                before.delete(entry);
            };
        },

        afterResponse(match: RegExp, hook: AfterHook): Unsubscribe {
            const entry = { match, fn: hook };
            after.add(entry);
            return () => {
                after.delete(entry);
            };
        },

        install(): void {
            if (wrapper) return;
            const current = target.fetch;
            if (typeof current !== 'function') {
                log.warn('window.fetch is missing; the fetch gate is not installed');
                return;
            }
            original = current;
            passThrough = false;
            const fn: FetchFn = function maestroFetch(input: RequestInfo | URL, init?: RequestInit) {
                return gated(input, init);
            };
            Object.defineProperty(fn, MAESTRO_FETCH, { value: true });
            wrapper = fn;
            target.fetch = fn;
        },

        dispose(): void {
            before.clear();
            after.clear();
            if (!wrapper) return;
            if (target.fetch === wrapper && original) {
                target.fetch = original;
            } else {
                // Someone (DES's safeGenerateRaw, another extension) holds our wrapper: keep it working.
                passThrough = true;
                log.debug('window.fetch was re-wrapped by someone else; the gate stays as a pass-through');
            }
            wrapper = undefined;
        },

        installed(): boolean {
            return wrapper !== undefined && !passThrough;
        },

        original(): FetchFn | undefined {
            return original;
        },
    };
}

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

function matches(pattern: RegExp, url: string): boolean {
    pattern.lastIndex = 0;
    return pattern.test(url);
}

/**
 * ST's generate endpoint pipes the provider stream without a content type (src/util.js forwardFetchResponse),
 * so the request body's `"stream": true` is the reliable sign of a streamed response.
 */
function isStreaming(response: Response, init: RequestInit | undefined): boolean {
    const type = response.headers.get('content-type') ?? '';
    if (/event-stream|ndjson/i.test(type)) return true;
    if (/json/i.test(type)) return false;
    return typeof init?.body === 'string' && /"stream"\s*:\s*true/.test(init.body);
}

/**
 * A copy nobody started reading would buffer the whole body in memory: cancel it. Hooks must call
 * .text()/.json()/.body.getReader() before their first await.
 */
function release(copy: Response): void {
    const body = copy.body;
    if (!body || copy.bodyUsed || body.locked) return;
    body.cancel().catch(() => {});
}
