// M25 state engine (plan-2 §6): operations beyond values — statuses, items, revealing, the fight, the clock; event
// actions and chains with the loop guard; levels from experience; derived values and modifiers; rollback and undo of
// every kind (exact and as a difference); resets; stored data; one committed turn (clock, statuses, time rules,
// rounds).
import { describe, expect, it } from 'vitest';
import type { MechanicDef } from '../../src/domain/mechanics-defs';
import { startCombat } from '../../src/domain/mechanics-combat';
import {
    applyOps,
    attributeModifierIds,
    checkModifierIds,
    DEPTH_LIMIT,
    emptyStateDoc,
    findChange,
    isRevealed,
    itemsOf,
    nextValue,
    normalizeStateDoc,
    OPS_LIMIT,
    previewChange,
    publicChange,
    recordKey,
    resetOps,
    revealKey,
    revertChange,
    rollbackFrom,
    rollbackMessage,
    rollbackWhere,
    statusesOf,
    valueReader,
} from '../../src/domain/mechanics-state';
import type { ApplyOptions, MechanicsStateDoc, OpInput } from '../../src/domain/mechanics-state';
import { isResting, turnOps } from '../../src/domain/mechanics-turn';

const MAGIC: MechanicDef = {
    id: 'magic',
    name: 'Magic',
    summary: '',
    rules: '',
    attributes: [
        {
            id: 'mana',
            name: 'Mana',
            promptName: 'Mana',
            kind: 'number',
            min: 0,
            max: 100,
            initial: 50,
            events: [
                {
                    id: 'drained',
                    when: { op: '<=', value: 0 },
                    text: '{holder} is drained.',
                    actions: [{ who: 'actor', attr: 'status', op: 'push', value: 'drained' }],
                    chain: 'faint',
                },
                {
                    id: 'faint',
                    when: { op: '=', value: -1 },
                    text: '{holder} faints.',
                    actions: [{ who: 'actor', attr: 'hp', op: 'sub', value: 5 }],
                },
            ],
        },
        { id: 'hp', name: 'HP', promptName: 'HP', kind: 'number', min: 0, max: 30, initial: 30 },
        { id: 'xp', name: 'XP', promptName: 'XP', kind: 'number', min: 0, initial: 0 },
        { id: 'level', name: 'Level', promptName: 'Level', kind: 'number', min: 1, initial: 1 },
        { id: 'max_mana', name: 'Max mana', promptName: 'Max mana', kind: 'number', formula: '50 + 10 * @level' },
        { id: 'loop_a', name: 'A', promptName: 'A', kind: 'number', formula: '@loop_b + 1' },
        { id: 'loop_b', name: 'B', promptName: 'B', kind: 'number', formula: '@loop_a + 1' },
        { id: 'rank', name: 'Rank', promptName: 'Rank', kind: 'scale', levels: ['novice', 'adept'] },
        { id: 'secret', name: 'Secret', promptName: 'Secret', kind: 'number', visibility: { preset: 'hidden' } },
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [],
    tracking: 'block',
    scope: { kind: 'global' },
    statuses: [{ id: 'drained', name: 'Опустошён', promptName: 'drained', modifiers: { checks: -2 } }],
    inventory: { money: 'coins' },
    progression: {
        xp: 'xp',
        level: 'level',
        thresholds: [100, 300],
        onLevelUp: [{ who: 'actor', attr: 'hp', op: 'add', value: 5 }],
    },
    time: [
        { attr: 'mana', amount: 10, per: 'hour', when: 'rest' },
        { attr: 'hp', amount: '@level', per: 'turn' },
        { attr: 'xp', amount: 0, per: 'day' },
    ],
};

/** A loop: each event changes the other attribute back and forth. */
const LOOP: MechanicDef = {
    ...MAGIC,
    id: 'loop',
    attributes: [
        {
            id: 'a',
            name: 'A',
            promptName: 'A',
            kind: 'number',
            events: [
                {
                    id: 'a',
                    when: { op: 'changed' },
                    text: '',
                    once: false,
                    actions: [{ who: 'actor', attr: 'b', op: 'add', value: 1 }],
                },
            ],
        },
        {
            id: 'b',
            name: 'B',
            promptName: 'B',
            kind: 'number',
            events: [
                {
                    id: 'b',
                    when: { op: 'changed' },
                    text: '',
                    once: false,
                    actions: [{ who: 'actor', attr: 'a', op: 'add', value: 1 }],
                },
            ],
        },
    ],
    progression: undefined,
};

let seq = 0;
function options(extra: Partial<ApplyOptions> = {}): ApplyOptions {
    return {
        getDef: (id) => [MAGIC, LOOP].find((def) => def.id === id) ?? null,
        now: 1000,
        newId: () => `id${++seq}`,
        holders: { persona: 'Алекс' },
        catalogue: [],
        rng: () => 0.5,
        ...extra,
    };
}

const at = { source: 'block' as const, messageIndex: 3 };

function apply(doc: MechanicsStateDoc, ...ops: OpInput[]) {
    return applyOps(doc, ops, options());
}

describe('event actions, chains and levels', () => {
    it('an event applies its actions and its chained event in the same application', () => {
        const doc = emptyStateDoc();
        const result = apply(doc, { ...at, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 0 });
        expect(result.fired.map((event) => event.text)).toEqual(['Kai is drained.', 'Kai faints.']);
        expect(statusesOf(doc, 'kai').map((status) => [status.name, status.modifiers])).toEqual([
            ['Опустошён', { checks: -2 }],
        ]);
        expect(doc.holders.magic?.Kai?.values.hp).toBe(25);
        expect(result.applied.map((change) => [change.kind ?? 'value', change.source])).toEqual([
            ['value', 'block'],
            ['value', 'event'],
            ['status', 'event'],
        ]);
        // All of it goes with the message.
        rollbackFrom(doc, 3, options().getDef);
        expect(doc.log).toEqual([]);
        expect(doc.statuses).toEqual({});
        expect(doc.fired).toEqual([]);
    });

    it('the loop guard stops events that keep firing each other', () => {
        const doc = emptyStateDoc();
        const result = apply(doc, { ...at, mechanicId: 'loop', holder: 'Kai', attribute: 'a', value: 1 });
        expect(result.applied.length).toBeLessThanOrEqual(DEPTH_LIMIT + 2);
        expect(result.applied.length).toBeGreaterThan(1);
        const many = Array.from({ length: OPS_LIMIT + 5 }, (_, i) => ({
            ...at,
            mechanicId: 'magic',
            holder: `H${i}`,
            attribute: 'hp',
            value: 1,
        }));
        expect(
            applyOps(emptyStateDoc(), many, options()).rejected.filter((item) => item.reason === 'limit'),
        ).toHaveLength(5);
    });

    it('experience raises the level and runs onLevelUp once per level', () => {
        const doc = emptyStateDoc();
        apply(doc, { ...at, mechanicId: 'magic', holder: 'Kai', attribute: 'hp', value: 10 });
        const result = apply(doc, { ...at, mechanicId: 'magic', holder: 'Kai', attribute: 'xp', value: 350 });
        expect(doc.holders.magic?.Kai?.values).toMatchObject({ xp: 350, level: 3, hp: 20 });
        expect(result.applied.map((change) => change.attribute)).toEqual(['xp', 'level', 'hp', 'hp']);
        expect(
            apply(doc, { ...at, mechanicId: 'magic', holder: 'Kai', attribute: 'xp', value: 360 }).applied,
        ).toHaveLength(1);
    });

    it('derived attributes cannot be changed', () => {
        const result = apply(emptyStateDoc(), {
            ...at,
            mechanicId: 'magic',
            holder: 'Kai',
            attribute: 'max_mana',
            value: 1,
        });
        expect(result.rejected[0]?.reason).toBe('derived');
    });
});

describe('values: derived and with modifiers', () => {
    it('computes formulas, guards circles, adds status and item modifiers', () => {
        const doc = emptyStateDoc();
        apply(
            doc,
            { ...at, mechanicId: 'magic', holder: 'Kai', attribute: 'level', value: 2 },
            {
                ...at,
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'Focus', modifiers: { mana: 5, 'magic.max_mana': 1 }, stacks: 1, maxStacks: 2 },
            },
            {
                ...at,
                kind: 'item',
                op: 'give',
                mechanicId: 'magic',
                holder: 'Kai',
                item: { name: 'Staff', equipped: 'hand', modifiers: { mana: 3 } },
            },
        );
        const reader = valueReader(doc, options().getDef);
        expect(reader.raw('magic', 'Kai', 'max_mana')).toBe(70);
        expect(reader.breakdown('magic', 'Kai', 'max_mana')).toMatchObject({ base: 70, value: 71 });
        expect(reader.breakdown('magic', 'Kai', 'mana')).toEqual({
            base: 50,
            value: 58,
            parts: [
                { from: 'status', name: 'Focus', amount: 5 },
                { from: 'item', name: 'Staff', amount: 3 },
            ],
        });
        expect(reader.number('magic', 'Kai', 'rank')).toBe(0);
        // A circle (refused by validation) does not hang: the inner reference counts as 0.
        expect(reader.number('magic', 'Kai', 'loop_a')).toBe(2);
        expect(reader.raw('magic', 'Kai', 'nope')).toBeNull();
        expect(reader.breakdown('nope', 'Kai', 'mana')).toBeNull();
        expect(reader.number('magic', 'Mira', 'mana')).toBe(50);
        expect(attributeModifierIds('magic', 'mana')).toEqual(['mana', 'magic.mana']);
        expect(checkModifierIds(MAGIC, 'mana')).toEqual(['check:mana', 'check:magic.mana', 'checks']);
        expect(checkModifierIds(MAGIC, 'cast')).toEqual([
            'check:cast',
            'check:magic.cast',
            'checks',
            'cast',
            'magic.cast',
        ]);
        const broken = { ...MAGIC, attributes: [{ ...MAGIC.attributes[4]!, formula: 'pow(' }] };
        expect(valueReader(doc, () => broken).raw('magic', 'Kai', 'max_mana')).toBe(0);
    });

    it('factors and list pushes and pulls', () => {
        const schools = {
            ...MAGIC,
            attributes: [
                {
                    id: 'schools',
                    name: 'S',
                    promptName: 'S',
                    kind: 'list' as const,
                    options: ['fire', 'air'],
                    multi: true,
                },
                { id: 'one', name: 'O', promptName: 'O', kind: 'list' as const, options: ['fire', 'air'] },
                ...MAGIC.attributes,
            ],
        };
        const attr = schools.attributes[0]!;
        expect(nextValue(attr, ['fire'], 'air', false, 'push')).toMatchObject({ ok: true, value: ['fire', 'air'] });
        expect(nextValue(attr, ['fire', 'air'], 'FIRE', false, 'pull')).toEqual({
            ok: true,
            value: ['air'],
            clamped: false,
        });
        expect(nextValue(schools.attributes[1]!, ['fire'], 'air', false, 'push')).toMatchObject({ value: ['air'] });
        expect(nextValue(attr, null, 2, false, 'mul')).toEqual({ ok: false, reason: 'op' });
        expect(nextValue(MAGIC.attributes[0]!, 40, 1.5, false, 'mul')).toEqual({ ok: true, value: 60, clamped: false });
        expect(nextValue(MAGIC.attributes[0]!, 40, 'x', false, 'mul').ok).toBe(false);
        expect(nextValue(MAGIC.attributes[0]!, 40, 'air', false, 'push').ok).toBe(false);
        expect(
            previewChange(MAGIC.attributes[0]!, 40, {
                mechanicId: 'magic',
                holder: 'Kai',
                attribute: 'mana',
                value: 2,
                op: 'mul',
            }),
        ).toBe(80);
    });
});

