// Pult tab «Архитектор» (M20, plan M20 п. 7): budgets per source with the usage of the last turn, presence and
// place settings with what was damped / pinned / cut, repeated facts with «Оставить только …», the provider cache
// and the P16 order check, and the before/after of every rule in the last turn. Also the section M20 offers the
// turn inspector (M2) when it accepts extra sections.
import { budgetShare } from '../../domain/architect-budget';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { formatTime } from '../../ui/views/format';
import type { ArchitectReport, BudgetSource, DuplicateFact, RuleEffect } from './api';
import { FUTURE_SOURCES } from './prompt';
import type { ArchitectService } from './service';
import { BUDGET_SOURCES, MAX_MENTION_WINDOW, cleanWindow } from './settings';

export const ARCHITECT_TAB = 'architect';

export const ARCHITECT_CSS = `
.maestro-m20-budgets { display: flex; flex-direction: column; gap: 10px; }
.maestro-m20-budget { display: flex; flex-direction: column; gap: 3px; }
.maestro-m20-bar { height: 6px; border-radius: 3px; background: var(--maestro-raised-strong); overflow: hidden; }
.maestro-m20-fill { height: 100%; background: var(--maestro-accent); }
.maestro-m20-fill.maestro-m20-over { background: var(--maestro-warn); }
.maestro-m20-line { font-size: 0.9em; }
.maestro-m20-facts { display: flex; flex-direction: column; gap: 10px; }
.maestro-m20-fact { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px; }
.maestro-m20-fact-text { font-style: italic; overflow-wrap: anywhere; }
.maestro-m20-sources { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.maestro-m20-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m20-list { display: flex; flex-direction: column; gap: 2px; font-size: 0.9em; }
`;

