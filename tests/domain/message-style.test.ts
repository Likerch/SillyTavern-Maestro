import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PRESET,
    MAX_PATTERN,
    MAX_RULES,
    PRESET_IDS,
    activeRules,
    appliesTo,
    buildPlan,
    clampOpacity,
    cleanFlags,
    compileCustom,
    defaultPlayerStyle,
    defaultStyle,
    isDialogueKind,
    isEmptyPlan,
    isHexColor,
    isPresetId,
    makeStyle,
    newRuleId,
    normalizeColor,
    normalizePlayer,
    normalizeRule,
    normalizeRules,
    normalizeStyle,
    planSignature,
    presetRules,
    sameRules,
    supportsDecoration,
} from '../../src/domain/message-style';
import type { MatchKind, StyleRule } from '../../src/domain/message-style';

function rule(id: string, kind: MatchKind, extra: Partial<StyleRule> = {}): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(), ...extra };
}

describe('presets', () => {
    it('Classic is the default: plain narration, "…" in the quote colour, *…* italic', () => {
        expect(DEFAULT_PRESET).toBe('classic');
        const rules = presetRules('classic');
        const byKind = (kind: MatchKind) => rules.find((item) => item.match.kind === kind)!;
        expect(byKind('narration').style).toEqual(defaultStyle());
        expect(byKind('doubleQuotes').style.color).toBe('quote');
        expect(byKind('asterisk').style.italic).toBe(true);
        expect(byKind('dashDialogue').enabled).toBe(false);
    });

    it('has the required presets, each valid and fresh on every call', () => {
        for (const id of ['classic', 'book', 'speech', 'thoughts', 'guillemets', 'screenplay', 'minimal']) {
            expect(PRESET_IDS).toContain(id);
        }
        for (const id of PRESET_IDS) {
            const rules = presetRules(id);
            expect(normalizeRules(rules)).toEqual(rules);
            expect(presetRules(id)).not.toBe(rules);
            expect(new Set(rules.map((item) => item.id)).size).toBe(rules.length);
        }
        expect(presetRules('minimal')).toEqual([]);
        expect(presetRules('nope' as never)).toEqual(presetRules('classic'));
    });

    it('describes the presets as asked', () => {
        const kindStyle = (id: (typeof PRESET_IDS)[number], kind: MatchKind) =>
            presetRules(id).find((item) => item.match.kind === kind)!.style;
        expect(kindStyle('book', 'guillemets')).toMatchObject({ color: 'text', marks: 'keep' });
        expect(kindStyle('book', 'asterisk')).toMatchObject({ italic: true, color: 'muted' });
        expect(kindStyle('speech', 'doubleQuotes')).toMatchObject({ bold: true, color: 'accent' });
        expect(kindStyle('speech', 'narration').opacity).toBeLessThan(1);
        expect(kindStyle('thoughts', 'asterisk')).toMatchObject({ italic: true, color: 'muted', bar: true });
        expect(kindStyle('guillemets', 'doubleQuotes').marks).toBe('guillemets');
        expect(kindStyle('guillemets', 'dashDialogue').marks).toBe('guillemets');
        expect(kindStyle('screenplay', 'narration')).toMatchObject({ italic: true, color: 'muted' });
        expect(kindStyle('screenplay', 'doubleQuotes').bold).toBe(true);
        expect(presetRules('player').filter((item) => item.applyTo === 'user')).toHaveLength(3);
        expect(isPresetId('book')).toBe(true);
        expect(isPresetId('Book')).toBe(false);
    });

    it('compares rule sets', () => {
        const a = presetRules('classic');
        expect(sameRules(a, presetRules('classic'))).toBe(true);
        const b = presetRules('classic');
        b[0]!.style.italic = true;
        expect(sameRules(a, b)).toBe(false);
        expect(sameRules(a, a.slice(1))).toBe(false);
        const custom = [rule('c1', 'custom', { match: { kind: 'custom', pattern: 'x' } })];
        expect(sameRules(custom, [rule('c1', 'custom', { match: { kind: 'custom', pattern: 'x', flags: '' } })])).toBe(
            true,
        );
        expect(
            sameRules([rule('a', 'asterisk', { match: { kind: 'asterisk', pattern: 'x' } })], [rule('a', 'asterisk')]),
        ).toBe(true);
    });
});

