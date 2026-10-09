import { describe, expect, it } from 'vitest';
import {
    cleanStatement,
    evaluatePromise,
    findPromiseMatch,
    isActive,
    isPromiseState,
    promiseOutcome,
    samePromise,
    sharePeople,
    similarity,
    splitNames,
} from '../../src/domain/calendar-promises';
import type { Grace, PromiseState } from '../../src/domain/calendar-promises';

const grace: Grace = { days: 1, turns: 10 };
const at = (day: number, minutes?: number) =>
    minutes === undefined ? { label: '', day } : { label: '', day, minutes };

describe('statuses', () => {
    it('opens, comes due and runs late by story days', () => {
        const promise = { status: 'open' as PromiseState, due: at(5, 19 * 60) };
        expect(evaluatePromise(promise, at(5, 12 * 60), 1, grace)).toEqual({ status: 'open' });
        expect(evaluatePromise(promise, at(5, 19 * 60), 2, grace)).toEqual({ status: 'due', dueTurn: 2 });
        const due = { ...promise, status: 'due' as PromiseState, dueTurn: 2 };
        expect(evaluatePromise(due, at(6, 18 * 60), 3, grace)).toEqual({ status: 'due', dueTurn: 2 });
        expect(evaluatePromise(due, at(6, 19 * 60), 4, grace)).toEqual({ status: 'overdue', dueTurn: 2 });
    });

    it('runs late by turns', () => {
        const due = { status: 'due' as PromiseState, due: at(5), dueTurn: 2 };
        expect(evaluatePromise(due, at(5), 11, grace).status).toBe('due');
        expect(evaluatePromise(due, at(5), 12, grace).status).toBe('overdue');
        expect(evaluatePromise(due, at(5), 99, { days: 0, turns: 0 }).status).toBe('due');
    });

    it('goes straight to overdue when found late', () => {
        const promise = { status: 'open' as PromiseState, due: at(2) };
        expect(evaluatePromise(promise, at(4), 7, grace)).toEqual({ status: 'overdue', dueTurn: 7 });
    });

    it('reopens when the clock went back, keeps closed promises and promises without a day', () => {
        const overdue = { status: 'overdue' as PromiseState, due: at(5), dueTurn: 3 };
        expect(evaluatePromise(overdue, at(6), 4, grace).status).toBe('overdue');
        expect(evaluatePromise(overdue, at(4), 4, grace)).toEqual({ status: 'open' });
        expect(evaluatePromise({ status: 'done', due: at(1), dueTurn: 1 }, at(9), 9, grace)).toEqual({
            status: 'done',
            dueTurn: 1,
        });
        expect(evaluatePromise({ status: 'open', due: null }, at(9), 9, grace)).toEqual({ status: 'open' });
        expect(evaluatePromise({ status: 'open', due: at(1) }, null, 9, grace)).toEqual({ status: 'open' });
        expect(evaluatePromise({ status: 'open', due: { label: 'к празднику', day: null } }, at(3), 1, grace)).toEqual({
            status: 'open',
        });
    });

    it('lets a due promise without a story day run out of turns', () => {
        const due = { status: 'due' as PromiseState, due: null };
        expect(evaluatePromise(due, at(1), 5, grace)).toEqual({ status: 'due', dueTurn: 5 });
        expect(evaluatePromise({ ...due, dueTurn: 5 }, at(1), 15, grace)).toEqual({ status: 'overdue', dueTurn: 5 });
    });

    it('knows the states', () => {
        expect(isActive('due')).toBe(true);
        expect(isActive('broken')).toBe(false);
        expect(isPromiseState('cancelled')).toBe(true);
        expect(isPromiseState('lost')).toBe(false);
        expect(isPromiseState(3)).toBe(false);
    });
});

describe('outcomes', () => {
    it('reads kept, broken and cancelled promises', () => {
        expect(promiseOutcome('Anna kept her promise to return the sword.')).toBe('done');
        expect(promiseOutcome('Boris returned the ring as promised.')).toBe('done');
        expect(promiseOutcome('Boris paid off his debt to the guild.')).toBe('done');
        expect(promiseOutcome('Boris broke his word to Anna.')).toBe('broken');
        expect(promiseOutcome('He failed to keep the promise to meet at dawn.')).toBe('broken');
        expect(promiseOutcome('The deal with the smuggler was called off.')).toBe('cancelled');
        expect(promiseOutcome('Анна сдержала обещание вернуть меч.')).toBe('done');
        expect(promiseOutcome('Борис не сдержал слово.')).toBe('broken');
        expect(promiseOutcome('Уговор отменён.')).toBe('cancelled');
    });

    it('does not take a new promise for an outcome', () => {
        expect(promiseOutcome('Anna promised to return the sword by sunset.')).toBeNull();
        expect(promiseOutcome('Boris agreed to keep the secret until spring.')).toBeNull();
        expect(promiseOutcome('He kept the sword.')).toBeNull();
        expect(promiseOutcome('')).toBeNull();
        expect(promiseOutcome(undefined)).toBeNull();
    });
});

