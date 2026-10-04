import { describe, expect, it } from 'vitest';
import {
    ELSE_MARKER,
    blockCondition,
    conditionHolds,
    evaluate,
    flagUses,
    isFalseBoolean,
    isFlagName,
    isMaestroFlag,
    isTruthy,
    parseCondition,
    parseConditional,
    topLevelMacros,
    trimScoped,
    unwrap,
    variableText,
    wrap,
    wrapBlockers,
} from '../../src/domain/preset-conditional-syntax';

describe('flag names', () => {
    it('follow ST’s variable shorthand pattern', () => {
        expect(isFlagName('maestro_scene_combat')).toBe(true);
        expect(isFlagName('a')).toBe(true);
        expect(isFlagName('my-var')).toBe(true);
        expect(isFlagName('my-')).toBe(false);
        expect(isFlagName('1x')).toBe(false);
        expect(isFlagName('a b')).toBe(false);
        expect(isFlagName('')).toBe(false);
        expect(isMaestroFlag('maestro_x')).toBe(true);
        expect(isMaestroFlag('maestro_')).toBe(false);
        expect(isMaestroFlag('mood')).toBe(false);
        expect(isMaestroFlag('maestro_bad-')).toBe(false);
    });
});

describe('macro tokens', () => {
    it('reads flags, names and arguments like ST’s lexer', () => {
        const tokens = topLevelMacros('{{#if .a}}x{{ /IF }}{{if::c::t}}{{.var}}{{// note}}{{else}}{{if}}{{if:.b}}');
        expect(tokens.map((token) => [token.name, token.closing, token.preserve, token.args])).toEqual([
            ['if', false, true, ['.a']],
            ['if', true, false, []],
            ['if', false, false, ['c', 't']],
            ['', false, false, []],
            ['', false, false, []],
            ['else', false, false, []],
            ['if', false, false, []],
            ['if', false, false, ['.b']],
        ]);
    });

    it('keeps nested macros inside an argument and stops at an unclosed {{', () => {
        const tokens = topLevelMacros('{{if {{getvar::x}}}}a{{/if}} {{broken');
        expect(tokens).toHaveLength(2);
        expect(tokens[0]!.args).toEqual(['{{getvar::x}}']);
        expect(topLevelMacros('{{if.x}}')[0]!.name).toBe('');
        expect(topLevelMacros('{{?}}')[0]!.name).toBe('');
    });
});

describe('conditions', () => {
    it('reads negation and the three forms', () => {
        expect(parseCondition('.maestro_x')).toMatchObject({ kind: 'local', name: 'maestro_x', negate: false });
        expect(parseCondition('! .maestro_x')).toMatchObject({ kind: 'local', name: 'maestro_x', negate: true });
        expect(parseCondition('$flag')).toMatchObject({ kind: 'global', name: 'flag' });
        expect(parseCondition('maestro_x')).toMatchObject({ kind: 'name', name: 'maestro_x' });
        expect(parseCondition('{{getvar::x}}')).toMatchObject({ kind: 'other' });
        expect(parseCondition('!')).toMatchObject({ kind: 'empty', negate: true });
        expect(parseCondition('.bad-')).toMatchObject({ kind: 'other' });
    });

    it('treats values the way getvar and isFalseBoolean do', () => {
        expect(variableText(undefined)).toBe('');
        expect(variableText(null)).toBe('');
        expect(variableText('1')).toBe('1');
        expect(variableText('01')).toBe('1');
        expect(variableText('0.0')).toBe('0');
        expect(variableText(' ')).toBe(' ');
        expect(variableText('')).toBe('');
        expect(variableText('yes')).toBe('yes');
        expect(variableText(true)).toBe('1');
        expect(variableText(false)).toBe('0');
        expect(variableText(Number.NaN)).toBe('');
        expect(variableText({ a: 1 })).toBe('{"a":1}');
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        expect(variableText(loop)).toBe('[object Object]');
        expect(isFalseBoolean(' OFF ')).toBe(true);
        expect(isTruthy('')).toBe(false);
        expect(isTruthy('0')).toBe(false);
        expect(isTruthy('false')).toBe(false);
        expect(isTruthy(' ')).toBe(true);
        expect(isTruthy('1')).toBe(true);
    });

    it('holds for flags given as a set, a list or values', () => {
        const local = parseCondition('.f');
        const negated = parseCondition('!.f');
        expect(conditionHolds(local, new Set(['f']))).toBe(true);
        expect(conditionHolds(local, ['f'])).toBe(true);
        expect(conditionHolds(local, { f: '0' })).toBe(false);
        expect(conditionHolds(local, { f: 'true' })).toBe(true);
        expect(conditionHolds(local, {})).toBe(false);
        expect(conditionHolds(negated, {})).toBe(true);
        expect(conditionHolds(parseCondition('$g'), {}, { globals: { g: '1' } })).toBe(true);
        expect(conditionHolds(parseCondition('$g'), {})).toBe(false);
        // A bare word is text: true without Maestro (P-137).
        expect(conditionHolds(parseCondition('maestro_x'), {})).toBe(true);
        expect(conditionHolds(parseCondition('description'), {}, { resolve: () => '' })).toBe(false);
        expect(conditionHolds(parseCondition('!'), {})).toBe(true);
    });
});

