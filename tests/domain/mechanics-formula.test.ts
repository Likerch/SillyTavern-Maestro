// M25 formulas (plan-2 §6 п. 9): the hand-written parser and evaluator — numbers, operators, parentheses, functions,
// references and dice; errors with codes and places; canonical text; circles between derived attributes.
import { describe, expect, it } from 'vitest';
import {
    computeFormula,
    constantOf,
    evaluateFormula,
    FORMULA_LIMITS,
    formulaCycles,
    formulaErrorText,
    formulaText,
    parseFormula,
    unknownRef,
} from '../../src/domain/mechanics-formula';
import type { FormulaNode } from '../../src/domain/mechanics-formula';

const values: Record<string, number> = { level: 3, mana: 40, 'magic.mana': 25, 'roll.margin': 4 };
const ref = (path: readonly string[]) => values[path.join('.')] ?? null;

function value(text: string, rng?: () => number): number {
    const result = computeFormula(text, { ref, ...(rng ? { rng } : {}) }, { dice: true });
    if (!result) throw new Error(`bad formula ${text}`);
    return result.value;
}

function error(text: string, dice = false) {
    const parsed = parseFormula(text, { dice });
    if (parsed.ok) throw new Error(`parsed ${text}`);
    return parsed.error;
}

describe('parseFormula and evaluation', () => {
    it('computes arithmetic with precedence, parentheses and unary signs', () => {
        expect(value('50 + 10 * @level')).toBe(80);
        expect(value('(50 + 10) * 2')).toBe(120);
        expect(value('-@level + 10')).toBe(7);
        expect(value('--3')).toBe(3);
        expect(value('+4')).toBe(4);
        expect(value('7 / 2')).toBe(3.5);
        expect(value('10 − 4')).toBe(6);
        expect(value('3 × 4 ÷ 2')).toBe(6);
        expect(value('1.5 * 2')).toBe(3);
        expect(value('10 - 2 - 3')).toBe(5);
        expect(value('@MANA')).toBe(40);
    });

    it('knows min, max, floor, ceil, round, abs and clamp', () => {
        expect(value('min(5, @level, 9)')).toBe(3);
        expect(value('max(1, @level * 2)')).toBe(6);
        expect(value('floor(7 / 2) + ceil(7 / 2)')).toBe(7);
        expect(value('round(2.5)')).toBe(3);
        expect(value('abs(-4)')).toBe(4);
        expect(value('clamp(@mana, 0, 30)')).toBe(30);
        expect(value('clamp(5, 30, 10)')).toBe(10);
    });

    it('reads another mechanic and the roll', () => {
        expect(value('@magic.mana + @roll.margin')).toBe(29);
    });

    it('counts a missing reference as 0 and reports it once', () => {
        const parsed = parseFormula('@missing + @missing + 1');
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const result = evaluateFormula(parsed.ast, { ref: () => null });
        expect(result).toMatchObject({ value: 1, missing: ['missing'] });
        const thrown = evaluateFormula(parsed.ast, {
            ref: () => {
                throw new Error('boom');
            },
        });
        expect(thrown.value).toBe(1);
    });

    it('divides by zero as 0 and flags it; non-finite results are 0', () => {
        const parsed = parseFormula('5 / (@level - 3)');
        if (!parsed.ok) throw new Error('parse');
        expect(evaluateFormula(parsed.ast, { ref })).toMatchObject({ value: 0, divZero: true });
        const huge: FormulaNode = {
            type: 'bin',
            op: '*',
            left: { type: 'num', value: 1e308 },
            right: { type: 'num', value: 10 },
        };
        expect(evaluateFormula(huge, { ref }).value).toBe(0);
    });

    it('rolls dice only where allowed, with the RNG or as the average', () => {
        expect(error('2d6').code).toBe('dice');
        let i = 0;
        const faces = [0.99, 0];
        const rolled = computeFormula('2d6 + 1', { ref, rng: () => faces[i++] ?? 0.5 }, { dice: true });
        expect(rolled).toMatchObject({ value: 8, rolls: [6, 1] });
        expect(value('1d6')).toBe(3.5);
        expect(value('d20 + 0')).toBe(10.5);
        expect(value('1к4')).toBe(2.5);
        const broken = computeFormula('1d6', { ref, rng: () => Number.NaN }, { dice: true });
        expect(broken?.value).toBe(1);
        expect(error('0d6', true).code).toBe('dice');
        expect(error('1d1', true).code).toBe('dice');
        expect(error(`${FORMULA_LIMITS.dice + 1}d6`, true).code).toBe('dice');
        expect(error('1d1001', true).code).toBe('dice');
    });

    it('takes plain numbers', () => {
        expect(parseFormula(12)).toMatchObject({ ok: true, text: '12' });
        expect(parseFormula(Number.NaN).ok).toBe(false);
    });

    it('gives an error code and place for broken formulas', () => {
        expect(error('').code).toBe('empty');
        expect(error('   ').code).toBe('empty');
        expect(error('x'.repeat(FORMULA_LIMITS.length + 1)).code).toBe('long');
        expect(error('2 $ 3')).toEqual({ code: 'char', at: 2, detail: '$' });
        expect(error('2 +').code).toBe('syntax');
        expect(error('(2 + 3').code).toBe('paren');
        expect(error('2 + 3)').code).toBe('paren');
        expect(error(')').code).toBe('paren');
        expect(error('pow(2, 3)')).toMatchObject({ code: 'func', detail: 'pow' });
        expect(error('floor(1, 2)')).toMatchObject({ code: 'args', detail: 'floor' });
        expect(error('clamp(1)').code).toBe('args');
        expect(error('max()').code).toBe('args');
        expect(error('min 3').code).toBe('syntax');
        expect(error('max(1, 2').code).toBe('paren');
        expect(error('@').code).toBe('ref');
        expect(error('@1x').code).toBe('ref');
        expect(error('2 3').code).toBe('syntax');
        expect(error(',').code).toBe('syntax');
        expect(error('('.repeat(30) + '1' + ')'.repeat(30)).code).toBe('depth');
        expect(error('-'.repeat(30) + '1').code).toBe('depth');
    });

    it('reads paths of up to three parts', () => {
        const parsed = parseFormula('@a.b.c');
        expect(parsed.ok && parsed.refs).toEqual([['a', 'b', 'c']]);
        expect(error('@a.b.c.d').code).toBe('char');
    });
});

