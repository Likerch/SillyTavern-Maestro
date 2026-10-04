import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROMPT_ORDER,
    activeOrder,
    applyPromptPatch,
    expectedActiveOrder,
    findOrderList,
    insertIndex,
    isBuiltinPrompt,
    isProtectedPrompt,
    normalizePrompt,
    normalizePromptPatch,
    promptIds,
    readOrder,
    reorderEntries,
} from '../../src/domain/preset-store-prompts';

describe('type normalisation (P-132)', () => {
    it('types a patch as ST compares it', () => {
        expect(
            normalizePromptPatch({
                identifier: 'x',
                enabled: true,
                extension: true,
                position: 3,
                injection_position: '1',
                injection_depth: '12.6',
                injection_order: 'abc',
                role: ' Assistant ',
                injection_trigger: ['Normal', 'bogus', 'quiet', 'normal'],
                forbid_overrides: 'true',
                system_prompt: 1,
                marker: 'no',
                name: null,
                content: 42,
                custom: { a: [1] },
                gone: undefined,
            }),
        ).toEqual({
            injection_position: 1,
            injection_depth: 13,
            injection_order: 100,
            role: 'assistant',
            injection_trigger: ['normal', 'quiet'],
            forbid_overrides: true,
            system_prompt: true,
            marker: false,
            name: '',
            content: '42',
            custom: { a: [1] },
        });
    });

    it('clamps depth and order, falls back for blanks, unknown roles and positions', () => {
        expect(
            normalizePromptPatch({
                injection_depth: 20000,
                injection_order: -5,
                role: 'narrator',
                injection_position: 2,
                injection_trigger: 'swipe',
            }),
        ).toEqual({
            injection_depth: 9999,
            injection_order: 0,
            role: 'system',
            injection_position: 0,
            injection_trigger: ['swipe'],
        });
        expect(normalizePromptPatch({ injection_depth: '  ', role: 5, injection_trigger: 7 })).toEqual({
            injection_depth: 4,
            role: 'system',
            injection_trigger: [],
        });
    });

    it('marks every block that is not a built-in system_prompt:false, marker:false (P-039)', () => {
        expect(normalizePrompt({ identifier: 'mine', system_prompt: true, marker: true, enabled: 'yes' })).toEqual({
            identifier: 'mine',
            system_prompt: false,
            marker: false,
            enabled: false,
        });
        expect(normalizePrompt({ identifier: 'main', system_prompt: true })).toEqual({
            identifier: 'main',
            system_prompt: true,
        });
        expect(normalizePrompt({ name: 'no id' })).toEqual({ name: 'no id', system_prompt: false, marker: false });
    });

    it('applies a patch over the whole block, fixing old foreign types', () => {
        const prompt = {
            identifier: 'x',
            injection_position: '1',
            injection_depth: '2',
            injection_order: '7',
            role: 'USER',
            extra: 1,
        };
        expect(applyPromptPatch(prompt, { content: 'c' })).toEqual({
            identifier: 'x',
            injection_position: 1,
            injection_depth: 2,
            injection_order: 7,
            role: 'user',
            extra: 1,
            content: 'c',
            system_prompt: false,
            marker: false,
        });
        expect(
            applyPromptPatch({ identifier: 'chatHistory', marker: true, system_prompt: true }, { role: 'user' }),
        ).toEqual({
            identifier: 'chatHistory',
            marker: true,
            system_prompt: true,
            role: 'user',
        });
    });

    it('knows built-ins', () => {
        expect(isBuiltinPrompt('worldInfoBefore')).toBe(true);
        expect(isBuiltinPrompt('custom')).toBe(false);
        expect(isProtectedPrompt({ identifier: 'main' })).toBe(true);
        expect(isProtectedPrompt({ identifier: 'x', system_prompt: true })).toBe(false);
        expect(isProtectedPrompt({})).toBe(false);
    });
});

describe('prompt order', () => {
    const lists = [
        { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
        { character_id: '100001', order: [{ identifier: 'a', enabled: true }, { identifier: 'b' }, { nope: 1 }, 'x'] },
    ];

    it('finds the global list by String() id and reads entries strictly', () => {
        expect(findOrderList(lists)?.character_id).toBe('100001');
        expect(findOrderList(lists, 100000)?.character_id).toBe(100000);
        expect(findOrderList('nope')).toBeNull();
        expect(activeOrder(lists)).toEqual([
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
        ]);
        expect(activeOrder([])).toEqual([]);
        expect(readOrder(null)).toEqual([]);
    });

    it('reorders the listed entries first and keeps the rest', () => {
        const entries = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: false },
            { identifier: 'c', enabled: true },
        ];
        expect(reorderEntries(entries, ['c', 'x', 'c', 'a']).map((entry) => entry.identifier)).toEqual(['c', 'a', 'b']);
        expect(insertIndex(entries)).toBe(0);
        expect(insertIndex(entries, 'b')).toBe(2);
        expect(insertIndex(entries, 'zzz')).toBe(0);
    });

    it('predicts the order ST holds after applying a body (P-037)', () => {
        expect(expectedActiveOrder({}, [])).toBeNull();
        expect(expectedActiveOrder({ prompt_order: lists }, ['a'])).toEqual([{ identifier: 'a', enabled: true }]);
        const fallback = expectedActiveOrder({ prompt_order: [lists[0]] }, ['main', 'chatHistory', 'jailbreak']);
        expect(fallback).toEqual(
            DEFAULT_PROMPT_ORDER.filter((entry) => ['main', 'chatHistory', 'jailbreak'].includes(entry.identifier)),
        );
        expect(promptIds([{ identifier: 'a' }, { name: 'x' }, 3])).toEqual(['a']);
        expect(promptIds(null)).toEqual([]);
    });
});
