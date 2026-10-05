// Design tokens of the unified look (M32, stage 12): pure derivation of Maestro's `--maestro-*` CSS variables from
// SillyTavern's theme (SmartTheme colours, blur strength, shadow width, font scale, chat width, fonts) plus the
// layer's own choices (density, radius scale). ST hands colours over as computed CSS strings (`rgba(23, 23, 23, 0.9)`,
// `#e18a24`, whatever a custom CSS put there); unknown syntaxes fall back to ST's defaults instead of breaking.
// The token list and meanings are documented in src/features/theme/tokens.ts.

export interface Rgba {
    /** 0–255 */
    r: number;
    g: number;
    b: number;
    /** 0–1 */
    a: number;
}

export type Density = 'comfortable' | 'compact';

export interface TokenOptions {
    density: Density;
    /** Multiplies every radius: 0 = square corners, 1 = Maestro's default, 2 = very round. */
    radiusScale: number;
}

/** ST's theme as read from the page (computed custom properties and body classes). Missing = ST default. */
export interface ThemeInput {
    /** --SmartThemeBodyColor */
    body?: string;
    /** --SmartThemeQuoteColor */
    quote?: string;
    /** --SmartThemeBlurTintColor (panels, drawers, popups) */
    blurTint?: string;
    /** --SmartThemeShadowColor */
    shadow?: string;
    /** --SmartThemeBorderColor */
    border?: string;
    /** --blurStrength (a number, px) */
    blurStrength?: string;
    /** --shadowWidth (a number, px) */
    shadowWidth?: string;
    /** --fontScale */
    fontScale?: string;
    /** --sheldWidth (`50vw`) */
    chatWidth?: string;
    /** --mainFontFamily */
    mainFont?: string;
    /** --monoFontFamily */
    monoFont?: string;
    /** body.no-blur («Отключить размытие» in ST) */
    noBlur?: boolean;
    /** body.noShadows */
    noShadows?: boolean;
}

/** ST 1.19 defaults (public/style.css :root). */
export const ST_THEME_DEFAULTS = {
    body: 'rgb(220, 220, 210)',
    quote: 'rgb(225, 138, 36)',
    blurTint: 'rgba(23, 23, 23, 1)',
    shadow: 'rgba(0, 0, 0, 0.5)',
    border: 'rgba(0, 0, 0, 0.5)',
    blurStrength: 10,
    shadowWidth: 2,
    fontScale: 1,
    chatWidth: '50vw',
    mainFont: '"Noto Sans", sans-serif',
    monoFont: "'Noto Sans Mono', 'Courier New', Consolas, monospace",
} as const;

export const RADIUS_SCALE_MIN = 0;
export const RADIUS_SCALE_MAX = 2;
export const DEFAULT_TOKEN_OPTIONS: TokenOptions = { density: 'comfortable', radiusScale: 1 };

/** Base font size of ST (`--mainFontSize: calc(var(--fontScale) * 15px)`). */
const BASE_FONT_PX = 15;
/** Fallback chain appended after the user's UI font (Cyrillic-capable system fonts first). */
const UI_FONT_FALLBACK = ['system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Noto Sans"', 'Arial', 'sans-serif'];
const GENERIC_FAMILIES = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
    'math',
    'emoji',
    'fangsong',
]);

const NAMED: Record<string, Rgba> = {
    transparent: { r: 0, g: 0, b: 0, a: 0 },
    black: { r: 0, g: 0, b: 0, a: 1 },
    white: { r: 255, g: 255, b: 255, a: 1 },
    gray: { r: 128, g: 128, b: 128, a: 1 },
    grey: { r: 128, g: 128, b: 128, a: 1 },
    silver: { r: 192, g: 192, b: 192, a: 1 },
    red: { r: 255, g: 0, b: 0, a: 1 },
    orange: { r: 255, g: 165, b: 0, a: 1 },
    gold: { r: 255, g: 215, b: 0, a: 1 },
    yellow: { r: 255, g: 255, b: 0, a: 1 },
    green: { r: 0, g: 128, b: 0, a: 1 },
    blue: { r: 0, g: 0, b: 255, a: 1 },
    purple: { r: 128, g: 0, b: 128, a: 1 },
};

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/* ------------------------------------------------------------------ numbers */

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

const round = (value: number, digits = 0): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

/** First number in a CSS value: `1.2`, `10px`, `calc(10 * 1px)` → 10; anything else → fallback. */
export function parseNumber(text: string | undefined | null, fallback: number): number {
    if (typeof text !== 'string') return fallback;
    const match = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text);
    if (!match) return fallback;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : fallback;
}

/* ------------------------------------------------------------------ colours */

