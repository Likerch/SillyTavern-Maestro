import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../src/core/bus';
import { costFileName, createCostMeter, dateKey, readUsage, usageFromBody } from '../../src/core/cost';
import { Settings } from '../../src/core/settings';
import { createHost } from '../../src/host';
import type { HostImpl } from '../../src/host';
import { installStMock, message } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { completion, memoryFiles, memoryLogger, settle, sse, streamOf } from '../helpers/host-fakes';
import type { MemoryFiles } from '../helpers/host-fakes';

const GENERATE = '/api/backends/chat-completions/generate';
const DAY = new Date(2026, 9, 4, 12, 0, 0).getTime();

let mock: StMock;
let host: HostImpl;
let files: MemoryFiles;
let clock: number;
/** What the fake server answers to the next generate requests. */
let answers: (() => Response)[];

beforeEach(() => {
    mock = installStMock();
    answers = [];
    const mockFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(GENERATE)) {
            const next = answers.shift();
            return next ? next() : new Response('{}');
        }
        return mockFetch(input, init);
    };
    host = createHost(memoryLogger());
    host.install();
    files = memoryFiles();
    clock = DAY;
});

afterEach(() => {
    host.dispose();
    delete (globalThis as Record<string, unknown>)['memory_intercept_messages'];
});

function setup(
    core: {
        cap?: number;
        limit?: { enabled: boolean; usd: number; action: 'warn' | 'economy' | 'stopBackground' };
    } = {},
) {
    const log = memoryLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    if (core.cap !== undefined) settings.core().backgroundDailyCapUsd = core.cap;
    if (core.limit) settings.core().dailyLimit = core.limit;
    const bus = createBus(log);
    const meter = createCostMeter({ host, settings, files, bus, log, now: () => clock, persistDelayMs: 10 });
    meter.install();
    return { meter, bus, settings, log };
}

/** NAI Studio adds fields to media items that global.d.ts does not declare. */
function asExtra(extra: Record<string, unknown>): STChatMessage['extra'] {
    return extra as STChatMessage['extra'];
}

function json(body: unknown): () => Response {
    return () => new Response(JSON.stringify(body), { status: 200 });
}

async function generate(body: Record<string, unknown> = { stream: false }, init: RequestInit = {}): Promise<string> {
    const response = await fetch(GENERATE, { method: 'POST', body: JSON.stringify(body), ...init });
    const text = await response.text();
    await settle();
    return text;
}

