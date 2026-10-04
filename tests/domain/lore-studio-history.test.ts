import { describe, expect, it } from 'vitest';
import {
    HISTORY_LIMIT,
    emptyHistory,
    pushVersions,
    readHistory,
    versionCount,
    versionsOf,
} from '../../src/domain/lore-studio-history';
import type { HistoryVersion } from '../../src/domain/lore-studio-history';

const version = (at: number, content: string, by = 'user'): HistoryVersion => ({
    at,
    by,
    summary: `s${at}`,
    entry: { uid: 1, content },
});

describe('entry history', () => {
    it('repairs stored documents', () => {
        expect(readHistory(null, 'Book')).toEqual(emptyHistory('Book'));
        expect(readHistory({ entries: [] }, 'Book').entries).toEqual({});
        const doc = readHistory(
            { book: 'Old', entries: { 1: [version(1, 'a'), { at: 'x' }, 'junk'], 2: 'bad', 3: [{ at: 1, by: 'u' }] } },
            'Book',
        );
        expect(doc.book).toBe('Book');
        expect(Object.keys(doc.entries)).toEqual(['1']);
        expect(doc.entries['1']).toHaveLength(1);
    });

    it('keeps the newest versions, newest first, without duplicates', () => {
        let doc = emptyHistory('Book');
        doc = pushVersions(doc, [{ uid: 1, version: version(1, 'a') }]);
        doc = pushVersions(doc, [{ uid: 1, version: version(2, 'a') }]);
        doc = pushVersions(doc, [{ uid: 1, version: version(3, 'b', 'M6') }]);
        const list = versionsOf(doc, 1);
        expect(list.map((item) => item.entry.content)).toEqual(['b', 'a']);
        expect(list[0]?.by).toBe('M6');
        list[0]!.entry.content = 'changed';
        expect(versionsOf(doc, 1)[0]?.entry.content).toBe('b');
        expect(versionsOf(doc, 9)).toEqual([]);
        expect(versionCount(doc)).toBe(2);
    });

    it('limits versions per entry', () => {
        let doc = emptyHistory('Book');
        for (let i = 0; i < HISTORY_LIMIT + 5; i++) doc = pushVersions(doc, [{ uid: 1, version: version(i, `v${i}`) }]);
        const list = versionsOf(doc, 1);
        expect(list).toHaveLength(HISTORY_LIMIT);
        expect(list[0]?.entry.content).toBe(`v${HISTORY_LIMIT + 4}`);
        expect(pushVersions(doc, [{ uid: 2, version: version(1, 'x') }], 1).entries['2']).toHaveLength(1);
    });
});
