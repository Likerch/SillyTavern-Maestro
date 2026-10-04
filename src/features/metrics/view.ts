// Pult tab «Замеры» (M21m): the R3 criteria table (criterion, target, now, status, how measured), the details behind
// it (send path per device, module timings, spend, lore, pack files, data-loss warnings) and the export.
import { DEVICES } from '../../domain/metrics-stats';
import type { Distribution } from '../../domain/metrics-stats';
import { overallVerdict } from '../../domain/metrics-report';
import type { CriterionRow } from '../../domain/metrics-report';
import type { App, PultTab } from '../../shared/contracts';
import { banner, emptyState, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { coalesce, formatTime, formatUsd } from '../../ui/views/format';
import { criterionText, formatNumber } from './report';
import type { MetricsService, MetricsSnapshot } from './service';

export const METRICS_TAB = 'metrics';

export const M21M_CSS = `
.maestro-m21m-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
.maestro-m21m-status { white-space: nowrap; font-weight: 600; }
.maestro-m21m-ok { color: var(--maestro-ok, #4a9d5b); }
.maestro-m21m-warn { color: var(--maestro-warn, #d08a2c); }
.maestro-m21m-none { opacity: 0.7; }
.maestro-m21m-target { font-size: 0.85em; opacity: 0.8; margin-top: 2px; }
.maestro-m21m-how { font-size: 0.85em; opacity: 0.85; }
.maestro-m21m-bench { font-size: 0.8em; opacity: 0.7; margin-top: 2px; font-style: italic; }
.maestro-m21m-line { margin: 3px 0; overflow-wrap: anywhere; }
.maestro-m21m-note { font-size: 0.9em; opacity: 0.85; }
.maestro-m21m-out { width: 100%; min-height: 8em; font-family: monospace; font-size: 0.8em; }
`;

/** The async Clipboard API exists only in secure contexts; ST often runs over plain HTTP on a LAN or a VPS. */
async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to execCommand
    }
    const area = el('textarea', { attrs: { readonly: true, 'aria-hidden': 'true' } });
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
    }
}

