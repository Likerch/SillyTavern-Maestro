// @vitest-environment happy-dom
// Neighbour skins (M32, part B): every rule is scoped to its part, nothing hides or re-lays out neighbour controls,
// `!important` only in the CK skin, colours come from tokens, the selectors hit the neighbours' real markup and
// outweigh their own theme rules, present() and the strings.
import { afterEach, describe, expect, it } from 'vitest';
import { THEME_CLASS, partClass } from '../../../src/features/theme/api';
import type { NeighbourId, NeighbourSkin } from '../../../src/features/theme/api';
import {
    DES_SKIN,
    NEIGHBOUR_SKINS,
    NEIGHBOUR_STRINGS,
    neighbourSkin,
    skinScope,
} from '../../../src/features/theme/neighbours';
import { scopeCss, splitSelectors } from '../../../src/features/theme/neighbours/common';
import { THEME_TOKENS } from '../../../src/features/theme/tokens';
import type { App, NeighbourAdapter } from '../../../src/shared/contracts';

const IDS: NeighbourId[] = ['des', 'ck', 'nai', 'desru', 'qvink', 'localizer'];
/** Skins allowed to use `!important`, and why. */
const IMPORTANT_ALLOWED: Partial<Record<NeighbourId, string>> = {
    ck: "CarrotKernel's own stylesheets use !important on the parts it restyles",
};
/** Properties a skin never sets: they hide controls or change the layout direction. */
const FORBIDDEN = [
    'display',
    'visibility',
    'position',
    'float',
    'flex-direction',
    'flex-flow',
    'direction',
    'writing-mode',
    'content-visibility',
];

/* ------------------------------------------------------------------ a small CSS parser, independent of scopeCss */

interface Declaration {
    property: string;
    value: string;
    important: boolean;
}

interface Rule {
    selectors: string[];
    declarations: Declaration[];
    /** Enclosing at-rule preludes, outermost first. */
    context: string[];
}

interface Parsed {
    rules: Rule[];
    atRules: string[];
}

function scan(text: string, from: number, stops: string): number {
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

function matchingBrace(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return i;
    }
    throw new Error('unbalanced');
}

function splitTop(text: string, separator: string): string[] {
    const parts: string[] = [];
    let start = 0;
    for (let i = scan(text, 0, separator); i !== -1; i = scan(text, start, separator)) {
        parts.push(text.slice(start, i));
        start = i + 1;
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter(Boolean);
}

function parseCss(css: string, context: string[] = [], out: Parsed = { rules: [], atRules: [] }): Parsed {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let pos = 0;
    for (;;) {
        const open = scan(text, pos, '{;');
        if (open === -1) {
            expect(text.slice(pos).trim()).toBe('');
            return out;
        }
        expect(text[open]).toBe('{');
        const prelude = text.slice(pos, open).trim();
        const close = matchingBrace(text, open);
        const body = text.slice(open + 1, close);
        if (prelude.startsWith('@')) {
            out.atRules.push(prelude);
            parseCss(body, [...context, prelude], out);
        } else {
            const declarations = splitTop(body, ';').map((d) => {
                const colon = d.indexOf(':');
                const raw = d.slice(colon + 1).trim();
                const important = /!\s*important$/i.test(raw);
                return {
                    property: d.slice(0, colon).trim().toLowerCase(),
                    value: raw.replace(/!\s*important$/i, '').trim(),
                    important,
                };
            });
            out.rules.push({ selectors: splitTop(prelude, ','), declarations, context });
        }
        pos = close + 1;
    }
}

const parsed = new Map<NeighbourId, Parsed>(NEIGHBOUR_SKINS.map((skin) => [skin.id, parseCss(skin.css)]));
const rulesOf = (id: NeighbourId): Rule[] => parsed.get(id)?.rules ?? [];

/** True when `selector` starts with the skin's scope as a whole compound (not `…-des` inside `…-desru`). */
function startsWithScope(selector: string, id: NeighbourId): boolean {
    const scope = `html.${THEME_CLASS}.${partClass(id)}`;
    return selector.startsWith(scope) && !/^[\w-]/.test(selector.slice(scope.length));
}

/* ------------------------------------------------------------------ specificity (Selectors 4) */

type Specificity = [number, number, number];

const add = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const compare = (a: Specificity, b: Specificity): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function closingParen(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) return i;
    }
    throw new Error('unbalanced');
}

/** Index just past the `]` closing the attribute selector opened at `open` (quotes may hold `]`). */
function pastAttribute(text: string, open: number): number {
    let quote = '';
    for (let i = open + 1; i < text.length; i++) {
        const c = text.charAt(i);
        if (quote) {
            if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ']') return i + 1;
    }
    throw new Error('unbalanced');
}

