// M25 dice of plan-2 §6 п. 6: several dice groups and terms, keep highest/lowest, exploding dice, advantage and
// disadvantage, bonuses, criticals of any dice, opposed checks and their facts — parseDice stays backward compatible.
import { describe, expect, it } from 'vitest';
import {
    criticalsDefault,
    criticalsOf,
    diceAttributes,
    diceParts,
    modifierValue,
    naturalRange,
    parseDice,
} from '../../src/domain/mechanics-defs';
import type { DiceFormula } from '../../src/domain/mechanics-defs';
import {
    checkFact,
    criticalsByDefault,
    difficultyFor,
    marginOf,
    middleOf,
    opposedFact,
    opposedOutcome,
    outcomeText,
    rollDice,
    rollText,
} from '../../src/domain/mechanics-dice';
import type { Rng } from '../../src/domain/mechanics-dice';

function formula(text: string): DiceFormula {
    const parsed = parseDice(text);
    if (!parsed) throw new Error(`bad formula ${text}`);
    return parsed;
}

/** Faces of dice of `sides` in order (then the middle face). */
function faces(sides: number, ...values: number[]): Rng {
    let i = 0;
    return () => {
        const value = values[i++];
        return value === undefined ? 0.5 : (value - 0.5) / sides;
    };
}

/** Faces of mixed dice: [sides, face] pairs. */
function mixed(...rolls: [number, number][]): Rng {
    let i = 0;
    return () => {
        const roll = rolls[i++];
        return roll ? (roll[1] - 0.5) / roll[0] : 0.5;
    };
}

const none = () => null;

describe('parseDice: multi-term formulas', () => {
    it('reads several groups and terms, keep and exploding dice', () => {
        expect(parseDice('2d6+1d4+3')).toMatchObject({
            count: 2,
            sides: 6,
            modifier: null,
            under: null,
            text: '2d6+1d4+3',
            parts: [
                { kind: 'dice', sign: 1, count: 2, sides: 6 },
                { kind: 'dice', sign: 1, count: 1, sides: 4 },
                { kind: 'term', sign: 1, term: { kind: 'flat', value: 3 } },
            ],
        });
        expect(parseDice('4d6kh3')?.parts?.[0]).toEqual({
            kind: 'dice',
            sign: 1,
            count: 4,
            sides: 6,
            keep: { high: true, n: 3 },
        });
        expect(parseDice('2D20KL1')?.text).toBe('2d20kl1');
        expect(parseDice('1d6!')?.parts?.[0]).toMatchObject({ explode: true });
        expect(parseDice('1d20 + @agility + 2')?.text).toBe('1d20+@agility+2');
        expect(parseDice('-2+1d20+mod(@str)')?.text).toBe('-2+1d20+mod(@str)');
        expect(parseDice('1d8-1d4')?.parts?.[1]).toMatchObject({ sign: -1, count: 1, sides: 4 });
        expect(parseDice('d6+d6')?.text).toBe('1d6+1d6');
    });

    it('refuses bad multi-term formulas', () => {
        for (const bad of [
            '3+2',
            '1d6+@',
            '4d6kh0',
            '2d6kh3',
            '1d1+1d6',
            '1d6+1d2000',
            '1d6+20000',
            `${'1d6+'.repeat(10)}1d6`,
            '60d6+50d6',
            '1d6+1d6<=10',
            '1d6+x',
        ]) {
            expect(parseDice(bad), bad).toBeNull();
        }
    });

    it('keeps the simple shape for the old formulas', () => {
        expect(parseDice('1d20+3')).toEqual({
            count: 1,
            sides: 20,
            modifier: { sign: 1, term: { kind: 'flat', value: 3 } },
            under: null,
            text: '1d20+3',
        });
        expect(diceParts(formula('1d20+3'))).toEqual([
            { kind: 'dice', sign: 1, count: 1, sides: 20 },
            { kind: 'term', sign: 1, term: { kind: 'flat', value: 3 } },
        ]);
    });

    it('reads attributes, modifiers and natural ranges of any formula', () => {
        const multi = formula('2d6+@str-mod(@dex)+1');
        expect(diceAttributes(multi)).toEqual(['str', 'dex']);
        expect(modifierValue(multi, (name) => (name === 'str' ? 3 : 14))).toBe(2);
        expect(naturalRange(formula('2d6+1d4'))).toEqual({ min: 3, max: 16 });
        expect(naturalRange(formula('4d6kh3'))).toEqual({ min: 3, max: 18 });
        expect(naturalRange(formula('1d8-1d4'))).toEqual({ min: -3, max: 7 });
        expect(naturalRange(formula('1d6!'))).toBeNull();
        expect(criticalsDefault(formula('1d20'))).toBe(true);
        expect(criticalsDefault(formula('1d20+1d4'))).toBe(false);
        expect(criticalsByDefault(formula('1d20+1d4'))).toBe(false);
        expect(criticalsOf({ dice: '2d6', criticals: true })).toBe(true);
        expect(criticalsOf({ dice: '1d20' })).toBe(true);
        expect(criticalsOf({ dice: '2d6' })).toBe(false);
        expect(criticalsOf({ dice: 'nope' })).toBe(false);
    });
});

