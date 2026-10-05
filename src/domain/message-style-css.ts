// The stylesheet of the message style rules (M32 «Стиль сообщений»). Every selector starts with the page class the
// module puts on <html>: remove the class (module off) and messages look exactly as SillyTavern draws them.
//
// What is styled: SillyTavern's own output where it marks things itself (`q`, `em`/`i`, `strong`/`b`, inline `code`)
// and the spans of Maestro's formatter hook for the rest (`maestro-ms-*`; ST's sanitizer prefixes classes with
// `custom-`, so both spellings are matched). Narration is the message text itself: its colour, italic and weight
// are reset on the parts other enabled rules own, so «narration» really means «everything else». Colours come from
// Maestro's tokens when the theme layer is on and fall back to ST's theme variables when it is off. Opacity is drawn
// as a translucent colour (CSS opacity would multiply through nested parts). The same rules also style the editor's
// preview boxes. Pure: no DOM.
import { activeRules, isColorToken } from './message-style';
import type {
    ColorToken,
    ColorValue,
    FontToken,
    MarksMode,
    PlayerStyle,
    RuleStyle,
    Scope,
    StyleRule,
} from './message-style';

export interface CssOptions {
    /** Page class on <html> that gates every rule. */
    pageClass: string;
    /** Class of the preview message box; its text is `<class>-text`, its name `<class>-name`. */
    previewClass: string;
    /** Maestro's formatter hook marks messages; without it only what ST marks itself can be styled. */
    annotated: boolean;
    /** Page classes of the theme layer and its chat part: bubbles keep the theme's shadow under the player's mark. */
    themeClasses?: { layer: string; chat: string };
}

/** Prefix of the classes the formatter hook adds. */
export const ANNOTATION_PREFIX = 'maestro-ms-';

/** Both spellings of an annotation class: as written and as ST's sanitizer leaves it (`custom-` prefix). */
export function annotationSelector(name: string): string {
    return `:is(.${ANNOTATION_PREFIX}${name}, .custom-${ANNOTATION_PREFIX}${name})`;
}

export const TEXT_COLOR = 'var(--maestro-text, var(--SmartThemeBodyColor))';
export const ACCENT_COLOR = 'var(--maestro-accent, var(--SmartThemeQuoteColor))';
const SOFT_ACCENT = 'var(--maestro-accent-soft, color-mix(in srgb, var(--SmartThemeQuoteColor) 18%, transparent))';
const QUOTE_COLOR = 'var(--SmartThemeQuoteColor)';
const EM_COLOR = 'var(--SmartThemeEmColor)';

export const COLOR_VALUES: Readonly<Record<ColorToken, string>> = {
    accent: ACCENT_COLOR,
    text: TEXT_COLOR,
    muted: 'var(--maestro-text-muted, var(--maestro-muted, var(--SmartThemeEmColor)))',
    quote: QUOTE_COLOR,
    em: EM_COLOR,
    underline: 'var(--SmartThemeUnderlineColor)',
};

export const FONT_STACKS: Readonly<Record<FontToken, string>> = {
    ui: 'var(--maestro-font-ui, var(--mainFontFamily, sans-serif))',
    chat: 'var(--maestro-font-chat, var(--mainFontFamily, sans-serif))',
    mono: 'var(--maestro-font-mono, var(--monoFontFamily, monospace))',
    serif: "Georgia, 'PT Serif', 'Noto Serif', 'Times New Roman', serif",
};

const SPACING = '0.03em';

/** CSS colour of a token or a hex colour (anything else falls back to the text colour). */
export function colorValue(value: ColorValue): string {
    if (isColorToken(value)) return COLOR_VALUES[value];
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value.toLowerCase() : TEXT_COLOR;
}

function mix(color: string, amount: number): string {
    return amount >= 1 ? color : `color-mix(in srgb, ${color} ${Math.round(amount * 100)}%, transparent)`;
}

/* ------------------------------------------------------------------ channels */

/** Where a rule's kind shows up in the rendered message. */
type Channel = 'narration' | 'dq' | 'gq' | 'dash' | 'em' | 'strong' | 'code' | 'paren' | 'bracket' | 'custom';

const CHANNEL_OF: Readonly<Record<StyleRule['match']['kind'], Channel>> = {
    narration: 'narration',
    doubleQuotes: 'dq',
    guillemets: 'gq',
    dashDialogue: 'dash',
    asterisk: 'em',
    underscore: 'em',
    doubleAsterisk: 'strong',
    backticks: 'code',
    parentheses: 'paren',
    brackets: 'bracket',
    custom: 'custom',
};

/** The colour ST gives a channel (null: it inherits). */
const CHANNEL_COLOR: Partial<Record<Channel, string>> = { dq: QUOTE_COLOR, gq: QUOTE_COLOR, em: EM_COLOR };

