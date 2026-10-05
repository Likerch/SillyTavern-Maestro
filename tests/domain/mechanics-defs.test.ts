import { describe, expect, expectTypeOf, it } from 'vitest';
import { composeContent, readTypedMeta } from '../../src/domain/entry-types';
import {
    cleanList,
    defToEntry,
    describeAttribute,
    describeCheck,
    describeHolders,
    desStatsAttributes,
    diceAttributes,
    dndModifier,
    entryToDef,
    hasErrors,
    holdsCharacters,
    initialValueOf,
    isMechanicEntry,
    isSnakeId,
    mechanicJsonOf,
    mechanicLimits,
    modifierValue,
    newMechanicId,
    normalizeDef,
    normalizeHolders,
    normalizeScope,
    parseDice,
    scopeForNew,
    scopeMatches,
    snakeId,
    storedDef,
    trackingOf,
    underTarget,
    uniqueId,
    validateDef,
} from '../../src/domain/mechanics-defs';
import type * as Domain from '../../src/domain/mechanics-defs';
import type * as Api from '../../src/features/mechanics/api';

type Dict = Record<string, unknown>;

function def(partial: Partial<Domain.MechanicDef> = {}): Domain.MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Spellcasting powered by mana.',
        rules: 'Casting costs mana.',
        attributes: [
            { id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 50 },
            {
                id: 'schools',
                name: 'Школы',
                promptName: 'Schools',
                kind: 'list',
                options: ['fire', 'water'],
                multi: true,
                initial: ['fire'],
            },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'spell',
                name: 'Заклинание',
                promptName: 'Spellcasting',
                dice: '1d100<=@mana',
                difficulty: null,
                triggers: ['заклин', 'spell'],
            },
        ],
        tracking: 'desStats',
        scope: { kind: 'card', avatar: 'kai.png' },
        ...partial,
    };
}

const codes = (value: Domain.MechanicDef) => validateDef(value).map((issue) => issue.code);

describe('types', () => {
    it('are the public contract', () => {
        expectTypeOf<Domain.MechanicDef>().toEqualTypeOf<Api.MechanicDef>();
        expectTypeOf<Domain.AttributeDef>().toEqualTypeOf<Api.AttributeDef>();
        expectTypeOf<Domain.CheckDef>().toEqualTypeOf<Api.CheckDef>();
        expectTypeOf<Domain.HolderSpec>().toEqualTypeOf<Api.HolderSpec>();
        expectTypeOf<Domain.MechanicScope>().toEqualTypeOf<Api.MechanicScope>();
        expectTypeOf<Domain.AttributeEvent>().toEqualTypeOf<Api.AttributeEvent>();
        expectTypeOf<Domain.TrackingMode>().toEqualTypeOf<Api.TrackingMode>();
        expectTypeOf<Domain.AttributeValue>().toEqualTypeOf<Api.AttributeValue>();
        expectTypeOf<Domain.MechanicTemplate>().toEqualTypeOf<Api.MechanicTemplate>();
    });
});

