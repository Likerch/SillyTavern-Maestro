import { describe, expect, it } from 'vitest';
import { dateKey } from '../../src/core/cost';
import {
    ANLAS_KEY_CAP,
    SPEND_SOURCES,
    addAutoDay,
    addToLines,
    applyOp,
    classifyEntry,
    classifyGeneration,
    dayKey,
    dayRange,
    daySummary,
    emptyDoc,
    emptyLine,
    isAnlasEntry,
    lastDays,
    lineOf,
    mergeAutoDays,
    positive,
    readAutoDays,
    readDay,
    sanitizeDoc,
    summaryOf,
    toSpendLine,
    toSpendLines,
    totalsOf,
    turnList,
} from '../../src/domain/treasurer-spend';
import type { LedgerEntry, LineMap, TreasurerDoc } from '../../src/domain/treasurer-spend';

const entry = (patch: Partial<LedgerEntry> = {}): LedgerEntry => ({
    source: 'main',
    task: 'normal',
    usd: 0.01,
    tokens: { prompt: 100, completion: 20 },
    at: 1000,
    chatId: 'c1',
    ...patch,
});

describe('classification', () => {
    it('maps generation types to sources', () => {
        expect(classifyGeneration('normal', false)).toBe('main');
        expect(classifyGeneration('continue', false)).toBe('main');
        expect(classifyGeneration('impersonate', true)).toBe('main');
        expect(classifyGeneration(undefined, false)).toBe('main');
        expect(classifyGeneration('swipe', false)).toBe('regeneration');
        expect(classifyGeneration('regenerate', false)).toBe('regeneration');
        expect(classifyGeneration('swipe', true)).toBe('autoSwipe');
        expect(classifyGeneration('quiet', false)).toBe('other');
    });

    it('maps core entries to sources', () => {
        expect(classifyEntry({ source: 'main', task: 'swipe' }, true)).toBe('autoSwipe');
        expect(classifyEntry({ source: 'main', task: 'swipe' })).toBe('regeneration');
        expect(classifyEntry({ source: 'qvink' })).toBe('qvink');
        expect(classifyEntry({ source: 'maestro', task: 'revision' })).toBe('maestro');
        expect(classifyEntry({ source: 'nai' })).toBe('nai');
        expect(classifyEntry({ source: 'other' })).toBe('other');
        expect(classifyEntry({ source: 'mystery' })).toBe('other');
        expect(classifyEntry({ source: 'main', task: 'normal', anlas: 5 })).toBe('nai');
        expect(isAnlasEntry({ anlas: 0 })).toBe(false);
        expect(positive(Number.NaN)).toBe(0);
        expect(positive(-3)).toBe(0);
        expect(positive('7')).toBe(0);
    });
});

describe('lines', () => {
    it('adds entries and Anlas, keeping the source order and skipping empty lines', () => {
        const lines: LineMap = {};
        addToLines(lines, 'qvink', entry({ source: 'qvink', usd: 0.002, estimated: true }));
        addToLines(lines, 'main', entry({ tokens: { prompt: 10, completion: 5, cached: 8 } }));
        addToLines(lines, 'main', entry({ usd: 0.02, tokens: undefined }));
        addToLines(lines, 'nai', entry({ source: 'nai', usd: 0, anlas: 17 }));
        lines.other = emptyLine();
        const list = toSpendLines(lines);
        expect(list.map((line) => line.source)).toEqual(['main', 'qvink', 'nai']);
        expect(list[0]).toEqual({
            source: 'main',
            usd: 0.03,
            requests: 2,
            tokens: { prompt: 10, completion: 5, cached: 8 },
            estimated: false,
        });
        expect(list[1]).toMatchObject({ requests: 1, estimated: true, tokens: { prompt: 100, completion: 20 } });
        expect(list[1]!.tokens.cached).toBeUndefined();
        expect(list[2]).toMatchObject({ anlas: 17, requests: 0, usd: 0 });
        expect(totalsOf(list)).toEqual({ usd: 0.032, anlas: 17 });
        const summary = summaryOf('session', 1, 2, list);
        expect(summary).toMatchObject({ period: 'session', from: 1, to: 2, totalUsd: 0.032, totalAnlas: 17 });
        expect(lineOf(list, 'qvink')?.usd).toBe(0.002);
        expect(lineOf(list, 'maestro')).toBeUndefined();
        expect(toSpendLine('other', emptyLine()).anlas).toBeUndefined();
        expect(SPEND_SOURCES).toHaveLength(7);
    });
});