export function architectTab(app: App, service: ArchitectService): PultTab {
    const i18n = app.i18n;
    const t = i18n.t.bind(i18n);
    const number = (value: number): string => {
        try {
            return new Intl.NumberFormat(i18n.locale() === 'ru' ? 'ru-RU' : 'en-US').format(Math.round(value));
        } catch {
            return String(Math.round(value));
        }
    };
    const percent = (share: number): string => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

    return {
        id: ARCHITECT_TAB,
        titleKey: 'm20.tab',
        icon: 'fa-compass-drafting',
        order: 53,
        render(container) {
            let alive = true;

            const save = (path: string): void => {
                app.settings.save();
                app.settings.notify(path);
                draw();
            };

            const budgetRow = (source: BudgetSource, report: ArchitectReport | null): HTMLElement => {
                const limit = service.settings().budgets[source];
                const row = report?.budgets.find((item) => item.source === source);
                const used = row?.used ?? 0;
                const share = budgetShare(used, limit);
                const status = row?.status ?? (FUTURE_SOURCES.has(source) && limit > 0 ? 'noSource' : undefined);
                const lines: Child[] = [];
                if (FUTURE_SOURCES.has(source)) {
                    lines.push(el('div', { class: 'maestro-hint', text: t('m20.source.noSource') }));
                } else {
                    if (limit > 0) {
                        lines.push(
                            el('div', { class: 'maestro-m20-bar', attrs: { role: 'presentation' } }, [
                                el('div', {
                                    class: [
                                        'maestro-m20-fill',
                                        share > 1 || status === 'over' ? 'maestro-m20-over' : null,
                                    ],
                                    attrs: { style: `width: ${Math.min(100, Math.round(share * 100))}%` },
                                }),
                            ]),
                        );
                    }
                    const usage = row
                        ? limit > 0
                            ? t('m20.usage', { used: number(used), limit: number(limit) })
                            : t('m20.usage.free', { used: number(used) })
                        : '';
                    const statusText =
                        status && status !== 'off' ? t(`m20.status.${status}`, { cut: number(row?.cut ?? 0) }) : '';
                    const line = [usage, statusText].filter(Boolean).join(' · ');
                    if (line) lines.push(el('div', { class: 'maestro-m20-line maestro-muted', text: line }));
                    lines.push(el('div', { class: 'maestro-hint', text: t(`m20.source.${source}.hint`) }));
                }
                return el('div', { class: 'maestro-m20-budget', data: { source } }, [
                    field(
                        t(`m20.source.${source}`),
                        numberInput({
                            value: limit,
                            min: 0,
                            max: 1_000_000,
                            step: 100,
                            label: t(`m20.source.${source}`),
                            onChange: async (value) => {
                                await service.setBudget(source, value);
                                draw();
                            },
                        }),
                    ),
                    ...lines,
                ]);
            };

            const budgetsView = (report: ArchitectReport | null): HTMLElement =>
                section(t('m20.budgets.title'), [
                    el('div', { class: 'maestro-hint', text: t('m20.budgets.hint') }),
                    el(
                        'div',
                        { class: 'maestro-m20-budgets' },
                        BUDGET_SOURCES.map((source) => budgetRow(source, report)),
                    ),
                ]);

            const presenceView = (report: ArchitectReport | null): HTMLElement => {
                const settings = service.settings();
                const presence = settings.presence;
                const world = !!app.modules.api('world');
                const damped = report?.damped ?? [];
                const pinned = report?.pinned ?? [];
                const cuts = report?.cuts ?? [];
                const since = (count: number) => (count >= 0 ? t('m20.since', { count }) : t('m20.since.never'));
                return section(t('m20.presence.title'), [
                    el('div', { class: 'maestro-hint', text: t('m20.presence.hint') }),
                    world ? null : banner(t('m20.presence.noWorld'), 'info', 'fa-circle-info'),
                    toggle({
                        label: t('m20.presence.damp'),
                        checked: presence.damp,
                        onChange: (checked) => {
                            presence.damp = checked;
                            save('m20.presence.damp');
                        },
                    }),
                    toggle({
                        label: t('m20.presence.pin'),
                        checked: presence.pin,
                        onChange: (checked) => {
                            presence.pin = checked;
                            save('m20.presence.pin');
                        },
                    }),
                    field(
                        t('m20.presence.window'),
                        numberInput({
                            value: presence.mentionWindow,
                            min: 1,
                            max: MAX_MENTION_WINDOW,
                            step: 1,
                            label: t('m20.presence.window'),
                            onChange: (value) => {
                                presence.mentionWindow = cleanWindow(value);
                                save('m20.presence.mentionWindow');
                            },
                        }),
                    ),
                    damped.length
                        ? el('details', {}, [
                              el('summary', { text: t('m20.presence.damped', { count: damped.length }) }),
                              table(
                                  [
                                      {
                                          key: 'entry',
                                          label: t('m20.col.entry'),
                                          cell: (row) => row.comment || `${row.world} #${row.uid}`,
                                      },
                                      { key: 'about', label: t('m20.col.about'), cell: (row) => row.entity },
                                      {
                                          key: 'why',
                                          label: t('m20.col.why'),
                                          cell: (row) =>
                                              `${t(`m20.reason.${row.reason}`)} · ${since(row.sinceMention)}`,
                                      },
                                  ],
                                  damped,
                              ),
                          ])
                        : null,
                    pinned.length
                        ? el('details', {}, [
                              el('summary', { text: t('m20.presence.pinned', { count: pinned.length }) }),
                              table(
                                  [
                                      {
                                          key: 'entry',
                                          label: t('m20.col.entry'),
                                          cell: (row) => row.comment || `${row.world} #${row.uid}`,
                                      },
                                      {
                                          key: 'why',
                                          label: t('m20.col.why'),
                                          cell: (row) => t(`m20.reason.${row.reason}`),
                                      },
                                      {
                                          key: 'tokens',
                                          label: t('m20.col.tokens'),
                                          numeric: true,
                                          cell: (row) => number(row.tokens),
                                      },
                                  ],
                                  pinned,
                              ),
                          ])
                        : null,
                    cuts.length
                        ? el('details', {}, [
                              el('summary', { text: t('m20.presence.cuts', { count: cuts.length }) }),
                              table(
                                  [
                                      {
                                          key: 'entry',
                                          label: t('m20.col.entry'),
                                          cell: (row) => row.comment || `${row.world} #${row.uid}`,
                                      },
                                      {
                                          key: 'tokens',
                                          label: t('m20.col.tokens'),
                                          numeric: true,
                                          cell: (row) => number(row.tokens),
                                      },
                                  ],
                                  cuts,
                              ),
                          ])
                        : null,
                ]);
            };

            const factView = (fact: DuplicateFact): HTMLElement => {
                const kept = fact.keep ? fact.sources.find((source) => source.ref === fact.keep) : undefined;
                const actions: Child[] = fact.sources.map((source) =>
                    button({
                        label: t('m20.dup.keep', { source: service.sourceLabel(source.owner, source.ref) }),
                        kind: fact.keep === source.ref ? 'primary' : 'default',
                        disabled: fact.keep === source.ref,
                        onClick: async () => {
                            await service.keepSource(fact.id, source.ref);
                            draw();
                        },
                    }),
                );
                if (fact.keep) {
                    actions.push(
                        button({
                            label: t('m20.dup.reportOnly'),
                            kind: 'ghost',
                            onClick: async () => {
                                await service.keepSource(fact.id, null);
                                draw();
                            },
                        }),
                    );
                }
                return el('div', { class: 'maestro-m20-fact', data: { fact: fact.id } }, [
                    el('div', { class: 'maestro-m20-fact-text', text: fact.text }),
                    el(
                        'div',
                        { class: 'maestro-m20-sources' },
                        fact.sources.map((source) =>
                            badge(
                                `${service.sourceLabel(source.owner, source.ref)} · ${number(source.tokens)}`,
                                fact.keep === source.ref ? 'ok' : 'muted',
                            ),
                        ),
                    ),
                    kept
                        ? el('div', {
                              class: 'maestro-hint',
                              text: t('m20.dup.kept', { source: service.sourceLabel(kept.owner, kept.ref) }),
                          })
                        : null,
                    el('div', { class: 'maestro-m20-actions' }, actions),
                ]);
            };

            const duplicatesView = (): HTMLElement => {
                const settings = service.settings();
                const facts = service.duplicates();
                return section(t('m20.dup.title'), [
                    el('div', { class: 'maestro-hint', text: t('m20.dup.hint') }),
                    toggle({
                        label: t('m20.dup.detect'),
                        checked: settings.duplicates.detect,
                        onChange: (checked) => {
                            settings.duplicates.detect = checked;
                            save('m20.duplicates.detect');
                        },
                    }),
                    !settings.duplicates.detect && !facts.length
                        ? el('div', { class: 'maestro-muted', text: t('m20.dup.off') })
                        : facts.length
                          ? el('div', { class: 'maestro-m20-facts' }, facts.map(factView))
                          : emptyState(t('m20.dup.none')),
                ]);
            };

            const cacheView = (report: ArchitectReport | null): HTMLElement => {
                const settings = service.settings();
                const stats = service.cache();
                const order = report?.order ?? [];
                const lines: Child[] = [];
                if (!stats.requests) lines.push(el('div', { class: 'maestro-muted', text: t('m20.cache.none') }));
                else if (!stats.promptTokens)
                    lines.push(el('div', { class: 'maestro-muted', text: t('m20.cache.noUsage') }));
                else {
                    lines.push(
                        el('div', {
                            class: 'maestro-m20-line',
                            text: t('m20.cache.summary', {
                                rate: percent(stats.hitRate),
                                requests: stats.requests,
                                cached: number(stats.cachedTokens),
                                prompt: number(stats.promptTokens),
                            }),
                        }),
                    );
                }
                if (stats.firstChangeAt !== null) {
                    lines.push(
                        el('div', {
                            class: 'maestro-m20-line maestro-muted',
                            text: t('m20.cache.firstChange', { index: number(stats.firstChangeAt) }),
                        }),
                    );
                }
                return section(t('m20.cache.title'), [
                    toggle({
                        label: t('m20.cache.measure'),
                        checked: settings.cache.measure,
                        onChange: (checked) => {
                            settings.cache.measure = checked;
                            save('m20.cache.measure');
                        },
                    }),
                    toggle({
                        label: t('m20.cache.orderCheck'),
                        checked: settings.cache.orderCheck,
                        onChange: (checked) => {
                            settings.cache.orderCheck = checked;
                            save('m20.cache.orderCheck');
                        },
                    }),
                    ...lines,
                    settings.cache.orderCheck && report
                        ? order.length
                            ? el('div', { class: 'maestro-m20-list' }, [
                                  el('div', { class: 'maestro-warn-text', text: t('m20.order.title') }),
                                  ...order.map((item) =>
                                      el('div', {
                                          text: t('m20.order.item', {
                                              key: item.key,
                                              index: item.messageIndex,
                                              count: item.stableAfter,
                                          }),
                                      }),
                                  ),
                              ])
                            : el('div', { class: 'maestro-m20-line maestro-muted', text: t('m20.order.none') })
                        : null,
                ]);
            };

            const reportView = (report: ArchitectReport | null): HTMLElement =>
                section(t('m20.report.title'), [
                    report
                        ? el('div', {
                              class: 'maestro-muted',
                              text: t('m20.report.at', { time: formatTime(report.at, i18n) }),
                          })
                        : null,
                    report
                        ? effectsTable(app, report.effects ?? [], number)
                        : emptyState(t('m20.report.none'), 'fa-compass-drafting'),
                ]);

            const draw = (): void => {
                if (!alive) return;
                clear(container);
                if (!app.host.chatId()) {
                    container.append(
                        el('div', { class: 'maestro-view' }, [emptyState(t('m20.noChat'), 'fa-comments')]),
                    );
                    return;
                }
                const report = service.lastReport();
                container.append(
                    el('div', { class: 'maestro-view maestro-m20' }, [
                        el('p', { class: 'maestro-hint', text: t('m20.intro') }),
                        service.ensureRules() ? null : banner(t('m20.rulesMissing'), 'warn'),
                        budgetsView(report),
                        presenceView(report),
                        duplicatesView(),
                        cacheView(report),
                        reportView(report),
                    ]),
                );
            };

            const off = service.onChange(() => draw());
            draw();
            return () => {
                alive = false;
                off();
            };
        },
    };
}

