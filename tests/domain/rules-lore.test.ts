import { describe, expect, it } from 'vitest';
import {
    bookVersion,
    compareBookRecency,
    diffActivations,
    duplicateSignature,
    estimateTokens,
    findCrossBookDuplicates,
    isLimit,
    isOldBookName,
    isPlainObject,
    normalizeKeyList,
    planBookCaps,
} from '../../src/domain/rules-lore';
import type { CapActivation, LoreEntryLike } from '../../src/domain/rules-lore';

const wi = (world: string, uid: number, fields: Partial<LoreEntryLike> = {}): LoreEntryLike => ({
    world,
    uid,
    key: ['<INTJ-U>'],
    keysecondary: [],
    content: 'The architect.',
    ...fields,
});

describe('estimateTokens', () => {
    it('divides characters by 3.6 and rounds up', () => {
        expect(estimateTokens(0)).toBe(0);
        expect(estimateTokens(-5)).toBe(0);
        expect(estimateTokens(36)).toBe(10);
        expect(estimateTokens(37)).toBe(11);
    });
});

describe('normalizeKeyList / duplicateSignature', () => {
    it('normalises keys: trim, lower case, unique, sorted, strings only', () => {
        expect(normalizeKeyList([' B', 'a', 'A', '', 3, 'b'])).toBe('a\u0001b');
        expect(normalizeKeyList('x')).toBe('');
    });

    it('signs keys and exact content; empty content has no signature', () => {
        expect(duplicateSignature(wi('A', 1))).toBe(duplicateSignature(wi('B', 2, { key: ['<intj-u> '] })));
        expect(duplicateSignature(wi('A', 1))).not.toBe(duplicateSignature(wi('B', 2, { content: 'The architect. ' })));
        expect(duplicateSignature(wi('A', 1))).not.toBe(duplicateSignature(wi('B', 2, { keysecondary: ['x'] })));
        expect(duplicateSignature(wi('A', 1, { content: '  ' }))).toBeNull();
        expect(duplicateSignature(wi('A', 1, { content: 5 }))).toBeNull();
    });
});

describe('book recency', () => {
    it('reads versions from names', () => {
        expect(bookVersion('MBTI V2')).toEqual([2]);
        expect(bookVersion('MBTI v1')).toEqual([1]);
        expect(bookVersion('✩°｡⋆🥕BUNNYMO🥕⋆｡°✩ V3.0')).toEqual([3, 0]);
        expect(bookVersion('Pack version 4')).toEqual([4]);
        expect(bookVersion('Pack 1.2.1')).toEqual([1, 2, 1]);
        expect(bookVersion('Species (Old Versions)')).toEqual([]);
        expect(bookVersion('Species')).toEqual([]);
    });

    it('spots old copies', () => {
        expect(isOldBookName('BunnyMo Pastures (Old Versions)')).toBe(true);
        expect(isOldBookName('MBTI legacy')).toBe(true);
        expect(isOldBookName('Лорбук копия')).toBe(true);
        expect(isOldBookName('Старая книга')).toBe(true);
        expect(isOldBookName('Golden Bold')).toBe(false);
        expect(isOldBookName('MBTI V2')).toBe(false);
    });

    it('orders: not old, then version, then size, then name', () => {
        expect(compareBookRecency('MBTI V2', 'MBTI v1')).toBeGreaterThan(0);
        expect(compareBookRecency('MBTI v1', 'MBTI V2')).toBeLessThan(0);
        expect(compareBookRecency('MBTI V3 (old)', 'MBTI V2')).toBeLessThan(0);
        expect(compareBookRecency('Pack 1.10', 'Pack 1.9')).toBeGreaterThan(0);
        expect(compareBookRecency('BunnyMo V3.0', 'BunnyMo V3')).toBeGreaterThan(0);
        const sizes = new Map([
            ['Species', 111],
            ['Species---A', 12],
        ]);
        expect(compareBookRecency('Species', 'Species---A', sizes)).toBeGreaterThan(0);
        expect(compareBookRecency('Alpha', 'Beta')).toBeGreaterThan(0);
        expect(compareBookRecency('Beta', 'Alpha')).toBeLessThan(0);
        expect(compareBookRecency('Same', 'Same')).toBe(0);
    });
});

describe('findCrossBookDuplicates', () => {
    it('keeps the copy of the newest book and drops the others', () => {
        const old = wi('MBTI v1', 1);
        const fresh = wi('MBTI V2', 7);
        const third = wi('MBTI Editions', 3);
        const groups = findCrossBookDuplicates([old, fresh, third]);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.world).toBe('MBTI V2');
        expect(groups[0]!.keep).toEqual([fresh]);
        expect(groups[0]!.drop).toEqual([old, third]);
    });

    it('ignores different texts, single books, disabled and empty entries', () => {
        const groups = findCrossBookDuplicates([
            wi('A', 1),
            wi('B', 1, { content: 'Different.' }),
            wi('A', 2, { key: ['x'] }),
            wi('A', 3, { key: ['x'] }),
            wi('C', 4, { key: ['y'], disable: true }),
            wi('D', 4, { key: ['y'] }),
            wi('E', 5, { content: '' }),
            wi('F', 5, { content: '' }),
        ]);
        expect(groups).toEqual([]);
    });

    it('keeps every copy inside the winning book', () => {
        const a1 = wi('Pack V2', 1);
        const a2 = wi('Pack V2', 2);
        const b = wi('Pack V1', 1);
        const [group] = findCrossBookDuplicates([b, a1, a2]);
        expect(group!.keep).toEqual([a1, a2]);
        expect(group!.drop).toEqual([b]);
    });

    it('uses entry counts per book as the size tie-break unless sizes are given', () => {
        const merged = [wi('Species', 1), wi('Species', 2, { key: ['<ELF>'], content: 'Elves.' })];
        const split = wi('Species---E', 9, { key: ['<ELF>'], content: 'Elves.' });
        expect(findCrossBookDuplicates([...merged, split])[0]!.world).toBe('Species');
        const sizes = new Map([['Species---E', 500]]);
        expect(findCrossBookDuplicates([...merged, split], sizes)[0]!.world).toBe('Species---E');
    });
});