export function metricsTab(app: App, service: MetricsService): PultTab {
    const i18n = app.i18n;
    const t = i18n.t.bind(i18n);
    const ms = (value: number | undefined, digits = 0): string =>
        value === undefined ? '—' : formatNumber(value, i18n, digits);

    const criteriaTable = (rows: CriterionRow[]): HTMLElement =>
        table(
            [
                { key: 'id', label: '№', cell: (row) => String(row.id), numeric: true },
                {
                    key: 'criterion',
                    label: t('m21m.col.criterion'),
                    cell: (row) => {
                        const text = criterionText(row, i18n);
                        return [
                            el('div', { text: text.name }),
                            el('div', {
                                class: 'maestro-m21m-target',
                                text: `${t('m21m.col.target')}: ${text.target}`,
                            }),
                        ];
                    },
                },
                { key: 'current', label: t('m21m.col.current'), cell: (row) => criterionText(row, i18n).current },
                {
                    key: 'status',
                    label: t('m21m.col.status'),
                    cell: (row) =>
                        el('span', {
                            class: ['maestro-m21m-status', `maestro-m21m-${row.status}`],
                            text: criterionText(row, i18n).status,
                        }),
                },
                {
                    key: 'how',
                    label: t('m21m.col.how'),
                    cell: (row) => {
                        const text = criterionText(row, i18n);
                        return [
                            el('div', { class: 'maestro-m21m-how', text: text.how }),
                            el('div', { class: 'maestro-m21m-bench', text: text.bench }),
                        ];
                    },
                },
            ],
            rows,
            { caption: t('m21m.section.criteria') },
        );

    const distributionTable = (entries: [string, Distribution][]): HTMLElement =>
        table(
            [
                { key: 'module', label: t('m21m.col.module'), cell: ([label]) => label },
                { key: 'n', label: t('m21m.col.samples'), cell: ([, stats]) => String(stats.n), numeric: true },
                { key: 'p50', label: 'p50', cell: ([, stats]) => ms(stats.p50, 2), numeric: true },
                { key: 'p95', label: 'p95', cell: ([, stats]) => ms(stats.p95, 2), numeric: true },
            ],
            entries,
        );

    const latencyView = (snapshot: MetricsSnapshot): HTMLElement => {
        const parts: Child[] = [
            table(
                [
                    { key: 'device', label: t('m21m.col.device'), cell: (device) => t(`m21m.device.${device}`) },
                    {
                        key: 'n',
                        label: t('m21m.col.samples'),
                        cell: (device) => String(snapshot.latency.byDevice[device].send.n),
                        numeric: true,
                    },
                    {
                        key: 'p50',
                        label: 'p50',
                        cell: (device) => ms(snapshot.latency.byDevice[device].send.p50),
                        numeric: true,
                    },
                    {
                        key: 'p95',
                        label: 'p95',
                        cell: (device) => ms(snapshot.latency.byDevice[device].send.p95),
                        numeric: true,
                    },
                    {
                        key: 'window',
                        label: t('m21m.col.window'),
                        cell: (device) => ms(snapshot.latency.byDevice[device].window.p95),
                        numeric: true,
                    },
                    {
                        key: 'own',
                        label: t('m21m.col.own'),
                        cell: (device) => ms(snapshot.latency.byDevice[device].maestro.p95, 1),
                        numeric: true,
                    },
                ],
                [...DEVICES],
            ),
        ];
        const modules = Object.entries(snapshot.latency.modules);
        if (modules.length) parts.push(section(t('m21m.section.modules'), distributionTable(modules)));
        const idle = Object.entries(snapshot.idle);
        if (idle.length) parts.push(section(t('m21m.section.idle'), distributionTable(idle)));
        return section(t('m21m.section.latency'), parts);
    };

    const costView = (snapshot: MetricsSnapshot): HTMLElement => {
        const cost = snapshot.cost;
        const line = (label: string, value: string) =>
            el('div', { class: 'maestro-m21m-line', text: `${label}: ${value}` });
        return section(t('m21m.section.cost'), [
            line(t('m21m.cost.main'), formatUsd(cost.mainUsd, i18n)),
            line(t('m21m.cost.maestro'), formatUsd(cost.maestroUsd, i18n)),
            line(t('m21m.cost.autoSwipes'), `${formatUsd(cost.autoSwipeUsd, i18n)} (${cost.autoSwipes})`),
            line(t('m21m.cost.qvink'), formatUsd(cost.qvinkUsd, i18n)),
            line(t('m21m.cost.other'), formatUsd(cost.otherUsd, i18n)),
            el('div', { class: 'maestro-m21m-note', text: t('m21m.cost.window', { turns: cost.turns }) }),
        ]);
    };

    const loreView = (snapshot: MetricsSnapshot, rerender: () => void, note: (text: string) => void): HTMLElement => {
        const { lore } = snapshot;
        const lines: Child[] = [];
        if (lore.whatIf) {
            const ratio = lore.whatIf.before > 0 ? (lore.whatIf.after / lore.whatIf.before) * 100 : 0;
            lines.push(
                el('div', {
                    class: 'maestro-m21m-line',
                    text: t('m21m.lore.whatIf', {
                        before: formatNumber(lore.whatIf.before, i18n),
                        after: formatNumber(lore.whatIf.after, i18n),
                        ratio: `${formatNumber(ratio, i18n, 1)} %`,
                        removed: lore.whatIf.removed,
                    }),
                }),
            );
        }
        if (lore.baseline) {
            lines.push(
                el('div', {
                    class: 'maestro-m21m-line',
                    text: t('m21m.lore.baseline', {
                        avg: formatNumber(lore.baseline.avgChars, i18n),
                        turns: lore.baseline.turns,
                        rules: t(lore.baseline.rulesOff ? 'm21m.lore.baselineOff' : 'm21m.lore.baselineOn'),
                    }),
                }),
            );
        } else {
            const withLore = snapshot.input.assistantDepth.turns;
            lines.push(
                el('div', {
                    class: 'maestro-m21m-note',
                    text: t('m21m.lore.baselinePending', { size: service.baselineSize(), turns: withLore }),
                }),
            );
        }
        if (lore.current.avg !== undefined) {
            lines.push(
                el('div', {
                    class: 'maestro-m21m-line',
                    text: t('m21m.lore.current', {
                        avg: formatNumber(lore.current.avg, i18n),
                        turns: lore.current.turns,
                    }),
                }),
            );
        }
        lines.push(
            el('div', { class: 'maestro-m21m-actions' }, [
                button({
                    label: t('m21m.action.compareLore'),
                    icon: 'fa-scale-balanced',
                    onClick: async () => {
                        const result = await service.compareLore();
                        if (!result) note(t('m21m.compareLore.none'));
                        rerender();
                    },
                }),
                button({
                    label: t('m21m.action.resetBaseline'),
                    icon: 'fa-rotate-left',
                    kind: 'ghost',
                    onClick: async () => {
                        await service.resetBaseline();
                        rerender();
                    },
                }),
            ]),
        );
        return section(t('m21m.section.lore'), lines);
    };

    const packsView = (snapshot: MetricsSnapshot, rerender: () => void): HTMLElement => {
        const packs = snapshot.input.packs;
        const lines: Child[] = [];
        if (packs && snapshot.packsCheckedAt !== undefined) {
            lines.push(
                el('div', {
                    class: 'maestro-m21m-note',
                    text: t('m21m.packs.checkedAt', { at: formatTime(snapshot.packsCheckedAt, i18n) }),
                }),
            );
            const list = (key: string, names: string[]) =>
                names.length
                    ? el('div', { class: 'maestro-m21m-line', text: t(key, { list: names.join(', ') }) })
                    : null;
            lines.push(
                list('m21m.packs.changedList', packs.changed),
                list('m21m.packs.missingList', packs.missing),
                list('m21m.packs.addedList', packs.added),
            );
        }
        lines.push(
            el('div', { class: 'maestro-m21m-actions' }, [
                button({
                    label: t('m21m.action.checkPacks'),
                    icon: 'fa-fingerprint',
                    onClick: async () => {
                        await service.checkPacks();
                        rerender();
                    },
                }),
                button({
                    label: t('m21m.action.acceptPacks'),
                    icon: 'fa-check-double',
                    kind: 'ghost',
                    onClick: async () => {
                        if (!(await app.ui.confirm(t('m21m.acceptPacks.title'), t('m21m.acceptPacks.body')))) return;
                        await service.acceptPacks();
                        rerender();
                    },
                }),
            ]),
        );
        return section(t('m21m.section.packs'), lines);
    };

    const lossesView = (snapshot: MetricsSnapshot): HTMLElement =>
        section(
            t('m21m.section.losses'),
            snapshot.losses.length
                ? snapshot.losses.map((text) => el('div', { class: 'maestro-m21m-line', text }))
                : el('div', { class: 'maestro-m21m-note', text: t('m21m.losses.none') }),
        );

    return {
        id: METRICS_TAB,
        titleKey: 'm21m.tab',
        icon: 'fa-gauge-high',
        order: 90,
        render(container) {
            let alive = true;
            let noteText = '';
            let output = '';

            const draw = async (): Promise<void> => {
                const snapshot = await service.snapshot();
                if (!alive) return;
                clear(container);
                const rerender = () => void draw();
                const note = (text: string) => {
                    noteText = text;
                };
                const intro = el('div', { class: 'maestro-hint', text: t('m21m.view.intro') });
                if (!snapshot.chatId) {
                    container.append(intro, emptyState(t('m21m.view.noChat'), 'fa-comments'));
                    return;
                }
                if (app.host.isGroupChat()) {
                    container.append(intro, banner(t('m21m.view.group'), 'info'));
                    return;
                }
                const overall = overallVerdict(snapshot.report.rows);
                const exportButton = (label: string, format: 'json' | 'markdown') =>
                    button({
                        label,
                        icon: format === 'json' ? 'fa-code' : 'fa-file-lines',
                        onClick: async () => {
                            const text = await service.exportReport(format);
                            const copied = await copyText(text);
                            noteText = copied ? t('m21m.copied') : t('m21m.copyFailed');
                            output = copied ? '' : text;
                            rerender();
                        },
                    });
                const area = output ? el('textarea', { class: 'maestro-m21m-out', attrs: { readonly: true } }) : null;
                if (area) area.value = output;
                container.append(
                    intro,
                    el('div', {
                        class: 'maestro-m21m-line',
                        text: t('m21m.view.summary', {
                            turns: snapshot.report.turns,
                            since: formatTime(snapshot.report.startedAt, i18n),
                            device: t(`m21m.device.${snapshot.report.device}`),
                        }),
                    }),
                    banner(
                        t(`m21m.view.overall.${overall}`),
                        overall === 'ok' ? 'ok' : overall === 'warn' ? 'warn' : 'info',
                        overall === 'ok' ? 'fa-circle-check' : 'fa-gauge-high',
                    ),
                    el('div', { class: 'maestro-m21m-actions' }, [
                        button({ label: t('m21m.action.refresh'), icon: 'fa-rotate', onClick: rerender }),
                        exportButton(t('m21m.action.copyMd'), 'markdown'),
                        exportButton(t('m21m.action.copyJson'), 'json'),
                        noteText ? el('span', { class: 'maestro-m21m-note', text: noteText }) : null,
                    ]),
                    area ?? '',
                    section(t('m21m.section.criteria'), criteriaTable(snapshot.report.rows)),
                    latencyView(snapshot),
                    costView(snapshot),
                    loreView(snapshot, rerender, note),
                    packsView(snapshot, rerender),
                    lossesView(snapshot),
                );
            };

            const refresh = coalesce(() => void draw(), 300);
            const off = service.onChange(refresh);
            void draw();
            return () => {
                alive = false;
                off();
                refresh.cancel();
            };
        },
    };
}