describe('rules', () => {
    it('knows kinds and scopes', () => {
        expect(isDialogueKind('dashDialogue')).toBe(true);
        expect(isDialogueKind('asterisk')).toBe(false);
        expect(supportsDecoration('narration')).toBe(false);
        expect(appliesTo({ applyTo: 'all' }, 'user')).toBe(true);
        expect(appliesTo({ applyTo: 'char' }, 'user')).toBe(false);
        const rules = [rule('a', 'asterisk', { applyTo: 'user' }), rule('b', 'asterisk', { enabled: false })];
        expect(activeRules(rules, 'user').map((item) => item.id)).toEqual(['a']);
        expect(activeRules(rules, 'char')).toEqual([]);
        expect(activeRules(rules).map((item) => item.id)).toEqual(['a']);
    });

    it('makes free ids', () => {
        expect(newRuleId([])).toBe('c1');
        expect(newRuleId([{ id: 'c1' }, { id: 'c3' }])).toBe('c2');
        expect(newRuleId([{ id: 'r1' }], 'r')).toBe('r2');
    });
});

describe('repair', () => {
    it('normalizes colours and opacity', () => {
        expect(normalizeColor('accent')).toBe('accent');
        expect(normalizeColor('#AbC')).toBe('#abc');
        expect(normalizeColor('#a1b2c3')).toBe('#a1b2c3');
        expect(normalizeColor('red')).toBeNull();
        expect(normalizeColor(5)).toBeNull();
        expect(isHexColor('#12345')).toBe(false);
        expect(clampOpacity(0.123)).toBe(0.3);
        expect(clampOpacity(0.876)).toBe(0.88);
        expect(clampOpacity(7)).toBe(1);
        expect(clampOpacity('x')).toBe(1);
        expect(clampOpacity(Number.NaN)).toBe(1);
    });

    it('repairs a style for its kind', () => {
        const raw = {
            color: 'bogus',
            italic: 'yes',
            bold: false,
            underline: true,
            opacity: 0.5,
            spacing: true,
            font: 'serif',
            highlight: true,
            bar: true,
            marks: 'curly',
        };
        expect(normalizeStyle(raw, 'doubleQuotes')).toEqual({
            color: null,
            italic: null,
            bold: false,
            underline: true,
            opacity: 0.5,
            spacing: true,
            font: 'serif',
            highlight: true,
            bar: true,
            marks: 'curly',
        });
        expect(normalizeStyle(raw, 'narration')).toMatchObject({
            underline: false,
            highlight: false,
            bar: false,
            marks: 'keep',
        });
        expect(normalizeStyle({ font: 'comic', marks: 'weird' }, 'guillemets')).toMatchObject({
            font: null,
            marks: 'keep',
        });
        expect(normalizeStyle(null, 'asterisk')).toEqual(defaultStyle());
    });

    it('repairs rules: unknown kinds dropped, bad ids replaced, duplicates renamed, custom fields kept', () => {
        expect(normalizeRule(null)).toBeNull();
        expect(normalizeRule({ match: { kind: 'sparkles' } })).toBeNull();
        expect(normalizeRule({ id: 'x', match: 'asterisk', applyTo: 'nobody', enabled: 0, name: 7 })).toMatchObject({
            id: 'x',
            name: '',
            enabled: true,
            match: { kind: 'asterisk' },
            applyTo: 'all',
        });
        const custom = normalizeRule({
            id: 'c1',
            name: `  ${'я'.repeat(80)}  `,
            enabled: false,
            match: { kind: 'custom', pattern: 'p'.repeat(MAX_PATTERN + 5), flags: 'gimsx' },
            applyTo: 'char',
        })!;
        expect(custom.name).toHaveLength(60);
        expect(custom.enabled).toBe(false);
        expect(custom.match.pattern).toHaveLength(MAX_PATTERN);
        expect(custom.match.flags).toBe('is');
        expect(normalizeRule({ id: 'c2', match: { kind: 'custom', pattern: 5 } })!.match).toEqual({
            kind: 'custom',
            pattern: '',
            flags: '',
        });

        const rules = normalizeRules([
            { id: 'a', match: { kind: 'asterisk' } },
            { id: 'a', match: { kind: 'underscore' } },
            { id: 'BAD ID', match: { kind: 'brackets' } },
            'junk',
        ]);
        expect(rules.map((item) => item.id)).toEqual(['a', 'r1', 'r2']);
        expect(normalizeRules('nope')).toEqual([]);
        const many = Array.from({ length: MAX_RULES + 5 }, (_, index) => ({
            id: `x${index}`,
            match: { kind: 'asterisk' },
        }));
        expect(normalizeRules(many)).toHaveLength(MAX_RULES);
    });

    it('repairs the player style', () => {
        expect(normalizePlayer(undefined)).toEqual(defaultPlayerStyle());
        expect(
            normalizePlayer({ enabled: false, mark: 'tint', color: '#123456', name: false, align: 'indent' }),
        ).toEqual({
            enabled: false,
            mark: 'tint',
            color: '#123456',
            name: false,
            align: 'indent',
        });
        expect(normalizePlayer({ mark: 'glow', color: 'pink', align: 'left' })).toEqual(defaultPlayerStyle());
    });
});

