// M25 dice: formulas parsed by mechanics-defs' parseDice, modifiers from attributes, roll-under, criticals, outcomes,
// difficulty levels and the English fact text — with injected RNGs.
import { describe, expect, it } from 'vitest';
import { parseDice } from '../../src/domain/mechanics-defs';
import type { DiceFormula } from '../../src/domain/mechanics-defs';
import {
    checkFact,
    criticalsByDefault,
    difficultyFor,
    middleOf,
    rollDice,
    rollDie,
    rollText,
    seededRng,
} from '../../src/domain/mechanics-dice';
import type { Rng } from '../../src/domain/mechanics-dice';

/** An RNG that makes dice of `sides` show the given faces in order (then the middle face). */
function faces(sides: number, ...values: number[]): Rng {
    let i = 0;
    return () => {
        const value = values[i++];
        return value === undefined ? 0.5 : (value - 0.5) / sides;
    };
}

function formula(text: string): DiceFormula {
    const parsed = parseDice(text);
    if (!parsed) throw new Error(`bad formula ${text}`);
    return parsed;
}

const none = () => null;
const values =
    (map: Record<string, number>) =>
    (attribute: string): number | null =>
        map[attribute] ?? null;

describe('randomness', () => {
    it('seededRng is deterministic and stays in [0, 1)', () => {
        const a = seededRng(42);
        const b = seededRng(42);
        const first = Array.from({ length: 50 }, () => a());
        expect(Array.from({ length: 50 }, () => b())).toEqual(first);
        expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
        expect(new Set(first).size).toBeGreaterThan(40);
        expect(seededRng(7)()).not.toBe(seededRng(8)());
    });

    it('rollDie covers 1..sides and clamps broken RNG values', () => {
        expect(rollDie(20, () => 0)).toBe(1);
        expect(rollDie(20, () => 0.9999999)).toBe(20);
        expect(rollDie(20, () => 1)).toBe(20);
        expect(rollDie(20, () => -3)).toBe(1);
        expect(rollDie(20, () => Number.NaN)).toBe(1);
        const rng = seededRng(1);
        const seen = new Set(Array.from({ length: 400 }, () => rollDie(6, rng)));
        expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });
});

describe('rolling', () => {
    it('a plain d20 against a difficulty', () => {
        const roll = rollDice(formula('1d20'), none, faces(20, 14), { difficulty: 15 });
        expect(roll).toMatchObject({
            rolls: [14],
            natural: 14,
            modifier: 0,
            total: 14,
            target: 15,
            outcome: 'failure',
        });
        expect(checkFact('Persuasion', 'Kai', roll)).toBe('Persuasion check (Kai): rolled 14 vs 15 — failure.');
    });

    it('adds an attribute value as the modifier', () => {
        const roll = rollDice(formula('1d20+@charisma'), values({ charisma: 2 }), faces(20, 14), { difficulty: 15 });
        expect(roll).toMatchObject({ modifier: 2, total: 16, outcome: 'success', missing: [] });
        expect(checkFact('Persuasion', 'Kai', roll)).toBe(
            'Persuasion check (Kai): rolled 14 + 2 = 16 vs 15 — success.',
        );
    });

    it('subtracts constants and attributes', () => {
        const flat = rollDice(formula('1d20-3'), none, faces(20, 14), { difficulty: 10 });
        expect(rollText(flat)).toBe('rolled 14 - 3 = 11 vs 10 — success');
        const attr = rollDice(formula('1d20-@fatigue'), values({ fatigue: 4.4 }), faces(20, 9), { difficulty: 10 });
        expect(attr).toMatchObject({ modifier: -4, total: 5, outcome: 'failure' });
    });

    it('uses the D&D modifier for mod(@attr)', () => {
        const strong = rollDice(formula('1d20+mod(@strength)'), values({ strength: 15 }), faces(20, 10));
        expect(strong.modifier).toBe(2);
        const weak = rollDice(formula('1d20+mod(@strength)'), values({ strength: 8 }), faces(20, 10));
        expect(weak.modifier).toBe(-1);
        expect(rollText(weak)).toBe('rolled 10 - 1 = 9');
    });

    it('counts a missing attribute as 0 and reports it', () => {
        const roll = rollDice(formula('1d20+@charisma'), none, faces(20, 12), { difficulty: 10 });
        expect(roll).toMatchObject({ modifier: 0, total: 12, outcome: 'success', missing: ['charisma'] });
        const mod = rollDice(formula('1d20+mod(@charisma)'), values({ other: 3 }), faces(20, 12));
        expect(mod.missing).toEqual(['charisma']);
    });

    it('without a difficulty only the number is reported', () => {
        const roll = rollDice(formula('1d20+2'), none, faces(20, 14));
        expect(roll).toMatchObject({ target: null, outcome: 'none' });
        expect(checkFact('Luck', 'Kai', roll)).toBe('Luck check (Kai): rolled 14 + 2 = 16.');
        const nan = rollDice(formula('1d20'), none, faces(20, 14), { difficulty: Number.NaN });
        expect(nan.target).toBeNull();
    });

    it('several dice are listed', () => {
        const roll = rollDice(formula('2d6+1'), none, faces(6, 3, 5), { difficulty: 8 });
        expect(roll).toMatchObject({ rolls: [3, 5], natural: 8, total: 9, outcome: 'success' });
        expect(rollText(roll)).toBe('rolled 8 (3+5) + 1 = 9 vs 8 — success');
    });

    it('rounds a fractional difficulty', () => {
        expect(rollDice(formula('1d20'), none, faces(20, 10), { difficulty: 10.4 }).target).toBe(10);
    });
});

