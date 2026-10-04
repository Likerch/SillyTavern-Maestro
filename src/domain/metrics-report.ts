// The R3 criteria table (plan §14 пп. 1-10): one row per criterion with its verdict and the numbers behind it, and
// a Markdown renderer for the export. Pure: texts come from the feature (i18n), numbers from metrics-stats/-checks.
import { autonomyVerdict, livingVerdict, packVerdict, sheetVerdict, zeroVerdict } from './metrics-checks';
import type {
    LivingCounts,
    PackComparison,
    RevisionShare,
    SheetSummary,
    TurnCounts,
    UndoShare,
} from './metrics-checks';
import { costVerdict, latencyVerdict, loreVerdict } from './metrics-stats';
import type { CostShare, LatencySummary, LoreBaseline, LoreRatio, LoreWhatIf, Verdict } from './metrics-stats';

export type CriterionKey =
    'latency' | 'cost' | 'lore' | 'dropped' | 'assistantDepth' | 'tabs' | 'autonomy' | 'living' | 'sheets' | 'packs';

/** Order of plan §14. */
export const CRITERIA: readonly CriterionKey[] = [
    'latency',
    'cost',
    'lore',
    'dropped',
    'assistantDepth',
    'tabs',
    'autonomy',
    'living',
    'sheets',
    'packs',
];

/**
 * What the bench (mock model, recorded reference chat, tools/stand/measure.mjs) can prove: 'yes' fully, 'partly'
 * (synthetic prices, a desktop CPU emulating a phone, two tabs by hand), 'no' (needs real play and decisions).
 */
export const BENCH: Readonly<Record<CriterionKey, 'yes' | 'partly' | 'no'>> = {
    latency: 'partly',
    cost: 'partly',
    lore: 'yes',
    dropped: 'yes',
    assistantDepth: 'yes',
    tabs: 'partly',
    autonomy: 'no',
    living: 'no',
    sheets: 'yes',
    packs: 'yes',
};

export const STATUS_MARK: Readonly<Record<Verdict, string>> = { ok: '✅', warn: '⚠', none: '—' };

export interface CriteriaInput {
    latency: LatencySummary;
    cost: CostShare;
    lore: {
        ratio: LoreRatio;
        current: { avg?: number; turns: number };
        baseline?: LoreBaseline;
        whatIf?: LoreWhatIf;
    };
    /** Per turn where the Qvink check applied: prompt entries dropped without a summary. */
    dropped: TurnCounts;
    /** Turns with lore data, and assistant-role activations at depth over them. */
    assistantDepth: TurnCounts;
    tabs: { observedTurns: number; staleSaves: number; blocked?: number; staleEpisodes?: number; dataLosses: number };
    revision: RevisionShare;
    undo: UndoShare;
    living: LivingCounts | null;
    sheets: SheetSummary | null;
    packs: PackComparison | null;
}

export type CriterionValues = Record<string, number | string | undefined>;

export interface CriterionRow {
    /** 1-10 as in plan §14. */
    id: number;
    key: CriterionKey;
    status: Verdict;
    values: CriterionValues;
    bench: 'yes' | 'partly' | 'no';
}

const round = (value: number | undefined, digits = 0): number | undefined => {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

const percent = (share: number | undefined): number | undefined =>
    share === undefined ? undefined : round(share * 100, 1);

function row(key: CriterionKey, status: Verdict, values: CriterionValues): CriterionRow {
    return { id: CRITERIA.indexOf(key) + 1, key, status, values, bench: BENCH[key] };
}

export function buildCriteria(input: CriteriaInput): CriterionRow[] {
    const { latency, cost, lore, dropped, assistantDepth, tabs, revision, undo, living, sheets, packs } = input;
    // Criterion 1 is Maestro's ADDED latency: its interceptor and its listeners on the send path, not ST's own work.
    const desktop = latency.byDevice.desktop.maestro;
    const phone = latency.byDevice.phone.maestro;
    const tabIncidents = tabs.staleSaves + tabs.dataLosses;
    const sheetDefects = sheets ? sheets.findings.length : 0;
    return [
        row('latency', latencyVerdict(latency), {
            desktopP95: round(desktop.p95),
            desktopP50: round(desktop.p50),
            desktopN: desktop.n,
            phoneP95: round(phone.p95),
            phoneP50: round(phone.p50),
            phoneN: phone.n,
        }),
        row('cost', costVerdict(cost), {
            share: percent(cost.share),
            turns: cost.turns,
            backgroundUsd: round(cost.backgroundUsd, 4),
            mainUsd: round(cost.mainUsd, 4),
            autoSwipes: cost.autoSwipes,
        }),
        row('lore', loreVerdict(lore.ratio), {
            ratio: percent(lore.ratio.ratio),
            source: lore.ratio.source,
            current: round(lore.current.avg),
            turns: lore.current.turns,
            baseline: round(lore.baseline?.avgChars),
            before: lore.whatIf?.before,
            after: lore.whatIf?.after,
        }),
        row('dropped', zeroVerdict(dropped.turns, dropped.turnsWith), { ...dropped }),
        row('assistantDepth', zeroVerdict(assistantDepth.turns, assistantDepth.turnsWith), { ...assistantDepth }),
        row('tabs', zeroVerdict(tabs.observedTurns, tabIncidents), {
            staleSaves: tabs.staleSaves,
            blocked: tabs.blocked,
            staleEpisodes: tabs.staleEpisodes,
            dataLosses: tabs.dataLosses,
            turns: tabs.observedTurns,
        }),
        row('autonomy', autonomyVerdict(revision, undo), {
            revisionShare: percent(revision.share),
            decisions: revision.decisions,
            undoShare: percent(undo.share),
            actions: undo.actions,
        }),
        row('living', livingVerdict(living), {
            dropShare:
                living && living.provisional > 0 ? percent(living.droppedByUser / living.provisional) : undefined,
            provisional: living?.provisional,
            contradicted: living?.contradictedAfterConfirm,
        }),
        row('sheets', sheets ? sheetVerdict(sheets) : 'none', {
            sheets: sheets?.sheets ?? 0,
            defects: sheetDefects,
            tail: sheets?.tail,
            tracker: sheets?.tracker,
            notCollapsed: sheets?.notCollapsed,
            noTags: sheets?.noTags,
        }),
        row('packs', packVerdict(packs), {
            checked: packs?.checked ?? 0,
            changed: packs?.changed.length,
            missing: packs?.missing.length,
        }),
    ];
}

/** Overall verdict: any ⚠ → warn; all measured ✅ → ok; nothing measured → none. */
export function overallVerdict(rows: readonly CriterionRow[]): Verdict {
    if (rows.some((item) => item.status === 'warn')) return 'warn';
    return rows.some((item) => item.status === 'ok') ? 'ok' : 'none';
}

/* ------------------------------------------------------------------ Markdown */

/** A table cell: pipes escaped, line breaks flattened. */
export function escapeCell(text: string): string {
    return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
    const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
    return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}