describe('statuses', () => {
    it('apply from the catalogue, refresh without a change, end with an event when they expire', () => {
        const doc = emptyStateDoc();
        const added = apply(doc, {
            ...at,
            kind: 'status',
            op: 'add',
            mechanicId: 'magic',
            holder: 'Kai',
            status: { name: 'drained', duration: { turns: 2 } },
        });
        expect(added.applied[0]).toMatchObject({ kind: 'status', from: null, to: 'Опустошён', attribute: 'status' });
        expect(statusesOf(doc, 'Kai')[0]).toMatchObject({
            modifiers: { checks: -2 },
            remaining: { turns: 2 },
            since: 3,
        });
        const again = apply(doc, {
            ...at,
            kind: 'status',
            op: 'add',
            mechanicId: 'magic',
            holder: 'Kai',
            status: { name: 'drained', duration: { turns: 2 } },
        });
        expect(again.unchanged).toHaveLength(1);
        const instance = statusesOf(doc, 'Kai')[0]!;
        const ticked = apply(doc, {
            ...at,
            messageIndex: 4,
            kind: 'status',
            op: 'update',
            mechanicId: 'magic',
            holder: 'Kai',
            instance: { ...instance, remaining: { turns: 1 } },
        });
        expect(ticked.applied[0]).toMatchObject({ from: 2, to: 1 });
        const expired = apply(doc, {
            ...at,
            messageIndex: 5,
            kind: 'status',
            op: 'remove',
            mechanicId: 'magic',
            holder: 'kai',
            ref: instance.id,
            expired: true,
        });
        expect(expired.fired[0]).toMatchObject({
            attribute: 'status',
            eventId: 'expired_drained',
            text: 'Kai is no longer drained.',
        });
        expect(doc.statuses).toEqual({});
        expect(
            apply(doc, { ...at, kind: 'status', op: 'remove', mechanicId: 'magic', holder: 'Kai', ref: 'drained' })
                .unchanged,
        ).toHaveLength(1);
        expect(
            apply(doc, { ...at, kind: 'status', op: 'update', mechanicId: 'magic', holder: 'Kai', instance })
                .rejected[0]?.reason,
        ).toBe('status');
        // Back to the start, newest first: the removal, the tick, the addition.
        rollbackFrom(doc, 0, options().getDef);
        expect(doc.statuses).toEqual({});
        expect(
            apply(doc, { ...at, kind: 'status', op: 'add', mechanicId: 'nope', holder: ' ', status: { name: 'x' } })
                .rejected[0]?.reason,
        ).toBe('holder');
    });

    it('undo of one status change in the middle reverts it as a difference', () => {
        const doc = emptyStateDoc();
        apply(doc, {
            ...at,
            kind: 'status',
            op: 'add',
            mechanicId: 'magic',
            holder: 'Kai',
            status: { name: 'drained', duration: { turns: 3 } },
        });
        const instance = statusesOf(doc, 'Kai')[0]!;
        apply(doc, {
            ...at,
            kind: 'status',
            op: 'update',
            mechanicId: 'magic',
            holder: 'Kai',
            instance: { ...instance, remaining: { turns: 2 } },
        });
        apply(doc, {
            ...at,
            kind: 'status',
            op: 'update',
            mechanicId: 'magic',
            holder: 'Kai',
            instance: { ...instance, remaining: { turns: 1 } },
        });
        const middle = doc.log[1]!;
        expect(revertChange(doc, middle, options().getDef)).toBe(true);
        expect(statusesOf(doc, 'Kai')[0]?.remaining).toEqual({ turns: 2 });
        const first = doc.log[0]!;
        expect(revertChange(doc, first, options().getDef)).toBe(true);
        expect(statusesOf(doc, 'Kai')).toEqual([]);
    });
});

