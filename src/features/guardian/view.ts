// Pult tab «Страж» (plan M4, §7): tab state, the baseline, current drift with restore / accept.
import type { App, PultTab } from '../../shared/contracts';
import { emptyState, lamp, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { formatTime } from '../../ui/views/format';
import type { DriftItem } from './api';
import type { GuardianService } from './service';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export const GUARDIAN_TAB = 'guardian';
const LAMP = { fresh: 'ok', stale: 'error', checking: 'off', unknown: 'warn' } as const;

function shortValue(value: unknown): string {
    if (value === undefined) return '—';
    let text: string;
    try {
        text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        text = String(value);
    }
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function guardianTab(app: App, service: GuardianService, t: Translate): PultTab {
    return {
        id: GUARDIAN_TAB,
        titleKey: 'm4.tab',
        icon: 'fa-shield-halved',
        order: 72,
        badge: () => (service.tabState() === 'stale' ? 1 : 0),
        render(container) {
            let alive = true;
            let drawing = 0;

            const tabSection = (): HTMLElement => {
                const state = service.tabState();
                const info = service.guard?.info();
                return section(
                    t('m4.view.tab'),
                    el('div', { class: 'maestro-guardian-state' }, [
                        lamp(LAMP[state], t(`m4.state.${state}`)),
                        el('span', { text: ` ${t(`m4.state.${state}`)}` }),
                        info?.lastCheckAt
                            ? el('div', {
                                  class: 'maestro-muted',
                                  text: t('m4.view.lastCheck', { time: formatTime(info.lastCheckAt, app.i18n) }),
                              })
                            : null,
                    ]),
                    button({
                        label: t('m4.view.checkTab'),
                        icon: 'fa-arrows-rotate',
                        onClick: async () => {
                            await service.guard?.check();
                        },
                    }),
                );
            };

            const baselineSection = (): HTMLElement => {
                const baseline = service.store.current();
                const reasonKey = baseline ? `m4.reason.${baseline.reason}` : '';
                const reason = baseline ? t(reasonKey) : '';
                return section(
                    t('m4.view.baseline'),
                    baseline
                        ? el('div', {
                              text: t('m4.view.baselineAt', {
                                  time: formatTime(baseline.takenAt, app.i18n),
                                  reason: reason === reasonKey ? baseline.reason : reason,
                              }),
                          })
                        : emptyState(t('m4.view.noBaseline'), 'fa-shield-halved'),
                    button({
                        label: t('m4.view.take'),
                        icon: 'fa-camera',
                        kind: 'primary',
                        onClick: async () => {
                            await service.takeBaseline('manual');
                            // A reply to his click: always shown.
                            app.ui.notice(t('m4.notice.taken'), { level: 'info', urgent: true });
                        },
                    }),
                );
            };

            const driftSection = (items: DriftItem[] | null): HTMLElement => {
                if (items === null)
                    return section(t('m4.view.drift'), emptyState(t('m4.view.loading'), 'fa-hourglass'));
                if (!items.length) return section(t('m4.view.drift'), emptyState(t('m4.view.noDrift')));
                const restorable = items.filter((item) => item.restorable).map((item) => item.path);
                const restore = async (paths: string[]) => {
                    const count = await service.restoreNow(paths);
                    app.ui.notice(t('m4.notice.restored', { count }), {
                        level: count ? 'info' : 'warn',
                        urgent: true,
                    });
                };
                return section(
                    t('m4.view.drift'),
                    table(
                        [
                            { key: 'what', label: t('m4.view.what'), cell: (item) => service.label(item) },
                            {
                                key: 'baseline',
                                label: t('m4.view.baselineValue'),
                                cell: (item) => shortValue(item.baseline),
                            },
                            {
                                key: 'current',
                                label: t('m4.view.currentValue'),
                                cell: (item) => shortValue(item.current),
                            },
                            {
                                key: 'actions',
                                label: '',
                                cell: (item) =>
                                    el('div', { class: 'maestro-row-actions' }, [
                                        item.restorable
                                            ? button({
                                                  label: t('m4.view.restore'),
                                                  icon: 'fa-rotate-left',
                                                  onClick: () => restore([item.path]),
                                              })
                                            : null,
                                        button({
                                            label: t('m4.view.accept'),
                                            icon: 'fa-check',
                                            kind: 'ghost',
                                            onClick: async () => {
                                                await service.acknowledge([item.path]);
                                            },
                                        }),
                                    ]),
                            },
                        ],
                        items,
                    ),
                    [
                        restorable.length
                            ? button({
                                  label: t('m4.view.restoreAll'),
                                  icon: 'fa-rotate-left',
                                  onClick: () => restore(restorable),
                              })
                            : null,
                        button({
                            label: t('m4.view.acceptAll'),
                            icon: 'fa-check-double',
                            kind: 'ghost',
                            onClick: async () => {
                                await service.acknowledge(items.map((item) => item.path));
                            },
                        }),
                    ],
                );
            };

            const draw = async () => {
                const ticket = ++drawing;
                const paint = (items: DriftItem[] | null) => {
                    if (!alive || ticket !== drawing) return;
                    clear(container);
                    container.append(
                        el('div', { class: 'maestro-view maestro-guardian' }, [
                            tabSection(),
                            baselineSection(),
                            driftSection(items),
                        ]),
                    );
                };
                paint(null);
                let items: DriftItem[] = [];
                try {
                    items = await service.drift();
                } catch (error) {
                    app.log.warn('drift view failed', error);
                }
                paint(items);
            };

            const off = service.onChange(() => void draw());
            void draw();
            return () => {
                alive = false;
                off();
            };
        },
    };
}
