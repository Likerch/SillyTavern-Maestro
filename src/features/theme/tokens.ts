/*
 * Maestro design tokens (M32). Defined on `html.maestro-theme` while the layer is on, recomputed whenever ST's theme
 * changes (src/domain/theme-tokens.ts derives them). Neighbours' skins, the ST/chat restyle and Maestro's own windows
 * use exactly these names. All values are literal (no var() chains), so they can be used anywhere, including inside
 * calc() and color-mix().
 *
 * Shape
 *   --maestro-radius-xs / -sm / -md / -lg   3 / 6 / 10 / 14 px × the radius scale (settings): chips and checkboxes,
 *                                           buttons and inputs, cards and blocks, windows/drawers/popups
 *   --maestro-radius-pill                   999px (fully round ends; 0 when the radius scale is 0)
 *   --maestro-space-1 / -2 / -3 / -4        4 / 8 / 12 / 16 px × density (compact = 0.75) × ST font scale (clamped
 *                                           to 0.8–1.4): tight gaps, inner padding, block padding, section gaps
 *   --maestro-control-py / -px              button/input padding (comfortable = ST's own 3px 5px, compact 2px 4px)
 *   --maestro-mes-pad                       chat message padding (comfortable = ST's own 10px, compact 6px)
 *   --maestro-touch                         minimal touch target on phones (40px, compact 34px)
 *
 * Type
 *   --maestro-font-ui                       ST's UI font followed by Cyrillic-capable system fallbacks
 *   --maestro-font-chat                     ST's font exactly (the user's choice is kept)
 *   --maestro-font-mono                     ST's monospace font
 *   --maestro-font-size                     ST's base size (15px × font scale)
 *
 * Colour (from ST's SmartTheme colours)
 *   --maestro-text                          ST's main text colour
 *   --maestro-text-muted                    secondary text: text toward the surface, contrast ≥ 4.5 on the surface
 *   --maestro-surface-1                     panel/window background = ST's blur tint (its translucency kept)
 *   --maestro-surface-2                     raised block ON a surface-1 (cards, headers): text at 6 % (overlay)
 *   --maestro-surface-3                     hover / pressed / selected ON a surface-1: text at 12 % (overlay)
 *   --maestro-surface-solid                 opaque surface (menus, tooltips that must not be see-through)
 *   --maestro-well                          input background (ST's black30a on dark themes, lighter on light ones)
 *   --maestro-border                        ST's border colour as is
 *   --maestro-divider                       a hairline that is always visible on the surface (text at ≥ 12 %)
 *   --maestro-accent                        ST's quote colour, nudged toward the text colour if it has < 3:1 contrast
 *   --maestro-accent-soft                   accent at 18 % (selected backgrounds, soft rings)
 *   --maestro-on-accent                     black or white text on an accent background
 *   --maestro-focus                         focus ring colour (= accent)
 *   --maestro-scroll-thumb                  scrollbar thumb
 *
 * Depth and glass
 *   --maestro-shadow                        ST's shadow COLOUR (a colour, not a box-shadow, as in Maestro's own UI)
 *   --maestro-elevation-1 / -2              box-shadow values for raised blocks / floating windows (`none` when ST's
 *                                           «No text shadows» is on); spread follows ST's shadow width
 *   --maestro-blur                          ST's blur strength in px, 0px when ST's blur is off (body.no-blur)
 *
 * Layout
 *   --maestro-chat-width                    ST's chat column width (--sheldWidth, e.g. 50vw)
 *
 * Aliases of Maestro's own UI tokens (src/ui/style.css), same values at default settings so Maestro's windows follow
 * the radius scale and density: --maestro-radius (= md), --maestro-radius-sm, --maestro-gap (= lg), --maestro-gap-sm.
 *
 * ST's own variables stay usable next to these (user/bot message tints, chat tint, em/quote/underline colours):
 * the restyle reads them directly, so it follows ST live.
 */
import { deriveTokens, tokensCss } from '../../domain/theme-tokens';
import type { ThemeInput, TokenOptions } from '../../domain/theme-tokens';
import { THEME_CLASS } from './api';

/** Every token the layer defines (see the comment above). */
export const THEME_TOKENS: readonly string[] = Object.freeze(Object.keys(deriveTokens({})));

/** ui.style id of the token block. */
export const TOKENS_STYLE_ID = 'maestro-theme-tokens';

/** ST variables the derivation reads (custom properties on <html>, set by power-user.js applyTheme*). */
export const ST_THEME_VARS: Readonly<Record<Exclude<keyof ThemeInput, 'noBlur' | 'noShadows'>, string>> = {
    body: '--SmartThemeBodyColor',
    quote: '--SmartThemeQuoteColor',
    blurTint: '--SmartThemeBlurTintColor',
    shadow: '--SmartThemeShadowColor',
    border: '--SmartThemeBorderColor',
    blurStrength: '--blurStrength',
    shadowWidth: '--shadowWidth',
    fontScale: '--fontScale',
    chatWidth: '--sheldWidth',
    mainFont: '--mainFontFamily',
    monoFont: '--monoFontFamily',
};

/**
 * Reads ST's theme from the page. Browsers inherit custom properties, so <body> sees ST's values plus anything a
 * custom CSS set on body; <html> is the fallback (and what test DOMs without inheritance report).
 */
export function readStTheme(doc: Document = document): ThemeInput {
    const view = doc.defaultView;
    const html = doc.documentElement;
    const body = doc.body;
    const htmlStyle = view && html ? view.getComputedStyle(html) : null;
    const bodyStyle = view && body ? view.getComputedStyle(body) : null;
    const read = (name: string): string | undefined => {
        const value =
            bodyStyle?.getPropertyValue(name).trim() ||
            htmlStyle?.getPropertyValue(name).trim() ||
            html?.style.getPropertyValue(name).trim();
        return value || undefined;
    };
    const input: ThemeInput = {};
    for (const [key, name] of Object.entries(ST_THEME_VARS) as [keyof typeof ST_THEME_VARS, string][]) {
        const value = read(name);
        if (value !== undefined) input[key] = value;
    }
    input.noBlur = body?.classList.contains('no-blur') ?? false;
    input.noShadows = body?.classList.contains('noShadows') ?? false;
    return input;
}

/** The token stylesheet for the current theme. */
export function buildTokensCss(input: ThemeInput, options: TokenOptions): string {
    return `/* Maestro M32: design tokens derived from the ST theme */\n${tokensCss(
        `html.${THEME_CLASS}`,
        deriveTokens(input, options),
    )}`;
}
