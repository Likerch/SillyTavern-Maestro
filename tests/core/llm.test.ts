import { beforeEach, describe, expect, it } from 'vitest';
import {
    BREAKER_OPEN_MS,
    createLlmClient,
    extractReply,
    looksLikeRefusal,
    matchesSchema,
    parseJsonText,
} from '../../src/core/llm';
import { Settings } from '../../src/core/settings';
import type { CostEntry, CostMeter, LlmRequest } from '../../src/shared/contracts';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { completion, memoryLogger } from '../helpers/host-fakes';

interface SentCall {
    profileId: string;
    messages: { role: string; content: string }[];
    maxTokens: number;
    custom: Record<string, unknown>;
    override: Record<string, unknown>;
}

let mock: StMock;
let calls: SentCall[];
let replies: (unknown | Error)[];

function fakeCost(capped = false) {
    const entries: Omit<CostEntry, 'at'>[] = [];
    const own: { begin: (AbortSignal | undefined)[]; end: (AbortSignal | undefined)[] } = { begin: [], end: [] };
    const cost: CostMeter & { beginOwn(signal?: AbortSignal): void; endOwn(signal?: AbortSignal): void } = {
        record: (entry) => entries.push(entry),
        recordAnlas: () => {},
        summary: () => ({ todayUsd: 0, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0 }),
        backgroundCapReached: () => capped,
        onChange: () => () => {},
        beginOwn: (signal) => own.begin.push(signal),
        endOwn: (signal) => own.end.push(signal),
    };
    return { cost, entries, own };
}

