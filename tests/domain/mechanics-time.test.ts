// M25 time and growth (plan-2 §6 п. 5, 10): steps of story time between committed replies, periods of time rules,
// rest, levels by experience, growth of skills by use.
import { describe, expect, it } from 'vitest';
import {
    grownValue,
    levelFor,
    periodsOf,
    REST_MINUTES,
    ruleApplies,
    timeStep,
    xpToNext,
} from '../../src/domain/mechanics-time';

describe('timeStep', () => {
    it('counts minutes, hour boundaries and days', () => {
        expect(timeStep({ day: 1, minutes: 590 }, { day: 1, minutes: 660 })).toEqual({
            turns: 1,
            minutes: 70,
            hours: 2,
            days: 0,
        });
        expect(timeStep({ day: 1, minutes: 1380 }, { day: 2, minutes: 60 }, 2)).toEqual({
            turns: 2,
            minutes: 120,
            hours: 2,
            days: 1,
        });
    });

    it('whole days without a time of day; nothing for an unknown or backward clock', () => {
        expect(timeStep({ day: 1 }, { day: 3, minutes: 600 })).toEqual({ turns: 1, minutes: 2880, hours: 48, days: 2 });
        expect(timeStep(null, { day: 3 })).toEqual({ turns: 1, minutes: 0, hours: 0, days: 0 });
        expect(timeStep({ day: 2, minutes: 600 }, { day: 2, minutes: 500 })).toEqual({
            turns: 1,
            minutes: 0,
            hours: 0,
            days: 0,
        });
    });
});

describe('time rules', () => {
    const step = { turns: 1, minutes: 400, hours: 7, days: 0 };

    it('periods per turn, hour and day', () => {
        expect(periodsOf({ per: 'turn' }, step)).toBe(1);
        expect(periodsOf({ per: 'hour' }, step)).toBe(7);
        expect(periodsOf({ per: 'day' }, step)).toBe(0);
    });

    it('rest-only and awake-only rules', () => {
        expect(ruleApplies({}, true)).toBe(true);
        expect(ruleApplies({ when: 'always' }, false)).toBe(true);
        expect(ruleApplies({ when: 'rest' }, true)).toBe(true);
        expect(ruleApplies({ when: 'rest' }, false)).toBe(false);
        expect(ruleApplies({ when: 'awake' }, true)).toBe(false);
        expect(REST_MINUTES).toBe(360);
    });
});

describe('progression', () => {
    it('levels by thresholds and what is left to the next', () => {
        expect(levelFor(0, [100, 300, 600])).toBe(1);
        expect(levelFor(100, [100, 300, 600])).toBe(2);
        expect(levelFor(650, [100, 300, 600])).toBe(4);
        expect(xpToNext(120, { thresholds: [100, 300] })).toBe(180);
        expect(xpToNext(400, { thresholds: [100, 300] })).toBeNull();
    });
});

describe('growth', () => {
    it('grows on success (or any outcome), capped by the cap and the maximum', () => {
        expect(grownValue(4, { perUse: 0.2 }, 'success')).toBe(4.2);
        expect(grownValue(4, { perUse: 0.2 }, 'critical')).toBe(4.2);
        expect(grownValue(4, { perUse: 0.2 }, 'failure')).toBeNull();
        expect(grownValue(4, { perUse: 0.2, on: 'any' }, 'failure')).toBe(4.2);
        expect(grownValue(4, { perUse: 0.2, on: 'any' }, 'none')).toBeNull();
        expect(grownValue(7.9, { perUse: 0.2, cap: 8 }, 'success')).toBe(8);
        expect(grownValue(8, { perUse: 0.2, cap: 8 }, 'success')).toBeNull();
        expect(grownValue(9.9, { perUse: 0.5 }, 'success', 10)).toBe(10);
        expect(grownValue(3, { perUse: -1 }, 'success', 2)).toBe(2);
    });
});