describe('structure', () => {
    it('reads a whole-block conditional with else', () => {
        const parse = parseConditional('{{if .maestro_x}}A{{else}}B{{/if}}');
        expect(parse.issues).toEqual([]);
        expect(parse.outside).toBe('');
        expect(parse.sections).toHaveLength(1);
        expect(parse.sections[0]).toMatchObject({ thenText: 'A', elseText: 'B', elseCount: 1, start: 0 });
    });

    it('splits on the top-level else only (nested if keeps its own)', () => {
        const text = '{{if .a}}{{if .b}}1{{else}}2{{/if}}{{else}}3{{/if}}';
        const section = parseConditional(text).sections[0]!;
        expect(section.thenText).toBe('{{if .b}}1{{else}}2{{/if}}');
        expect(section.elseText).toBe('3');
        expect(section.nested.then).toHaveLength(1);
        expect(flagUses(text).map((use) => use.name)).toEqual(['a', 'b']);
    });

    it('reports malformed tags', () => {
        const codes = (text: string) => parseConditional(text).issues.map((issue) => issue.code);
        expect(codes('{{if .a}}A')).toEqual(['unclosed']);
        expect(codes('A{{/if}}')).toEqual(['strayClose']);
        expect(codes('A{{else}}B')).toEqual(['strayElse']);
        expect(codes('{{if .a}}A{{else}}B{{else}}C{{/if}}')).toEqual(['extraElse']);
        expect(codes('{{if}}A{{/if}}')).toEqual(['emptyCondition']);
        expect(codes('{{if .a}}{{if .b}}x{{/if}}')).toEqual(['unclosed']);
        expect(codes('{{if .a}}{{/if}}{{/if}}')).toEqual(['strayClose']);
        expect(codes('{{if .a}}{{if .b}}x{{else}}y{{else}}z{{/if}}{{/if}}')).toEqual(['extraElse']);
        expect(codes('{{if::.a::text}}')).toEqual([]);
        expect(parseConditional('plain {{char}} {{iffy}} {{elsewhere}}').tagged).toBe(false);
        expect(parseConditional('A{{else}}B').tagged).toBe(true);
        expect(parseConditional('A{{ /if }}').tagged).toBe(true);
        expect(parseConditional('{{#if .a}}').tagged).toBe(true);
    });

    it('keeps the text outside the conditionals', () => {
        const parse = parseConditional('Intro {{if .a}}A{{/if}} and {{char}}');
        expect(parse.outside).toBe('Intro  and {{char}}');
        expect(parseConditional('\n{{if .a}}A{{/if}}\n').outside).toBe('\n\n');
    });
});

describe('block condition', () => {
    it('is the whole text on one .flag', () => {
        expect(blockCondition('{{if !.maestro_x}}\n  A\n  B\n{{else}}C{{/if}}')).toEqual({
            flag: 'maestro_x',
            negate: true,
            body: 'A\nB',
            elseText: 'C',
            preserve: false,
        });
        expect(blockCondition('{{#if .f}} A {{/if}}')).toMatchObject({ body: ' A ', preserve: true, elseText: null });
        expect(blockCondition(' {{if .f}}A{{/if}}')).toBeNull();
        expect(blockCondition('{{if .f}}A{{/if}}{{if .g}}B{{/if}}')).toBeNull();
        expect(blockCondition('{{if f}}A{{/if}}')).toBeNull();
        expect(blockCondition('{{if .f}}A')).toBeNull();
        expect(blockCondition('plain')).toBeNull();
    });
});

describe('wrap and unwrap', () => {
    it('wraps with nothing outside the tags', () => {
        expect(wrap('  Short rules. ', 'maestro_scene_combat')).toBe('{{if .maestro_scene_combat}}Short rules.{{/if}}');
        expect(wrap('A', 'maestro_x', { negate: true, elseText: 'B' })).toBe('{{if !.maestro_x}}A{{else}}B{{/if}}');
        expect(wrap('A\nB', 'maestro_x', { elseText: ' ' })).toBe('{{if .maestro_x}}\nA\nB\n{{/if}}');
        expect(wrap('A', 'maestro_x', { elseText: 'B\nC' })).toBe('{{if .maestro_x}}\nA\n{{else}}\nB\nC\n{{/if}}');
        expect(() => wrap('A', 'bad name')).toThrow();
    });

    it('round-trips through blockCondition and unwrap', () => {
        for (const body of [
            'One line',
            'Line 1\nLine 2',
            '<rules>\n- a\n- b\n</rules>',
            'With {{char}} and {{user}}',
        ]) {
            for (const negate of [false, true]) {
                for (const elseText of [null, 'Other', 'Other\ntwo']) {
                    const wrapped = wrap(body, 'maestro_x', { negate, elseText });
                    expect(wrapped).toBe(wrapped.trim());
                    expect(blockCondition(wrapped)).toEqual({
                        flag: 'maestro_x',
                        negate,
                        body,
                        elseText,
                        preserve: false,
                    });
                    expect(unwrap(wrapped)).toBe(body);
                    expect(unwrap(wrapped, { branch: 'else' })).toBe(elseText ?? '');
                    expect(validateFree(wrapped)).toBe(true);
                }
            }
        }
    });

    it('unwraps conditionals inside mixed text and leaves others', () => {
        expect(unwrap('Intro\n{{if .a}}\nA\n{{/if}}\nEnd')).toBe('Intro\nA\nEnd');
        expect(unwrap('{{if description}}D{{/if}}')).toBe('{{if description}}D{{/if}}');
        expect(unwrap('{{if .a}}A', {})).toBe('{{if .a}}A');
        expect(unwrap('{{#if .a}} A {{/if}}')).toBe(' A ');
        expect(unwrap('{{if .a}}A{{/if}}', { filter: () => false })).toBe('{{if .a}}A{{/if}}');
    });

    it('refuses to wrap text with stray tags', () => {
        expect(wrapBlockers('A{{else}}B')).toEqual(['strayElse']);
        expect(wrapBlockers('A{{/if}}')).toEqual(['strayClose']);
        expect(wrapBlockers('{{if .a}}A')).toEqual(['unclosed']);
        expect(wrapBlockers('{{if .a}}A{{/if}}')).toEqual([]);
    });
});