describe('cost meter: fetch-level capture', () => {
    it('attributes a response during a generation to main, with the generation type as task', async () => {
        const { meter, bus } = setup();
        await bus.emit('generation:before', { type: 'swipe', dryRun: false, quiet: false });
        answers.push(json(completion('Hi', { prompt_tokens: 1000, completion_tokens: 200, cost: 0.004 })));
        const text = await generate();
        // The caller still gets the whole body.
        expect(JSON.parse(text).choices[0].message.content).toBe('Hi');
        expect(meter.summary()).toEqual({
            todayUsd: 0.004,
            todayBySource: { main: 0.004 },
            backgroundTodayUsd: 0,
            anlasToday: 0,
        });
        const entry = meter.today().recent[0]!;
        expect(entry).toMatchObject({ source: 'main', task: 'swipe', usd: 0.004, estimated: false, chatId: 'chat-1' });
        expect(entry.tokens).toEqual({ prompt: 1000, completion: 200 });
    });

    it('reads usage from the last chunk of a streamed response', async () => {
        const { meter, bus } = setup();
        await bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        const body = sse([
            { choices: [{ delta: { content: 'Hel' } }] },
            { choices: [{ delta: { content: 'lo' } }] },
            { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, cost: 0.0001 } },
        ]);
        const half = Math.floor(body.length / 2);
        answers.push(() => new Response(streamOf([body.slice(0, half), body.slice(half)])));
        const text = await generate({ stream: true });
        expect(text).toBe(body);
        expect(meter.summary().todayBySource).toEqual({ main: 0.0001 });
        expect(meter.today().tokens).toEqual({ prompt: 50, completion: 2 });
    });

    it('after the generation: qvink when Qvink is installed, otherwise other', async () => {
        const { meter, bus } = setup();
        await bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        await bus.emit('generation:ended', { type: 'normal', stopped: false });
        answers.push(json(completion('x', { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 })));
        await generate();
        (globalThis as Record<string, unknown>)['memory_intercept_messages'] = () => {};
        answers.push(json(completion('summary', { prompt_tokens: 1, completion_tokens: 1, cost: 0.02 })));
        await generate();
        expect(meter.summary().todayBySource).toEqual({ other: 0.01, qvink: 0.02 });
    });

    it('a generation claims only its first request, decided when the request leaves', async () => {
        const { meter, bus } = setup();
        await bus.emit('generation:before', { type: 'quiet', dryRun: false, quiet: true });
        // The main request is slow; a neighbour's request leaves later and finishes first.
        let releaseMain!: () => void;
        const mainGate = new Promise<void>((resolve) => (releaseMain = resolve));
        const slowBody = new ReadableStream<Uint8Array>({
            async pull(controller) {
                await mainGate;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(completion('main', { cost: 0.25 }))));
                controller.close();
            },
        });
        answers.push(() => new Response(slowBody));
        answers.push(json(completion('tracker', { cost: 0.5 })));
        const main = fetch(GENERATE, { method: 'POST', body: '{"stream":false}' }).then((response) => response.text());
        await settle();
        await generate();
        releaseMain();
        await main;
        await settle();
        expect(meter.today().recent.map((entry) => [entry.source, entry.task])).toEqual([
            ['other', undefined],
            ['main', 'quiet'],
        ]);
        // No GENERATION_ENDED for a quiet generation: later requests are not 'main'.
        answers.push(json(completion('later', { cost: 1 })));
        await generate();
        expect(meter.summary().todayBySource).toEqual({ main: 0.25, other: 1.5 });
    });

    it('a stale generation window expires', async () => {
        const { meter, bus } = setup();
        await bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        clock += 6 * 60_000;
        answers.push(json(completion('x', { cost: 0.5 })));
        await generate();
        expect(meter.summary().todayBySource).toEqual({ other: 0.5 });
    });

    it('marks responses without a cost as estimated and ignores failures and missing usage', async () => {
        const { meter } = setup();
        answers.push(json(completion('a', { prompt_tokens: 10, completion_tokens: 5 })));
        answers.push(json(completion('b')));
        answers.push(() => new Response('{"error":{"message":"bad"}}', { status: 500 }));
        await generate();
        await generate();
        await generate();
        const today = meter.today();
        expect(today.requests).toBe(1);
        expect(today.estimated).toBe(1);
        expect(today.recent[0]).toMatchObject({ source: 'other', usd: 0, estimated: true });
    });

    it("skips Maestro's own requests by signal, without hiding concurrent ones", async () => {
        const { meter } = setup();
        const own = new AbortController();
        meter.beginOwn(own.signal);
        answers.push(json(completion('own', { prompt_tokens: 1, completion_tokens: 1, cost: 1 })));
        answers.push(json(completion('neighbour', { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 })));
        await generate({ stream: false }, { signal: own.signal });
        await generate();
        meter.endOwn(own.signal);
        expect(meter.summary().todayUsd).toBe(0.5);
    });

    it('skips everything while an unmarked own request is in flight (counter fallback)', async () => {
        const { meter } = setup();
        meter.beginOwn();
        answers.push(json(completion('x', { prompt_tokens: 1, completion_tokens: 1, cost: 1 })));
        await generate();
        meter.endOwn();
        answers.push(json(completion('y', { prompt_tokens: 1, completion_tokens: 1, cost: 2 })));
        await generate();
        expect(meter.summary().todayUsd).toBe(2);
    });
});