describe('parseDice', () => {
    it('reads every supported form', () => {
        expect(parseDice('2d6')).toEqual({ count: 2, sides: 6, modifier: null, under: null, text: '2d6' });
        expect(parseDice('d20')?.text).toBe('1d20');
        expect(parseDice('1d20+3')).toMatchObject({ modifier: { sign: 1, term: { kind: 'flat', value: 3 } } });
        expect(parseDice('1d20-2')).toMatchObject({ modifier: { sign: -1, term: { kind: 'flat', value: 2 } } });
        expect(parseDice('1d20+@stealth')).toMatchObject({
            modifier: { sign: 1, term: { kind: 'attr', attribute: 'stealth' } },
        });
        expect(parseDice('1d20-@fatigue')?.modifier).toEqual({
            sign: -1,
            term: { kind: 'attr', attribute: 'fatigue' },
        });
        expect(parseDice('1d20+mod(@persuasion)')).toMatchObject({
            modifier: { sign: 1, term: { kind: 'mod', attribute: 'persuasion' } },
            text: '1d20+mod(@persuasion)',
        });
        expect(parseDice('1d100<=@stealth')).toMatchObject({
            modifier: null,
            under: { kind: 'attr', attribute: 'stealth' },
            text: '1d100<=@stealth',
        });
        expect(parseDice('3d6<=12')?.under).toEqual({ kind: 'flat', value: 12 });
    });

    it('ignores case and spaces and takes the Russian «к»', () => {
        expect(parseDice(' 1D20 + MOD( @Persuasion ) ')?.text).toBe('1d20+mod(@persuasion)');
        expect(parseDice('1к20+2')?.text).toBe('1d20+2');
        expect(parseDice('2К6')?.text).toBe('2d6');
    });

    it('refuses anything else', () => {
        for (const bad of [
            '',
            'abc',
            '1d',
            'd',
            '0d6',
            '1d1',
            '101d6',
            '1d1001',
            '1d20+10001',
            '1d100<=100001',
            '1d20+@',
            '1d20+@1abc',
            '1d20+mod(stealth)',
            '1d20+3<=@stealth',
            '1d20*2',
            '1d20+3+2',
            '1d20>=10',
        ]) {
            expect(parseDice(bad), bad).toBeNull();
        }
        expect(parseDice(42 as unknown as string)).toBeNull();
    });

    it('evaluates modifiers and roll-under targets', () => {
        const values: Record<string, number> = { str: 16, low: 7 };
        const valueOf = (id: string) => values[id] ?? null;
        expect(dndModifier(10)).toBe(0);
        expect(dndModifier(16)).toBe(3);
        expect(dndModifier(7)).toBe(-2);
        expect(modifierValue(parseDice('1d20')!, valueOf)).toBe(0);
        expect(modifierValue(parseDice('1d20+4')!, valueOf)).toBe(4);
        expect(modifierValue(parseDice('1d20-4')!, valueOf)).toBe(-4);
        expect(modifierValue(parseDice('1d20+@str')!, valueOf)).toBe(16);
        expect(modifierValue(parseDice('1d20+@missing')!, valueOf)).toBe(0);
        expect(modifierValue(parseDice('1d20+mod(@str)')!, valueOf)).toBe(3);
        expect(modifierValue(parseDice('1d20-mod(@low)')!, valueOf)).toBe(2);
        expect(modifierValue(parseDice('1d20+mod(@missing)')!, valueOf)).toBe(0);
        expect(underTarget(parseDice('1d20')!, valueOf)).toBeNull();
        expect(underTarget(parseDice('1d100<=40')!, valueOf)).toBe(40);
        expect(underTarget(parseDice('1d100<=@str')!, valueOf)).toBe(16);
        expect(underTarget(parseDice('1d100<=@missing')!, valueOf)).toBeNull();
        expect(diceAttributes(parseDice('1d20+mod(@str)')!)).toEqual(['str']);
        expect(diceAttributes(parseDice('1d100<=@low')!)).toEqual(['low']);
        expect(diceAttributes(parseDice('2d6+1')!)).toEqual([]);
    });
});

describe('ids', () => {
    it('makes readable snake_case ids', () => {
        expect(snakeId('Здоровье')).toBe('zdorove');
        expect(snakeId('Stamina Points!')).toBe('stamina_points');
        expect(snakeId('Щит ёжика')).toBe('schit_ezhika');
        expect(snakeId('  ')).toBe('item');
        expect(snakeId('***', 'attr')).toBe('attr');
        expect(snakeId('42 coins')).toBe('x_42_coins');
        expect(snakeId('a'.repeat(50))).toHaveLength(32);
        expect(isSnakeId('mana_2')).toBe(true);
        expect(isSnakeId('Mana')).toBe(false);
        expect(isSnakeId('2mana')).toBe(false);
        expect(isSnakeId('a'.repeat(41))).toBe(false);
        expect(isSnakeId(5)).toBe(false);
    });

    it('keeps ids unique', () => {
        expect(uniqueId('magic', [])).toBe('magic');
        expect(uniqueId('magic', ['magic', 'magic_2'])).toBe('magic_3');
        expect(newMechanicId('Магия', ['magiya'])).toBe('magiya_2');
        expect(newMechanicId('', [])).toBe('mechanic');
    });

    it('cleans lists', () => {
        expect(cleanList(' fire, Water ,, fire ,water')).toEqual(['fire', 'Water']);
        expect(cleanList(['a', 2, ' b ', 'A'])).toEqual(['a', 'b']);
        expect(cleanList(undefined)).toEqual([]);
    });
});

