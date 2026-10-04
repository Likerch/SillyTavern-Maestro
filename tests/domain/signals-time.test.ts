import { describe, expect, it } from 'vitest';
import { dateKey, monthNumber, parseClock, parseDay, timeJump } from '../../src/domain/signals-time';

describe('parseClock', () => {
    it('reads 24-hour and 12-hour clocks', () => {
        expect(parseClock('18:30')).toBe(18 * 60 + 30);
        expect(parseClock('Evening, 18.05')).toBe(18 * 60 + 5);
        expect(parseClock('6:30 PM')).toBe(18 * 60 + 30);
        expect(parseClock('12:15 a.m.')).toBe(15);
        expect(parseClock('12:00 pm')).toBe(12 * 60);
        expect(parseClock('9 am')).toBe(9 * 60);
        expect(parseClock('11 p.m.')).toBe(23 * 60);
        expect(parseClock('24:00')).toBe(0);
        expect(parseClock('около 7ч30')).toBe(7 * 60 + 30);
    });

    it('reads midnight and noon words', () => {
        expect(parseClock('Midnight')).toBe(0);
        expect(parseClock('полдень')).toBe(720);
        expect(parseClock('около полуночи')).toBeNull();
    });

    it('gives null for what it cannot read', () => {
        expect(parseClock(undefined)).toBeNull();
        expect(parseClock('Evening')).toBeNull();
        expect(parseClock('25:00')).toBeNull();
        expect(parseClock('10:75')).toBeNull();
        expect(parseClock('13 pm')).toBeNull();
        expect(parseClock('9 amber')).toBeNull();
    });
});

describe('parseDay', () => {
    it('reads story days', () => {
        expect(parseDay('Day 3')).toEqual({ kind: 'day', value: 3 });
        expect(parseDay('День 12, утро')).toEqual({ kind: 'day', value: 12 });
        expect(parseDay('3rd day of the journey')).toEqual({ kind: 'day', value: 3 });
        expect(parseDay('Monday')).toBeNull();
    });

    it('reads calendar dates', () => {
        expect(parseDay('March 5, 1856')).toMatchObject({ kind: 'date', year: 1856, month: 3, day: 5 });
        expect(parseDay('5 марта 1856 г.')).toMatchObject({ year: 1856, month: 3, day: 5 });
        expect(parseDay('Понедельник, 3 марта')).toMatchObject({ month: 3, day: 3 });
        expect(parseDay('1815, March 15')).toMatchObject({ year: 1815, month: 3, day: 15 });
        expect(parseDay('the 5th of May')).toMatchObject({ month: 5, day: 5 });
        expect(parseDay('1856-03-05')).toMatchObject({ year: 1856, month: 3, day: 5 });
        expect(parseDay('05.03.1856')).toMatchObject({ year: 1856, month: 3, day: 5 });
        expect(parseDay('05/03/24')).toMatchObject({ year: 2024, month: 3, day: 5 });
        expect(parseDay('March')).toBeNull();
        expect(parseDay('40.13.2000')).toBeNull();
        expect(parseDay(undefined)).toBeNull();
    });

    it('knows month words', () => {
        expect(monthNumber('марта')).toBe(3);
        expect(monthNumber('dec')).toBe(12);
        expect(monthNumber('toString')).toBeUndefined();
    });

    it('keys dates by their word set', () => {
        expect(dateKey('Monday, 3 March')).toBe(dateKey('3 March, Monday'));
    });
});

describe('timeJump', () => {
    it('measures jumps within a day', () => {
        expect(timeJump({ date: 'Day 1', end: '18:00' }, { date: 'Day 1', start: '19:00' }, 6)).toEqual({
            skipped: false,
            hours: 1,
            dateChanged: false,
        });
        expect(timeJump({ start: '08:00' }, { start: '20:00' }, 6)).toEqual({
            skipped: true,
            hours: 12,
            dateChanged: false,
        });
    });

    it('measures jumps across days', () => {
        expect(timeJump({ date: 'Day 1', start: '23:00' }, { date: 'Day 2', start: '01:00' }, 6)).toMatchObject({
            skipped: false,
            hours: 2,
            dateChanged: true,
        });
        expect(timeJump({ date: 'Day 1', start: '10:00' }, { date: 'Day 2', start: '10:00' }, 6)).toMatchObject({
            skipped: true,
            hours: 24,
        });
        expect(timeJump({ date: 'Day 1' }, { date: 'Day 3' }, 6)).toMatchObject({ skipped: true, hours: 48 });
        expect(timeJump({ date: 'March 5, 1856' }, { date: 'March 6' }, 6)).toMatchObject({ skipped: true, hours: 24 });
    });

    it('treats wording changes of the same date as no change', () => {
        expect(timeJump({ date: 'Monday, 3 March' }, { date: '3 March, Monday' }, 6)).toEqual({
            skipped: false,
            dateChanged: false,
        });
        expect(timeJump({ date: 'March 3' }, { date: '3 марта' }, 6)).toEqual({ skipped: false, dateChanged: false });
    });

    it('counts an unreadable date change as a skip unless both clocks say otherwise', () => {
        expect(timeJump({ date: 'Spring' }, { date: 'Summer' }, 6)).toEqual({ skipped: true, dateChanged: true });
        expect(
            timeJump({ date: 'Night of the feast', end: '23:00' }, { date: 'Morning after', start: '07:00' }, 6),
        ).toMatchObject({ skipped: true, hours: 8 });
        expect(
            timeJump({ date: 'Night of the feast', end: '23:00' }, { date: 'Morning after', start: '01:00' }, 6),
        ).toMatchObject({ skipped: false, hours: 2 });
    });

    it('never counts time going backwards', () => {
        expect(timeJump({ date: 'Day 3' }, { date: 'Day 2' }, 6)).toEqual({ skipped: false, dateChanged: true });
        expect(timeJump({ start: '20:00' }, { start: '08:00' }, 6)).toEqual({ skipped: false, dateChanged: false });
        expect(timeJump({ date: 'Day 2' }, { date: 'Day 2' }, 6)).toEqual({ skipped: false, dateChanged: false });
        expect(timeJump({ date: 'Day 1' }, { date: 'March 5' }, 6)).toMatchObject({ dateChanged: true });
    });
});
