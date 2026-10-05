// M25 «Механики», dice (plan M25 п.3): a check's dice formula (parsed by `parseDice` of mechanics-defs.ts, shared
// with the constructor) rolled with an injectable RNG and the holder's attribute values (a plain modifier `@attr`,
// the D&D modifier `mod(@attr)`, or a roll-under target `<=@attr`), natural criticals, the outcome against a
// difficulty and the English fact the prompt gets ("Persuasion check (Kai): rolled 14 + 2 = 16 vs 15 — success.").
// Pure: no DOM, no SillyTavern.
import { dndModifier } from './mechanics-defs';
import type { DiceFormula } from './mechanics-defs';

/** A random number in [0, 1). */
export type Rng = () => number;

export type DiceOutcome = 'critical' | 'success' | 'failure' | 'fumble' | 'none';

export type DifficultyLevel = 'easy' | 'normal' | 'hard' | 'veryHard';

/* ------------------------------------------------------------------ randomness */

/** A deterministic RNG (mulberry32) for tests and reproducible rolls. */
export function seededRng(seed: number): Rng {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** One die, 1..sides; a broken RNG value (NaN, out of range) is clamped instead of producing 0 or sides+1. */
export function rollDie(sides: number, rng: Rng): number {
    const raw = rng();
    const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON) : 0;
    return Math.floor(unit * sides) + 1;
}

/* ------------------------------------------------------------------ rolling */

/** A numeric value of an attribute for the roll, or null when the holder has none. */
export type AttributeLookup = (attribute: string) => number | null;

export interface RollOptions {
    /** Target the total must reach (roll-over); ignored for roll-under formulas. null/undefined: only the number. */
    difficulty?: number | null;
    /** Roll-under only: easy ×1.5, hard ×½, very hard ×⅕ of the target (Call of Cthulhu style). */
    level?: DifficultyLevel | null;
    /** Natural max/min as critical success/failure; default: true for a single d20 or d100. */
    criticals?: boolean;
}

export interface DiceRoll {
    rolls: number[];
    /** Sum of the dice. */
    natural: number;
    modifier: number;
    total: number;
    target: number | null;
    under: boolean;
    outcome: DiceOutcome;
    /** Attributes the formula needs that had no numeric value (modifier 0; a missing roll-under target → none). */
    missing: string[];
}

const UNDER_SCALE: Record<DifficultyLevel, number> = { easy: 1.5, normal: 1, hard: 0.5, veryHard: 0.2 };

export function criticalsByDefault(formula: Pick<DiceFormula, 'count' | 'sides'>): boolean {
    return formula.count === 1 && (formula.sides === 20 || formula.sides === 100);
}

/** 'critical' / 'fumble' for a natural extreme, null otherwise (d100: 01–05 and 96–00). */
function naturalExtreme(formula: DiceFormula, sum: number, under: boolean): 'critical' | 'fumble' | null {
    if (formula.count === 1 && formula.sides === 100) {
        if (sum <= 5) return under ? 'critical' : 'fumble';
        if (sum >= 96) return under ? 'fumble' : 'critical';
        return null;
    }
    if (sum === formula.count * formula.sides) return under ? 'fumble' : 'critical';
    if (sum === formula.count) return under ? 'critical' : 'fumble';
    return null;
}

export function rollDice(formula: DiceFormula, lookup: AttributeLookup, rng: Rng, options: RollOptions = {}): DiceRoll {
    const rolls: number[] = [];
    for (let i = 0; i < formula.count; i++) rolls.push(rollDie(formula.sides, rng));
    const sum = rolls.reduce((total, value) => total + value, 0);
    const missing: string[] = [];
    const read = (attribute: string): number | null => {
        const value = lookup(attribute);
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (!missing.includes(attribute)) missing.push(attribute);
        return null;
    };
    let modifier = 0;
    if (formula.modifier) {
        const { sign, term } = formula.modifier;
        if (term.kind === 'flat') {
            modifier = sign * term.value;
        } else {
            const value = read(term.attribute);
            if (value !== null) modifier = sign * (term.kind === 'mod' ? dndModifier(value) : Math.round(value));
        }
    }
    const total = sum + modifier;
    const under = formula.under !== null;
    let target: number | null = null;
    if (formula.under) {
        const base = formula.under.kind === 'flat' ? formula.under.value : read(formula.under.attribute);
        if (base !== null) target = Math.floor(base * UNDER_SCALE[options.level ?? 'normal']);
    } else if (typeof options.difficulty === 'number' && Number.isFinite(options.difficulty)) {
        target = Math.round(options.difficulty);
    }
    const criticals = options.criticals ?? criticalsByDefault(formula);
    const extreme = criticals ? naturalExtreme(formula, sum, under) : null;
    let outcome: DiceOutcome;
    if (extreme) outcome = extreme;
    else if (target === null) outcome = 'none';
    else if (under) outcome = total <= target ? 'success' : 'failure';
    else outcome = total >= target ? 'success' : 'failure';
    return { rolls, natural: sum, modifier, total, target, under, outcome, missing };
}

/* ------------------------------------------------------------------ difficulty */

/** The middle of the formula's range (dice only), the base when a check has no default difficulty. */
export function middleOf(formula: Pick<DiceFormula, 'count' | 'sides'>): number {
    return Math.round((formula.count * (formula.sides + 1)) / 2);
}

/**
 * The target of a roll-over check at a difficulty level: the check's default (or the middle of the range) moved by a
 * quarter of the dice range per step (d20: 5, 2d6: 3, d100: 25). Roll-under checks carry their own target: null.
 */
export function difficultyFor(level: DifficultyLevel, base: number | null, formula: DiceFormula): number | null {
    if (formula.under) return null;
    const start = base ?? middleOf(formula);
    const step = Math.max(1, Math.round((formula.count * formula.sides - formula.count) / 4));
    const shift = level === 'easy' ? -step : level === 'hard' ? step : level === 'veryHard' ? 2 * step : 0;
    return start + shift;
}

/* ------------------------------------------------------------------ the fact */

const OUTCOME_TEXT: Record<DiceOutcome, string> = {
    critical: 'critical success',
    success: 'success',
    failure: 'failure',
    fumble: 'critical failure',
    none: '',
};

/** "rolled 14 + 2 = 16 vs 15 — success" without the check and the holder (the pult shows it too). */
export function rollText(roll: DiceRoll): string {
    const dice = roll.rolls.length > 1 ? `${roll.natural} (${roll.rolls.join('+')})` : String(roll.natural);
    let text = `rolled ${dice}`;
    if (roll.modifier !== 0) {
        text += ` ${roll.modifier < 0 ? '-' : '+'} ${Math.abs(roll.modifier)} = ${roll.total}`;
    }
    if (roll.target !== null) text += roll.under ? `, needed ${roll.target} or lower` : ` vs ${roll.target}`;
    const outcome = OUTCOME_TEXT[roll.outcome];
    if (outcome) {
        text += ` — ${outcome}`;
        if (roll.outcome === 'critical' || roll.outcome === 'fumble') text += ` (natural ${roll.natural})`;
    }
    return text;
}

/** The English fact for the prompt: "Persuasion check (Kai): rolled 14 + 2 = 16 vs 15 — success." */
export function checkFact(checkName: string, holder: string, roll: DiceRoll): string {
    const name = checkName.trim() || 'Skill';
    const who = holder.trim();
    return `${name} check${who ? ` (${who})` : ''}: ${rollText(roll)}.`;
}