/** Selector of a rule's parts inside the message text ('' = the text itself); null when it cannot be styled. */
export function channelSelector(rule: StyleRule, annotated: boolean): string | null {
    switch (CHANNEL_OF[rule.match.kind]) {
        case 'narration':
            return '';
        case 'dq':
            return annotated ? `q${annotationSelector('dq')}` : 'q';
        case 'gq':
            return annotated ? `q${annotationSelector('gq')}` : null;
        case 'em':
            return ':is(em, i)';
        case 'strong':
            return ':is(strong, b)';
        case 'code':
            return ':not(pre) > code';
        case 'dash':
            return annotated ? annotationSelector('dash') : null;
        case 'paren':
            return annotated ? annotationSelector('paren') : null;
        case 'bracket':
            return annotated ? annotationSelector('bracket') : null;
        default:
            return annotated ? annotationSelector(`c-${rule.id}`) : null;
    }
}

/** The rule can be drawn now (kinds only the hook marks need it). */
export function canStyle(rule: StyleRule, annotated: boolean): boolean {
    return channelSelector(rule, annotated) !== null;
}

/* ------------------------------------------------------------------ declarations */

interface NarrationInfo {
    color: boolean;
    italic: boolean;
    bold: boolean;
}

function block(selectors: readonly string[], declarations: readonly string[]): string {
    if (!declarations.length || !selectors.length) return '';
    return `${selectors.join(',\n')} {\n${declarations.map((item) => `    ${item};`).join('\n')}\n}\n`;
}

function narrationDeclarations(style: RuleStyle): string[] {
    const out: string[] = [];
    if (style.color !== null || style.opacity < 1) {
        out.push(`color: ${mix(style.color !== null ? colorValue(style.color) : TEXT_COLOR, style.opacity)}`);
    }
    if (style.italic !== null) out.push(`font-style: ${style.italic ? 'italic' : 'normal'}`);
    if (style.bold !== null) out.push(`font-weight: ${style.bold ? 'bold' : 'normal'}`);
    if (style.spacing) out.push(`letter-spacing: ${SPACING}`);
    if (style.font) out.push(`font-family: ${FONT_STACKS[style.font]}`);
    return out;
}

function ruleDeclarations(style: RuleStyle, channel: Channel, narration: NarrationInfo | null): string[] {
    const out: string[] = [];
    const own = style.color !== null ? colorValue(style.color) : null;
    const reset = narration?.color === true && own === null;
    if (own !== null || style.opacity < 1 || reset) {
        const base = own ?? CHANNEL_COLOR[channel] ?? (reset ? TEXT_COLOR : 'currentColor');
        out.push(`color: ${mix(base, style.opacity)}`);
    }
    if (style.italic !== null) out.push(`font-style: ${style.italic ? 'italic' : 'normal'}`);
    else if (narration?.italic && channel !== 'em') out.push('font-style: normal');
    if (style.bold !== null) out.push(`font-weight: ${style.bold ? 'bold' : 'normal'}`);
    else if (narration?.bold && channel !== 'strong') out.push('font-weight: normal');
    if (style.underline) out.push('text-decoration-line: underline', 'text-underline-offset: 0.18em');
    if (style.spacing) out.push(`letter-spacing: ${SPACING}`);
    if (style.font) out.push(`font-family: ${FONT_STACKS[style.font]}`);
    const shadows: string[] = [];
    if (style.bar) {
        shadows.push(`inset 0.16em 0 0 ${mix(own ?? ACCENT_COLOR, 0.6)}`);
        out.push('padding-left: 0.35em');
    }
    if (style.highlight) {
        out.push(`background-color: ${SOFT_ACCENT}`, 'border-radius: 0.25em');
        shadows.push(`0 0 0 0.12em ${SOFT_ACCENT}`);
    }
    if (shadows.length) {
        out.push(
            `box-shadow: ${shadows.join(', ')}`,
            '-webkit-box-decoration-break: clone',
            'box-decoration-break: clone',
        );
    }
    return out;
}

const GLYPHS: Readonly<Record<MarksMode, [string, string] | null>> = {
    keep: null,
    none: null,
    straight: ['"\\22"', '"\\22"'],
    curly: ['"\\201C"', '"\\201D"'],
    guillemets: ['"\\AB"', '"\\BB"'],
};

function marksCss(roots: readonly string[], channel: string, marks: MarksMode, swapped: boolean): string {
    const mark = annotationSelector('mark');
    const at = (suffix: string) => roots.map((root) => `${root} ${channel}${suffix}`);
    if (marks === 'keep') {
        if (!swapped) return '';
        return (
            block(at(` > ${mark}`), ['display: inline']) +
            block([...at('::before'), ...at('::after')], ['content: none'])
        );
    }
    const glyphs = GLYPHS[marks];
    let css = block(at(` > ${mark}`), ['display: none']);
    if (glyphs)
        css += block(at('::before'), [`content: ${glyphs[0]}`]) + block(at('::after'), [`content: ${glyphs[1]}`]);
    return css;
}

/* ------------------------------------------------------------------ the stylesheet */

function scopeRoots(scope: Scope, options: CssOptions): string[] {
    const page = `html.${options.pageClass}`;
    const attr = scope === 'user' ? '[is_user="true"]' : ':not([is_user="true"])';
    return [
        `${page} #chat .mes${attr} .mes_text`,
        `${page} .${options.previewClass}[data-ms-scope="${scope}"] .${options.previewClass}-text`,
    ];
}

