import { describe, expect, it } from 'vitest';
import {
    averageLore,
    costShare,
    costVerdict,
    deviceClass,
    distribution,
    freezeBaseline,
    latencyVerdict,
    loreRatio,
    loreVerdict,
    percentile,
    summarizeLatency,
} from '../../src/domain/metrics-stats';
import type { CostSample, LatencySample, LoreTurn } from '../../src/domain/metrics-stats';

describe('percentile (nearest rank)', () => {
    it('returns a value that really happened', () => {
        const values = [5, 1, 4, 2, 3];
        expect(percentile(values, 50)).toBe(3);
        expect(percentile(values, 95)).toBe(5);
        expect(percentile(values, 0)).toBe(1);
        expect(percentile(values, 100)).toBe(5);
        expect(percentile(values, 20)).toBe(1);
        expect(percentile(values, 21)).toBe(2);
    });

    it('follows the nearest-rank rule on 100 values', () => {
        const values = Array.from({ length: 100 }, (_, i) => i + 1);
        expect(percentile(values, 95)).toBe(95);
        expect(percentile(values, 50)).toBe(50);
        expect(percentile(values, 99.5)).toBe(100);
    });

    it('ignores non-finite values, clamps p and handles empty input', () => {
        expect(percentile([], 50)).toBeUndefined();
        expect(percentile([NaN, Infinity], 50)).toBeUndefined();
        expect(percentile([3, NaN, 1], 50)).toBe(1);
        expect(percentile([1, 2], 150)).toBe(2);
        expect(percentile([1, 2], -5)).toBe(1);
        expect(percentile([1, 2], NaN)).toBe(1);
    });

    it('does not reorder the caller array', () => {
        const values = [3, 1, 2];
        percentile(values, 50);
        expect(values).toEqual([3, 1, 2]);
    });
});

describe('distribution', () => {
    it('summarises finite values', () => {
        expect(distribution([10, 20, 30, 40])).toEqual({ n: 4, p50: 20, p95: 40, max: 40, mean: 25 });
        expect(distribution([])).toEqual({ n: 0 });
        expect(distribution([NaN])).toEqual({ n: 0 });
    });
});

describe('deviceClass', () => {
    it('treats a coarse pointer or a narrow window as a phone', () => {
        expect(deviceClass({ coarsePointer: true, width: 1920 })).toBe('phone');
        expect(deviceClass({ coarsePointer: false, width: 767 })).toBe('phone');
        expect(deviceClass({ coarsePointer: false, width: 768 })).toBe('desktop');
        expect(deviceClass({ width: 1280 })).toBe('desktop');
    });

    it('falls back to desktop without a usable width', () => {
        expect(deviceClass({})).toBe('desktop');
        expect(deviceClass({ width: 0 })).toBe('desktop');
        expect(deviceClass({ width: NaN })).toBe('desktop');
    });
});

describe('latency', () => {
    const samples = (device: 'desktop' | 'phone', values: number[]): LatencySample[] =>
        // Criterion 1 judges Maestro's own share: here it is the given value, the whole ST path is ten times more.
        values.map((maestroMs) => ({ device, sendMs: maestroMs * 10, windowMs: maestroMs * 20, maestroMs }));

    it('splits samples by device and module', () => {
        const summary = summarizeLatency([
            ...samples('desktop', [10, 20, 30]),
            ...samples('phone', [100]),
            { device: 'desktop', sendMs: 40, modules: { 'rules.scan': 3, 'canon.inject': 1 } },
            { device: 'phone', modules: { 'rules.scan': 5 } },
        ]);
        expect(summary.byDevice.desktop.send).toMatchObject({ n: 4, p50: 100, p95: 300 });
        expect(summary.byDevice.desktop.maestro).toMatchObject({ n: 3, p50: 20, p95: 30 });
        expect(summary.byDevice.desktop.window).toMatchObject({ n: 3, max: 600 });
        expect(summary.byDevice.phone.send).toMatchObject({ n: 1, p95: 1000 });
        expect(Object.keys(summary.modules)).toEqual(['canon.inject', 'rules.scan']);
        expect(summary.modules['rules.scan']).toMatchObject({ n: 2, max: 5 });
    });

    it('judges every device with enough samples against its own budget', () => {
        const fast = Array.from({ length: 20 }, () => 50);
        expect(latencyVerdict(summarizeLatency(samples('desktop', fast)))).toBe('ok');
        expect(latencyVerdict(summarizeLatency(samples('desktop', fast.slice(0, 19))))).toBe('none');
        const slowDesktop = [...fast.slice(0, 18), 250, 260];
        expect(latencyVerdict(summarizeLatency(samples('desktop', slowDesktop)))).toBe('warn');
        // 450 ms is fine on a phone, not on a PC.
        const phone = Array.from({ length: 20 }, () => 450);
        expect(latencyVerdict(summarizeLatency(samples('phone', phone)))).toBe('ok');
        expect(latencyVerdict(summarizeLatency(samples('desktop', phone)))).toBe('warn');
        expect(latencyVerdict(summarizeLatency([...samples('desktop', fast), ...samples('phone', [900])]))).toBe('ok');
        expect(latencyVerdict(summarizeLatency([]), 0)).toBe('none');
    });
});

