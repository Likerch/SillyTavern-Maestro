// M25 consequences (plan-2 §6 п. 1–2): actions of checks, events and level ups become state operations for concrete
// holders — who, which attribute, numbers through formulas over the actor's values and the roll, lists, scales,
// texts, statuses, items, revealing, fights — with English notes that honour each attribute's visibility.
import { describe, expect, it } from 'vitest';
import type { ChangeAction, MechanicDef } from '../../src/domain/mechanics-defs';
import { resolveActions } from '../../src/domain/mechanics-effects';
import type { ActionContext } from '../../src/domain/mechanics-effects';
import { resolveHolder } from '../../src/domain/mechanics-state';

const MAGIC: MechanicDef = {
    id: 'magic',
    name: 'Magic',
    summary: '',
    rules: '',
    attributes: [
        { id: 'mana', name: 'Mana', promptName: 'Mana', kind: 'number', min: 0, max: 100 },
        { id: 'power', name: 'Power', promptName: 'Power', kind: 'number', formula: '@mana / 10' },
        { id: 'schools', name: 'Schools', promptName: 'Schools', kind: 'list', options: ['fire', 'air'], multi: true },
        { id: 'rank', name: 'Rank', promptName: 'Rank', kind: 'scale', levels: ['novice', 'adept', 'master'] },
        { id: 'note', name: 'Note', promptName: 'Note', kind: 'text' },
        {
            id: 'secret',
            name: 'Secret',
            promptName: 'Secret',
            kind: 'number',
            visibility: { preset: 'secret' },
        },
        { id: 'bond', name: 'Bond', promptName: 'Bond', kind: 'number', visibility: { preset: 'book' } },
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [],
    tracking: 'block',
    scope: { kind: 'global' },
};

const HEALTH: MechanicDef = {
    ...MAGIC,
    id: 'health',
    name: 'Health',
    attributes: [{ id: 'hp', name: 'HP', promptName: 'HP', kind: 'number', min: 0, max: 20 }],
    holders: { kind: 'named', names: ['Kai', 'Guard'] },
};

const numbers: Record<string, number> = { 'magic|Kai|mana': 40, 'magic|Kai|rank': 1, 'health|Kai|hp': 12 };

function context(extra: Partial<ActionContext> = {}): ActionContext {
    return {
        def: MAGIC,
        actor: 'Kai',
        target: 'Guard',
        persona: 'Алекс',
        getDef: (id) => [MAGIC, HEALTH].find((def) => def.id === id) ?? null,
        resolveHolder: (def, raw) => resolveHolder(def, raw, { persona: 'Алекс' }),
        numberOf: (mechanicId, holder, attribute) => numbers[`${mechanicId}|${holder}|${attribute}`] ?? null,
        roll: { total: 15, margin: 3, natural: 13 },
        rng: () => 0.5,
        base: { source: 'check', messageIndex: 4, rollId: 'r1' },
        ...extra,
    };
}

function action(
    attr: string,
    op: ChangeAction['op'],
    value: number | string,
    extra: Partial<ChangeAction> = {},
): ChangeAction {
    return { who: 'actor', attr, op, value, ...extra };
}

const base = { source: 'check', messageIndex: 4, rollId: 'r1' };

describe('resolveActions', () => {
    it('numbers: deltas, absolute values, factors, formulas over the actor and the roll, dice', () => {
        const result = resolveActions(
            [
                action('mana', 'sub', 10),
                action('mana', 'add', '@roll.margin * 2'),
                action('mana', 'set', '@mana / 2'),
                action('mana', 'mul', 0.5),
                action('mana', 'sub', '1d6 + @roll.natural - @roll.total'),
                action('health.hp', 'sub', '@health.hp - 2', { who: 'target' }),
                action('mana', 'set', '50'),
            ],
            context(),
        );
        expect(result.rejected).toEqual([]);
        expect(result.ops).toEqual([
            { ...base, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: -10, delta: true },
            { ...base, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 6, delta: true },
            { ...base, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 20 },
            { ...base, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 0.5, op: 'mul' },
            { ...base, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: -2, delta: true },
            { ...base, mechanicId: 'health', holder: 'Guard', attribute: 'hp', value: -10, delta: true },
            { ...base, mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 50 },
        ]);
        expect(result.notes).toEqual([
            'Kai: Mana -10',
            'Kai: Mana +6',
            'Kai: Mana = 20',
            'Kai: Mana x0.5',
            'Kai: Mana -2',
            'Guard: HP -10',
            'Kai: Mana = 50',
        ]);
    });

    it('a roll reference without a roll counts as nothing', () => {
        const result = resolveActions(
            [action('mana', 'add', '@roll.total + @roll.margin + @roll.natural')],
            context({ roll: null }),
        );
        expect(result.ops[0]).toMatchObject({ value: 0, delta: true });
    });

    it('lists push and pull, scales step and set, texts are set', () => {
        const result = resolveActions(
            [
                action('schools', 'push', 'fire'),
                action('schools', 'pull', 'air'),
                action('schools', 'add', 'air'),
                action('rank', 'add', 1),
                action('rank', 'set', 'master'),
                action('note', 'set', 'tired'),
                action('schools', 'set', 'fire, air'),
            ],
            context(),
        );
        expect(
            result.ops.map((op) => ('value' in op ? [op.value, 'op' in op ? op.op : (op.delta ?? false)] : [])),
        ).toEqual([
            ['fire', 'push'],
            ['air', 'pull'],
            ['air', 'push'],
            [1, true],
            ['master', false],
            ['tired', false],
            ['fire, air', false],
        ]);
    });

    it('statuses, items, revealing and fights; who may be the persona or a named holder', () => {
        const result = resolveActions(
            [
                action('status', 'push', 'Poisoned (3 turns)'),
                action('status', 'push', '', { status: { name: 'Stunned', promptName: 'stunned' } }),
                action('status', 'pull', 'blessed', { who: 'persona' }),
                action('item', 'push', 'rope', { item: { name: 'rope', qty: 2 } }),
                action('item', 'pull', 3, { item: { name: 'coin' } }),
                action('item', 'push', 'torch'),
                action('reveal', 'push', 'Bond', { who: 'Guard' }),
                action('combat', 'pull', '', { who: 'target' }),
                action('combat', 'push', ''),
            ],
            context({ def: { ...MAGIC, holders: { kind: 'named', names: ['Kai', 'Guard', 'Алекс'] } } }),
        );
        expect(result.rejected).toEqual([]);
        expect(result.ops).toEqual([
            {
                ...base,
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'Poisoned', duration: { turns: 3 } },
            },
            {
                ...base,
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'Stunned', promptName: 'stunned' },
            },
            { ...base, kind: 'status', op: 'remove', mechanicId: 'magic', holder: 'Алекс', ref: 'blessed' },
            {
                ...base,
                kind: 'item',
                op: 'give',
                mechanicId: 'magic',
                holder: 'Kai',
                item: { name: 'rope', qty: 2 },
                qty: 2,
            },
            { ...base, kind: 'item', op: 'take', mechanicId: 'magic', holder: 'Kai', item: { name: 'coin' }, qty: 3 },
            { ...base, kind: 'item', op: 'give', mechanicId: 'magic', holder: 'Kai', item: { name: 'torch' }, qty: 1 },
            { ...base, kind: 'reveal', mechanicId: 'magic', holder: 'Guard', attribute: 'bond' },
            { ...base, kind: 'combat', op: 'out', mechanicId: 'magic', holder: 'Guard' },
            { ...base, kind: 'combat', op: 'join', mechanicId: 'magic', holder: 'Kai' },
        ]);
        expect(result.notes).toEqual([
            'Kai is now Poisoned',
            'Kai is now stunned',
            'Алекс is no longer blessed',
            'Kai gets rope x2',
            'Kai loses coin x3',
            'Kai gets torch',
            'Guard is out of the fight',
            'Kai joins the fight',
        ]);
        const counted = resolveActions([action('item', 'push', 4, { item: { name: 'arrow' } })], context());
        expect(counted.ops[0]).toMatchObject({ qty: 4 });
    });

    it('notes honour visibility: words for book attributes, nothing for secret ones', () => {
        const result = resolveActions(
            [action('bond', 'add', 5), action('bond', 'sub', 5), action('bond', 'set', 5), action('secret', 'add', 1)],
            context(),
        );
        expect(result.ops).toHaveLength(4);
        expect(result.notes).toEqual(['Kai: Bond goes up', 'Kai: Bond goes down', 'Kai: Bond changes']);
    });

    it('rejects what cannot be resolved', () => {
        const result = resolveActions(
            [
                action('mana', 'sub', 5, { who: 'target' }),
                action('mana', 'sub', 5, { who: 'Stranger' }),
                action('nope.mana', 'sub', 5),
                action('luck', 'add', 1),
                action('power', 'add', 1),
                action('mana', 'add', 'pow(2)'),
                action('mana', 'push', 1),
                action('status', 'push', ''),
                action('item', 'push', ''),
                action('reveal', 'push', 'luck'),
                action('note', 'add', 'x'),
            ],
            context({ target: null, def: { ...MAGIC, holders: { kind: 'named', names: ['Kai'] } } }),
        );
        expect(result.ops).toEqual([]);
        expect(result.rejected.map((item) => item.reason)).toEqual([
            'who',
            'who',
            'mechanic',
            'attribute',
            'attribute',
            'value',
            'op',
            'value',
            'value',
            'attribute',
            'op',
        ]);
    });

    it('takes the persona through its aliases and the actor through holder / self', () => {
        const result = resolveActions(
            [
                action('mana', 'add', 1, { who: 'user' }),
                action('mana', 'add', 1, { who: 'self' }),
                action('mana', 'add', 1, { who: 'holder' }),
            ],
            context({ persona: '' }),
        );
        expect(result.ops.map((op) => ('holder' in op ? op.holder : ''))).toEqual(['Алекс', 'Kai', 'Kai']);
    });
});