function scopeCss(rules: readonly StyleRule[], scope: Scope, options: CssOptions): string {
    const active = activeRules(rules, scope).filter((rule) => canStyle(rule, options.annotated));
    if (!active.length) return '';
    const roots = scopeRoots(scope, options);
    const narrationRules = active.filter((rule) => rule.match.kind === 'narration');
    const firstSet = <T>(pick: (style: RuleStyle) => T | null): T | null => {
        for (const rule of narrationRules) {
            const value = pick(rule.style);
            if (value !== null) return value;
        }
        return null;
    };
    const narration: NarrationInfo | null = narrationRules.length
        ? {
              color: narrationRules.some((rule) => rule.style.color !== null || rule.style.opacity < 1),
              italic: firstSet((style) => style.italic) === true,
              bold: firstSet((style) => style.bold) === true,
          }
        : null;

    let css = '';
    // Code and NAI images never take the narration's slant, weight or spacing (zero specificity: rules still win).
    const textReset: string[] = [];
    if (narration?.italic) textReset.push('font-style: normal');
    if (narration?.bold) textReset.push('font-weight: normal');
    if (narrationRules.some((rule) => rule.style.spacing)) textReset.push('letter-spacing: normal');
    css += block(
        roots.map((root) => `${root} :where(pre, code, [data-naist-img])`),
        textReset,
    );

    // Lower rules first: the rule higher in the list comes last and wins ties.
    for (const rule of [...active].reverse()) {
        const channel = CHANNEL_OF[rule.match.kind];
        const selector = channelSelector(rule, options.annotated)!;
        if (channel === 'narration') {
            css += block(roots, narrationDeclarations(rule.style));
            continue;
        }
        css += block(
            roots.map((root) => `${root} ${selector}`),
            ruleDeclarations(rule.style, channel, narration),
        );
    }

    if (options.annotated) {
        for (const kind of ['doubleQuotes', 'guillemets', 'dashDialogue'] as const) {
            const own = active.filter((rule) => rule.match.kind === kind);
            if (!own.length) continue;
            const swapped = own.some((rule) => rule.style.marks !== 'keep');
            const selector = channelSelector(own[0]!, true)!;
            for (const rule of [...own].reverse()) css += marksCss(roots, selector, rule.style.marks, swapped);
        }
    }

    // ST keeps emphasis inside quotes in the quote's colour (`.mes_text q em { color: inherit }`): so do these rules.
    const dialogue = options.annotated ? `:is(q, ${annotationSelector('dash')})` : 'q';
    const colours = (channel: Channel) =>
        active.some(
            (rule) => CHANNEL_OF[rule.match.kind] === channel && (rule.style.color !== null || rule.style.opacity < 1),
        );
    if (colours('em'))
        css += block(
            roots.map((root) => `${root} ${dialogue} :is(em, i)`),
            ['color: inherit'],
        );
    if (colours('strong'))
        css += block(
            roots.map((root) => `${root} ${dialogue} :is(strong, b)`),
            ['color: inherit'],
        );
    return css;
}

/** The player's messages as a whole: a bar or a tint on the message, the name colour, bubble alignment. */
export function playerCss(player: PlayerStyle, options: CssOptions): string {
    if (!player.enabled) return '';
    const page = `html.${options.pageClass}`;
    const color = colorValue(player.color);
    const boxes = [`${page} #chat .mes[is_user="true"]`, `${page} .${options.previewClass}[data-ms-scope="user"]`];
    let css = '';
    if (player.mark === 'bar' || player.mark === 'both') {
        const bar = `inset 3px 0 0 ${mix(color, 0.75)}`;
        css += block(boxes, [`box-shadow: ${bar}`]);
        const theme = options.themeClasses;
        if (theme) {
            css += block(
                [`${page}.${theme.layer}.${theme.chat} body.bubblechat #chat .mes[is_user="true"]`],
                [`box-shadow: ${bar}, var(--maestro-elevation-1, 0 0 #0000)`],
            );
        }
    }
    if (player.mark === 'tint' || player.mark === 'both') {
        css += block(boxes, [`background-image: linear-gradient(90deg, ${mix(color, 0.12)}, ${mix(color, 0.04)})`]);
    }
    if (player.name) {
        css += block([`${boxes[0]} .name_text`, `${boxes[1]} .${options.previewClass}-name`], [`color: ${color}`]);
    }
    if (player.align === 'indent') {
        // Bubbles only: the message box stays a full flex item of #chat, it just starts further right.
        css += block(
            [`${page} body.bubblechat #chat .mes[is_user="true"]`],
            ['width: auto', 'margin-left: clamp(16px, 12%, 120px)'],
        );
    }
    return css;
}

/** The whole stylesheet: the player's look, then the rules of both scopes. */
export function buildMessageStyleCss(rules: readonly StyleRule[], player: PlayerStyle, options: CssOptions): string {
    const parts = [
        '/* Maestro M32m: message style */\n',
        playerCss(player, options),
        scopeCss(rules, 'char', options),
        scopeCss(rules, 'user', options),
    ];
    return parts.join('');
}