describe('rolling multi-term formulas', () => {
    it('adds the groups, keeps the highest, explodes, takes modifiers', () => {
        const sum = rollDice(formula('2d6+1d4+3'), none, mixed([6, 2], [6, 5], [4, 4]), { difficulty: 12 });
        expect(sum).toMatchObject({ rolls: [2, 5, 4], natural: 11, modifier: 3, total: 14, outcome: 'success' });
        const keep = rollDice(formula('4d6kh3'), none, faces(6, 1, 5, 3, 6));
        expect(keep).toMatchObject({ rolls: [1, 5, 3, 6], dropped: [1], natural: 14, outcome: 'none' });
        const low = rollDice(formula('2d20kl1'), none, faces(20, 15, 4));
        expect(low).toMatchObject({ natural: 4, dropped: [15] });
        const boom = rollDice(formula('1d6!'), none, faces(6, 6, 6, 2));
        expect(boom).toMatchObject({ rolls: [14], natural: 14 });
        const minus = rollDice(formula('1d8-1d4'), none, mixed([8, 6], [4, 4]));
        expect(minus.natural).toBe(2);
        const attrs = rollDice(formula('1d20+@str+mod(@dex)'), (name) => (name === 'str' ? 2.6 : 14), faces(20, 10));
        expect(attrs.modifier).toBe(5);
        expect(rollDice(formula('1d20+@str+mod(@dex)'), none, faces(20, 10)).missing).toEqual(['str', 'dex']);
    });

    it('criticals of multi-term formulas when asked: the highest and lowest natural sums', () => {
        expect(rollDice(formula('2d6+1'), none, faces(6, 6, 6), { difficulty: 20, criticals: true }).outcome).toBe(
            'critical',
        );
        expect(rollDice(formula('1d6+1d6'), none, faces(6, 1, 1), { difficulty: 2, criticals: true }).outcome).toBe(
            'fumble',
        );
        expect(rollDice(formula('1d6!'), none, faces(6, 6, 1), { difficulty: 30, criticals: true }).outcome).toBe(
            'failure',
        );
    });

    it('advantage keeps the better roll, disadvantage the worse; roll-under the lower one', () => {
        const adv = rollDice(formula('1d20+2'), none, faces(20, 5, 17), { difficulty: 15, mode: 'adv' });
        expect(adv).toMatchObject({
            natural: 17,
            total: 19,
            outcome: 'success',
            mode: 'adv',
            other: { rolls: [5], total: 7 },
        });
        expect(rollText(adv)).toBe('rolled 17 + 2 = 19 (advantage, other roll 7) vs 15 — success');
        const dis = rollDice(formula('1d20'), none, faces(20, 5, 17), { difficulty: 15, mode: 'dis' });
        expect(dis).toMatchObject({ natural: 5, outcome: 'failure', other: { total: 17 } });
        expect(rollText(dis)).toContain('disadvantage, other roll 17');
        const under = rollDice(formula('1d100<=@stealth'), () => 50, faces(100, 70, 30), { mode: 'adv' });
        expect(under).toMatchObject({ natural: 30, outcome: 'success' });
        const underDis = rollDice(formula('1d100<=@stealth'), () => 50, faces(100, 30, 70), { mode: 'dis' });
        expect(underDis).toMatchObject({ natural: 70, outcome: 'failure' });
    });

    it('adds a bonus (statuses, items) to the modifier', () => {
        const roll = rollDice(formula('1d20+1'), none, faces(20, 10), { difficulty: 12, bonus: 2.4 });
        expect(roll).toMatchObject({ modifier: 3, total: 13, outcome: 'success' });
        expect(rollDice(formula('1d20'), none, faces(20, 10), { bonus: Number.NaN }).modifier).toBe(0);
    });

    it('difficulty levels and the middle of multi-term ranges', () => {
        expect(middleOf(formula('2d6+1d4'))).toBe(10);
        expect(middleOf(formula('1d6!'))).toBe(4);
        expect(difficultyFor('hard', null, formula('2d6+1d4'))).toBe(13);
        expect(difficultyFor('easy', 10, formula('1d6!'))).toBe(9);
    });
});

