import { describe, expect, it } from 'vitest';
import { ArgError } from '../../src/domain/assistant-write-args';
import {
    applyReplacements,
    composePreset,
    emptyPreset,
    isHiddenParam,
    paramValue,
    placeBlock,
    roleWarnings,
    scopesAbove,
} from '../../src/domain/assistant-write-presets';

function errorOf(run: () => unknown): { code: string; params: Record<string, unknown> } | null {
    try {
        run();
    } catch (error) {
        if (error instanceof ArgError) return { code: error.code, params: error.params };
        throw error;
    }
    return null;
}

describe('scopes', () => {
    it('lists the scopes laid over a scope', () => {
        expect(scopesAbove('global')).toEqual(['character', 'chat']);
        expect(scopesAbove('character')).toEqual(['chat']);
        expect(scopesAbove('chat')).toEqual([]);
    });
});

describe('text replacements', () => {
    it('replaces exact unique snippets in turn, line ends as \\n', () => {
        const text = 'You are the GM.\r\nWrite vividly.\r\nStay sharp.';
        expect(
            applyReplacements(text, [
                { find: 'Write vividly.', replace: 'Write plainly.' },
                { find: 'plainly.\nStay', replace: 'plainly.\n\nStay' },
            ]),
        ).toBe('You are the GM.\nWrite plainly.\n\nStay sharp.');
        expect(applyReplacements('a b', [{ find: ' b', replace: '' }])).toBe('a');
    });

    it('refuses a missing, an empty and an ambiguous snippet', () => {
        expect(errorOf(() => applyReplacements('abc', [{ find: 'x', replace: 'y' }]))).toEqual({
            code: 'presetFindMissing',
            params: { find: 'x' },
        });
        expect(errorOf(() => applyReplacements('abc', [{ find: '', replace: 'y' }]))?.code).toBe('argEmpty');
        expect(errorOf(() => applyReplacements('na na na', [{ find: 'na', replace: 'x' }]))).toEqual({
            code: 'presetFindAmbiguous',
            params: { find: 'na', count: 3 },
        });
    });
});

describe('a block moved in the order', () => {
    const order = ['main', 'style', 'chatHistory', 'jailbreak'];

    it('gives the new order and an anchor after the preceding block', () => {
        expect(placeBlock(order, 'jailbreak', 'start')).toEqual({
            order: ['jailbreak', 'main', 'style', 'chatHistory'],
            anchor: { kind: 'start' },
        });
        expect(placeBlock(order, 'main', 'end')).toEqual({
            order: ['style', 'chatHistory', 'jailbreak', 'main'],
            anchor: { kind: 'after', identifier: 'jailbreak' },
        });
        expect(placeBlock(order, 'style', 'after', 'chatHistory')).toEqual({
            order: ['main', 'chatHistory', 'style', 'jailbreak'],
            anchor: { kind: 'after', identifier: 'chatHistory' },
        });
        expect(placeBlock(order, 'jailbreak', 'before', 'main')).toEqual({
            order: ['jailbreak', 'main', 'style', 'chatHistory'],
            anchor: { kind: 'start' },
        });
        // A block out of the order joins it.
        expect(placeBlock(order, 'new', 'before', 'jailbreak').order).toEqual([
            'main',
            'style',
            'chatHistory',
            'new',
            'jailbreak',
        ]);
    });

    it('refuses a missing anchor, the block itself, an anchor off the list and no move', () => {
        expect(errorOf(() => placeBlock(order, 'main', 'after'))?.code).toBe('presetNeedAnchor');
        expect(errorOf(() => placeBlock(order, 'main', 'after', 'main'))?.code).toBe('presetSelfAnchor');
        expect(errorOf(() => placeBlock(order, 'main', 'after', 'nope'))).toEqual({
            code: 'presetAnchorOff',
            params: { block: 'nope' },
        });
        expect(errorOf(() => placeBlock(order, 'main', 'start'))?.code).toBe('presetSamePlace');
        expect(errorOf(() => placeBlock(order, 'style', 'after', 'main'))?.code).toBe('presetSamePlace');
    });
});

