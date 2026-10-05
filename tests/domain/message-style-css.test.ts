import { describe, expect, it } from 'vitest';
import { PRESET_IDS, defaultPlayerStyle, makeStyle, presetRules } from '../../src/domain/message-style';
import type { MatchKind, PlayerStyle, StyleRule } from '../../src/domain/message-style';
import {
    ACCENT_COLOR,
    COLOR_VALUES,
    FONT_STACKS,
    TEXT_COLOR,
    annotationSelector,
    buildMessageStyleCss,
    canStyle,
    channelSelector,
    colorValue,
    playerCss,
} from '../../src/domain/message-style-css';
import type { CssOptions } from '../../src/domain/message-style-css';

function rule(id: string, kind: MatchKind, extra: Partial<StyleRule> = {}): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(), ...extra };
}

const OPTIONS: CssOptions = { pageClass: 'ms', previewClass: 'pv', annotated: true };
const NO_PLAYER: PlayerStyle = { ...defaultPlayerStyle(), enabled: false };
const CHAR = 'html.ms #chat .mes:not([is_user="true"]) .mes_text';
const USER = 'html.ms #chat .mes[is_user="true"] .mes_text';

const css = (rules: StyleRule[], options: Partial<CssOptions> = {}) =>
    buildMessageStyleCss(rules, NO_PLAYER, { ...OPTIONS, ...options });

/** Declarations of the last block (the one that wins) whose selector list contains `selector`. */
function declarations(sheet: string, selector: string): string[] {
    const blocks = sheet.replace('/* Maestro M32m: message style */\n', '').split('}\n');
    const found = [...blocks].reverse().find((block) =>
        block
            .split('{')[0]!
            .split(',\n')
            .map((item) => item.trim())
            .includes(selector),
    );
    return found
        ? found
              .split('{')[1]!
              .split(';')
              .map((item) => item.trim())
              .filter(Boolean)
        : [];
}

describe('values', () => {
    it('maps colour tokens and hex colours', () => {
        expect(colorValue('accent')).toBe(ACCENT_COLOR);
        expect(colorValue('#ABC')).toBe('#abc');
        expect(colorValue('nope')).toBe(TEXT_COLOR);
        expect(COLOR_VALUES.muted).toContain('--maestro-text-muted');
        expect(COLOR_VALUES.muted).toContain('--SmartThemeEmColor');
        expect(FONT_STACKS.serif).toContain('serif');
    });

    it('matches both spellings of an annotation class', () => {
        expect(annotationSelector('dash')).toBe(':is(.maestro-ms-dash, .custom-maestro-ms-dash)');
    });

    it('knows where each kind shows up, and what needs the hook', () => {
        expect(channelSelector(rule('n', 'narration'), true)).toBe('');
        expect(channelSelector(rule('q', 'doubleQuotes'), false)).toBe('q');
        expect(channelSelector(rule('q', 'doubleQuotes'), true)).toBe(`q${annotationSelector('dq')}`);
        expect(channelSelector(rule('g', 'guillemets'), true)).toBe(`q${annotationSelector('gq')}`);
        expect(channelSelector(rule('a', 'asterisk'), false)).toBe(':is(em, i)');
        expect(channelSelector(rule('u', 'underscore'), false)).toBe(':is(em, i)');
        expect(channelSelector(rule('s', 'doubleAsterisk'), false)).toBe(':is(strong, b)');
        expect(channelSelector(rule('b', 'backticks'), false)).toBe(':not(pre) > code');
        expect(channelSelector(rule('p', 'parentheses'), true)).toBe(annotationSelector('paren'));
        expect(channelSelector(rule('k', 'brackets'), true)).toBe(annotationSelector('bracket'));
        expect(channelSelector(rule('c9', 'custom'), true)).toBe(annotationSelector('c-c9'));
        for (const kind of ['guillemets', 'dashDialogue', 'parentheses', 'brackets', 'custom'] as const) {
            expect(canStyle(rule('x', kind), false)).toBe(false);
            expect(canStyle(rule('x', kind), true)).toBe(true);
        }
    });
});

