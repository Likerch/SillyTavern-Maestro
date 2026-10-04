// Overview tab (plan §7): stack lamps, modules, today's spend, mode switch, Inbox summary and recent notices.
import type { CapabilityReport, CoreSettings, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, lamp, section } from '../components/card';
import { segmented } from '../components/controls';
import { button, clear, el } from '../components/dom';
import { table } from '../components/table';
import { coalesce, formatTime, formatUsd, tOr } from './format';
import type { ViewEnv } from './types';

export const OVERVIEW_TAB = 'overview';
export const MODES: readonly CoreSettings['mode'][] = ['economy', 'balanced', 'cinema'];

/** Groups capability ids by neighbour prefix: 'des.tracker' → 'des'. */
export function groupCapabilities(report: CapabilityReport[]): Map<string, CapabilityReport[]> {
    const groups = new Map<string, CapabilityReport[]>();
    for (const item of report) {
        const prefix = item.id.includes('.') ? item.id.slice(0, item.id.indexOf('.')) : item.id;
        const list = groups.get(prefix) ?? [];
        list.push(item);
        groups.set(prefix, list);
    }
    return groups;
}

export function overviewTab(env: ViewEnv): PultTab {
    const { i18n, shell } = env;
    const t = i18n.t.bind(i18n);

    const banners = (): HTMLElement[] => {
        const result: HTMLElement[] = [];
        try {
            if (shell.host.isGroupChat()) result.push(banner(t('ui.overview.groupChat'), 'warn', 'fa-users'));
            else if (shell.host.chatId() !== null && !shell.host.isChatCompletion())
                result.push(banner(t('ui.overview.textCompletion'), 'info', 'fa-circle-info'));
        } catch (error) {
            shell.log.debug('overview banners', error);
        }
        return result;
    };

    const inboxBlock = (): HTMLElement => {
        const count = env.inbox.count();
        return section(
            t('ui.overview.inbox'),
            count
                ? el('div', { class: 'maestro-row' }, [
                      el('span', { text: t('ui.overview.inboxCount', { count }) }),
                      button({
                          label: t('ui.overview.openInbox'),
                          icon: 'fa-inbox',
                          onClick: () => shell.openPult('inbox'),
                      }),
                  ])
                : emptyState(t('ui.overview.inboxEmpty')),
        );
    };

    const modeBlock = (): HTMLElement => {
        const core = env.settings.core();
        return section(t('ui.overview.mode'), [
            segmented({
                value: core.mode,
                label: t('ui.overview.mode'),
                options: MODES.map((mode) => ({ value: mode, label: t(`ui.mode.${mode}`) })),
                onChange: (mode) => {
                    env.settings.core().mode = mode;
                    env.settings.save();
                    env.settings.notify('core.mode');
                },
            }),
            el('div', { class: 'maestro-hint', text: t(`ui.mode.${core.mode}Hint`) }),
        ]);
    };

    const costBlock = (): HTMLElement => {
        const summary = env.cost.summary();
        const core = env.settings.core();
        const cap = core.backgroundDailyCapUsd;
        const sources = Object.entries(summary.todayBySource).filter(([, usd]) => usd > 0);
        const children: (HTMLElement | null)[] = [
            el('div', { class: 'maestro-kv' }, [
                el('span', { text: t('ui.cost.today') }),
                el('strong', { text: formatUsd(summary.todayUsd, i18n) }),
            ]),
            el('div', { class: 'maestro-kv' }, [
                el('span', { text: t('ui.cost.background') }),
                el('strong', {
                    text:
                        cap > 0
                            ? t('ui.cost.backgroundOfCap', {
                                  spent: formatUsd(summary.backgroundTodayUsd, i18n),
                                  cap: formatUsd(cap, i18n),
                              })
                            : t('ui.cost.backgroundNoCap', { spent: formatUsd(summary.backgroundTodayUsd, i18n) }),
                }),
            ]),
            summary.anlasToday > 0
                ? el('div', { class: 'maestro-kv' }, [
                      el('span', { text: t('ui.cost.anlas') }),
                      el('strong', { text: String(summary.anlasToday) }),
                  ])
                : null,
            env.cost.backgroundCapReached() ? banner(t('ui.cost.capReached'), 'error', 'fa-hand') : null,
            sources.length
                ? table(
                      [
                          {
                              key: 'source',
                              label: t('ui.cost.source'),
                              cell: ([source]: [string, number]) => tOr(i18n, `ui.cost.source.${source}`, source),
                          },
                          {
                              key: 'usd',
                              label: t('ui.cost.usd'),
                              numeric: true,
                              cell: ([, usd]: [string, number]) => formatUsd(usd, i18n),
                          },
                      ],
                      sources,
                      { caption: t('ui.cost.bySource') },
                  )
                : null,
        ];
        return section(t('ui.overview.cost'), children);
    };

    const stackBlock = (): HTMLElement => {
        const groups = groupCapabilities(env.caps.report());
        if (!groups.size) return section(t('ui.overview.stack'), emptyState(t('ui.overview.stackEmpty'), 'fa-plug'));
        const rows = [...groups.entries()].map(([prefix, items]) => {
            const ok = items.filter((item) => item.ok).length;
            const state = ok === items.length ? 'ok' : ok === 0 ? 'error' : 'warn';
            const failing = items.filter((item) => !item.ok);
            const name = tOr(i18n, `ui.stack.${prefix}`, prefix);
            return el('div', { class: 'maestro-stack-row' }, [
                lamp(state, t(`ui.lamp.${state}`)),
                el('span', { class: 'maestro-stack-name', text: name }),
                el('span', { class: 'maestro-muted', text: t('ui.overview.capsCount', { ok, total: items.length }) }),
                failing.length
                    ? el('details', { class: 'maestro-stack-missing' }, [
                          el('summary', { text: t('ui.overview.capsMissing', { count: failing.length }) }),
                          el(
                              'ul',
                              {},
                              failing.map((item) =>
                                  el('li', { text: item.detail ? `${item.id} — ${item.detail}` : item.id }),
                              ),
                          ),
                      ])
                    : null,
            ]);
        });
        return section(t('ui.overview.stack'), el('div', { class: 'maestro-stack' }, rows));
    };

    const modulesBlock = (): HTMLElement => {
        const list = env.modules
            .list()
            .sort((a, b) => a.module.stage - b.module.stage || a.module.id.localeCompare(b.module.id));
        const status = (item: (typeof list)[number]) => {
            if (item.running) return badge(t('ui.modules.running'), 'ok');
            if (!item.enabled) return badge(t('ui.modules.off'), 'muted');
            if (item.missing.length) return badge(t('ui.modules.blocked'), 'warn');
            return badge(t('ui.modules.stopped'), 'warn');
        };
        return section(
            t('ui.overview.modules'),
            table(
                [
                    {
                        key: 'stage',
                        label: t('ui.modules.stage'),
                        numeric: true,
                        cell: (item) => String(item.module.stage),
                    },
                    {
                        key: 'title',
                        label: t('ui.modules.module'),
                        cell: (item) => [
                            el('span', { text: t(item.module.titleKey) }),
                            el('span', { class: 'maestro-muted', text: ` ${item.module.id}` }),
                        ],
                    },
                    { key: 'status', label: t('ui.modules.status'), cell: status },
                    {
                        key: 'missing',
                        label: t('ui.modules.missing'),
                        cell: (item) =>
                            item.missing.length
                                ? el('span', { class: 'maestro-warn-text', text: item.missing.join(', ') })
                                : '—',
                    },
                ],
                list,
                { empty: t('ui.modules.none') },
            ),
        );
    };

    const noticesBlock = (): HTMLElement => {
        const notices = [...shell.notices()].reverse().slice(0, 15);
        const list = notices.length
            ? el(
                  'ul',
                  { class: 'maestro-notices' },
                  notices.map((notice) =>
                      el(
                          'li',
                          {
                              class: [
                                  'maestro-notice',
                                  `maestro-level-${notice.level}`,
                                  notice.urgent ? 'maestro-urgent' : null,
                              ],
                          },
                          [
                              el('span', { class: 'maestro-notice-time', text: formatTime(notice.at, i18n) }),
                              el('span', { class: 'maestro-notice-text', text: notice.text }),
                              notice.action
                                  ? button({
                                        label: notice.action.label,
                                        kind: 'primary',
                                        onClick: () => notice.action?.run(),
                                    })
                                  : null,
                          ],
                      ),
                  ),
              )
            : emptyState(t('ui.overview.noticesEmpty'), 'fa-bell-slash');
        return section(
            t('ui.overview.notices'),
            list,
            notices.length
                ? button({
                      label: t('ui.overview.clearNotices'),
                      icon: 'fa-broom',
                      kind: 'ghost',
                      onClick: () => {
                          shell.clearNotices();
                          shell.refresh();
                      },
                  })
                : undefined,
        );
    };

    return {
        id: OVERVIEW_TAB,
        titleKey: 'ui.tab.overview',
        icon: 'fa-gauge-high',
        order: 10,
        badge: () => shell.notices().filter((notice) => notice.urgent && !notice.seen).length,
        render(container) {
            const draw = () => {
                clear(container);
                container.append(
                    el('div', { class: 'maestro-view maestro-overview' }, [
                        ...banners(),
                        el('div', { class: 'maestro-grid' }, [inboxBlock(), modeBlock(), costBlock(), stackBlock()]),
                        modulesBlock(),
                        noticesBlock(),
                    ]),
                );
            };
            draw();
            shell.markNoticesSeen();
            const later = coalesce(draw, 250);
            const unsubscribers = [
                env.cost.onChange(later),
                env.inbox.onChange(later),
                env.settings.onChange((path) => {
                    if (
                        path === 'core.mode' ||
                        path.startsWith('core.modules') ||
                        path === 'core.backgroundDailyCapUsd'
                    )
                        later();
                }),
            ];
            return () => {
                later.cancel();
                for (const unsubscribe of unsubscribers) unsubscribe();
            };
        },
    };
}
