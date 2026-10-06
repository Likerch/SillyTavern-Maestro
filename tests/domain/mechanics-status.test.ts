// M25 statuses and inventories (plan-2 §6 п. 3–4): instances from specs and catalogues, refresh and stacks, ticking
// by turns, story minutes and moments, durations from words, modifier sums, items given, taken and equipped, the
// model's text, stored data repaired.
import { describe, expect, it } from 'vitest';
import {
    applyStatus,
    catalogueStatus,
    durationText,
    equipItem,
    findItem,
    findStatus,
    giveItem,
    itemsText,
    makeStatus,
    mergeStatusSpec,
    minutesText,
    modifierSum,
    parseDurationText,
    readItem,
    readStatus,
    statusIdOf,
    storyMinutes,
    takeItem,
    tickStatuses,
} from '../../src/domain/mechanics-status';
import type { ItemState, StatusState } from '../../src/domain/mechanics-status';

let seq = 0;
const options = () => ({ id: `s${++seq}`, source: 'block', since: 4, at: 100, mechanicId: 'health' });

function poisoned(extra: Partial<StatusState> = {}): StatusState {
    return { ...makeStatus({ name: 'Отравлен', promptName: 'poisoned', duration: { turns: 3 } }, options()), ...extra };
}

describe('statuses', () => {
    it('make an instance with an id from the name, durations and modifiers', () => {
        const status = makeStatus(
            {
                name: 'Благословение',
                duration: { turns: 2, minutes: 90, until: { day: 3, minutes: 1080 } },
                modifiers: { checks: 1 },
                stacks: 5,
                maxStacks: 3,
                text: 'glows',
                icon: 'fa-sun',
            },
            options(),
        );
        expect(status).toMatchObject({
            statusId: 'blagoslovenie',
            name: 'Благословение',
            promptName: 'Благословение',
            remaining: { turns: 2, minutes: 90 },
            until: { day: 3, minutes: 1080 },
            modifiers: { checks: 1 },
            stacks: 3,
            maxStacks: 3,
            source: 'block',
            since: 4,
            mechanicId: 'health',
            text: 'glows',
            icon: 'fa-sun',
        });
        expect(makeStatus({ name: 'x', duration: null }, { id: 'a', source: 'user', since: -1, at: 0 })).toMatchObject({
            remaining: null,
            stacks: 1,
        });
        expect(makeStatus({ name: 'x', duration: { turns: 0 } }, options()).remaining).toBeNull();
        expect(statusIdOf({ id: 'own', name: 'x' })).toBe('own');
        expect(statusIdOf({ name: 'Poisoned', promptName: 'poisoned badly' })).toBe('poisoned_badly');
    });

    it('a repeat refreshes the longer duration, stacks up to the maximum, takes new modifiers and a later moment', () => {
        const first = poisoned({ remaining: { turns: 1, minutes: 30 }, until: { day: 1 } });
        const again = applyStatus([first], { name: 'poisoned', duration: { turns: 3, until: { day: 2 } } }, options());
        expect(again.before).toBe(first);
        expect(again.after).toMatchObject({
            id: first.id,
            remaining: { turns: 3, minutes: 30 },
            stacks: 1,
            until: { day: 2 },
        });
        const stacking = applyStatus(
            [{ ...first, maxStacks: 3 }],
            { name: 'poisoned', modifiers: { checks: -3 } },
            options(),
        );
        expect(stacking.after).toMatchObject({ stacks: 2, modifiers: { checks: -3 }, remaining: null });
        const fresh = applyStatus([first], { name: 'Blessed' }, options());
        expect(fresh.before).toBeNull();
        const earlier = applyStatus([first], { name: 'poisoned', duration: { until: { day: 0 } } }, options());
        expect(earlier.after.until).toEqual({ day: 1 });
    });

    it('are found by instance id, status id, name or English name; catalogues by id and names', () => {
        const status = poisoned();
        expect(findStatus([status], status.id)).toBe(status);
        expect(findStatus([status], 'poisoned')).toBe(status);
        expect(findStatus([status], 'POISONED')).toBe(status);
        expect(findStatus([status], 'Отравлен')).toBe(status);
        expect(findStatus([status], '')).toBeNull();
        expect(findStatus([status], 'blessed')).toBeNull();
        const catalogue = [{ id: 'stun', name: 'Оглушён', promptName: 'stunned' }, { name: 'Prone' }];
        expect(catalogueStatus(catalogue, 'stun')?.name).toBe('Оглушён');
        expect(catalogueStatus(catalogue, 'Stunned')?.name).toBe('Оглушён');
        expect(catalogueStatus(catalogue, 'prone')?.name).toBe('Prone');
        expect(catalogueStatus(catalogue, 'nope')).toBeNull();
    });

    it('merge a given spec over the catalogue (duration, modifiers and names of the catalogue fill gaps)', () => {
        const base = {
            id: 'stun',
            name: 'Оглушён',
            promptName: 'stunned',
            duration: { turns: 1 },
            modifiers: { checks: -5 },
        };
        expect(mergeStatusSpec(base, { name: 'stunned' })).toEqual({
            id: 'stun',
            name: 'Оглушён',
            promptName: 'stunned',
            duration: { turns: 1 },
            modifiers: { checks: -5 },
        });
        expect(
            mergeStatusSpec(base, { name: 'stunned', duration: { turns: 4 }, modifiers: { checks: -1 } }),
        ).toMatchObject({
            duration: { turns: 4 },
            modifiers: { checks: -1 },
        });
        expect(mergeStatusSpec({ name: 'A' }, { name: 'b', promptName: 'bee' })).toEqual({
            name: 'A',
            promptName: 'bee',
        });
        expect(mergeStatusSpec(null, { name: 'x' })).toEqual({ name: 'x' });
    });

    it('tick by turns and minutes and end at their moment', () => {
        const turns = poisoned({ remaining: { turns: 2 } });
        const minutes = poisoned({ id: 'm', statusId: 'm', remaining: { minutes: 60 } });
        const moment = poisoned({ id: 'u', statusId: 'u', remaining: null, until: { day: 2, minutes: 600 } });
        const forever = poisoned({ id: 'f', statusId: 'f', remaining: null });
        const step = tickStatuses([turns, minutes, moment, forever], {
            turns: 1,
            minutes: 30,
            now: { day: 2, minutes: 500 },
        });
        expect(step.expired).toEqual([]);
        expect(step.updated.map(([, after]) => after.remaining)).toEqual([{ turns: 1 }, { minutes: 30 }]);
        const later = tickStatuses([turns, minutes, moment], { turns: 2, minutes: 60, now: { day: 2, minutes: 600 } });
        expect(later.expired.map((status) => status.id)).toEqual([turns.id, 'm', 'u']);
        expect(tickStatuses([turns], { turns: 0, minutes: 0 }).updated).toEqual([]);
    });

    it('describe durations for the model', () => {
        expect(durationText({ remaining: { turns: 1 } })).toBe('1 turn left');
        expect(durationText({ remaining: { turns: 3, minutes: 120 } })).toBe('3 turns left, 2 h left');
        expect(durationText({ remaining: null, until: { day: 4, minutes: 1080 } })).toBe('until day 4 18:00');
        expect(durationText({ remaining: null, until: { day: 4 } })).toBe('until day 4');
        expect(durationText({ remaining: null })).toBe('');
        expect(minutesText(45)).toBe('45 min');
        expect(minutesText(180)).toBe('3 h');
        expect(minutesText(4 * 1440)).toBe('4 days');
        expect(minutesText(3 * 10080)).toBe('3 weeks');
        expect(storyMinutes({ day: 2, minutes: 30 })).toBe(2910);
        expect(storyMinutes({ day: 1 })).toBe(1440);
    });
});