describe('normalizeDef', () => {
    it('refuses non-objects and definitions without an id', () => {
        expect(normalizeDef(null)).toBeNull();
        expect(normalizeDef([])).toBeNull();
        expect(normalizeDef({ name: 'x' })).toBeNull();
    });

    it('keeps an English prompt name only when it is given', () => {
        expect(normalizeDef({ id: 'magic', name: 'Магия', promptName: ' Magic ' })?.promptName).toBe('Magic');
        expect(normalizeDef({ id: 'magic', name: 'Магия', promptName: '  ' })).not.toHaveProperty('promptName');
    });

    it('fills defaults and coerces stored data', () => {
        const value = normalizeDef({
            id: ' luck ',
            summary: '  Luck.\r\n',
            attributes: [
                { id: 'luck', promptName: 'Luck', min: '0', max: 10, initial: '5', levels: ['x'], tracking: 'nope' },
                { id: 'mood', name: 'Mood', kind: 'scale', levels: 'sad, calm, glad', initial: ' calm ', min: 1 },
                { id: 'tags', name: 'Tags', kind: 'list', options: ['a', 'b'], initial: 'a', multi: 'yes' },
                { id: 'note', name: 'Note', kind: 'weird', initial: '  hi  ', visible: false },
                { id: 'free', name: 'Free', kind: 'text', initial: 3 },
                'junk',
            ],
            checks: [
                {
                    id: 'roll',
                    name: 'Roll',
                    dice: ' 1d20 ',
                    difficulty: '12',
                    triggers: 'luck, LUCK',
                    criticals: false,
                },
                { name: 'Other', difficulty: 'hard' },
                7,
            ],
            holders: { kind: 'factions', names: 'Guild, Crown' },
            tracking: 'nope',
            scope: { kind: 'card', avatar: '' },
            template: 'x',
            book: 'B',
            uid: 3,
            updatedAt: 5,
        })!;
        expect(value).toMatchObject({
            id: 'luck',
            name: 'luck',
            summary: 'Luck.',
            rules: '',
            tracking: 'background',
            scope: { kind: 'global' },
            holders: { kind: 'factions', names: ['Guild', 'Crown'] },
            template: 'x',
            book: 'B',
            uid: 3,
            updatedAt: 5,
        });
        expect(value.attributes).toEqual([
            { id: 'luck', name: 'Luck', promptName: 'Luck', kind: 'number', max: 10, initial: 5 },
            {
                id: 'mood',
                name: 'Mood',
                promptName: 'Mood',
                kind: 'scale',
                levels: ['sad', 'calm', 'glad'],
                initial: 'calm',
            },
            { id: 'tags', name: 'Tags', promptName: 'Tags', kind: 'list', options: ['a', 'b'], initial: ['a'] },
            { id: 'note', name: 'Note', promptName: 'Note', kind: 'text', initial: 'hi', visible: false },
            { id: 'free', name: 'Free', promptName: 'Free', kind: 'text' },
        ]);
        expect(value.checks).toEqual([
            {
                id: 'roll',
                name: 'Roll',
                promptName: 'Roll',
                dice: '1d20',
                difficulty: 12,
                triggers: ['luck'],
                criticals: false,
            },
            { id: 'check_2', name: 'Other', promptName: 'Other', dice: '', difficulty: null, triggers: [] },
        ]);
        expect(normalizeDef(value)).toEqual(value);
    });

    it('keeps valid events and drops broken ones', () => {
        const value = normalizeDef({
            id: 'hp',
            attributes: [
                {
                    id: 'hp',
                    name: 'HP',
                    events: [
                        { id: 'down', when: { op: '<=', value: 0 }, text: ' {holder} falls. ', once: false },
                        { when: { op: 'changed', value: 4 }, text: 'Changed.' },
                        { id: 'lvl', when: { op: '=', value: ' max ' }, text: 'x' },
                        { id: 'bad', when: { op: '<' }, text: 'x' },
                        { id: 'nan', when: { op: '>=', value: Number.NaN }, text: 'x' },
                        'junk',
                    ],
                },
                { id: 'empty', name: 'E', events: [{ when: {} }] },
            ],
        })!;
        expect(value.attributes[0]!.events).toEqual([
            { id: 'down', when: { op: '<=', value: 0 }, text: '{holder} falls.', once: false },
            { id: 'event_2', when: { op: 'changed' }, text: 'Changed.' },
            { id: 'lvl', when: { op: '=', value: 'max' }, text: 'x' },
            { id: 'nan', when: { op: '>=' }, text: 'x' },
        ]);
        expect(value.attributes[1]!.events).toBeUndefined();
    });

    it('normalises holders and scopes', () => {
        expect(normalizeHolders(undefined)).toEqual({ kind: 'characters' });
        expect(normalizeHolders({ kind: 'characters', includePersona: true })).toEqual({
            kind: 'characters',
            includePersona: true,
        });
        expect(normalizeHolders({ kind: 'persona', names: ['x'] })).toEqual({ kind: 'persona' });
        expect(normalizeHolders({ kind: 'world' })).toEqual({ kind: 'world' });
        expect(normalizeHolders({ kind: 'named', names: ['Kai', ' kai '] })).toEqual({ kind: 'named', names: ['Kai'] });
        expect(normalizeScope({ kind: 'chat', chatId: 'c1' })).toEqual({ kind: 'chat', chatId: 'c1' });
        expect(normalizeScope({ kind: 'chat' })).toEqual({ kind: 'global' });
        expect(normalizeScope({ kind: 'card', avatar: 'a.png' })).toEqual({ kind: 'card', avatar: 'a.png' });
        expect(normalizeScope('x')).toEqual({ kind: 'global' });
    });
});