describe('text and helpers', () => {
    it('writes the canonical text', () => {
        const text = (input: string) => {
            const parsed = parseFormula(input, { dice: true });
            return parsed.ok ? parsed.text : '';
        };
        expect(text('50+10*@LEVEL')).toBe('50 + 10 * @level');
        expect(text('(1+2)*3')).toBe('(1 + 2) * 3');
        expect(text('1-(2+3)')).toBe('1 - (2 + 3)');
        expect(text('1+(2-3)')).toBe('1 + 2 - 3');
        expect(text('8/(2*2)')).toBe('8 / (2 * 2)');
        expect(text('-(1+2)')).toBe('-(1 + 2)');
        expect(text('-@a')).toBe('-@a');
        expect(text('max(1,2d6)')).toBe('max(1, 2d6)');
        expect(formulaText({ type: 'num', value: 2 })).toBe('2');
    });

    it('constants and errors in words', () => {
        expect(constantOf(5)).toBe(5);
        expect(constantOf(Number.POSITIVE_INFINITY)).toBeNull();
        expect(constantOf('2 * 3')).toBe(6);
        expect(constantOf('@a')).toBeNull();
        expect(constantOf('1d6')).toBeNull();
        expect(constantOf('nope(')).toBeNull();
        expect(formulaErrorText({ code: 'func', at: 3, detail: 'pow' })).toBe(
            'an unknown function (min, max, floor, ceil, round, abs and clamp are known) at 4: «pow»',
        );
        expect(formulaErrorText({ code: 'empty' })).toBe('the formula is empty');
    });

    it('finds unknown references', () => {
        const parsed = parseFormula('@a + @b.c');
        expect(unknownRef(parsed, (path) => path[0] === 'a')).toEqual({ code: 'ref', detail: '@b.c' });
        expect(unknownRef(parsed, () => true)).toBeNull();
        expect(unknownRef(parseFormula(''), () => true)?.code).toBe('empty');
    });

    it('finds circles between derived values once each', () => {
        const graph = new Map<string, string[]>([
            ['a', ['b']],
            ['b', ['c', 'x']],
            ['c', ['a']],
            ['d', ['d']],
            ['e', ['a']],
        ]);
        expect(formulaCycles(graph)).toEqual([['a', 'b', 'c'], ['d']]);
        expect(
            formulaCycles(
                new Map([
                    ['a', ['b']],
                    ['b', []],
                ]),
            ),
        ).toEqual([]);
    });
});
