import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROMPT_ORDER,
    blockFields,
    blockKind,
    canEditBlock,
    canEditText,
    canForbidOverrides,
    canRemoveBlock,
    canReset,
    copyName,
    detachedPrompts,
    enabledCount,
    fieldsPatch,
    highlightSegments,
    isBuiltinId,
    maestroFlags,
    matchesSearch,
    normalizePrompt,
    promptDepth,
    promptName,
    promptOrder,
    promptRole,
    promptText,
    promptTriggers,
    sameFields,
    sideEffectMacros,
    tokenTotal,
    typeProblems,
    userFlagsPatch,
} from '../../src/domain/preset-ui-blocks';
import type { PromptLike } from '../../src/domain/preset-ui-blocks';

const user = (fields: Partial<PromptLike> = {}): PromptLike => ({
    identifier: 'u1',
    name: 'Mine',
    role: 'system',
    content: 'text',
    system_prompt: false,
    marker: false,
    ...fields,
});

describe('block kinds and permissions (P-020, P-025, P-026, P-029)', () => {
    it('classifies rows like PM', () => {
        expect(blockKind(user({ injection_position: 1 }))).toBe('inChat');
        expect(blockKind({ identifier: 'chatHistory', marker: true, system_prompt: true })).toBe('marker');
        expect(blockKind({ identifier: 'main', system_prompt: true, forbid_overrides: true })).toBe('important');
        expect(blockKind({ identifier: 'main', system_prompt: true })).toBe('global');
        expect(blockKind(user())).toBe('user');
        expect(blockKind(user({ injection_position: '1' }))).toBe('user');
    });

    it('knows what may be edited, removed, reset and overridden', () => {
        expect(canEditBlock({ identifier: 'chatHistory', marker: true })).toBe(false);
        expect(canEditBlock({ identifier: 'dialogueExamples', marker: true })).toBe(false);
        expect(canEditBlock({ identifier: 'scenario', marker: true })).toBe(true);
        expect(canEditBlock(user())).toBe(true);
        expect(canEditText({ identifier: 'scenario', marker: true })).toBe(false);
        expect(canEditText(user())).toBe(true);
        expect(canRemoveBlock(user())).toBe(true);
        expect(canRemoveBlock(user({ system_prompt: undefined }))).toBe(true);
        expect(canRemoveBlock(user({ system_prompt: true }))).toBe(false);
        expect(canRemoveBlock({ identifier: 'main', system_prompt: false })).toBe(false);
        expect(canRemoveBlock(user({ identifier: 'x', marker: true }))).toBe(false);
        expect(canReset({ identifier: 'main', system_prompt: true })).toBe(true);
        expect(canReset(user())).toBe(false);
        expect(canForbidOverrides('jailbreak')).toBe(true);
        expect(canForbidOverrides('nsfw')).toBe(false);
        expect(isBuiltinId('worldInfoAfter')).toBe(true);
        expect(isBuiltinId('custom')).toBe(false);
    });

    it('ST’s default order has the 12 built-in blocks with enhanceDefinitions off', () => {
        expect(DEFAULT_PROMPT_ORDER).toHaveLength(12);
        expect(DEFAULT_PROMPT_ORDER.filter((entry) => !entry.enabled).map((entry) => entry.identifier)).toEqual([
            'enhanceDefinitions',
        ]);
    });
});

