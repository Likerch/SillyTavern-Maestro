import { describe, expect, it } from 'vitest';
import { makeStyle, presetRules } from '../../src/domain/message-style';
import type { MatchKind, StyleRule } from '../../src/domain/message-style';
import { buildFormatHint } from '../../src/domain/message-style-hint';

function rule(id: string, kind: MatchKind, extra: Partial<StyleRule> = {}): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(), ...extra };
}

describe('buildFormatHint', () => {
    it('describes the Classic format in Russian and English', () => {
        expect(buildFormatHint(presetRules('classic'), 'ru')).toBe(
            'Прямую речь пиши в кавычках "…", мысли и выделения — *курсивом*.',
        );
        expect(buildFormatHint(presetRules('classic'), 'en')).toBe(
            'Write direct speech in double quotes "…", thoughts and emphasis in *italics*.',
        );
    });

    it('names only the first dialogue kind and the first thoughts kind, then the extras', () => {
        const rules = [
            rule('d', 'dashDialogue'),
            rule('q', 'doubleQuotes'),
            rule('u', 'underscore'),
            rule('a', 'asterisk'),
            rule('b', 'backticks'),
            rule('p', 'parentheses'),
            rule('k', 'brackets'),
            rule('s', 'doubleAsterisk'),
        ];
        expect(buildFormatHint(rules, 'ru')).toBe(
            'Прямую речь оформляй с новой строки через тире: «— Реплика, — сказал он.», мысли и выделения — _курсивом_, короткие ремарки — в (скобках), служебные пометки — в [квадратных скобках], надписи и записки — в `обратных кавычках`.',
        );
        expect(buildFormatHint([rule('g', 'guillemets')], 'en')).toBe('Write direct speech in guillemets «…».');
    });

    it('ignores the player’s rules, disabled rules and kinds the model does not write', () => {
        const rules = [
            rule('q', 'doubleQuotes', { applyTo: 'user' }),
            rule('a', 'asterisk', { enabled: false }),
            rule('n', 'narration'),
            rule('c', 'custom', { match: { kind: 'custom', pattern: 'x' } }),
        ];
        expect(buildFormatHint(rules, 'ru')).toBe('');
        expect(buildFormatHint([], 'en')).toBe('');
        expect(buildFormatHint([rule('q', 'doubleQuotes')], 'de' as never)).toBe(
            'Write direct speech in double quotes "…".',
        );
    });
});
