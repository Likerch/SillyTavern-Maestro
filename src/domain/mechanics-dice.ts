// M25 «Механики», dice (plan M25 п.3; plan-2 §6 п. 6): a check's dice formula (parsed by `parseDice` of
// mechanics-defs.ts, shared with the constructor) rolled with an injectable RNG and the holder's attribute values (a
// plain modifier `@attr`, the D&D modifier `mod(@attr)`, or a roll-under target `<=@attr`), several dice groups
// ('2d6+1d4+3'), keep highest/lowest ('4d6kh3'), exploding dice ('1d6!'), advantage and disadvantage (the whole roll
// twice, the better / worse one kept), natural criticals, the outcome against a difficulty, opposed checks (the
// actor's total against the other side's) and the English facts the prompt gets
// ("Persuasion check (Kai): rolled 14 + 2 = 16 vs 15 — success.").
// Pure: no DOM, no SillyTavern.
import { diceParts, dndModifier, naturalRange } from './mechanics-defs';
import type { DiceFormula } from './mechanics-defs';

/** A random number in [0, 1). */
export type Rng = () => number;

export type DiceOutcome = 'critical' | 'success' | 'failure' | 'fumble' | 'none';

export type DifficultyLevel = 'easy' | 'normal' | 'hard' | 'veryHard';

/** Advantage: the better of two rolls; disadvantage: the worse. */
export type RollMode = 'adv' | 'dis';

/** How many times one exploding die may roll again. */
const EXPLODE_MAX = 10;

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
    /** Roll twice and keep the better (adv) or the worse (dis). */
    mode?: RollMode | null;
    /** Added to the total (status and item modifiers of the check). */
    bonus?: number;
}

export interface DiceRoll {
    /** Faces of the kept roll in order (every die, dropped ones of keep-highest/lowest included). */
    rolls: number[];
    /** Sum of the kept dice (signed by group). */
    natural: number;
    modifier: number;
    total: number;
    target: number | null;
    under: boolean;
    outcome: DiceOutcome;
    /** Attributes the formula needs that had no numeric value (modifier 0; a missing roll-under target → none). */
    missing: string[];
    /** Faces of the dice that keep-highest/lowest dropped. */
    dropped?: number[];
    /** Advantage / disadvantage: the mode and the total of the roll that was not kept. */
    mode?: RollMode;
    other?: { rolls: number[]; total: number };
}

const UNDER_SCALE: Record<DifficultyLevel, number> = { easy: 1.5, normal: 1, hard: 0.5, veryHard: 0.2 };

export function criticalsByDefault(formula: Pick<DiceFormula, 'count' | 'sides'> & { parts?: unknown }): boolean {
    return !formula.parts && formula.count === 1 && (formula.sides === 20 || formula.sides === 100);
}

/** 'critical' / 'fumble' for a natural extreme, null otherwise (d100: 01–05 and 96–00). */
function naturalExtreme(formula: DiceFormula, sum: number, under: boolean): 'critical' | 'fumble' | null {
    if (!formula.parts && formula.count === 1 && formula.sides === 100) {
        if (sum <= 5) return under ? 'critical' : 'fumble';
        if (sum >= 96) return under ? 'fumble' : 'critical';
        return null;
    }
    const range = naturalRange(formula);
    if (!range) return null;
    if (sum === range.max) return under ? 'fumble' : 'critical';
    if (sum === range.min) return under ? 'critical' : 'fumble';
    return null;
}

interface RawRoll {
    rolls: number[];
    dropped: number[];
    natural: number;
}

function rollParts(formula: DiceFormula, rng: Rng): RawRoll {
    const rolls: number[] = [];
    const dropped: number[] = [];
    let natural = 0;
    for (const part of diceParts(formula)) {
        if (part.kind !== 'dice') continue;
        const faces: number[] = [];
        for (let i = 0; i < part.count; i++) {
            let face = rollDie(part.sides, rng);
            let die = face;
            for (let again = 0; part.explode && face === part.sides && again < EXPLODE_MAX; again++) {
                face = rollDie(part.sides, rng);
                die += face;
            }
            faces.push(die);
        }
        rolls.push(...faces);
        let kept = faces;
        if (part.keep) {
            const sorted = [...faces].sort((a, b) => (part.keep?.high ? b - a : a - b));
            kept = sorted.slice(0, part.keep.n);
            const rest = [...faces];
            for (const face of kept) rest.splice(rest.indexOf(face), 1);
            dropped.push(...rest);
        }
        natural += part.sign * kept.reduce((total, value) => total + value, 0);
    }
    return { rolls, dropped, natural };
}

