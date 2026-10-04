// Pult tab «Расходы» (M21): totals of the last turn, the session and today by source (USD and Anlas), the per-turn
// table of the chat, a plain HTML/CSS bar chart of the last days, and the background cap / overall daily limit
// (the same core settings paths the Settings tab writes). Estimated entries (no cost in the answer) are marked.
import { lineOf } from '../../domain/treasurer-spend';
import type { App, CoreSettings, PultTab } from '../../shared/contracts';
import { banner, emptyState, section } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { coalesce, formatTime, formatUsd } from '../../ui/views/format';
import type { SpendLine, SpendSource, SpendSummary, TurnSpend } from './api';
import type { TreasurerService } from './service';

export const TREASURER_TAB = 'treasurer';
const SETTINGS_TAB = 'settings';
const LIMIT_ACTIONS: readonly CoreSettings['dailyLimit']['action'][] = ['warn', 'economy', 'stopBackground'];

/** Rows of the totals table and columns of the turn table: the NAI line splits into its LLM cost and Anlas. */
type Column = SpendSource | 'anlas';
const COLUMNS: readonly Column[] = ['main', 'regeneration', 'autoSwipe', 'qvink', 'maestro', 'nai', 'anlas', 'other'];

export const M21_CSS = `
.maestro-m21-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
.maestro-m21-note { font-size: 0.85em; opacity: 0.8; margin: 4px 0; }
.maestro-m21-est { display: inline-block; margin-left: 4px; padding: 0 4px; border-radius: 4px; font-size: 0.75em;
    border: 1px dashed currentColor; opacity: 0.8; white-space: nowrap; }
.maestro-m21-total td { font-weight: 600; }
.maestro-m21-muted { opacity: 0.6; }
.maestro-m21-chart { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding: 4px 0; }
.maestro-m21-day { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: stretch;
    height: 100%; }
.maestro-m21-track { flex: 1 1 auto; display: flex; align-items: flex-end; border-bottom: 1px solid
    var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.4)); }
.maestro-m21-bar { width: 100%; min-height: 0; border-radius: 3px 3px 0 0;
    background: var(--SmartThemeQuoteColor, #6b8fd6); opacity: 0.75; }
.maestro-m21-today .maestro-m21-bar { opacity: 1; }
.maestro-m21-anlas .maestro-m21-bar { box-shadow: inset 0 3px 0 var(--maestro-warn, #d08a2c); }
.maestro-m21-day-label { text-align: center; font-size: 0.7em; opacity: 0.75; margin-top: 2px; overflow: hidden; }
.maestro-m21-today .maestro-m21-day-label { font-weight: 700; opacity: 1; }
`;

function formatAnlas(value: number, app: App): string {
    const rounded = Math.round(value * 100) / 100;
    try {
        return new Intl.NumberFormat(app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US').format(rounded);
    } catch {
        return String(rounded);
    }
}

function formatDay(at: number, app: App): string {
    try {
        return new Intl.DateTimeFormat(app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US', {
            day: 'numeric',
            month: 'short',
        }).format(new Date(at));
    } catch {
        return new Date(at).toDateString();
    }
}