describe('durations from words', () => {
    it('reads turns, minutes, hours, days, weeks and months in Russian and English', () => {
        expect(parseDurationText('3 хода')).toEqual({ turns: 3 });
        expect(parseDurationText('2 раунда')).toEqual({ turns: 2 });
        expect(parseDurationText('3 turns')).toEqual({ turns: 3 });
        expect(parseDurationText('2 hours')).toEqual({ minutes: 120 });
        expect(parseDurationText('2h')).toEqual({ minutes: 120 });
        expect(parseDurationText('1d')).toEqual({ minutes: 1440 });
        expect(parseDurationText('2 недели')).toEqual({ minutes: 20160 });
        expect(parseDurationText('a week')).toEqual({ minutes: 10080 });
        expect(parseDurationText('три дня')).toEqual({ minutes: 4320 });
        expect(parseDurationText('1 день 6 часов')).toEqual({ minutes: 1800 });
        expect(parseDurationText('полчаса')).toEqual({ minutes: 30 });
        expect(parseDurationText('half an hour')).toEqual({ minutes: 30 });
        expect(parseDurationText('1,5 часа')).toEqual({ minutes: 90 });
        expect(parseDurationText('2 месяца')).toEqual({ minutes: 86400 });
        expect(parseDurationText('5')).toEqual({ turns: 5 });
    });

    it('leaves phrases for the calendar', () => {
        expect(parseDurationText('до заката')).toBeNull();
        expect(parseDurationText('until sunset')).toBeNull();
        expect(parseDurationText('')).toBeNull();
        expect(parseDurationText(undefined as unknown as string)).toBeNull();
        expect(parseDurationText('0 turns')).toBeNull();
    });
});