describe('rules', () => {
    it('gates every selector by the page class and covers the preview boxes', () => {
        const sheet = css([rule('q', 'doubleQuotes', { style: makeStyle({ color: 'accent' }) })]);
        expect(sheet.startsWith('/* Maestro M32m')).toBe(true);
        for (const line of sheet.split('\n')) {
            if (line.includes('{') || line.endsWith(',')) expect(line.startsWith('html.ms')).toBe(true);
        }
        expect(sheet).toContain('html.ms .pv[data-ms-scope="char"] .pv-text q');
        expect(sheet).toContain('html.ms .pv[data-ms-scope="user"] .pv-text q');
        expect(declarations(sheet, `${CHAR} q${annotationSelector('dq')}`)).toEqual([`color: ${ACCENT_COLOR}`]);
    });

    it('writes every style property', () => {
        const style = makeStyle({
            color: '#123456',
            italic: true,
            bold: false,
            underline: true,
            opacity: 0.5,
            spacing: true,
            font: 'mono',
            highlight: true,
            bar: true,
        });
        const sheet = css([rule('p', 'parentheses', { style })]);
        expect(declarations(sheet, `${CHAR} ${annotationSelector('paren')}`)).toEqual([
            'color: color-mix(in srgb, #123456 50%, transparent)',
            'font-style: italic',
            'font-weight: normal',
            'text-decoration-line: underline',
            'text-underline-offset: 0.18em',
            'letter-spacing: 0.03em',
            `font-family: ${FONT_STACKS.mono}`,
            'padding-left: 0.35em',
            'background-color: var(--maestro-accent-soft, color-mix(in srgb, var(--SmartThemeQuoteColor) 18%, transparent))',
            'border-radius: 0.25em',
            'box-shadow: inset 0.16em 0 0 color-mix(in srgb, #123456 60%, transparent), 0 0 0 0.12em var(--maestro-accent-soft, color-mix(in srgb, var(--SmartThemeQuoteColor) 18%, transparent))',
            '-webkit-box-decoration-break: clone',
            'box-decoration-break: clone',
        ]);
    });

    it('keeps ST’s own colour under opacity alone', () => {
        const sheet = css([
            rule('q', 'doubleQuotes', { style: makeStyle({ opacity: 0.6 }) }),
            rule('s', 'doubleAsterisk', { style: makeStyle({ opacity: 0.6 }) }),
        ]);
        expect(declarations(sheet, `${CHAR} q${annotationSelector('dq')}`)).toEqual([
            'color: color-mix(in srgb, var(--SmartThemeQuoteColor) 60%, transparent)',
        ]);
        expect(declarations(sheet, `${CHAR} :is(strong, b)`)).toEqual([
            'color: color-mix(in srgb, currentColor 60%, transparent)',
        ]);
    });

    it('styles narration on the text and resets it on parts other rules own', () => {
        const sheet = css([
            rule('n', 'narration', {
                style: makeStyle({ italic: true, bold: true, color: 'muted', spacing: true, font: 'serif' }),
            }),
            rule('q', 'doubleQuotes', { style: makeStyle({ bold: true }) }),
            rule('a', 'asterisk'),
            rule('s', 'doubleAsterisk'),
        ]);
        expect(declarations(sheet, CHAR)).toEqual([
            `color: ${COLOR_VALUES.muted}`,
            'font-style: italic',
            'font-weight: bold',
            `letter-spacing: 0.03em`,
            `font-family: ${FONT_STACKS.serif}`,
        ]);
        expect(declarations(sheet, `${CHAR} q${annotationSelector('dq')}`)).toEqual([
            'color: var(--SmartThemeQuoteColor)',
            'font-style: normal',
            'font-weight: bold',
        ]);
        expect(declarations(sheet, `${CHAR} :is(em, i)`)).toEqual([
            'color: var(--SmartThemeEmColor)',
            'font-weight: normal',
        ]);
        expect(declarations(sheet, `${CHAR} :is(strong, b)`)).toEqual([`color: ${TEXT_COLOR}`, 'font-style: normal']);
        expect(declarations(sheet, `${CHAR} :where(pre, code, [data-naist-img])`)).toEqual([
            'font-style: normal',
            'font-weight: normal',
            'letter-spacing: normal',
        ]);
        // Narration upright and regular by choice, without colour.
        const plain = css([rule('n', 'narration', { style: makeStyle({ italic: false, bold: false, opacity: 0.8 }) })]);
        expect(declarations(plain, CHAR)).toEqual([
            `color: color-mix(in srgb, ${TEXT_COLOR} 80%, transparent)`,
            'font-style: normal',
            'font-weight: normal',
        ]);
    });

    it('leaves the speaker colour of <font color> lines alone and keeps the rule otherwise', () => {
        const sheet = css([rule('speech', 'doubleQuotes', { style: makeStyle({ color: 'quote', bold: true }) })]);
        const dialogue = `:is(q, ${annotationSelector('dash')})`;
        expect(declarations(sheet, `${CHAR} :is(font[color], [style*="color"]) ${dialogue}`)).toEqual([
            'color: inherit',
        ]);
        // Without a colour the rule needs no exception.
        expect(css([rule('speech', 'doubleQuotes', { style: makeStyle({ bold: true }) })])).not.toContain(
            'font[color]',
        );
    });

    it('lets the higher rule win: lower rules are written first', () => {
        const sheet = css([
            rule('top', 'doubleQuotes', { style: makeStyle({ color: 'accent' }) }),
            rule('low', 'doubleQuotes', { style: makeStyle({ color: 'muted' }) }),
        ]);
        expect(sheet.indexOf(COLOR_VALUES.muted)).toBeLessThan(sheet.indexOf(ACCENT_COLOR));
    });

    it('splits rules by scope', () => {
        const sheet = css([
            rule('u', 'doubleQuotes', { applyTo: 'user', style: makeStyle({ color: 'accent' }) }),
            rule('c', 'doubleQuotes', { applyTo: 'char', style: makeStyle({ color: 'text' }) }),
        ]);
        expect(declarations(sheet, `${USER} q${annotationSelector('dq')}`)).toEqual([`color: ${ACCENT_COLOR}`]);
        expect(declarations(sheet, `${CHAR} q${annotationSelector('dq')}`)).toEqual([`color: ${TEXT_COLOR}`]);
    });

    it('swaps quote marks with pseudo-elements and hides the original ones', () => {
        const sheet = css([
            rule('q', 'doubleQuotes', { style: makeStyle({ marks: 'curly' }) }),
            rule('q2', 'doubleQuotes', { style: makeStyle({ marks: 'keep' }) }),
            rule('g', 'guillemets', { style: makeStyle({ marks: 'straight' }) }),
            rule('d', 'dashDialogue', { style: makeStyle({ marks: 'none' }) }),
        ]);
        const dq = `${CHAR} q${annotationSelector('dq')}`;
        const mark = annotationSelector('mark');
        expect(declarations(sheet, `${dq} > ${mark}`)).toEqual(['display: none']);
        expect(declarations(sheet, `${dq}::before`)).toEqual(['content: "\\201C"']);
        expect(declarations(sheet, `${dq}::after`)).toEqual(['content: "\\201D"']);
        expect(sheet.indexOf('display: inline')).toBeLessThan(sheet.indexOf('display: none'));
        expect(declarations(sheet, `${CHAR} q${annotationSelector('gq')}::before`)).toEqual(['content: "\\22"']);
        const dash = `${CHAR} ${annotationSelector('dash')}`;
        expect(declarations(sheet, `${dash} > ${mark}`)).toEqual(['display: none']);
        expect(declarations(sheet, `${dash}::before`)).toEqual([]);
        // Without the hook the marks cannot be swapped.
        expect(
            css([rule('q', 'doubleQuotes', { style: makeStyle({ marks: 'curly' }) })], { annotated: false }),
        ).not.toContain('::before');
    });

    it('keeps emphasis inside dialogue in the dialogue colour, like ST', () => {
        const sheet = css([
            rule('a', 'asterisk', { style: makeStyle({ color: 'accent' }) }),
            rule('s', 'doubleAsterisk', { style: makeStyle({ opacity: 0.5 }) }),
        ]);
        expect(declarations(sheet, `${CHAR} :is(q, ${annotationSelector('dash')}) :is(em, i)`)).toEqual([
            'color: inherit',
        ]);
        expect(declarations(sheet, `${CHAR} :is(q, ${annotationSelector('dash')}) :is(strong, b)`)).toEqual([
            'color: inherit',
        ]);
        const plain = css([rule('a', 'asterisk', { style: makeStyle({ color: 'accent' }) })], { annotated: false });
        expect(declarations(plain, `${CHAR} q :is(em, i)`)).toEqual(['color: inherit']);
    });

    it('leaves out rules that cannot be drawn and empty rules', () => {
        expect(css([rule('d', 'dashDialogue', { style: makeStyle({ color: 'accent' }) })], { annotated: false })).toBe(
            '/* Maestro M32m: message style */\n',
        );
        expect(css([rule('a', 'asterisk')])).toBe('/* Maestro M32m: message style */\n');
        expect(css([])).toBe('/* Maestro M32m: message style */\n');
    });

    it('builds a stylesheet for every preset', () => {
        for (const id of PRESET_IDS) {
            const sheet = buildMessageStyleCss(presetRules(id), defaultPlayerStyle(), OPTIONS);
            expect(sheet).toContain('html.ms #chat .mes[is_user="true"]');
            expect(sheet.split('{').length).toBe(sheet.split('}').length);
        }
        expect(buildMessageStyleCss(presetRules('book'), NO_PLAYER, OPTIONS)).toContain(annotationSelector('gq'));
        expect(buildMessageStyleCss(presetRules('speech'), NO_PLAYER, OPTIONS)).toContain(
            `color-mix(in srgb, ${TEXT_COLOR} 80%, transparent)`,
        );
        expect(buildMessageStyleCss(presetRules('thoughts'), NO_PLAYER, OPTIONS)).toContain('inset 0.16em 0 0');
        expect(buildMessageStyleCss(presetRules('guillemets'), NO_PLAYER, OPTIONS)).toContain('content: "\\AB"');
        expect(buildMessageStyleCss(presetRules('novel'), NO_PLAYER, OPTIONS)).toContain('content: "\\201C"');
        expect(buildMessageStyleCss(presetRules('screenplay'), NO_PLAYER, OPTIONS)).toContain('font-style: italic');
        expect(buildMessageStyleCss(presetRules('player'), NO_PLAYER, OPTIONS)).toContain(USER);
        expect(buildMessageStyleCss(presetRules('minimal'), NO_PLAYER, OPTIONS)).toBe(
            '/* Maestro M32m: message style */\n',
        );
    });
});