/** Before/after of every rule of one turn (used by the tab and by the inspector section). */
export function effectsTable(app: App, effects: readonly RuleEffect[], number: (value: number) => string): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    if (!effects.length) return emptyState(t('m20.inspector.none'));
    return table(
        [
            { key: 'rule', label: t('m20.col.rule'), cell: (row: RuleEffect) => t(`m20.effect.${row.rule}`) },
            { key: 'before', label: t('m20.col.before'), numeric: true, cell: (row: RuleEffect) => number(row.before) },
            { key: 'after', label: t('m20.col.after'), numeric: true, cell: (row: RuleEffect) => number(row.after) },
            { key: 'count', label: t('m20.col.count'), numeric: true, cell: (row: RuleEffect) => number(row.count) },
        ],
        [...effects],
        { caption: t('m20.report.title') },
    );
}

/** The architect's section of the turn inspector (M2): the report of the same turn, if this session has it. */
export function inspectorSection(
    app: App,
    service: ArchitectService,
    record: { messageIndex: number; at: number },
): HTMLElement | null {
    const reports = service.reports();
    const report =
        reports.find((item) => item.messageIndex === record.messageIndex && Math.abs(item.at - record.at) < 60_000) ??
        reports.find((item) => item.messageIndex === undefined && Math.abs(item.at - record.at) < 5_000);
    if (!report) return null;
    const number = (value: number) => String(Math.round(value));
    return section(app.i18n.t('m20.inspector.title'), effectsTable(app, report.effects ?? [], number));
}
