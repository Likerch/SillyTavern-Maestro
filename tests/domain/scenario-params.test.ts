import { describe, expect, it } from 'vitest';
import {
    applyScenarioParams,
    promptRole,
    promptText,
    snapshotPrompt,
    toPromptMessages,
} from '../../src/domain/scenario-params';

describe('promptText', () => {
    it('reads strings and the text parts of multimodal content', () => {
        expect(promptText('hello')).toBe('hello');
        expect(
            promptText([{ type: 'text', text: 'one' }, { type: 'image_url', image_url: { url: 'x' } }, 'two', null]),
        ).toBe('one\ntwo');
        expect(promptText(undefined)).toBe('');
        expect(promptText(42)).toBe('');
    });
});

describe('promptRole', () => {
    it('keeps the three plain roles and maps the rest', () => {
        expect(promptRole('system')).toBe('system');
        expect(promptRole('user')).toBe('user');
        expect(promptRole('assistant')).toBe('assistant');
        expect(promptRole('tool')).toBe('user');
        expect(promptRole('narrator')).toBe('system');
        expect(promptRole(undefined)).toBe('system');
    });
});

describe('toPromptMessages', () => {
    it('creates fresh objects and drops empty messages', () => {
        const source = [
            { role: 'system', content: 'rules' },
            { role: 'user', content: '   ' },
            { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
            { role: 'weird', content: 'x' },
        ];
        const result = toPromptMessages(source);
        expect(result).toEqual([
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'hi' },
            { role: 'system', content: 'x' },
        ]);
        expect(result[0]).not.toBe(source[0]);
    });
});

describe('snapshotPrompt', () => {
    it('copies the prompt into frozen plain messages', () => {
        const chat = [{ role: 'user', content: 'a', name: 'x' }, null];
        const copy = snapshotPrompt(chat);
        expect(copy).toEqual([
            { role: 'user', content: 'a' },
            { role: 'system', content: '' },
        ]);
        expect(Object.isFrozen(copy[0])).toBe(true);
    });
});

describe('applyScenarioParams', () => {
    const body = (): Record<string, unknown> => ({
        max_tokens: 300,
        temperature: 1,
        stream: true,
        stop: ['\nUser:'],
        reasoning_effort: 'auto',
        include_reasoning: false,
    });

    it('sets length, temperature and reasoning, never stream', () => {
        const data = body();
        const changed = applyScenarioParams(data, {
            max_tokens: 6000.7,
            temperature: 0.7,
            reasoning_effort: 'low',
            include_reasoning: true,
        });
        expect(changed).toEqual(['max_tokens', 'temperature', 'reasoning_effort', 'include_reasoning']);
        expect(data).toMatchObject({
            max_tokens: 6000,
            temperature: 0.7,
            reasoning_effort: 'low',
            include_reasoning: true,
        });
        expect(data.stream).toBe(true);
        expect(data.stop).toEqual(['\nUser:']);
    });

    it('replaces stop strings, and removes the key for an empty list', () => {
        const data = body();
        expect(applyScenarioParams(data, { stop: ['</sheet>', ''] })).toEqual(['stop']);
        expect(data.stop).toEqual(['</sheet>']);
        expect(applyScenarioParams(data, { stop: [] })).toEqual(['stop']);
        expect('stop' in data).toBe(false);
        expect(applyScenarioParams(data, { stop: [] })).toEqual([]);
    });

    it('ignores missing params, invalid values and values that are already set', () => {
        const data = body();
        expect(applyScenarioParams(data, undefined)).toEqual([]);
        expect(
            applyScenarioParams(data, {
                max_tokens: -1,
                temperature: Number.NaN,
                reasoning_effort: '',
            }),
        ).toEqual([]);
        expect(applyScenarioParams(data, { max_tokens: 300, temperature: 1 })).toEqual([]);
        expect(data).toEqual(body());
    });

    it('turns reasoning off: effort "none" through OpenRouter, include_reasoning false everywhere, stream untouched', () => {
        const routed = { ...body(), chat_completion_source: 'openrouter', include_reasoning: true };
        expect(applyScenarioParams(routed, { reasoning_effort: 'high', reasoning: 'off' })).toEqual([
            'reasoning_effort',
            'include_reasoning',
        ]);
        expect(routed).toMatchObject({ reasoning_effort: 'none', include_reasoning: false, stream: true });

        const direct = { ...body(), chat_completion_source: 'deepseek', include_reasoning: true };
        expect(applyScenarioParams(direct, { reasoning: 'off' })).toEqual(['include_reasoning']);
        expect(direct).toMatchObject({ reasoning_effort: 'auto', include_reasoning: false, stream: true });
    });
});
