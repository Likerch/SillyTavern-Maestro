import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TOKEN_OPTIONS,
    alphaForContrast,
    chatWidth,
    clamp,
    clampRadiusScale,
    contrast,
    cssSafe,
    deriveTokens,
    ensureContrast,
    fontFamilies,
    fontStack,
    formatColor,
    isDark,
    luminance,
    mix,
    opaque,
    over,
    parseColor,
    parseNumber,
    readableOn,
    tokensCss,
    withAlpha,
} from '../../src/domain/theme-tokens';
import type { Rgba, ThemeInput } from '../../src/domain/theme-tokens';

const rgba = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const close = (actual: Rgba | null, expected: Rgba, digits = 0) => {
    expect(actual).not.toBeNull();
    expect(actual!.r).toBeCloseTo(expected.r, digits);
    expect(actual!.g).toBeCloseTo(expected.g, digits);
    expect(actual!.b).toBeCloseTo(expected.b, digits);
    expect(actual!.a).toBeCloseTo(expected.a, 2);
};
const rgbaOf = (text: string | undefined) => parseColor(text) as Rgba;

describe('parseColor', () => {
    it('reads rgb()/rgba() in comma and space syntax, percentages and slash alpha', () => {
        expect(parseColor('rgba(23, 23, 23, 0.9)')).toEqual(rgba(23, 23, 23, 0.9));
        expect(parseColor('rgb(220, 220, 210)')).toEqual(rgba(220, 220, 210));
        expect(parseColor('  RGB(1 2 3 / 50%) ')).toEqual(rgba(1, 2, 3, 0.5));
        expect(parseColor('rgb(100%, 0%, 50%)')).toEqual(rgba(255, 0, 127.5));
        expect(parseColor('rgba(300, -5, 10, 2)')).toEqual(rgba(255, 0, 10, 1));
        expect(parseColor('rgb(none 0 0)')).toEqual(rgba(0, 0, 0));
    });

    it('reads hex in 3, 4, 6 and 8 digits', () => {
        expect(parseColor('#fff')).toEqual(rgba(255, 255, 255));
        expect(parseColor('#0008')).toEqual(rgba(0, 0, 0, 0.533));
        expect(parseColor('#E18A24')).toEqual(rgba(225, 138, 36));
        expect(parseColor('#e18a2480')).toEqual(rgba(225, 138, 36, 0.502));
    });

    it('reads hsl()/hsla() with units and plain numbers', () => {
        close(parseColor('hsl(0, 100%, 50%)'), rgba(255, 0, 0));
        close(parseColor('hsla(120deg 100% 25% / 0.5)'), rgba(0, 127.5, 0, 0.5));
        close(parseColor('hsl(0.5turn 100 50)'), rgba(0, 255, 255));
        close(parseColor('hsl(3.14159rad, 100%, 50%)'), rgba(0, 255, 255));
        close(parseColor('hsl(400grad, 0%, 100%)'), rgba(255, 255, 255));
        close(parseColor('hsl(-120, 100%, 50%)'), rgba(0, 0, 255));
        close(parseColor('hsl(none 0% 0%)'), rgba(0, 0, 0));
    });

    it('knows a few names', () => {
        expect(parseColor('transparent')).toEqual(rgba(0, 0, 0, 0));
        expect(parseColor('White')).toEqual(rgba(255, 255, 255));
        const black = parseColor('black')!;
        black.r = 99;
        expect(parseColor('black')).toEqual(rgba(0, 0, 0));
    });

    it('returns null for anything it does not understand', () => {
        for (const text of [
            undefined,
            null,
            '',
            '   ',
            'var(--x)',
            'color-mix(in srgb, red, blue)',
            'oklch(0.5 0.1 30)',
            '#ggg',
            '#12345',
            'rgb()',
            'rgb(1, 2)',
            'rgb(1, 2, 3, 4, 5)',
            'rgb(1 2 / 3 / 4)',
            'rgb(1 2 3 4 / 0.5)',
            'rgb(1 2 3 / )',
            'rgb(a, b, c)',
            'rgba(1, 2, 3, x)',
            'hsl(red, 1%, 1%)',
            'hsl(1, x, 1%)',
            'hsl(1, 1%, 1%, x)',
            'toString',
        ]) {
            expect(parseColor(text)).toBeNull();
        }
    });
});