describe('items', () => {
    it('give, take, equip; quantities revert as differences', () => {
        const doc = emptyStateDoc();
        apply(doc, {
            ...at,
            kind: 'item',
            op: 'give',
            mechanicId: 'magic',
            holder: 'Kai',
            item: { name: 'Coin' },
            qty: 10,
        });
        apply(doc, {
            ...at,
            messageIndex: 4,
            kind: 'item',
            op: 'take',
            mechanicId: 'magic',
            holder: 'kai',
            item: { name: 'coin' },
            qty: 3,
        });
        apply(doc, {
            ...at,
            messageIndex: 5,
            kind: 'item',
            op: 'give',
            mechanicId: 'magic',
            holder: 'Kai',
            item: { name: 'coin' },
            qty: 1,
        });
        expect(itemsOf(doc, 'Kai')[0]?.qty).toBe(8);
        expect(doc.log.map((change) => [change.from, change.to])).toEqual([
            [0, 10],
            [10, 7],
            [7, 8],
        ]);
        expect(publicChange(doc.log[1]!).item).toMatchObject({ name: 'Coin', qty: 7 });
        expect(revertChange(doc, doc.log[1]!, options().getDef)).toBe(true);
        expect(itemsOf(doc, 'Kai')[0]?.qty).toBe(11);
        const equip = apply(doc, {
            ...at,
            kind: 'item',
            op: 'equip',
            mechanicId: 'magic',
            holder: 'Kai',
            item: { name: 'coin' },
            slot: 'hand',
        });
        expect(equip.applied[0]).toMatchObject({ from: '', to: 'hand' });
        expect(
            apply(doc, {
                ...at,
                kind: 'item',
                op: 'equip',
                mechanicId: 'magic',
                holder: 'Kai',
                item: { name: 'coin' },
                slot: 'hand',
            }).unchanged,
        ).toHaveLength(1);
        expect(
            apply(doc, { ...at, kind: 'item', op: 'take', mechanicId: 'magic', holder: 'Kai', item: { name: 'gem' } })
                .rejected[0]?.reason,
        ).toBe('item');
        expect(
            apply(doc, { ...at, kind: 'item', op: 'give', mechanicId: 'magic', holder: 'Kai', item: { name: ' ' } })
                .rejected[0]?.reason,
        ).toBe('item');
        rollbackFrom(doc, 0, options().getDef);
        expect(doc.items).toEqual({});
    });

    it('a taken-away item comes back when its removal is undone in the middle', () => {
        const doc = emptyStateDoc();
        apply(doc, {
            ...at,
            kind: 'item',
            op: 'give',
            mechanicId: 'magic',
            holder: 'Kai',
            item: { name: 'Rope' },
            qty: 2,
        });
        apply(doc, { ...at, kind: 'item', op: 'take', mechanicId: 'magic', holder: 'Kai', item: { name: 'rope' } });
        apply(doc, {
            ...at,
            kind: 'item',
            op: 'give',
            mechanicId: 'magic',
            holder: 'Kai',
            item: { name: 'rope' },
            qty: 1,
        });
        expect(revertChange(doc, doc.log[1]!, options().getDef)).toBe(true);
        expect(itemsOf(doc, 'Kai')[0]?.qty).toBe(3);
        expect(recordKey(doc.items, 'KAI')).toBe('Kai');
        expect(recordKey({}, ' Mira ')).toBe('Mira');
    });
});

