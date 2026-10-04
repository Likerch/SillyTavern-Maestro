import { describe, expect, it } from 'vitest';
import {
    SCAN_STATE,
    ScanCollector,
    assembleRecord,
    attributeVia,
    captureEntry,
    entryId,
} from '../../src/domain/lore-scan';
import { finalList, scanPayloads, wiEntry } from '../helpers/lore-fixtures';

const globals = { caseSensitive: false, matchWholeWords: false };

describe('captureEntry', () => {
    it('copies identity, placement, keys and scan options', () => {
        const key = ['Anna'];
        const raw = wiEntry('World', 7, {
            comment: 'Anna',
            content: 'Anna is a ranger.',
            key,
            keysecondary: ['forest', 3],
            position: 4,
            depth: 2,
            role: 1,
            order: 50,
            constant: true,
            preventRecursion: true,
            caseSensitive: true,
            matchWholeWords: false,
            scanDepth: 6,
            matchScenario: true,
            extensions: { lorebook_localizer: {} },
        });
        const entry = captureEntry(raw, 2, 1);
        expect(entry).toMatchObject({
            world: 'World',
            uid: 7,
            comment: 'Anna',
            content: 'Anna is a ranger.',
            position: 4,
            depth: 2,
            role: 1,
            order: 50,
            constant: true,
            preventRecursion: true,
            key: ['Anna'],
            keysecondary: ['forest'],
            caseSensitive: true,
            matchWholeWords: false,
            scanDepth: 6,
            flags: { matchScenario: true },
            loop: 2,
            recursionLevel: 1,
        });
        // A copy: never the alias of ST's cached array.
        expect(entry?.key).not.toBe(key);
        expect(entry?.extensions).toBe(raw.extensions);
    });

    it('fills defaults and rejects entries without identity', () => {
        const entry = captureEntry({ world: 'W', uid: '3' }, 1, 0);
        expect(entry).toMatchObject({
            uid: 3,
            comment: '',
            content: '',
            position: 0,
            order: 100,
            caseSensitive: null,
            scanDepth: null,
        });
        expect(entry).not.toHaveProperty('depth');
        expect(entry).not.toHaveProperty('flags');
        expect(captureEntry(null, 1, 0)).toBeNull();
        expect(captureEntry({ world: 1, uid: 1 }, 1, 0)).toBeNull();
        expect(captureEntry({ world: 'W', uid: 'x' }, 1, 0)).toBeNull();
    });

    it('builds unambiguous ids', () => {
        expect(entryId('a.b', 1)).not.toBe(entryId('a', 1));
    });
});

describe('ScanCollector', () => {
    const a = wiEntry('W', 1, { content: 'Anna lives in the Silver Tower.' });
    const b = wiEntry('W', 2, { key: ['silver tower'], content: 'The tower is tall.' });
    const c = wiEntry('Other', 3, { key: ['tall'], content: 'Tall things.' });
    const big = wiEntry('W', 4, { content: 'x'.repeat(100) });

    it('records loops, recursion levels, budget cuts and the final list', () => {
        const collector = new ScanCollector('normal', 'chat-1', 1000);
        expect(collector.hasData()).toBe(false);
        const loops = [
            { activated: [a], budget: 500 },
            { current: SCAN_STATE.RECURSION, activated: [b] },
            { current: SCAN_STATE.RECURSION, activated: [c], cut: [big], overflowed: true },
        ];
        for (const payload of scanPayloads(loops)) collector.scanDone(payload);
        expect(collector.isComplete()).toBe(true);
        collector.activatedFinal(finalList(loops));
        expect(collector.hasData()).toBe(true);
        expect(collector.loops()).toBe(3);
        expect(collector.budget()).toBe(1000);
        expect(collector.overflow()).toBe(true);
        expect(collector.startedAt).toBe(1000);
        expect(collector.chatId).toBe('chat-1');
        const rows = collector.result();
        expect(rows.map((row) => [row.uid, row.loop, row.recursionLevel, row.cut])).toEqual([
            [1, 1, 0, undefined],
            [2, 2, 1, undefined],
            [3, 3, 2, undefined],
            [4, 3, 2, 'budget'],
        ]);
    });

    it('marks entries removed after our listener and those cut by Maestro', () => {
        const collector = new ScanCollector('normal');
        for (const payload of scanPayloads([{ activated: [a, b, c] }, { activated: [], cut: [big] }])) {
            collector.scanDone(payload);
        }
        collector.markCut('W', 2);
        collector.markCut('W', 4);
        collector.activatedFinal([a, b]);
        const cut = Object.fromEntries(collector.result().map((row) => [row.uid, row.cut]));
        expect(cut).toEqual({ 1: undefined, 2: 'maestro', 3: 'other', 4: 'maestro' });
    });

    it('tells a budget cut from an entry another listener removed', () => {
        const collector = new ScanCollector('normal');
        for (const payload of scanPayloads([
            { activated: [a], cut: [b] },
            { activated: [], cut: [c], overflowed: true },
        ])) {
            collector.scanDone(payload);
        }
        const cut = Object.fromEntries(collector.result().map((row) => [row.uid, row.cut]));
        expect(cut).toEqual({ 1: undefined, 2: 'other', 3: 'budget' });
    });

    it('takes final content and entries it did not see in the loops', () => {
        const collector = new ScanCollector('normal');
        for (const payload of scanPayloads([{ activated: [a], cut: [big] }])) collector.scanDone(payload);
        collector.activatedFinal([{ ...a, content: 'substituted' }, big, 'junk']);
        const rows = collector.result();
        expect(rows.find((row) => row.uid === 1)?.content).toBe('substituted');
        expect(rows.find((row) => row.uid === 4)?.cut).toBeUndefined();
        collector.activatedFinal('not a list');
    });

    it('restarts on a new scan and ignores scans after completion', () => {
        const collector = new ScanCollector('normal');
        const first = scanPayloads([{ activated: [a] }, { activated: [b] }], { lastNext: 2 });
        for (const payload of first) collector.scanDone(payload);
        expect(collector.isComplete()).toBe(false);
        // Another loop 1: someone else's scan started; the latest one wins.
        for (const payload of scanPayloads([{ activated: [c] }])) collector.scanDone(payload);
        expect(collector.result().map((row) => row.uid)).toEqual([3]);
        expect(collector.isComplete()).toBe(true);
        for (const payload of scanPayloads([{ activated: [big] }])) collector.scanDone(payload);
        expect(collector.result().map((row) => row.uid)).toEqual([3]);
    });

    it('survives malformed payloads', () => {
        const collector = new ScanCollector('normal');
        collector.scanDone(null);
        collector.scanDone({
            state: { next: 2 },
            activated: { entries: 'nope' },
            new: { successful: [null] },
            budget: 5,
        });
        expect(collector.loops()).toBe(1);
        expect(collector.result()).toEqual([]);
        collector.scanDone({ state: 'x', activated: { entries: new Map([['k', null]]) } });
        expect(collector.loops()).toBe(2);
    });

    it('treats min-activation loops as direct matches', () => {
        const collector = new ScanCollector('normal');
        for (const payload of scanPayloads([
            { activated: [] },
            { current: SCAN_STATE.MIN_ACTIVATIONS, activated: [a] },
        ])) {
            collector.scanDone(payload);
        }
        expect(collector.result()[0]).toMatchObject({ loop: 2, recursionLevel: 0 });
    });
});

