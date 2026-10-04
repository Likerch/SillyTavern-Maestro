import { describe, expect, it } from 'vitest';
import {
    bodyHash,
    canonical,
    comparablePrompt,
    diffDraft,
    looseEqual,
    mergeBodies,
    promptsEqual,
    withSecretsOf,
} from '../../src/domain/preset-store-diff';

type Dict = Record<string, unknown>;

const KNOWN = ['temperature', 'openai_max_tokens', 'stream_openai', 'seed', 'extensions', 'prompts', 'prompt_order'];

function body(overrides: Dict = {}): Dict {
    return {
        temperature: 1,
        openai_max_tokens: 300,
        stream_openai: true,
        extensions: { regex_scripts: [] },
        prompts: [
            { identifier: 'main', name: 'Main', system_prompt: true, role: 'system', content: 'M' },
            { identifier: 'x', name: 'X', system_prompt: false, role: 'user', content: 'x' },
        ],
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'x', enabled: true },
                ],
            },
        ],
        ...overrides,
    };
}

describe('comparison', () => {
    it('treats numeric strings as numbers, drops undefined members, ignores key order', () => {
        expect(canonical({ a: '1.5', b: undefined, c: ['2', undefined, 'x'] })).toEqual({ a: 1.5, c: [2, null, 'x'] });
        expect(looseEqual({ a: '1', b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(looseEqual('a', 'b')).toBe(false);
        expect(looseEqual(Number.NaN, null)).toBe(true);
        expect(looseEqual(' ', ' ')).toBe(true);
        const cyclic: Dict = {};
        cyclic.self = cyclic;
        expect(looseEqual(cyclic, {})).toBe(false);
    });

    it('fills ST defaults of prompts before comparing', () => {
        expect(comparablePrompt({ identifier: 'x', enabled: true, extension: true, position: 'start' })).toEqual({
            identifier: 'x',
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            injection_trigger: [],
            forbid_overrides: false,
            marker: false,
            content: '',
        });
        expect(promptsEqual({ identifier: 'x', injection_depth: '4' }, { identifier: 'x' })).toBe(true);
        expect(promptsEqual({ identifier: 'x', role: 'user' }, { identifier: 'x' })).toBe(false);
    });
});

describe('diffDraft', () => {
    it('is clean for the same body, numeric strings, keys the file lacks and unknown keys', () => {
        const saved = body({ temperature: '1', mystery: 'file only' });
        delete saved.seed;
        const working = body({ seed: 5 });
        expect(diffDraft(working, saved, KNOWN)).toEqual({ dirty: false, changedPrompts: [], changedKeys: [] });
        expect(diffDraft(working, saved).dirty).toBe(false);
    });

    it('reports keys, prompts (changed, added, removed) and built-ins PM re-adds as no change', () => {
        const working = body({ temperature: 0.5 });
        (working.prompts as Dict[])[1]!.content = 'changed';
        (working.prompts as Dict[]).push({ identifier: 'nsfw', system_prompt: true }, { identifier: 'new', name: 'N' });
        const saved = body();
        (saved.prompts as Dict[]).push({ identifier: 'gone', name: 'G' });
        const draft = diffDraft(working, saved, KNOWN);
        expect(draft.changedKeys).toEqual(['temperature']);
        expect(draft.changedPrompts).toEqual(['x', 'new', 'gone']);
    });

    it('skips prompts and order when the file has none (applying keeps the previous ones)', () => {
        const saved = body();
        delete saved.prompts;
        delete saved.prompt_order;
        const working = body();
        (working.prompts as Dict[])[1]!.content = 'changed';
        expect(diffDraft(working, saved, KNOWN).dirty).toBe(false);
    });

    it('reports switches, presence and sequence of the active order', () => {
        const working = body();
        const order = (working.prompt_order as Dict[])[0]!.order as Dict[];
        order.reverse();
        expect(diffDraft(working, body(), KNOWN)).toEqual({
            dirty: true,
            changedPrompts: [],
            changedKeys: ['prompt_order'],
        });
        order[0]!.enabled = false;
        order.push({ identifier: 'extra', enabled: true });
        const draft = diffDraft(working, body(), KNOWN);
        expect(draft.changedPrompts).toEqual(['x', 'extra']);
        order.splice(0, 1);
        expect(diffDraft(working, body(), KNOWN).changedPrompts).toEqual(expect.arrayContaining(['x', 'extra']));
    });

    it('expects PM default order when the file has an order without 100001', () => {
        const saved = body({
            prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
        });
        const working = body({
            prompt_order: [
                { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
                { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
            ],
        });
        // PM's default would also hold the built-in markers; main alone is what this working copy kept.
        expect(diffDraft(working, saved, KNOWN).changedPrompts).toEqual(
            expect.arrayContaining(['worldInfoBefore', 'chatHistory']),
        );
        const edited = body({
            prompt_order: [
                { character_id: 100000, order: [{ identifier: 'main', enabled: false }] },
                { character_id: 100001, order: [] },
            ],
        });
        expect(diffDraft(edited, saved, KNOWN).changedKeys).toContain('prompt_order');
        const without = body({ prompt_order: [{ character_id: 100001, order: [] }] });
        expect(diffDraft(without, saved, KNOWN).changedKeys).toContain('prompt_order');
    });

    it('reports extension sub-keys the working copy holds differently, not those only the file has', () => {
        const saved = body({ extensions: { a: 1, b: { c: 2 } } });
        expect(diffDraft(body({ extensions: { a: 1 } }), saved, KNOWN).dirty).toBe(false);
        expect(diffDraft(body({ extensions: undefined }), saved, KNOWN).dirty).toBe(false);
        expect(diffDraft(body({ extensions: { b: { c: 3 } } }), saved, KNOWN).changedKeys).toEqual(['extensions']);
        expect(diffDraft(body({ extensions: { d: 1 } }), body({ extensions: undefined }), KNOWN).changedKeys).toEqual([
            'extensions',
        ]);
    });
});

describe('merge, hash, secrets', () => {
    it('lays the working copy over the cached body and merges extensions per sub-key', () => {
        const merged = mergeBodies(
            { unknown: 1, temperature: 1, extensions: { a: 1, b: 1 } },
            { temperature: 0.5, extensions: { b: 2 }, gone: undefined },
        );
        expect(merged).toEqual({ unknown: 1, temperature: 0.5, extensions: { a: 1, b: 2 } });
        expect(mergeBodies(null, { a: 1 })).toEqual({ a: 1 });
        expect(mergeBodies({ extensions: 'odd' }, { extensions: { a: 1 } })).toEqual({ extensions: { a: 1 } });
    });

    it('hashes without sensitive keys and puts secrets of the file back', () => {
        expect(bodyHash({ a: 1, proxy_password: 'x' })).toBe(bodyHash({ a: 1 }));
        expect(bodyHash({ a: 1 })).not.toBe(bodyHash({ a: 2 }));
        expect(withSecretsOf({ a: 1, proxy_password: 'old' }, { proxy_password: 'new', b: 2 })).toEqual({
            a: 1,
            proxy_password: 'new',
        });
        expect(withSecretsOf({ a: 1, reverse_proxy: 'x' }, null)).toEqual({ a: 1 });
    });
});
