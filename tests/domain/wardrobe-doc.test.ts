import { describe, expect, it } from 'vitest';
import {
    addSeen,
    dropOutfit,
    emptyWardrobeDoc,
    findOutfit,
    KEEP_HISTORY,
    KEEP_SEEN,
    markUndone,
    normalizeWardrobeDoc,
    noteOutfit,
    pushHistory,
    recentHistory,
} from '../../src/domain/wardrobe-doc';
import type { HistoryEntry, OutfitRecord } from '../../src/domain/wardrobe-doc';

const entry = (op: string, kind: HistoryEntry['kind'], extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
    op,
    kind,
    subject: 'Anna',
    passportId: 'p1',
    state: 'wet',
    enabled: true,
    messageIndex: 3,
    at: 10,
    origin: 'des',
    ...extra,
});

describe('normalizeWardrobeDoc', () => {
    it('gives an empty document for junk', () => {
        expect(normalizeWardrobeDoc(null)).toEqual(emptyWardrobeDoc());
        expect(normalizeWardrobeDoc([1, 2])).toEqual(emptyWardrobeDoc());
    });

    it('repairs records, history, bookkeeping and pointers', () => {
        const doc = normalizeWardrobeDoc({
            outfits: [
                { passportId: 'p1', name: 'blue dress', seenAs: ['синее платье', 3], created: true, origin: 'odd' },
                { name: 'no passport' },
                'junk',
            ],
            history: [
                { op: 'o1', kind: 'place', placeId: 'pl1', undone: true, created: true, enabled: false },
                { op: 'o2', kind: 'weird' },
                { kind: 'outfit' },
            ],
            chars: {
                p1: { wet: { since: 2, missing: -3, stateId: 'wet', suppressed: true }, bad: 'x' },
                '': {},
                p2: 5,
            },
            places: {
                pl1: { night: { since: 1, missing: 1, stateId: 'night', passportId: 'loc', added: ['night'] } },
                pl2: { rain: { since: 1 } },
            },
            lastIndex: 7,
            lastOutfit: { p1: 5, p2: 'x' },
            taken: ['def-1', 2],
        });
        expect(doc.outfits).toEqual([
            {
                passportId: 'p1',
                character: '',
                name: 'blue dress',
                tags: '',
                seenAs: ['синее платье'],
                firstSeen: 0,
                lastSeen: 0,
                lastIndex: -1,
                origin: 'des',
                created: true,
            },
        ]);
        expect(doc.history).toEqual([
            {
                op: 'o1',
                kind: 'place',
                subject: '',
                passportId: '',
                state: '',
                enabled: false,
                messageIndex: -1,
                at: 0,
                origin: 'des',
                created: true,
                undone: true,
                placeId: 'pl1',
            },
        ]);
        expect(doc.chars).toEqual({ p1: { wet: { since: 2, missing: 0, stateId: 'wet', suppressed: true } } });
        expect(doc.places).toEqual({
            pl1: { night: { since: 1, missing: 1, stateId: 'night', passportId: 'loc', added: ['night'] } },
        });
        expect(doc.lastIndex).toBe(7);
        expect(doc.lastOutfit).toEqual({ p1: 5 });
        expect(doc.taken).toEqual(['def-1']);
    });
});

describe('the library', () => {
    it('notes an outfit once and adds its wordings', () => {
        const doc = emptyWardrobeDoc();
        const record = noteOutfit(doc, {
            passportId: 'p1',
            character: 'Anna',
            name: 'blue dress',
            tags: 'blue dress',
            wording: 'синее платье',
            messageIndex: 4,
            origin: 'des',
            at: 100,
            created: true,
        });
        expect(record).toMatchObject({ name: 'blue dress', seenAs: ['синее платье'], firstSeen: 100, created: true });
        noteOutfit(doc, {
            passportId: 'p1',
            character: '',
            name: 'Blue Dress',
            wording: 'синим платьем',
            messageIndex: 2,
            origin: 'revision',
            at: 200,
        });
        expect(doc.outfits).toHaveLength(1);
        expect(findOutfit(doc, 'p1', 'BLUE DRESS')).toMatchObject({
            character: 'Anna',
            seenAs: ['синее платье'],
            lastSeen: 200,
            lastIndex: 4,
            origin: 'des',
        });
        dropOutfit(doc, 'p1', 'blue dress');
        expect(doc.outfits).toEqual([]);
    });

    it('keeps a few distinct wordings', () => {
        const record: OutfitRecord = {
            passportId: 'p1',
            character: 'Anna',
            name: 'x',
            tags: '',
            seenAs: [],
            firstSeen: 0,
            lastSeen: 0,
            lastIndex: -1,
            origin: 'des',
        };
        expect(addSeen(record, '  ')).toBe(false);
        expect(addSeen(record, 'blue dress')).toBe(true);
        expect(addSeen(record, 'Blue  dress')).toBe(false);
        const garments = ['boots', 'cloak', 'hat', 'gloves', 'scarf', 'belt', 'apron', 'vest', 'kilt', 'robe'];
        for (const garment of garments) addSeen(record, `${garment} only`);
        expect(record.seenAs).toHaveLength(KEEP_SEEN);
        expect(record.seenAs[record.seenAs.length - 1]).toBe('robe only');
    });
});

describe('history', () => {
    it('caps, marks undone and filters newest first', () => {
        const doc = emptyWardrobeDoc();
        for (let i = 0; i < KEEP_HISTORY + 5; i++) pushHistory(doc, entry(`o${i}`, 'character'));
        expect(doc.history).toHaveLength(KEEP_HISTORY);
        pushHistory(doc, entry('outfit-1', 'outfit', { state: 'blue dress' }));
        pushHistory(doc, entry('place-1', 'place', { placeId: 'pl1', passportId: 'loc' }));
        expect(markUndone(doc, 'place-1')).toBe(true);
        expect(markUndone(doc, 'nope')).toBe(false);
        expect(recentHistory(doc, { limit: 2 }).map((item) => item.op)).toEqual(['place-1', 'outfit-1']);
        expect(recentHistory(doc, { kind: 'state', limit: 1 })[0]).toMatchObject({ op: 'place-1', undone: true });
        expect(recentHistory(doc, { kind: 'outfit' }).map((item) => item.op)).toEqual(['outfit-1']);
        expect(recentHistory(doc, { placeId: 'pl1' })).toHaveLength(1);
        expect(recentHistory(doc, { passportId: 'loc' })).toHaveLength(1);
    });
});