describe('revealing and the fight', () => {
    it('reveals per holder or for everyone, and takes it back', () => {
        const doc = emptyStateDoc();
        const shown = apply(doc, { ...at, kind: 'reveal', mechanicId: 'magic', holder: 'Kai', attribute: 'Secret' });
        expect(shown.applied[0]).toMatchObject({ kind: 'reveal', from: 'hidden', to: 'shown' });
        expect(isRevealed(doc, 'magic', 'kai', 'secret')).toBe(true);
        expect(
            apply(doc, { ...at, kind: 'reveal', mechanicId: 'magic', holder: 'Kai', attribute: 'secret' }).unchanged,
        ).toHaveLength(1);
        apply(doc, { ...at, kind: 'reveal', mechanicId: 'magic', holder: '*', attribute: 'secret' });
        expect(isRevealed(doc, 'magic', 'Mira', 'secret')).toBe(true);
        apply(doc, { ...at, kind: 'reveal', mechanicId: 'magic', holder: 'Kai', attribute: 'secret', hide: true });
        expect(doc.revealed[revealKey('magic', 'Kai', 'secret')]).toBeUndefined();
        expect(
            apply(doc, { ...at, kind: 'reveal', mechanicId: 'magic', holder: 'Kai', attribute: 'luck' }).rejected[0]
                ?.reason,
        ).toBe('attribute');
        expect(
            apply(doc, { ...at, kind: 'reveal', mechanicId: 'nope', holder: 'Kai', attribute: 'x' }).rejected[0]
                ?.reason,
        ).toBe('mechanic');
        rollbackWhere(doc, () => true, options().getDef);
        expect(doc.revealed).toEqual({});
    });

    it('starts, takes combatants out (the fight ends when the enemies are), joins; rolls back exactly', () => {
        const doc = emptyStateDoc();
        expect(
            apply(doc, { ...at, kind: 'combat', op: 'out', mechanicId: 'magic', holder: 'Kai' }).rejected[0]?.reason,
        ).toBe('combat');
        const next = startCombat(
            [
                { holder: 'Kai', init: 10 },
                { holder: 'Bandit', init: 5, enemy: true },
            ],
            { mechanicId: 'magic', at: 3, by: 'user' },
        );
        apply(doc, { ...at, kind: 'combat', op: 'set', mechanicId: 'magic', next });
        expect(apply(doc, { ...at, kind: 'combat', op: 'set', mechanicId: 'magic', next }).unchanged).toHaveLength(1);
        apply(doc, { ...at, kind: 'combat', op: 'join', mechanicId: 'magic', holder: 'Wolf', init: 7, enemy: true });
        expect(doc.combat?.order.map((item) => item.holder)).toEqual(['Kai', 'Wolf', 'Bandit']);
        apply(doc, { ...at, kind: 'combat', op: 'out', mechanicId: 'magic', holder: 'Wolf' });
        const end = apply(doc, {
            ...at,
            messageIndex: 4,
            kind: 'combat',
            op: 'out',
            mechanicId: 'magic',
            holder: 'Bandit',
        });
        expect(doc.combat).toMatchObject({ active: false, endedAt: 4 });
        expect(end.fired[0]).toMatchObject({
            eventId: 'combat_ended',
            text: 'The fight is over: every enemy is down.',
        });
        expect(end.applied[0]).toMatchObject({ kind: 'combat', from: 'round 1', to: 'off' });
        // Only the newest fight change undoes alone.
        expect(revertChange(doc, doc.log[1]!, options().getDef)).toBe(false);
        rollbackMessage(doc, 4, ['block'], options().getDef);
        expect(doc.combat?.active).toBe(true);
        rollbackFrom(doc, 0, options().getDef);
        expect(doc.combat).toBeNull();
        const ended = apply(
            doc,
            { ...at, kind: 'combat', op: 'set', mechanicId: 'magic', next },
            { ...at, kind: 'combat', op: 'set', mechanicId: 'magic', next: null },
        );
        expect(ended.fired[0]?.text).toBe('The fight is over.');
    });
});

