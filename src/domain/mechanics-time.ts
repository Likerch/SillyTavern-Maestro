// M25 «Механики», time and growth (plan-2 §6 п. 5 «Время», п. 10 «Развитие»):
// - the story clock of the mechanics follows DES's date and time of every committed reply (the calendar's reading of
//   them, domain/calendar-time advanceClock); a step between two committed replies is one turn and the story minutes
//   in between. Time rules turn a step into amounts: per turn, per story hour (hour boundaries crossed — no fractions
//   to carry, so a rollback only needs the values), per story day (days crossed). Without DES's time for a reply
//   (release 1.26) the clock moves by the minutes the service block (`time: +3h`) or the background parse says pass:
//   a relative clock counted from day 1, 00:00 when there was none;
// - experience and levels: the level a number of experience points gives (`thresholds[i]` → level i + 2);
// - growth by use: the next value of a skill after one use (capped).
// Pure: no DOM, no SillyTavern.
import type { AttributeGrowth, Progression, TimeRule } from './mechanics-defs';

export interface ClockPoint {
    day: number;
    minutes?: number;
    label?: string;
}

export interface TimeStep {
    /** Committed turns (replies) passed. */
    turns: number;
    /** Story minutes passed (0 when the clock is unknown or did not move). */
    minutes: number;
    /** Story hour boundaries crossed. */
    hours: number;
    /** Story days crossed. */
    days: number;
}

const MINUTES_PER_DAY = 1440;

function total(point: ClockPoint): number {
    return point.day * MINUTES_PER_DAY + (point.minutes ?? 0);
}

/**
 * The step from one clock reading to the next (one committed turn). Without a time of day on either side only whole
 * days count (24 hours each); a clock that goes back is noise (no time passes).
 */
export function timeStep(from: ClockPoint | null, to: ClockPoint | null, turns = 1): TimeStep {
    if (!from || !to) return { turns, minutes: 0, hours: 0, days: 0 };
    const days = Math.max(0, to.day - from.day);
    if (from.minutes === undefined || to.minutes === undefined) {
        return { turns, minutes: days * MINUTES_PER_DAY, hours: days * 24, days };
    }
    const minutes = Math.max(0, total(to) - total(from));
    if (!minutes) return { turns, minutes: 0, hours: 0, days: 0 };
    const hours = Math.max(0, Math.floor(total(to) / 60) - Math.floor(total(from) / 60));
    return { turns, minutes, hours, days };
}

/** How many periods of a rule a step holds. */
export function periodsOf(rule: Pick<TimeRule, 'per'>, step: TimeStep): number {
    return rule.per === 'turn' ? step.turns : rule.per === 'hour' ? step.hours : step.days;
}

/** A rule applies to a holder now: always, only while resting, or only while awake. */
export function ruleApplies(rule: Pick<TimeRule, 'when'>, resting: boolean): boolean {
    if (rule.when === 'rest') return resting;
    if (rule.when === 'awake') return !resting;
    return true;
}

/** The long pause that counts as rest by itself (a night, a time skip): six story hours or more. */
export const REST_MINUTES = 360;

/* ------------------------------------------------------------------ time without DES (release 1.26) */

/** A clock the minutes advance moves (the shape of the state's clock record). */
export interface MovableClock extends ClockPoint {
    label: string;
    /** DES's time as written: dropped once the clock moves by itself. */
    time?: string;
    weekday?: number;
    /** Counted from the service block or the background parse: no real time of day behind it. */
    relative?: true;
}

/** Where a clock counted without DES starts: day 1, 00:00, relative. */
export const RELATIVE_START: Readonly<MovableClock> = { day: 1, minutes: 0, label: '', relative: true };

/**
 * The clock `minutes` of story time later — the service block's `time: +3h` or the background parse's `elapsed`, when
 * DES gives no time for the reply. `from` is where the step starts (for timeStep): the clock itself, its midnight when
 * it has no time of day, or RELATIVE_START without a clock. A clock that had no time of day (or none at all) becomes
 * relative: its minutes are counted, not read.
 */
export function advanceByMinutes<T extends MovableClock>(
    clock: T | null,
    minutes: number,
): { from: MovableClock; clock: MovableClock } {
    const from: MovableClock = clock ? { ...clock, minutes: clock.minutes ?? 0 } : { ...RELATIVE_START };
    const add = Math.max(0, Math.round(Number.isFinite(minutes) ? minutes : 0));
    const total = (from.minutes ?? 0) + add;
    const days = Math.floor(total / MINUTES_PER_DAY);
    const next: MovableClock = { ...from, day: from.day + days, minutes: total % MINUTES_PER_DAY };
    delete next.time;
    if (next.weekday !== undefined) next.weekday = (next.weekday + days) % 7;
    if (!clock || clock.relative || clock.minutes === undefined) next.relative = true;
    return { from, clock: next };
}

/* ------------------------------------------------------------------ progression */

/** The level for an amount of experience: 1 below the first threshold, i + 2 at or above threshold i. */
export function levelFor(xp: number, thresholds: readonly number[]): number {
    let level = 1;
    for (const threshold of thresholds) if (xp >= threshold) level++;
    return level;
}

/** Experience still needed for the next level, null at the top. */
export function xpToNext(xp: number, progression: Pick<Progression, 'thresholds'>): number | null {
    const next = progression.thresholds.find((threshold) => threshold > xp);
    return next === undefined ? null : next - xp;
}

/* ------------------------------------------------------------------ growth */

/**
 * A skill's value after one use of a check that reads it: + perUse, never past the cap (nor the maximum); null when it
 * does not grow (the outcome does not count, or it is at the cap already).
 */
export function grownValue(
    current: number,
    growth: AttributeGrowth,
    outcome: 'critical' | 'success' | 'failure' | 'fumble' | 'none',
    max?: number,
): number | null {
    const counts = growth.on === 'any' ? outcome !== 'none' : outcome === 'success' || outcome === 'critical';
    if (!counts) return null;
    const limit = Math.min(growth.cap ?? Infinity, max ?? Infinity);
    if (current >= limit && growth.perUse > 0) return null;
    const next = Math.round((current + growth.perUse) * 10000) / 10000;
    return Math.min(limit, next);
}