describe('modifiers', () => {
    it('sum statuses (times stacks) and equipped items for the wanted keys', () => {
        const statuses = [
            poisoned({ modifiers: { checks: -2, stealth: -1 }, stacks: 2 }),
            poisoned({ id: 'b', name: 'Blessed', modifiers: { 'check:stealth': 3 } }),
        ];
        const items: ItemState[] = [
            { id: 'i1', name: 'Cloak', qty: 1, equipped: 'worn', modifiers: { stealth: 2 } },
            { id: 'i2', name: 'Boots', qty: 1, modifiers: { stealth: 5 } },
            { id: 'i3', name: 'Ring', qty: 1, equipped: 'hand' },
        ];
        expect(modifierSum(statuses, items, ['stealth', 'skills.stealth'])).toEqual({
            total: 0,
            parts: [
                { from: 'status', name: 'Отравлен', amount: -2 },
                { from: 'item', name: 'Cloak', amount: 2 },
            ],
        });
        expect(modifierSum(statuses, items, ['check:stealth', 'checks']).total).toBe(-1);
        expect(modifierSum([], [], ['x'])).toEqual({ total: 0, parts: [] });
    });
});

describe('items', () => {
    let next = 0;
    const newId = () => `i${++next}`;

    it('are given, merged by name and described', () => {
        const rope = giveItem([], { name: ' Rope ', desc: 'hemp', tags: ['tool'], value: 2 }, newId, 2);
        expect(rope).toMatchObject({
            before: null,
            after: { name: 'Rope', qty: 2, desc: 'hemp', tags: ['tool'], value: 2 },
        });
        const more = giveItem([rope!.after], { name: 'rope', qty: 3, tags: ['tool', 'long'], equipped: 'hand' }, newId);
        expect(more?.after).toMatchObject({ id: rope!.after.id, qty: 5, tags: ['tool', 'long'], equipped: 'hand' });
        expect(giveItem([], { name: 'x' }, newId, 0)).toBeNull();
        expect(giveItem([], { name: ' ' }, newId)).toBeNull();
        expect(giveItem([], { name: 'sword', modifiers: { attack: 1 } }, newId)?.after.modifiers).toEqual({
            attack: 1,
        });
        expect(findItem([rope!.after], 'ROPE')).toBe(rope!.after);
        expect(findItem([rope!.after], rope!.after.id)).toBe(rope!.after);
        expect(findItem([rope!.after], '')).toBeNull();
    });

    it('are taken (all of them without a quantity) and equipped', () => {
        const coins: ItemState = { id: 'c', name: 'Coin', qty: 10 };
        expect(takeItem([coins], 'coin', 4)).toMatchObject({ after: { qty: 6 }, taken: 4 });
        expect(takeItem([coins], 'coin', 40)).toMatchObject({ after: null, taken: 10 });
        expect(takeItem([coins], 'coin')).toMatchObject({ after: null, taken: 10 });
        expect(takeItem([coins], 'gem', 1)).toBeNull();
        const sword: ItemState = { id: 's', name: 'Sword', qty: 1 };
        expect(equipItem([sword], 'sword', 'hand')?.after.equipped).toBe('hand');
        expect(equipItem([{ ...sword, equipped: 'hand' }], 'sword', null)?.after).not.toHaveProperty('equipped');
        expect(equipItem([sword], 'sword', null)).toBeNull();
        expect(equipItem([sword], 'axe', 'hand')).toBeNull();
    });

    it('read for the model', () => {
        const list: ItemState[] = [
            { id: '1', name: 'rope', qty: 2 },
            { id: '2', name: 'sword', qty: 1, equipped: 'hand' },
            { id: '3', name: 'cloak', qty: 1, equipped: 'worn' },
        ];
        expect(itemsText(list)).toBe('rope x2, sword (in hand), cloak (worn)');
        expect(itemsText(list, 1)).toBe('rope x2, +2 more');
        expect(itemsText([])).toBe('');
    });
});

