import { describe, expect, it } from 'vitest';
import type { LoreEntry } from '../../src/domain/lore-studio-entries';
import {
    CUSTOM_SORT_ID,
    SEARCH_SORT_ID,
    SORT_OPTIONS,
    applyOrder,
    clampedTail,
    moveItem,
    pageOfIndex,
    paginate,
    plainSearch,
    reorderPage,
    sortEntries,
    sortOption,
    totalChars,
    validateApplyOrder,
} from '../../src/domain/lore-studio-sort';

const e = (uid: number, fields: Record<string, unknown> = {}): LoreEntry => ({ uid, order: 100, ...fields });
const uids = (list: LoreEntry[]) => list.map((item) => item.uid);

describe('sort options', () => {
    it('has ST’s 15 option values', () => {
        expect(SORT_OPTIONS.map((option) => option.id).sort((a, b) => a - b)).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        ]);
        expect(sortOption(999).id).toBe(0);
        expect(sortOption(CUSTOM_SORT_ID).rule).toBe('custom');
    });

    it('sorts by priority: constant, normal, disabled; then order desc, uid asc', () => {
        const list = [e(1, { disable: true }), e(2), e(3, { constant: true }), e(4, { order: 200 }), e(0)];
        expect(uids(sortEntries(list, 0))).toEqual([3, 4, 0, 2, 1]);
    });

    it('sorts by display index (custom)', () => {
        const list = [e(1, { displayIndex: 2 }), e(2, { displayIndex: 0 }), e(3)];
        expect(uids(sortEntries(list, 13))).toEqual([2, 1, 3]);
    });

    it('sorts titles with localeCompare and falls back for missing ones', () => {
        const list = [e(1, { comment: 'b' }), e(2, { comment: 'a' }), e(3, { comment: 'c', order: 1 })];
        expect(uids(sortEntries(list, 1))).toEqual([2, 1, 3]);
        expect(uids(sortEntries(list, 2))).toEqual([3, 1, 2]);
        // Non-strings compare as numbers: NaN counts as equal and the secondary key decides.
        const mixed = [e(1, { comment: 'x', order: 1 }), e(2, { order: 5 })];
        expect(uids(sortEntries(mixed, 1))).toEqual([2, 1]);
    });

    it('sorts «tokens» by content length', () => {
        const list = [e(1, { content: 'aaa' }), e(2, { content: 'a' }), e(3, { content: 'aa' })];
        expect(uids(sortEntries(list, 3))).toEqual([2, 3, 1]);
        expect(uids(sortEntries(list, 4))).toEqual([1, 3, 2]);
    });

    it('sorts numbers (depth, order, uid, probability with null as 0)', () => {
        const list = [
            e(1, { depth: 4, probability: null }),
            e(2, { depth: 1, probability: 50 }),
            e(3, { depth: 9, probability: 100 }),
        ];
        expect(uids(sortEntries(list, 5))).toEqual([2, 1, 3]);
        expect(uids(sortEntries(list, 6))).toEqual([3, 1, 2]);
        expect(uids(sortEntries(list, 11))).toEqual([1, 2, 3]);
        expect(uids(sortEntries(list, 12))).toEqual([3, 2, 1]);
        expect(uids(sortEntries(list, 9))).toEqual([1, 2, 3]);
        expect(uids(sortEntries(list, 10))).toEqual([3, 2, 1]);
        const orders = [e(1, { order: 5 }), e(2, { order: 1 })];
        expect(uids(sortEntries(orders, 7))).toEqual([2, 1]);
        expect(uids(sortEntries(orders, 8))).toEqual([1, 2]);
    });

    it('sorts by search score; without scores by order', () => {
        const list = [e(1, { order: 1 }), e(2, { order: 9 }), e(3)];
        const scores = new Map([
            [1, 0.1],
            [2, 0.9],
            [3, 0.5],
        ]);
        expect(uids(sortEntries(list, SEARCH_SORT_ID, scores))).toEqual([1, 3, 2]);
        expect(uids(sortEntries(list, SEARCH_SORT_ID))).toEqual([3, 2, 1]);
    });

    it('does not mutate its input', () => {
        const list = [e(2), e(1)];
        sortEntries(list, 9);
        expect(uids(list)).toEqual([2, 1]);
    });
});

