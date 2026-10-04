import { describe, expect, it, vi } from 'vitest';
import { createFetchGate, MAESTRO_FETCH } from '../../src/host/fetch-gate';
import type { FetchTarget } from '../../src/host/fetch-gate';
import { memoryLogger, readAll, settle, streamOf } from '../helpers/host-fakes';

type FetchFn = FetchTarget['fetch'];

function setup(respond: FetchFn = async () => new Response('{"ok":true}', { status: 200 })) {
    const calls: string[] = [];
    const original: FetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return respond(input, init);
    });
    const target: FetchTarget = { fetch: original };
    const log = memoryLogger();
    const gate = createFetchGate(log, target);
    return { gate, target, original, calls, log };
}

describe('fetch gate', () => {
    it('installs once and passes requests through', async () => {
        const { gate, target, original } = setup();
        gate.install();
        const wrapper = target.fetch;
        gate.install();
        expect(target.fetch).toBe(wrapper);
        expect(wrapper).not.toBe(original);
        expect((wrapper as unknown as Record<symbol, unknown>)[MAESTRO_FETCH]).toBe(true);
        const response = await target.fetch('/api/x');
        expect(await response.json()).toEqual({ ok: true });
        expect(gate.installed()).toBe(true);
        expect(gate.original()).toBe(original);
    });

    it('runs beforeRequest hooks in order, can delay a request', async () => {
        const { gate, target, calls } = setup();
        gate.install();
        const steps: string[] = [];
        let release!: () => void;
        const gateOpen = new Promise<void>((resolve) => {
            release = resolve;
        });
        gate.beforeRequest(/\/api\/settings\/save/, async () => {
            steps.push('hook1');
            await gateOpen;
            steps.push('hook1 released');
        });
        gate.beforeRequest(/\/api\/settings/, () => {
            steps.push('hook2');
        });
        gate.beforeRequest(/\/other/, () => {
            steps.push('never');
        });
        const pending = target.fetch('/api/settings/save', { method: 'POST' });
        await settle();
        expect(calls).toEqual([]);
        expect(steps).toEqual(['hook1']);
        release();
        await pending;
        expect(steps).toEqual(['hook1', 'hook1 released', 'hook2']);
        expect(calls).toEqual(['/api/settings/save']);
    });

    it('vetoes a request when a hook returns a Response', async () => {
        const { gate, target, calls } = setup();
        gate.install();
        const after = vi.fn();
        gate.afterResponse(/save/, after);
        gate.beforeRequest(/save/, () => new Response('blocked', { status: 409 }));
        const later = vi.fn();
        gate.beforeRequest(/save/, later);
        const response = await target.fetch('/api/settings/save');
        expect(response.status).toBe(409);
        expect(await response.text()).toBe('blocked');
        expect(calls).toEqual([]);
        expect(later).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
    });

    it('isolates hook errors', async () => {
        const { gate, target, log } = setup();
        gate.install();
        gate.beforeRequest(/x/, () => {
            throw new Error('before boom');
        });
        gate.afterResponse(/x/, () => {
            throw new Error('after boom');
        });
        gate.afterResponse(/x/, async (_url, response) => {
            await response.text();
            throw new Error('async after boom');
        });
        const response = await target.fetch('/x');
        expect(await response.json()).toEqual({ ok: true });
        await settle();
        expect(log.lines.filter((line) => line.level === 'warn')).toHaveLength(3);
    });

    it('gives afterResponse hooks a clone of a JSON body and the request init', async () => {
        const { gate, target } = setup(
            async () => new Response('{"usage":{"cost":0.5}}', { headers: { 'content-type': 'application/json' } }),
        );
        gate.install();
        const seen: unknown[] = [];
        const init: RequestInit = { method: 'POST', body: '{"stream":false}' };
        gate.afterResponse(/generate/, (url, response, hookInit) => {
            expect(hookInit).toBe(init);
            void response.json().then((data) => seen.push([url, data]));
        });
        gate.afterResponse(/generate/, (_url, response) => {
            void response.text().then((text) => seen.push(text.length));
        });
        const response = await target.fetch('/api/backends/chat-completions/generate', init);
        expect(await response.json()).toEqual({ usage: { cost: 0.5 } });
        await settle();
        expect(seen).toContainEqual(['/api/backends/chat-completions/generate', { usage: { cost: 0.5 } }]);
        expect(seen).toContainEqual(22);
    });

    it('tees a streamed body: the caller reads chunk by chunk while the hook gets everything', async () => {
        const pieces = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
        const { gate, target } = setup(async () => new Response(streamOf(pieces), { status: 200, statusText: 'OK' }));
        gate.install();
        let hookText = '';
        const hookDone = new Promise<void>((resolve) => {
            gate.afterResponse(/generate/, (_url, response) => {
                void response.text().then((text) => {
                    hookText = text;
                    resolve();
                });
            });
        });
        const response = await target.fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            body: JSON.stringify({ stream: true, messages: [] }),
        });
        expect(response.status).toBe(200);
        expect(response.statusText).toBe('OK');
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read();
        expect(decoder.decode(first.value)).toBe(pieces[0]);
        let rest = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            rest += decoder.decode(value);
        }
        expect(rest).toBe(pieces[1]! + pieces[2]!);
        await hookDone;
        expect(hookText).toBe(pieces.join(''));
    });

    it('detects streams by content type too and cancels copies nobody reads', async () => {
        const { gate, target } = setup(
            async () =>
                new Response(streamOf(['data: 1\n\n', 'data: 2\n\n']), {
                    headers: { 'content-type': 'text/event-stream' },
                }),
        );
        gate.install();
        let given: Response | undefined;
        gate.afterResponse(/stream/, (_url, response) => {
            given = response;
        });
        const response = await target.fetch('/stream');
        expect(await readAll(response.body)).toBe('data: 1\n\ndata: 2\n\n');
        expect(given).toBeDefined();
        await settle();
        // The unread hook copy was cancelled: it is closed and yields nothing.
        const reader = given!.body!.getReader();
        expect((await reader.read()).done).toBe(true);
    });

    it('dispose restores the original fetch when it is still ours', async () => {
        const { gate, target, original } = setup();
        gate.install();
        const hook = vi.fn();
        gate.beforeRequest(/./, hook);
        gate.dispose();
        expect(target.fetch).toBe(original);
        expect(gate.installed()).toBe(false);
        await target.fetch('/x');
        expect(hook).not.toHaveBeenCalled();
    });

    it('dispose keeps a wrapped wrapper working as a pass-through (DES swaps fetch temporarily)', async () => {
        const { gate, target, original, calls } = setup();
        gate.install();
        const ours = target.fetch;
        const hook = vi.fn();
        gate.beforeRequest(/./, hook);
        // DES safeGenerateRaw: capture, wrap, …
        const captured = target.fetch;
        target.fetch = async (input, init) => captured(input, init);
        gate.dispose();
        expect(target.fetch).not.toBe(original);
        await target.fetch('/during-des');
        // … and restore the captured reference: our wrapper, now a pass-through.
        target.fetch = captured;
        expect(target.fetch).toBe(ours);
        const response = await target.fetch('/after-des');
        expect(await response.json()).toEqual({ ok: true });
        expect(calls).toEqual(['/during-des', '/after-des']);
        expect(hook).not.toHaveBeenCalled();
        expect(original).toHaveBeenCalledTimes(2);
    });

    it('propagates network errors from the original fetch', async () => {
        const { gate, target } = setup(async () => {
            throw new TypeError('Failed to fetch');
        });
        gate.install();
        gate.afterResponse(/./, () => {});
        await expect(target.fetch('/x')).rejects.toThrow('Failed to fetch');
    });

    it('matches URL objects and Request inputs, and global regexes repeatedly', async () => {
        const { gate, target } = setup();
        gate.install();
        const seen: string[] = [];
        gate.beforeRequest(/generate/g, (url) => {
            seen.push(url);
        });
        await target.fetch(new URL('http://localhost/api/generate'));
        await target.fetch(new Request('http://localhost/api/generate'));
        await target.fetch('/api/generate');
        expect(seen).toEqual(['http://localhost/api/generate', 'http://localhost/api/generate', '/api/generate']);
    });
});
