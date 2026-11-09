// The «Мизансцена» section (window «Мир»): who is where and how now, editable by hand; the module's settings.
import { STAGING_FIELDS } from '../../domain/staging';
import type { StagingEntry } from '../../domain/staging';
import type { App, PultTab, Unsubscribe } from '../../shared/contracts';
import { emptyState, moduleSettingsSection } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { append, button, clear, el } from '../../ui/components/dom';
import type { StagingService, StagingSettings } from './service';

export const STAGING_CSS = `
.maestro-staging-row { display: grid; grid-template-columns: repeat(6, minmax(70px, 1fr)) auto; gap: 4px; margin-bottom: 4px; align-items: center; }
.maestro-staging-head { font-size: 0.8em; opacity: 0.7; }
@media (max-width: 1000px) { .maestro-staging-row { grid-template-columns: 1fr 1fr; } }
`;

export function stagingTab(app: App, service: StagingService, settings: () => StagingSettings): PultTab {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    return {
        id: 'staging',
        titleKey: 'm45.title',
        icon: 'fa-people-arrows',
        order: 45,
        group: 'world',
        render(container: HTMLElement): Unsubscribe {
            let draft: StagingEntry[] = [];
            const paint = () => {
                clear(container);
                draft = service.current().map((entry) => ({ ...entry }));
                container.append(el('div', { class: 'maestro-hint', text: t('m45.hint') }));
                const rows = el('div', {});
                const head = el('div', { class: ['maestro-staging-row', 'maestro-staging-head'] }, [
                    el('span', { text: t('m45.field.name') }),
                    ...STAGING_FIELDS.map((key) => el('span', { text: t(`m45.field.${key}`) })),
                    el('span', {}),
                ]);
                const paintRows = () => {
                    clear(rows);
                    rows.append(head);
                    for (const entry of draft) {
                        const input = (key: 'name' | (typeof STAGING_FIELDS)[number]) => {
                            const node = el('input', { class: 'text_pole', attrs: { type: 'text' } });
                            node.value = entry[key] ?? '';
                            node.addEventListener('input', () => {
                                if (key === 'name') entry.name = node.value;
                                else entry[key] = node.value || undefined;
                            });
                            return node;
                        };
                        rows.append(
                            el('div', { class: 'maestro-staging-row' }, [
                                input('name'),
                                ...STAGING_FIELDS.map((key) => input(key)),
                                button({
                                    icon: 'fa-xmark',
                                    kind: 'ghost',
                                    title: t('m45.remove'),
                                    onClick: () => {
                                        draft = draft.filter((item) => item !== entry);
                                        paintRows();
                                    },
                                }),
                            ]),
                        );
                    }
                };
                if (!draft.length) container.append(emptyState(t('m45.empty'), 'fa-people-arrows'));
                paintRows();
                append(container, [
                    rows,
                    el('div', { class: 'maestro-actions' }, [
                        button({
                            icon: 'fa-plus',
                            label: t('m45.add'),
                            onClick: () => {
                                draft.push({ name: '' });
                                paintRows();
                            },
                        }),
                        button({
                            icon: 'fa-floppy-disk',
                            label: t('m45.save'),
                            kind: 'primary',
                            onClick: () => service.setCurrent(draft.filter((entry) => entry.name.trim())),
                        }),
                    ]),
                    service.text() ? el('pre', { class: 'maestro-agent-preview', text: service.text() }) : null,
                    moduleSettingsSection(t('m45.settings'), [
                        toggle({
                            label: t('m45.promptLine'),
                            hint: t('m45.promptLineHint'),
                            checked: settings().promptLine,
                            onChange: (on) => {
                                app.settings.module<StagingSettings>('staging').promptLine = on;
                                app.settings.save();
                                app.settings.notify('staging.promptLine');
                            },
                        }),
                        field(
                            t('m45.depth'),
                            numberInput({
                                value: settings().depth,
                                min: 0,
                                max: 20,
                                step: 1,
                                onChange: (value) => {
                                    app.settings.module<StagingSettings>('staging').depth = value;
                                    app.settings.save();
                                    app.settings.notify('staging.depth');
                                },
                            }),
                        ),
                    ]),
                ]);
            };
            paint();
            const off = service.onChange(() => {
                if (!container.contains(document.activeElement)) paint();
            });
            return () => off();
        },
    };
}