describe('validateDef', () => {
    it('accepts a good definition', () => {
        expect(validateDef(def())).toEqual([]);
        expect(hasErrors(validateDef(def()))).toBe(false);
    });

    it('reports problems of the mechanic', () => {
        expect(codes(def({ id: 'Magic' }))).toContain('id');
        expect(codes(def({ name: ' ' }))).toContain('name');
        expect(codes(def({ attributes: [], checks: [], rules: '' }))).toEqual(['empty']);
        expect(codes(def({ rules: '', summary: '' }))).toEqual(['noRules']);
        expect(codes(def({ holders: { kind: 'factions', names: [] } }))).toContain('holderNames');
        expect(codes(def({ scope: { kind: 'card', avatar: '' } }))).toContain('scope');
        expect(codes(def({ scope: { kind: 'chat', chatId: '' } }))).toContain('scope');
        const warnOnly = validateDef(def({ rules: '', summary: '' }));
        expect(hasErrors(warnOnly)).toBe(false);
    });

    it('reports problems of attributes', () => {
        const attrs = (attributes: Domain.AttributeDef[]) => codes(def({ attributes, checks: [] }));
        const number = (extra: Partial<Domain.AttributeDef>): Domain.AttributeDef => ({
            id: 'hp',
            name: 'HP',
            promptName: 'HP',
            kind: 'number',
            ...extra,
        });
        expect(attrs([number({ id: 'HP' })])).toContain('attrId');
        expect(attrs([number({}), number({})])).toContain('attrIdDuplicate');
        expect(attrs([number({ name: '' })])).toContain('attrName');
        expect(attrs([number({ promptName: '' })])).toContain('attrPromptName');
        expect(attrs([number({ min: 5, max: 1 })])).toContain('bounds');
        expect(attrs([number({ initial: 'x' })])).toContain('initial');
        expect(attrs([number({ min: 0, max: 10, initial: 11 })])).toContain('initialRange');
        expect(attrs([number({ min: 0, initial: -1 })])).toContain('initialRange');
        const scale = (extra: Partial<Domain.AttributeDef>) => number({ kind: 'scale', levels: ['a', 'b'], ...extra });
        expect(attrs([scale({ levels: ['a'] })])).toContain('levels');
        expect(attrs([scale({ initial: 'c' })])).toContain('initialLevel');
        const list = (extra: Partial<Domain.AttributeDef>) => number({ kind: 'list', options: ['a', 'b'], ...extra });
        expect(attrs([list({ options: [] })])).toContain('options');
        expect(attrs([list({ initial: ['c'] })])).toContain('initialOption');
        expect(attrs([list({ initial: 'a' })])).toEqual([]);
        expect(attrs([list({ initial: ['a', 'b'] })])).toContain('initialSingle');
        expect(attrs([list({ initial: ['a', 'b'], multi: true })])).toEqual([]);
        expect(attrs([number({ kind: 'text', tracking: 'desStats' })])).toContain('desStatsKind');
        expect(
            codes(def({ holders: { kind: 'world' }, attributes: [number({ tracking: 'desStats' })], checks: [] })),
        ).toContain('desStatsHolders');
    });

    it('reports problems of events', () => {
        const withEvents = (kind: Domain.AttributeKind, events: Domain.AttributeEvent[]) =>
            codes(
                def({
                    checks: [],
                    attributes: [
                        {
                            id: 'a',
                            name: 'A',
                            promptName: 'A',
                            kind,
                            levels: ['low', 'high'],
                            options: ['x'],
                            events,
                        },
                    ],
                }),
            );
        const event = (when: Domain.AttributeEvent['when'], extra: Partial<Domain.AttributeEvent> = {}) => ({
            id: 'e',
            when,
            text: 'Note.',
            ...extra,
        });
        expect(withEvents('number', [event({ op: '<=', value: 0 }, { id: 'E' })])).toContain('eventId');
        expect(withEvents('number', [event({ op: 'changed' }), event({ op: 'changed' })])).toContain(
            'eventIdDuplicate',
        );
        expect(withEvents('number', [event({ op: 'changed' }, { text: ' ' })])).toContain('eventText');
        expect(withEvents('number', [event({ op: '<=', value: 'x' })])).toContain('eventValue');
        expect(withEvents('scale', [event({ op: '>=', value: 'mid' })])).toContain('eventLevel');
        expect(withEvents('scale', [event({ op: '>=', value: 'high' })])).toEqual([]);
        expect(withEvents('list', [event({ op: '<=', value: 'x' })])).toContain('eventOp');
        expect(withEvents('list', [event({ op: '=', value: '' })])).toContain('eventValue');
        expect(withEvents('text', [event({ op: '=', value: 'calm' })])).toEqual([]);
    });

    it('reports problems of checks', () => {
        const check = (extra: Partial<Domain.CheckDef>): Domain.CheckDef => ({
            id: 'c',
            name: 'C',
            promptName: 'C',
            dice: '1d20',
            difficulty: 10,
            triggers: ['c'],
            ...extra,
        });
        const checks = (list: Domain.CheckDef[]) => codes(def({ checks: list }));
        expect(checks([check({ id: '1' })])).toContain('checkId');
        expect(checks([check({}), check({})])).toContain('checkIdDuplicate');
        expect(checks([check({ name: '' })])).toContain('checkName');
        expect(checks([check({ dice: '1x20' })])).toContain('dice');
        expect(checks([check({ dice: '1d20+@nope' })])).toContain('diceUnknown');
        expect(checks([check({ dice: '1d20+@schools' })])).toContain('diceKind');
        expect(checks([check({ difficulty: Number.NaN })])).toContain('difficulty');
        const warn = validateDef(def({ checks: [check({ triggers: [] })] }));
        expect(warn).toEqual([
            { level: 'warn', code: 'noTriggers', path: 'checks.0.triggers', params: { check: 'C' } },
        ]);
    });
});

