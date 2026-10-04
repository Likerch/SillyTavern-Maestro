import { describe, expect, it } from 'vitest';
import {
    advanceClock,
    calendarDate,
    dateDifference,
    daysFromEpoch,
    elapsedMinutes,
    formatMinutes,
    labelDay,
    momentOf,
    parseDueExpression,
    readLabel,
    relativeDays,
    resolveDue,
} from '../../src/domain/calendar-time';
import type { ObservedTime, StoryClock } from '../../src/domain/calendar-time';

/** Runs a sequence of tracker times through the clock; returns the day counter after each. */
function days(steps: ObservedTime[]): number[] {
    let clock: StoryClock | null = null;
    const out: number[] = [];
    for (const step of steps) {
        const next = advanceClock(clock, step);
        if (next) clock = next.clock;
        out.push(clock?.day ?? -1);
    }
    return out;
}

function clockAt(steps: ObservedTime[]): StoryClock {
    let clock: StoryClock | null = null;
    for (const step of steps) clock = advanceClock(clock, step)?.clock ?? clock;
    if (!clock) throw new Error('no clock');
    return clock;
}

describe('dates', () => {
    it('counts days from the epoch, also for years below 100', () => {
        expect(daysFromEpoch(1970, 1, 1)).toBe(0);
        expect(daysFromEpoch(1970, 1, 2)).toBe(1);
        expect(daysFromEpoch(50, 1, 1)).toBeLessThan(daysFromEpoch(1850, 1, 1));
    });

    it('reads story days and Gregorian dates', () => {
        expect(calendarDate('Day 3')).toEqual({ kind: 'day', n: 3 });
        expect(calendarDate('День 12')).toEqual({ kind: 'day', n: 12 });
        expect(calendarDate('5 марта')).toEqual({ kind: 'date', n: 64 });
        expect(calendarDate('March 5, 1856')).toMatchObject({ kind: 'date', n: 64, abs: daysFromEpoch(1856, 3, 5) });
        expect(calendarDate('12 Зимня')).toBeNull();
        expect(calendarDate(undefined)).toBeNull();
    });

    it('measures date differences, the year optional', () => {
        const a = calendarDate('Dec 31')!;
        const b = calendarDate('Jan 1')!;
        expect(dateDifference(a, b)).toBe(1);
        expect(dateDifference(b, a)).toBe(-1);
        expect(dateDifference(calendarDate('Feb 28, 1856')!, calendarDate('March 1, 1856')!)).toBe(2);
        expect(dateDifference(calendarDate('Day 3')!, calendarDate('Day 7')!)).toBe(4);
        expect(dateDifference(calendarDate('Day 3')!, calendarDate('5 May')!)).toBeNull();
    });
});

describe('labels', () => {
    it('separates words, numbers, weekdays and day parts', () => {
        expect(readLabel('Утро, 12 Зимня')).toMatchObject({ key: 'зимн', numbers: [12] });
        expect(readLabel('Monday, March 5, 1856')).toMatchObject({ key: '', weekday: 0, numbers: [5, 1856] });
        expect(readLabel('Пятница')).toMatchObject({ weekday: 4 });
        expect(readLabel('3rd of Frostfall, 4E 201')).toMatchObject({ key: 'frostfall', numbers: [3, 4, 201] });
        expect(readLabel('Day 3, 14:30')).toMatchObject({ numbers: [3], date: { kind: 'day', n: 3 } });
        expect(readLabel('None')).toBeNull();
        expect(readLabel('  ')).toBeNull();
        expect(readLabel(undefined)).toBeNull();
    });

    it('gives the weekday of a dated label with a year', () => {
        expect(readLabel('2026-10-05')?.weekday).toBe(0);
        expect(readLabel('March 5, 1856')?.weekday).toBe(2);
    });

    it('reads relative words', () => {
        expect(relativeDays('The next day')).toBe(1);
        expect(relativeDays('Three days later')).toBe(3);
        expect(relativeDays('На следующий день')).toBe(1);
        expect(relativeDays('Неделю спустя')).toBe(7);
        expect(relativeDays('Спустя два дня')).toBe(2);
        expect(relativeDays('Today')).toBeNull();
        expect(relativeDays(undefined)).toBeNull();
        expect(relativeDays('Следующий день')).toBe(1);
        expect(relativeDays('The day after')).toBe(1);
        expect(relativeDays('A fortnight later')).toBe(14);
        expect(relativeDays('Год спустя')).toBe(365);
        expect(relativeDays('Two years later')).toBe(730);
    });
});

