// Unified look (M32, stage 12): one Maestro stylesheet behind the page class `maestro-theme` (on <html>): remove the
// class and everything looks as before. ST's theme gives the colours, blur, shadow, font scale and chat width; radii,
// spacing, fonts and icons are Maestro's design decisions. Parts can be switched one by one (each adds its own page
// class `maestro-theme-<part>`): ST itself, the chat, and every neighbour. Neighbours' settings are never changed for
// the look; DES nodes are styled only by the stylesheet (DES rewrites inline styles). ST has no «theme changed» event:
// the module watches the theme variables itself and recomputes derived tokens.
// Exposed as app.modules.api<ThemeApi>('theme').
import type { App, Unsubscribe } from '../../shared/contracts';

/** Page class of the whole layer. */
export const THEME_CLASS = 'maestro-theme';
/** Page class of one part: `maestro-theme-st`, `maestro-theme-chat`, `maestro-theme-des`… */
export const partClass = (part: ThemePart): string => `${THEME_CLASS}-${part}`;

export type NeighbourId = 'des' | 'ck' | 'nai' | 'desru' | 'qvink' | 'localizer';
export type ThemePart = 'st' | 'chat' | NeighbourId;

/**
 * A neighbour's skin (neighbours/*.ts): CSS whose every selector starts with `html.maestro-theme.maestro-theme-<id>`
 * (so it applies only while the layer and that part are on), its chat elements included (DES scene headers, NAI
 * images, Qvink memory lines).
 */
export interface NeighbourSkin {
    id: NeighbourId;
    /** i18n key of the part's name in the settings. */
    titleKey: string;
    /** The stylesheet. Uses Maestro's tokens (`--maestro-*`, see tokens in the theme module) and ST's variables. */
    css: string;
    /** The neighbour is on the page (adapter present or its DOM found). */
    present(app: App): boolean;
}

export interface ThemeApi {
    /** The layer is on (the page has THEME_CLASS). */
    enabled(): boolean;
    /** Parts that are on now. */
    parts(): ThemePart[];
    setEnabled(on: boolean): Promise<void>;
    setPart(part: ThemePart, on: boolean): Promise<void>;
    /** Recomputes the derived tokens now (after a theme change the watcher may have missed). */
    refresh(): void;
    onChange(listener: () => void): Unsubscribe;
}
