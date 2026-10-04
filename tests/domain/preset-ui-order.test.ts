import { describe, expect, it } from 'vitest';
import {
    anchorFor,
    detachFromOrder,
    insertAtStart,
    mergeImportedOrder,
    moveItem,
    moveOps,
    sameOrder,
} from '../../src/domain/preset-ui-order';
import type { MoveOp } from '../../src/domain/preset-ui-order';

/** Applies move operations left to right the way the layer does. */
function applyMoves(order: string[], ops: MoveOp[]): string[] {
    let list = [...order];
    for (const op of ops) {
        list = list.filter((item) => item !== op.identifier);
        const at = op.anchor.kind === 'start' ? 0 : list.indexOf(op.anchor.identifier) + 1;
        list.splice(at, 0, op.identifier);
    }
    return list;
}

describe('moving rows', () => {
    it('moves an item and clamps the target', () => {
        expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
        expect(moveItem(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
        expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
        expect(sameOrder(['a'], ['a'])).toBe(true);
        expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
        expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    });

    it('turns a reorder into the fewest anchored moves', () => {
        expect(moveOps(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual([
            { identifier: 'a', anchor: { kind: 'after', identifier: 'c' } },
        ]);
        expect(moveOps(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
        expect(moveOps([], [])).toEqual([]);
        const reversed = moveOps(['a', 'b', 'c'], ['c', 'b', 'a']);
        expect(reversed).toHaveLength(2);
        expect(applyMoves(['a', 'b', 'c'], reversed)).toEqual(['c', 'b', 'a']);
    });

    it('records the block the user moved when a swap could go either way', () => {
        expect(moveOps(['a', 'b', 'c'], ['a', 'c', 'b'], ['b'])).toEqual([
            { identifier: 'b', anchor: { kind: 'after', identifier: 'c' } },
        ]);
        expect(moveOps(['a', 'b', 'c'], ['b', 'a', 'c'], ['b'])).toEqual([
            { identifier: 'b', anchor: { kind: 'start' } },
        ]);
    });

    it('rebuilds any permutation and ignores adds and removals', () => {
        const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        const after = ['g', 'c', 'a', 'f', 'b', 'e', 'd'];
        expect(applyMoves(before, moveOps(before, after))).toEqual(after);
        expect(moveOps(['a', 'b'], ['new', 'b', 'a'])).toEqual([
            { identifier: 'b', anchor: { kind: 'after', identifier: 'new' } },
        ]);
    });
});

describe('prompt-list order (P-031) and detach / insert (P-026, P-028)', () => {
    it('writes the imported entries over the current ones by index and drops duplicates', () => {
        const current = [
            { identifier: 'main', enabled: true },
            { identifier: 'style', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'jailbreak', enabled: false },
        ];
        expect(
            mergeImportedOrder(current, [
                { identifier: 'chatHistory', enabled: false },
                { identifier: 'main' },
                null,
                { identifier: '' },
                'junk',
            ]),
        ).toEqual([
            { identifier: 'chatHistory', enabled: false },
            { identifier: 'main', enabled: false },
            { identifier: 'jailbreak', enabled: false },
        ]);
    });

    it('detaches, inserts at the start and picks an anchor', () => {
        expect(detachFromOrder(['a', 'b'], 'a')).toEqual(['b']);
        expect(insertAtStart(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
        expect(insertAtStart(['a', 'b'], 'b')).toEqual(['a', 'b']);
        expect(anchorFor(['a', 'b'], 'a')).toBe('a');
        expect(anchorFor(['a', 'b'], 'zzz')).toBe('b');
        expect(anchorFor(['a', 'b'], null)).toBe('b');
        expect(anchorFor([], undefined)).toBeUndefined();
    });
});
