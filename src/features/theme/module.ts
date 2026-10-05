// M32 «Единый интерфейс и стиль», part A (stage 12): the theme layer. The module is built from the neighbours' skins
// so tests can pass their own; index.ts wires the real ones (src/features/theme/neighbours).
import type { I18nParts, MaestroModule } from '../../shared/contracts';
import type { NeighbourSkin, ThemeApi } from './api';
import { ThemeLayer } from './layer';
import { THEME_ID, THEME_KEY, defaultThemeSettings } from './settings';
import type { ThemeSettings } from './settings';
import { THEME_STRINGS } from './strings';
import { registerThemeSettings } from './view';

/** `skinStrings`: the skins' own strings (their titleKey and hints), registered together with the module's. */
export function createThemeModule(
    skins: readonly NeighbourSkin[],
    skinStrings?: I18nParts,
): MaestroModule<ThemeSettings> {
    const i18n: I18nParts = skinStrings
        ? { en: { ...skinStrings.en, ...THEME_STRINGS.en }, ru: { ...skinStrings.ru, ...THEME_STRINGS.ru } }
        : THEME_STRINGS;
    return {
        id: THEME_ID,
        key: THEME_KEY,
        stage: 12,
        titleKey: 'm32.theme.title',
        enabledByDefault: true,
        defaults: defaultThemeSettings,
        i18n,
        init({ app, log, own }) {
            const layer = new ThemeLayer({ app, log: log.scope('theme'), skins });
            own(() => layer.dispose());
            layer.start();
            const api: ThemeApi = {
                enabled: () => layer.enabled(),
                parts: () => layer.parts(),
                setEnabled: (on) => layer.setEnabled(on),
                setPart: (part, on) => layer.setPart(part, on),
                refresh: () => layer.refresh(),
                onChange: (listener) => layer.onChange(listener),
            };
            app.modules.expose(THEME_KEY, api);
            own(registerThemeSettings({ app, layer, skins }));
        },
    };
}