describe('apply sorting as order', () => {
    it('validates start and step', () => {
        expect(validateApplyOrder({ start: -1, step: 1, ascending: false })).toBe('start');
        expect(validateApplyOrder({ start: Number.NaN, step: 1, ascending: false })).toBe('start');
        expect(validateApplyOrder({ start: 0, step: 0, ascending: false })).toBe('step');
        expect(validateApplyOrder({ start: 0, step: 1, ascending: true })).toBeNull();
    });

    it('warns when descending values would go below 0', () => {
        expect(clampedTail(5, { start: 2, step: 1, ascending: false })).toBe(-2);
        expect(clampedTail(3, { start: 2, step: 1, ascending: false })).toBeNull();
        expect(clampedTail(5, { start: 0, step: 1, ascending: true })).toBeNull();
        expect(clampedTail(0, { start: 0, step: 5, ascending: false })).toBeNull();
    });

    it('assigns values in order, clamping at 0 and skipping unchanged', () => {
        const list = [e(1, { order: 10 }), e(2, { order: 5 }), e(3, { order: 0 })];
        expect(applyOrder(list, { start: 10, step: 5, ascending: false })).toEqual([]);
        expect(applyOrder(list, { start: 6, step: 5, ascending: false })).toEqual([
            { uid: 1, order: 6 },
            { uid: 2, order: 1 },
        ]);
        expect(applyOrder(list, { start: 0, step: 2, ascending: true })).toEqual([
            { uid: 1, order: 0 },
            { uid: 2, order: 2 },
            { uid: 3, order: 4 },
        ]);
    });
});

describe('pages and manual order', () => {
    it('paginates with clamping', () => {
        expect(paginate(0, 3, 25)).toEqual({ page: 0, pages: 1, start: 0, end: 0 });
        expect(paginate(60, 1, 25)).toEqual({ page: 1, pages: 3, start: 25, end: 50 });
        expect(paginate(60, 9, 25)).toEqual({ page: 2, pages: 3, start: 50, end: 60 });
        expect(paginate(10, -2, 0).page).toBe(0);
        expect(pageOfIndex(26, 25)).toBe(1);
        expect(pageOfIndex(-1, 25)).toBe(0);
    });

    it('renumbers one page from its smallest display index', () => {
        const entries = {
            1: e(1, { displayIndex: 10 }),
            2: e(2, { displayIndex: 11 }),
            3: e(3, { displayIndex: 12 }),
        };
        expect(reorderPage([3, 1, 2], entries)).toEqual([
            { uid: 3, displayIndex: 10 },
            { uid: 1, displayIndex: 11 },
            { uid: 2, displayIndex: 12 },
        ]);
        expect(reorderPage([1, 2, 3], entries)).toEqual([]);
        expect(reorderPage([42], entries)).toEqual([]);
    });

    it('moves list items', () => {
        expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
        expect(moveItem([1, 2, 3], 2, -5)).toEqual([3, 1, 2]);
        expect(moveItem([1, 2, 3], 7, 0)).toEqual([1, 2, 3]);
    });
});

describe('plain search', () => {
    const list = [
        e(0, { key: ['Anna'], comment: 'Heroine', content: 'Lives in Paris' }),
        e(1, { key: ['Rome'], comment: 'City', content: 'Anna was born here', group: 'places' }),
        e(2, { key: ['Florence'], keysecondary: ['annabelle'], automationId: 'flo' }),
    ];

    it('matches across weighted fields, keys first', () => {
        const scores = plainSearch(list, 'anna');
        expect([...scores.keys()].sort()).toEqual([0, 1, 2]);
        expect((scores.get(0) ?? 1) < (scores.get(1) ?? 0)).toBe(true);
    });

    it('supports Fuse extended operators', () => {
        expect([...plainSearch(list, '^rom').keys()]).toEqual([1]);
        expect([...plainSearch(list, 'paris$').keys()]).toEqual([0]);
        expect([...plainSearch(list, '=city').keys()]).toEqual([1]);
        expect([...plainSearch(list, "'flo").keys()]).toEqual([2]);
        expect([...plainSearch(list, 'anna !rome').keys()].sort()).toEqual([0, 2]);
        expect([...plainSearch(list, '!anna').keys()]).toEqual([]);
        expect(plainSearch(list, '!zzz').get(0)).toBe(0.5);
        expect(plainSearch(list, '   ').size).toBe(0);
        expect(plainSearch(list, '!').size).toBe(0);
        expect([...plainSearch(list, '2').keys()]).toEqual([2]);
    });

    it('counts content characters', () => {
        expect(totalChars([e(1, { content: 'ab' }), e(2)])).toBe(2);
    });
});
