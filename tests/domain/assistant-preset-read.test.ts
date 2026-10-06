import { describe, expect, it } from 'vitest';
import { PARAM_TEXT_CHARS, dryRunView, paramsView } from '../../src/domain/assistant-preset-read';
import type { DrySlot } from '../../src/domain/assistant-preset-read';

describe('parameters the assistant sees', () => {
    it('shows the parameters and other keys, counts the hidden ones, cuts long texts', () => {
        const view = paramsView({
            temperature: 1,
            top_p: 0.9,
            assistant_prefill: 'x'.repeat(PARAM_TEXT_CHARS + 50),
            marinara_version: '7.2',
            bias_preset_selected: 'Default (none)',
            openrouter_model: 'some/model',
            chat_completion_source: 'openrouter',
            reverse_proxy: 'http://proxy.local',
            proxy_password: 'secret',
            prompts: [],
            prompt_order: [],
            extensions: { other: true },
            list: Array.from({ length: 600 }, (_, i) => `item-${i}`),
        });
        expect(view.params).toMatchObject({ temperature: 1, top_p: 0.9 });
        expect(String(view.params.assistant_prefill)).toHaveLength(PARAM_TEXT_CHARS + 1);
        expect(view.other).toMatchObject({ marinara_version: '7.2', bias_preset_selected: 'Default (none)' });
        expect(String(view.other.list).endsWith('…')).toBe(true);
        expect(view.hidden).toBe(4);
        const json = JSON.stringify(view);
        expect(json).not.toContain('secret');
        expect(json).not.toContain('proxy.local');
        expect(json).not.toContain('some/model');
    });
});

function slot(identifier: string, patch: Partial<DrySlot> = {}): DrySlot {
    return {
        identifier,
        name: identifier,
        role: 'system',
        placement: 'relative',
        tokens: 10,
        enabled: true,
        marker: false,
        injections: [],
        ...patch,
    };
}

describe('the dry run view', () => {
    const slots = [
        slot('main', { tokens: 120, injections: [{ owner: 'des', key: 'x', tokens: 40, where: 'start' }] }),
        slot('worldInfoBefore', { marker: true, tokens: 300 }),
        slot('chatHistory', { marker: true, tokens: 2000, name: 'Chat History' }),
        slot('deep', { placement: 'depth', depth: 4, order: 100, role: 'user', tokens: 30 }),
        slot('shallow', { placement: 'depth', depth: 1, role: 'system', tokens: 20 }),
        slot('off', { enabled: false }),
        slot('dropped', { dropped: 'strict types: system_prompt must be false' }),
        slot('silent'),
        slot('jailbreak', { tokens: 50, note: 'after the history' }),
    ];

    it('lists what goes out in order, in-chat blocks inside the history deepest first', () => {
        const view = dryRunView({
            slots,
            texts: new Map([
                ['main', 'You are the GM. '.repeat(40)],
                ['deep', 'Remember the rules.'],
                ['shallow', 'Short.'],
                ['jailbreak', 'Stay sharp.'],
            ]),
            silent: new Set(['silent']),
            previewChars: 60,
        });
        expect(view.messages.map((row) => row.name)).toEqual([
            'main',
            'worldInfoBefore',
            'Chat History',
            'deep',
            'shallow',
            'jailbreak',
        ]);
        expect(view.messages[0]).toMatchObject({ n: 1, kind: 'block', tokens: 120, injections: ['des (40 tokens)'] });
        expect(view.messages[0]!.preview!.length).toBeLessThanOrEqual(60);
        // Markers: sizes only, never a text.
        expect(view.messages[1]).toEqual({
            n: 2,
            name: 'worldInfoBefore',
            role: 'system',
            tokens: 300,
            kind: 'marker',
        });
        expect(view.messages[3]).toMatchObject({ depth: 4, role: 'user', preview: 'Remember the rules.' });
        expect(view.messages[5]).toMatchObject({ note: 'after the history' });
        expect(view.notSent).toEqual([
            { name: 'off', why: 'switched off' },
            { name: 'dropped', why: 'strict types: system_prompt must be false' },
            { name: 'silent', why: 'condition is off now' },
        ]);
        expect(view.tokens).toEqual({ total: 2520, presetBlocks: 180, filledBySillyTavern: 2300, extensions: 40 });
    });

    it('puts in-chat blocks at the end when there is no history block', () => {
        const view = dryRunView({
            slots: [slot('deep', { placement: 'depth', depth: 2 }), slot('main')],
            texts: new Map(),
            silent: new Set(),
            previewChars: 100,
        });
        expect(view.messages.map((row) => row.name)).toEqual(['main', 'deep']);
        expect(view.messages[1]).toMatchObject({ depth: 2 });
        expect(view.messages[0]!.preview).toBeUndefined();
    });
});