export function treasurerTab(app: App, service: TreasurerService): PultTab {
    const i18n = app.i18n;
    const t = i18n.t.bind(i18n);
    const usd = (value: number) => formatUsd(value, i18n);

    /** «оценка»: the core meter had no cost in some answers (usd 0); the tooltip gives the tokens known. */
    const estimated = (line?: SpendLine): HTMLElement => {
        const tokens = line
            ? ` ${t('m21.tokens', { prompt: line.tokens.prompt, completion: line.tokens.completion })}`
            : '';
        return el('span', {
            class: 'maestro-m21-est',
            text: t('m21.estimated'),
            title: `${t('m21.estimatedHint')}${tokens}`,
        });
    };

    /** One cell: USD of a source (or Anlas of the NAI line), «оценка» when some answers had no cost. */
    const cell = (lines: readonly SpendLine[], column: Column): Child[] => {
        if (column === 'anlas') {
            const anlas = lineOf(lines, 'nai')?.anlas ?? 0;
            return [anlas > 0 ? formatAnlas(anlas, app) : '—'];
        }
        const line = lineOf(lines, column);
        if (!line || (line.usd <= 0 && line.requests <= 0)) return ['—'];
        return [usd(line.usd), line.estimated ? estimated(line) : null];
    };

    const totalCell = (lines: readonly SpendLine[]): Child[] => {
        let total = 0;
        let anyEstimated = false;
        for (const line of lines) {
            total += line.usd;
            if (line.estimated) anyEstimated = true;
        }
        return [usd(total), anyEstimated ? estimated() : null];
    };

    const totalsView = (): HTMLElement => {
        const periods: { key: string; summary: SpendSummary }[] = [
            { key: 'm21.col.turn', summary: service.summary('turn') },
            { key: 'm21.col.session', summary: service.summary('session') },
            { key: 'm21.col.day', summary: service.summary('day') },
        ];
        type Row = { column: Column | 'total' };
        const rows: Row[] = [...COLUMNS.map((column) => ({ column })), { column: 'total' }];
        const node = table<Row>(
            [
                {
                    key: 'source',
                    label: t('m21.col.source'),
                    cell: (row) => (row.column === 'total' ? t('m21.total') : t(`m21.source.${row.column}`)),
                },
                ...periods.map((period) => ({
                    key: period.key,
                    label: t(period.key),
                    numeric: true,
                    cell: (row: Row) =>
                        row.column === 'total'
                            ? totalCell(period.summary.lines)
                            : cell(period.summary.lines, row.column),
                })),
            ],
            rows,
            { caption: t('m21.section.totals') },
        );
        node.querySelector('tbody tr:last-child')?.classList.add('maestro-m21-total');
        return section(t('m21.section.totals'), [
            node,
            el('div', {
                class: 'maestro-m21-note',
                text: t('m21.sessionSince', { time: formatTime(service.sessionStart(), i18n) }),
            }),
        ]);
    };

    const turnsView = (): HTMLElement => {
        if (!app.host.chatId()) return section(t('m21.section.turns'), emptyState(t('m21.view.noChat'), 'fa-comments'));
        const turns = [...service.turns()].reverse();
        return section(t('m21.section.turns'), [
            table<TurnSpend>(
                [
                    {
                        key: 'turn',
                        label: t('m21.col.message'),
                        numeric: true,
                        cell: (turn) => t('m21.turn.number', { index: turn.messageIndex }),
                    },
                    ...COLUMNS.map((column) => ({
                        key: column,
                        label: t(`m21.source.${column}Short`),
                        numeric: true,
                        cell: (turn: TurnSpend) => cell(turn.lines, column),
                    })),
                    { key: 'total', label: t('m21.col.total'), numeric: true, cell: (turn) => totalCell(turn.lines) },
                ],
                turns,
                { empty: t('m21.turns.empty'), caption: t('m21.section.turns') },
            ),
            turns.length ? el('div', { class: 'maestro-m21-note', text: t('m21.turns.note') }) : null,
        ]);
    };

    const chartView = (days: SpendSummary[]): HTMLElement => {
        const max = days.reduce((top, day) => Math.max(top, day.totalUsd), 0);
        const last = days[days.length - 1];
        let total = 0;
        let anlas = 0;
        const bars = days.map((day) => {
            total += day.totalUsd;
            anlas += day.totalAnlas;
            const share = max > 0 ? day.totalUsd / max : 0;
            const percent = day.totalUsd > 0 ? Math.max(2, Math.round(share * 100)) : 0;
            const params = {
                date: formatDay(day.from, app),
                usd: usd(day.totalUsd),
                anlas: formatAnlas(day.totalAnlas, app),
            };
            const label = day.totalAnlas > 0 ? t('m21.days.barAnlas', params) : t('m21.days.bar', params);
            const bar = el('div', { class: 'maestro-m21-bar' });
            bar.style.height = `${percent}%`;
            return el(
                'div',
                {
                    class: [
                        'maestro-m21-day',
                        day === last ? 'maestro-m21-today' : null,
                        day.totalAnlas > 0 ? 'maestro-m21-anlas' : null,
                    ],
                    title: label,
                    attrs: { role: 'listitem', 'aria-label': label },
                },
                [
                    el('div', { class: 'maestro-m21-track' }, [bar]),
                    el('div', { class: 'maestro-m21-day-label', text: String(new Date(day.from).getDate()) }),
                ],
            );
        });
        const params = { count: days.length, usd: usd(total), anlas: formatAnlas(anlas, app) };
        return el('div', {}, [
            el(
                'div',
                {
                    class: 'maestro-m21-chart',
                    attrs: { role: 'list', 'aria-label': t('m21.days.aria', { count: days.length }) },
                },
                bars,
            ),
            el('div', {
                class: 'maestro-m21-note',
                text: anlas > 0 ? t('m21.days.captionAnlas', params) : t('m21.days.caption', params),
            }),
        ]);
    };

    const limitsView = (): HTMLElement => {
        const settings = app.settings;
        const core = () => settings.core();
        const commit = (path: string) => {
            settings.save();
            settings.notify(path);
        };
        const summary = app.cost.summary();
        const cap = core().backgroundDailyCapUsd;
        const limit = core().dailyLimit;
        return section(t('m21.section.limits'), [
            el('div', { class: 'maestro-kv' }, [
                el('span', { text: t('m21.limits.background') }),
                el('strong', {
                    text:
                        cap > 0
                            ? t('m21.limits.backgroundOfCap', { spent: usd(summary.backgroundTodayUsd), cap: usd(cap) })
                            : t('m21.limits.backgroundNoCap', { spent: usd(summary.backgroundTodayUsd) }),
                }),
            ]),
            app.cost.backgroundCapReached() ? banner(t('m21.limits.capReached'), 'error', 'fa-hand') : null,
            service.limitReached()
                ? banner(
                      t('m21.limits.limitReached', { spent: usd(summary.todayUsd), limit: usd(limit.usd) }),
                      'warn',
                      'fa-scale-unbalanced',
                  )
                : null,
            field(
                t('m21.limits.backgroundCap'),
                numberInput({
                    value: cap,
                    min: 0,
                    step: 0.05,
                    label: t('m21.limits.backgroundCap'),
                    onChange: (value) => {
                        core().backgroundDailyCapUsd = value;
                        commit('core.backgroundDailyCapUsd');
                    },
                }),
                t('m21.limits.backgroundCapHint'),
            ),
            toggle({
                label: t('m21.limits.dailyLimit'),
                hint: t('m21.limits.dailyLimitHint'),
                checked: limit.enabled,
                onChange: (checked) => {
                    core().dailyLimit.enabled = checked;
                    commit('core.dailyLimit.enabled');
                },
            }),
            field(
                t('m21.limits.dailyLimitUsd'),
                numberInput({
                    value: limit.usd,
                    min: 0,
                    step: 0.5,
                    label: t('m21.limits.dailyLimitUsd'),
                    onChange: (value) => {
                        core().dailyLimit.usd = value;
                        commit('core.dailyLimit.usd');
                    },
                }),
            ),
            field(
                t('m21.limits.dailyLimitAction'),
                select({
                    value: limit.action,
                    label: t('m21.limits.dailyLimitAction'),
                    options: LIMIT_ACTIONS.map((value) => ({ value, label: t(`m21.limits.action.${value}`) })),
                    onChange: (value) => {
                        core().dailyLimit.action = value;
                        commit('core.dailyLimit.action');
                    },
                }),
            ),
            el('div', { class: 'maestro-m21-actions' }, [
                button({
                    label: t('m21.limits.openSettings'),
                    icon: 'fa-gear',
                    kind: 'ghost',
                    onClick: () => app.ui.openPult(SETTINGS_TAB),
                }),
            ]),
        ]);
    };

    return {
        id: TREASURER_TAB,
        titleKey: 'm21.tab',
        icon: 'fa-coins',
        order: 54,
        render(container) {
            let alive = true;
            let days: SpendSummary[] | null = null;
            let daysFailed = false;
            let chartBox: HTMLElement | null = null;

            const fillChart = (): void => {
                if (!chartBox) return;
                clear(chartBox);
                if (days) chartBox.append(chartView(days));
                else if (daysFailed) chartBox.append(banner(t('m21.days.failed'), 'warn'));
                else chartBox.append(el('div', { class: 'maestro-m21-note', text: t('m21.days.loading') }));
            };

            const loadDays = async (): Promise<void> => {
                try {
                    days = await service.days();
                    daysFailed = false;
                } catch (error) {
                    app.log.debug('treasurer days', error);
                    daysFailed = days === null;
                }
                if (alive) fillChart();
            };

            const draw = (): void => {
                if (!alive) return;
                clear(container);
                chartBox = el('div', { class: 'maestro-m21-days' });
                container.append(
                    el('div', { class: 'maestro-view maestro-m21' }, [
                        el('div', { class: 'maestro-hint', text: t('m21.view.intro') }),
                        el('div', { class: 'maestro-m21-actions' }, [
                            button({
                                label: t('m21.view.refresh'),
                                icon: 'fa-rotate',
                                onClick: () => {
                                    service.process();
                                    refresh();
                                },
                            }),
                        ]),
                        totalsView(),
                        turnsView(),
                        section(t('m21.section.days'), chartBox),
                        limitsView(),
                    ]),
                );
                fillChart();
            };

            const refresh = coalesce(() => {
                draw();
                void loadDays();
            }, 300);
            const offs = [
                service.onChange(refresh),
                app.cost.onChange(refresh),
                app.settings.onChange((path) => {
                    if (path.startsWith('core.dailyLimit') || path === 'core.backgroundDailyCapUsd') refresh();
                }),
            ];
            draw();
            void loadDays();
            return () => {
                alive = false;
                refresh.cancel();
                for (const off of offs) off();
            };
        },
    };
}
