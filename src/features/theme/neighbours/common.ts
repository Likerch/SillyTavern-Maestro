// Shared plumbing of the neighbour skins (M32, part B): the scope every rule starts with, Maestro's design tokens as
// CSS values, a tiny scoper for skin stylesheets, and the "is the neighbour on the page" probe.
//
// Skins are written as plain CSS without the scope; `scopeCss` prefixes every selector of every rule (inside @media,
// @supports and @container too) with `html.maestro-theme.maestro-theme-<id>`, so a skin applies only while the layer
// and its part are on. A selector that starts with `&` means the page root itself (`& body` → `html.… body`).
// Global at-rules (@keyframes, @font-face, @import…) are refused: their names would leak out of the scope.
import type { App, NeighbourAdapter } from '../../../shared/contracts';
import { THEME_CLASS, partClass } from '../api';
import type { NeighbourId } from '../api';

/** `html.maestro-theme.maestro-theme-<id>`: the start of every selector of a skin. */
export function skinScope(id: NeighbourId): string {
    return `html.${THEME_CLASS}.${partClass(id)}`;
}

/**
 * Maestro's design tokens (src/features/theme/tokens.ts). The theme module defines them on `html.maestro-theme`,
 * which every skin rule requires, so they are always there when a skin applies. Colours, blur and shadow follow the
 * ST theme; radii, spacing and fonts are Maestro's. The status colours come from Maestro's own stylesheet
 * (src/ui/style.css), hence their fallbacks.
 */
export const T = {
    text: 'var(--maestro-text)',
    muted: 'var(--maestro-text-muted)',
    accent: 'var(--maestro-accent)',
    accentSoft: 'var(--maestro-accent-soft)',
    /** Text on an accent background. */
    onAccent: 'var(--maestro-on-accent)',
    focus: 'var(--maestro-focus)',
    /** Frames (ST's border colour as is). */
    border: 'var(--maestro-border)',
    /** Separators inside a surface: always visible. */
    divider: 'var(--maestro-divider)',
    /** Window and panel background (translucent like ST's). */
    surface1: 'var(--maestro-surface-1)',
    /** A section or card on a surface. */
    surface2: 'var(--maestro-surface-2)',
    /** Hover, pressed, selected. */
    surface3: 'var(--maestro-surface-3)',
    /** Opaque: menus, sticky headers, anything that must not be see-through. */
    surfaceSolid: 'var(--maestro-surface-solid)',
    /** Input background. */
    well: 'var(--maestro-well)',
    /** A colour, used inside box-shadow values. */
    shadow: 'var(--maestro-shadow)',
    /** box-shadow values: raised blocks / floating windows (`none` with ST's «No text shadows»). */
    elevation1: 'var(--maestro-elevation-1)',
    elevation2: 'var(--maestro-elevation-2)',
    /** A length (0px when ST's blur is off). */
    blur: 'var(--maestro-blur)',
    radiusXs: 'var(--maestro-radius-xs)',
    radiusSm: 'var(--maestro-radius-sm)',
    radiusMd: 'var(--maestro-radius-md)',
    radiusLg: 'var(--maestro-radius-lg)',
    radiusPill: 'var(--maestro-radius-pill)',
    space1: 'var(--maestro-space-1)',
    space2: 'var(--maestro-space-2)',
    space3: 'var(--maestro-space-3)',
    space4: 'var(--maestro-space-4)',
    fontUi: 'var(--maestro-font-ui)',
    fontChat: 'var(--maestro-font-chat)',
    fontMono: 'var(--maestro-font-mono)',
    scrollThumb: 'var(--maestro-scroll-thumb)',
    ok: 'var(--maestro-ok, rgb(88, 182, 0))',
    warn: 'var(--maestro-warn, rgb(230, 170, 40))',
    error: 'var(--maestro-error, rgb(225, 80, 80))',
} as const;

/** Values built from the tokens that several skins share (Maestro's own buttons, src/ui/style.css). */
export const V = {
    primaryBg: `color-mix(in srgb, ${T.accent} 32%, transparent)`,
    primaryBgHover: `color-mix(in srgb, ${T.accent} 44%, transparent)`,
    primaryBorder: `color-mix(in srgb, ${T.accent} 60%, transparent)`,
    accentLine: `color-mix(in srgb, ${T.accent} 45%, transparent)`,
    focusRing: `0 0 0 2px color-mix(in srgb, ${T.focus} 45%, transparent)`,
    /** A hue mixed with ST's text colour: keeps the hue's meaning and stays readable on light and dark themes. */
    readable: (hue: string, share = 65) => `color-mix(in srgb, ${hue} ${share}%, ${T.text})`,
} as const;

