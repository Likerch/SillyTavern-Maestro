import { describe, expect, it } from 'vitest';
import {
    EXHAUSTIVE_FLAGS,
    applyCondition,
    conditionalInfo,
    customFlagName,
    flagCombinations,
    mergeCatalogue,
    neverSends,
    readFlagEntries,
    validateConditional,
    whitespaceCombination,
    withoutMaestroConditionals,
} from '../../src/domain/preset-conditional-check';

const codes = (text: string, options = {}) => validateConditional(text, options).map((issue) => issue.code);
const KNOWN = { known: ['maestro_scene_combat', 'maestro_explicit'] };

describe('catalogue', () => {
    it('reads entries defensively', () => {
        expect(
            readFlagEntries(
                [
                    {
                        name: 'maestro_scene_combat',
                        titleKey: 'm13.flag.combat',
                        descriptionKey: 'm13.flag.combatHint',
                    },
                    'maestro_explicit',
                    { name: 'bad name' },
                    { name: 3 },
                    7,
                    { name: 'maestro_x', titleKey: '' },
                ],
                'director',
            ),
        ).toEqual([
            {
                name: 'maestro_scene_combat',
                titleKey: 'm13.flag.combat',
                descriptionKey: 'm13.flag.combatHint',
                source: 'director',
            },
            { name: 'maestro_explicit', source: 'director' },
            { name: 'maestro_x', source: 'director' },
        ]);
        expect(readFlagEntries({ maestro_scene_combat: '1', 'not valid': '1' }, 'director')).toEqual([
            { name: 'maestro_scene_combat', source: 'director' },
        ]);
        expect(readFlagEntries(null, 'director')).toEqual([]);
        expect(readFlagEntries('maestro_x', 'director')).toEqual([]);
    });

    it('merges lists, the first wins', () => {
        const merged = mergeCatalogue(
            [{ name: 'a', source: 'director', titleKey: 'k' }],
            [
                { name: 'a', source: 'builtin' },
                { name: 'b', source: 'builtin' },
            ],
            [{ name: 'c', source: 'preset' }],
        );
        expect(merged.map((entry) => [entry.name, entry.source])).toEqual([
            ['a', 'director'],
            ['b', 'builtin'],
            ['c', 'preset'],
        ]);
    });

    it('turns free input into a maestro_ flag', () => {
        expect(customFlagName(' weather_rain ')).toBe('maestro_weather_rain');
        expect(customFlagName('maestro_mood')).toBe('maestro_mood');
        expect(customFlagName('')).toBeNull();
        expect(customFlagName('two words')).toBeNull();
        expect(customFlagName('maestro_')).toBeNull();
    });
});

describe('combinations', () => {
    it('enumerates every combination for few flags', () => {
        expect(flagCombinations(['a', 'b'])).toEqual([[], ['a'], ['b'], ['a', 'b']]);
        expect(flagCombinations([])).toEqual([[]]);
        expect(flagCombinations(['a', 'a'])).toEqual([[], ['a']]);
    });

    it('samples beyond the limit', () => {
        const names = Array.from({ length: EXHAUSTIVE_FLAGS + 1 }, (_, index) => `f${index}`);
        const combos = flagCombinations(names);
        expect(combos).toHaveLength(2 + 2 * names.length);
        expect(combos[0]).toEqual([]);
        expect(combos[1]).toEqual(names);
        expect(flagCombinations(['a', 'b', 'c'], 2)).toEqual([
            [],
            ['a', 'b', 'c'],
            ['a'],
            ['b'],
            ['c'],
            ['b', 'c'],
            ['a', 'c'],
            ['a', 'b'],
        ]);
    });

    it('finds a combination that leaves whitespace only', () => {
        expect(whitespaceCombination('{{if .a}}A{{/if}} {{if .b}}B{{/if}}')).toEqual([]);
        expect(whitespaceCombination('{{#if .a}}  {{/if}}')).toEqual(['a']);
        expect(whitespaceCombination('{{if .a}}A{{else}}B{{/if}}')).toBeNull();
        expect(whitespaceCombination('plain')).toBeNull();
        expect(neverSends('{{if .a}}{{/if}}')).toBe(true);
        expect(neverSends('{{if .a}} {{else}}\n{{/if}}')).toBe(true);
        expect(neverSends('{{if .a}}A{{/if}}')).toBe(false);
        expect(neverSends('plain')).toBe(false);
    });
});