describe('costShare', () => {
    const turns = [{ at: 100 }, { at: 200 }, { at: 300, auto: true }, { at: 400 }];
    const costs: CostSample[] = [
        { at: 50, source: 'maestro', usd: 9 }, // before the window
        { at: 110, source: 'main', usd: 1 },
        { at: 150, source: 'maestro', usd: 0.05 },
        { at: 210, source: 'main', usd: 1 },
        { at: 310, source: 'main', usd: 1 }, // auto-swipe
        { at: 320, source: 'qvink', usd: 0.2 },
        { at: 330, source: 'nai', usd: 0 },
        { at: 410, source: 'main', usd: 1, estimated: true },
        { at: 420, source: 'other', usd: 0.3 },
        { at: NaN, source: 'main', usd: 5 },
        { at: 430, source: 'main', usd: -1 },
    ];

    it('counts Maestro tasks and auto-swipes against the main model in the window', () => {
        const share = costShare(costs, turns, 100);
        expect(share.turns).toBe(4);
        expect(share.from).toBe(100);
        expect(share.mainUsd).toBeCloseTo(3);
        expect(share.maestroUsd).toBeCloseTo(0.05);
        expect(share.autoSwipeUsd).toBeCloseTo(1);
        expect(share.autoSwipes).toBe(1);
        expect(share.backgroundUsd).toBeCloseTo(1.05);
        expect(share.qvinkUsd).toBeCloseTo(0.2);
        expect(share.otherUsd).toBeCloseTo(0.3);
        expect(share.estimated).toBe(3);
        expect(share.share).toBeCloseTo(0.35);
    });

    it('keeps only the newest turns of the window', () => {
        const share = costShare(costs, turns, 2);
        expect(share.turns).toBe(2);
        expect(share.from).toBe(300);
        expect(share.mainUsd).toBeCloseTo(1);
        expect(share.autoSwipeUsd).toBeCloseTo(1);
        expect(share.maestroUsd).toBe(0);
    });

    it('has no share while the main model cost nothing', () => {
        const share = costShare([{ at: 1, source: 'maestro', usd: 1 }], [], 100);
        expect(share.turns).toBe(0);
        expect(share.share).toBeUndefined();
        expect(costVerdict(share)).toBe('none');
    });

    it('a main entry before the first turn of the window stays main', () => {
        const share = costShare([{ at: 100, source: 'main', usd: 2 }], [{ at: 100 }, { at: 50 }], 100);
        expect(share.from).toBe(50);
        expect(share.mainUsd).toBe(2);
    });

    it('needs enough turns for a verdict', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ at: i * 10 }));
        const cheap = costShare(
            [
                { at: 5, source: 'main', usd: 10 },
                { at: 6, source: 'maestro', usd: 1 },
            ],
            many,
        );
        expect(costVerdict(cheap)).toBe('ok');
        const dear = costShare(
            [
                { at: 5, source: 'main', usd: 10 },
                { at: 6, source: 'maestro', usd: 2 },
            ],
            many,
        );
        expect(costVerdict(dear)).toBe('warn');
        expect(costVerdict(dear, 21)).toBe('none');
    });
});

describe('lore baseline and ratio', () => {
    const turns = (values: number[], rules = 0, start = 0): LoreTurn[] =>
        values.map((loreChars, i) => ({ at: start + i, loreChars, loreRules: rules }));

    it('averages the newest turns with lore data', () => {
        expect(averageLore([...turns([100, 200, 300]), { at: 99 }], 2)).toEqual({ avg: 250, turns: 2 });
        expect(averageLore(turns([100, 200]))).toEqual({ avg: 150, turns: 2 });
        expect(averageLore([])).toEqual({ turns: 0 });
        expect(averageLore(turns([100]), 0)).toEqual({ turns: 0 });
    });

    it('freezes the first turns once enough exist', () => {
        expect(freezeBaseline(turns([1, 2]), 3)).toBeUndefined();
        expect(freezeBaseline(turns([1]), 0)).toBeUndefined();
        const baseline = freezeBaseline([...turns([300, 100, 200, 999], 0, 10)], 3, 77)!;
        expect(baseline).toEqual({ avgChars: 200, turns: 3, from: 10, to: 12, rulesOff: true, at: 77 });
        expect(freezeBaseline(turns([1, 2, 3], 2), 3)!.rulesOff).toBe(false);
    });

    it('prefers a what-if, accepts a baseline only when it ran without the rules', () => {
        const whatIf = { at: 1, before: 1000, after: 400, ruleIds: ['book.cap'], removed: 3 };
        expect(loreRatio({ whatIf })).toEqual({ ratio: 0.4, source: 'whatIf' });
        expect(loreVerdict(loreRatio({ whatIf }))).toBe('ok');
        const off = { avgChars: 1000, turns: 50, from: 0, to: 1, rulesOff: true, at: 0 };
        expect(loreRatio({ baseline: off, current: { avg: 600, turns: 20 } })).toEqual({
            ratio: 0.6,
            source: 'baseline',
        });
        expect(loreVerdict(loreRatio({ baseline: off, current: { avg: 600, turns: 20 } }))).toBe('warn');
        expect(loreRatio({ baseline: off, current: { avg: 600, turns: 3 } })).toEqual({ source: 'none' });
        expect(loreRatio({ baseline: off, current: { avg: 600, turns: 3 }, minTurns: 3 }).source).toBe('baseline');
        expect(loreRatio({ baseline: { ...off, rulesOff: false }, current: { avg: 1, turns: 99 } })).toEqual({
            source: 'none',
            baselineWithRules: true,
        });
        expect(loreRatio({ whatIf: { ...whatIf, before: 0 } })).toEqual({ source: 'none' });
        expect(loreVerdict(loreRatio({}))).toBe('none');
    });
});