describe('the story clock', () => {
    it('follows story days and dates exactly', () => {
        expect(days([{ date: 'Day 3' }, { date: 'Day 3' }, { date: 'Day 4' }, { date: 'Day 7' }])).toEqual([
            3, 3, 4, 7,
        ]);
        expect(days([{ date: '5 марта' }, { date: '6 марта' }, { date: '6 марта' }, { date: '1 апреля' }])).toEqual([
            1, 2, 2, 28,
        ]);
        expect(days([{ date: 'Dec 30' }, { date: 'Dec 31' }, { date: 'Jan 2' }])).toEqual([1, 2, 4]);
    });

    it('never goes back on DES noise and catches up after it', () => {
        expect(
            days([{ date: 'Day 3' }, { date: 'Day 5' }, { date: 'Day 3' }, { date: 'Day 5' }, { date: 'Day 6' }]),
        ).toEqual([3, 5, 5, 5, 6]);
        expect(days([{ date: 'March 5, 1856' }, { date: 'March 5, 2856' }])).toEqual([1, 1]);
    });

    it('counts fantasy calendars by label changes', () => {
        expect(
            days([
                { date: '12 Зимня', start: '08:00' },
                { date: '12 Зимня', start: '20:00' },
                { date: '14 Зимня', start: '09:00' },
                { date: '1 Весеня', start: '10:00' },
            ]),
        ).toEqual([1, 1, 3, 4]);
        expect(
            days([{ date: 'Morning of the Feast' }, { date: 'Evening of the Feast' }, { date: 'Harvest Eve' }]),
        ).toEqual([1, 1, 2]);
        expect(days([{ date: 'Monday' }, { date: 'Thursday' }, { date: 'Thursday' }])).toEqual([1, 4, 4]);
        expect(days([{ date: 'Весна, 1024' }, { date: 'Весна, 1024' }, { date: 'Лето, 1024' }])).toEqual([1, 1, 2]);
        expect(
            days([{ date: '3rd day of Frostfall' }, { date: '5th day of Frostfall' }, { date: '1st day of Sun Dawn' }]),
        ).toEqual([3, 5, 6]);
        expect(days([{ date: 'Day 3' }, { date: 'Day 3 of the journey' }, { date: 'Day 4 of the journey' }])).toEqual([
            3, 3, 4,
        ]);
    });

    it('takes relative labels and keeps the last real label across blank ones', () => {
        expect(days([{ date: 'Ярмарка' }, { date: 'Три дня спустя' }])).toEqual([1, 4]);
        expect(days([{ start: '20:00' }, { date: 'The next day', start: '09:00' }])).toEqual([1, 2]);
        expect(days([{ date: 'Evening' }, { date: 'Ярмарка' }])).toEqual([1, 1]);
        expect(days([{ date: 'March 5' }, { date: 'The next morning' }, { date: 'March 6' }])).toEqual([1, 2, 2]);
        const clock = clockAt([{ date: '12 Зимня' }, { date: 'Evening', start: '19:00' }]);
        expect(clock).toMatchObject({ label: '12 Зимня', day: 1, minutes: 19 * 60, time: '19:00' });
        expect(days([{ date: '12 Зимня' }, { date: 'Evening' }, { date: '13 Зимня' }])).toEqual([1, 1, 2]);
    });

    it('counts a wrapped clock as the next day when DES has no date', () => {
        expect(
            days([{ start: '18:00', end: '22:30' }, { start: '23:00' }, { start: '07:00' }, { start: '06:40' }]),
        ).toEqual([1, 1, 2, 2]);
        expect(advanceClock(clockAt([{ start: '22:00' }]), { start: '06:00' })?.reason).toBe('wrap');
    });

    it('re-anchors when the calendar changes and keeps weekdays', () => {
        const clock = clockAt([{ date: 'Monday, Day 1' }, { date: 'Day 3' }]);
        expect(clock).toMatchObject({ day: 3, weekday: 2 });
        const changed = clockAt([{ date: 'Day 3' }, { date: 'March 5' }, { date: 'March 7' }]);
        expect(changed.day).toBe(6);
        expect(changed.anchor).toMatchObject({ kind: 'date', day: 6 });
    });

    it('ignores a reply without date and time and gives the time span', () => {
        expect(advanceClock(null, {})).toBeNull();
        const first = advanceClock(null, { date: 'Day 2', start: '9 am', end: '10:15' });
        expect(first).toMatchObject({ delta: 0, reason: 'first', clock: { day: 2, minutes: 615, time: '9 am–10:15' } });
        expect(momentOf(first?.clock)).toEqual({ label: 'Day 2', day: 2, minutes: 615 });
        expect(momentOf(null)).toBeNull();
        expect(momentOf({ label: '', time: '19:00', day: 1 })).toEqual({ label: '19:00', day: 1 });
    });
});