function specificity(selector: string): Specificity {
    let s: Specificity = [0, 0, 0];
    let i = 0;
    const ident = (from: number) => /^-?[\w-]+/.exec(selector.slice(from))?.[0] ?? '';
    while (i < selector.length) {
        const c = selector.charAt(i);
        if (c === '#') {
            s = add(s, [1, 0, 0]);
            i += 1 + ident(i + 1).length;
        } else if (c === '.') {
            s = add(s, [0, 1, 0]);
            i += 1 + ident(i + 1).length;
        } else if (c === '[') {
            s = add(s, [0, 1, 0]);
            i = pastAttribute(selector, i);
        } else if (c === ':' && selector[i + 1] === ':') {
            s = add(s, [0, 0, 1]);
            i += 2 + ident(i + 2).length;
        } else if (c === ':') {
            const name = ident(i + 1);
            const after = i + 1 + name.length;
            if (selector[after] === '(') {
                const end = closingParen(selector, after);
                const inner = selector.slice(after + 1, end);
                if (['is', 'not', 'has'].includes(name)) {
                    const best = splitTop(inner, ',')
                        .map(specificity)
                        .reduce((a, b) => (compare(a, b) >= 0 ? a : b));
                    s = add(s, best);
                } else if (name !== 'where') s = add(s, [0, 1, 0]);
                i = end + 1;
            } else {
                s = add(s, ['before', 'after'].includes(name) ? [0, 0, 1] : [0, 1, 0]);
                i = after;
            }
        } else if (/[a-zA-Z]/.test(c)) {
            s = add(s, [0, 0, 1]);
            i += ident(i).length;
        } else i++;
    }
    return s;
}

/** The selector as happy-dom can match it: pseudo-elements dropped; null for states it cannot evaluate. */
function matchable(selector: string): string | null {
    if (/:(hover|focus|focus-visible|active|empty)\b/.test(selector)) return null;
    return selector.replace(/::[\w-]+/g, '');
}

function matches(element: Element, selector: string): boolean {
    const plain = matchable(selector);
    if (plain === null) return false;
    try {
        return element.matches(plain);
    } catch {
        return false;
    }
}

/** The best specificity among the skin's selectors that match `element` and set `property`. */
function bestFor(id: NeighbourId, element: Element, property: string): Specificity | null {
    let best: Specificity | null = null;
    for (const rule of rulesOf(id)) {
        if (rule.context.length) continue;
        if (!rule.declarations.some((d) => d.property === property)) continue;
        for (const selector of rule.selectors) {
            if (!matches(element, selector)) continue;
            const spec = specificity(selector);
            if (!best || compare(spec, best) > 0) best = spec;
        }
    }
    return best;
}

function setPage(...classes: string[]): void {
    document.documentElement.className = classes.join(' ');
}