describe('colour maths', () => {
    it('formats with rounding, rgb() when opaque', () => {
        expect(formatColor(rgba(10.4, 20.6, 300, 1))).toBe('rgb(10, 21, 255)');
        expect(formatColor(rgba(1, 2, 3, 0.12345))).toBe('rgba(1, 2, 3, 0.123)');
        expect(formatColor(rgba(-4, 2, 3, 0))).toBe('rgba(0, 2, 3, 0)');
    });

    it('changes alpha, drops alpha and clamps', () => {
        expect(withAlpha(rgba(1, 2, 3), 2)).toEqual(rgba(1, 2, 3, 1));
        expect(withAlpha(rgba(1, 2, 3), -1)).toEqual(rgba(1, 2, 3, 0));
        expect(opaque(rgba(1, 2, 3, 0.2))).toEqual(rgba(1, 2, 3, 1));
        expect(clamp(5, 0, 1)).toBe(1);
    });

    it('mixes premultiplied, so transparent fades instead of darkening', () => {
        expect(mix(rgba(255, 255, 255), rgba(0, 0, 0), 0.5)).toEqual(rgba(127.5, 127.5, 127.5));
        expect(mix(rgba(200, 100, 0), rgba(0, 0, 0, 0), 0.18)).toEqual(rgba(200, 100, 0, 0.18));
        expect(mix(rgba(1, 1, 1, 0), rgba(2, 2, 2, 0), 0.5)).toEqual(rgba(0, 0, 0, 0));
        expect(mix(rgba(255, 0, 0), rgba(0, 0, 255), 2)).toEqual(rgba(255, 0, 0));
    });

    it('composites source-over', () => {
        close(over(rgba(255, 255, 255, 0.5), rgba(0, 0, 0)), rgba(127.5, 127.5, 127.5));
        close(over(rgba(10, 20, 30), rgba(0, 0, 0)), rgba(10, 20, 30));
        expect(over(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))).toEqual(rgba(0, 0, 0, 0));
        close(over(rgba(255, 0, 0, 0.5), rgba(0, 0, 255, 0.5)), rgba(170, 0, 85, 0.75));
    });

    it('computes WCAG luminance and contrast', () => {
        expect(luminance(rgba(0, 0, 0))).toBe(0);
        expect(luminance(rgba(255, 255, 255))).toBeCloseTo(1, 5);
        expect(luminance(rgba(2, 2, 2))).toBeCloseTo(0.0006, 4);
        expect(contrast(rgba(255, 255, 255), rgba(0, 0, 0))).toBeCloseTo(21, 5);
        expect(contrast(rgba(0, 0, 0), rgba(255, 255, 255))).toBeCloseTo(21, 5);
        expect(contrast(rgba(10, 10, 10), rgba(10, 10, 10))).toBe(1);
        // A translucent foreground is composited over the background first.
        expect(contrast(rgba(255, 255, 255, 0), rgba(0, 0, 0))).toBe(1);
        expect(contrast(rgba(255, 255, 255, 0.5), rgba(0, 0, 0))).toBeCloseTo(5.28, 1);
    });

    it('tells dark from light and picks readable text', () => {
        expect(isDark(rgba(23, 23, 23))).toBe(true);
        expect(isDark(rgba(240, 240, 235))).toBe(false);
        expect(readableOn(rgba(23, 23, 23))).toEqual(rgba(255, 255, 255));
        expect(readableOn(rgba(250, 250, 250, 0.1))).toEqual(rgba(0, 0, 0));
    });

    it('ensures contrast by moving toward a colour, then toward black/white', () => {
        const bg = rgba(23, 23, 23);
        const good = rgba(225, 138, 36);
        expect(ensureContrast(good, bg, 3, rgba(220, 220, 210))).toBe(good);

        const dim = rgba(40, 40, 60);
        const fixed = ensureContrast(dim, bg, 3, rgba(220, 220, 210));
        expect(contrast(fixed, bg)).toBeGreaterThanOrEqual(3);
        expect(contrast(fixed, bg)).toBeLessThan(4);

        // Moving toward a useless target (the background itself) falls back to white on a dark background.
        const viaWhite = ensureContrast(dim, bg, 3, bg);
        expect(contrast(viaWhite, bg)).toBeGreaterThanOrEqual(3);

        // Impossible: the best effort is returned.
        const mid = rgba(119, 119, 119);
        const best = ensureContrast(mid, mid, 30, mid);
        expect(contrast(best, mid)).toBeGreaterThan(4);
    });

    it('finds the smallest alpha for a contrast, capped', () => {
        const bg = rgba(23, 23, 23);
        const line = alphaForContrast(rgba(220, 220, 210), bg, 1.3, 0.12, 0.4);
        expect(line.a).toBeGreaterThanOrEqual(0.12);
        expect(contrast(line, bg)).toBeGreaterThanOrEqual(1.3);
        expect(contrast(withAlpha(line, line.a - 0.02), bg)).toBeLessThan(1.3);
        expect(alphaForContrast(rgba(30, 30, 30), bg, 10, 0.1, 0.3).a).toBe(0.3);
    });
});

