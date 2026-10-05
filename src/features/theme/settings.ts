// Settings slice of M32 «Оформление» (`extensionSettings.maestro.modules.theme`): the layer on/off, every part on/off,
// density and the radius scale. Only Maestro's own slice is stored; ST's and neighbours' settings are never touched.
import { DEFAULT_TOKEN_OPTIONS, RADIUS_SCALE_MAX, RADIUS_SCALE_MIN, clampRadiusScale } from '../../domain/theme-tokens';
import type { Density } from '../../domain/theme-tokens';
import type { NeighbourId, ThemePart } from './api';

export const THEME_KEY = 'theme';
export const THEME_ID = 'M32';

export const NEIGHBOUR_PARTS: readonly NeighbourId[] = ['des', 'ck', 'nai', 'desru', 'qvink', 'localizer'];
/** Every part, in the order the settings list them. */
export const ALL_PARTS: readonly ThemePart[] = ['st', 'chat', ...NEIGHBOUR_PARTS];
export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
/** Radius presets offered in the settings (any value in the range is accepted from storage). */
export const RADIUS_PRESETS: readonly number[] = [0, 0.5, 1, 1.5];
export { RADIUS_SCALE_MAX, RADIUS_SCALE_MIN };

export interface ThemeSettings {
    /** The whole layer (the page class `maestro-theme`). */
    enabled: boolean;
    /** Each part adds its page class `maestro-theme-<part>` while on. */
    parts: Record<ThemePart, boolean>;
    density: Density;
    /** Multiplies Maestro's radii (0 = square corners). */
    radiusScale: number;
}

export function defaultThemeSettings(): ThemeSettings {
    const parts = Object.fromEntries(ALL_PARTS.map((part) => [part, true])) as Record<ThemePart, boolean>;
    return {
        enabled: true,
        parts,
        density: DEFAULT_TOKEN_OPTIONS.density,
        radiusScale: DEFAULT_TOKEN_OPTIONS.radiusScale,
    };
}

export function isThemePart(value: unknown): value is ThemePart {
    return typeof value === 'string' && (ALL_PARTS as readonly string[]).includes(value);
}

/** The live slice, repaired in place (it is the object the settings section edits). */
export function readThemeSettings(slice: Partial<ThemeSettings>): ThemeSettings {
    const defaults = defaultThemeSettings();
    if (typeof slice.enabled !== 'boolean') slice.enabled = defaults.enabled;
    if (!slice.parts || typeof slice.parts !== 'object' || Array.isArray(slice.parts)) slice.parts = defaults.parts;
    const parts = slice.parts as Record<string, unknown>;
    for (const part of ALL_PARTS) {
        if (typeof parts[part] !== 'boolean') parts[part] = true;
    }
    if (!DENSITIES.includes(slice.density as Density)) slice.density = defaults.density;
    if (slice.radiusScale !== clampRadiusScale(slice.radiusScale))
        slice.radiusScale = clampRadiusScale(slice.radiusScale);
    return slice as ThemeSettings;
}