describe('cost meter: caps and limits', () => {
    it('background cap counts only Maestro spend', () => {
        const { meter } = setup({ cap: 0.5 });
        meter.record({ source: 'main', usd: 1 });
        expect(meter.backgroundCapReached()).toBe(false);
        meter.record({ source: 'maestro', task: 'revision', usd: 0.25 });
        expect(meter.backgroundCapReached()).toBe(false);
        meter.record({ source: 'maestro', task: 'judge', usd: 0.25 });
        expect(meter.backgroundCapReached()).toBe(true);
        expect(meter.today().byTask).toEqual({ revision: 0.25, judge: 0.25 });
        expect(meter.summary().backgroundTodayUsd).toBe(0.5);
    });

    it('a zero cap means no cap', () => {
        const { meter } = setup({ cap: 0 });
        meter.record({ source: 'maestro', usd: 100 });
        expect(meter.backgroundCapReached()).toBe(false);
    });

    it('the overall daily limit notifies once and stops background work only when asked to', () => {
        const warn = setup({ limit: { enabled: true, usd: 1, action: 'warn' } });
        const hits: unknown[] = [];
        let changes = 0;
        warn.meter.onLimitReached((info) => hits.push(info));
        warn.meter.onChange(() => changes++);
        warn.meter.record({ source: 'main', usd: 0.6 });
        expect(warn.meter.dailyLimitReached()).toBe(false);
        warn.meter.record({ source: 'main', usd: 0.6 });
        warn.meter.record({ source: 'main', usd: 0.1 });
        expect(changes).toBe(3);
        expect(hits).toEqual([{ usd: 1.2, limit: 1, action: 'warn' }]);
        expect(warn.meter.dailyLimitReached()).toBe(true);
        expect(warn.meter.backgroundCapReached()).toBe(false);

        const stop = setup({ limit: { enabled: true, usd: 1, action: 'stopBackground' } });
        stop.meter.record({ source: 'main', usd: 1 });
        expect(stop.meter.backgroundCapReached()).toBe(true);

        const off = setup({ limit: { enabled: false, usd: 1, action: 'stopBackground' } });
        off.meter.record({ source: 'main', usd: 5 });
        expect(off.meter.backgroundCapReached()).toBe(false);
        expect(off.meter.dailyLimitReached()).toBe(false);
    });
});

describe('cost meter: Anlas', () => {
    it('counts a NAI Studio picture post once', async () => {
        const { meter, bus } = setup();
        mock.chat.push(message('hello'));
        mock.chat.push(
            message('a scene', {
                send_date: 't1',
                extra: asExtra({
                    media: [{ url: '/img/1.png', type: 'image', nai_studio: { cost: 20, correlationId: 'c1' } }],
                    nai_studio: { model: 'nai-diffusion-4-5-full', cost: 20 },
                }),
            }),
        );
        await bus.emit('reply:ready', { messageIndex: 1, type: 'extension' });
        await bus.emit('reply:ready', { messageIndex: 1, type: 'extension' });
        await bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(meter.summary().anlasToday).toBe(20);
        expect(meter.summary().todayUsd).toBe(0);
    });

    it('counts inline pictures once per generation batch', async () => {
        const { meter, bus } = setup();
        mock.chat.push(
            message('reply', {
                extra: asExtra({
                    media: [
                        { url: '/a.png', type: 'image', nai_studio: { cost: 10, correlationId: 'b1' } },
                        { url: '/b.png', type: 'image', nai_studio: { cost: 10, correlationId: 'b1' } },
                        { url: '/c.png', type: 'image', nai_studio: { cost: 5 } },
                        { url: '/d.png', type: 'image' },
                    ],
                }),
            }),
        );
        await bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        expect(meter.summary().anlasToday).toBe(15);
        meter.recordAnlas(-3);
        meter.recordAnlas(2);
        expect(meter.summary().anlasToday).toBe(17);
    });
});

