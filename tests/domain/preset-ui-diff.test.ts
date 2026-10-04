import { describe, expect, it } from 'vitest';
import {
    MASK,
    activeOrderOf,
    diffCounts,
    isSensitiveKey,
    presetDiff,
    promptsOf,
    shownValue,
} from '../../src/domain/preset-ui-diff';

const body = (order: { identifier: string; enabled: boolean }[], extra: Record<string, unknown> = {}) => ({
    temperature: 1,
    prompts: [
        { identifier: 'main', name: 'Main', content: 'Write.' },
        { identifier: 'style', name: 'Style', content: 'Short.' },
        { identifier: 'gone', name: 'Gone' },
    ],
    prompt_order: [
        { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
        { character_id: 100001, order },
    ],
    ...extra,
});

describe('preset diff', () => {
    it('reads prompts and the active order', () => {
        expect(promptsOf({ prompts: [{ identifier: 'a' }, 'junk', { name: 'no id' }] })).toEqual([{ identifier: 'a' }]);
        expect(promptsOf(null)).toEqual([]);
        expect(activeOrderOf(body([{ identifier: 'style', enabled: false }]))).toEqual([
            { identifier: 'style', enabled: false },
        ]);
        expect(
            activeOrderOf({ prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: 1 }] }] }),
        ).toEqual([{ identifier: 'main', enabled: false }]);
        expect(activeOrderOf({ prompt_order: 'x' })).toEqual([]);
        expect(activeOrderOf({ prompt_order: [{ character_id: 100001, order: 'x' }] })).toEqual([]);
        expect(activeOrderOf(undefined)).toEqual([]);
    });

    it('finds block, order and key changes', () => {
        const before = body([
            { identifier: 'main', enabled: true },
            { identifier: 'style', enabled: true },
            { identifier: 'gone', enabled: true },
        ]);
        const after = {
            ...body(
                [
                    { identifier: 'style', enabled: false },
                    { identifier: 'main', enabled: true },
                    { identifier: 'fresh', enabled: true },
                ],
                { temperature: 0.5, top_p: 0.9, reverse_proxy: 'http://proxy' },
            ),
        };
        after.prompts = [
            { identifier: 'main', name: 'Main', content: 'Write more.' },
            { identifier: 'style', name: 'Style', content: 'Short.' },
            { identifier: 'fresh', name: 'Fresh', content: 'New' },
        ];
        const diff = presetDiff(before, after);
        expect(diff.same).toBe(false);
        expect(diff.prompts).toEqual([
            {
                identifier: 'main',
                name: 'Main',
                kind: 'changed',
                fields: [{ field: 'content', before: 'Write.', after: 'Write more.' }],
            },
            { identifier: 'fresh', name: 'Fresh', kind: 'added', fields: [] },
            { identifier: 'gone', name: 'Gone', kind: 'removed', fields: [] },
        ]);
        expect(diff.order).toEqual({
            moved: ['style'],
            enabled: [],
            disabled: ['style'],
            added: ['fresh'],
            removed: ['gone'],
        });
        expect(diff.keys).toEqual([
            { key: 'temperature', before: 1, after: 0.5, sensitive: false },
            { key: 'top_p', before: undefined, after: 0.9, sensitive: false },
            { key: 'reverse_proxy', before: undefined, after: MASK, sensitive: true },
        ]);
        expect(diffCounts(diff)).toEqual({ prompts: 3, order: 4, keys: 3 });
    });

    it('reports nothing for equal bodies (key order does not count) and handles missing bodies', () => {
        const a = body([{ identifier: 'main', enabled: true }], { extensions: { a: 1, b: 2 } });
        const b = body([{ identifier: 'main', enabled: true }], { extensions: { b: 2, a: 1 } });
        expect(presetDiff(a, b).same).toBe(true);
        const fromNothing = presetDiff(null, { temperature: 1 });
        expect(fromNothing.keys).toEqual([{ key: 'temperature', before: undefined, after: 1, sensitive: false }]);
        expect(presetDiff(undefined, undefined).same).toBe(true);
        const enabledOnly = presetDiff(
            body([{ identifier: 'main', enabled: false }]),
            body([{ identifier: 'main', enabled: true }]),
        );
        expect(enabledOnly.order.enabled).toEqual(['main']);
    });

    it('masks secret values only', () => {
        expect(isSensitiveKey('proxy_password')).toBe(true);
        expect(isSensitiveKey('temperature')).toBe(false);
        expect(shownValue('proxy_password', 'hunter2')).toBe(MASK);
        expect(shownValue('proxy_password', '')).toBe('');
        expect(shownValue('proxy_password', null)).toBeNull();
        expect(shownValue('temperature', 1)).toBe(1);
    });
});