describe('tracking and values', () => {
    it('gives DES stats only to numbers of characters', () => {
        const value = def();
        expect(trackingOf(value, value.attributes[0]!)).toBe('desStats');
        expect(trackingOf(value, value.attributes[1]!)).toBe('background');
        expect(trackingOf(value, { ...value.attributes[0]!, tracking: 'block' })).toBe('block');
        expect(trackingOf({ ...value, holders: { kind: 'world' } }, value.attributes[0]!)).toBe('background');
        expect(desStatsAttributes(value).map((item) => item.id)).toEqual(['mana']);
        expect(holdsCharacters({ kind: 'persona' })).toBe(true);
        expect(holdsCharacters({ kind: 'named', names: [] })).toBe(true);
        expect(holdsCharacters({ kind: 'factions', names: [] })).toBe(false);
    });

    it('starts holders at the initial value', () => {
        const base = { id: 'a', name: 'A', promptName: 'A' };
        expect(initialValueOf({ ...base, kind: 'number', min: 0, max: 10, initial: 50 })).toBe(10);
        expect(initialValueOf({ ...base, kind: 'number', min: 3 })).toBe(3);
        expect(initialValueOf({ ...base, kind: 'number', max: -2 })).toBe(-2);
        expect(initialValueOf({ ...base, kind: 'scale', levels: ['a', 'b'], initial: 'b' })).toBe('b');
        expect(initialValueOf({ ...base, kind: 'scale', levels: ['a', 'b'], initial: 'z' })).toBe('a');
        expect(initialValueOf({ ...base, kind: 'scale' })).toBe('');
        expect(initialValueOf({ ...base, kind: 'list', options: ['x', 'y'], initial: ['x', 'y', 'z'] })).toEqual(['x']);
        expect(
            initialValueOf({ ...base, kind: 'list', options: ['x', 'y'], initial: ['x', 'y'], multi: true }),
        ).toEqual(['x', 'y']);
        expect(initialValueOf({ ...base, kind: 'list', options: ['x'], initial: 'x' })).toEqual(['x']);
        expect(initialValueOf({ ...base, kind: 'list' })).toEqual([]);
        expect(initialValueOf({ ...base, kind: 'text', initial: 'hi' })).toBe('hi');
        expect(initialValueOf({ ...base, kind: 'text' })).toBe('');
    });
});