/** Parses a CSS colour: hex (3/4/6/8), rgb()/rgba() (comma or space syntax, %, `/ alpha`), hsl()/hsla(), a few names. */
export function parseColor(text: string | undefined | null): Rgba | null {
    if (typeof text !== 'string') return null;
    const value = text.trim().toLowerCase();
    if (!value) return null;
    const named = Object.hasOwn(NAMED, value) ? NAMED[value] : undefined;
    if (named) return { ...named };
    if (value.startsWith('#')) return parseHex(value.slice(1));
    const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(value);
    if (!fn) return null;
    const args = splitArgs(fn[2] ?? '');
    if (!args) return null;
    return fn[1]?.startsWith('rgb') ? fromRgbArgs(args) : fromHslArgs(args);
}

function parseHex(hex: string): Rgba | null {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    let pairs: string[];
    if (hex.length === 3 || hex.length === 4) pairs = [...hex].map((digit) => digit + digit);
    else if (hex.length === 6 || hex.length === 8) pairs = hex.match(/../g) ?? [];
    else return null;
    const [r = 0, g = 0, b = 0, a] = pairs.map((pair) => parseInt(pair, 16));
    return { r, g, b, a: a === undefined ? 1 : round(a / 255, 3) };
}

type Args = [string, string, string, string | undefined];

/** `1, 2, 3, 0.5` or `1 2 3 / 50%` → ['1', '2', '3', '0.5'] (3 or 4 parts), else null. */
function splitArgs(body: string): Args | null {
    const [main = '', alpha, extra] = body.split('/');
    if (extra !== undefined) return null;
    const parts = main
        .split(/[\s,]+/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (alpha !== undefined) {
        if (parts.length !== 3 || !alpha.trim()) return null;
        parts.push(alpha.trim());
    }
    const [x, y, z, w] = parts;
    if (x === undefined || y === undefined || z === undefined || parts.length > 4) return null;
    return [x, y, z, w];
}

/** A channel/number token: `none` = 0, `50%` = fraction of `percentOf`, else a plain number. */
function token(part: string, percentOf: number): number | null {
    if (part === 'none') return 0;
    const percent = part.endsWith('%');
    const number = Number(percent ? part.slice(0, -1) : part);
    if (!Number.isFinite(number)) return null;
    return percent ? (number / 100) * percentOf : number;
}

function alphaOf(part: string | undefined): number | null {
    if (part === undefined) return 1;
    const value = token(part, 1);
    return value === null ? null : clamp(value, 0, 1);
}

function fromRgbArgs([x, y, z, w]: Args): Rgba | null {
    const r = token(x, 255);
    const g = token(y, 255);
    const b = token(z, 255);
    const a = alphaOf(w);
    if (r === null || g === null || b === null || a === null) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a };
}

const HUE_UNITS: Record<string, number> = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 };

function hue(part: string): number | null {
    if (part === 'none') return 0;
    const match = /^(-?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/.exec(part);
    if (!match) return null;
    const degrees = Number(match[1]) * (HUE_UNITS[match[2] ?? 'deg'] ?? 1);
    return ((degrees % 360) + 360) % 360;
}

function fromHslArgs([x, y, z, w]: Args): Rgba | null {
    const h = hue(x);
    const s = token(y, 1);
    const l = token(z, 1);
    const a = alphaOf(w);
    if (h === null || s === null || l === null || a === null) return null;
    // Plain numbers in hsl() are percentages (`hsl(30 50 40)`).
    const sat = clamp(y.endsWith('%') ? s : s / 100, 0, 1);
    const light = clamp(z.endsWith('%') ? l : l / 100, 0, 1);
    const k = (n: number) => (n + h / 30) % 12;
    const chroma = sat * Math.min(light, 1 - light);
    const f = (n: number) => light - chroma * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a };
}

/** `rgb(r, g, b)` when opaque, else `rgba(r, g, b, a)`; channels rounded. */
export function formatColor(color: Rgba): string {
    const r = Math.round(clamp(color.r, 0, 255));
    const g = Math.round(clamp(color.g, 0, 255));
    const b = Math.round(clamp(color.b, 0, 255));
    const a = round(clamp(color.a, 0, 1), 3);
    return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
    return { ...color, a: clamp(alpha, 0, 1) };
}

/** The colour without its transparency. */
export function opaque(color: Rgba): Rgba {
    return withAlpha(color, 1);
}

/**
 * `color-mix(in srgb, a weight, b)`: premultiplied interpolation, so mixing with `transparent` fades instead of
 * darkening. `weight` is the share of `a` (0–1).
 */
export function mix(a: Rgba, b: Rgba, weight: number): Rgba {
    const w = clamp(weight, 0, 1);
    const alpha = a.a * w + b.a * (1 - w);
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = (x: number, y: number) => (x * a.a * w + y * b.a * (1 - w)) / alpha;
    return { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha };
}

