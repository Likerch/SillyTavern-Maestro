// Pult tab of the Preset Studio (plan M34, stage 5): a short summary of the current preset, «Открыть Пресет-студию»
// and «Классический редактор», the «replace Prompt Manager» setting (off by default: on when the parity table is
// green, docs/parity/preset-studio.md) and «edits go to my layer».
import { banner, section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, el } from '../../ui/components/dom';
import type { App, PultTab } from '../../shared/contracts';
import type { LauncherSummary } from './launcher';
import type { PresetStudioSettings } from './studio';

export const PRESET_STUDIO_TAB = 'presetStudio';

export interface TabDeps {
    settings: PresetStudioSettings;
    open(): void;
    showClassic(): void;
    /** Turns the replacement on or off; resolves with «the launcher stands in PM's place». */
    setReplace(on: boolean): boolean;
    replaceActive(): boolean;
    setEditsToLayer(on: boolean): void;
    /** null without the data layer. */
    summary(): LauncherSummary | null;
}

export function presetStudioTab(app: App, deps: TabDeps): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: PRESET_STUDIO_TAB,
        titleKey: 'm34.title',
        icon: 'fa-sliders',
        order: 42,
        render(container) {
            const chatCompletion = app.host.isChatCompletion();
            const summary = deps.summary();
            const status = el('div', { class: 'maestro-field-hint maestro-m34-tab-status' });
            const renderStatus = () => {
                status.textContent = deps.replaceActive()
                    ? t('m34.tab.replaceActive')
                    : deps.settings.replacePromptManager
                      ? t('m34.tab.replaceWaiting')
                      : t('m34.tab.replaceInactive');
            };
            renderStatus();
            if (!chatCompletion) container.append(banner(t('m34.tab.textCompletion'), 'warn'));
            container.append(
                section(t('m34.title'), [
                    el('p', { text: t('m34.tab.intro') }),
                    summary
                        ? el('p', {
                              class: 'maestro-muted maestro-m34-tab-summary',
                              text: [
                                  t('m34.tab.preset', { name: summary.preset || t('m34.launcher.noPreset') }),
                                  t('m34.launcher.blocks', { enabled: summary.enabled, total: summary.total }),
                                  summary.tokens === null
                                      ? t('m34.launcher.noTokens')
                                      : t('m34.launcher.tokens', { count: summary.tokens.toLocaleString() }),
                                  summary.dirty ? t('m34.launcher.unsaved') : null,
                                  summary.binding ?? null,
                              ]
                                  .filter(Boolean)
                                  .join(' · '),
                          })
                        : banner(t('m34.error.noStore'), 'error'),
                    el('div', { class: 'maestro-row' }, [
                        button({
                            icon: 'fa-sliders',
                            label: t('m34.launcher.open'),
                            kind: 'primary',
                            className: 'maestro-m34-tab-open',
                            disabled: !chatCompletion || !summary,
                            onClick: () => {
                                app.ui.closePult?.();
                                deps.open();
                            },
                        }),
                        button({
                            icon: 'fa-list-ul',
                            label: t('m34.classic'),
                            disabled: !chatCompletion,
                            onClick: () => {
                                app.ui.closePult?.();
                                deps.showClassic();
                            },
                        }),
                    ]),
                ]),
                section(t('m34.tab.settings'), [
                    toggle({
                        label: t('m34.tab.replace'),
                        checked: deps.settings.replacePromptManager,
                        onChange: (on) => {
                            const placed = deps.setReplace(on);
                            renderStatus();
                            if (on && !placed) app.ui.notice(t('m34.tab.replaceLater'), { level: 'info' });
                        },
                    }),
                    el('div', { class: 'maestro-field-hint', text: t('m34.tab.replaceHint') }),
                    status,
                    toggle({
                        label: t('m34.layer.editsToLayer'),
                        checked: deps.settings.editsToLayer,
                        onChange: (on) => deps.setEditsToLayer(on),
                    }),
                    el('div', { class: 'maestro-field-hint', text: t('m34.layer.editsToLayerHint') }),
                    el('p', { class: 'maestro-muted', text: t('m34.tab.slash') }),
                ]),
            );
        },
    };
}