describe('attributeVia', () => {
    it('finds the entry of an earlier loop whose content holds the key, most recent loop first', () => {
        const root = captureEntry(wiEntry('W', 1, { content: 'Anna and the Silver Tower.' }), 1, 0)!;
        const middle = captureEntry(wiEntry('W', 2, { content: 'The silver tower is tall.' }), 2, 1)!;
        const leaf = captureEntry(wiEntry('W', 3, { key: ['silver tower'] }), 3, 2)!;
        const blocked = captureEntry(wiEntry('W', 4, { content: 'dragon', preventRecursion: true }), 1, 0)!;
        const dragon = captureEntry(wiEntry('W', 5, { key: ['dragon'] }), 2, 1)!;
        const direct = captureEntry(wiEntry('W', 6, { key: ['anna'] }), 1, 0)!;
        const removed = { ...captureEntry(wiEntry('W', 7, { content: 'griffin' }), 1, 0)!, cut: 'other' as const };
        const griffin = captureEntry(wiEntry('W', 8, { key: ['griffin'] }), 2, 1)!;
        const via = attributeVia([root, middle, leaf, blocked, dragon, direct, removed, griffin], globals);
        expect(via.get(entryId('W', 3))).toEqual({ world: 'W', uid: 2 });
        expect(via.get(entryId('W', 2))).toBeUndefined();
        expect(via.has(entryId('W', 5))).toBe(false);
        expect(via.has(entryId('W', 6))).toBe(false);
        expect(via.has(entryId('W', 8))).toBe(false);
    });
});

describe('assembleRecord', () => {
    it('builds rows and totals of entries that reached the prompt', () => {
        const kept = captureEntry(
            wiEntry('Maestro · канон · 1', 1, { content: 'abcd', position: 4, depth: 2, role: 0 }),
            1,
            0,
        )!;
        const cut = { ...captureEntry(wiEntry('W', 2, { content: 'efghij' }), 1, 0)!, cut: 'budget' as const };
        const removed = { ...captureEntry(wiEntry('W', 3, { content: 'zz' }), 1, 0)!, cut: 'other' as const };
        const record = assembleRecord([kept, cut, removed], {
            messageIndex: 5,
            at: 123,
            generationType: 'swipe',
            budgetTokens: 900,
            overflow: true,
            simulated: true,
            tokens: (entry) => entry.content.length * 10,
            tags: (entry) => (entry.uid === 1 ? ['canon'] : []),
            via: new Map([[entryId('W', 2), { world: 'W', uid: 1 }]]),
        });
        expect(record).toMatchObject({
            messageIndex: 5,
            at: 123,
            generationType: 'swipe',
            totalChars: 4,
            totalTokens: 40,
            canonChars: 4,
            overflow: true,
            budgetTokens: 900,
            simulated: true,
        });
        expect(record.activations[0]).toMatchObject({ depth: 2, role: 0, chars: 4, tags: ['canon'] });
        expect(record.activations[1]).toMatchObject({ cut: true, cutBy: 'budget', via: { world: 'W', uid: 1 } });
        expect(record.activations[2]).toMatchObject({ cut: true });
        expect(record.activations[2]).not.toHaveProperty('cutBy');
        const plainRecord = assembleRecord([], {
            messageIndex: 1,
            at: 1,
            generationType: 'normal',
            overflow: false,
            tokens: () => 0,
            tags: () => [],
        });
        expect(plainRecord).not.toHaveProperty('budgetTokens');
        expect(plainRecord).not.toHaveProperty('simulated');
    });
});
