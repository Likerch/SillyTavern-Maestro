import { describe, expect, it } from 'vitest';
import {
    cacheUsageFromBody,
    findOrderViolations,
    firstChangeIndex,
    hashMessages,
    median,
    messageContentText,
    quickHash,
    readCacheUsage,
    requestMessageHashes,
    summarizeCache,
} from '../../src/domain/architect-cache';

describe('readCacheUsage', () => {
    it('reads OpenRouter / OpenAI cached tokens', () => {
        expect(
            readCacheUsage({
                usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
            }),
        ).toEqual({ prompt: 1000, cached: 800 });
        expect(readCacheUsage({ usage: { prompt_tokens: 1000 } })).toEqual({ prompt: 1000, cached: 0 });
    });

    it('reads DeepSeek hit/miss tokens, with or without prompt_tokens', () => {
        expect(
            readCacheUsage({
                usage: { prompt_tokens: 900, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 300 },
            }),
        ).toEqual({ prompt: 900, cached: 600 });
        expect(readCacheUsage({ usage: { prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 50 } })).toEqual({
            prompt: 150,
            cached: 100,
        });
    });

    it('reads Claude (message_start) and Gemini usage', () => {
        expect(
            readCacheUsage({
                type: 'message_start',
                message: { usage: { input_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 80 } },
            }),
        ).toEqual({ prompt: 1000, cached: 900 });
        expect(readCacheUsage({ usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 200 } })).toEqual({
            prompt: 500,
            cached: 200,
        });
    });

    it('returns null without usable usage and never reports more cached than prompt', () => {
        expect(readCacheUsage(null)).toBeNull();
        expect(readCacheUsage({ usage: null })).toBeNull();
        expect(readCacheUsage({ usage: { completion_tokens: 5 } })).toBeNull();
        expect(readCacheUsage({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 50 } } })).toEqual({
            prompt: 10,
            cached: 10,
        });
    });
});