describe('the clock and the turn', () => {
    const def = (extra: Partial<MechanicDef> = {}) => ({ ...MAGIC, ...extra });

    it('a turn moves the clock, ticks statuses (not new ones), regenerates while resting, rounds a fight', () => {
        const doc = emptyStateDoc();
        apply(doc, { ...at, messageIndex: 1, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 10 });
        apply(doc, {
            ...at,
            messageIndex: 1,
            kind: 'status',
            op: 'add',
            mechanicId: 'magic',
            holder: 'Kai',
            status: { name: 'Resting', duration: { turns: 1 } },
        });
        apply(doc, {
            ...at,
            messageIndex: 5,
            kind: 'status',
            op: 'add',
            mechanicId: 'magic',
            holder: 'Kai',
            status: { name: 'Fresh', duration: { turns: 1 } },
        });
        apply(doc, {
            ...at,
            messageIndex: 2,
            kind: 'status',
            op: 'add',
            mechanicId: 'magic',
            holder: 'Kai',
            status: { name: 'Hex', duration: { turns: 3 } },
        });
        const fight = startCombat([{ holder: 'Kai', init: 3 }], { mechanicId: 'magic', at: 2, by: 'user' });
        apply(doc, { ...at, messageIndex: 2, kind: 'combat', op: 'set', mechanicId: 'magic', next: fight });
        doc.clock = { day: 1, minutes: 600, label: 'Day 1' };
        const turn = turnOps(
            doc,
            { index: 5, clock: { day: 1, minutes: 760, label: 'Day 1' }, defs: [def()], holdersOf: () => ['Kai'] },
            options().getDef,
        );
        expect(turn.step).toEqual({ turns: 1, minutes: 160, hours: 2, days: 0 });
        const result = applyOps(doc, turn.ops, options());
        expect(doc.clock).toEqual({ day: 1, minutes: 760, label: 'Day 1' });
        expect(doc.lastTurn).toBe(5);
        expect(statusesOf(doc, 'Kai').map((status) => [status.name, status.remaining])).toEqual([
            ['Fresh', { turns: 1 }],
            ['Hex', { turns: 2 }],
        ]);
        expect(result.fired.map((event) => event.text)).toEqual(['Kai is no longer Resting.']);
        // Resting (the status was there when the turn began): +10 mana per hour × 2; +level hp per turn (hp at max).
        expect(doc.holders.magic?.Kai?.values.mana).toBe(30);
        expect(doc.combat?.round).toBe(2);
        expect(doc.clockHistory).toEqual([{ index: 5, clock: { day: 1, minutes: 760, label: 'Day 1' } }]);
        // A rollback forgets the clock.
        rollbackFrom(doc, 5, options().getDef);
        expect(doc.clock).toBeNull();
        expect(doc.lastTurn).toBe(4);
        expect(doc.combat?.round).toBe(1);
    });

    it('a turn without a clock keeps the old one; a fight started in this reply does not round', () => {
        const doc = emptyStateDoc();
        doc.clock = { day: 2, label: 'Day 2' };
        doc.combat = startCombat([{ holder: 'Kai', init: 1 }], { mechanicId: 'magic', at: 6, by: 'model' });
        const turn = turnOps(
            doc,
            {
                index: 6,
                clock: null,
                defs: [def({ time: [{ attr: 'mana', amount: '1d4', per: 'turn' }] })],
                holdersOf: () => ['Kai'],
                rng: () => 0,
            },
            options().getDef,
        );
        expect(turn.ops.filter((op) => op.kind === 'combat')).toEqual([]);
        applyOps(doc, turn.ops, options());
        expect(doc.clock).toEqual({ day: 2, label: 'Day 2' });
        expect(doc.lastTurn).toBe(6);
        expect(doc.holders.magic?.Kai?.values.mana).toBe(51);
        rollbackMessage(doc, 6, undefined, options().getDef);
        expect(doc.lastTurn).toBe(5);
    });

    it('rest: a rest status, a long pause or a time-skip scene', () => {
        const step = { turns: 1, minutes: 30, hours: 0, days: 0 };
        expect(isResting([], step)).toBe(false);
        expect(isResting([], { ...step, minutes: 400 })).toBe(true);
        expect(isResting([], step, true)).toBe(true);
        const sleeping = applyOps(
            emptyStateDoc(),
            [{ ...at, kind: 'status', op: 'add', mechanicId: 'magic', holder: 'Kai', status: { name: 'Спит' } }],
            options(),
        ).applied[0]!.status!;
        expect(isResting([sleeping], step)).toBe(true);
    });
});