describe('fields with strict types (P-043…P-052, P-132)', () => {
    it('reads stored values with ST’s defaults', () => {
        expect(promptName({ identifier: 'x', name: '  ' })).toBe('x');
        expect(promptText({ identifier: 'x', content: 5 })).toBe('');
        expect(promptRole({ identifier: 'x', role: 'narrator' })).toBe('system');
        expect(promptRole({ identifier: 'x', role: 'assistant' })).toBe('assistant');
        expect(promptDepth({ identifier: 'x' })).toBe(4);
        expect(promptDepth({ identifier: 'x', injection_depth: '7' })).toBe(7);
        expect(promptDepth({ identifier: 'x', injection_depth: 99999 })).toBe(9999);
        expect(promptDepth({ identifier: 'x', injection_depth: -3 })).toBe(0);
        expect(promptDepth({ identifier: 'x', injection_depth: 'deep' })).toBe(4);
        expect(promptOrder({ identifier: 'x', injection_order: 2.6 })).toBe(3);
        expect(promptOrder({ identifier: 'x', injection_order: '' })).toBe(100);
        expect(
            promptTriggers({ identifier: 'x', injection_trigger: ['Normal', 'swipe', 'bogus', 3, 'swipe'] }),
        ).toEqual(['normal', 'swipe']);
        expect(promptTriggers({ identifier: 'x', injection_trigger: 'normal' })).toEqual([]);
        expect(blockFields(user({ injection_position: 1, forbid_overrides: true }))).toMatchObject({
            position: 1,
            forbidOverrides: true,
            depth: 4,
            order: 100,
        });
        expect(blockFields({ identifier: 'x' }).name).toBe('');
    });

    it('compares form states', () => {
        const a = blockFields(user({ injection_trigger: ['normal', 'swipe'] }));
        expect(sameFields(a, { ...a, triggers: ['swipe', 'normal'] })).toBe(true);
        expect(sameFields(a, { ...a, triggers: ['swipe'] })).toBe(false);
        expect(sameFields(a, { ...a, content: 'other' })).toBe(false);
    });

    it('writes only changed fields, fixes foreign types and never a marker’s text', () => {
        const block = user();
        expect(fieldsPatch(block, blockFields(block))).toEqual({});
        expect(fieldsPatch(block, { ...blockFields(block), content: 'new', depth: 3 })).toEqual({
            content: 'new',
            injection_depth: 3,
        });
        expect(fieldsPatch(block, { ...blockFields(block), name: '   ' })).toEqual({});
        expect(
            fieldsPatch(user({ injection_depth: '2', role: 'narrator' }), blockFields(user({ injection_depth: '2' }))),
        ).toEqual({
            role: 'system',
            injection_depth: 2,
        });
        expect(
            fieldsPatch(user({ injection_trigger: ['Swipe'] }), blockFields(user({ injection_trigger: ['Swipe'] }))),
        ).toEqual({
            injection_trigger: ['swipe'],
        });
        expect(fieldsPatch(user({ system_prompt: undefined }), blockFields(user()))).toEqual({ system_prompt: false });
        const marker = { identifier: 'scenario', marker: true, system_prompt: true, name: 'Scenario' };
        expect(
            fieldsPatch(marker, {
                ...blockFields(marker),
                content: 'x',
                role: 'user',
                triggers: ['quiet'],
                forbidOverrides: true,
            }),
        ).toEqual({
            role: 'user',
            injection_trigger: ['quiet'],
            forbid_overrides: true,
        });
        expect(
            fieldsPatch(
                { identifier: 'nameless' },
                { ...blockFields({ identifier: 'nameless' }), position: 1, order: 99 },
            ),
        ).toMatchObject({
            name: 'nameless',
            injection_position: 1,
            injection_order: 99,
        });
    });

    it('normalizes foreign blocks and reports traps', () => {
        expect(
            normalizePrompt({
                identifier: 'f',
                injection_position: '1',
                injection_depth: '3',
                injection_order: '50',
                injection_trigger: ['Normal'],
                forbid_overrides: 'yes',
                enabled: true,
                extension: true,
                position: 2,
                extra: 'kept',
            }),
        ).toEqual({
            identifier: 'f',
            name: 'f',
            role: 'system',
            content: '',
            injection_position: 1,
            injection_depth: 3,
            injection_order: 50,
            injection_trigger: ['normal'],
            forbid_overrides: false,
            extra: 'kept',
            system_prompt: false,
            marker: false,
        });
        const marker = normalizePrompt({
            identifier: 'chatHistory',
            marker: true,
            system_prompt: true,
            name: 'Chat History',
        });
        expect(marker).toEqual({
            identifier: 'chatHistory',
            marker: true,
            system_prompt: true,
            name: 'Chat History',
            role: 'system',
        });
        expect(typeProblems(user())).toEqual([]);
        expect(
            typeProblems({
                identifier: 'x',
                role: 'narrator',
                injection_position: '1',
                injection_depth: '4',
                injection_order: '1',
            }),
        ).toEqual(['systemPrompt', 'role', 'position', 'depth', 'order']);
        expect(userFlagsPatch(user())).toEqual({});
        expect(userFlagsPatch({ identifier: 'x' })).toEqual({ system_prompt: false, marker: false });
    });
});

