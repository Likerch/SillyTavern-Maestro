// M25 definitions of plan-2 §6: the new parts of a mechanic are stored cleanly (effects, event actions and chains,
// derived attributes, growth, statuses, inventory, time rules, levels, fights, visibility, pinning), validated with
// plain issues, described in English for the entry's «Costs and limits».
import { describe, expect, it } from 'vitest';
import {
    defToEntry,
    describeAction,
    describeAttribute,
    describeCheck,
    entryToDef,
    findChainEvent,
    formulaIssueCode,
    mechanicLimits,
    normalizeAction,
    normalizeDef,
    normalizeDuration,
    normalizeItemSpec,
    normalizeStatusSpec,
    validateDef,
} from '../../src/domain/mechanics-defs';
import type { MechanicDef } from '../../src/domain/mechanics-defs';

function base(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'rpg',
        name: 'RPG',
        summary: 'A role-playing system.',
        rules: 'Rules.',
        attributes: [
            { id: 'hp', name: 'HP', promptName: 'HP', kind: 'number', min: 0, max: 30, initial: 30 },
            { id: 'xp', name: 'XP', promptName: 'XP', kind: 'number', min: 0, initial: 0 },
            { id: 'level', name: 'Level', promptName: 'Level', kind: 'number', min: 1, initial: 1 },
            { id: 'coins', name: 'Coins', promptName: 'Coins', kind: 'number', min: 0 },
            { id: 'perks', name: 'Perks', promptName: 'Perks', kind: 'list', options: ['a', 'b'], multi: true },
            { id: 'mood', name: 'Mood', promptName: 'Mood', kind: 'scale', levels: ['low', 'high'] },
            { id: 'note', name: 'Note', promptName: 'Note', kind: 'text' },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'attack',
                name: 'Attack',
                promptName: 'Attack',
                dice: '1d20+@level',
                difficulty: 12,
                triggers: ['атак'],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

const codes = (def: MechanicDef) => validateDef(def).map((issue) => issue.code);

describe('normalizing the new parts', () => {
    it('keeps every new part of a clean definition as it is', () => {
        const def = base({
            visibility: { preset: 'book', words: [{ upTo: 10, label: 'low' }] },
            statuses: [
                {
                    id: 'stun',
                    name: 'Stunned',
                    promptName: 'stunned',
                    duration: { turns: 1 },
                    modifiers: { checks: -5 },
                    stacks: 1,
                    maxStacks: 2,
                    text: 'dazed',
                    icon: 'fa-star',
                },
            ],
            inventory: { money: 'coins' },
            time: [{ attr: 'hp', amount: '@level', per: 'hour', when: 'rest' }],
            progression: {
                xp: 'xp',
                level: 'level',
                thresholds: [100, 200],
                onLevelUp: [{ who: 'actor', attr: 'hp', op: 'add', value: 5 }],
            },
            combat: { initiative: 'attack', enemy: { hp: 10 } },
            pinned: true,
            keys: ['guild'],
        });
        def.attributes[0] = {
            ...def.attributes[0]!,
            visibility: { prompt: 'words' },
            events: [
                {
                    id: 'down',
                    when: { op: '<=', value: 0 },
                    text: '',
                    actions: [{ who: 'actor', attr: 'combat', op: 'pull', value: '' }],
                    chain: 'hp.other',
                },
                { id: 'other', when: { op: 'changed' }, text: 'Changed.' },
            ],
        };
        def.attributes.push({
            id: 'max_hp',
            name: 'Max HP',
            promptName: 'Max HP',
            kind: 'number',
            formula: '20 + 5 * @level',
        });
        def.attributes[2] = { ...def.attributes[2]!, growth: { perUse: 0.5, cap: 10, on: 'any' } };
        def.checks[0] = {
            ...def.checks[0]!,
            effects: [
                { on: 'success', changes: [{ who: 'target', attr: 'hp', op: 'sub', value: '1d6' }], text: 'a hit' },
                { on: 'fumble', changes: [], text: 'drops the sword' },
            ],
        };
        expect(normalizeDef(def)).toEqual(def);
        expect(validateDef(def).filter((issue) => issue.level === 'error')).toEqual([]);
    });

    it('cleans stored parts: durations in words, odd values, extra fields', () => {
        expect(
            normalizeDuration({
                turns: 2.2,
                hours: 1,
                days: 1,
                weeks: 1,
                minutes: 10,
                until: { day: 3.7, minutes: 2000 },
            }),
        ).toEqual({
            turns: 3,
            minutes: 10 + 60 + 1440 + 10080,
            until: { day: 3, minutes: 1439 },
        });
        expect(normalizeDuration({ turns: 0 })).toBeNull();
        expect(normalizeDuration('x')).toBeNull();
        expect(normalizeStatusSpec(' Hex ')).toEqual({ name: 'Hex' });
        expect(normalizeStatusSpec('')).toBeNull();
        expect(
            normalizeStatusSpec({
                promptName: 'hexed',
                duration: null,
                stacks: 0,
                modifiers: { ' Checks ': '-2', x: 'a' },
            }),
        ).toEqual({
            name: 'hexed',
            promptName: 'hexed',
            duration: null,
            modifiers: { checks: -2 },
        });
        expect(normalizeStatusSpec({})).toBeNull();
        expect(normalizeStatusSpec(3)).toBeNull();
        expect(normalizeItemSpec('rope')).toEqual({ name: 'rope' });
        expect(normalizeItemSpec('')).toBeNull();
        expect(
            normalizeItemSpec({
                name: 'Sword',
                qty: 2,
                desc: ' sharp ',
                equipped: 'hand',
                tags: 'a, b',
                value: -1,
                modifiers: {},
            }),
        ).toEqual({
            name: 'Sword',
            qty: 2,
            desc: 'sharp',
            equipped: 'hand',
            tags: ['a', 'b'],
        });
        expect(normalizeItemSpec({ name: 'Cloak', equipped: null, value: 3 })).toEqual({
            name: 'Cloak',
            equipped: null,
            value: 3,
        });
        expect(normalizeItemSpec({ qty: 1 })).toBeNull();
        expect(normalizeItemSpec(null)).toBeNull();
        expect(normalizeAction({ attribute: 'HP', op: '-', value: 3, status: 'Hex', item: 'rope' })).toEqual({
            who: 'actor',
            attr: 'hp',
            op: 'sub',
            value: 3,
            status: { name: 'Hex' },
            item: { name: 'rope' },
        });
        expect(normalizeAction({ attr: 'hp', op: '+', value: ' 2 ' })).toMatchObject({ op: 'add', value: '2' });
        expect(normalizeAction({ attr: 'hp', op: '=', value: {} })).toMatchObject({ op: 'set', value: '' });
        expect(normalizeAction({ attr: 'hp' })).toBeNull();
        expect(normalizeAction('x')).toBeNull();
        const stored = normalizeDef({
            ...base(),
            visibility: 'secret',
            statuses: [null, 'Hex'],
            inventory: { money: ' Coins ' },
            time: [
                { attr: 'hp', amount: 1, per: 'week' },
                { attr: 'hp', amount: ' ', per: 'turn' },
                { attr: 'hp', amount: 2, per: 'turn', when: 'never' },
                'x',
            ],
            progression: { xp: 'xp', level: 'level', thresholds: ['5', 'x', 10] },
            combat: { enemy: { hp: 'x' } },
            pinned: 'yes',
            keys: ' guild, Guild ',
            attributes: [
                { id: 'hp', kind: 'number', name: 'HP', formula: ' ', growth: { perUse: 0 } },
                { id: 'mood', kind: 'scale', name: 'Mood', levels: ['a', 'b'], formula: '1', growth: { perUse: 1 } },
                { id: 'xp', kind: 'number', name: 'XP', growth: { perUse: 1, on: 'never' } },
            ],
            checks: [
                {
                    id: 'c',
                    name: 'C',
                    dice: '1d6',
                    effects: [
                        { on: 'never' },
                        { on: 'any' },
                        { on: 'any', changes: [{ attr: 'hp', op: 'sub', value: 1 }] },
                        3,
                    ],
                },
            ],
        });
        expect(stored).toMatchObject({
            visibility: { preset: 'secret' },
            statuses: [{ name: 'Hex' }],
            inventory: { money: 'coins' },
            time: [{ attr: 'hp', amount: 2, per: 'turn' }],
            progression: { xp: 'xp', level: 'level', thresholds: [5, 10] },
            combat: {},
            keys: ['guild'],
        });
        expect(stored?.pinned).toBeUndefined();
        expect(stored?.attributes[0]).not.toHaveProperty('formula');
        expect(stored?.attributes[0]).not.toHaveProperty('growth');
        expect(stored?.attributes[1]).not.toHaveProperty('formula');
        expect(stored?.attributes[2]?.growth).toEqual({ perUse: 1 });
        expect(stored?.checks[0]?.effects).toEqual([
            { on: 'any', changes: [{ who: 'actor', attr: 'hp', op: 'sub', value: 1 }] },
        ]);
        expect(normalizeDef({ ...base(), inventory: {}, progression: { xp: 'xp' }, time: [] })).not.toHaveProperty(
            'time',
        );
        expect(normalizeDef({ ...base(), inventory: {} })?.inventory).toEqual({});
    });

    it('finds chained events by id or attribute.id', () => {
        const def = base();
        def.attributes[0]!.events = [{ id: 'low', when: { op: '<=', value: 5 }, text: 'Low.' }];
        expect(findChainEvent(def, 'low')?.event.id).toBe('low');
        expect(findChainEvent(def, 'hp.low')?.attribute.id).toBe('hp');
        expect(findChainEvent(def, 'xp.low')).toBeNull();
    });
});

describe('validation of the new parts', () => {
    it('formulas of derived attributes: syntax, unknown references, dice, circles', () => {
        const def = base();
        def.attributes.push(
            { id: 'a', name: 'A', promptName: 'A', kind: 'number', formula: '@b + 1' },
            { id: 'b', name: 'B', promptName: 'B', kind: 'number', formula: '@a + 1' },
            { id: 'c', name: 'C', promptName: 'C', kind: 'number', formula: 'pow(2)' },
            { id: 'd', name: 'D', promptName: 'D', kind: 'number', formula: '@luck' },
            { id: 'e', name: 'E', promptName: 'E', kind: 'number', formula: '1d6' },
            { id: 'f', name: 'F', promptName: 'F', kind: 'number', formula: '@other.x + @roll.total' },
        );
        expect(codes(def)).toEqual(['formulaFunc', 'formulaRef', 'formulaDice', 'formulaRef', 'formulaCycle']);
        const issue = validateDef(def).find((item) => item.code === 'formulaCycle');
        expect(issue).toMatchObject({ path: 'attributes.7.formula', params: { where: 'a → b' } });
        expect(validateDef(def).find((item) => item.code === 'formulaFunc')?.params).toMatchObject({
            where: 'C',
            detail: 'pow',
            at: 1,
        });
        expect(formulaIssueCode({ code: 'empty' })).toBe('formulaEmpty');
    });

    it('consequences: unknown or derived attributes, wrong operations, statuses, items, reveals, formulas', () => {
        const def = base();
        def.attributes.push({ id: 'max', name: 'Max', promptName: 'Max', kind: 'number', formula: '1' });
        def.checks[0]!.effects = [
            {
                on: 'success',
                changes: [
                    { who: 'actor', attr: 'luck', op: 'add', value: 1 },
                    { who: 'actor', attr: 'max', op: 'add', value: 1 },
                    { who: 'actor', attr: 'hp', op: 'push', value: 1 },
                    { who: 'actor', attr: 'hp', op: 'sub', value: '@roll.margin + @roll.oops' },
                    { who: 'actor', attr: 'perks', op: 'add', value: 'a' },
                    { who: 'actor', attr: 'mood', op: 'push', value: 'x' },
                    { who: 'actor', attr: 'note', op: 'add', value: 'x' },
                    { who: 'actor', attr: 'status', op: 'push', value: '' },
                    { who: 'actor', attr: 'item', op: 'push', value: ' ' },
                    { who: 'actor', attr: 'reveal', op: 'push', value: 'luck' },
                    { who: 'actor', attr: 'other.hp', op: 'sub', value: '2 +' },
                    { who: 'actor', attr: 'other.note', op: 'set', value: 'free text' },
                    { who: 'actor', attr: 'perks', op: 'push', value: 'a' },
                    { who: 'actor', attr: 'mood', op: 'add', value: 1 },
                    { who: 'actor', attr: 'note', op: 'set', value: 'x' },
                    { who: 'actor', attr: 'hp', op: 'sub', value: '1d6 + @roll.total' },
                ],
            },
        ];
        expect(codes(def)).toEqual([
            'actionAttr',
            'actionDerived',
            'actionOp',
            'formulaRef',
            'actionOp',
            'actionOp',
            'actionOp',
            'actionStatus',
            'actionItem',
            'actionReveal',
            'formulaSyntax',
        ]);
    });

    it('events: actions, chains (unknown, to itself), a note or an action is needed', () => {
        const def = base();
        def.attributes[0]!.events = [
            { id: 'a', when: { op: '<=', value: 0 }, text: '', chain: 'nope' },
            {
                id: 'b',
                when: { op: '<=', value: 5 },
                text: '',
                chain: 'b',
                actions: [{ who: 'actor', attr: 'luck', op: 'add', value: 1 }],
            },
        ];
        expect(codes(def)).toEqual(['eventText', 'eventChain', 'actionAttr', 'eventChainSelf']);
    });

    it('time rules, levels, growth, fights and money', () => {
        const def = base({
            time: [
                { attr: 'luck', amount: 1, per: 'turn' },
                { attr: 'note', amount: 1, per: 'turn' },
                { attr: 'hp', amount: '2 +', per: 'turn' },
            ],
            progression: {
                xp: 'luck',
                level: 'note',
                thresholds: [10, 5],
                onLevelUp: [{ who: 'actor', attr: 'luck', op: 'add', value: 1 }],
            },
            combat: { initiative: 'nope' },
            inventory: { money: 'gold' },
        });
        def.attributes.push({ id: 'max', name: 'Max', promptName: 'Max', kind: 'number', formula: '1' });
        def.time!.push({ attr: 'max', amount: 1, per: 'turn' });
        def.attributes[0] = { ...def.attributes[0]!, growth: { perUse: 1, cap: 40 } };
        expect(codes(def)).toEqual([
            'growthCap',
            'timeAttr',
            'timeAttr',
            'formulaSyntax',
            'actionDerived',
            'progressionAttr',
            'progressionAttr',
            'progressionThresholds',
            'actionAttr',
            'combatInitiative',
            'inventoryMoney',
        ]);
        expect(
            codes(
                base({ progression: { xp: 'xp', level: 'level', thresholds: [] }, inventory: { money: 'bank.gold' } }),
            ),
        ).toEqual(['progressionThresholds']);
    });
});

describe('English descriptions of the new parts', () => {
    it('attributes, actions, checks with effects and the limits field', () => {
        expect(
            describeAttribute({
                id: 'max',
                name: 'Max',
                promptName: 'Max HP',
                kind: 'number',
                min: 0,
                formula: '20 + @level',
            }),
        ).toBe('Max HP (max): derived number from 0 = 20 + @level');
        expect(
            describeAttribute({
                id: 'sk',
                name: 'S',
                promptName: 'Skill',
                kind: 'number',
                growth: { perUse: 0.2, on: 'any' },
            }),
        ).toBe('Skill (sk): number, grows by 0.2 per use');
        expect(describeAction({ who: 'target', attr: 'hp', op: 'sub', value: '1d6' })).toBe("target's hp -1d6");
        expect(describeAction({ who: 'actor', attr: 'hp', op: 'set', value: 5 })).toBe('hp = 5');
        expect(describeAction({ who: 'actor', attr: 'hp', op: 'mul', value: 2 })).toBe('hp x2');
        expect(
            describeAction({
                who: 'actor',
                attr: 'status',
                op: 'push',
                value: 'x',
                status: { name: 'Hex', promptName: 'hexed', duration: { turns: 2 } },
            }),
        ).toBe('status +hexed (2 turns)');
        expect(describeAction({ who: 'actor', attr: 'status', op: 'pull', value: 'hexed' })).toBe('status -hexed');
        expect(
            describeAction({ who: 'actor', attr: 'item', op: 'push', value: 'rope', item: { name: 'rope', qty: 2 } }),
        ).toBe('item +rope x2');
        expect(describeAction({ who: 'actor', attr: 'item', op: 'pull', value: 'coin' })).toBe('item -coin');
        expect(describeAction({ who: 'actor', attr: 'reveal', op: 'push', value: 'mood' })).toBe('reveal mood');
        expect(describeAction({ who: 'Kai', attr: 'combat', op: 'pull', value: '' })).toBe('Kai leaves the fight');
        expect(describeAction({ who: 'actor', attr: 'combat', op: 'push', value: '' })).toBe('joins the fight');
        const check = {
            ...base().checks[0]!,
            effects: [
                {
                    on: 'failure' as const,
                    changes: [{ who: 'actor', attr: 'hp', op: 'sub' as const, value: 2 }],
                    text: 'stumbles',
                },
            ],
        };
        expect(describeCheck(check)).toBe('Attack (attack): 1d20+@level vs 12; on failure: hp -2, stumbles');
        const limits = mechanicLimits(
            base({
                statuses: [{ name: 'Оглушён', promptName: 'stunned' }, { name: 'Prone' }],
                inventory: { money: 'coins' },
                time: [
                    { attr: 'hp', amount: 5, per: 'hour', when: 'rest' },
                    { attr: 'hp', amount: -1, per: 'turn', when: 'awake' },
                    { attr: 'hp', amount: 1, per: 'day' },
                ],
                progression: { xp: 'xp', level: 'level', thresholds: [100, 300] },
                combat: { initiative: 'attack' },
            }),
        );
        expect(limits).toContain('Statuses: stunned, Prone');
        expect(limits).toContain('Inventory, money in coins');
        expect(limits).toContain('Over time: hp 5 per hour while resting');
        expect(limits).toContain('Over time: hp -1 per turn while awake');
        expect(limits).toContain('Over time: hp 1 per day');
        expect(limits).toContain('Levels: level by xp at 100, 300');
        expect(limits).toContain('Combat, initiative by attack');
        expect(mechanicLimits(base({ inventory: {}, combat: {} }))).toContain('Inventory\nCombat');
    });

    it('the lorebook entry keeps the new parts through a round trip', () => {
        const def = base({ statuses: [{ name: 'Hex' }], visibility: { preset: 'book' }, pinned: true });
        const entry = defToEntry(def, 3);
        expect(entryToDef(entry, 'Book')).toMatchObject({
            statuses: [{ name: 'Hex' }],
            visibility: { preset: 'book' },
            pinned: true,
            uid: 3,
        });
    });
});
