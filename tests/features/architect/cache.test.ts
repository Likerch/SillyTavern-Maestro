// Provider cache measurement through the fetch gate: only the main generation's request is measured (armed by its
// PROMPT_READY), streamed and non-streamed responses of OpenRouter and DeepSeek, the first changed message.
import { afterEach, describe, expect, it } from 'vitest';
import { architectSettings, runTurn, startArchitect, tick } from './helpers';
import type { ArchitectTestApp } from './helpers';

const URL = '/api/backends/chat-completions/generate';

let app: ArchitectTestApp;

afterEach(async () => {
    await app?.stop();
});

function body(messages: { role: string; content: string }[], stream = false): string {
    return JSON.stringify({ model: 'x', stream, messages });
}

function json(data: unknown, init: ResponseInit = { status: 200 }): Response {
    return new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json' } });
}

function sse(chunks: unknown[]): Response {
    const text = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function mainTurn(): Promise<void> {
    await runTurn(app, { books: [], chatText: '', messages: [{ role: 'user', content: 'Hi' }] });
}

async function settleResponse(): Promise<void> {
    await tick();
    await tick();
}

describe('cache stats', () => {
    it('measures the main request of a turn (OpenRouter, non-streamed)', async () => {
        app = await startArchitect();
        await mainTurn();
        const messages = [
            { role: 'system', content: 'Main.' },
            { role: 'user', content: 'Hi' },
        ];
        await app.gate.send(
            URL,
            { method: 'POST', body: body(messages) },
            json({
                usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
            }),
        );
        await settleResponse();
        expect(app.api.cache()).toEqual({
            requests: 1,
            cachedTokens: 0,
            promptTokens: 1000,
            hitRate: 0,
            firstChangeAt: null,
        });

        await mainTurn();
        const next = [...messages, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'More' }];
        next[1] = { role: 'user', content: 'Hi' };
        await app.gate.send(
            URL,
            { method: 'POST', body: body(next) },
            json({
                usage: { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 1000 } },
            }),
        );
        await settleResponse();
        const stats = app.api.cache();
        expect(stats.requests).toBe(2);
        expect(stats.cachedTokens).toBe(1000);
        expect(stats.promptTokens).toBe(2200);
        expect(stats.hitRate).toBeCloseTo(1000 / 2200);
        expect(stats.firstChangeAt).toBe(2);
    });

    it('reads a streamed DeepSeek response', async () => {
        app = await startArchitect();
        await mainTurn();
        await app.gate.send(
            URL,
            { method: 'POST', body: body([{ role: 'user', content: 'Hi' }], true) },
            sse([
                { choices: [{ delta: { content: 'He' } }] },
                {
                    choices: [],
                    usage: { prompt_tokens: 800, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 160 },
                },
            ]),
        );
        await settleResponse();
        expect(app.api.cache()).toMatchObject({ requests: 1, cachedTokens: 640, promptTokens: 800, hitRate: 0.8 });
    });

    it('ignores requests that are not the main generation, failed responses and the switched-off meter', async () => {
        app = await startArchitect();
        const notify: number[] = [];
        app.api.onCache?.(() => notify.push(1));
        // No turn armed the meter: Qvink summaries, Maestro tasks, DES tracker calls.
        await app.gate.send(
            URL,
            { method: 'POST', body: body([{ role: 'user', content: 'x' }]) },
            json({ usage: { prompt_tokens: 5 } }),
        );
        await mainTurn();
        await app.gate.send(
            URL,
            { method: 'POST', body: body([{ role: 'user', content: 'x' }]) },
            json({ error: 'x' }, { status: 500 }),
        );
        // The arm was taken by the failed request.
        await app.gate.send(
            URL,
            { method: 'POST', body: body([{ role: 'user', content: 'x' }]) },
            json({ usage: { prompt_tokens: 5 } }),
        );
        architectSettings(app).cache.measure = false;
        await mainTurn();
        await app.gate.send(
            URL,
            { method: 'POST', body: body([{ role: 'user', content: 'x' }]) },
            json({ usage: { prompt_tokens: 5 } }),
        );
        await settleResponse();
        expect(app.api.cache().requests).toBe(0);
        expect(notify).toEqual([]);
    });

    it('counts responses without cache numbers as requests, not as prompt tokens', async () => {
        app = await startArchitect();
        await mainTurn();
        await app.gate.send(URL, { method: 'POST', body: '{"prompt":"text completion"}' }, json({ choices: [] }));
        await settleResponse();
        expect(app.api.cache()).toEqual({
            requests: 1,
            cachedTokens: 0,
            promptTokens: 0,
            hitRate: 0,
            firstChangeAt: null,
        });
    });

    it('starts the first-change comparison again in another chat', async () => {
        app = await startArchitect();
        const messages = [{ role: 'user', content: 'Hi' }];
        await mainTurn();
        await app.gate.send(URL, { method: 'POST', body: body(messages) }, json({ usage: { prompt_tokens: 10 } }));
        await settleResponse();
        await app.env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        await mainTurn();
        await app.gate.send(URL, { method: 'POST', body: body(messages) }, json({ usage: { prompt_tokens: 10 } }));
        await settleResponse();
        expect(app.api.cache().firstChangeAt).toBeNull();
    });
});