export function rollDice(formula: DiceFormula, lookup: AttributeLookup, rng: Rng, options: RollOptions = {}): DiceRoll {
    const missing: string[] = [];
    const read = (attribute: string): number | null => {
        const value = lookup(attribute);
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (!missing.includes(attribute)) missing.push(attribute);
        return null;
    };
    let modifier = 0;
    for (const part of diceParts(formula)) {
        if (part.kind !== 'term') continue;
        const { term } = part;
        if (term.kind === 'flat') modifier += part.sign * term.value;
        else {
            const value = read(term.attribute);
            if (value !== null) modifier += part.sign * (term.kind === 'mod' ? dndModifier(value) : Math.round(value));
        }
    }
    const bonus = typeof options.bonus === 'number' && Number.isFinite(options.bonus) ? Math.round(options.bonus) : 0;
    modifier += bonus;
    const under = formula.under !== null;
    let target: number | null = null;
    if (formula.under) {
        const base = formula.under.kind === 'flat' ? formula.under.value : read(formula.under.attribute);
        if (base !== null) target = Math.floor(base * UNDER_SCALE[options.level ?? 'normal']);
    } else if (typeof options.difficulty === 'number' && Number.isFinite(options.difficulty)) {
        target = Math.round(options.difficulty);
    }
    let kept = rollParts(formula, rng);
    let other: RawRoll | null = null;
    if (options.mode === 'adv' || options.mode === 'dis') {
        const second = rollParts(formula, rng);
        // Roll-under wants the lower total; advantage keeps the better one.
        const firstBetter = under ? kept.natural <= second.natural : kept.natural >= second.natural;
        const keepFirst = options.mode === 'adv' ? firstBetter : !firstBetter;
        other = keepFirst ? second : kept;
        if (!keepFirst) kept = second;
    }
    const total = kept.natural + modifier;
    const criticals = options.criticals ?? criticalsByDefault(formula);
    const extreme = criticals ? naturalExtreme(formula, kept.natural, under) : null;
    let outcome: DiceOutcome;
    if (extreme) outcome = extreme;
    else if (target === null) outcome = 'none';
    else if (under) outcome = total <= target ? 'success' : 'failure';
    else outcome = total >= target ? 'success' : 'failure';
    const roll: DiceRoll = {
        rolls: kept.rolls,
        natural: kept.natural,
        modifier,
        total,
        target,
        under,
        outcome,
        missing,
    };
    if (kept.dropped.length) roll.dropped = kept.dropped;
    if (other && options.mode) {
        roll.mode = options.mode;
        roll.other = { rolls: other.rolls, total: other.natural + modifier };
    }
    return roll;
}

/** How far a roll beat its target (positive) or missed it (negative); 0 without a target. */
export function marginOf(roll: Pick<DiceRoll, 'total' | 'target' | 'under'>): number {
    if (roll.target === null) return 0;
    return roll.under ? roll.target - roll.total : roll.total - roll.target;
}

/* ------------------------------------------------------------------ opposed */

/**
 * The actor's outcome against the other side: criticals of the actor's own roll stand; otherwise roll-over: a higher
 * total wins (a tie keeps things as they are: the defender wins); roll-under: the actor must succeed, and beat a
 * succeeding defender by margin.
 */
export function opposedOutcome(actor: DiceRoll, defender: DiceRoll): DiceOutcome {
    if (actor.outcome === 'critical' || actor.outcome === 'fumble') return actor.outcome;
    if (actor.under) {
        const actorOk = actor.target !== null && actor.total <= actor.target;
        if (!actorOk) return 'failure';
        const defenderOk = defender.target !== null && defender.total <= defender.target;
        if (defender.outcome === 'critical') return 'failure';
        return !defenderOk || marginOf(actor) > marginOf(defender) ? 'success' : 'failure';
    }
    if (defender.outcome === 'critical') return 'failure';
    return actor.total > defender.total ? 'success' : 'failure';
}

/* ------------------------------------------------------------------ difficulty */

/** The middle of the formula's range (dice only), the base when a check has no default difficulty. */
export function middleOf(formula: Pick<DiceFormula, 'count' | 'sides'> & Partial<Pick<DiceFormula, 'parts'>>): number {
    if (formula.parts) {
        const range = naturalRange(formula as DiceFormula);
        if (range) return Math.round((range.min + range.max) / 2);
    }
    return Math.round((formula.count * (formula.sides + 1)) / 2);
}

/**
 * The target of a roll-over check at a difficulty level: the check's default (or the middle of the range) moved by a
 * quarter of the dice range per step (d20: 5, 2d6: 3, d100: 25). Roll-under checks carry their own target: null.
 */
export function difficultyFor(level: DifficultyLevel, base: number | null, formula: DiceFormula): number | null {
    if (formula.under) return null;
    const start = base ?? middleOf(formula);
    const range = formula.parts ? naturalRange(formula) : null;
    const spread = range ? range.max - range.min : formula.count * formula.sides - formula.count;
    const step = Math.max(1, Math.round(spread / 4));
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

/** The English word of an outcome ('critical success'); '' for 'none'. */
export function outcomeText(outcome: DiceOutcome): string {
    return OUTCOME_TEXT[outcome];
}

function diceShown(roll: DiceRoll): string {
    return roll.rolls.length > 1 ? `${roll.natural} (${roll.rolls.join('+')})` : String(roll.natural);
}

/** "rolled 14 + 2 = 16 vs 15 — success" without the check and the holder (the pult shows it too). */
export function rollText(roll: DiceRoll): string {
    let text = `rolled ${diceShown(roll)}`;
    if (roll.modifier !== 0) {
        text += ` ${roll.modifier < 0 ? '-' : '+'} ${Math.abs(roll.modifier)} = ${roll.total}`;
    }
    if (roll.mode && roll.other) {
        text += ` (${roll.mode === 'adv' ? 'advantage' : 'disadvantage'}, other roll ${roll.other.total})`;
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

/**
 * The English fact of an opposed check: "Stealth (Kai) vs Perception (Guard): 14 vs 11 — success." (the outcome is
 * the actor's).
 */
export function opposedFact(
    actor: { check: string; holder: string; roll: DiceRoll },
    defender: { check: string; holder: string; roll: DiceRoll },
    outcome: DiceOutcome,
): string {
    const left = `${actor.check.trim() || 'Skill'} (${actor.holder.trim()})`;
    const right = `${defender.check.trim() || 'Skill'} (${defender.holder.trim()})`;
    const word = OUTCOME_TEXT[outcome] || 'tie';
    const natural = outcome === 'critical' || outcome === 'fumble' ? ` (natural ${actor.roll.natural})` : '';
    return `${left} vs ${right}: ${actor.roll.total} vs ${defender.roll.total} — ${word}${natural}.`;
}