describe('scope', () => {
    const here = { avatars: ['kai.png'], chatId: 'c1' };
    it('matches global, card and chat definitions', () => {
        expect(scopeMatches({ kind: 'global' }, here)).toBe(true);
        expect(scopeMatches({ kind: 'card', avatar: 'kai.png' }, here)).toBe(true);
        expect(scopeMatches({ kind: 'card', avatar: 'mia.png' }, here)).toBe(false);
        expect(scopeMatches({ kind: 'chat', chatId: 'c1' }, here)).toBe(true);
        expect(scopeMatches({ kind: 'chat', chatId: 'c2' }, here)).toBe(false);
        expect(scopeMatches({ kind: 'chat', chatId: 'c1' }, { avatars: [], chatId: null })).toBe(false);
        expect(
            scopeMatches({ kind: 'card', avatar: 'mia.png' }, { avatars: ['kai.png', 'mia.png'], chatId: 'g' }),
        ).toBe(true);
    });

    it('scopes new definitions to the card, a group chat or everywhere', () => {
        expect(scopeForNew(here)).toEqual({ kind: 'card', avatar: 'kai.png' });
        expect(scopeForNew({ avatars: ['a', 'b'], chatId: 'g' })).toEqual({ kind: 'chat', chatId: 'g' });
        expect(scopeForNew({ avatars: [], chatId: null })).toEqual({ kind: 'global' });
    });
});