describe('the player’s messages', () => {
    const user = 'html.ms #chat .mes[is_user="true"]';
    const preview = 'html.ms .pv[data-ms-scope="user"]';

    it('draws a bar, keeps the theme’s bubble shadow, colours the name', () => {
        const sheet = playerCss(defaultPlayerStyle(), { ...OPTIONS, themeClasses: { layer: 'mt', chat: 'mtc' } });
        expect(declarations(sheet, user)).toEqual([
            `box-shadow: inset 3px 0 0 color-mix(in srgb, ${ACCENT_COLOR} 75%, transparent)`,
        ]);
        expect(declarations(sheet, preview)).toHaveLength(1);
        expect(declarations(sheet, 'html.ms.mt.mtc body.bubblechat #chat .mes[is_user="true"]')[0]).toContain(
            'var(--maestro-elevation-1, 0 0 #0000)',
        );
        expect(declarations(sheet, `${user} .name_text`)).toEqual([`color: ${ACCENT_COLOR}`]);
        expect(declarations(sheet, `${preview} .pv-name`)).toEqual([`color: ${ACCENT_COLOR}`]);
    });

    it('draws a tint, both, nothing; shifts bubbles', () => {
        const tint = playerCss({ ...defaultPlayerStyle(), mark: 'tint', name: false, color: '#ff0000' }, OPTIONS);
        expect(tint).toContain('linear-gradient(90deg, color-mix(in srgb, #ff0000 12%, transparent)');
        expect(tint).not.toContain('box-shadow');
        expect(tint).not.toContain('name_text');
        const both = playerCss({ ...defaultPlayerStyle(), mark: 'both' }, OPTIONS);
        expect(both).toContain('box-shadow');
        expect(both).toContain('linear-gradient');
        expect(both).not.toContain('bubblechat');
        const indent = playerCss({ ...defaultPlayerStyle(), mark: 'none', name: false, align: 'indent' }, OPTIONS);
        expect(declarations(indent, 'html.ms body.bubblechat #chat .mes[is_user="true"]')).toEqual([
            'width: auto',
            'margin-left: clamp(16px, 12%, 120px)',
        ]);
        expect(playerCss(NO_PLAYER, OPTIONS)).toBe('');
    });
});
