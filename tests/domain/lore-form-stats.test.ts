import { describe, expect, it } from 'vitest';
import { entryActivationStats, findingTargetsEntry } from '../../src/domain/lore-form-stats';

const turn = (messageIndex: number, activations: object[], simulated?: boolean) => ({
    messageIndex,
    at: 1000 + messageIndex,
    activations: activations as { world: string; uid: number; chars: number }[],
    ...(simulated ? { simulated } : {}),
});

describe('entryActivationStats', () => {
    it('counts real turns, cuts, average size, recent and the last key', () => {
        const turns = [
            turn(1, [{ world: 'World', uid: 1, chars: 100, key: 'Anna' }]),
            turn(3, [{ world: 'World', uid: 2, chars: 50 }]),
            turn(5, [{ world: 'World', uid: 1, chars: 300, cut: true, recursionLevel: 1 }]),
            turn(7, [{ world: 'World', uid: 1, chars: 200 }]),
            turn(9, [{ world: 'World', uid: 1, chars: 999 }], true),
            turn(11, [{ world: 'Other', uid: 1, chars: 10 }]),
        ];
        const stats = entryActivationStats(turns, 'World', 1, 2);
        expect(stats).toMatchObject({ turns: 5, activations: 3, cut: 1, avgChars: 150, lastKey: 'Anna' });
        expect(stats.frequency).toBeCloseTo(0.6);
        expect(stats.recent).toEqual([
            { messageIndex: 7, at: 1007, chars: 200, cut: false, recursionLevel: 0 },
            { messageIndex: 5, at: 1005, chars: 300, cut: true, recursionLevel: 1 },
        ]);
    });

    it('handles an empty journal and entries that never reached the prompt', () => {
        expect(entryActivationStats([], 'World', 1)).toEqual({
            turns: 0,
            activations: 0,
            frequency: 0,
            cut: 0,
            avgChars: 0,
            recent: [],
        });
        const onlyCut = entryActivationStats([turn(1, [{ world: 'W', uid: 2, chars: 10, cut: true }])], 'W', 2);
        expect(onlyCut).toMatchObject({ activations: 1, cut: 1, avgChars: 0 });
        expect(onlyCut.lastKey).toBeUndefined();
    });
});

describe('findingTargetsEntry', () => {
    it('matches uid, uid lists and CK archives', () => {
        expect(findingTargetsEntry({ book: 'W', uid: 1 }, 'W', 1)).toBe(true);
        expect(findingTargetsEntry({ book: 'W', uids: [3, 1] }, 'W', 1)).toBe(true);
        expect(findingTargetsEntry({ book: 'X', uid: 1 }, 'W', 1)).toBe(false);
        expect(findingTargetsEntry({ book: 'W', uid: 2 }, 'W', 1)).toBe(false);
        expect(findingTargetsEntry({ tag: '<A>', archives: [{ book: 'W', uid: 1 }, null] }, 'W', 1)).toBe(true);
        expect(findingTargetsEntry({ archives: [{ book: 'W', uid: 2 }, 'x'] }, 'W', 1)).toBe(false);
        expect(findingTargetsEntry({ setting: 'x' }, 'W', 1)).toBe(false);
    });
});
