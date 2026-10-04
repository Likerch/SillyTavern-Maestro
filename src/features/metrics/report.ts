// Texts of the R3 criteria table (current value, target, how it is measured) and the JSON / Markdown export.
// Numbers come from MetricsService.snapshot(); this file only words and formats them.
import { DEVICES } from '../../domain/metrics-stats';
import type { DeviceClass, Verdict } from '../../domain/metrics-stats';
import { STATUS_MARK, markdownTable } from '../../domain/metrics-report';
import type { CriterionRow } from '../../domain/metrics-report';
import type { I18n } from '../../shared/contracts';
import { formatUsd } from '../../ui/views/format';
import type { MetricsSnapshot } from './service';

export interface CriterionText {
    name: string;
    target: string;
    current: string;
    how: string;
    status: string;
    bench: string;
}

type Values = CriterionRow['values'];

function locale(i18n: I18n): string {
    return i18n.locale() === 'ru' ? 'ru-RU' : 'en-US';
}

export function formatNumber(value: number, i18n: I18n, digits = 0): string {
    try {
        return new Intl.NumberFormat(locale(i18n), { maximumFractionDigits: digits }).format(value);
    } catch {
        return value.toFixed(digits);
    }
}

const num = (values: Values, key: string): number | undefined => {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

function latencyText(values: Values, i18n: I18n): string {
    const t = i18n.t.bind(i18n);
    return DEVICES.map((device: DeviceClass) => {
        const p95 = num(values, `${device}P95`);
        const name = t(`m21m.device.${device}`);
        if (p95 === undefined) return t('m21m.v.latencyNone', { device: name });
        return t('m21m.v.latency', {
            device: name,
            p95: formatNumber(p95, i18n),
            p50: formatNumber(num(values, `${device}P50`) ?? 0, i18n),
            n: num(values, `${device}N`) ?? 0,
        });
    }).join('; ');
}

function currentText(row: CriterionRow, i18n: I18n): string {
    const t = i18n.t.bind(i18n);
    const v = row.values;
    const pct = (key: string) => `${formatNumber(num(v, key) ?? 0, i18n, 1)} %`;
    switch (row.key) {
        case 'latency':
            return latencyText(v, i18n);
        case 'cost': {
            if (num(v, 'share') === undefined) return t('m21m.v.costNone', { turns: num(v, 'turns') ?? 0 });
            const text = t('m21m.v.cost', {
                share: pct('share'),
                background: formatUsd(num(v, 'backgroundUsd') ?? 0, i18n),
                main: formatUsd(num(v, 'mainUsd') ?? 0, i18n),
                turns: num(v, 'turns') ?? 0,
            });
            const swipes = num(v, 'autoSwipes') ?? 0;
            return swipes ? `${text} ${t('m21m.v.costSwipes', { count: swipes })}` : text;
        }
        case 'lore': {
            const current = num(v, 'current');
            if (v.source === 'whatIf') {
                return t('m21m.v.loreWhatIf', {
                    ratio: pct('ratio'),
                    before: formatNumber(num(v, 'before') ?? 0, i18n),
                    after: formatNumber(num(v, 'after') ?? 0, i18n),
                });
            }
            if (v.source === 'baseline') {
                return t('m21m.v.loreBaseline', {
                    ratio: pct('ratio'),
                    current: formatNumber(current ?? 0, i18n),
                    baseline: formatNumber(num(v, 'baseline') ?? 0, i18n),
                });
            }
            if (current === undefined) return t('m21m.noData');
            return t('m21m.v.loreCurrent', { current: formatNumber(current, i18n), turns: num(v, 'turns') ?? 0 });
        }
        case 'dropped':
        case 'assistantDepth': {
            const turns = num(v, 'turns') ?? 0;
            if (!turns) return row.key === 'dropped' ? t('m21m.v.droppedNone') : t('m21m.noData');
            return t(`m21m.v.${row.key}`, { with: num(v, 'turnsWith') ?? 0, turns, max: num(v, 'max') ?? 0 });
        }
        case 'tabs': {
            const text = t('m21m.v.tabs', {
                stale: num(v, 'staleSaves') ?? 0,
                losses: num(v, 'dataLosses') ?? 0,
                episodes: num(v, 'staleEpisodes') ?? 0,
            });
            const blocked = num(v, 'blocked');
            return blocked === undefined ? text : `${text} ${t('m21m.v.tabsBlocked', { blocked })}`;
        }
        case 'autonomy': {
            const revision =
                num(v, 'revisionShare') === undefined
                    ? t('m21m.v.revisionNone')
                    : t('m21m.v.revision', { share: pct('revisionShare'), decisions: num(v, 'decisions') ?? 0 });
            const undo =
                num(v, 'undoShare') === undefined
                    ? t('m21m.v.undoNone')
                    : t('m21m.v.undo', { share: pct('undoShare'), actions: num(v, 'actions') ?? 0 });
            return `${revision}; ${undo}`;
        }
        case 'living':
            return num(v, 'provisional') === undefined
                ? t('m21m.v.livingNone')
                : t('m21m.v.living', {
                      share: num(v, 'dropShare') === undefined ? '—' : pct('dropShare'),
                      provisional: num(v, 'provisional') ?? 0,
                      contradicted: num(v, 'contradicted') ?? 0,
                  });
        case 'sheets': {
            if (!num(v, 'sheets')) return t('m21m.v.sheetsNone');
            const text = t('m21m.v.sheets', { sheets: num(v, 'sheets') ?? 0, defects: num(v, 'defects') ?? 0 });
            const parts = (['tail', 'tracker', 'notCollapsed', 'noTags'] as const)
                .filter((key) => (num(v, key) ?? 0) > 0)
                .map((key) => t(`m21m.v.sheet.${key}`, { count: num(v, key) ?? 0 }));
            return parts.length ? `${text} (${parts.join(', ')})` : text;
        }
        case 'packs':
            return num(v, 'checked')
                ? t('m21m.v.packs', {
                      checked: num(v, 'checked') ?? 0,
                      changed: num(v, 'changed') ?? 0,
                      missing: num(v, 'missing') ?? 0,
                  })
                : t('m21m.v.packsNone');
    }
}

export function statusLabel(status: Verdict, i18n: I18n): string {
    return `${STATUS_MARK[status]} ${i18n.t(`m21m.status.${status}`)}`;
}

export function criterionText(row: CriterionRow, i18n: I18n): CriterionText {
    const t = i18n.t.bind(i18n);
    return {
        name: t(`m21m.c.${row.key}.name`),
        target: t(`m21m.c.${row.key}.target`),
        current: currentText(row, i18n),
        how: t(`m21m.c.${row.key}.how`),
        status: statusLabel(row.status, i18n),
        bench: t(`m21m.bench.${row.bench}`),
    };
}

function iso(at: number): string {
    try {
        return new Date(at).toISOString();
    } catch {
        return String(at);
    }
}

export function renderMarkdown(snapshot: MetricsSnapshot, i18n: I18n): string {
    const t = i18n.t.bind(i18n);
    const { report, latency } = snapshot;
    const lines: string[] = [];
    lines.push(`# ${t('m21m.export.title')}`, '');
    lines.push(
        t('m21m.export.meta', {
            at: iso(report.generatedAt),
            turns: report.turns,
            since: iso(report.startedAt),
            device: t(`m21m.device.${report.device}`),
        }),
        '',
    );
    lines.push(
        markdownTable(
            [
                '№',
                t('m21m.col.criterion'),
                t('m21m.col.target'),
                t('m21m.col.current'),
                t('m21m.col.status'),
                t('m21m.col.how'),
                t('m21m.col.bench'),
            ],
            report.rows.map((row) => {
                const text = criterionText(row, i18n);
                return [String(row.id), text.name, text.target, text.current, text.status, text.how, text.bench];
            }),
        ),
        '',
    );
    lines.push(`## ${t('m21m.section.latency')}`, '');
    lines.push(
        markdownTable(
            [t('m21m.col.device'), t('m21m.col.samples'), 'p50', 'p95', 'max', t('m21m.col.window'), t('m21m.col.own')],
            DEVICES.map((device) => {
                const row = latency.byDevice[device];
                const ms = (value: number | undefined) => (value === undefined ? '—' : formatNumber(value, i18n, 1));
                return [
                    t(`m21m.device.${device}`),
                    String(row.send.n),
                    ms(row.send.p50),
                    ms(row.send.p95),
                    ms(row.send.max),
                    ms(row.window.p95),
                    ms(row.maestro.p95),
                ];
            }),
        ),
        '',
    );
    const modules = Object.entries(latency.modules);
    if (modules.length) {
        lines.push(`## ${t('m21m.section.modules')}`, '');
        lines.push(
            markdownTable(
                [t('m21m.col.module'), t('m21m.col.samples'), 'p50', 'p95'],
                modules.map(([label, stats]) => [
                    label,
                    String(stats.n),
                    formatNumber(stats.p50 ?? 0, i18n, 2),
                    formatNumber(stats.p95 ?? 0, i18n, 2),
                ]),
            ),
            '',
        );
    }
    const cost = snapshot.cost;
    lines.push(`## ${t('m21m.section.cost')}`, '');
    lines.push(
        `- ${t('m21m.cost.main')}: ${formatUsd(cost.mainUsd, i18n)}`,
        `- ${t('m21m.cost.maestro')}: ${formatUsd(cost.maestroUsd, i18n)}`,
        `- ${t('m21m.cost.autoSwipes')}: ${formatUsd(cost.autoSwipeUsd, i18n)} (${cost.autoSwipes})`,
        `- ${t('m21m.cost.qvink')}: ${formatUsd(cost.qvinkUsd, i18n)}`,
        `- ${t('m21m.cost.other')}: ${formatUsd(cost.otherUsd, i18n)}`,
        `- ${t('m21m.cost.window', { turns: cost.turns })}`,
        '',
    );
    return lines.join('\n');
}

export function renderJson(snapshot: MetricsSnapshot, i18n: I18n): string {
    const { report } = snapshot;
    const payload = {
        format: 'maestro-r3-metrics',
        version: 1,
        generatedAt: iso(report.generatedAt),
        since: iso(report.startedAt),
        turns: report.turns,
        device: report.device,
        criteria: report.rows.map((row) => ({ ...row, text: criterionText(row, i18n) })),
        latency: snapshot.latency,
        cost: snapshot.cost,
        lore: snapshot.lore,
        counters: snapshot.counters,
        idle: snapshot.idle,
        dataLossSamples: snapshot.losses.length,
    };
    return JSON.stringify(payload, null, 2);
}