describe('per-chat document', () => {
    it('sanitizes stored data', () => {
        expect(sanitizeDoc(null)).toEqual(emptyDoc());
        const raw = {
            version: 0,
            turns: [
                { messageIndex: 5, at: 50, last: 10, lines: { main: { usd: 0.1, requests: 1 }, bogus: { usd: 9 } } },
                { messageIndex: 2.5, at: 1 },
                'junk',
                { messageIndex: 1, at: -4, lines: 'x' },
            ],
            anlasKeys: ['a', 3, 'b'],
        };
        const doc = sanitizeDoc(raw);
        expect(doc).toBe(raw);
        expect(doc.version).toBe(1);
        expect(doc.turns.map((turn) => turn.messageIndex)).toEqual([1, 5]);
        expect(doc.turns[1]).toMatchObject({ at: 50, last: 50 });
        expect(doc.turns[1]!.lines.main).toMatchObject({ usd: 0.1, requests: 1, anlas: 0 });
        expect(Object.keys(doc.turns[1]!.lines)).toEqual(['main']);
        expect(doc.turns[0]!.lines).toEqual({});
        expect(doc.anlasKeys).toEqual(['a', 'b']);
    });

    it('applies spend in message order, merges turns and caps them', () => {
        const doc: TreasurerDoc = emptyDoc();
        applyOp(doc, { kind: 'spend', turn: 5, source: 'main', entry: entry({ at: 500 }) });
        applyOp(doc, { kind: 'spend', turn: 9, source: 'main', entry: entry({ at: 900 }) });
        applyOp(doc, { kind: 'spend', turn: 1, source: 'qvink', entry: entry({ source: 'qvink', at: 100 }) });
        applyOp(doc, { kind: 'spend', turn: 7, source: 'regeneration', entry: entry({ task: 'swipe', at: 700 }) });
        applyOp(doc, { kind: 'spend', turn: 5, source: 'maestro', entry: entry({ source: 'maestro', at: 400 }) });
        applyOp(doc, { kind: 'spend', turn: 5, source: 'main', entry: entry({ at: 650 }) });
        applyOp(doc, { kind: 'spend', turn: -1, source: 'main', entry: entry() });
        expect(doc.turns.map((turn) => turn.messageIndex)).toEqual([1, 5, 7, 9]);
        const five = doc.turns[1]!;
        expect(five).toMatchObject({ at: 400, last: 650 });
        expect(five.lines.main?.requests).toBe(2);
        expect(five.lines.maestro?.requests).toBe(1);

        applyOp(doc, { kind: 'spend', turn: 11, source: 'main', entry: entry({ at: 1100 }) }, { turns: 3, keys: 5 });
        expect(doc.turns.map((turn) => turn.messageIndex)).toEqual([7, 9, 11]);
        expect(turnList(doc, 2).map((turn) => turn.messageIndex)).toEqual([9, 11]);
        expect(turnList(doc, 0)).toEqual([]);
        expect(turnList(doc, 10)[0]!.lines[0]).toMatchObject({ source: 'regeneration', requests: 1 });
    });

    it('keeps counted NAI keys unique and capped', () => {
        const doc = emptyDoc();
        applyOp(doc, { kind: 'anlasKey', key: 'a' });
        applyOp(doc, { kind: 'anlasKey', key: 'a' });
        expect(doc.anlasKeys).toEqual(['a']);
        for (let i = 0; i < 5; i++) applyOp(doc, { kind: 'anlasKey', key: `k${i}` }, { turns: 10, keys: 3 });
        expect(doc.anlasKeys).toEqual(['k2', 'k3', 'k4']);
        expect(ANLAS_KEY_CAP).toBeGreaterThan(100);
    });
});

