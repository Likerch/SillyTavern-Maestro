import { describe, expect, it } from 'vitest';
import {
    DOC_LIMITS,
    applyBatch,
    batchIsEmpty,
    copyMetricsDoc,
    emptyBatch,
    emptyMetricsDoc,
    freezeDocBaseline,
    normalizeMetricsDoc,
    readCost,
    readTurn,
} from '../../src/domain/metrics-doc';
import type { MetricsBatch } from '../../src/domain/metrics-doc';

const turn = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
    id,
    at,
    type: 'normal',
    device: 'desktop' as const,
    ...extra,
});

describe('reading stored values', () => {
    it('validates turn samples', () => {
        expect(readTurn(null)).toBeNull();
        expect(readTurn({ id: '', at: 1 })).toBeNull();
        expect(readTurn({ id: 'a', at: 'x' })).toBeNull();
        expect(
            readTurn({
                id: 'a',
                at: 5,
                device: 'phone',
                mode: 'balanced',
                auto: true,
                sendMs: 12.5,
                loreChars: 'nope',
                modules: { 'rules.scan': 2, bad: -1, worse: 'x' },
            }),
        ).toEqual({
            id: 'a',
            at: 5,
            type: 'normal',
            device: 'phone',
            mode: 'balanced',
            auto: true,
            sendMs: 12.5,
            modules: { 'rules.scan': 2 },
        });
        expect(readTurn({ id: 'b', at: 1, device: 'tablet', type: 'swipe', modules: {} })).toEqual({
            id: 'b',
            at: 1,
            type: 'swipe',
            device: 'desktop',
        });
    });

    it('validates cost entries', () => {
        expect(readCost({ at: 1, source: 'main', usd: -2, task: 'normal', estimated: true })).toEqual({
            at: 1,
            source: 'main',
            usd: 0,
            task: 'normal',
            estimated: true,
        });
        expect(readCost({ at: 1, usd: 1 })).toBeNull();
        expect(readCost({ at: 1, source: 'main' })).toBeNull();
        expect(readCost('x')).toBeNull();
    });
});

describe('normalizeMetricsDoc', () => {
    it('repairs whatever is stored, in place', () => {
        const raw: Record<string, unknown> = {
            v: 0,
            turns: [turn('a', 2), turn('a', 3), { id: 'bad' }, turn('b', 1)],
            costs: [{ at: 1, source: 'main', usd: 1 }, { at: 1, source: 'main', usd: 1 }, null],
            counters: { x: 2, y: 'z' },
            applied: { t1: 4 },
            baseline: { avgChars: 100, turns: 50, rulesOff: true },
            baselineFrom: 7,
            whatIf: { before: 10, after: 5, ruleIds: ['book.cap', 3] },
        };
        const doc = normalizeMetricsDoc(raw, 99);
        expect(doc).toBe(raw);
        expect(doc.v).toBe(1);
        expect(doc.startedAt).toBe(99);
        expect(doc.turns.map((item) => item.id)).toEqual(['b', 'a']);
        expect(doc.costs).toHaveLength(1);
        expect(doc.counters).toEqual({ x: 2 });
        expect(doc.applied).toEqual({ t1: 4 });
        expect(doc.baseline).toEqual({ avgChars: 100, turns: 50, from: 0, to: 0, rulesOff: true, at: 0 });
        expect(doc.baselineFrom).toBe(7);
        expect(doc.whatIf).toEqual({ at: 0, before: 10, after: 5, ruleIds: ['book.cap'], removed: 0 });
    });

    it('drops broken optional parts and caps the lists', () => {
        const raw: Record<string, unknown> = {
            startedAt: 5,
            turns: Array.from({ length: DOC_LIMITS.turns + 10 }, (_, i) => turn(`t${i}`, i)),
            costs: Array.from({ length: DOC_LIMITS.costs + 5 }, (_, i) => ({ at: i, source: 'main', usd: 1 })),
            baseline: { avgChars: 'x' },
            whatIf: { before: 1 },
            baselineFrom: 'x',
            counters: [],
        };
        const doc = normalizeMetricsDoc(raw);
        expect(doc.startedAt).toBe(5);
        expect(doc.turns).toHaveLength(DOC_LIMITS.turns);
        expect(doc.turns[0]!.id).toBe('t10');
        expect(doc.costs).toHaveLength(DOC_LIMITS.costs);
        expect(doc.baseline).toBeUndefined();
        expect(doc.whatIf).toBeUndefined();
        expect(doc.baselineFrom).toBeUndefined();
        expect(doc.counters).toEqual({});
        expect(normalizeMetricsDoc({}).turns).toEqual([]);
    });
});