describe('descriptions', () => {
    it('describes attributes, checks and holders in English', () => {
        const value = def();
        expect(describeAttribute(value.attributes[0]!)).toBe('Mana (mana): number 0–100, starts at 50');
        expect(describeAttribute(value.attributes[1]!)).toBe('Schools (schools): any of fire, water, starts with fire');
        expect(
            describeAttribute({
                id: 'mood',
                name: 'Mood',
                promptName: '',
                kind: 'scale',
                levels: ['sad', 'glad'],
                initial: 'sad',
                events: [
                    { id: 'e', when: { op: '=', value: 'glad' }, text: '{holder} smiles.' },
                    { id: 'f', when: { op: 'changed' }, text: 'Moved.' },
                ],
            }),
        ).toBe('Mood (mood): scale sad < glad, starts at sad; at = glad: {holder} smiles.; on change: Moved.');
        const plain = { id: 'n', name: 'N', promptName: 'N' };
        expect(describeAttribute({ ...plain, kind: 'number', min: 1 })).toBe('N (n): number from 1');
        expect(describeAttribute({ ...plain, kind: 'number', max: 9 })).toBe('N (n): number up to 9');
        expect(describeAttribute({ ...plain, kind: 'number' })).toBe('N (n): number');
        expect(describeAttribute({ ...plain, kind: 'list', options: ['a'] })).toBe('N (n): one of a');
        expect(describeAttribute({ ...plain, kind: 'text' })).toBe('N (n): free text');
        expect(describeCheck(value.checks[0]!)).toBe('Spellcasting (spell): 1d100<=@mana');
        expect(describeCheck({ ...value.checks[0]!, dice: '1d20 + 2', difficulty: 12 })).toBe(
            'Spellcasting (spell): 1d20+2 vs 12',
        );
        expect(describeCheck({ ...value.checks[0]!, dice: 'bad', difficulty: null })).toBe('Spellcasting (spell): bad');
        expect(describeHolders({ kind: 'persona' })).toBe("the user's character");
        expect(describeHolders({ kind: 'characters' })).toBe('every character');
        expect(describeHolders({ kind: 'characters', includePersona: true })).toContain("user's");
        expect(describeHolders({ kind: 'named', names: ['Kai', 'Mia'] })).toBe('Kai, Mia');
        expect(describeHolders({ kind: 'named', names: [] })).toBe('named characters');
        expect(describeHolders({ kind: 'world' })).toBe('the world');
        expect(describeHolders({ kind: 'factions', names: ['Guild'] })).toBe('factions: Guild');
        expect(describeHolders({ kind: 'factions', names: [] })).toBe('factions');
        expect(mechanicLimits(def())).toBe(
            [
                "Holders: every character and the user's character",
                'Attributes:',
                '- Mana (mana): number 0–100, starts at 50',
                '- Schools (schools): any of fire, water, starts with fire',
                'Checks:',
                '- Spellcasting (spell): 1d100<=@mana',
            ].join('\n'),
        );
        expect(mechanicLimits(def({ attributes: [], checks: [] }))).toBe(
            "Holders: every character and the user's character",
        );
    });
});