describe('reset', () => {
    it('brings values, statuses, items and the fight back to the start as one batch', () => {
        const doc = emptyStateDoc();
        apply(
            doc,
            { ...at, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 5 },
            { ...at, mechanicId: 'magic', holder: 'Mira', attribute: 'hp', value: 3 },
            { ...at, kind: 'status', op: 'add', mechanicId: 'magic', holder: 'Kai', status: { name: 'Hex' } },
            { ...at, kind: 'status', op: 'add', mechanicId: 'other', holder: 'Kai', status: { name: 'Cold' } },
            { ...at, kind: 'item', op: 'give', mechanicId: 'magic', holder: 'Kai', item: { name: 'Rope' } },
            {
                ...at,
                kind: 'combat',
                op: 'set',
                mechanicId: 'magic',
                next: startCombat([{ holder: 'Kai', init: 1 }], { mechanicId: 'magic', at: 3, by: 'user' }),
            },
        );
        const base = { source: 'user' as const, messageIndex: -1, batch: 'b1' };
        const forKai = resetOps(doc, options().getDef, { holder: 'kai' }, base);
        expect(forKai.map((op) => op.kind ?? 'value')).toEqual(['value', 'status', 'status', 'item']);
        const forMagic = resetOps(doc, options().getDef, { mechanicId: 'magic' }, base);
        expect(forMagic.map((op) => op.kind ?? 'value')).toEqual(['value', 'value', 'status', 'item', 'combat']);
        applyOps(doc, forMagic, options());
        expect(doc.holders.magic?.Kai?.values.mana).toBe(50);
        expect(statusesOf(doc, 'Kai').map((status) => status.name)).toEqual(['Cold']);
        expect(doc.items).toEqual({});
        expect(doc.combat).toBeNull();
        expect(resetOps(doc, options().getDef, { mechanicId: 'nope' }, base)).toEqual([]);
        rollbackWhere(doc, (change) => change.batch === 'b1', options().getDef);
        expect(doc.holders.magic?.Kai?.values.mana).toBe(5);
        expect(itemsOf(doc, 'Kai')).toHaveLength(1);
        expect(doc.combat?.active).toBe(true);
        expect(
            resetOps(doc, () => ({ ...MAGIC, inventory: undefined }), { mechanicId: 'magic' }, base).some(
                (op) => op.kind === 'item',
            ),
        ).toBe(false);
    });
});