function validateFree(text: string): boolean {
    return parseConditional(text).issues.length === 0 && parseConditional(text).outside === '';
}

describe('evaluate', () => {
    const block = '{{if .maestro_scene_combat}}\nShort sentences.\n{{else}}\nLong prose.\n{{/if}}';

    it('picks the branch and trims it', () => {
        expect(evaluate(block, ['maestro_scene_combat'])).toBe('Short sentences.');
        expect(evaluate(block, [])).toBe('Long prose.');
        expect(evaluate('{{if .f}}A{{/if}}', [])).toBe('');
        expect(evaluate('{{if !.f}}A{{/if}}', [])).toBe('A');
        expect(evaluate('{{if !.f}}A{{/if}}', { f: '1' })).toBe('');
        expect(evaluate('{{if .f}}A{{/if}}', { f: 'false' })).toBe('');
        expect(evaluate('{{#if .f}}  A  {{/if}}', ['f'])).toBe('  A  ');
    });

    it('keeps whitespace outside the tags (P-138)', () => {
        expect(evaluate('\n{{if .f}}A{{/if}}\n', [])).toBe('\n\n');
        expect(evaluate('X {{if .f}}A{{/if}} {{char}}', ['f'])).toBe('X A {{char}}');
    });

    it('dedents the chosen branch like trimScopedContent', () => {
        expect(evaluate('{{if .f}}\n    a\n      b\n  c\n{{/if}}', ['f'])).toBe('a\n  b\nc');
        expect(trimScoped('')).toBe('');
        expect(trimScoped('\n \n')).toBe('');
        expect(trimScoped('  x\n\ty')).toBe('x\ny');
    });

    it('evaluates nested and inline conditionals', () => {
        const nested = '{{if .a}}A{{if .b}}+B{{/if}}{{else}}N{{/if}}';
        expect(evaluate(nested, ['a', 'b'])).toBe('A+B');
        expect(evaluate(nested, ['a'])).toBe('A');
        expect(evaluate(nested, ['b'])).toBe('N');
        expect(evaluate('x{{if::.a::yes{{else}}no}}', [])).toBe('xno');
        expect(evaluate('x{{if::.a::yes}}', ['a'])).toBe('xyes');
    });

    it('leaves malformed tags in the text and drops stray else', () => {
        expect(evaluate('{{if .f}}A', ['f'])).toBe('{{if .f}}A');
        expect(evaluate('A{{/if}}', [])).toBe('A{{/if}}');
        expect(evaluate('A{{else}}B', [])).toBe('AB');
        expect(evaluate('{{if .f}}A{{else}}B{{else}}C{{/if}}', [])).toBe('BC');
        expect(evaluate('{{if}}A{{/if}}', [])).toBe('{{if}}A{{/if}}');
        expect(evaluate('{{if::.a::b}}x{{/if}}', ['a'])).toBe('{{if::.a::b}}x{{/if}}');
        expect(evaluate(`a${ELSE_MARKER}b`, [])).toBe('ab');
        expect(evaluate('no macros', [])).toBe('no macros');
    });

    it('uses globals and a resolver for other conditions', () => {
        expect(evaluate('{{if $g}}G{{/if}}', [], { globals: { g: 'on' } })).toBe('G');
        expect(evaluate('{{if description}}D{{/if}}', [])).toBe('D');
        expect(evaluate('{{if description}}D{{/if}}', [], { resolve: () => '' })).toBe('');
    });
});

describe('flag uses', () => {
    it('lists flags with their negation', () => {
        expect(flagUses('{{if .a}}x{{/if}}{{if !.a}}y{{/if}}{{if !.b}}z{{/if}}{{if $c}}{{/if}}')).toEqual([
            { name: 'a', negated: true, plain: true },
            { name: 'b', negated: true, plain: false },
        ]);
    });
});