describe('cost meter: persistence', () => {
    it('writes the day file after the debounce and merges with what other tabs wrote', async () => {
        const name = costFileName('2026-10-04');
        files.data.set(name, {
            version: 1,
            date: '2026-10-04',
            totalUsd: 1,
            bySource: { main: 1 },
            byTask: {},
            tokens: { prompt: 10, completion: 1 },
            requests: 1,
            estimated: 0,
            anlas: 4,
            recent: [{ source: 'main', usd: 1, at: DAY - 1000 }],
        });
        const { meter } = setup();
        await settle();
        // Loaded at install.
        expect(meter.summary()).toEqual({
            todayUsd: 1,
            todayBySource: { main: 1 },
            backgroundTodayUsd: 0,
            anlasToday: 4,
        });

        meter.record({ source: 'maestro', task: 'judge', usd: 0.5 });
        expect(files.writes).toEqual([]);
        // Another tab adds to the file meanwhile.
        const stored = files.data.get(name) as { totalUsd: number; bySource: Record<string, number> };
        files.data.set(name, { ...stored, totalUsd: 3, bySource: { main: 3 } });
        await new Promise((resolve) => setTimeout(resolve, 30));
        await settle();
        expect(files.writes).toEqual([name]);
        const written = files.data.get(name) as {
            totalUsd: number;
            bySource: Record<string, number>;
            recent: unknown[];
        };
        expect(written.totalUsd).toBe(3.5);
        expect(written.bySource).toEqual({ main: 3, maestro: 0.5 });
        expect(written.recent).toHaveLength(2);
        expect(meter.summary().todayUsd).toBe(3.5);
    });

    it('starts a new day at midnight and writes the old day to its own file', async () => {
        const { meter } = setup();
        meter.record({ source: 'main', usd: 2 });
        clock = new Date(2026, 9, 5, 0, 0, 1).getTime();
        expect(meter.summary().todayUsd).toBe(0);
        meter.record({ source: 'main', usd: 1 });
        await meter.flush();
        expect((files.data.get(costFileName('2026-10-04')) as { totalUsd: number }).totalUsd).toBe(2);
        expect((files.data.get(costFileName('2026-10-05')) as { totalUsd: number }).totalUsd).toBe(1);
        expect(meter.today().date).toBe('2026-10-05');
    });

    it('dispose flushes pending totals and stops listening', async () => {
        const { meter, bus } = setup();
        meter.record({ source: 'main', usd: 0.25 });
        meter.dispose();
        await settle();
        expect((files.data.get(costFileName('2026-10-04')) as { totalUsd: number }).totalUsd).toBe(0.25);
        await bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        answers.push(json(completion('x', { prompt_tokens: 1, completion_tokens: 1, cost: 9 })));
        await generate();
        expect(meter.summary().todayUsd).toBe(0.25);
    });

    it('ignores a corrupt or foreign day file', async () => {
        files.data.set(costFileName('2026-10-04'), { date: '2026-10-03', totalUsd: 50 });
        const { meter } = setup();
        await settle();
        expect(meter.summary().todayUsd).toBe(0);
    });
});

describe('usage parsing', () => {
    it('reads OpenAI, Claude and Gemini usage', () => {
        expect(readUsage({ usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.1 } })).toEqual({
            prompt: 3,
            completion: 4,
            usd: 0.1,
        });
        expect(readUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({ prompt: 3, completion: 4 });
        expect(readUsage({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 } })).toEqual({
            prompt: 7,
            completion: 8,
        });
        expect(readUsage({ usage: null })).toBeUndefined();
        expect(readUsage('text')).toBeUndefined();
    });

    it('merges usage split across Claude stream events', () => {
        const body = [
            'event: message_start',
            `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 1 } } })}`,
            '',
            'event: message_delta',
            `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 15 } })}`,
            '',
        ].join('\n');
        expect(usageFromBody(body)).toEqual({ prompt: 25, completion: 15 });
        expect(usageFromBody('')).toBeUndefined();
        expect(usageFromBody('data: {broken usage')).toBeUndefined();
    });

    it('dateKey uses the local date', () => {
        expect(dateKey(DAY)).toBe('2026-10-04');
    });
});
