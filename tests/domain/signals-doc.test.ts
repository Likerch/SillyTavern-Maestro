import { describe, expect, it } from 'vitest';
import { emptyBaseline, step } from '../../src/domain/signals-diff';
import {
    emptySignalsDoc,
    firstStaleRecord,
    lastRecordIndex,
    lastTrackerRecord,
    messageStamp,
    messagesSince,
    normalizeSignalsDoc,
    pendingSignals,
    rollbackFrom,
    trimRecords,
} from '../../src/domain/signals-doc';
import type { SignalRecord, SignalsDocData } from '../../src/domain/signals-doc';
import type { Signal } from '../../src/shared/contracts';

const signal = (kind: string, messageIndex: number): Signal => ({ kind, chatId: 'c', messageIndex, at: 1 });

function record(index: number, extra: Partial<SignalRecord> = {}): SignalRecord {
    return { index, stamp: `d${index}|0`, tracker: true, at: 1, signals: [], folded: 0, trace: [], ...extra };
}

describe('signals document', () => {
    it('stamps messages by send date and swipe', () => {
        expect(messageStamp({ send_date: 'May 1', swipe_id: 2 })).toBe('May 1|2');
        expect(messageStamp({ send_date: 17, swipe_id: -1 })).toBe('17|0');
        expect(messageStamp({})).toBe('|0');
        expect(messageStamp(null)).toBe('');
    });

    it('repairs stored documents', () => {
        expect(normalizeSignalsDoc(null)).toEqual(emptySignalsDoc());
        const doc = normalizeSignalsDoc({
            records: [
                record(5, {
                    signals: [signal('a', 5), { bad: true } as unknown as Signal],
                    extra: [signal('fact.new', 5)],
                }),
                record(3, { trace: [{ k: 'location' }, { nope: 1 } as never] }),
                record(5),
                { index: 'x' },
                { index: 7, stamp: 3, signals: 'no', data: 1 },
                {
                    index: 8,
                    signals: [{ kind: 'k', chatId: 4, at: 'x', entity: 'e', data: { a: 1 }, messageIndex: 8 }],
                },
            ],
            baseline: { chars: [], names: 'x', aliases: 1, memories: [], quests: {} },
            consumedUpTo: 'x',
            initialized: true,
        });
        expect(doc.records.map((item) => item.index)).toEqual([3, 5, 7, 8]);
        expect(doc.records[0]?.trace).toEqual([{ k: 'location' }]);
        expect(doc.records[1]?.signals).toEqual([signal('a', 5)]);
        expect(doc.records[1]?.extra).toEqual([signal('fact.new', 5)]);
        expect(doc.records[2]).toEqual({
            index: 7,
            stamp: '',
            tracker: false,
            at: 0,
            signals: [],
            folded: 0,
            trace: [],
        });
        expect(doc.records[3]?.signals).toEqual([
            { kind: 'k', chatId: null, at: 0, entity: 'e', data: { a: 1 }, messageIndex: 8 },
        ]);
        expect(doc.baseline).toEqual({ chars: {}, names: {} });
        expect(doc.consumedUpTo).toBe(-1);
        expect(doc.initialized).toBe(true);
        expect(normalizeSignalsDoc({ baseline: 'x' }).baseline).toEqual(emptyBaseline());
    });

    it('finds stale records and rolls back exactly', () => {
        const doc: SignalsDocData = emptySignalsDoc();
        const first = step(doc.baseline, {
            current: { chars: [], location: 'Tavern', quests: null },
            previous: null,
            options: { timeSkipHours: 6, appearanceThreshold: 0.5 },
        });
        doc.records.push(record(1, { trace: first.trace }));
        const second = step(doc.baseline, {
            current: { chars: [], location: 'Tavern, Kitchen', quests: null },
            previous: null,
            options: { timeSkipHours: 6, appearanceThreshold: 0.5 },
        });
        doc.records.push(record(3, { trace: second.trace, tracker: false }));
        expect(doc.baseline.location).toBe('Tavern, Kitchen');
        expect(lastRecordIndex(doc)).toBe(3);
        expect(lastTrackerRecord(doc)?.index).toBe(1);
        const stamps: Record<number, string> = { 1: 'd1|0', 3: 'd3|1' };
        expect(firstStaleRecord(doc, (index) => stamps[index] ?? null)).toBe(3);
        expect(firstStaleRecord(doc, (index) => `d${index}|0`)).toBeNull();
        expect(firstStaleRecord(doc, () => null, 1)).toBe(3);
        expect(rollbackFrom(doc, 3)).toBe(1);
        expect(doc.baseline.location).toBe('Tavern');
        expect(rollbackFrom(doc, 0)).toBe(1);
        expect(doc.baseline.location).toBeUndefined();
        expect(lastRecordIndex(doc)).toBe(-1);
        expect(lastTrackerRecord(doc)).toBeNull();
    });

    it('lists pending signals after the last revision and counts replies', () => {
        const doc = emptySignalsDoc();
        doc.records.push(
            record(1, { signals: [signal('a', 1)] }),
            record(3, { signals: [signal('b', 3)], extra: [signal('fact.new', 3)] }),
            record(5, { signals: [signal('c', 5)] }),
        );
        doc.consumedUpTo = 1;
        expect(pendingSignals(doc).map((item) => item.kind)).toEqual(['b', 'fact.new', 'c']);
        const chat = [
            { is_user: false },
            { is_user: false },
            { is_user: true },
            { is_user: false, is_system: true },
            { is_user: true },
            { is_user: false },
            { is_user: true },
            null,
        ];
        expect(messagesSince(doc, chat)).toBe(1);
        doc.consumedUpTo = -1;
        expect(messagesSince(doc, chat)).toBe(2);
        trimRecords(doc, 2);
        expect(doc.records.map((item) => item.index)).toEqual([3, 5]);
        trimRecords(doc, 0);
        expect(doc.records.map((item) => item.index)).toEqual([5]);
    });
});
