import { describe, expect, it } from 'vitest';
import {
    chatExcerpt,
    continuedIndex,
    expandCustomMessages,
    expandNames,
    hasCustomMessages,
    mergeScenarioParams,
    requestParams,
    sanitizeScenarioParams,
} from '../../src/domain/scenario-builtins';

const NAMES = { char: 'Вера', user: 'Кай' };

describe('scenario parameter values', () => {
    it('keeps only valid values', () => {
        expect(
            sanitizeScenarioParams({
                enabled: 'yes',
                max_tokens: 300.9,
                temperature: 3,
                stop: ['\n{{char}}:', 5],
                reasoning: 'maybe',
                messages: [{ role: 'system', content: 'a' }, { role: 'tool', content: 'b' }, { role: 'user' }, 'junk'],
                historyMessages: 999,
            }),
        ).toEqual({
            max_tokens: 300,
            stop: ['\n{{char}}:'],
            messages: [{ role: 'system', content: 'a' }],
            historyMessages: 200,
        });
        expect(
            sanitizeScenarioParams({
                enabled: true,
                temperature: 0.7,
                reasoning: 'off',
                max_tokens: 0,
                historyMessages: -1,
            }),
        ).toEqual({ enabled: true, temperature: 0.7, reasoning: 'off' });
        expect(sanitizeScenarioParams(null)).toEqual({});
        expect(sanitizeScenarioParams([1])).toEqual({});
    });

    it('merges the user values over the defaults', () => {
        expect(
            mergeScenarioParams(
                { enabled: false, max_tokens: 300, reasoning: 'off' },
                { enabled: true, max_tokens: -5 },
            ),
        ).toEqual({ enabled: true, max_tokens: 300, reasoning: 'off' });
        expect(mergeScenarioParams({ max_tokens: 400 }, undefined)).toEqual({ max_tokens: 400 });
    });

    it('turns values into request parameters with the names filled in', () => {
        expect(expandNames('\n{{char}}: and {{ USER }}', NAMES)).toBe('\nВера: and Кай');
        expect(
            requestParams(
                { enabled: true, max_tokens: 300, temperature: 0.5, stop: ['\n{{char}}:', ''], reasoning: 'off' },
                NAMES,
            ),
        ).toEqual({ max_tokens: 300, temperature: 0.5, stop: ['\nВера:'], reasoning: 'off' });
        expect(requestParams({ stop: [] }, NAMES)).toEqual({ stop: [] });
        expect(requestParams({ enabled: true, reasoning: 'keep', messages: [] }, NAMES)).toBeUndefined();
    });

    it('detects a custom message set', () => {
        expect(hasCustomMessages({ messages: [{ role: 'system', content: '  ' }] })).toBe(false);
        expect(hasCustomMessages({ messages: [{ role: 'system', content: 'Write as {{user}}' }] })).toBe(true);
        expect(hasCustomMessages({})).toBe(false);
    });
});

describe('custom message sets', () => {
    const chat = [
        { mes: 'Привет', is_user: true },
        { mes: 'hidden', is_user: false, is_system: true },
        { mes: 'Здравствуй', is_user: false },
        { mes: '  ', is_user: true },
        { mes: 'Как дела?', is_user: true },
        { mes: 42 },
        { mes: 'Хорошо, а', is_user: false },
    ];

    it('takes the last visible messages, oldest first, optionally without the last one', () => {
        expect(chatExcerpt(chat, 2)).toEqual([
            { role: 'user', content: 'Как дела?' },
            { role: 'assistant', content: 'Хорошо, а' },
        ]);
        expect(chatExcerpt(chat, 10, { skipLast: true })).toEqual([
            { role: 'user', content: 'Привет' },
            { role: 'assistant', content: 'Здравствуй' },
            { role: 'user', content: 'Как дела?' },
        ]);
        expect(chatExcerpt([], 5)).toEqual([]);
    });

    it('finds the continued message in ST’s prompt by the end of its text', () => {
        const original = [
            { role: 'system' as const, content: 'rules' },
            { role: 'assistant' as const, content: 'Вера: Хорошо, а ' },
            { role: 'system' as const, content: '[Continue your last message]' },
        ];
        expect(continuedIndex(original, 'Хорошо, а')).toBe(1);
        expect(continuedIndex(original, 'nothing like it')).toBe(-1);
        expect(continuedIndex(original, '   ')).toBe(-1);
    });

    it('expands {{history}} and substitutes the other messages, dropping empty ones', () => {
        const history = [{ role: 'user' as const, content: 'h1' }];
        const result = expandCustomMessages(
            [
                { role: 'system', content: 'Write as {{user}}.' },
                { role: 'system', content: ' {{history}} ' },
                { role: 'system', content: '{{empty}}' },
            ],
            history,
            (text) => expandNames(text, NAMES).replace('{{empty}}', ''),
        );
        expect(result).toEqual([
            { role: 'system', content: 'Write as Кай.' },
            { role: 'user', content: 'h1' },
        ]);
        expect(result[1]).not.toBe(history[0]);
    });
});