describe('applyBatch', () => {
    const batch = (seq: number, patch: Partial<MetricsBatch> = {}): MetricsBatch => ({
        ...emptyBatch('tab-1', seq),
        ...patch,
    });

    it('adds turns, patches them later and merges costs without duplicates', () => {
        const doc = emptyMetricsDoc(1);
        expect(
            applyBatch(
                doc,
                batch(1, { turns: [turn('a', 10, { sendMs: 5 })], costs: [{ at: 1, source: 'main', usd: 1 }] }),
            ),
        ).toBe(true);
        expect(
            applyBatch(
                doc,
                batch(2, {
                    turns: [
                        { id: 'a', loreChars: 300 },
                        { id: 'ghost', loreChars: 1 },
                    ],
                    costs: [
                        { at: 1, source: 'main', usd: 1 },
                        { at: 2, source: 'maestro', usd: 0.1 },
                        { at: 'x' } as never,
                    ],
                }),
            ),
        ).toBe(true);
        expect(doc.turns).toEqual([{ id: 'a', at: 10, type: 'normal', device: 'desktop', sendMs: 5, loreChars: 300 }]);
        expect(doc.costs.map((cost) => cost.source)).toEqual(['main', 'maestro']);
    });

    it('applies a batch only once per tab and sequence', () => {
        const doc = emptyMetricsDoc();
        const first = batch(5, { counters: { 'data.loss': 2, zero: 0, nan: NaN } });
        expect(applyBatch(doc, first)).toBe(true);
        expect(applyBatch(doc, first)).toBe(false);
        expect(applyBatch(doc, batch(4, { counters: { 'data.loss': 1 } }))).toBe(false);
        expect(applyBatch(doc, { ...batch(4, { counters: { 'data.loss': 1 } }), tab: 'tab-2' })).toBe(true);
        expect(doc.counters).toEqual({ 'data.loss': 3 });
        expect(doc.applied).toEqual({ 'tab-1': 5, 'tab-2': 4 });
    });

    it('sets and clears the baseline and the what-if', () => {
        const doc = emptyMetricsDoc();
        const baseline = { avgChars: 1, turns: 1, from: 0, to: 0, rulesOff: true, at: 0 };
        const whatIf = { at: 1, before: 10, after: 4, ruleIds: ['book.cap'], removed: 2 };
        applyBatch(doc, batch(1, { baseline, whatIf, baselineFrom: 3 }));
        expect(doc.baseline).toEqual(baseline);
        expect(doc.whatIf).toEqual(whatIf);
        expect(doc.whatIf).not.toBe(whatIf);
        expect(doc.baselineFrom).toBe(3);
        applyBatch(doc, batch(2, { baseline: null, whatIf: null }));
        expect(doc.baseline).toBeUndefined();
        expect(doc.whatIf).toBeUndefined();
    });

    it('caps counters and remembered tabs', () => {
        const doc = emptyMetricsDoc();
        const counters = Object.fromEntries(Array.from({ length: DOC_LIMITS.counters + 5 }, (_, i) => [`c${i}`, 1]));
        applyBatch(doc, batch(1, { counters }));
        expect(Object.keys(doc.counters)).toHaveLength(DOC_LIMITS.counters);
        for (let i = 0; i < DOC_LIMITS.tabs + 3; i++) applyBatch(doc, { ...emptyBatch(`tab-${i}`, 100 + i) });
        expect(Object.keys(doc.applied)).toHaveLength(DOC_LIMITS.tabs);
        expect(doc.applied['tab-0']).toBeUndefined();
        expect(doc.applied[`tab-${DOC_LIMITS.tabs + 2}`]).toBe(100 + DOC_LIMITS.tabs + 2);
    });

    it('knows an empty batch', () => {
        expect(batchIsEmpty(emptyBatch('t', 1))).toBe(true);
        expect(batchIsEmpty({ ...emptyBatch('t', 1), baselineFrom: 1 })).toBe(false);
        expect(batchIsEmpty({ ...emptyBatch('t', 1), whatIf: null })).toBe(false);
        expect(batchIsEmpty({ ...emptyBatch('t', 1), counters: { a: 1 } })).toBe(false);
    });
});

describe('baseline and copies', () => {
    it('freezes the baseline from turns after baselineFrom, once', () => {
        const doc = emptyMetricsDoc();
        doc.turns = [
            turn('a', 1, { loreChars: 1000 }),
            turn('b', 5, { loreChars: 200 }),
            turn('c', 6, { loreChars: 400 }),
        ];
        doc.baselineFrom = 5;
        expect(freezeDocBaseline(doc, 3, 9)).toBe(false);
        expect(freezeDocBaseline(doc, 2, 9)).toBe(true);
        expect(doc.baseline).toMatchObject({ avgChars: 300, turns: 2, from: 5, to: 6, rulesOff: true, at: 9 });
        expect(freezeDocBaseline(doc, 2, 10)).toBe(false);
    });

    it('copies deeply', () => {
        const doc = emptyMetricsDoc(3);
        doc.turns.push(turn('a', 1, { modules: { x: 1 } }));
        const copy = copyMetricsDoc(doc);
        copy.turns[0]!.modules!.x = 5;
        expect(doc.turns[0]!.modules!.x).toBe(1);
        expect(copy.startedAt).toBe(3);
    });
});
