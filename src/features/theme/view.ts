// Settings section «Оформление» (M32): the layer on/off, parts (neighbours only when present, named by their skins),
// density, corners and «Показать, как было». Lives in the pult's settings through `app.ui.addSettingsSection` when the
// shell offers it (stage 12 dock), otherwise in a small pult tab of its own. Phone-first: one column, big targets.
import type { App, PultTab, SettingsSection, Unsubscribe } from '../../shared/contracts';
import { field, segmented, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { section } from '../../ui/components/card';
import type { NeighbourSkin, ThemePart } from './api';
import type { ThemeLayer } from './layer';
import { DENSITIES, RADIUS_PRESETS } from './settings';
import type { ThemeSettings } from './settings';

export const THEME_TAB = 'theme';
export const THEME_TAB_ORDER = 98;
export const THEME_SECTION_ORDER = 30;

/** `Ui.addSettingsSection` is optional (stage 12 shell); feature-detected so the module also works without it. */
export type SettingsSectionSpec = SettingsSection;

export const THEME_CSS = `
.maestro-m32 { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m32-parts { display: flex; flex-direction: column; gap: 4px; }
.maestro-m32-compare { display: flex; flex-wrap: wrap; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m32 .maestro-toggle[aria-disabled='true'] { opacity: 0.55; }
`;

export interface ThemeViewDeps {
    app: App;
    layer: ThemeLayer;
    skins: readonly NeighbourSkin[];
}

/** Name of a part: ST and chat from Maestro's strings, neighbours from their skin (fallback: Maestro's key). */
export function partLabel(app: App, part: ThemePart, skins: readonly NeighbourSkin[]): string {
    const own = `m32.theme.part.${part}`;
    const skin = skins.find((item) => item.id === part);
    if (skin?.titleKey) {
        const label = app.i18n.t(skin.titleKey);
        if (label && label !== skin.titleKey) return label;
    }
    return app.i18n.t(own);
}

/**
 * What a part restyles: `<titleKey>.hint` of a neighbour's skin, or Maestro's `m32.theme.part.<part>.hint` (ST and
 * the chat), if there is such a string.
 */
export function partHint(app: App, part: ThemePart, skins: readonly NeighbourSkin[]): string | undefined {
    const skin = skins.find((item) => item.id === part);
    const key = skin?.titleKey ? `${skin.titleKey}.hint` : skin ? '' : `m32.theme.part.${part}.hint`;
    if (!key) return undefined;
    const hint = app.i18n.t(key);
    return hint && hint !== key ? hint : undefined;
}

/** Parts listed in the settings: ST, chat, then each neighbour whose skin says it is on the page. */
export function listedParts(app: App, skins: readonly NeighbourSkin[]): ThemePart[] {
    const parts: ThemePart[] = ['st', 'chat'];
    for (const skin of skins) {
        if (isPresent(app, skin) && !parts.includes(skin.id)) parts.push(skin.id);
    }
    return parts;
}

/** A throwing probe counts as «not on the page». */
function isPresent(app: App, skin: NeighbourSkin): boolean {
    try {
        return skin.present(app) === true;
    } catch {
        return false;
    }
}

/** Renders the settings into `container` and keeps them in sync with the layer; returns the cleanup. */
export function renderThemeSettings(container: HTMLElement, deps: ThemeViewDeps, framed: boolean): Unsubscribe {
    const { app, layer, skins } = deps;
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m32' });
    container.appendChild(root);

    const control = <T extends HTMLElement>(node: T, key: string): T => {
        const target = node.matches('input, button') ? node : node.querySelector<HTMLElement>('input, button');
        if (target) target.dataset.m32Control = key;
        return node;
    };

    const draw = () => {
        const focused = (root.ownerDocument.activeElement as HTMLElement | null)?.dataset?.m32Control;
        clear(root);
        const settings: ThemeSettings = layer.settings();
        const on = settings.enabled;

        const enabled = control(
            toggle({
                label: t('m32.theme.enabled'),
                hint: t('m32.theme.enabledHint'),
                checked: on,
                onChange: (checked) => layer.setEnabled(checked),
            }),
            'enabled',
        );

        const parts = el(
            'div',
            { class: 'maestro-m32-parts', attrs: { role: 'group', 'aria-label': t('m32.theme.parts') } },
            listedParts(app, skins).map((part) => {
                const node = control(
                    toggle({
                        label: partLabel(app, part, skins),
                        hint: partHint(app, part, skins),
                        checked: settings.parts[part],
                        disabled: !on,
                        onChange: (checked) => layer.setPart(part, checked),
                    }),
                    `part-${part}`,
                );
                node.dataset.part = part;
                if (!on) node.setAttribute('aria-disabled', 'true');
                return node;
            }),
        );

        const density = segmented({
            label: t('m32.theme.density'),
            value: settings.density,
            options: DENSITIES.map((value) => ({ value, label: t(`m32.theme.density.${value}`) })),
            onChange: (value) => layer.setDensity(value),
        });

        for (const node of density.querySelectorAll<HTMLElement>('button')) {
            node.dataset.m32Control = `density-${node.dataset.value ?? ''}`;
        }

        const radius = segmented({
            label: t('m32.theme.radius'),
            value: String(settings.radiusScale),
            options: RADIUS_PRESETS.map((value) => ({
                value: String(value),
                label: t(`m32.theme.radius.${value}`),
            })),
            onChange: (value) => layer.setRadiusScale(Number(value)),
        });

        for (const node of radius.querySelectorAll<HTMLElement>('button')) {
            node.dataset.m32Control = `radius-${node.dataset.value ?? ''}`;
        }

        const previewing = layer.previewing();
        const compare = el('div', { class: 'maestro-m32-compare' }, [
            control(
                button({
                    label: t(previewing ? 'm32.theme.compareBack' : 'm32.theme.compare'),
                    icon: previewing ? 'fa-wand-magic-sparkles' : 'fa-eye',
                    disabled: !on,
                    onClick: () => layer.preview(!previewing),
                }),
                'compare',
            ),
        ]);
        compare.firstElementChild?.setAttribute('aria-pressed', previewing ? 'true' : 'false');

        const body = [
            el('div', { class: 'maestro-hint', text: t('m32.theme.intro') }),
            enabled,
            on ? null : el('div', { class: 'maestro-hint', attrs: { role: 'status' }, text: t('m32.theme.offHint') }),
            field(t('m32.theme.parts'), parts, t('m32.theme.partsHint')),
            field(t('m32.theme.density'), density),
            field(t('m32.theme.radius'), radius),
            field(t('m32.theme.compareLabel'), compare, t('m32.theme.compareHint')),
        ];
        if (framed) root.appendChild(section(t('m32.theme.title'), body));
        else for (const node of body) if (node) root.appendChild(node);

        if (focused) root.querySelector<HTMLElement>(`[data-m32-control="${focused}"]`)?.focus();
    };

    draw();
    const off = layer.onChange(draw);
    return () => {
        off();
        root.remove();
    };
}

/** Fallback when the shell has no settings sections yet: a small pult tab «Оформление». */
export function themeTab(deps: ThemeViewDeps): PultTab {
    return {
        id: THEME_TAB,
        titleKey: 'm32.theme.tab',
        icon: 'fa-palette',
        order: THEME_TAB_ORDER,
        render: (container) => renderThemeSettings(container, deps, true),
    };
}

/** Registers the settings where the shell wants them; returns the remover (own() it). */
export function registerThemeSettings(deps: ThemeViewDeps): Unsubscribe {
    const ui = deps.app.ui;
    const offStyle = ui.style('maestro-m32-view', THEME_CSS);
    let offView: Unsubscribe;
    if (typeof ui.addSettingsSection === 'function') {
        // The shell frames the section with its title, so the body is rendered without a frame of its own.
        offView = ui.addSettingsSection({
            id: THEME_TAB,
            titleKey: 'm32.theme.title',
            order: THEME_SECTION_ORDER,
            render: (container) => renderThemeSettings(container, deps, false),
        });
    } else {
        offView = ui.addTab(themeTab(deps));
    }
    return () => {
        offView();
        offStyle();
    };
}