describe('preset parameters', () => {
    it('hides connection settings, addresses, passwords and the prompt lists', () => {
        for (const key of [
            'openrouter_model',
            'chat_completion_source',
            'reverse_proxy',
            'proxy_password',
            'custom_url',
            'prompts',
            'prompt_order',
            'extensions',
            'some_api_key',
            'my_endpoint',
        ]) {
            expect(isHiddenParam(key), key).toBe(true);
        }
        for (const key of ['temperature', 'top_k', 'openai_max_tokens', 'assistant_prefill', 'marinara_version']) {
            expect(isHiddenParam(key), key).toBe(false);
        }
    });

    it("types values and checks ST's limits", () => {
        expect(paramValue('temperature', '0.9')).toBe(0.9);
        expect(paramValue('temperature', 1.2)).toBe(1.2);
        expect(paramValue('top_k', 40.4)).toBe(40);
        expect(paramValue('stream_openai', 'false')).toBe(false);
        expect(paramValue('show_thoughts', true)).toBe(true);
        expect(paramValue('reasoning_effort', 'low')).toBe('low');
        expect(paramValue('names_behavior', 2)).toBe(2);
        expect(paramValue('assistant_prefill', '')).toBe('');
        expect(errorOf(() => paramValue('temperature', 3))).toEqual({
            code: 'presetParamRange',
            params: { key: 'temperature', min: 0, max: 2 },
        });
        expect(errorOf(() => paramValue('temperature', 'hot'))?.code).toBe('presetParamType');
        expect(errorOf(() => paramValue('temperature', null))?.code).toBe('presetParamType');
        expect(errorOf(() => paramValue('stream_openai', 'yes'))?.code).toBe('presetParamType');
        expect(errorOf(() => paramValue('assistant_prefill', 5))?.code).toBe('presetParamType');
        expect(errorOf(() => paramValue('reasoning_effort', 'ultra'))?.code).toBe('presetParamOption');
        expect(errorOf(() => paramValue('assistant_prefill', 'x'.repeat(20001)))?.code).toBe('argTooLong');
    });

    it('refuses hidden and unknown keys', () => {
        expect(errorOf(() => paramValue('openrouter_model', 'x'))).toEqual({
            code: 'presetParamHidden',
            params: { key: 'openrouter_model' },
        });
        expect(errorOf(() => paramValue('proxy_password', 'x'))?.code).toBe('presetParamHidden');
        expect(errorOf(() => paramValue('marinara_version', '8'))?.code).toBe('presetParamUnknown');
    });
});

describe('role warnings', () => {
    const quirks = new Set(['prefillEos', 'systemMerge', 'assistantDepth']);
    const block = { role: 'system', inChat: false, depth: 4, afterHistory: false, text: 'Write.' };

    it('warns about a prefill, an assistant or a system message inside the history', () => {
        expect(roleWarnings({ ...block, role: 'assistant', afterHistory: true }, quirks, true)).toEqual(['prefillEos']);
        expect(roleWarnings({ ...block, role: 'assistant', inChat: true, depth: 0 }, quirks, true)).toEqual([
            'prefillEos',
        ]);
        expect(roleWarnings({ ...block, role: 'assistant', inChat: true, depth: 3 }, quirks, true)).toEqual([
            'assistantDepth',
        ]);
        expect(roleWarnings({ ...block, inChat: true, depth: 2 }, quirks, false)).toEqual(['systemMerge']);
        expect(roleWarnings({ ...block, inChat: true, depth: 0 }, quirks, false)).toEqual([]);
        expect(roleWarnings(block, quirks, true)).toEqual([]);
        // Another model: no quirks, no warnings.
        expect(roleWarnings({ ...block, role: 'assistant', afterHistory: true }, new Set(), true)).toEqual([]);
    });

    it('warns when tracker instructions go to the system role', () => {
        const tracker = { ...block, text: 'Update the DES tracker JSON every reply.' };
        expect(roleWarnings(tracker, new Set(), true)).toEqual(['trackerSystem']);
        expect(roleWarnings({ ...tracker, text: 'Обнови трекер сцены.' }, new Set(), true)).toEqual(['trackerSystem']);
        expect(roleWarnings(tracker, new Set(), false)).toEqual([]);
        expect(roleWarnings({ ...tracker, role: 'user' }, new Set(), true)).toEqual([]);
    });
});

describe('a new preset', () => {
    it("starts empty as ST's fresh preset", () => {
        const empty = emptyPreset();
        expect(empty.order.map((item) => item.identifier)).toContain('chatHistory');
        expect(empty.prompts.find((prompt) => prompt.identifier === 'main')?.content).toContain('{{char}}');
        expect(empty.prompts.find((prompt) => prompt.identifier === 'chatHistory')?.marker).toBe(true);
        expect(empty.order.find((item) => item.identifier === 'enhanceDefinitions')?.enabled).toBe(false);
    });

    it('puts additions around the history, at the start and the end, with fresh identifiers when taken', () => {
        const base = {
            prompts: [{ identifier: 'main' }, { identifier: 'chatHistory' }, { identifier: 'jailbreak' }],
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        };
        let next = 0;
        const result = composePreset(
            base,
            [
                { prompt: { identifier: 'a', name: 'A' }, place: 'beforeHistory', enabled: true },
                { prompt: { identifier: 'main', name: 'Main copy' }, place: 'afterHistory', enabled: false },
                { prompt: { identifier: 's', name: 'S' }, place: 'start', enabled: true },
                { prompt: { identifier: 'e', name: 'E' }, place: 'end', enabled: true },
            ],
            () => `new-${++next}`,
        );
        expect(result.order).toEqual([
            { identifier: 's', enabled: true },
            { identifier: 'main', enabled: true },
            { identifier: 'a', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'new-1', enabled: false },
            { identifier: 'jailbreak', enabled: true },
            { identifier: 'e', enabled: true },
        ]);
        expect(result.prompts.find((prompt) => prompt.identifier === 'new-1')?.name).toBe('Main copy');
        // The base is not changed.
        expect(base.order).toHaveLength(3);
        // Without a history block the additions go to the end.
        expect(
            composePreset(
                { prompts: [], order: [{ identifier: 'main', enabled: true }] },
                [{ prompt: { identifier: 'x' }, place: 'beforeHistory', enabled: true }],
                () => 'y',
            ).order.map((item) => item.identifier),
        ).toEqual(['main', 'x']);
    });
});