describe('lorebook entry', () => {
    it('is a disabled typed entry with the definition in extensions.maestro.mechanic', () => {
        const value = { ...def(), book: 'Maestro · механики', uid: 9, updatedAt: 100 };
        const entry = defToEntry(value, 4);
        expect(entry).toMatchObject({
            uid: 4,
            comment: 'Магия',
            key: [],
            keysecondary: [],
            constant: false,
            disable: true,
            order: 100,
            position: 0,
        });
        const maestro = (entry.extensions as Dict).maestro as Dict;
        expect(maestro.type).toBe('mechanic');
        expect(maestro.mechanic).toEqual(storedDef(value));
        expect((maestro.mechanic as Dict).book).toBeUndefined();
        expect((maestro.mechanic as Dict).uid).toBeUndefined();
        expect(String(entry.content)).toBe(
            [
                'Mechanic: Магия',
                'Summary: Spellcasting powered by mana.',
                'Rules: Casting costs mana.',
                'Costs and limits:',
                mechanicLimits(value),
            ].join('\n'),
        );
        expect(readTypedMeta(maestro)?.fields.limits).toBe(mechanicLimits(value));
        expect(isMechanicEntry(entry)).toBe(true);
        expect(entryToDef(entry, 'Maestro · механики')).toEqual({ ...value, uid: 4 });
    });

    it("keeps unknown fields, keys, other extensions and the user's examples; never the world copy field", () => {
        const previous = {
            uid: 2,
            world: 'Book',
            key: ['magic'],
            keysecondary: ['mana'],
            comment: 'old',
            content: 'old',
            disable: false,
            constant: true,
            custom: { keep: true },
            extensions: {
                other: 1,
                maestro: { type: 'mechanic', typeFields: { examples: 'Kai casts a fireball.' }, passport: 'p1' },
            },
        };
        const entry = defToEntry(def(), 2, previous);
        expect(entry).toMatchObject({
            uid: 2,
            key: ['magic'],
            keysecondary: ['mana'],
            custom: { keep: true },
            disable: true,
            constant: false,
        });
        expect(entry.world).toBeUndefined();
        expect((entry.extensions as Dict).other).toBe(1);
        const maestro = (entry.extensions as Dict).maestro as Dict;
        expect(maestro.passport).toBe('p1');
        expect(String(entry.content)).toContain('Examples: Kai casts a fireball.');
        expect(
            defToEntry(def(), 2, { extensions: { maestro: { type: 'place', typeFields: { examples: 'x' } } } }).content,
        ).not.toContain('Examples');
    });

    it('reads user edits of the content back', () => {
        const entry = defToEntry(def(), 1);
        // ST's editor: the content changed, the typed fields did not.
        const edited = {
            ...entry,
            content: String(entry.content)
                .replace('Mechanic: Магия', 'Mechanic: Тёмная магия')
                .replace('Rules: Casting costs mana.', 'Rules: Casting costs blood.')
                .replace('Summary: Spellcasting powered by mana.\n', ''),
        };
        expect(entryToDef(edited, 'B')).toMatchObject({
            id: 'magic',
            name: 'Тёмная магия',
            summary: '',
            rules: 'Casting costs blood.',
            attributes: def().attributes,
        });
        // Free text without labels becomes the rules; the name stays.
        expect(entryToDef({ ...entry, content: 'Mana is life.\nUse it wisely.' })).toMatchObject({
            name: 'Магия',
            summary: 'Spellcasting powered by mana.',
            rules: 'Mana is life.\nUse it wisely.',
        });
        // An emptied content keeps the definition.
        expect(entryToDef({ ...entry, content: '' })).toMatchObject({ name: 'Магия', rules: 'Casting costs mana.' });
        // The Lore Studio's typed form: fields and content changed together.
        const maestro = (entry.extensions as Dict).maestro as Dict;
        const fields = { ...(maestro.typeFields as Record<string, string>), rules: 'Studio rules.' };
        const studio = {
            ...entry,
            content: composeContent({ type: 'mechanic', fields }),
            extensions: { maestro: { ...maestro, typeFields: fields } },
        };
        expect(entryToDef(studio)?.rules).toBe('Studio rules.');
        // Stored without typed fields at all: the content is parsed.
        const bare = {
            uid: 3,
            content: 'Mechanic: Bare\nRules: R.',
            extensions: { maestro: { mechanic: storedDef(def()) } },
        };
        expect(entryToDef(bare)).toMatchObject({ name: 'Bare', rules: 'R.', uid: 3 });
        expect(entryToDef(bare)?.book).toBeUndefined();
    });

    it('ignores entries that are not mechanics', () => {
        expect(entryToDef(null)).toBeNull();
        expect(entryToDef({ uid: 1, content: 'x' })).toBeNull();
        expect(entryToDef({ uid: 1, extensions: { maestro: { type: 'mechanic' } } })).toBeNull();
        expect(
            entryToDef({ uid: 1, extensions: { maestro: { type: 'place', mechanic: storedDef(def()) } } }),
        ).toBeNull();
        expect(entryToDef({ uid: 1, extensions: { maestro: { mechanic: { name: 'no id' } } } })).toBeNull();
        expect(mechanicJsonOf({ extensions: { maestro: 'x' } })).toBeNull();
        expect(isMechanicEntry({ extensions: {} })).toBe(false);
    });
});