describe('validation', () => {
    it('is silent for plain text and a correct block', () => {
        expect(codes('plain {{char}}')).toEqual([]);
        expect(codes('{{if .maestro_scene_combat}}A{{else}}B{{/if}}', KNOWN)).toEqual([]);
        expect(codes('{{if !.maestro_explicit}}A{{/if}}', KNOWN)).toEqual([]);
        expect(codes('Intro {{if .maestro_explicit}}A{{/if}}', KNOWN)).toEqual([]);
    });

    it('reports whitespace outside the tags once', () => {
        expect(codes('\n{{if .maestro_explicit}}A{{/if}}\n', KNOWN)).toEqual(['outsideWhitespace']);
        expect(codes('{{if .maestro_explicit}}A{{/if}} {{if .maestro_scene_combat}}B{{/if}}', KNOWN)).toEqual([
            'outsideWhitespace',
        ]);
        expect(validateConditional('{{#if .maestro_explicit}} {{/if}}', KNOWN)).toEqual([
            { code: 'whitespaceResult', severity: 'warn', flags: ['maestro_explicit'] },
        ]);
    });

    it('reports flags Maestro does not own and unsafe forms', () => {
        expect(validateConditional('{{if .mood}}A{{/if}}', KNOWN)).toEqual([
            { code: 'unknownFlag', severity: 'warn', flag: 'mood' },
        ]);
        expect(validateConditional('{{if .maestro_rain}}A{{/if}}', KNOWN)).toEqual([
            { code: 'customFlag', severity: 'info', flag: 'maestro_rain' },
        ]);
        expect(codes('{{if maestro_explicit}}A{{/if}}', KNOWN)).toEqual(['bareFlag']);
        expect(codes('{{if $maestro_explicit}}A{{/if}}', KNOWN)).toEqual(['globalFlag']);
        expect(codes('X{{if description}}A{{/if}}{{if $other}}B{{/if}}', KNOWN)).toEqual([]);
        expect(codes('{{if .maestro_rain}}A{{/if}}{{if .maestro_rain}}B{{/if}}', KNOWN)).toEqual(['customFlag']);
    });

    it('reports the macro engine and malformed tags', () => {
        expect(codes('{{if .maestro_explicit}}A{{/if}}', { ...KNOWN, macroEngine: false })).toEqual(['macroEngineOff']);
        expect(codes('{{if .maestro_explicit}}A{{/if}}', { ...KNOWN, macroEngine: true })).toEqual([]);
        expect(codes('plain', { macroEngine: false })).toEqual([]);
        expect(codes('{{if .maestro_explicit}}A', KNOWN)).toEqual(['unclosed']);
        expect(codes('{{if .maestro_explicit}}A{{else}}B{{else}}C{{/if}}', KNOWN)).toEqual(['extraElse']);
        expect(codes('{{if}}A{{/if}}', KNOWN)).toEqual(['emptyCondition']);
        expect(codes('{{if .maestro_explicit}}{{/if}}', KNOWN)).toEqual(['neverSends']);
    });

    it('checks nested conditionals', () => {
        expect(codes('{{if .maestro_explicit}}{{if .mood}}A{{/if}}{{/if}}', KNOWN)).toEqual(['unknownFlag']);
    });
});