describe('planBookCaps', () => {
    const act = (key: string, fields: Partial<CapActivation> = {}): CapActivation => ({
        key,
        world: 'Big',
        order: 100,
        priority: 0,
        tokens: 100,
        isNew: true,
        ...fields,
    });

    it('cuts new activations deeper than the recursion limit', () => {
        const cuts = planBookCaps(
            [act('Big.1'), act('Big.2', { isNew: false }), act('Other.3', { world: 'Other' })],
            { Big: { maxRecursionLevel: 1 } },
            2,
        );
        expect(cuts).toEqual([{ key: 'Big.1', world: 'Big', reason: 'recursion' }]);
        expect(planBookCaps([act('Big.1')], { Big: { maxRecursionLevel: 1 } }, 1)).toEqual([]);
        expect(planBookCaps([act('Big.1')], { Big: { maxRecursionLevel: 0 } }, 1)).toHaveLength(1);
    });

    it('keeps higher order first within the token cap and cuts from the first overflow on', () => {
        const cuts = planBookCaps(
            [
                act('Big.low', { order: 10, tokens: 50 }),
                act('Big.high', { order: 300, tokens: 150 }),
                act('Big.mid', { order: 200, tokens: 100, priority: 2 }),
                act('Big.mid2', { order: 200, tokens: 10, priority: 1 }),
            ],
            { Big: { maxTokens: 260 } },
            0,
        );
        // high 150 + mid2 10 = 160, mid would make 260 (fits), low 50 → 310 overflows.
        expect(cuts.map((cut) => cut.key)).toEqual(['Big.low']);
        const tight = planBookCaps(
            [
                act('Big.a', { order: 300, tokens: 150 }),
                act('Big.b', { order: 200, tokens: 200 }),
                act('Big.c', { order: 100, tokens: 1 }),
            ],
            { Big: { maxTokens: 200 } },
            0,
        );
        expect(tight.map((cut) => cut.key)).toEqual(['Big.b', 'Big.c']);
        expect(tight.every((cut) => cut.reason === 'tokens')).toBe(true);
    });

    it('does not count recursion cuts against the token cap and ignores books without limits', () => {
        const cuts = planBookCaps(
            [act('Big.deep', { order: 999, tokens: 500 }), act('Big.ok', { order: 1, tokens: 100, isNew: false })],
            { Big: { maxTokens: 100, maxRecursionLevel: 0 }, Free: {} },
            1,
        );
        expect(cuts).toEqual([{ key: 'Big.deep', world: 'Big', reason: 'recursion' }]);
        expect(planBookCaps([act('Free.1', { world: 'Free' })], { Free: { maxTokens: 0 } }, 3)).toEqual([]);
    });

    it('validates limits', () => {
        expect(isLimit(0)).toBe(true);
        expect(isLimit(-1)).toBe(false);
        expect(isLimit(Number.NaN)).toBe(false);
        expect(isLimit('3')).toBe(false);
    });
});

describe('diffActivations', () => {
    it('lists entries only before / only after, ignoring cut ones, and the size delta', () => {
        const before = [
            { world: 'B', uid: 2, comment: 'two', chars: 200 },
            { world: 'A', uid: 1, comment: 'one', chars: 100 },
            { world: 'A', uid: 3, chars: 50, cut: true },
        ];
        const after = [
            { world: 'A', uid: 1, comment: 'one', chars: 100 },
            { world: 'A', uid: 3, chars: 50 },
            { world: 'B', uid: 2, comment: 'two', chars: 200, cut: true },
            { world: 'A', uid: 0, chars: Number.NaN },
        ];
        expect(diffActivations(before, after)).toEqual({
            removed: [{ world: 'B', uid: 2, comment: 'two', chars: 200 }],
            added: [
                { world: 'A', uid: 0, comment: '', chars: 0 },
                { world: 'A', uid: 3, comment: '', chars: 50 },
            ],
            charsDelta: -150,
        });
    });

    it('is empty for identical lists', () => {
        const list = [{ world: 'A', uid: 1, chars: 10 }];
        expect(diffActivations(list, list)).toEqual({ removed: [], added: [], charsDelta: 0 });
    });
});

describe('isPlainObject', () => {
    it('accepts objects only', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject([])).toBe(false);
        expect(isPlainObject(null)).toBe(false);
        expect(isPlainObject('x')).toBe(false);
    });
});