describe('cacheUsageFromBody', () => {
    it('parses a non-streamed JSON body', () => {
        const body = JSON.stringify({
            choices: [{ message: { content: 'Hi' } }],
            usage: { prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 1500 } },
        });
        expect(cacheUsageFromBody(body)).toEqual({ prompt: 2000, cached: 1500 });
        expect(cacheUsageFromBody('   ')).toBeNull();
    });

    it('scans an OpenRouter stream for the final usage chunk only', () => {
        const chunks = [
            { choices: [{ delta: { content: 'Hel' } }], usage: null },
            { choices: [{ delta: { content: 'lo' } }] },
            {
                choices: [],
                usage: { prompt_tokens: 3000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 2400 } },
            },
        ];
        const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n`;
        expect(cacheUsageFromBody(body)).toEqual({ prompt: 3000, cached: 2400 });
    });

    it('reads a DeepSeek stream', () => {
        const body =
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":700,"prompt_cache_hit_tokens":512,"prompt_cache_miss_tokens":188}}\n\n' +
            'data: [DONE]';
        expect(cacheUsageFromBody(body)).toEqual({ prompt: 700, cached: 512 });
    });

    it('merges Claude message_start and message_delta usage', () => {
        const body = [
            'event: message_start',
            'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":990,"output_tokens":1}}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","usage":{"output_tokens":40}}',
        ].join('\n');
        expect(cacheUsageFromBody(body)).toEqual({ prompt: 1000, cached: 990 });
    });

    it('survives broken chunks and bodies without usage', () => {
        expect(cacheUsageFromBody('data: {"usage": {broken\n')).toBeNull();
        expect(cacheUsageFromBody('{"choices":[]} trailing')).toBeNull();
        expect(cacheUsageFromBody('data: {"choices":[]}')).toBeNull();
        expect(cacheUsageFromBody('"usage" outside json')).toBeNull();
    });
});

describe('prompt hashes', () => {
    it('hashes messages by role, name and text (multimodal text parts too)', () => {
        const messages = [
            { role: 'system', content: 'Rules.' },
            { role: 'user', name: 'Bob', content: [{ type: 'text', text: 'Hi' }, { type: 'image_url' }] },
        ];
        const hashes = hashMessages(messages);
        expect(hashes).toHaveLength(2);
        expect(hashMessages([{ role: 'system', content: 'Rules.' }])[0]).toBe(hashes[0]);
        expect(hashMessages([{ role: 'user', content: 'Rules.' }])[0]).not.toBe(hashes[0]);
        expect(messageContentText(messages[1])).toBe('Hi');
        expect(messageContentText({ role: 'user' })).toBe('');
        expect(messageContentText('x')).toBe('');
        expect(quickHash('abc')).toBe(quickHash('abc'));
        expect(quickHash('abc')).not.toBe(quickHash('abd'));
    });

    it('reads message hashes from a request body', () => {
        const body = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'Hi' }], stream: true });
        expect(requestMessageHashes(body)).toEqual(hashMessages([{ role: 'user', content: 'Hi' }]));
        expect(requestMessageHashes(JSON.stringify({ prompt: 'text completion' }))).toBeNull();
        expect(requestMessageHashes('{"messages": broken')).toBeNull();
        expect(requestMessageHashes(undefined)).toBeNull();
        expect(requestMessageHashes(JSON.stringify({ messages: 'no' }))).toBeNull();
    });

    it('finds the first changed message', () => {
        expect(firstChangeIndex(null, [1, 2])).toBeNull();
        expect(firstChangeIndex([1, 2, 3], [1, 2, 4, 5])).toBe(2);
        expect(firstChangeIndex([1, 2], [1, 2, 3])).toBe(2);
        expect(firstChangeIndex([1, 2], [1, 2])).toBe(2);
        expect(firstChangeIndex([9], [1])).toBe(0);
    });
});

describe('summarizeCache', () => {
    it('sums the window and takes the median first change', () => {
        expect(median([])).toBeNull();
        expect(median([5, 1, 3])).toBe(3);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        const samples = [
            { at: 1, prompt: 1000, cached: 0, firstChangeAt: null },
            { at: 2, prompt: 1000, cached: 900, firstChangeAt: 10 },
            { at: 3, prompt: null, cached: null, firstChangeAt: 14 },
            { at: 4, prompt: 2000, cached: 1500, firstChangeAt: 12 },
        ];
        expect(summarizeCache(samples)).toEqual({
            requests: 4,
            cachedTokens: 2400,
            promptTokens: 4000,
            hitRate: 0.6,
            firstChangeAt: 12,
        });
        expect(summarizeCache(samples, 1).requests).toBe(1);
        expect(summarizeCache([]).hitRate).toBe(0);
    });
});

describe('findOrderViolations (P16)', () => {
    const hashes = [10, 20, 30, 40, 50];

    it('reports a volatile injection followed by messages of the previous request', () => {
        const previous = new Set([10, 20, 30, 40]);
        const violations = findOrderViolations(
            [
                { key: 'maestro_note', index: 1, position: 1, depth: 3 },
                { key: 'maestro_tail', index: 4, position: 1, depth: 0 },
            ],
            hashes,
            previous,
        );
        expect(violations).toEqual([{ key: 'maestro_note', messageIndex: 1, stableAfter: 2, position: 1, depth: 3 }]);
    });

    it('without a previous request flags only the prompt head', () => {
        expect(
            findOrderViolations(
                [
                    { key: 'maestro_head', index: 0, position: 0, depth: 0 },
                    { key: 'maestro_chat', index: 2, position: 1, depth: 2 },
                    { key: 'maestro_lost', index: 9, position: 0, depth: 0 },
                ],
                hashes,
                null,
            ),
        ).toEqual([{ key: 'maestro_head', messageIndex: 0, stableAfter: 4, position: 0, depth: 0 }]);
    });
});
