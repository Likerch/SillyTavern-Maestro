// M25 combat mode (plan-2 §6 п. 11): the order by initiative, turns and rounds, joining, leaving, the end of a fight,
// the prompt line and stored data.
import { describe, expect, it } from 'vitest';
import {
    addCombatant,
    combatantOf,
    combatLine,
    endCombat,
    markOut,
    nextRound,
    nextTurn,
    readCombat,
    startCombat,
} from '../../src/domain/mechanics-combat';

function fight() {
    return startCombat(
        [
            { holder: 'Mira', init: 9 },
            { holder: 'Bandit', init: 12, enemy: true },
            { holder: ' Kai ', init: 17.4 },
            { holder: 'kai', init: 3 },
            { holder: ' ', init: 20 },
            { holder: 'Wolf', init: 12, enemy: true },
        ],
        { mechanicId: 'combat', at: 5, by: 'director' },
    );
}

describe('combat', () => {
    it('orders by initiative (ties: our side, then the name), drops repeats and empty names', () => {
        const state = fight();
        expect(state).toMatchObject({
            active: true,
            round: 1,
            current: 0,
            mechanicId: 'combat',
            startedAt: 5,
            by: 'director',
        });
        expect(state.order).toEqual([
            { holder: 'Kai', init: 17 },
            { holder: 'Bandit', init: 12, enemy: true },
            { holder: 'Wolf', init: 12, enemy: true },
            { holder: 'Mira', init: 9 },
        ]);
    });

    it('turns go round, skipping those out; a new round after the last', () => {
        let state = fight();
        state = nextTurn(state);
        expect(state.order[state.current]?.holder).toBe('Bandit');
        state = markOut(state, 'Wolf').state;
        state = nextTurn(state);
        expect(state.order[state.current]?.holder).toBe('Mira');
        state = nextTurn(state);
        expect(state).toMatchObject({ round: 2, current: 0 });
        expect(nextRound(state)).toMatchObject({ round: 3, current: 0 });
        expect(nextTurn({ ...state, active: false })).toEqual({ ...state, active: false });
        expect(nextRound({ ...state, active: false }).round).toBe(2);
    });

    it('joins at its initiative keeping who acts, and brings back one that was out', () => {
        let state = nextTurn(fight());
        state = addCombatant(state, { holder: 'Rat', init: 20, enemy: true });
        expect(state.order[0]).toEqual({ holder: 'Rat', init: 20, enemy: true });
        expect(state.order[state.current]?.holder).toBe('Bandit');
        state = markOut(state, 'Mira').state;
        state = addCombatant(state, { holder: 'mira', init: 1 });
        expect(combatantOf(state, 'Mira')).toEqual({ holder: 'Mira', init: 9 });
        state = addCombatant(state, { holder: 'Mira', init: 1, enemy: true });
        expect(combatantOf(state, 'Mira')?.enemy).toBe(true);
        expect(combatantOf(null, 'Mira')).toBeNull();
    });

    it('ends when every enemy is out, or nobody is left', () => {
        let state = fight();
        const first = markOut(state, 'Bandit');
        expect(first.ended).toBe(false);
        expect(markOut(first.state, 'Bandit').state).toBe(first.state);
        expect(markOut(state, 'Nobody').ended).toBe(false);
        const second = markOut(first.state, 'Wolf');
        expect(second.ended).toBe(true);
        state = startCombat([{ holder: 'Kai', init: 1 }], { mechanicId: null, at: -1, by: 'user' });
        const alone = markOut(state, 'Kai');
        expect(alone.ended).toBe(true);
        // The one acting goes out: the next one acts.
        const acting = markOut(fight(), 'Kai');
        expect(acting.state.order[acting.state.current]?.holder).toBe('Bandit');
        expect(endCombat(state, 9)).toMatchObject({ active: false, endedAt: 9 });
    });

    it('is one line for the model', () => {
        let state = markOut(nextTurn(fight()), 'Wolf').state;
        expect(combatLine(state)).toBe(
            '[Combat] Round 1. Turn order: Kai 17, Bandit 12 (enemy), Mira 9; out: Wolf. Now acting: Bandit. Keep the fight to this order; one round per reply.',
        );
        state = markOut(state, 'Bandit').state;
        expect(combatLine(state)).toContain('Now acting: Mira.');
        expect(combatLine(endCombat(state, 1))).toBe('');
        expect(combatLine(null)).toBe('');
        const empty = startCombat([], { mechanicId: null, at: 0, by: 'user' });
        expect(combatLine(empty)).toBe('');
        const everyoneOut = { ...fight(), order: fight().order.map((item) => ({ ...item, out: true })) };
        expect(combatLine(everyoneOut)).toContain('Turn order: nobody; out:');
    });

    it('repairs stored data', () => {
        expect(readCombat(null)).toBeNull();
        expect(readCombat({ order: 'x' })).toBeNull();
        expect(
            readCombat({
                active: true,
                round: 0,
                order: [{ holder: 'Kai', init: 'x', enemy: true, out: true }, { holder: ' ' }, 3],
                current: 7,
                mechanicId: '',
                startedAt: 2.5,
                by: 'model',
                endedAt: 4,
            }),
        ).toEqual({
            active: true,
            round: 1,
            order: [{ holder: 'Kai', init: 0, enemy: true, out: true }],
            current: 0,
            mechanicId: null,
            startedAt: 2,
            by: 'model',
            endedAt: 4,
        });
        expect(readCombat({ order: [], by: 'nobody' })).toMatchObject({ active: false, by: 'user', startedAt: -1 });
    });
});