describe('numbers, fonts, widths', () => {
    it('parses the first number of a CSS value', () => {
        expect(parseNumber('1.2', 1)).toBe(1.2);
        expect(parseNumber('calc(10 * 1px)', 0)).toBe(10);
        expect(parseNumber(' 13px', 0)).toBe(13);
        expect(parseNumber('.5', 0)).toBe(0.5);
        expect(parseNumber('-3', 0)).toBe(-3);
        expect(parseNumber('auto', 7)).toBe(7);
        expect(parseNumber(undefined, 7)).toBe(7);
        expect(parseNumber('1e999', 7)).toBe(7);
    });

    it('splits and stacks fonts, keeping the user font first and the generic family last', () => {
        expect(fontFamilies('"Noto Sans", sans-serif')).toEqual(['"Noto Sans"', 'sans-serif']);
        expect(fontFamilies("'A, B', C")).toEqual(["'A, B'", 'C']);
        expect(fontStack('"Noto Sans", sans-serif', ['system-ui', '"Noto Sans"', 'sans-serif'])).toBe(
            '"Noto Sans", system-ui, sans-serif',
        );
        expect(fontStack('Comic Sans MS', ['Arial', 'sans-serif'])).toBe('Comic Sans MS, Arial, sans-serif');
        expect(fontStack(undefined, ['Arial', 'serif'])).toBe('Arial, serif');
        expect(fontStack('X', [])).toBe('X');
        expect(fontStack('Evil; } body { color: red', ['serif'])).toBe('Evil  body  color: red, serif');
    });

    it('cleans values that would break generated CSS', () => {
        expect(cssSafe(' a;b{c}<d>\\e ')).toBe('abcde');
    });

    it('keeps plain chat widths and replaces anything else', () => {
        expect(chatWidth('55vw')).toBe('55vw');
        expect(chatWidth(' 800px ')).toBe('800px');
        expect(chatWidth('62.5%')).toBe('62.5%');
        expect(chatWidth('calc(50vw + 1px)')).toBe('50vw');
        expect(chatWidth(undefined)).toBe('50vw');
    });

    it('clamps the radius scale', () => {
        expect(clampRadiusScale(1.5)).toBe(1.5);
        expect(clampRadiusScale(9)).toBe(2);
        expect(clampRadiusScale(-1)).toBe(0);
        expect(clampRadiusScale('2')).toBe(1);
        expect(clampRadiusScale(Number.NaN)).toBe(1);
    });
});

