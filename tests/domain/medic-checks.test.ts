import { describe, expect, it } from 'vitest';
import { assistantDepthEntries, bookEntries, missingAddedKeys } from '../../src/domain/medic-lore';
import { activePromptOrder, findAssistantPrefill, promptIndex } from '../../src/domain/medic-prefill';
import { findQvinkGaps, qvinkRemovalBoundary, QVINK_GAP_DEFAULTS } from '../../src/domain/medic-qvink';
import type { QvinkMessageView } from '../../src/domain/medic-qvink';

describe('Qvink gaps', () => {
    const view = (overrides: Partial<QvinkMessageView> = {}): QvinkMessageView => ({
        isUser: false,
        isSystem: false,
        textLength: 100,
        skip: false,
        record: null,
        ...overrides,
    });
    const memory = (text: string, lagging?: boolean, extra: Partial<NonNullable<QvinkMessageView['record']>> = {}) => ({
        memory: text,
        exclude: false,
        remember: false,
        ...(lagging === undefined ? {} : { lagging }),
        ...extra,
    });

    it('finds the removal boundary', () => {
        expect(
            qvinkRemovalBoundary([view(), view({ record: memory('x', false) }), view({ record: memory('', true) })]),
        ).toBe(1);
        expect(qvinkRemovalBoundary([view(), view({ record: memory('', true) })])).toBe(-1);
    });

    it('counts dropped messages that Qvink would summarise', () => {
        const messages = [
            view(), // gap
            view({ isUser: true }), // user messages are not summarised by default
            view({ isSystem: true }),
            view({ textLength: 5 }), // too short
            view({ skip: true }), // picture post
            view({ record: memory('', undefined, { exclude: true }) }),
            view({ record: memory('summary', false) }),
            view({ record: memory('', false) }), // gap, marked by Qvink
            view({ record: memory('', true) }), // still in the prompt
        ];
        expect(findQvinkGaps(messages)).toEqual([0, 7]);
        expect(
            findQvinkGaps(messages, { ...QVINK_GAP_DEFAULTS, includeUser: true, includeSystem: true, minTokens: 0 }),
        ).toEqual([0, 1, 2, 3, 7]);
        expect(findQvinkGaps([view(), view({ record: memory('', true) })])).toEqual([]);
    });
});

describe('lore entries', () => {
    it('reads entries of maps and lists', () => {
        expect(bookEntries({ entries: { 1: { uid: 1 }, 2: 'junk' } })).toEqual([{ uid: 1 }]);
        expect(bookEntries({ entries: [{ uid: 2 }, null] })).toEqual([{ uid: 2 }]);
        expect(bookEntries(null)).toEqual([]);
    });

    it('finds enabled assistant entries at depth', () => {
        expect(
            assistantDepthEntries([
                { uid: 1, position: 4, role: 2, comment: 'Archive' },
                { uid: '2', position: '4', role: '2' },
                { uid: 3, position: 4, role: 2, disable: true },
                { uid: 4, position: 4, role: 0 },
                { uid: 5, position: 1, role: 2 },
                { uid: 'x', position: 4, role: 2 },
            ]),
        ).toEqual([
            { uid: 1, comment: 'Archive' },
            { uid: 2, comment: '' },
            { uid: -1, comment: '' },
        ]);
    });

    it('finds keys the Localizer added that are gone', () => {
        const entry = { key: ['Anna', 'Анна'], keysecondary: ['x'] };
        expect(missingAddedKeys(entry, { key: ['Анна', 'Аня'], keysecondary: ['y', 'x'] })).toEqual(['Аня', 'y']);
        expect(missingAddedKeys({}, { key: ['a'], keysecondary: [] })).toEqual(['a']);
    });
});

describe('assistant prefill', () => {
    const prompts = [
        { identifier: 'main', role: 'system', content: 'Main' },
        { identifier: 'chatHistory', marker: true },
        { identifier: 'worldInfoAfter', marker: true },
        { identifier: 'jb', role: 'user', content: 'JB' },
        { identifier: 'prefill', name: 'Prefill', role: 'assistant', content: 'Sure' },
        { identifier: 'empty', role: 'assistant', content: '  ' },
        { identifier: 'deep', role: 'assistant', content: 'x', injection_position: 1, injection_depth: 2 },
        'junk',
    ];
    const order = (...ids: string[]) => ids.map((identifier) => ({ identifier, enabled: true }));

    it('picks the global order, then the character, then the first list', () => {
        const lists = [
            { character_id: 7, order: [{ identifier: 'a', enabled: false }] },
            { character_id: 100001, order: [{ identifier: 'b' }, { nope: 1 }] },
        ];
        expect(activePromptOrder(lists, 7)).toEqual([{ identifier: 'b', enabled: true }]);
        expect(activePromptOrder([lists[0]], 7)).toEqual([{ identifier: 'a', enabled: false }]);
        expect(activePromptOrder([{ character_id: 3, order: 'x' }], 9)).toEqual([]);
        expect(activePromptOrder([lists[0]])).toEqual([{ identifier: 'a', enabled: false }]);
        expect(activePromptOrder(null)).toEqual([]);
    });

    it('finds the prompt index', () => {
        expect(promptIndex(prompts, 'jb')).toBe(3);
        expect(promptIndex(prompts, 'nope')).toBe(-1);
        expect(promptIndex(null, 'jb')).toBe(-1);
    });

    it('flags an assistant prompt that ends the request', () => {
        expect(findAssistantPrefill(prompts, order('main', 'chatHistory', 'jb', 'prefill', 'empty'))).toEqual({
            identifier: 'prefill',
            name: 'Prefill',
            placement: 'relative',
        });
    });

    it('ignores prompts before the history, after a user prompt or a marker, and disabled ones', () => {
        expect(findAssistantPrefill(prompts, order('prefill', 'chatHistory', 'jb'))).toBeNull();
        expect(findAssistantPrefill(prompts, order('chatHistory', 'prefill', 'worldInfoAfter'))).toBeNull();
        expect(findAssistantPrefill(prompts, order('main', 'prefill'))).toBeNull();
        expect(
            findAssistantPrefill(prompts, [
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'prefill', enabled: false },
                { identifier: 'missing', enabled: true },
                { identifier: 'deep', enabled: true },
            ]),
        ).toBeNull();
        expect(findAssistantPrefill('x', order('chatHistory'))).toBeNull();
    });

    it('flags in-chat assistant prompts at depth 0', () => {
        const atDepth = [
            { identifier: 'p', role: 'assistant', content: 'x', injection_position: 1, injection_depth: 0 },
        ];
        expect(findAssistantPrefill(atDepth, order('p'))).toEqual({ identifier: 'p', name: 'p', placement: 'depth' });
        const userAtDepth = [
            { identifier: 'p', role: 'user', content: 'x', injection_position: 1, injection_depth: 0 },
        ];
        expect(findAssistantPrefill(userAtDepth, order('p'))).toBeNull();
    });
});