describe('dates', () => {
    it('formats like the core meter and lists days oldest first', () => {
        const at = new Date(2026, 9, 4, 13, 30).getTime();
        expect(dayKey(at)).toBe(dateKey(at));
        expect(dayKey(at)).toBe('2026-10-04');
        const range = dayRange('2026-10-04')!;
        expect(range.from).toBe(new Date(2026, 9, 4).getTime());
        expect(range.to).toBe(new Date(2026, 9, 5).getTime() - 1);
        expect(dayRange('04.10.2026')).toBeNull();
        expect(lastDays(at, 3)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
        expect(lastDays(new Date(2026, 2, 1).getTime(), 2)).toEqual(['2026-02-28', '2026-03-01']);
        expect(lastDays(at, 0)).toEqual(['2026-10-04']);
    });
});

describe('day files', () => {
    const file = {
        version: 1,
        date: '2026-10-03',
        totalUsd: 1.5,
        bySource: { main: 1.0, qvink: 0.1, maestro: 0.2, nai: 0.05, other: 0.1, mystery: 0.05, bad: -1 },
        byTask: { normal: 0.4, swipe: 0.3, regenerate: 0.1, quiet: 0.2, revision: 0.2 },
        tokens: { prompt: 1000, completion: 100 },
        requests: 9,
        estimated: 1,
        anlas: 34,
        recent: [
            { source: 'main', task: 'normal', usd: 0.4, at: 1, tokens: { prompt: 300, completion: 30, cached: 200 } },
            { source: 'main', task: 'swipe', usd: 0.2, at: 2, tokens: { prompt: 300, completion: 30 } },
            { source: 'main', task: 'swipe', usd: 0.1, at: 3, tokens: { prompt: 200, completion: 20 } },
            { source: 'qvink', usd: 0.1, at: 4, estimated: true, chatId: null },
            { source: 'nai', usd: 0, at: 5, anlas: 34, chatId: 'c1' },
            { at: 6 },
            'junk',
        ],
    };

    it('reads a day file defensively', () => {
        expect(readDay(file, '2026-10-04')).toBeNull();
        expect(readDay('x', '2026-10-03')).toBeNull();
        const day = readDay(file, '2026-10-03')!;
        expect(day.bySource.bad).toBeUndefined();
        expect(day.recent).toHaveLength(5);
        expect(day.recent[0]!.tokens).toEqual({ prompt: 300, completion: 30, cached: 200 });
        expect(day.recent[3]).toMatchObject({ estimated: true, chatId: null });
        expect(day.recent[4]).toMatchObject({ anlas: 34, chatId: 'c1' });
        expect(readDay({ date: '2026-10-03' }, '2026-10-03')).toMatchObject({ totalUsd: 0, recent: [] });
    });

    it('splits the main model into main, regenerations, auto-swipes and quiet', () => {
        const day = readDay(file, '2026-10-03')!;
        const summary = daySummary(day, '2026-10-03', { usd: 0.1, requests: 1, prompt: 200, completion: 20 });
        expect(summary.period).toBe('day');
        expect(summary.totalUsd).toBe(1.5);
        expect(summary.totalAnlas).toBe(34);
        expect(summary.from).toBe(dayRange('2026-10-03')!.from);
        const usd = Object.fromEntries(summary.lines.map((line) => [line.source, Math.round(line.usd * 1000) / 1000]));
        expect(usd).toEqual({
            main: 0.4,
            regeneration: 0.3,
            autoSwipe: 0.1,
            qvink: 0.1,
            maestro: 0.2,
            nai: 0.05,
            other: 0.35,
        });
        expect(lineOf(summary.lines, 'nai')?.anlas).toBe(34);
        expect(lineOf(summary.lines, 'regeneration')).toMatchObject({
            requests: 1,
            tokens: { prompt: 300, completion: 30 },
        });
        expect(lineOf(summary.lines, 'autoSwipe')).toMatchObject({
            requests: 1,
            tokens: { prompt: 200, completion: 20 },
        });
        expect(lineOf(summary.lines, 'main')?.tokens.cached).toBe(200);
        expect(lineOf(summary.lines, 'qvink')?.estimated).toBe(true);
    });

    it('caps the auto-swipe share by the redo spend and handles an empty day', () => {
        const day = readDay({ ...file, byTask: {}, recent: [] }, '2026-10-03')!;
        const summary = daySummary(day, '2026-10-03', { usd: 5, requests: 0, prompt: 0, completion: 0 });
        expect(lineOf(summary.lines, 'autoSwipe')).toBeUndefined();
        expect(lineOf(summary.lines, 'main')?.usd).toBe(1);
        const empty = daySummary(null, '2026-10-01');
        expect(empty).toMatchObject({ totalUsd: 0, totalAnlas: 0, lines: [] });
        expect(empty.to).toBe(dayRange('2026-10-01')!.to);
        expect(daySummary(null, 'bad').from).toBe(0);
    });
});

describe('auto-swipe day notes', () => {
    it('reads, adds and merges with a cap', () => {
        expect(readAutoDays(null)).toEqual({ version: 1, days: {} });
        const doc = readAutoDays({
            days: { '2026-10-01': { usd: 0.1, requests: 1 }, nope: { usd: 1 }, '2026-10-02': 3 },
        });
        expect(doc.days).toEqual({ '2026-10-01': { usd: 0.1, requests: 1, prompt: 0, completion: 0 } });
        const delta = {};
        addAutoDay(delta, '2026-10-01', entry({ usd: 0.2 }));
        addAutoDay(delta, '2026-10-03', entry({ usd: 0.3, tokens: undefined }));
        const merged = mergeAutoDays(doc, delta, 2);
        expect(Object.keys(merged.days)).toEqual(['2026-10-01', '2026-10-03']);
        expect(merged.days['2026-10-01']).toEqual({
            usd: 0.30000000000000004,
            requests: 2,
            prompt: 100,
            completion: 20,
        });
        expect(merged.days['2026-10-03']).toEqual({ usd: 0.3, requests: 1, prompt: 0, completion: 0 });
        expect(doc.days['2026-10-01']!.requests).toBe(1);
        expect(Object.keys(mergeAutoDays(merged, {}, 1).days)).toEqual(['2026-10-03']);
    });
});