describe('stored data', () => {
    it('keeps the new parts and repairs them', () => {
        const doc = emptyStateDoc();
        apply(
            doc,
            {
                ...at,
                rollId: 'r1',
                batch: 'b',
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'Hex' },
            },
            { ...at, kind: 'item', op: 'give', mechanicId: 'magic', holder: 'Kai', item: { name: 'Rope' } },
            { ...at, kind: 'reveal', mechanicId: 'magic', holder: 'Kai', attribute: 'secret' },
            {
                ...at,
                kind: 'combat',
                op: 'set',
                mechanicId: 'magic',
                next: startCombat([{ holder: 'Kai', init: 1 }], { mechanicId: 'magic', at: 3, by: 'user' }),
            },
            {
                ...at,
                kind: 'clock',
                index: 3,
                clock: {
                    day: 1,
                    minutes: 30,
                    label: 'Day 1',
                    time: '00:30',
                    weekday: 2,
                    anchor: { kind: 'day', n: 1, key: '', day: 1, abs: 5 },
                },
            },
        );
        const copy = normalizeStateDoc(JSON.parse(JSON.stringify(doc)));
        expect(copy).toEqual(doc);
        expect(findChange(copy, { changeId: doc.log[0]!.id })).toMatchObject({
            rollId: 'r1',
            batch: 'b',
            kind: 'status',
        });
        expect(publicChange(copy.log[0]!)).toMatchObject({
            rollId: 'r1',
            batch: 'b',
            kind: 'status',
            status: { name: 'Hex' },
        });
        const broken = normalizeStateDoc({
            log: [
                {
                    id: 'x',
                    mechanicId: 'm',
                    holder: 'h',
                    attribute: 'status',
                    to: '',
                    source: 'block',
                    kind: 'status',
                    statusBefore: null,
                    statusAfter: 'x',
                },
            ],
            statuses: { Kai: [{ id: 'a' }, 'x'], Mira: 'x' },
            items: { Kai: [{ id: 'i', name: 'Rope', qty: 1 }] },
            revealed: { a: true, b: 1 },
            clock: { day: 'x' },
            clockHistory: [{ index: 2, clock: { day: 1 } }, { index: 3, clock: null }, 4],
            combat: 'x',
            lastTurn: 7.9,
        });
        expect(broken.log[0]).toMatchObject({ kind: 'status', statusBefore: null, statusAfter: null });
        expect(broken.statuses).toEqual({});
        expect(broken.items.Kai).toHaveLength(1);
        expect(broken.revealed).toEqual({ a: true });
        expect(broken.clock).toBeNull();
        expect(broken.clockHistory).toEqual([{ index: 2, clock: { day: 1, label: '' } }]);
        expect(broken.combat).toBeNull();
        expect(broken.lastTurn).toBe(7);
        const kinds = normalizeStateDoc({
            log: [
                {
                    id: 'i',
                    mechanicId: 'm',
                    holder: 'h',
                    attribute: 'item',
                    to: 1,
                    source: 'user',
                    kind: 'item',
                    itemBefore: null,
                    itemAfter: { id: 'x', name: 'R', qty: 1 },
                },
                {
                    id: 'r',
                    mechanicId: 'm',
                    holder: 'h',
                    attribute: 'a',
                    to: 'shown',
                    source: 'user',
                    kind: 'reveal',
                    revealBefore: true,
                },
                {
                    id: 'c',
                    mechanicId: 'm',
                    holder: 'h',
                    attribute: 'combat',
                    to: 'off',
                    source: 'user',
                    kind: 'combat',
                    combatBefore: null,
                    combatAfter: { order: [] },
                },
                { id: 'v', mechanicId: 'm', holder: 'h', attribute: 'a', to: 1, source: 'time', kind: 'weird' },
            ],
        });
        expect(kinds.log.map((change) => change.kind)).toEqual(['item', 'reveal', 'combat', undefined]);
        expect(kinds.log[0]?.item).toMatchObject({ name: 'R' });
        expect(kinds.log[1]?.revealBefore).toBe(true);
        expect(kinds.log[2]?.combatAfter).toMatchObject({ active: false });
    });
});