describe('matching', () => {
    const list = [
        {
            id: 'a',
            who: ['Anna'],
            what: 'Promised to return the sword to Boris by sunset.',
            status: 'due' as PromiseState,
        },
        { id: 'b', who: ['Anna'], what: 'Promised to bake bread for the festival.', status: 'open' as PromiseState },
        { id: 'c', who: ['Boris'], what: 'Promised to return the sword to the smith.', status: 'open' as PromiseState },
        { id: 'd', who: ['Anna'], what: 'Promised to return the sword to Boris.', status: 'done' as PromiseState },
    ];

    it('finds the promise an outcome is about', () => {
        expect(findPromiseMatch(list, ['Anna'], 'Kept her promise to return the sword to Boris.')?.id).toBe('a');
        expect(findPromiseMatch(list, ['Anna'], 'Kept the promise about the festival bread.')?.id).toBe('b');
        expect(findPromiseMatch(list, ['Clara'], 'Kept her promise to return the sword.')).toBeNull();
        expect(findPromiseMatch(list, ['Anna'], 'Kept her promise to visit the mill.')).toBeNull();
    });

    it('measures similarity without promise words', () => {
        expect(similarity('Promised to return the sword', 'Kept the promise to return the sword')).toBe(1);
        expect(similarity('Promised', 'Promised')).toBe(1);
        expect(similarity('Promised', 'Kept')).toBe(0);
        expect(similarity('', '')).toBe(0);
    });

    it('recognises the same promise again', () => {
        const a = { who: ['Anna'], what: 'Promised to return the sword by sunset.', quote: '«Верну к закату»' };
        expect(samePromise(a, { who: ['anna'], what: 'Will return the sword by sunset.' })).toBe(true);
        expect(samePromise(a, { who: ['Anna'], what: 'Something else', quote: '«верну к закату»' })).toBe(true);
        expect(samePromise(a, { who: ['Boris'], what: a.what })).toBe(false);
        expect(samePromise(a, { who: ['Anna'], what: 'Promised to bake bread.' })).toBe(false);
    });

    it("matches a Russian story's prepared promise by its English copy", () => {
        const prepared = {
            id: 'r',
            who: ['Anna'],
            what: 'Анна вернёт меч Борису до заката.',
            english: 'Promised to return the sword to Boris by sunset.',
            status: 'open' as PromiseState,
        };
        expect(findPromiseMatch([prepared], ['Anna'], 'Kept her promise to return the sword to Boris.')?.id).toBe('r');
        expect(samePromise(prepared, { who: ['Anna'], what: 'Will return the sword to Boris by sunset.' })).toBe(true);
        expect(samePromise({ who: ['Anna'], what: 'Will return the sword to Boris by sunset.' }, prepared)).toBe(true);
        expect(samePromise(prepared, { who: ['Anna'], what: 'Promised to bake bread.' })).toBe(false);
    });

    it('compares people lists', () => {
        expect(sharePeople([], ['Anna'])).toBe(true);
        expect(sharePeople(['Анна'], ['анна'])).toBe(true);
        expect(sharePeople(['Anna'], ['Boris'])).toBe(false);
    });
});

describe('text', () => {
    it('cleans statements', () => {
        expect(cleanStatement('  "Return   the sword"  ')).toBe('Return the sword');
        expect(cleanStatement('«Верну меч»')).toBe('Верну меч');
        expect(cleanStatement(' «Верну  меч» ', 100, false)).toBe('«Верну меч»');
        expect(cleanStatement(undefined)).toBe('');
        const long = cleanStatement(`${'word '.repeat(80)}end`, 40);
        expect(long.length).toBeLessThanOrEqual(41);
        expect(long.endsWith('…')).toBe(true);
        expect(cleanStatement('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}…`);
    });

    it('splits names', () => {
        expect(splitNames('Анна, Борис и Клара; Анна')).toEqual(['Анна', 'Борис', 'Клара']);
        expect(splitNames('Anna and Boris')).toEqual(['Anna', 'Boris']);
        expect(splitNames('')).toEqual([]);
        expect(splitNames(undefined)).toEqual([]);
    });
});