describe('criticals', () => {
    it('a natural 20 succeeds and a natural 1 fails whatever the total', () => {
        const high = rollDice(formula('1d20'), none, faces(20, 20), { difficulty: 25 });
        expect(high.outcome).toBe('critical');
        expect(checkFact('Persuasion', 'Kai', high)).toBe(
            'Persuasion check (Kai): rolled 20 vs 25 — critical success (natural 20).',
        );
        const low = rollDice(formula('1d20+10'), none, faces(20, 1), { difficulty: 5 });
        expect(low.outcome).toBe('fumble');
        expect(rollText(low)).toBe('rolled 1 + 10 = 11 vs 5 — critical failure (natural 1)');
    });

    it('criticals are reported even without a target', () => {
        expect(rollDice(formula('1d20'), none, faces(20, 20)).outcome).toBe('critical');
    });

    it('can be switched off, and are off by default for other dice', () => {
        const off = rollDice(formula('1d20'), none, faces(20, 20), { difficulty: 25, criticals: false });
        expect(off.outcome).toBe('failure');
        const twoD6 = rollDice(formula('2d6'), none, faces(6, 6, 6), { difficulty: 13 });
        expect(twoD6.outcome).toBe('failure');
        const on = rollDice(formula('2d6'), none, faces(6, 6, 6), { difficulty: 13, criticals: true });
        expect(on.outcome).toBe('critical');
        const snake = rollDice(formula('2d6'), none, faces(6, 1, 1), { difficulty: 2, criticals: true });
        expect(snake.outcome).toBe('fumble');
        expect(criticalsByDefault(formula('1d20'))).toBe(true);
        expect(criticalsByDefault(formula('d100'))).toBe(true);
        expect(criticalsByDefault(formula('2d10'))).toBe(false);
    });

    it('a d100 rolled over: 96–00 critical, 01–05 fumble', () => {
        expect(rollDice(formula('1d100'), none, faces(100, 97), { difficulty: 50 }).outcome).toBe('critical');
        expect(rollDice(formula('1d100'), none, faces(100, 4), { difficulty: 3 }).outcome).toBe('fumble');
        expect(rollDice(formula('1d100'), none, faces(100, 50), { difficulty: 50 }).outcome).toBe('success');
    });
});