function setup(options: { capped?: boolean; profiles?: Record<string, string> } = {}) {
    const log = memoryLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.core().profiles = options.profiles ?? { default: 'p-default', fallback: 'p-fallback', judge: 'p-judge' };
    const { cost, entries, own } = fakeCost(options.capped);
    let clock = 1_000_000;
    const client = createLlmClient({
        host: { ctx: () => SillyTavern.getContext() } as never,
        settings,
        cost,
        log,
        backoffMs: [0, 0],
        now: () => clock,
    });
    return {
        client,
        entries,
        own,
        log,
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

beforeEach(() => {
    mock = installStMock();
    calls = [];
    replies = [];
    mock.sendRequest = async (profileId, prompt, maxTokens, custom, override) => {
        calls.push({
            profileId,
            messages: prompt as SentCall['messages'],
            maxTokens,
            custom: custom as Record<string, unknown>,
            override: override as Record<string, unknown>,
        });
        const next = replies.shift();
        if (next === undefined) throw new Error('API request failed', { cause: new Error('no scripted reply') });
        if (next instanceof Error) throw next;
        return next;
    };
});

const ask = (extra: Partial<LlmRequest> = {}): LlmRequest => ({
    task: 'judge',
    messages: [
        { role: 'system', content: 'You are a judge.' },
        { role: 'user', content: 'Rate this.' },
    ],
    maxTokens: 300,
    ...extra,
});

const SCHEMA = {
    name: 'verdict',
    schema: {
        type: 'object',
        required: ['score'],
        properties: { score: { type: 'number' }, note: { type: 'string' } },
    },
};

describe('llm client: request shape', () => {
    it('calls sendRequest with the task profile, raw data and no undefined keys', async () => {
        const { client } = setup();
        replies.push(completion('Fine.'));
        const result = await client.request(ask({ temperature: 0.2, schema: undefined }));
        expect(result).toMatchObject({ ok: true, text: 'Fine.', data: 'Fine.' });
        expect(calls).toHaveLength(1);
        const call = calls[0]!;
        expect(call.profileId).toBe('p-judge');
        expect(call.maxTokens).toBe(300);
        expect(call.messages).toEqual(ask().messages);
        expect(call.custom).toMatchObject({
            stream: false,
            extractData: false,
            includePreset: false,
            includeInstruct: true,
        });
        expect(call.custom['signal']).toBeInstanceOf(AbortSignal);
        expect(call.override).toEqual({ temperature: 0.2 });
    });

    it('uses profiles.default for tasks without their own profile', async () => {
        const { client } = setup();
        replies.push(completion('ok'));
        await client.request(ask({ task: 'revision' }));
        expect(calls[0]!.profileId).toBe('p-default');
    });

    it('sends json_schema and tools in the override payload', async () => {
        const { client } = setup();
        replies.push(completion('{"score": 1}'));
        await client.request(ask({ schema: SCHEMA }));
        expect(calls[0]!.override).toEqual({ json_schema: { name: 'verdict', strict: true, value: SCHEMA.schema } });

        const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
        const toolCalls = [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }];
        replies.push(completion('', undefined, { tool_calls: toolCalls }));
        const result = await client.request(ask({ tools }));
        expect(calls[1]!.override).toEqual({ tools, tool_choice: 'auto', custom_prompt_post_processing: '' });
        expect(result).toEqual({ ok: true, toolCalls, costUsd: 0, tokens: { prompt: 0, completion: 0 } });
    });

    it('marks its own requests with the signal it hands to sendRequest', async () => {
        const { client, own } = setup();
        replies.push(completion('ok'));
        await client.request(ask());
        const signal = calls[0]!.custom['signal'];
        expect(own.begin).toEqual([signal]);
        expect(own.end).toEqual([signal]);
    });
});

describe('llm client: results and cost', () => {
    it('records the real OpenRouter cost and returns totals', async () => {
        const { client, entries } = setup();
        replies.push(completion('Good.', { prompt_tokens: 120, completion_tokens: 30, cost: 0.0012 }));
        const result = await client.request(ask());
        expect(result.costUsd).toBeCloseTo(0.0012);
        expect(result.tokens).toEqual({ prompt: 120, completion: 30 });
        expect(entries).toEqual([
            {
                source: 'maestro',
                task: 'judge',
                usd: 0.0012,
                tokens: { prompt: 120, completion: 30 },
                estimated: false,
            },
        ]);
    });

    it('marks the cost as estimated when the provider reports none', async () => {
        const { client, entries } = setup();
        replies.push(completion('Good.', { prompt_tokens: 10, completion_tokens: 5 }));
        await client.request(ask());
        replies.push(completion('Good.'));
        await client.request(ask());
        expect(entries).toEqual([
            { source: 'maestro', task: 'judge', usd: 0, tokens: { prompt: 10, completion: 5 }, estimated: true },
            { source: 'maestro', task: 'judge', usd: 0, estimated: true },
        ]);
    });

    it('strips reasoning from text replies and reads text-completion and Claude shapes', async () => {
        const { client } = setup();
        replies.push(completion('<think>hmm</think>\nThe answer.'));
        expect((await client.request(ask())).text).toBe('The answer.');
        replies.push({ choices: [{ index: 0, text: ' plain text ' }] });
        expect((await client.request(ask())).text).toBe('plain text');
        replies.push({
            content: [{ type: 'text', text: 'From Claude' }],
            usage: { input_tokens: 5, output_tokens: 2 },
        });
        const claude = await client.request(ask());
        expect(claude.text).toBe('From Claude');
        expect(claude.tokens).toEqual({ prompt: 5, completion: 2 });
    });

    it('returns an empty-reply failure', async () => {
        const { client, entries } = setup();
        replies.push(completion('   '));
        expect(await client.request(ask())).toMatchObject({ ok: false, error: 'empty' });
        expect(entries).toHaveLength(1);
    });
});

describe('llm client: structured output', () => {
    it('parses JSON wrapped in fences, reasoning and prose', async () => {
        const { client } = setup();
        replies.push(
            completion(
                '<think>let me see { not json</think>Sure! ```json\n{"score": 7, "note": "ok"}\n``` Hope it helps.',
            ),
        );
        const result = await client.request<{ score: number }>(ask({ schema: SCHEMA }));
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ score: 7, note: 'ok' });
        expect(calls).toHaveLength(1);
    });

    it('takes structured output from a Claude tool_use block', async () => {
        const { client } = setup();
        replies.push({ content: [{ type: 'tool_use', id: 'x', name: 'verdict', input: { score: 3 } }] });
        const result = await client.request(ask({ schema: SCHEMA }));
        expect(result).toMatchObject({ ok: true, data: { score: 3 } });
    });

    it('retries once without json_schema, with the schema as instructions', async () => {
        const { client } = setup();
        replies.push(completion('I think the score is seven.'));
        replies.push(completion('{"score": 7}'));
        const result = await client.request(ask({ schema: SCHEMA }));
        expect(result).toMatchObject({ ok: true, data: { score: 7 } });
        expect(calls).toHaveLength(2);
        expect(calls[1]!.override).toEqual({});
        const last = calls[1]!.messages.at(-1)!;
        expect(last.role).toBe('system');
        expect(last.content).toContain('JSON schema');
        expect(last.content).toContain('"required":["score"]');
        expect(calls[1]!.messages).toHaveLength(3);
    });

    it('rejects a reply that does not match the schema, then fails', async () => {
        const { client, entries } = setup();
        replies.push(completion('{"note": "no score"}'));
        replies.push(completion('{"score": "high"}'));
        const result = await client.request(ask({ schema: SCHEMA }));
        expect(result).toMatchObject({ ok: false, error: 'parse' });
        expect(calls).toHaveLength(2);
        expect(entries).toHaveLength(2);
        expect(result.text).toBe('{"score": "high"}');
    });

    it('drops json_schema at once when the provider rejects it', async () => {
        const { client } = setup();
        replies.push(
            new Error('API request failed', { cause: new Error('This response_format type is unavailable now') }),
        );
        replies.push(completion('{"score": 2}'));
        const result = await client.request(ask({ schema: SCHEMA }));
        expect(result).toMatchObject({ ok: true, data: { score: 2 } });
        expect(calls.map((call) => 'json_schema' in call.override)).toEqual([true, false]);
    });
});