/** Alpha compositing of `top` over `bottom` (source-over). */
export function over(top: Rgba, bottom: Rgba): Rgba {
    const alpha = top.a + bottom.a * (1 - top.a);
    if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const channel = (x: number, y: number) => (x * top.a + y * bottom.a * (1 - top.a)) / alpha;
    return { r: channel(top.r, bottom.r), g: channel(top.g, bottom.g), b: channel(top.b, bottom.b), a: alpha };
}

/** WCAG relative luminance of the colour's RGB (alpha ignored). */
export function luminance(color: Rgba): number {
    const linear = (value: number) => {
        const c = clamp(value, 0, 255) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio (1–21). A translucent `fg` is composited over an opaque `bg` first. */
export function contrast(fg: Rgba, bg: Rgba): number {
    const back = opaque(bg);
    const front = fg.a < 1 ? over(fg, back) : fg;
    const l1 = luminance(front);
    const l2 = luminance(back);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
}

/** Dark colours read better with white on top (decided by contrast, not by a luminance threshold). */
export function isDark(color: Rgba): boolean {
    return contrast(WHITE, opaque(color)) >= contrast(BLACK, opaque(color));
}

/** Black or white, whichever contrasts more with `color`. */
export function readableOn(color: Rgba): Rgba {
    return isDark(color) ? { ...WHITE } : { ...BLACK };
}

/**
 * Moves `fg` toward `toward` in 5 % steps until it contrasts at least `min` with `bg`; if even `toward` is not
 * enough, tries black/white (whichever suits `bg`). Returns the first passing colour or the best one found.
 */
export function ensureContrast(fg: Rgba, bg: Rgba, min: number, toward: Rgba): Rgba {
    if (contrast(fg, bg) >= min) return fg;
    let best = fg;
    let bestRatio = contrast(fg, bg);
    for (const target of [toward, readableOn(bg)]) {
        for (let step = 1; step <= 20; step++) {
            const candidate = mix(target, fg, step / 20);
            const ratio = contrast(candidate, bg);
            if (ratio >= min) return candidate;
            if (ratio > bestRatio) {
                best = candidate;
                bestRatio = ratio;
            }
        }
    }
    return best;
}

/** Smallest alpha (from `start`, in 0.02 steps, up to `max`) at which `color` over `bg` reaches `min` contrast. */
export function alphaForContrast(color: Rgba, bg: Rgba, min: number, start: number, max: number): Rgba {
    let alpha = start;
    while (alpha < max && contrast(withAlpha(color, alpha), bg) < min) alpha = round(alpha + 0.02, 2);
    return withAlpha(color, Math.min(alpha, max));
}

/* ------------------------------------------------------------------ fonts and lengths */

/** Drops characters that could end a declaration in generated CSS (`;`, braces, angle brackets, backslashes). */
export function cssSafe(value: string): string {
    return value.replace(/[;{}<>\\]/g, '').trim();
}

/** Splits a font-family list, keeping quoted names intact. */
export function fontFamilies(list: string): string[] {
    return (list.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []).map((name) => name.trim()).filter(Boolean);
}

/** The user's families (without generic ones) followed by `fallback` (duplicates removed, case-insensitive). */
export function fontStack(family: string | undefined, fallback: readonly string[]): string {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (name: string) => {
        const key = name.replace(/^["']|["']$/g, '').toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(name);
    };
    const own = fontFamilies(cssSafe(family ?? ''));
    const last = fallback[fallback.length - 1];
    for (const name of own) {
        if (!GENERIC_FAMILIES.has(name.toLowerCase())) add(name);
    }
    for (const name of fallback) {
        if (name !== last) add(name);
    }
    // The generic family always closes the stack.
    if (last) add(last);
    return out.join(', ');
}

/** `--sheldWidth` as given when it is a plain length (`50vw`, `800px`, `60%`), else ST's default. */
export function chatWidth(value: string | undefined): string {
    const text = (value ?? '').trim();
    return /^\d+(?:\.\d+)?(?:vw|dvw|svw|px|%|rem|em)$/.test(text) ? text : ST_THEME_DEFAULTS.chatWidth;
}

export function clampRadiusScale(value: unknown): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TOKEN_OPTIONS.radiusScale;
    return clamp(number, RADIUS_SCALE_MIN, RADIUS_SCALE_MAX);
}

/* ------------------------------------------------------------------ derivation */

const px = (value: number) => `${round(value, 2)}px`;

const color = (text: string | undefined, fallback: string): Rgba => parseColor(text) ?? (parseColor(fallback) as Rgba);

/**
 * All `--maestro-*` tokens for ST's current theme. Values are literal (computed once per theme change), so neighbours'
 * skins and Maestro's own UI read the same numbers without re-deriving them in CSS.
 */
export function deriveTokens(input: ThemeInput, options: TokenOptions = DEFAULT_TOKEN_OPTIONS): Record<string, string> {
    const text = opaque(color(input.body, ST_THEME_DEFAULTS.body));
    const surface = color(input.blurTint, ST_THEME_DEFAULTS.blurTint);
    // Translucent panels sit on the chat background; assume a backdrop of the panel's own side (dark or light).
    const base = over(surface, readableOn(text));
    const dark = isDark(base);
    const quote = opaque(color(input.quote, ST_THEME_DEFAULTS.quote));
    const accent = ensureContrast(quote, base, 3, text);
    const shadow = color(input.shadow, ST_THEME_DEFAULTS.shadow);
    const border = color(input.border, ST_THEME_DEFAULTS.border);

    const fontScale = clamp(parseNumber(input.fontScale, ST_THEME_DEFAULTS.fontScale), 0.5, 2);
    const blur = input.noBlur ? 0 : clamp(parseNumber(input.blurStrength, ST_THEME_DEFAULTS.blurStrength), 0, 60);
    const shadowWidth = clamp(parseNumber(input.shadowWidth, ST_THEME_DEFAULTS.shadowWidth), 0, 20);

    const compact = options.density === 'compact';
    const density = compact ? 0.75 : 1;
    const flow = clamp(fontScale, 0.8, 1.4);
    const space = (size: number) => px(Math.max(1, Math.round(size * density * flow)));
    const radiusScale = clampRadiusScale(options.radiusScale);
    const radius = (size: number) => px(Math.round(size * radiusScale * 10) / 10);

    const muted = ensureContrast(mix(text, base, 0.62), base, 4.5, text);
    const divider = alphaForContrast(text, base, 1.3, 0.12, 0.4);
    const elevationColor = (factor: number) => formatColor(withAlpha(shadow, clamp(shadow.a * factor, 0.15, 0.85)));
    const elevation1 = `0 1px ${px(2 + shadowWidth)} ${elevationColor(0.6)}`;
    const elevation2 = `0 ${px(4 + shadowWidth)} ${px(18 + shadowWidth * 4)} ${elevationColor(0.9)}`;

    return {
        '--maestro-radius-xs': radius(3),
        '--maestro-radius-sm': radius(6),
        '--maestro-radius-md': radius(10),
        '--maestro-radius-lg': radius(14),
        '--maestro-radius-pill': radiusScale === 0 ? '0px' : '999px',
        '--maestro-radius': radius(10),
        '--maestro-space-1': space(4),
        '--maestro-space-2': space(8),
        '--maestro-space-3': space(12),
        '--maestro-space-4': space(16),
        '--maestro-gap': space(12),
        '--maestro-gap-sm': space(6),
        '--maestro-control-py': px(compact ? 2 : 3),
        '--maestro-control-px': px(compact ? 4 : 5),
        '--maestro-mes-pad': px(compact ? 6 : 10),
        '--maestro-touch': px(compact ? 34 : 40),
        '--maestro-font-ui': fontStack(input.mainFont || ST_THEME_DEFAULTS.mainFont, UI_FONT_FALLBACK),
        '--maestro-font-chat': cssSafe(input.mainFont || '') || ST_THEME_DEFAULTS.mainFont,
        '--maestro-font-mono': cssSafe(input.monoFont || '') || ST_THEME_DEFAULTS.monoFont,
        '--maestro-font-size': px(BASE_FONT_PX * fontScale),
        '--maestro-text': formatColor(text),
        '--maestro-text-muted': formatColor(muted),
        '--maestro-surface-1': formatColor(surface),
        '--maestro-surface-2': formatColor(withAlpha(text, 0.06)),
        '--maestro-surface-3': formatColor(withAlpha(text, 0.12)),
        '--maestro-surface-solid': formatColor(base),
        '--maestro-well': formatColor(withAlpha(BLACK, dark ? 0.3 : 0.06)),
        '--maestro-border': formatColor(border),
        '--maestro-divider': formatColor(divider),
        '--maestro-accent': formatColor(accent),
        '--maestro-accent-soft': formatColor(withAlpha(accent, 0.18)),
        '--maestro-on-accent': formatColor(readableOn(accent)),
        '--maestro-focus': formatColor(accent),
        '--maestro-shadow': formatColor(shadow),
        '--maestro-elevation-1': input.noShadows ? 'none' : elevation1,
        '--maestro-elevation-2': input.noShadows ? 'none' : elevation2,
        '--maestro-blur': px(blur),
        '--maestro-scroll-thumb': formatColor(withAlpha(text, 0.28)),
        '--maestro-chat-width': chatWidth(input.chatWidth),
    };
}

/** The token block as CSS (`selector { --name: value; … }`). */
export function tokensCss(selector: string, tokens: Record<string, string>): string {
    const lines = Object.entries(tokens).map(([name, value]) => `    ${name}: ${value};`);
    return `${selector} {\n${lines.join('\n')}\n}\n`;
}