afterEach(() => {
    document.documentElement.className = '';
    document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ the list */

describe('NEIGHBOUR_SKINS', () => {
    it('has one skin per neighbour, with its title key and non-empty CSS', () => {
        expect(NEIGHBOUR_SKINS.map((skin) => skin.id)).toEqual(IDS);
        for (const skin of NEIGHBOUR_SKINS) {
            expect(skin.titleKey).toBe(`m32.skin.${skin.id}`);
            expect(skin.css.length).toBeGreaterThan(500);
            expect(neighbourSkin(skin.id)).toBe(skin);
            expect(skinScope(skin.id)).toBe(`html.${THEME_CLASS}.${partClass(skin.id)}`);
        }
    });
});

/* ------------------------------------------------------------------ invariants of every rule */

describe.each(IDS)('the %s skin', (id) => {
    const rules = rulesOf(id);
    const all = rules.flatMap((rule) => rule.declarations.map((d) => ({ rule, d })));

    it('scopes every selector of every rule, inside @media too', () => {
        expect(rules.length).toBeGreaterThan(5);
        expect(rules.some((rule) => rule.context.length > 0)).toBe(true);
        for (const rule of rules) {
            for (const selector of rule.selectors) {
                expect(startsWithScope(selector, id), selector).toBe(true);
                for (const other of IDS.filter((o) => o !== id)) {
                    expect(selector.includes(partClass(other) + ' '), selector).toBe(false);
                }
            }
        }
    });

    it('uses only grouping at-rules (no global names like @keyframes)', () => {
        for (const prelude of parsed.get(id)?.atRules ?? []) {
            expect(prelude, prelude).toMatch(/^@(media|supports|container)\b/);
        }
    });

    it('never hides controls or changes their layout direction', () => {
        for (const { rule, d } of all) {
            const where = `${rule.selectors[0]} { ${d.property}: ${d.value} }`;
            expect(FORBIDDEN, where).not.toContain(d.property);
            if (d.property === 'opacity') expect(Number(d.value), where).toBeGreaterThan(0.3);
            if (d.property === 'pointer-events') expect(d.value, where).not.toBe('none');
            if (d.property === 'transform') expect(d.value, where).toBe('none');
        }
    });

    it(`uses !important ${IMPORTANT_ALLOWED[id] ? 'only where the neighbour does' : 'nowhere'}`, () => {
        const important = all.filter(({ d }) => d.important);
        if (!IMPORTANT_ALLOWED[id]) expect(important.map(({ rule }) => rule.selectors[0])).toEqual([]);
        else expect(important.length).toBeGreaterThan(0);
    });

    it('takes colours from tokens: a fixed colour only mixed with a token', () => {
        const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black|red|green|blue|grey|gray|gold|orange)\b/i;
        for (const { rule, d } of all) {
            if (!literal.test(d.value)) continue;
            expect(d.value, `${rule.selectors[0]} { ${d.property} }`).toContain('var(--');
        }
    });

    it('gives touch targets of at least 36px on phones (ST breakpoint)', () => {
        const phone = rules.filter((rule) => rule.context.some((c) => c.includes('max-width: 1000px')));
        expect(phone.length).toBeGreaterThan(0);
        const sizes = phone.flatMap((rule) =>
            rule.declarations.filter((d) => d.property === 'min-height' || d.property === 'min-width'),
        );
        expect(sizes.length).toBeGreaterThan(0);
        for (const d of sizes) {
            // A length, or max(<floor>, var(--maestro-touch)): the density token never goes below the floor.
            const floor = /^max\(\s*([\d.]+px)/.exec(d.value)?.[1] ?? d.value;
            expect(parseFloat(floor), d.value).toBeGreaterThanOrEqual(36);
        }
    });

    it("reads only tokens the theme module defines (status colours: Maestro's own stylesheet)", () => {
        const known = new Set([...THEME_TOKENS, '--maestro-ok', '--maestro-warn', '--maestro-error']);
        const used = new Set(
            all.flatMap(({ d }) => [...d.value.matchAll(/var\((--maestro-[\w-]+)/g)].map((m) => m[1] ?? '')),
        );
        expect(used.size).toBeGreaterThan(5);
        for (const name of used) expect(known.has(name), name).toBe(true);
    });
});

/* ------------------------------------------------------------------ the selectors hit the neighbours' real markup */

interface Fixture {
    html: string;
    /** [element selector in the fixture, property a skin rule must set on it]. */
    targets: [string, string][];
}

const FIXTURES: Record<NeighbourId, Fixture> = {
    des: {
        html: `
            <div id="extensions_settings"><div class="inline-drawer"><div class="inline-drawer-content">
                <input type="checkbox" id="rpg-extension-enabled">
                <button id="dooms-github-star-btn" class="dooms-github-star-btn"><span class="dooms-github-star-label">Star</span></button>
            </div></div></div>
            <div class="rpg-panel rpg-position-right" data-theme="sci-fi">
                <div class="rpg-panel-header"><h3><i class="fa-solid fa-dice"></i> Tracker</h3></div>
                <div class="rpg-content-box"><div class="rpg-quests-wrapper">Quests</div><button class="rpg-btn-primary">Add</button></div>
            </div>
            <div id="rpg-settings-popup" class="rpg-settings-popup is-open" data-theme="fantasy"><div class="rpg-settings-popup-content">
                <header class="rpg-settings-popup-header"><h3>Settings</h3><button class="rpg-popup-close">x</button></header>
                <div class="rpg-settings-popup-body">
                    <div class="rpg-accordion-section"><div class="rpg-accordion-header"><span class="rpg-accordion-title">Display</span></div></div>
                    <input class="rpg-input"><span class="rpg-setting-hint">hint</span>
                </div>
                <footer class="rpg-settings-popup-footer"><button class="rpg-btn rpg-btn-ghost">Close</button></footer>
            </div></div>
            <div id="character-workshop-popup" class="rpg-settings-popup" data-theme="dracula"><section class="rpg-settings-popup-content">
                <nav class="workshop-nav cw-tabs"><button class="active">Identity</button><button class="cw-looks">Looks</button></nav>
                <button class="rpg-btn rpg-btn-primary">Save</button>
            </section></div>
            <div id="character-roster-popup" class="rpg-settings-popup"><section class="rpg-settings-popup-content cr-content">
                <button class="cr-mode-pill is-active">Characters</button><button class="cr-scope-pill">All</button>
                <div class="cr-grid"><button class="cr-tile"></button></div>
            </section></div>
            <div id="rpg-lorebook-modal" class="rpg-lb-modal is-open" data-theme="arctic"><div class="rpg-lb-modal-content">
                <header class="rpg-lb-modal-header"><h3><i></i><span>Lore Library</span></h3><button class="rpg-lb-close">x</button></header>
                <div class="rpg-lb-modal-body"><div class="rpg-lb-tab active">Books</div><button class="rpg-lb-btn">New</button></div>
            </div></div>
            <div id="rpg-thought-panel" data-theme="custom" style="--rpg-bg: #ff0000"><div class="rpg-thoughts-content">t</div></div>
            <div id="dooms-portrait-bar-wrapper">
                <div class="dooms-pb-toggle dooms-pb-open" id="dooms-pb-toggle"><span class="dooms-pb-toggle-label">Characters</span></div>
                <div class="dooms-portrait-bar dooms-pb-expanded" id="dooms-portrait-bar">
                    <div class="dooms-pb-header"><span class="dooms-pb-title">Present</span><span class="dooms-pb-count">2</span></div>
                    <div class="dooms-pb-scroll"><div class="dooms-portrait-card dooms-pb-speaking"><div class="dooms-portrait-card-name">Ann</div></div></div>
                </div>
            </div>
            <div id="dooms-pb-context-menu" class="dooms-pb-context-menu"><div class="dooms-pb-ctx-item">Workshop</div></div>
            <div id="chat"><div class="mes"><div class="mes_block">
                <div class="mes_text">text</div>
                <div class="dooms-scene-header dooms-scene-layout-grid" style="--st-accent: #e94560">
                    <div class="dooms-scene-row"><i></i><span class="dooms-scene-label">Time:</span><span class="dooms-scene-value">dawn</span></div>
                    <div class="dooms-scene-characters"><span class="dooms-scene-char-badge">Ann</span></div>
                </div>
                <div class="dooms-info-banner"><span class="dooms-ip-item">x</span></div>
                <div class="dooms-scene-transition dooms-transition-hybrid"><div class="dooms-scene-transition-location">Docks</div></div>
                <details class="dooms-inline-thought"><summary class="dooms-inline-thought-summary">Ann</summary><div class="dooms-inline-thought-content">hm</div></details>
                <details class="dooms-tracker-json"><summary class="dooms-tracker-json-summary">data</summary></details>
            </div></div></div>`,
        targets: [
            ['body', '--rpg-highlight'],
            ['.dooms-github-star-btn', 'background'],
            ['.rpg-panel', '--rpg-bg'],
            ['.rpg-panel', 'background'],
            ['.rpg-panel > .rpg-content-box', '--rpg-highlight'],
            ['.rpg-content-box', 'border-radius'],
            ['.rpg-panel .rpg-btn-primary', 'background'],
            ['#rpg-settings-popup .rpg-settings-popup-content', '--rpg-bg'],
            ['#rpg-settings-popup .rpg-settings-popup-content', 'background'],
            ['#rpg-settings-popup .rpg-settings-popup-header', 'border-bottom'],
            ['#rpg-settings-popup .rpg-settings-popup-footer', 'border-top'],
            ['#rpg-settings-popup .rpg-popup-close', 'color'],
            ['#rpg-settings-popup .rpg-accordion-section', 'background'],
            ['#rpg-settings-popup .rpg-input', 'border'],
            ['#rpg-settings-popup .rpg-setting-hint', 'color'],
            ['#character-workshop-popup .rpg-btn-primary', 'background'],
            ['#character-workshop-popup .workshop-nav .cw-looks', 'color'],
            ['#character-roster-popup .cr-mode-pill', 'border-color'],
            ['#character-roster-popup .cr-tile', 'border-radius'],
            ['#rpg-lorebook-modal', '--rpg-highlight'],
            ['#rpg-lorebook-modal .rpg-lb-modal-content', 'background'],
            ['#rpg-lorebook-modal .rpg-lb-tab', 'color'],
            ['#rpg-lorebook-modal .rpg-lb-btn', 'background'],
            ['#rpg-thought-panel > .rpg-thoughts-content', '--rpg-bg'],
            ['.dooms-pb-toggle', 'background'],
            ['.dooms-portrait-bar', 'background'],
            ['.dooms-pb-title', 'color'],
            ['.dooms-portrait-card', 'border-color'],
            ['.dooms-pb-context-menu', 'background'],
            ['.dooms-scene-header', 'background'],
            ['.dooms-scene-label', '--st-label-color'],
            ['.dooms-scene-char-badge', 'background'],
            ['.dooms-info-banner', 'border-left'],
            ['.dooms-transition-hybrid', 'background'],
            ['.dooms-inline-thought', 'background'],
            ['.dooms-inline-thought-content', 'font-family'],
            ['.dooms-tracker-json', 'background'],
        ],
    },
    ck: {
        html: `
            <div id="carrot_settings" class="carrot-extension-settings"><div class="inline-drawer"><div class="inline-drawer-content">
                <div class="carrot-card carrot-enable-card"><div class="carrot-card-header"><h3>Feature Controls</h3><p class="carrot-card-subtitle">s</p></div>
                    <div class="carrot-card-body"><div class="carrot-setting-item">
                        <label class="carrot-toggle"><input type="checkbox" checked><span class="carrot-toggle-slider"></span><span class="carrot-toggle-label">On</span></label>
                        <div class="carrot-help-text">help</div>
                        <select class="carrot-select"></select>
                    </div></div></div>
                <div class="carrot-status-panels"><div class="carrot-status-panel active"><div class="carrot-status-icon"></div><div class="carrot-status-title">System</div><div class="carrot-status-value">Ready</div></div></div>
                <button class="carrot-primary-btn">Scan</button><button class="carrot-secondary-btn">Reset</button>
                <div class="carrot-popup-overlay active"><div class="carrot-popup-container"><div class="carrot-popup-content">
                    <div class="carrot-popup-header"><h4>Packs</h4><button class="carrot-popup-close">x</button></div>
                    <div class="carrot-popup-body">body</div>
                </div></div></div>
            </div></div></div>
            <div class="ck-panel ck-panel--active"><div class="ck-header"><span class="ck-header__title">Tracker</span><span class="ck-header__badge">3</span></div>
                <div class="ck-content"><div class="ck-world-header">World</div><div class="ck-entry">Entry</div></div></div>
            <div id="carrot-rag-visualizer-modal" class="carrot-rag-overlay is-visible"><div class="chunk-modal">chunks</div></div>
            <div id="chat"><div class="mes"><div class="mes_block">
                <details class="carrot-thinking-details"><summary class="carrot-thinking-summary">BunnyMoTags</summary><div class="carrot-thinking-content">tags</div></details>
                <div class="bmt-cards-grid horizontal"><div class="bmt-tracker-card horizontal-layout">card</div></div>
                <div class="mes_text">text</div>
            </div></div></div>`,
        targets: [
            ['#carrot_settings', '--active'],
            ['body', '--ck-primary'],
            ['.carrot-card', 'background'],
            ['.carrot-card-header h3', 'color'],
            ['.carrot-help-text', 'color'],
            ['.carrot-toggle', 'background'],
            ['.carrot-select', 'color'],
            ['.carrot-status-panel', 'border-left'],
            ['.carrot-status-title', 'color'],
            ['.carrot-primary-btn', 'background'],
            ['.carrot-secondary-btn', 'border'],
            ['.carrot-popup-container', 'background'],
            ['.carrot-popup-header', 'background'],
            ['.carrot-popup-close', 'color'],
            ['.ck-panel', 'background'],
            ['.ck-header', 'background'],
            ['.ck-header__badge', 'background'],
            ['.chunk-modal', 'border'],
            ['.carrot-thinking-details', 'border-left'],
            ['.bmt-tracker-card', 'border-radius'],
        ],
    },
    nai: {
        html: `
            <div class="naist-panel" id="naist_panel"><div class="inline-drawer"><div class="inline-drawer-content"><div class="naist-content">
                <div class="naist-badge">plugin</div><div class="naist-account">acc</div>
                <div class="naist-banner">takeover</div>
                <div class="naist-tabs"><div class="naist-tab menu_button naist-tab-active">Generate</div></div>
                <div class="naist-tabpanel"><div class="naist-section"><div class="naist-block">block</div></div></div>
            </div></div></div></div>
            <div class="popup"><div class="popup-content"><div class="naist-dialog naist-gallery">
                <div class="naist-gallery-grid"><div class="naist-g-card"><img><div class="naist-g-card-text">t</div></div></div>
                <div class="naist-slot"><div class="menu_button">x</div></div>
            </div></div></div>
            <div class="naist-progress"><div class="naist-progress-bar"><span></span></div></div>
            <div class="naist-ac"><div class="naist-ac-item naist-ac-active"><span>tag</span></div></div>
            <div id="chat"><div class="mes"><div class="mes_text">
                <span class="naist-inline"><span class="naist-inline-frame naist-inline-border"><img class="naist-inline-img"><span class="naist-inline-toolbar"><i class="naist-inline-btn"></i></span></span>
                    <span class="naist-inline-caption">cap</span><span class="naist-inline-chip">hidden</span></span>
                <span class="naist-inline naist-inline-missing">missing</span>
                <span class="naist-inline naist-inline-marker naist-inline-marker-error"><span class="naist-marker-box"><span class="naist-marker-prompt">p</span></span></span>
            </div></div></div>`,
        targets: [
            ['#naist_panel', 'font-family'],
            ['.naist-tab-active', 'background'],
            ['.naist-banner', 'border-color'],
            ['.naist-account', 'color'],
            ['.naist-block', 'background'],
            ['.naist-badge', 'border-radius'],
            ['.naist-g-card', 'background'],
            ['.naist-slot', 'border-radius'],
            ['.naist-progress', 'background'],
            ['.naist-progress-bar span', 'background'],
            ['.naist-ac', 'background'],
            ['.naist-inline-frame', 'outline-color'],
            ['.naist-inline-caption', 'color'],
            ['.naist-inline-chip', 'border-radius'],
            ['.naist-inline-missing', 'border-color'],
            ['.naist-marker-box', 'background'],
            ['.naist-inline-marker-error .naist-marker-box', 'border-color'],
        ],
    },
    desru: {
        html: `
            <div id="desru-settings" class="desru-settings"><div class="inline-drawer"><div class="inline-drawer-content">
                <p class="desru-intro">intro</p>
                <div class="desru-status"><div class="desru-status-line"><span class="desru-badge desru-tone-on">ok</span></div>
                    <ul class="desru-problems"><li>p</li></ul></div>
                <div class="desru-modules"><div class="desru-module"><span class="desru-module-desc">d</span></div></div>
                <details class="desru-section" open><summary>Names</summary><ul class="desru-merge-list"><li>Ann</li></ul></details>
                <pre class="desru-log">log</pre>
            </div></div></div>`,
        targets: [
            ['#desru-settings', 'font-family'],
            ['.desru-intro', 'color'],
            ['.desru-status', 'background'],
            ['.desru-badge', 'background'],
            ['.desru-tone-on', 'color'],
            ['.desru-problems', 'color'],
            ['.desru-module', 'border-radius'],
            ['.desru-section', 'border'],
            ['.desru-section > summary', 'color'],
            ['.desru-merge-list > li', 'border-radius'],
            ['.desru-log', 'background'],
        ],
    },
    qvink: {
        html: `
            <div id="qvink_memory_settings" class="qvink_memory_settings_content"><div class="inline-drawer"><div class="inline-drawer-content">
                <div class="qvink_interface_card">card</div><button class="menu_button button_highlight">b</button>
            </div></div></div>
            <div id="qvink_memory_state_interface"><div class="qvink_interface_card">c</div><table><thead><tr><th>h</th></tr></thead>
                <tbody><tr><td class="interface_summary"><textarea></textarea><i></i></td></tr></tbody></table>
                <button id="bulk_delete">Delete</button></div>
            <div id="sheld"><div class="summarize qvink_progress_bar">progress</div><div id="chat"><div class="mes"><div class="mes_block">
                <div class="mes_text">text</div>
                <div class="qvink_memory_text qvink_memory_display"><span class="qvink_short_memory">Memory: x</span></div>
                <textarea class="qvink_memory_display qvink_memory_edit_textarea"></textarea>
            </div></div></div></div>`,
        targets: [
            ['body', '--qm-short'],
            ['textarea.qvink_memory_edit_textarea', 'border'],
            ['#qvink_memory_settings .qvink_interface_card', 'border'],
            ['#qvink_memory_settings .button_highlight', 'color'],
            ['#qvink_memory_state_interface .qvink_interface_card', 'border-radius'],
            ['#qvink_memory_state_interface thead', 'background'],
            ['#qvink_memory_state_interface td.interface_summary i', 'color'],
            ['#bulk_delete', 'color'],
            ['.qvink_progress_bar', 'background-color'],
        ],
    },
    localizer: {
        html: `
            <div id="extensions_settings2"><div class="lorebook-localizer-settings"><div class="inline-drawer"><div class="inline-drawer-content">
                <p class="lbl-hint">hint</p><div class="menu_button menu_button_icon lbl-open">Open</div>
            </div></div></div></div>
            <div class="popup"><div class="popup-content"><div class="lbl-dialog">
                <div class="lbl-toolbar"><input class="lbl-search"><span class="lbl-counter">3</span></div>
                <div class="lbl-book-list"><label class="lbl-book"><span>Book</span><span class="lbl-badge">ru</span></label></div>
                <details class="lbl-details" open><summary>Options</summary></details>
                <div class="lbl-preview-list"><div class="lbl-preview-book-title">Book</div><div class="lbl-preview-entry"><div class="lbl-preview-entry-title">Entry</div>
                    <div class="lbl-proposal"><span class="lbl-arrow">→</span><input class="lbl-key-input lbl-invalid"></div></div></div>
                <span class="lbl-warning">warn</span>
            </div></div></div>`,
        targets: [
            ['.lorebook-localizer-settings', 'font-family'],
            ['.lorebook-localizer-settings .lbl-hint', 'color'],
            ['.lbl-counter', 'color'],
            ['.lbl-book-list', 'background'],
            ['.lbl-details', 'border-radius'],
            ['.lbl-badge', 'border-radius'],
            ['.lbl-preview-entry', 'border-left'],
            ['.lbl-proposal', 'border-radius'],
            ['.lbl-key-input', 'outline-color'],
            ['.lbl-warning', 'color'],
        ],
    },
};

describe.each(IDS)('the %s skin on the neighbour markup', (id) => {
    const fixture = FIXTURES[id];
    const elementOf = (selector: string): Element => {
        const element = document.querySelector(selector);
        expect(element, selector).not.toBeNull();
        return element as Element;
    };

    it('styles the visible parts while the layer and the part are on', () => {
        document.body.innerHTML = fixture.html;
        setPage(THEME_CLASS, partClass(id));
        for (const [selector, property] of fixture.targets) {
            expect(bestFor(id, elementOf(selector), property), `${selector} { ${property} }`).not.toBeNull();
        }
    });

    it('matches nothing when the layer or the part is off', () => {
        document.body.innerHTML = fixture.html;
        const others = IDS.filter((o) => o !== id).map(partClass);
        for (const classes of [[], [THEME_CLASS], [partClass(id)], [THEME_CLASS, ...others]]) {
            setPage(...classes);
            for (const [selector, property] of fixture.targets) {
                expect(bestFor(id, elementOf(selector), property), `${classes.join(' ')}: ${selector}`).toBeNull();
            }
        }
    });
});

/* ------------------------------------------------------------------ DES: its own theme rules lose */

describe('the DES skin against DES theme rules', () => {
    // [DES's own selector (from its stylesheets), the element in the fixture, a property both set].
    const contests: [string, string, string][] = [
        ['.rpg-panel[data-theme="sci-fi"]', '.rpg-panel', '--rpg-bg'],
        ['#rpg-thought-panel[data-theme="sci-fi"]', '#rpg-thought-panel', '--rpg-bg'],
        ['.rpg-lb-modal[data-theme="sci-fi"]', '#rpg-lorebook-modal', '--rpg-highlight'],
        [
            '#rpg-settings-popup[data-theme="sci-fi"] .rpg-settings-popup-content',
            '#rpg-settings-popup .rpg-settings-popup-content',
            '--rpg-bg',
        ],
        [
            '#character-workshop-popup[data-theme="sci-fi"] .rpg-settings-popup-content',
            '#character-workshop-popup .rpg-settings-popup-content',
            '--rpg-bg',
        ],
        [
            '#rpg-settings-popup[data-theme="sci-fi"] .rpg-settings-popup-content',
            '#rpg-settings-popup .rpg-settings-popup-content',
            'background',
        ],
        ['#character-workshop-popup .rpg-btn-primary', '#character-workshop-popup .rpg-btn-primary', 'background'],
        ['#character-roster-popup .cr-mode-pill.is-active', '#character-roster-popup .cr-mode-pill', 'background'],
        ['#character-roster-popup .cr-tile', '#character-roster-popup .cr-tile', 'border-color'],
        [
            '#character-workshop-popup .workshop-nav button',
            '#character-workshop-popup .workshop-nav .cw-looks',
            'color',
        ],
        ['#rpg-tracker-editor-popup .rpg-input', '#rpg-settings-popup .rpg-input', 'background'],
        [
            '#dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-header',
            '.dooms-pb-header',
            'border-bottom-color',
        ],
    ];

    it('measures specificity like the browser', () => {
        expect(specificity('#a[data-x="]"] .b:is(.c, #d)::before')).toEqual([2, 2, 1]);
        expect(specificity('html.a.b body > *:not(.x, .y):where(#z)')).toEqual([0, 3, 2]);
        expect(specificity('.rpg-panel[data-theme="sci-fi"]')).toEqual([0, 2, 0]);
    });

    it.each(contests)('outweighs %s on %s (%s)', (theirs, target, property) => {
        document.body.innerHTML = FIXTURES.des.html;
        setPage(THEME_CLASS, partClass('des'));
        const element = document.querySelector(target) as Element;
        const ours = bestFor('des', element, property);
        expect(ours, `${target} { ${property} }`).not.toBeNull();
        expect(compare(ours as Specificity, specificity(theirs))).toBeGreaterThan(0);
    });

    it('leaves the side portrait panel its own layout', () => {
        document.body.innerHTML = FIXTURES.des.html;
        setPage(THEME_CLASS, partClass('des'));
        document.getElementById('dooms-portrait-bar-wrapper')?.classList.add('dooms-pb-position-left');
        expect(bestFor('des', document.querySelector('.dooms-portrait-bar') as Element, 'background')).toBeNull();
    });

    it('reads the inline «custom» theme variables only on the holder, not below it', () => {
        document.body.innerHTML = FIXTURES.des.html;
        setPage(THEME_CLASS, partClass('des'));
        // DES writes --rpg-* inline on #rpg-thought-panel; its children get the skin's values.
        expect(bestFor('des', document.querySelector('.rpg-thoughts-content') as Element, '--rpg-bg')).not.toBeNull();
    });
});

/* ------------------------------------------------------------------ the scoper */

describe('scopeCss', () => {
    const scope = 'html.a.b';
    const firstRule = (css: string): Rule => {
        const [rule] = parseCss(css).rules;
        expect(rule).toBeDefined();
        return rule as Rule;
    };

    it('prefixes every selector, splitting lists but not :is() arguments', () => {
        const css = scopeCss(scope, '.x, :is(.y, #z) > .w { color: red; }');
        expect(firstRule(css).selectors).toEqual(['html.a.b .x', 'html.a.b :is(.y, #z) > .w']);
    });

    it('reads & as the page root and keeps declarations whole', () => {
        const css = scopeCss(scope, '& body { --v: url("a;b"); background: color-mix(in srgb, red 5%, blue); }');
        const rule = firstRule(css);
        expect(rule.selectors).toEqual(['html.a.b body']);
        expect(rule.declarations.map((d) => d.property)).toEqual(['--v', 'background']);
    });

    it('scopes rules inside @media and @supports and drops comments', () => {
        const css = scopeCss(
            scope,
            '/* c */ @media (max-width: 1000px) { @supports (color: red) { .x { color: red } } }',
        );
        const rule = firstRule(css);
        expect(rule.selectors).toEqual(['html.a.b .x']);
        expect(rule.context).toEqual(['@media (max-width: 1000px)', '@supports (color: red)']);
        expect(css).not.toContain('/*');
    });

    it('refuses global at-rules and broken CSS', () => {
        expect(() => scopeCss(scope, '@keyframes k { from { opacity: 0 } }')).toThrow(/keyframes/);
        expect(() => scopeCss(scope, '@import url(x.css);')).toThrow();
        expect(() => scopeCss(scope, '.x { color: red;')).toThrow(/unbalanced/);
        expect(() => scopeCss(scope, '.x { color: red } }')).toThrow();
        expect(() => scopeCss(scope, '{ color: red }')).toThrow(/selector/);
    });

    it('splits selector lists at top-level commas only', () => {
        expect(splitSelectors('a, b:not(.c, .d), [e="f,g"]')).toEqual(['a', 'b:not(.c, .d)', '[e="f,g"]']);
    });
});

/* ------------------------------------------------------------------ present() */

function fakeApp(adapters: Partial<Record<NeighbourAdapter['id'], () => boolean>>): App {
    const all = Object.fromEntries(
        Object.entries(adapters).map(([id, present]) => [id, { id, present } as unknown as NeighbourAdapter]),
    );
    return { adapters: all } as unknown as App;
}

const SETTINGS_BLOCKS: Record<NeighbourId, string> = {
    des: '<div><input type="checkbox" id="rpg-extension-enabled"></div>',
    ck: '<div id="carrot_settings" class="carrot-extension-settings"></div>',
    nai: '<div class="naist-panel" id="naist_panel"></div>',
    desru: '<div id="desru-settings" class="desru-settings"></div>',
    qvink: '<div id="qvink_memory_settings" class="qvink_memory_settings_content"></div>',
    localizer: '<div class="lorebook-localizer-settings"></div>',
};

describe.each(IDS)('present() of the %s skin', (id) => {
    const skin = neighbourSkin(id) as NeighbourSkin;

    it('follows the adapter', () => {
        expect(skin.present(fakeApp({ [id]: () => true }))).toBe(true);
        expect(skin.present(fakeApp({ [id]: () => false }))).toBe(false);
        expect(skin.present(fakeApp({}))).toBe(false);
    });

    it('falls back to its settings block on the page', () => {
        document.body.innerHTML = SETTINGS_BLOCKS[id];
        expect(skin.present(fakeApp({ [id]: () => false }))).toBe(true);
        expect(
            skin.present(
                fakeApp({
                    [id]: () => {
                        throw new Error('broken adapter');
                    },
                }),
            ),
        ).toBe(true);
    });

    it("does not take another neighbour's block for its own", () => {
        document.body.innerHTML = IDS.filter((o) => o !== id)
            .map((o) => SETTINGS_BLOCKS[o])
            .join('');
        expect(skin.present(fakeApp({ [id]: () => false }))).toBe(false);
    });
});

/* ------------------------------------------------------------------ strings */

describe('NEIGHBOUR_STRINGS', () => {
    it('has the same keys in English and Russian, all filled', () => {
        expect(Object.keys(NEIGHBOUR_STRINGS.ru).sort()).toEqual(Object.keys(NEIGHBOUR_STRINGS.en).sort());
        for (const value of [...Object.values(NEIGHBOUR_STRINGS.en), ...Object.values(NEIGHBOUR_STRINGS.ru)]) {
            expect(value.trim()).not.toBe('');
        }
    });

    it('names every part and says what it restyles, in Russian too', () => {
        for (const skin of NEIGHBOUR_SKINS) {
            for (const locale of [NEIGHBOUR_STRINGS.en, NEIGHBOUR_STRINGS.ru]) {
                expect(locale[skin.titleKey]).toBeTruthy();
                expect(locale[`${skin.titleKey}.hint`]).toBeTruthy();
            }
            expect(NEIGHBOUR_STRINGS.ru[`${skin.titleKey}.hint`]).toMatch(/[а-яё]/i);
        }
        expect(Object.keys(NEIGHBOUR_STRINGS.en).every((key) => key.startsWith('m32.skin.'))).toBe(true);
    });
});

/* ------------------------------------------------------------------ the DES skin is self-consistent */

describe('the DES skin variables', () => {
    it('maps every DES theme variable to a Maestro token', () => {
        const holder = rulesOf('des').find((rule) => rule.selectors.some((s) => s.endsWith(' body')));
        const vars = Object.fromEntries((holder?.declarations ?? []).map((d) => [d.property, d.value]));
        for (const name of [
            '--rpg-bg',
            '--rpg-accent',
            '--rpg-text',
            '--rpg-highlight',
            '--rpg-border',
            '--rpg-shadow',
        ]) {
            expect(vars[name], name).toMatch(/var\(--maestro-/);
        }
        expect(DES_SKIN.css).not.toMatch(/style=/);
    });
});