describe('blocks', () => {
    it('describes the conditional facts of a block', () => {
        expect(conditionalInfo('x', 'plain')).toBeNull();
        expect(conditionalInfo('x', '{{if .maestro_a}}A{{/if}}')).toEqual({
            identifier: 'x',
            flags: ['maestro_a'],
            whole: true,
            maestro: true,
            onlyMaestro: true,
        });
        expect(conditionalInfo('x', 'Intro {{if .mood}}A{{/if}}')).toEqual({
            identifier: 'x',
            flags: ['mood'],
            whole: false,
            maestro: false,
            onlyMaestro: false,
        });
        expect(conditionalInfo('x', '{{if .scene}}A{{/if}}', ['scene'])?.maestro).toBe(true);
        expect(conditionalInfo('x', '{{if maestro_a}}A{{/if}}')).toMatchObject({
            whole: false,
            maestro: true,
            onlyMaestro: true,
        });
        // Two conditionals with whitespace between: nothing but Maestro's; an unclosed one still mentions a flag.
        expect(conditionalInfo('x', '\n{{if .maestro_a}}A{{/if}}\n{{if !.maestro_b}}B{{/if}}')).toMatchObject({
            whole: false,
            onlyMaestro: true,
        });
        expect(conditionalInfo('x', '{{if .maestro_a}}A')).toMatchObject({ maestro: true, onlyMaestro: false });
        expect(conditionalInfo('x', '{{if .mood}}A{{/if}}{{if .maestro_a}}B{{/if}}')).toMatchObject({
            maestro: true,
            onlyMaestro: false,
        });
    });

    it('strips Maestro conditionals for the disable preparation', () => {
        const text = 'Intro\n{{if .maestro_a}}\nA\n{{else}}\nB\n{{/if}}\n{{if .mood}}M{{if .maestro_b}}+{{/if}}{{/if}}';
        expect(withoutMaestroConditionals(text, 'then')).toBe('Intro\nA\n{{if .mood}}M+{{/if}}');
        expect(withoutMaestroConditionals(text, 'absent')).toBe('Intro\nB\n{{if .mood}}M{{/if}}');
        expect(withoutMaestroConditionals('{{if !.maestro_a}}N{{/if}}', 'absent')).toBe('N');
        expect(withoutMaestroConditionals('{{if maestro_a}}T{{else}}F{{/if}}', 'absent')).toBe('T');
        expect(withoutMaestroConditionals('{{if $maestro_a}}T{{else}}F{{/if}}', 'absent')).toBe('F');
        expect(withoutMaestroConditionals('{{if .scene}}S{{/if}}', 'absent', ['scene'])).toBe('');
        expect(withoutMaestroConditionals('{{#if .maestro_a}} A {{/if}}', 'then')).toBe(' A ');
        expect(withoutMaestroConditionals('{{if .mood}}M{{else}}{{if .maestro_a}}x{{/if}}{{/if}}', 'absent')).toBe(
            '{{if .mood}}M{{else}}{{/if}}',
        );
    });
});

describe('the editor condition', () => {
    it('wraps, rewraps and unwraps a block', () => {
        expect(applyCondition('Text', { mode: 'when', flag: 'maestro_a' })).toEqual({
            ok: true,
            text: '{{if .maestro_a}}Text{{/if}}',
        });
        expect(
            applyCondition('{{if .maestro_a}}Text{{/if}}', { mode: 'unless', flag: 'maestro_b', elseText: 'E' }),
        ).toEqual({
            ok: true,
            text: '{{if !.maestro_b}}Text{{else}}E{{/if}}',
        });
        expect(applyCondition('{{if .maestro_a}}\nText\n{{else}}E{{/if}}', { mode: 'always' })).toEqual({
            ok: true,
            text: 'Text',
        });
        expect(applyCondition('Intro {{if .maestro_a}}A{{/if}}', { mode: 'always' })).toEqual({
            ok: true,
            text: 'Intro {{if .maestro_a}}A{{/if}}',
        });
        expect(applyCondition('Intro {{if .maestro_a}}A{{/if}}', { mode: 'when', flag: 'maestro_b' })).toEqual({
            ok: true,
            text: '{{if .maestro_b}}Intro {{if .maestro_a}}A{{/if}}{{/if}}',
        });
    });

    it('refuses stray tags and bad names', () => {
        expect(applyCondition('A{{else}}B', { mode: 'when', flag: 'maestro_a' })).toEqual({
            ok: false,
            reason: 'blocked',
            codes: ['strayElse'],
        });
        expect(applyCondition('A', { mode: 'when', flag: 'bad name' })).toEqual({ ok: false, reason: 'flag' });
    });
});
