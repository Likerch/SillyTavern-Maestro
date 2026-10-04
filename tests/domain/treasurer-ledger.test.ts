import { describe, expect, it } from 'vitest';
import { TurnLedger, entryKey } from '../../src/domain/treasurer-ledger';
import type { Assignment } from '../../src/domain/treasurer-ledger';
import type { LedgerEntry } from '../../src/domain/treasurer-spend';

const main = (at: number, task = 'normal', usd = 0.01): LedgerEntry => ({
    source: 'main',
    task,
    usd,
    tokens: { prompt: 100, completion: 10 },
    at,
    chatId: 'c1',
});
const bg = (source: string, at: number, usd = 0.001): LedgerEntry => ({ source, usd, at, chatId: 'c1' });
const anlas = (amount: number, at: number): LedgerEntry => ({ source: 'nai', usd: 0, anlas: amount, at, chatId: 'c1' });

const brief = (list: Assignment[]) => list.map((item) => [item.source, item.turn, item.entry.at]);

function ledger(turn = 3): TurnLedger {
    return new TurnLedger({ chatId: 'c1', turn, since: 0, graceMs: 100, hintTtlMs: 1000 });
}

describe('TurnLedger', () => {
    it('binds a main entry to the reply of its generation, even when the reply comes later', () => {
        const l = ledger();
        l.begin('normal', false, 10);
        const first = l.ingest([main(50)], 60);
        expect(first.fresh.map((item) => item.source)).toEqual(['main']);
        expect(first.assigned).toEqual([]);
        expect(l.waiting()).toBe(1);
        l.reply(5, 70);
        expect(brief(l.ingest([main(50)], 80).assigned)).toEqual([['main', 5, 50]]);
        expect(l.waiting()).toBe(0);
        // A late entry of a resolved generation goes straight to its turn.
        l.end(75);
        expect(brief(l.ingest([main(50), main(76)], 90).assigned)).toEqual([['main', 5, 76]]);
    });

    it('classifies user regenerations, auto-swipes and continues on the same turn', () => {
        const l = ledger();
        l.begin('normal', false, 10);
        l.reply(5, 20);
        l.begin('swipe', false, 30);
        l.reply(5, 40);
        l.begin('swipe', true, 50);
        l.reply(5, 60);
        l.begin('continue', false, 70);
        l.reply(5, 80);
        const result = l.ingest([main(15), main(35, 'swipe'), main(55, 'swipe'), main(75, 'continue')], 90);
        expect(brief(result.assigned)).toEqual([
            ['main', 5, 15],
            ['regeneration', 5, 35],
            ['autoSwipe', 5, 55],
            ['main', 5, 75],
        ]);
        expect(result.fresh.map((item) => item.source)).toEqual(['main', 'regeneration', 'autoSwipe', 'main']);
    });

    it('puts background entries into the turn during which they ran', () => {
        const l = ledger(3);
        // Before any generation: the chat's latest reply.
        let result = l.ingest([bg('qvink', 5)], 6);
        expect(brief(result.assigned)).toEqual([['qvink', 3, 5]]);
        l.begin('normal', false, 10);
        // While the generation runs: waits for its reply.
        result = l.ingest([bg('maestro', 12), main(30)], 31);
        expect(result.assigned).toEqual([]);
        l.reply(5, 40);
        l.end(41);
        result = l.ingest([bg('nai', 45), { ...main(46, 'quiet'), usd: 0.002 }], 50);
        expect(brief(result.assigned)).toEqual([
            ['maestro', 5, 12],
            ['main', 5, 30],
            ['nai', 5, 45],
            ['other', 5, 46],
        ]);
    });

    it('falls back to the current turn for a generation without a reply after the grace', () => {
        const l = ledger(7);
        l.begin('impersonate', false, 10);
        l.end(20);
        expect(l.ingest([main(15, 'impersonate')], 50).assigned).toEqual([]);
        expect(brief(l.ingest([], 130).assigned)).toEqual([['main', 7, 15]]);
    });

    it('settles generations that never replied when a new one starts', () => {
        const l = ledger(2);
        l.begin('normal', false, 10);
        l.ingest([main(15)], 16);
        l.begin('normal', false, 20);
        expect(brief(l.ingest([main(25)], 26).assigned)).toEqual([['main', 2, 15]]);
        l.begin('swipe', false, 30);
        expect(brief(l.ingest([main(35, 'swipe')], 36).assigned)).toEqual([['main', 2, 25]]);
        l.begin('normal', false, 40);
        l.reply(4, 50);
        l.reply(6, 60);
        expect(brief(l.ingest([main(45)], 61).assigned)).toEqual([
            ['regeneration', 2, 35],
            ['main', 4, 45],
        ]);
    });

    it('treats a main entry without a matching generation as background', () => {
        const l = ledger(1);
        l.reply(3, 5);
        expect(brief(l.ingest([main(8, 'regenerate'), { ...main(9), task: undefined }], 10).assigned)).toEqual([
            ['regeneration', 3, 8],
            ['main', 3, 9],
        ]);
        expect(brief(l.ingest([main(2)], 11).assigned)).toEqual([]);
    });

    it('takes each entry once, including identical entries recorded in the same millisecond', () => {
        const l = new TurnLedger({ chatId: 'c1', turn: 0, since: 100 });
        const list = [bg('qvink', 50), bg('qvink', 150), bg('qvink', 150), bg('maestro', 160)];
        expect(l.ingest(list, 200).fresh).toHaveLength(3);
        expect(l.ingest(list, 201).fresh).toHaveLength(0);
        expect(l.ingest([...list, bg('qvink', 160), bg('qvink', 160)], 202).fresh).toHaveLength(2);
        expect(l.ingest([...list, bg('qvink', 160), bg('qvink', 160)], 203).fresh).toHaveLength(0);
        expect(l.ingest([{ ...bg('qvink', 170), at: Number.NaN }], 204).fresh).toHaveLength(0);
        expect(entryKey(anlas(3, 9))).toBe('9|nai|0||3');
    });

    it('ignores entries of other chats and entries without a chat', () => {
        const l = ledger(1);
        const result = l.ingest(
            [
                { ...bg('qvink', 5), chatId: 'other' },
                { ...bg('qvink', 6), chatId: null },
                { ...bg('qvink', 7), chatId: undefined },
            ],
            10,
        );
        expect(brief(result.assigned)).toEqual([['qvink', 1, 7]]);
    });

    it('routes Anlas by hints and the rest by time', () => {
        const l = ledger(9);
        l.hint(0, 2, 10);
        l.hint(12, 4, 100);
        l.hint(20, 6, 100);
        const result = l.ingest([anlas(12, 99), anlas(20, 98), anlas(12, 101), anlas(7, 102)], 103);
        expect(brief(result.assigned)).toEqual([
            ['nai', 6, 98],
            ['nai', 4, 99],
            ['nai', 9, 101],
            ['nai', 9, 102],
        ]);
        l.hint(5, 1, 200);
        expect(brief(l.ingest([anlas(5, 2000)], 2000).assigned)).toEqual([['nai', 9, 2000]]);
        // Far too early for the hint.
        l.hint(8, 1, 10_000);
        expect(brief(l.ingest([anlas(8, 7000)], 10_001).assigned)).toEqual([['nai', 9, 7000]]);
    });

    it('returns waiting entries on reset and starts the next chat clean', () => {
        const l = ledger(3);
        l.begin('normal', false, 10);
        l.ingest([main(20)], 21);
        l.hint(4, 3, 22);
        const leftovers = l.reset('c2', 0, 500);
        expect(brief(leftovers)).toEqual([['main', 3, 20]]);
        expect(l.waiting()).toBe(0);
        const result = l.ingest(
            [
                { ...bg('qvink', 400), chatId: 'c2' },
                { ...anlas(4, 600), chatId: 'c2' },
            ],
            700,
        );
        expect(brief(result.assigned)).toEqual([['nai', 0, 600]]);
        l.reset(null, -1, 100);
        expect(l.ingest([{ ...bg('qvink', 800), chatId: null }], 900).fresh).toEqual([]);
    });

    it('caps its history', () => {
        const l = ledger(0);
        for (let i = 0; i < 110; i++) {
            l.begin('normal', false, i * 10);
            l.reply(i, i * 10 + 5);
        }
        for (let i = 0; i < 60; i++) l.hint(1, i, 1000);
        const result = l.ingest([main(3), main(295), main(1092), anlas(1, 1000)], 1001);
        // Generations and marks that left the window: entries go by the oldest marks kept (or the initial turn).
        expect(brief(result.assigned)).toEqual([
            ['main', 0, 3],
            ['main', 29, 295],
            ['nai', 10, 1000],
            ['main', 109, 1092],
        ]);
        l.end(1200);
        l.end(1201);
        expect(l.waiting()).toBe(0);
    });
});
