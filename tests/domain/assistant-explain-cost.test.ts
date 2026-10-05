import { describe, expect, it } from 'vitest';
import { COST_HINT_TEXT, costHints, costTotals } from '../../src/domain/assistant-explain-cost';
import type { CostLineLike } from '../../src/domain/assistant-explain-cost';

function line(source: string, usd: number, prompt = 0, completion = 0, cached?: number): CostLineLike {
    return { source, usd, requests: 1, tokens: { prompt, completion, ...(cached === undefined ? {} : { cached }) } };
}

describe('costTotals', () => {
    it('sums every line and takes the cache share of the main generations', () => {
        const totals = costTotals([
            line('main', 0.02, 10000, 500, 6000),
            line('regeneration', 0.01, 10000, 400, 0),
            line('qvink', 0.001, 2000, 100, 2000),
            { ...line('nai', 0), anlas: 20 },
        ]);
        expect(totals).toEqual({
            usd: 0.031,
            anlas: 20,
            requests: 4,
            prompt: 22000,
            completion: 1000,
            cached: 8000,
            cacheShare: 0.3,
        });
        expect(costTotals([line('qvink', 0.001, 100)]).cacheShare).toBeNull();
    });
});

describe('costHints', () => {
    const codes = (lines: CostLineLike[], extra: Partial<Parameters<typeof costHints>[0]> = {}) =>
        costHints({ lines, ...extra }).map((hint) => hint.code);

    it('finds retries, auto-swipes, a low cache, a big prompt and a long reply', () => {
        expect(
            codes([
                line('main', 0.05, 70000, 2000, 1000),
                { ...line('regeneration', 0.04), requests: 2 },
                line('autoSwipe', 0.04),
            ]),
        ).toEqual(['retries', 'autoSwipe', 'lowCache', 'bigPrompt', 'longReply']);
        const hints = costHints({ lines: [line('main', 0.01, 10000, 100, 1000)] });
        expect(hints).toEqual([{ code: 'lowCache', detail: '10%' }]);
    });

    it('does not complain about a small or well-cached prompt', () => {
        expect(codes([line('main', 0.01, 5000, 100, 0)])).toEqual([]);
        expect(codes([line('main', 0.01, 20000, 100, 15000)])).toEqual([]);
        expect(codes([line('regeneration', 0, 0, 0)].map((item) => ({ ...item, requests: 0 })))).toEqual([]);
    });

    it('reads the prompt weights by source kind', () => {
        expect(codes([line('main', 0.01)], { promptByKind: { lore: 4000, history: 5000 } })).toEqual(['loreHeavy']);
        expect(codes([line('main', 0.01)], { promptByKind: { lore: 100, history: 9000, preset: 900 } })).toEqual([
            'historyHeavy',
        ]);
        expect(codes([line('main', 0.01)], { promptByKind: {} })).toEqual([]);
    });

    it('finds background work, pictures, above-average turns and estimates', () => {
        expect(codes([line('main', 0.01), line('maestro', 0.004), line('qvink', 0.002)])).toEqual(['background']);
        expect(codes([line('main', 0.01), { ...line('nai', 0), anlas: 30 }])).toEqual(['images']);
        expect(costHints({ lines: [line('main', 0), line('nai', 0.02)] })[0]).toEqual({
            code: 'images',
            detail: '$0.02',
        });
        expect(costHints({ lines: [line('main', 0.03)], averageUsd: 0.01 })).toEqual([
            { code: 'aboveAverage', detail: '×3' },
        ]);
        expect(codes([line('main', 0.011)], { averageUsd: 0.01 })).toEqual([]);
        expect(codes([{ ...line('main', 0.01), estimated: true }])).toEqual(['estimated']);
    });

    it('has a text for every hint in both languages', () => {
        expect(Object.keys(COST_HINT_TEXT.ru)).toEqual(Object.keys(COST_HINT_TEXT.en));
    });
});
