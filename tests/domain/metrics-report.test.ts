import { describe, expect, it } from 'vitest';
import {
    BENCH,
    CRITERIA,
    buildCriteria,
    escapeCell,
    markdownTable,
    overallVerdict,
} from '../../src/domain/metrics-report';
import type { CriteriaInput } from '../../src/domain/metrics-report';
import { costShare, summarizeLatency } from '../../src/domain/metrics-stats';
import { comparePacks, sheetSummary, turnCounts } from '../../src/domain/metrics-checks';

function emptyInput(): CriteriaInput {
    return {
        latency: summarizeLatency([]),
        cost: costShare([], []),
        lore: { ratio: { source: 'none' }, current: { turns: 0 } },
        dropped: turnCounts([]),
        assistantDepth: turnCounts([undefined]),
        tabs: { observedTurns: 0, staleSaves: 0, dataLosses: 0 },
        revision: { decisions: 0, acceptedAsIs: 0, edited: 0, rejected: 0 },
        undo: { actions: 0, undone: 0 },
        living: null,
        sheets: null,
        packs: null,
    };
}

describe('buildCriteria', () => {
    it('lists the ten criteria of plan §14 in order', () => {
        const rows = buildCriteria(emptyInput());
        expect(rows.map((row) => [row.id, row.key])).toEqual(CRITERIA.map((key, i) => [i + 1, key]));
        expect(rows.every((row) => row.status === 'none')).toBe(true);
        expect(rows.map((row) => row.bench)).toEqual(CRITERIA.map((key) => BENCH[key]));
        expect(overallVerdict(rows)).toBe('none');
    });

    it('judges every criterion from its numbers', () => {
        const input = emptyInput();
        input.latency = summarizeLatency(
            Array.from({ length: 20 }, (_, i) => ({ device: 'desktop' as const, sendMs: 900 + i, maestroMs: 40 + i })),
        );
        input.cost = costShare(
            [
                { at: 1, source: 'main', usd: 1 },
                { at: 2, source: 'maestro', usd: 0.1 },
            ],
            Array.from({ length: 20 }, (_, i) => ({ at: i })),
        );
        input.lore = {
            ratio: { ratio: 0.42, source: 'whatIf' },
            current: { avg: 1234.4, turns: 12 },
            whatIf: { at: 1, before: 1000, after: 420, ruleIds: [], removed: 2 },
            baseline: { avgChars: 2000, turns: 50, from: 0, to: 1, rulesOff: true, at: 0 },
        };
        input.dropped = turnCounts(Array.from({ length: 10 }, () => 0));
        input.assistantDepth = turnCounts([2, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
        input.tabs = { observedTurns: 10, staleSaves: 0, dataLosses: 0, blocked: 1, staleEpisodes: 2 };
        input.revision = { decisions: 10, acceptedAsIs: 8, edited: 1, rejected: 1, share: 0.8 };
        input.undo = { actions: 30, undone: 0, share: 0 };
        input.living = { provisional: 10, droppedByUser: 1, contradictedAfterConfirm: 0 };
        input.sheets = sheetSummary([{ index: 1, text: 'no tags here', committed: true }], 0, true);
        input.packs = comparePacks({ Core: { hash: 'a', bytes: 1, at: 0 } }, { Core: { hash: 'a', bytes: 1, at: 0 } });
        const rows = buildCriteria(input);
        const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
        expect(byKey.latency).toMatchObject({
            status: 'ok',
            values: { desktopP95: 58, desktopP50: 49, desktopN: 20, phoneN: 0 },
        });
        expect(byKey.cost).toMatchObject({
            status: 'ok',
            values: { share: 10, turns: 20, backgroundUsd: 0.1, mainUsd: 1 },
        });
        expect(byKey.lore).toMatchObject({
            status: 'ok',
            values: { ratio: 42, source: 'whatIf', current: 1234, baseline: 2000, before: 1000, after: 420 },
        });
        expect(byKey.dropped!.status).toBe('ok');
        expect(byKey.assistantDepth).toMatchObject({
            status: 'warn',
            values: { total: 3, turns: 10, turnsWith: 2, max: 2 },
        });
        expect(byKey.tabs).toMatchObject({ status: 'ok', values: { blocked: 1, staleEpisodes: 2 } });
        expect(byKey.autonomy).toMatchObject({ status: 'ok', values: { revisionShare: 80, undoShare: 0 } });
        expect(byKey.living).toMatchObject({ status: 'ok', values: { dropShare: 10, provisional: 10 } });
        expect(byKey.sheets).toMatchObject({ status: 'warn', values: { sheets: 1, defects: 1, noTags: 1 } });
        expect(byKey.packs).toMatchObject({ status: 'ok', values: { checked: 1, changed: 0, missing: 0 } });
        expect(overallVerdict(rows)).toBe('warn');
        expect(overallVerdict(rows.filter((row) => row.status !== 'warn'))).toBe('ok');
    });

    it('fails the tab criterion on a rollback or a data loss', () => {
        const input = emptyInput();
        input.tabs = { observedTurns: 0, staleSaves: 0, dataLosses: 1 };
        expect(buildCriteria(input).find((row) => row.key === 'tabs')!.status).toBe('warn');
        input.living = { provisional: 0, droppedByUser: 0, contradictedAfterConfirm: 0 };
        expect(buildCriteria(input).find((row) => row.key === 'living')!.values.dropShare).toBeUndefined();
    });
});

describe('markdown', () => {
    it('escapes cells and builds a table', () => {
        expect(escapeCell(' a|b\nc\\ ')).toBe('a\\|b c\\\\');
        expect(markdownTable(['A', 'B'], [['1', 'x|y']])).toBe('| A | B |\n|---|---|\n| 1 | x\\|y |');
    });
});