describe('search, highlighting and macros', () => {
    it('matches every word in the name, identifier or text', () => {
        expect(matchesSearch(user({ name: 'Writing Style', content: 'Short sentences' }), 'u1', 'style short')).toBe(
            true,
        );
        expect(matchesSearch(user(), 'u1', 'missing')).toBe(false);
        expect(matchesSearch(null, 'dangling-id', 'dangling')).toBe(true);
        expect(matchesSearch(user(), 'u1', '   ')).toBe(true);
    });

    it('splits text into macros, conditions, flags, variables and comments', () => {
        const segments = highlightSegments(
            'Hi {{char}}! {{if .maestro_scene_combat}}Fight{{else}}Talk{{/if}} {{getvar::x}} {{.y}} {{// note}} end',
        );
        expect(segments.map((segment) => segment.kind)).toEqual([
            'text',
            'macro',
            'text',
            'flag',
            'text',
            'condition',
            'text',
            'condition',
            'text',
            'variable',
            'text',
            'variable',
            'text',
            'comment',
            'text',
        ]);
        expect(highlightSegments('{{if !.maestro_x}}').map((segment) => segment.kind)).toEqual(['flag']);
        expect(highlightSegments('{{if $global}}')[0]?.kind).toBe('condition');
        expect(highlightSegments('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
    });

    it('finds Maestro flags and macros with side effects', () => {
        expect(maestroFlags('{{if .maestro_a}}x{{/if}}{{#if !.maestro_b_2}}y{{/if}}{{if .maestro_a}}')).toEqual([
            'maestro_a',
            'maestro_b_2',
        ]);
        expect(sideEffectMacros('{{setvar::a::1}} {{ incvar::b }} {{getvar::c}} {{flushglobalvar}}')).toEqual([
            'setvar',
            'incvar',
            'flushglobalvar',
        ]);
    });
});

describe('list helpers', () => {
    const rows = [
        { item: { identifier: 'a', enabled: true }, prompt: user({ identifier: 'a' }) },
        { item: { identifier: 'b', enabled: false }, prompt: user({ identifier: 'b' }) },
        { item: { identifier: 'gone', enabled: true }, prompt: null },
    ];

    it('counts enabled blocks and their tokens', () => {
        expect(enabledCount(rows)).toEqual({ enabled: 1, total: 2 });
        expect(
            tokenTotal(
                rows,
                new Map([
                    ['a', 10],
                    ['b', 5],
                    ['gone', 3],
                ]),
            ),
        ).toBe(10);
        expect(tokenTotal(rows, new Map([['a', Number.NaN]]))).toBe(0);
    });

    it('offers non-system blocks outside the order, sorted by name', () => {
        const prompts = [
            user({ identifier: 'z', name: 'Zeta' }),
            user({ identifier: 'a', name: 'Alpha' }),
            user({ identifier: 'listed', name: 'Beta' }),
            { identifier: 'main', system_prompt: true },
            { identifier: 'm', marker: true },
        ];
        expect(detachedPrompts(prompts, ['listed']).map((item) => item.identifier)).toEqual(['a', 'z']);
    });

    it('names copies', () => {
        expect(copyName('Style', ['Style'], 'copy')).toBe('Style (copy)');
        expect(copyName('Style', ['Style (copy)', 'Style (copy 2)'], 'copy')).toBe('Style (copy 3)');
    });
});