describe('llm client: failures', () => {
    it('retries transport errors twice', async () => {
        const { client } = setup();
        replies.push(new Error('API request failed', { cause: new Error('502') }));
        replies.push(new Error('API request failed', { cause: new Error('502') }));
        replies.push(completion('third time'));
        expect(await client.request(ask())).toMatchObject({ ok: true, text: 'third time' });
        expect(calls).toHaveLength(3);
    });

    it('gives up after two retries', async () => {
        const { client } = setup();
        const result = await client.request(ask());
        expect(result.ok).toBe(false);
        expect(result.error).toBe('transport: API request failed: no scripted reply');
        expect(calls).toHaveLength(3);
        expect(result.costUsd).toBeUndefined();
    });

    it('does not retry configuration errors', async () => {
        const { client } = setup();
        replies.push(new Error('Profile not found (ID: p-judge)'));
        await client.request(ask());
        expect(calls).toHaveLength(1);
    });

    it('detects refusals (en, ru, provider flag) and never retries them', async () => {
        const { client } = setup();
        replies.push(completion("I'm sorry, but I can't help with that request."));
        expect(await client.request(ask())).toMatchObject({ ok: false, refusal: true, error: 'refusal' });
        replies.push(completion('Извините, но я не могу помочь с этим.'));
        expect(await client.request(ask({ schema: SCHEMA }))).toMatchObject({ ok: false, refusal: true });
        replies.push(completion('', undefined, { refusal: 'Policy.' }));
        expect(await client.request(ask())).toMatchObject({ ok: false, refusal: true, text: 'Policy.' });
        expect(calls).toHaveLength(3);
        expect(client.breaker('p-judge').failures).toBe(0);
    });

    it('returns cap without calling the model', async () => {
        const { client } = setup({ capped: true });
        expect(await client.request(ask())).toEqual({ ok: false, error: 'cap' });
        expect(calls).toHaveLength(0);
    });

    it('lets the assistant (started by the user) through the background cap', async () => {
        const { client } = setup({ capped: true, profiles: { assistant: 'p-judge', judge: 'p-judge' } });
        replies.push(completion('Hello.'));
        const result = await client.request(ask({ task: 'assistant' }));
        expect(calls).toHaveLength(1);
        expect(result).not.toEqual({ ok: false, error: 'cap' });
    });

    it('reports missing profiles and a missing or disabled Connection Manager', async () => {
        expect(await setup({ profiles: {} }).client.request(ask())).toEqual({ ok: false, error: 'no-profile' });
        expect(setup({ profiles: {} }).client.available('judge')).toBe(false);

        mock.extensionSettings['disabledExtensions'] = ['connection-manager'];
        const disabled = setup();
        expect(await disabled.client.request(ask())).toEqual({ ok: false, error: 'no-cm' });
        expect(disabled.client.available('judge')).toBe(false);

        mock.extensionSettings['disabledExtensions'] = [];
        delete (mock.context as unknown as Record<string, unknown>)['ConnectionManagerRequestService'];
        expect(await setup().client.request(ask())).toEqual({ ok: false, error: 'no-cm' });
        expect(calls).toHaveLength(0);
    });

    it('aborts without retrying or tripping the breaker', async () => {
        const { client } = setup();
        const controller = new AbortController();
        mock.sendRequest = async (_profile, _prompt, _max, custom) => {
            const signal = (custom as { signal: AbortSignal }).signal;
            calls.push({} as SentCall);
            return new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                controller.abort();
            });
        };
        expect(await client.request(ask({ signal: controller.signal }))).toEqual({ ok: false, error: 'aborted' });
        expect(calls).toHaveLength(1);
        expect(client.breaker('p-judge').failures).toBe(0);
        expect(await client.request(ask({ signal: controller.signal }))).toEqual({ ok: false, error: 'aborted' });
        expect(calls).toHaveLength(1);
    });
});