describe('deriveTokens', () => {
    const defaults = deriveTokens({});

    it('reproduces Maestro’s own UI values for ST’s default theme', () => {
        expect(defaults['--maestro-text']).toBe('rgb(220, 220, 210)');
        expect(defaults['--maestro-accent']).toBe('rgb(225, 138, 36)');
        expect(defaults['--maestro-accent-soft']).toBe('rgba(225, 138, 36, 0.18)');
        expect(defaults['--maestro-border']).toBe('rgba(0, 0, 0, 0.5)');
        expect(defaults['--maestro-shadow']).toBe('rgba(0, 0, 0, 0.5)');
        expect(defaults['--maestro-surface-1']).toBe('rgb(23, 23, 23)');
        expect(defaults['--maestro-surface-2']).toBe('rgba(220, 220, 210, 0.06)');
        expect(defaults['--maestro-surface-3']).toBe('rgba(220, 220, 210, 0.12)');
        expect(defaults['--maestro-radius']).toBe('10px');
        expect(defaults['--maestro-radius-sm']).toBe('6px');
        expect(defaults['--maestro-gap']).toBe('12px');
        expect(defaults['--maestro-gap-sm']).toBe('6px');
        expect(defaults['--maestro-font-size']).toBe('15px');
        expect(defaults['--maestro-blur']).toBe('10px');
        expect(defaults['--maestro-chat-width']).toBe('50vw');
        expect(defaults['--maestro-well']).toBe('rgba(0, 0, 0, 0.3)');
        expect(defaults['--maestro-on-accent']).toBe('rgb(0, 0, 0)');
        expect(defaults['--maestro-control-py']).toBe('3px');
        expect(defaults['--maestro-control-px']).toBe('5px');
        expect(defaults['--maestro-mes-pad']).toBe('10px');
        expect(defaults['--maestro-font-chat']).toBe('"Noto Sans", sans-serif');
        expect(defaults['--maestro-font-ui']).toMatch(/^"Noto Sans", system-ui, .*sans-serif$/);
        expect(defaults['--maestro-font-mono']).toContain('Noto Sans Mono');
    });

    it('keeps muted text and dividers readable on the surface', () => {
        const base = rgba(23, 23, 23);
        expect(contrast(rgbaOf(defaults['--maestro-text-muted']), base)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(rgbaOf(defaults['--maestro-text-muted']), base)).toBeLessThan(
            contrast(rgba(220, 220, 210), base),
        );
        expect(contrast(rgbaOf(defaults['--maestro-divider']), base)).toBeGreaterThanOrEqual(1.3);
    });

    it('derives from a translucent theme (Azure) with the panel composited on a dark backdrop', () => {
        const azure: ThemeInput = {
            body: 'rgba(171, 198, 223, 1)',
            quote: 'rgba(111, 133, 253, 1)',
            blurTint: 'rgba(23, 30, 33, 0.61)',
            shadow: 'rgba(0, 0, 0, 1)',
            border: 'rgba(0, 0, 0, 0.5)',
            blurStrength: '11',
            shadowWidth: '5',
            fontScale: '1',
            chatWidth: '50vw',
        };
        const tokens = deriveTokens(azure);
        expect(tokens['--maestro-surface-1']).toBe('rgba(23, 30, 33, 0.61)');
        expect(tokens['--maestro-surface-solid']).toBe('rgb(14, 18, 20)');
        expect(tokens['--maestro-accent']).toBe('rgb(111, 133, 253)');
        expect(tokens['--maestro-blur']).toBe('11px');
        expect(tokens['--maestro-elevation-1']).toBe('0 1px 7px rgba(0, 0, 0, 0.6)');
        expect(tokens['--maestro-elevation-2']).toBe('0 9px 38px rgba(0, 0, 0, 0.85)');
    });

    it('nudges a low-contrast quote colour toward the text colour', () => {
        const tokens = deriveTokens({ quote: 'rgb(40, 40, 50)', blurTint: 'rgb(23, 23, 23)' });
        const accent = rgbaOf(tokens['--maestro-accent']);
        expect(contrast(accent, rgba(23, 23, 23))).toBeGreaterThanOrEqual(3);
        expect(tokens['--maestro-focus']).toBe(tokens['--maestro-accent']);
    });

    it('handles light themes', () => {
        const tokens = deriveTokens({
            body: 'rgb(30, 30, 30)',
            quote: '#b05a00',
            blurTint: 'rgba(245, 245, 240, 0.9)',
        });
        expect(tokens['--maestro-surface-solid']).toBe('rgb(246, 246, 242)');
        expect(tokens['--maestro-well']).toBe('rgba(0, 0, 0, 0.06)');
        expect(tokens['--maestro-on-accent']).toBe('rgb(255, 255, 255)');
        expect(contrast(rgbaOf(tokens['--maestro-text-muted']), rgba(246, 246, 242))).toBeGreaterThanOrEqual(4.5);
    });

    it('follows ST’s blur, shadows, font scale and chat width', () => {
        expect(deriveTokens({ noBlur: true })['--maestro-blur']).toBe('0px');
        expect(deriveTokens({ blurStrength: 'calc(99 * 1px)' })['--maestro-blur']).toBe('60px');
        const flat = deriveTokens({ noShadows: true });
        expect(flat['--maestro-elevation-1']).toBe('none');
        expect(flat['--maestro-elevation-2']).toBe('none');
        const big = deriveTokens({ fontScale: '1.2', chatWidth: '70vw' });
        expect(big['--maestro-font-size']).toBe('18px');
        expect(big['--maestro-space-2']).toBe('10px');
        expect(big['--maestro-chat-width']).toBe('70vw');
        const huge = deriveTokens({ fontScale: '5' });
        expect(huge['--maestro-font-size']).toBe('30px');
        expect(huge['--maestro-space-3']).toBe('17px');
    });

    it('applies density and the radius scale', () => {
        const compact = deriveTokens({}, { density: 'compact', radiusScale: 1 });
        expect(compact['--maestro-space-1']).toBe('3px');
        expect(compact['--maestro-space-4']).toBe('12px');
        expect(compact['--maestro-gap']).toBe('9px');
        expect(compact['--maestro-control-py']).toBe('2px');
        expect(compact['--maestro-mes-pad']).toBe('6px');
        expect(compact['--maestro-touch']).toBe('34px');
        const square = deriveTokens({}, { density: 'comfortable', radiusScale: 0 });
        expect(square['--maestro-radius-md']).toBe('0px');
        expect(square['--maestro-radius-pill']).toBe('0px');
        const round = deriveTokens({}, { density: 'comfortable', radiusScale: 1.5 });
        expect(round['--maestro-radius-lg']).toBe('21px');
        expect(round['--maestro-radius-xs']).toBe('4.5px');
        expect(round['--maestro-radius-pill']).toBe('999px');
        expect(deriveTokens({}, DEFAULT_TOKEN_OPTIONS)).toEqual(defaults);
    });

    it('falls back to ST defaults for unreadable values and sanitises fonts', () => {
        const tokens = deriveTokens({
            body: 'var(--nope)',
            quote: 'nonsense',
            blurTint: '',
            shadow: 'oklch(1 0 0)',
            border: 'color-mix(in srgb, red, blue)',
            fontScale: 'auto',
            mainFont: '"Inter"; } html { display: none',
            monoFont: '   ',
        });
        expect(tokens['--maestro-text']).toBe(defaults['--maestro-text']);
        expect(tokens['--maestro-accent']).toBe(defaults['--maestro-accent']);
        expect(tokens['--maestro-border']).toBe(defaults['--maestro-border']);
        expect(tokens['--maestro-font-size']).toBe('15px');
        expect(tokens['--maestro-font-chat']).not.toMatch(/[;{}]/);
        expect(tokens['--maestro-font-mono']).toBe(defaults['--maestro-font-mono']);
    });
});

describe('tokensCss', () => {
    it('writes one declaration per token under the selector', () => {
        expect(tokensCss('html.x', { '--a': '1px', '--b': 'red' })).toBe('html.x {\n    --a: 1px;\n    --b: red;\n}\n');
    });
});
