import { describe, expect, it } from 'vitest';
import {
    checkEntryMeta,
    emptyEntryMetaFile,
    entryContentHash,
    entryHashes,
    entryMetaKey,
    mergeEntryMeta,
    parseEntryMetaKey,
    readEntryMetaFile,
} from '../../src/domain/roles-meta';

describe('entry meta keys', () => {
    it('round-trips book and uid, also for books with # in the name', () => {
        expect(entryMetaKey('World', 3)).toBe('World#3');
        expect(parseEntryMetaKey('World#3')).toEqual({ book: 'World', uid: 3 });
        expect(parseEntryMetaKey('A#B#12')).toEqual({ book: 'A#B', uid: 12 });
        expect(parseEntryMetaKey('#3')).toBeNull();
        expect(parseEntryMetaKey('World#x')).toBeNull();
        expect(parseEntryMetaKey('World#-1')).toBeNull();
        expect(parseEntryMetaKey('World')).toBeNull();
    });
});

describe('content hashes', () => {
    it('hash the content only', () => {
        const a = entryContentHash({ content: 'Text', key: ['a'] });
        expect(entryContentHash({ content: 'Text', key: ['b'], order: 5 })).toBe(a);
        expect(entryContentHash({ content: 'Text!' })).not.toBe(a);
        expect(entryContentHash(null)).toBe(entryContentHash({ content: '' }));
        expect(entryContentHash({ content: 5 })).toBe(entryContentHash({}));
    });

    it('collects hashes of a book by uid', () => {
        const hashes = entryHashes({
            entries: { '0': { uid: 0, content: 'a' }, '7': { content: 'b' }, x: { content: 'c' }, '9': 'junk' },
        });
        expect([...hashes.keys()].sort()).toEqual([0, 7]);
        expect(hashes.get(7)).toBe(entryContentHash({ content: 'b' }));
        expect(entryHashes(null).size).toBe(0);
    });
});

describe('sidecar file', () => {
    it('drops junk records when read', () => {
        const file = readEntryMetaFile({
            entries: {
                'World#1': { meta: { type: 'place' }, contentHash: 'h', at: 5 },
                'World#2': { meta: { type: 'item' }, contentHash: 'h2' },
                bad: { meta: {}, contentHash: 'h' },
                'World#3': { meta: 'x', contentHash: 'h' },
                'World#4': { meta: {}, contentHash: 4 },
                'World#5': null,
            },
        });
        expect(Object.keys(file.entries)).toEqual(['World#1', 'World#2']);
        expect(file.entries['World#2']?.at).toBe(0);
        expect(readEntryMetaFile(undefined)).toEqual(emptyEntryMetaFile());
    });

    it('reports none, unknown, ok and stale', () => {
        const record = { meta: { type: 'place' }, contentHash: 'h1', at: 1 };
        expect(checkEntryMeta(undefined, 'h1')).toEqual({ state: 'none' });
        expect(checkEntryMeta(record, undefined)).toEqual({ state: 'unknown' });
        expect(checkEntryMeta(record, 'h1')).toEqual({ state: 'ok', meta: { type: 'place' } });
        expect(checkEntryMeta(record, 'h2')).toEqual({ state: 'stale' });
    });

    it('merges another tab’s file with this tab’s changes', () => {
        const stored = readEntryMetaFile({
            entries: {
                'A#1': { meta: { v: 'stored' }, contentHash: 'h', at: 1 },
                'A#2': { meta: { v: 'other tab' }, contentHash: 'h', at: 1 },
                'A#3': { meta: { v: 'deleted here' }, contentHash: 'h', at: 1 },
            },
        });
        const local = readEntryMetaFile({ entries: { 'A#1': { meta: { v: 'mine' }, contentHash: 'h', at: 2 } } });
        const merged = mergeEntryMeta(stored, local, new Set(['A#1', 'A#3']));
        expect(merged.entries['A#1']?.meta).toEqual({ v: 'mine' });
        expect(merged.entries['A#2']?.meta).toEqual({ v: 'other tab' });
        expect(merged.entries['A#3']).toBeUndefined();
    });
});