/** ST's phone breakpoint (its own `max-width: 1000px`). */
export const PHONE = '(max-width: 1000px)';
/** Touch targets on phones: Maestro's density token, never below 36px. */
export const TOUCH = 'max(36px, var(--maestro-touch))';

const GROUP_AT_RULES = new Set(['media', 'supports', 'container']);

/** Index of the first `stop` character outside strings, brackets and parentheses (comments are gone), or -1. */
function findTopLevel(text: string, from: number, stops: string): number {
    let depth = 0;
    let quote = '';
    for (let i = from; i < text.length; i++) {
        const c = text.charAt(i);
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0 && stops.includes(c)) return i;
    }
    return -1;
}

/** Index of the `}` closing the block opened at `open`. */
function closingBrace(text: string, open: number): number {
    let depth = 0;
    let quote = '';
    for (let i = open; i < text.length; i++) {
        const c = text.charAt(i);
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i;
    }
    throw new Error('neighbour skin: unbalanced braces');
}

/** Splits a selector list at its top-level commas (`:is(a, b)` stays whole). */
export function splitSelectors(list: string): string[] {
    const parts: string[] = [];
    let start = 0;
    for (let i = findTopLevel(list, 0, ','); i !== -1; i = findTopLevel(list, start, ',')) {
        parts.push(list.slice(start, i));
        start = i + 1;
    }
    parts.push(list.slice(start));
    return parts.map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

function scopeSelector(scope: string, selector: string): string {
    return selector.startsWith('&') ? `${scope}${selector.slice(1)}` : `${scope} ${selector}`;
}

function scopeBlock(scope: string, css: string, indent: string): string {
    const out: string[] = [];
    let pos = 0;
    for (;;) {
        const open = findTopLevel(css, pos, '{;}');
        if (open === -1) {
            if (css.slice(pos).trim()) throw new Error(`neighbour skin: dangling text "${css.slice(pos).trim()}"`);
            break;
        }
        const prelude = css.slice(pos, open).trim();
        if (css[open] !== '{') throw new Error(`neighbour skin: unexpected "${css[open]}" after "${prelude}"`);
        const close = closingBrace(css, open);
        const body = css.slice(open + 1, close);
        if (prelude.startsWith('@')) {
            const name = /^@([\w-]+)/.exec(prelude)?.[1] ?? '';
            if (!GROUP_AT_RULES.has(name)) throw new Error(`neighbour skin: @${name} is not allowed`);
            out.push(
                `${indent}${prelude.replace(/\s+/g, ' ')} {\n${scopeBlock(scope, body, `${indent}    `)}${indent}}\n`,
            );
        } else {
            if (!prelude) throw new Error('neighbour skin: a rule without a selector');
            const selectors = splitSelectors(prelude).map((s) => scopeSelector(scope, s));
            const declarations = body
                .split(/;(?![^(]*\))/)
                .map((d) => d.trim().replace(/\s+/g, ' '))
                .filter(Boolean)
                .map((d) => `${indent}    ${d};\n`)
                .join('');
            out.push(`${indent}${selectors.join(`,\n${indent}`)} {\n${declarations}${indent}}\n`);
        }
        pos = close + 1;
    }
    return out.join('');
}

/** Prefixes every selector of `css` with `scope`; comments are dropped. Throws on malformed CSS. */
export function scopeCss(scope: string, css: string): string {
    return scopeBlock(scope, css.replace(/\/\*[\s\S]*?\*\//g, ''), '');
}

function domHas(selectors: readonly string[]): boolean {
    if (typeof document === 'undefined') return false;
    return selectors.some((selector) => {
        try {
            return document.querySelector(selector) !== null;
        } catch {
            return false;
        }
    });
}

/** True when the neighbour's adapter says it is present, or one of its own elements is on the page. */
export function neighbourPresent(app: App, id: NeighbourAdapter['id'], probes: readonly string[]): boolean {
    try {
        if (app.adapters[id]?.present()) return true;
    } catch {
        // A failing adapter must not break the look: fall back to the page.
    }
    return domHas(probes);
}