describe('opposed checks', () => {
    it('roll-over: the higher total wins, ties go to the defender, criticals stand', () => {
        const actor = rollDice(formula('1d20'), none, faces(20, 14));
        const defender = rollDice(formula('1d20'), none, faces(20, 11));
        expect(opposedOutcome(actor, defender)).toBe('success');
        expect(opposedOutcome(actor, { ...defender, total: 14 })).toBe('failure');
        expect(opposedOutcome({ ...actor, outcome: 'critical' }, defender)).toBe('critical');
        expect(opposedOutcome({ ...actor, outcome: 'fumble' }, defender)).toBe('fumble');
        expect(opposedOutcome(actor, { ...defender, outcome: 'critical' })).toBe('failure');
        expect(
            opposedFact(
                { check: 'Stealth', holder: 'Kai', roll: actor },
                { check: 'Perception', holder: 'Guard', roll: defender },
                'success',
            ),
        ).toBe('Stealth (Kai) vs Perception (Guard): 14 vs 11 — success.');
        expect(
            opposedFact(
                { check: '', holder: 'Kai', roll: actor },
                { check: '', holder: 'Guard', roll: defender },
                'critical',
            ),
        ).toBe('Skill (Kai) vs Skill (Guard): 14 vs 11 — critical success (natural 14).');
        expect(
            opposedFact({ check: 'A', holder: 'K', roll: actor }, { check: 'B', holder: 'G', roll: defender }, 'none'),
        ).toContain('— tie.');
    });

    it('roll-under: the actor must succeed and beat a succeeding defender by margin', () => {
        const under = (natural: number, target: number) =>
            rollDice(formula('1d100<=@skill'), () => target, faces(100, natural));
        expect(opposedOutcome(under(40, 60), under(50, 55))).toBe('success');
        expect(opposedOutcome(under(50, 55), under(40, 60))).toBe('failure');
        expect(opposedOutcome(under(70, 60), under(90, 55))).toBe('failure');
        expect(opposedOutcome(under(40, 60), under(90, 55))).toBe('success');
        expect(opposedOutcome(under(40, 60), { ...under(2, 55), outcome: 'critical' })).toBe('failure');
        expect(marginOf(under(40, 60))).toBe(20);
        expect(marginOf(rollDice(formula('1d20'), none, faces(20, 14), { difficulty: 10 }))).toBe(4);
        expect(marginOf(rollDice(formula('1d20'), none, faces(20, 14)))).toBe(0);
    });

    it('words of outcomes and the fact of a plain check', () => {
        expect(outcomeText('fumble')).toBe('critical failure');
        expect(outcomeText('none')).toBe('');
        const roll = rollDice(formula('4d6kh3'), none, faces(6, 1, 5, 3, 6));
        expect(checkFact('Strength', 'Kai', roll)).toBe('Strength check (Kai): rolled 14 (1+5+3+6).');
    });
});