describe('moments', () => {
    it('measures story minutes', () => {
        expect(elapsedMinutes({ label: '', day: 1, minutes: 600 }, { label: '', day: 2, minutes: 60 })).toBe(900);
        expect(elapsedMinutes({ label: '', day: 1 }, { label: '', day: 2, minutes: 60 })).toBe(1440);
        expect(elapsedMinutes({ label: '', day: null }, { label: '', day: 2 })).toBeNull();
    });

    it('formats minutes', () => {
        expect(formatMinutes(0)).toBe('00:00');
        expect(formatMinutes(19 * 60 + 5)).toBe('19:05');
        expect(formatMinutes(1440 + 30)).toBe('00:30');
    });
});

describe('deadline phrases', () => {
    const base = (): StoryClock => ({
        label: 'Day 5',
        day: 5,
        minutes: 10 * 60,
        weekday: 0,
        anchor: { kind: 'day', n: 5, key: '', day: 5 },
    });
    const due = (text: string, clock: StoryClock | null = base()) => {
        const expression = parseDueExpression(text);
        return expression ? resolveDue(expression, clock) : null;
    };

    it('reads tomorrow and the day after, in both languages', () => {
        expect(due('Anna promised to return the sword by tomorrow.')).toEqual({ label: 'by tomorrow', day: 6 });
        expect(due('Верну завтра')).toMatchObject({ day: 6 });
        expect(due('Приду послезавтра')).toMatchObject({ day: 7 });
        expect(due('He will pay the day after tomorrow')).toMatchObject({ day: 7 });
        expect(due('He will pay tomorrow evening')).toEqual({ label: 'tomorrow evening', day: 6, minutes: 19 * 60 });
        expect(due('Жду тебя завтра утром')).toEqual({ label: 'завтра утром', day: 6, minutes: 8 * 60 });
    });

    it('reads day parts: today or tomorrow if passed', () => {
        expect(due('Верну меч к закату')).toEqual({ label: 'к закату', day: 5, minutes: 19 * 60 });
        expect(due('Agreed to meet at dawn')).toMatchObject({ day: 6, minutes: 6 * 60 });
        expect(due('until morning', { ...base(), minutes: undefined })).toMatchObject({ day: 6, minutes: 8 * 60 });
        expect(due('by noon', { ...base(), minutes: 13 * 60 })).toMatchObject({ day: 6, minutes: 12 * 60 });
        expect(due('Вернусь до темноты')).toMatchObject({ day: 5, minutes: 19 * 60 });
        expect(due('Придёт сегодня вечером', { ...base(), minutes: 20 * 60 })).toMatchObject({ day: 5 });
        expect(due('He will be back tonight')).toMatchObject({ day: 5, minutes: 22 * 60 });
        expect(due('к концу дня')).toMatchObject({ day: 5, minutes: 1439 });
        expect(due('by the afternoon')).toMatchObject({ day: 5, minutes: 15 * 60 });
        expect(due('Зайду днём')).toMatchObject({ day: 5, minutes: 15 * 60 });
        expect(due('до полуночи')).toMatchObject({ day: 5, minutes: 1439 });
        expect(due('в обед')).toMatchObject({ day: 5, minutes: 12 * 60 });
        expect(due('Мы идём на вечеринку')).toBeNull();
    });

    it('reads relative offsets with counts', () => {
        expect(due('Promised to come back in two days')).toEqual({ label: 'in two days', day: 7 });
        expect(due('within a week')).toMatchObject({ day: 12 });
        expect(due('in a couple of days')).toMatchObject({ day: 7 });
        expect(due('three days from now')).toMatchObject({ day: 8 });
        expect(due('Обещал вернуться через три дня')).toEqual({ label: 'через три дня', day: 8 });
        expect(due('через неделю')).toMatchObject({ day: 12 });
        expect(due('через пару дней')).toMatchObject({ day: 7 });
        expect(due('в течение месяца')).toMatchObject({ day: 35 });
        expect(due('на следующей неделе')).toMatchObject({ day: 12 });
        expect(due('next week')).toMatchObject({ day: 12 });
        expect(due('через день')).toMatchObject({ day: 6 });
    });

    it('reads hours', () => {
        expect(due('in two hours')).toMatchObject({ day: 5, minutes: 12 * 60 });
        expect(due('через час', { ...base(), minutes: 23 * 60 + 30 })).toMatchObject({ day: 6, minutes: 30 });
        expect(due('in 30 hours', { ...base(), minutes: undefined })).toMatchObject({ day: 6 });
    });

    it('reads clock times', () => {
        expect(due('Meet me at 6 pm')).toMatchObject({ day: 5, minutes: 18 * 60 });
        expect(due('by 18:30')).toMatchObject({ day: 5, minutes: 18 * 60 + 30 });
        expect(due('Приходи в 6 вечера')).toMatchObject({ day: 5, minutes: 18 * 60 });
        expect(due('к 8 утра')).toMatchObject({ day: 6, minutes: 8 * 60 });
        expect(due('в 11 ночи')).toMatchObject({ minutes: 23 * 60 });
        expect(due('в 2 ночи')).toMatchObject({ day: 6, minutes: 2 * 60 });
        expect(due('в час дня')).toMatchObject({ minutes: 13 * 60 });
        expect(due('к 5 золотым')).toBeNull();
        expect(due('в 13 вечера')).toBeNull();
        expect(due('в 12 утра')).toMatchObject({ day: 6, minutes: 0 });
        expect(due('в 12 дня')).toMatchObject({ day: 5, minutes: 12 * 60 });
        expect(due('в 12 ночи')).toMatchObject({ day: 6, minutes: 0 });
        expect(due('в шесть вечера')).toMatchObject({ minutes: 18 * 60 });
        expect(due('in a year')).toMatchObject({ day: 370 });
        expect(due('within a fortnight')).toMatchObject({ day: 19 });
    });

    it('reads weekdays against the known weekday', () => {
        expect(due('by Friday')).toMatchObject({ day: 9 });
        expect(due('к пятнице')).toMatchObject({ day: 9 });
        expect(due('в следующий понедельник')).toMatchObject({ day: 12 });
        expect(due('by Friday', { ...base(), weekday: undefined })).toEqual({ label: 'by Friday', day: null });
    });

    it('reads explicit dates against the anchor', () => {
        expect(due('Promised to deliver it on Day 7')).toMatchObject({ day: 7 });
        const dated: StoryClock = { label: 'March 1', day: 2, anchor: { kind: 'date', n: 60, key: '', day: 2 } };
        expect(due('by March 5', dated)).toMatchObject({ day: 6 });
        expect(due('к 5 марта', dated)).toMatchObject({ day: 6 });
        expect(due('by March 5')).toEqual({ label: 'by March 5', day: null });
    });

    it('works without a clock and without a deadline', () => {
        expect(due('by tomorrow', null)).toEqual({ label: 'by tomorrow', day: null });
        expect(due('к закату', null)).toEqual({ label: 'к закату', day: null, minutes: 19 * 60 });
        expect(parseDueExpression('Anna promised to help Boris with the harvest.')).toBeNull();
        expect(parseDueExpression('')).toBeNull();
        expect(parseDueExpression(undefined)).toBeNull();
    });

    it('labels long phrases by their first part', () => {
        const expression = parseDueExpression(
            'He promised tomorrow that he would, after a very long journey through the mountains and rivers, come by sunset',
        );
        expect(expression?.label).toBe('tomorrow');
    });
});

describe('labels typed by hand', () => {
    it('places a label against the clock', () => {
        const fantasy = clockAt([{ date: '12 Зимня' }]);
        expect(labelDay('15 Зимня', fantasy)).toBe(4);
        expect(labelDay('12 Зимня', fantasy)).toBe(1);
        expect(labelDay('Лето', fantasy)).toBeNull();
        const days3 = clockAt([{ date: 'Day 3' }]);
        expect(labelDay('Day 9', days3)).toBe(9);
        const weekday = clockAt([{ date: 'Monday' }]);
        expect(labelDay('Friday', weekday)).toBe(5);
        expect(labelDay('', weekday)).toBeNull();
        expect(labelDay('Friday', null)).toBeNull();
        expect(labelDay('Friday', clockAt([{ start: '10:00' }]))).toBeNull();
    });
});
