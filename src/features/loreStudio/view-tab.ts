// Pult tab of the Lore Studio: the entry point next to the classic window (plan M23 stage 2), the button takeover
// setting (off by default: only when the parity table is green) and the classic editor.
import { section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, el } from '../../ui/components/dom';
import type { App, PultTab } from '../../shared/contracts';
import type { LoreStudioSettings } from './studio';

export const LORE_STUDIO_TAB = 'loreStudio';

export interface TabDeps {
    settings: LoreStudioSettings;
    open(): void;
    openClassic(): void;
    setTakeover(on: boolean): Promise<boolean>;
    takeoverActive(): boolean;
    bookCount(): number;
}

export function loreStudioTab(app: App, deps: TabDeps): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: LORE_STUDIO_TAB,
        titleKey: 'm23.title',
        icon: 'fa-book-atlas',
        order: 40,
        render(container) {
            const status = el('div', {
                class: 'maestro-field-hint',
                text: deps.takeoverActive() ? t('m23.tab.takeoverActive') : t('m23.tab.takeoverInactive'),
            });
            container.append(
                section(t('m23.title'), [
                    el('p', { text: t('m23.tab.intro') }),
                    el('p', { class: 'maestro-muted', text: t('m23.tab.books', { count: deps.bookCount() }) }),
                    el('div', { class: 'maestro-row' }, [
                        button({
                            icon: 'fa-book-atlas',
                            label: t('m23.tab.open'),
                            kind: 'primary',
                            onClick: () => {
                                app.ui.closePult?.();
                                deps.open();
                            },
                        }),
                        button({
                            icon: 'fa-book-open',
                            label: t('m23.classic'),
                            onClick: () => {
                                app.ui.closePult?.();
                                deps.openClassic();
                            },
                        }),
                    ]),
                ]),
                section(t('m23.tab.takeoverTitle'), [
                    toggle({
                        label: t('m23.tab.takeover'),
                        checked: deps.settings.takeoverButton,
                        onChange: async (on) => {
                            const ok = await deps.setTakeover(on);
                            status.textContent = deps.takeoverActive()
                                ? t('m23.tab.takeoverActive')
                                : t('m23.tab.takeoverInactive');
                            if (on && !ok) app.ui.notice(t('m23.tab.takeoverFailed'), { urgent: true, level: 'warn' });
                        },
                    }),
                    el('div', { class: 'maestro-field-hint', text: t('m23.tab.takeoverHint') }),
                    status,
                    el('p', { class: 'maestro-muted', text: t('m23.tab.slash') }),
                ]),
            );
        },
    };
}