describe('roll-under', () => {
    const stealth = values({ stealth: 60 });

    it('succeeds at or under the attribute value', () => {
        const roll = rollDice(formula('1d100<=@stealth'), stealth, faces(100, 34));
        expect(roll).toMatchObject({ target: 60, under: true, outcome: 'success' });
        expect(checkFact('Stealth', 'Kai', roll)).toBe('Stealth check (Kai): rolled 34, needed 60 or lower — success.');
        expect(rollDice(formula('1d100<=@stealth'), stealth, faces(100, 60)).outcome).toBe('success');
        expect(rollDice(formula('1d100<=@stealth'), stealth, faces(100, 75)).outcome).toBe('failure');
    });

    it('01–05 is a critical success, 96–00 a fumble', () => {
        const crit = rollDice(formula('1d100<=@stealth'), stealth, faces(100, 3));
        expect(crit.outcome).toBe('critical');
        expect(rollText(crit)).toBe('rolled 3, needed 60 or lower — critical success (natural 3)');
        expect(rollDice(formula('1d100<=@stealth'), values({ stealth: 99 }), faces(100, 98)).outcome).toBe('fumble');
    });

    it('other dice: the minimum is critical, the maximum a fumble when asked for', () => {
        const low = rollDice(formula('3d6<=@wits'), values({ wits: 12 }), faces(6, 1, 1, 1), { criticals: true });
        expect(low.outcome).toBe('critical');
        const high = rollDice(formula('3d6<=@wits'), values({ wits: 12 }), faces(6, 6, 6, 6), { criticals: true });
        expect(high.outcome).toBe('fumble');
    });

    it('a number as the target, and difficulty levels scale it', () => {
        expect(rollDice(formula('1d100<=40'), none, faces(100, 41)).outcome).toBe('failure');
        expect(rollDice(formula('1d100<=@stealth'), stealth, faces(100, 40), { level: 'hard' }).target).toBe(30);
        expect(rollDice(formula('1d100<=@stealth'), stealth, faces(100, 40), { level: 'veryHard' }).target).toBe(12);
        expect(rollDice(formula('1d100<=@stealth'), stealth, faces(100, 40), { level: 'easy' }).target).toBe(90);
        // A difficulty number does not apply to roll-under.
        expect(rollDice(formula('1d100<=@stealth'), stealth, faces(100, 40), { difficulty: 10 }).target).toBe(60);
    });

    it('without the attribute there is no target', () => {
        const roll = rollDice(formula('1d100<=@stealth'), none, faces(100, 40));
        expect(roll).toMatchObject({ target: null, outcome: 'none', missing: ['stealth'] });
        expect(rollDice(formula('1d100<=@stealth'), none, faces(100, 2)).outcome).toBe('critical');
    });
});

describe('difficulty levels', () => {
    it('move a quarter of the dice range per step from the default', () => {
        const d20 = formula('1d20+@charisma');
        expect(difficultyFor('easy', 15, d20)).toBe(10);
        expect(difficultyFor('normal', 15, d20)).toBe(15);
        expect(difficultyFor('hard', 15, d20)).toBe(20);
        expect(difficultyFor('veryHard', 15, d20)).toBe(25);
        expect(difficultyFor('hard', 8, formula('2d6'))).toBe(11);
        expect(difficultyFor('hard', 50, formula('1d100'))).toBe(75);
    });

    it('start from the middle of the range when the check has no default', () => {
        expect(middleOf(formula('1d20'))).toBe(11);
        expect(middleOf(formula('2d6'))).toBe(7);
        expect(difficultyFor('hard', null, formula('1d20'))).toBe(16);
        expect(difficultyFor('easy', null, formula('1d4'))).toBe(2);
    });

    it('roll-under checks carry their own target', () => {
        expect(difficultyFor('hard', 15, formula('1d100<=@stealth'))).toBeNull();
    });
});

describe('the fact', () => {
    it('falls back for an empty check name and holder', () => {
        const roll = rollDice(formula('1d20'), none, faces(20, 7), { difficulty: 5 });
        expect(checkFact('  ', '', roll)).toBe('Skill check: rolled 7 vs 5 — success.');
    });

    it('is reproducible with a seed', () => {
        const a = rollDice(formula('3d6+mod(@str)'), values({ str: 14 }), seededRng(99), { difficulty: 12 });
        const b = rollDice(formula('3d6+mod(@str)'), values({ str: 14 }), seededRng(99), { difficulty: 12 });
        expect(b).toEqual(a);
        expect(a.rolls).toHaveLength(3);
        expect(a.total).toBe(a.natural + 2);
    });
});