describe('custom regular expressions', () => {
    it('compiles with u when possible, without it otherwise', () => {
        const unicode = compileCustom('\\p{Lu}+');
        expect(unicode.ok && unicode.re.flags).toBe('gu');
        const legacy = compileCustom('\\-\\:', 'i');
        expect(legacy.ok && legacy.re.flags).toBe('gi');
        expect(compileCustom('\\-\\:', 'i')).toBe(legacy);
    });

    it('refuses empty, too long, broken and empty-matching patterns', () => {
        expect(compileCustom('')).toEqual({ ok: false, reason: 'empty' });
        expect(compileCustom('   ')).toEqual({ ok: false, reason: 'empty' });
        expect(compileCustom(5)).toEqual({ ok: false, reason: 'empty' });
        expect(compileCustom('x'.repeat(MAX_PATTERN + 1))).toEqual({ ok: false, reason: 'tooLong' });
        const broken = compileCustom('(');
        expect(broken.ok).toBe(false);
        expect(!broken.ok && broken.reason).toBe('syntax');
        expect(!broken.ok && broken.detail).toBeTruthy();
        expect(compileCustom('a*')).toEqual({ ok: false, reason: 'emptyMatch' });
    });

    it('keeps the cache bounded', () => {
        for (let i = 0; i < 80; i++) expect(compileCustom(`x${i}`).ok).toBe(true);
        expect(compileCustom('x79').ok).toBe(true);
    });

    it('cleans flags', () => {
        expect(cleanFlags('sigi')).toBe('is');
        expect(cleanFlags(null)).toBe('');
    });
});

describe('the annotation plan', () => {
    it('lists what the hook must mark, in rule order, per scope', () => {
        const rules = [
            rule('c1', 'custom', { match: { kind: 'custom', pattern: '~[^~]+~', flags: 'i' } }),
            rule('bad', 'custom', { match: { kind: 'custom', pattern: '(' } }),
            rule('p', 'parentheses', { applyTo: 'user' }),
            rule('d', 'dashDialogue', { style: makeStyle({ marks: 'curly' }) }),
            rule('d2', 'dashDialogue'),
            rule('q', 'doubleQuotes'),
            rule('g', 'guillemets', { enabled: false }),
            rule('b', 'brackets', { applyTo: 'char' }),
        ];
        expect(buildPlan(rules, 'user')).toEqual({
            quotes: true,
            marks: { dq: false, gq: false, dash: true },
            spans: [
                { cls: 'c-c1', kind: 'custom', pattern: '~[^~]+~', flags: 'i' },
                { cls: 'paren', kind: 'parentheses' },
                { cls: 'dash', kind: 'dashDialogue' },
            ],
        });
        expect(buildPlan(rules, 'char').spans.map((span) => span.cls)).toEqual(['c-c1', 'dash', 'bracket']);
        const empty = buildPlan([rule('a', 'asterisk')], 'char');
        expect(isEmptyPlan(empty)).toBe(true);
        expect(isEmptyPlan(buildPlan(rules, 'char'))).toBe(false);
        expect(planSignature(null)).toBe('');
        expect(planSignature({ user: empty, char: empty })).toContain('"spans":[]');
    });
});
