import { describe, expect, it } from 'vitest';
import { defaultResult } from '../../../src/domain/agents/def';
import { cleanPlain, parseAgentOutput, verdictFix } from '../../../src/domain/agents/output';

describe('plain answers', () => {
    it('cleans fences, labels and wrapping quotes', () => {
        expect(cleanPlain('```\nNote: «Лучше замедлиться»\n```')).toBe('Лучше замедлиться');
        expect(cleanPlain('  Directive:   "Speed up."  ')).toBe('Speed up.');
    });

    it('reads injections and notes; NONE is nothing; empty is an error', () => {
        expect(parseAgentOutput(defaultResult('inject'), 'Let Mira act first.')).toEqual({
            ok: true,
            output: { type: 'inject', text: 'Let Mira act first.' },
        });
        expect(parseAgentOutput(defaultResult('note'), undefined, 'NONE')).toEqual({
            ok: true,
            output: { type: 'none' },
        });
        expect(parseAgentOutput(defaultResult('note'), 'нет.')).toEqual({ ok: true, output: { type: 'none' } });
        expect(parseAgentOutput(defaultResult('note'), '  ')).toEqual({ ok: false, error: 'empty' });
        const long = parseAgentOutput(defaultResult('inject'), 'x'.repeat(5000));
        expect(long.ok && long.output.type === 'inject' && long.output.text.length).toBe(2000);
    });
});

describe('JSON answers', () => {
    it('flags: only the declared names and plain values', () => {
        const result = { type: 'flags' as const, options: { names: ['tension', 'night', 'n'] } };
        expect(parseAgentOutput(result, { flags: { tension: 'high', night: true, n: 3, other: 1 } })).toEqual({
            ok: true,
            output: { type: 'flags', flags: { tension: 'high', night: true, n: 3 } },
        });
        expect(parseAgentOutput(result, { flags: { other: 1, n: Infinity } })).toEqual({
            ok: true,
            output: { type: 'none' },
        });
        expect(parseAgentOutput(result, 'text')).toEqual({ ok: false, error: 'shape' });
    });

    it('memory: only declared fields, values as text', () => {
        const result = defaultResult('memory');
        if (result.type !== 'memory') throw new Error('type');
        result.options.fields = [{ name: 'goal' }, { name: 'stages' }, { name: 'n' }, { name: 'flag' }];
        expect(
            parseAgentOutput(result, {
                fields: { goal: ' Freedom ', stages: ['a', 'b', 3], n: 2, flag: false, extra: 'x', empty: '' },
            }),
        ).toEqual({
            ok: true,
            output: { type: 'memory', fields: { goal: 'Freedom', stages: 'a; b', n: '2', flag: 'false' } },
        });
        expect(parseAgentOutput(result, { fields: { goal: { deep: 1 } } })).toEqual({
            ok: true,
            output: { type: 'none' },
        });
        expect(parseAgentOutput(result, { nope: 1 })).toEqual({ ok: false, error: 'shape' });
    });

    it('rewrite: the contract editNeeded / editedText / changes', () => {
        const result = defaultResult('rewrite');
        expect(parseAgentOutput(result, { editNeeded: false })).toEqual({ ok: true, output: { type: 'none' } });
        expect(parseAgentOutput(result, { editNeeded: true, editedText: 'New.', changes: ['a', 5] })).toEqual({
            ok: true,
            output: { type: 'rewrite', editNeeded: true, editedText: 'New.', changes: ['a'] },
        });
        expect(parseAgentOutput(result, { editNeeded: true, editedText: '  ' })).toEqual({ ok: false, error: 'shape' });
        expect(parseAgentOutput(result, { editedText: 'x' })).toEqual({ ok: false, error: 'shape' });
    });

    it('verdict: problems with an issue; ok only without problems', () => {
        const result = defaultResult('verdict');
        expect(parseAgentOutput(result, { ok: true, problems: [] })).toEqual({
            ok: true,
            output: { type: 'verdict', ok: true, problems: [] },
        });
        expect(
            parseAgentOutput(result, {
                ok: true,
                problems: [
                    { issue: 'speaks for the player', quote: 'I nod', fix: 'leave it to the player' },
                    { issue: '' },
                    'x',
                ],
            }),
        ).toEqual({
            ok: true,
            output: {
                type: 'verdict',
                ok: false,
                problems: [{ quote: 'I nod', issue: 'speaks for the player', fix: 'leave it to the player' }],
            },
        });
        expect(parseAgentOutput(result, { problems: [] })).toEqual({ ok: false, error: 'shape' });
    });

    it('choices: up to the count, cleaned; none is empty', () => {
        const result = { type: 'choices' as const, options: { count: 2, send: false } };
        expect(parseAgentOutput(result, { choices: ['"Run."', 'Fight', 'Hide', 4] })).toEqual({
            ok: true,
            output: { type: 'choices', choices: ['Run.', 'Fight'] },
        });
        expect(parseAgentOutput(result, { choices: [] })).toEqual({ ok: false, error: 'empty' });
        expect(parseAgentOutput(result, {})).toEqual({ ok: false, error: 'shape' });
    });
});

describe('verdictFix', () => {
    it('writes the one-shot fix for the redone reply', () => {
        expect(
            verdictFix('Сверка голоса', [
                { quote: 'Сударь', issue: 'солдат говорит как поэт', fix: 'грубо и коротко' },
                { quote: '', issue: 'повтор', fix: '' },
            ]),
        ).toBe(
            '[Fix for this reply (Сверка голоса):\n- «Сударь» — солдат говорит как поэт. Instead: грубо и коротко\n- повтор.]',
        );
    });
});