describe('turn rules in detail', () => {
    it('formulas over another mechanic, days and hours, broken amounts, statuses without a mechanic', () => {
        const doc = emptyStateDoc();
        apply(doc, { ...at, messageIndex: 1, mechanicId: 'magic', holder: 'Kai', attribute: 'level', value: 2 });
        apply(doc, {
            ...at,
            messageIndex: 1,
            kind: 'status',
            op: 'add',
            mechanicId: '',
            holder: 'Mira',
            status: { name: 'Cold', duration: { minutes: 60 } },
        });
        doc.clock = { day: 1, minutes: 1380, label: 'Day 1' };
        const rules: MechanicDef = {
            ...MAGIC,
            time: [
                { attr: 'hp', amount: '@magic.level - 3', per: 'day' },
                { attr: 'mana', amount: 'pow(', per: 'hour' },
                { attr: 'xp', amount: 5, per: 'hour', when: 'awake' },
            ],
        };
        const { ops, step } = turnOps(
            doc,
            { index: 4, clock: { day: 2, minutes: 120, label: 'Day 2' }, defs: [rules], holdersOf: () => ['Kai'] },
            options().getDef,
        );
        expect(step).toEqual({ turns: 1, minutes: 180, hours: 3, days: 1 });
        expect(ops).toEqual([
            {
                source: 'time',
                messageIndex: 4,
                kind: 'clock',
                index: 4,
                clock: { day: 2, minutes: 120, label: 'Day 2' },
            },
            {
                source: 'time',
                messageIndex: 4,
                kind: 'status',
                op: 'remove',
                mechanicId: '',
                holder: 'Mira',
                ref: statusesOf(doc, 'Mira')[0]!.id,
                expired: true,
                reason: 'expired',
            },
            {
                source: 'time',
                messageIndex: 4,
                mechanicId: 'magic',
                holder: 'Kai',
                attribute: 'hp',
                value: -1,
                delta: true,
                reason: 'per day',
            },
            {
                source: 'time',
                messageIndex: 4,
                mechanicId: 'magic',
                holder: 'Kai',
                attribute: 'xp',
                value: 15,
                delta: true,
                reason: 'per hour',
            },
        ]);
    });
});
