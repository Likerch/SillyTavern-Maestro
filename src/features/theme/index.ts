// M32 «Единый интерфейс и стиль» (plan M32, §7, P10, P11; stage 12), part A: one Maestro stylesheet behind the page
// class `maestro-theme` on <html> — tokens derived from ST's theme, SillyTavern and the chat restyled, neighbours'
// skins (./neighbours) injected while the layer is on. Remove the class (setting, module switch, Maestro off) and the
// page looks as before; ST's and neighbours' settings are never changed for the look.
// Exposed as app.modules.api<ThemeApi>('theme').
import { createThemeModule } from './module';
import { NEIGHBOUR_SKINS, NEIGHBOUR_STRINGS } from './neighbours';

export const themeModule = createThemeModule(NEIGHBOUR_SKINS, NEIGHBOUR_STRINGS);

export { THEME_CLASS, partClass } from './api';
export type { NeighbourId, NeighbourSkin, ThemeApi, ThemePart } from './api';
export { createThemeModule } from './module';
export { CHAT_STYLE_ID, PREVIEW_MS, ST_STYLE_ID, ThemeLayer, skinStyleId } from './layer';
export type { ThemeLayerDeps } from './layer';
export {
    ALL_PARTS,
    DENSITIES,
    NEIGHBOUR_PARTS,
    RADIUS_PRESETS,
    THEME_ID,
    THEME_KEY,
    defaultThemeSettings,
    isThemePart,
    readThemeSettings,
} from './settings';
export type { ThemeSettings } from './settings';
export { THEME_STRINGS } from './strings';
export { ST_THEME_VARS, THEME_TOKENS, TOKENS_STYLE_ID, buildTokensCss, readStTheme } from './tokens';
export { ThemeWatcher, WATCH_DEBOUNCE_MS, WATCH_EVENTS } from './watcher';
export { CHAT_GATE, chatCss } from './css-chat';
export { ST_GATE, stCss } from './css-st';
export {
    THEME_CSS,
    THEME_SECTION_ORDER,
    THEME_TAB,
    THEME_TAB_ORDER,
    listedParts,
    partHint,
    partLabel,
    registerThemeSettings,
    renderThemeSettings,
    themeTab,
} from './view';
export type { SettingsSectionSpec, ThemeViewDeps } from './view';