describe('stored data', () => {
    it('repairs statuses', () => {
        expect(readStatus(null)).toBeNull();
        expect(readStatus({ id: 'x' })).toBeNull();
        expect(
            readStatus({
                id: 'x',
                name: 'Stunned',
                remaining: { turns: 2, minutes: 'a' },
                until: { day: 3, minutes: 60 },
                modifiers: { checks: -5, bad: 'x' },
                stacks: 2.4,
                maxStacks: 0,
                source: 'block',
                since: 3.7,
                at: 5,
                mechanicId: 'combat',
                text: 't',
                icon: 'i',
            }),
        ).toEqual({
            id: 'x',
            statusId: 'stunned',
            name: 'Stunned',
            promptName: 'Stunned',
            remaining: { turns: 2 },
            until: { day: 3, minutes: 60 },
            modifiers: { checks: -5 },
            stacks: 2,
            maxStacks: 1,
            source: 'block',
            since: 3,
            at: 5,
            mechanicId: 'combat',
            text: 't',
            icon: 'i',
        });
        expect(readStatus({ id: 'y', name: 'A', remaining: {}, statusId: 'a', promptName: 'aa' })).toMatchObject({
            remaining: null,
            source: 'user',
            since: -1,
            statusId: 'a',
            promptName: 'aa',
        });
    });

    it('repairs items', () => {
        expect(readItem({ id: 'x', name: ' ' })).toBeNull();
        expect(readItem('x')).toBeNull();
        expect(
            readItem({
                id: 'x',
                name: 'Rope',
                qty: 'a',
                desc: 'd',
                equipped: 'belt',
                tags: ['a', 'a'],
                value: 2,
                modifiers: { a: 1 },
            }),
        ).toEqual({ id: 'x', name: 'Rope', qty: 1, desc: 'd', tags: ['a'], value: 2, modifiers: { a: 1 } });
        expect(readItem({ id: 'x', name: 'Sword', qty: 1, equipped: 'hand' })?.equipped).toBe('hand');
    });
});