describe('llm client: circuit breaker', () => {
    it('opens after 3 failed requests, closes after 5 minutes', async () => {
        const { client, advance } = setup({ profiles: { default: 'p1' } });
        for (let i = 0; i < 3; i++) {
            expect(client.available('judge')).toBe(true);
            await client.request(ask());
        }
        expect(client.breaker('p1').failures).toBe(3);
        expect(client.available('judge')).toBe(false);
        const before = calls.length;
        expect(await client.request(ask())).toEqual({ ok: false, error: 'breaker-open' });
        expect(calls).toHaveLength(before);

        advance(BREAKER_OPEN_MS + 1);
        expect(client.available('judge')).toBe(true);
        // Half-open: one more failure re-opens at once, a success resets.
        await client.request(ask());
        expect(client.available('judge')).toBe(false);
        advance(BREAKER_OPEN_MS + 1);
        replies.push(completion('back'));
        expect(await client.request(ask())).toMatchObject({ ok: true });
        expect(client.breaker('p1')).toEqual({ failures: 0, openUntil: 0 });
    });

    it('switches to the fallback profile once the breaker opens', async () => {
        const { client } = setup();
        await client.request(ask());
        await client.request(ask());
        expect(new Set(calls.map((call) => call.profileId))).toEqual(new Set(['p-judge']));
        calls = [];
        // Third failure opens the breaker; the same request then goes to the fallback.
        replies.push(new Error('x'), new Error('x'), new Error('x'), completion('from fallback'));
        expect(await client.request(ask())).toMatchObject({ ok: true, text: 'from fallback' });
        expect(calls.map((call) => call.profileId)).toEqual(['p-judge', 'p-judge', 'p-judge', 'p-fallback']);
        expect(client.available('judge')).toBe(true);
        replies.push(completion('again'));
        await client.request(ask());
        expect(calls.at(-1)!.profileId).toBe('p-fallback');
    });
});

describe('llm helpers', () => {
    it('parseJsonText', () => {
        expect(parseJsonText('```json\n[1,2]\n```')).toEqual([1, 2]);
        expect(parseJsonText('reasoning...</think>{"a":1}')).toEqual({ a: 1 });
        expect(parseJsonText('Here: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
        expect(parseJsonText('no json')).toBeUndefined();
        expect(parseJsonText('')).toBeUndefined();
    });

    it('matchesSchema', () => {
        const schema = {
            type: 'object',
            required: ['items'],
            properties: {
                items: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
                n: { type: 'integer' },
            },
        };
        expect(matchesSchema({ items: ['a', 'b'], n: 2 }, schema)).toBe(true);
        expect(matchesSchema({ items: ['c'] }, schema)).toBe(false);
        expect(matchesSchema({ items: [], n: 1.5 }, schema)).toBe(false);
        expect(matchesSchema([], schema)).toBe(false);
        expect(matchesSchema(null, { type: ['null', 'string'] })).toBe(true);
    });

    it('looksLikeRefusal stays quiet on story text', () => {
        expect(looksLikeRefusal('As an AI language model, I cannot do that.')).toBe(true);
        expect(looksLikeRefusal('Я не могу выполнить эту просьбу.')).toBe(true);
        expect(looksLikeRefusal('Как ИИ, я должен отказаться.')).toBe(true);
        expect(looksLikeRefusal('{"score": 3}')).toBe(false);
        expect(looksLikeRefusal('Alice laughed. "I can\'t help it," she said.')).toBe(false);
        expect(looksLikeRefusal('Long story. '.repeat(30) + 'I cannot help you, he said.')).toBe(false);
    });

    it('extractReply converts Claude tool_use to tool calls', () => {
        const reply = extractReply({
            content: [{ type: 'tool_use', id: 't', name: 'f', input: { a: 1 } }],
            stop_reason: 'tool_use',
        });
        expect(reply.toolCalls).toEqual([{ id: 't', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]);
        expect(reply.toolInputs).toEqual([{ name: 'f', input: { a: 1 } }]);
        expect(
            extractReply({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] }).refusal,
        ).toBe(true);
        expect(extractReply({ candidates: [{ content: { parts: [{ text: 'gem' }] } }] }).text).toBe('gem');
        expect(extractReply('raw').text).toBe('raw');
        expect(extractReply(null).text).toBe('');
    });
});
