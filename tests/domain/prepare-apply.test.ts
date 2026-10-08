import { describe, expect, it } from 'vitest';
import type { MechanicDef } from '../../src/domain/mechanics-defs';
import {
    applyOrder,
    attributeValue,
    canonDraftOf,
    findAttribute,
    mechanicDefOf,
    missingForPlay,
    selectItems,
    startingValues,
} from '../../src/domain/prepare-apply';
import { emptyData, itemIdOf, itemNames, itemTitle, sectionCounts } from '../../src/domain/prepare-plan';
import type { AnyPrepareItem, PrepareDataMap, PrepareKind } from '../../src/domain/prepare-plan';

function item<K extends PrepareKind>(
    kind: K,
    data: Partial<PrepareDataMap[K]>,
    extra: Partial<AnyPrepareItem> = {},
): AnyPrepareItem {
    const full = { ...emptyData(kind), ...data } as PrepareDataMap[K];
    return {
        id: itemIdOf(kind, full),
        kind,
        data: full,
        russian: '',
        sources: [],
        scope: 'chat',
        ...extra,
    } as AnyPrepareItem;
}

describe('prepare apply: order and selection', () => {
    it('writes sections in plan order and places from the top down', () => {
        const items = [
            item('character', { name: 'Вера' }),
            item('place', { name: 'Таверна', parent: 'Квартал' }),
            item('place', { name: 'Квартал', parent: 'Гавань' }),
            item('world', { setting: 'North' }),
            item('place', { name: 'Гавань' }),
            item('mechanic', { name: 'Доверие' }),
        ];
        expect(applyOrder(items).map((row) => itemTitle(row))).toEqual([
            '',
            'Гавань',
            'Квартал',
            'Таверна',
            'Вера',
            'Доверие',
        ]);
    });

    it("takes everything new for 'all' and the chosen rows with their scope and edits", () => {
        const vera = item('character', { name: 'Вера', role: 'Captain' });
        const kai = item('character', { name: 'Кай', persona: true }, { exists: { where: 'persona', label: 'Кай' } });
        const fort = item('place', { name: 'Форт' }, { exists: { where: 'canon', label: 'Fort', ref: 1 } });
        const money = item(
            'mechanic',
            { name: 'Деньги', initial: [{ holder: 'Кай', attribute: 'Gold', value: '5' }] },
            { exists: { where: 'mechanics', label: 'Деньги', ref: 'money' } },
        );
        const saved = item('secret', { text: 'A secret.' }, { scope: 'character', saved: true });
        const all = selectItems([vera, kai, fort, money, saved], 'all', 'chat');
        expect(all.map((row) => [row.id, row.scope])).toEqual([
            ['character:вера', 'chat'],
            [saved.id, 'character'],
            ['mechanic:деньги', 'chat'],
        ]);
        const rows = selectItems(
            [vera, fort],
            [
                { id: fort.id, scope: 'character' },
                { id: vera.id, data: { role: 'Harbour captain', present: 'yes', unknown: 1 } },
                { id: 'missing' },
                { id: vera.id, scope: 'character' },
            ],
            'chat',
        );
        expect(rows.map((row) => [row.id, row.scope])).toEqual([
            ['place:форт', 'character'],
            ['character:вера', 'chat'],
        ]);
        const edited = rows[1]!;
        expect(edited.kind === 'character' && edited.data.role).toBe('Harbour captain');
        expect(edited.kind === 'character' && edited.data.present).toBe(false);
        expect(vera.kind === 'character' && vera.data.role).toBe('Captain');
    });
});

describe('prepare apply: canon entries', () => {
    it('makes typed English entries with Russian keys', () => {
        const vera = canonDraftOf(
            item('character', {
                name: 'Вера',
                english: 'Vera',
                forms: ['Веры', 'Веру'],
                role: 'Captain of the watch.',
                speech: 'Dry, short.',
                relations: [{ to: 'Кай', relation: 'Distrusts him.' }],
            }),
        );
        expect(vera).toMatchObject({ type: 'character', title: 'Vera', keys: ['Вера', 'Vera', 'Веры', 'Веру'] });
        expect(vera!.content).toBe(
            'Character: Vera\nAliases: Вера\nRole: Captain of the watch.\nRelationships: Кай: Distrusts him.\nSpeech: Dry, short.',
        );
        expect(canonDraftOf(item('character', { name: 'Кай', persona: true }))).toBeNull();
        const place = canonDraftOf(item('place', { name: 'Таверна', parent: 'Гавань', state: 'Closed.' }));
        expect(place!.content).toBe('Place: Таверна\nLocation: Гавань\nAtmosphere: At the start of the story: Closed.');
        expect(canonDraftOf(item('faction', { name: 'Дом', english: 'House', leader: 'Ada' }))!.content).toBe(
            'Faction: House\nAliases: Дом\nLeader: Ada',
        );
        expect(canonDraftOf(item('item', { name: 'Карта', description: 'Old map.' }))!.type).toBe('item');
        expect(canonDraftOf(item('tradition', { name: 'Праздник', practice: 'Lanterns.' }))!.type).toBe('tradition');
        const world = canonDraftOf(item('world', { name: 'Вельмар', english: 'Velmar', laws: 'No magic.' }));
        expect(world).toMatchObject({ type: 'note', title: 'Velmar' });
        expect(world!.content).toBe('Note: Velmar\nText: Laws of the world: No magic.');
        expect(canonDraftOf(item('world', { name: 'Пусто' }))).toBeNull();
        const time = canonDraftOf(item('time', { date: '12 Зимня', time: 'вечер', calendar: 'Twelve moons.' }));
        expect(time!.content).toBe(
            'Note: Story calendar\nText:\nThe story starts: 12 Зимня, вечер\nCalendar: Twelve moons.',
        );
        // With starting scenes each scene writes its own «Story start»: the calendar note keeps the calendar only.
        const withScenes = { date: '12 Зимня', time: 'вечер', calendar: 'Twelve moons.' };
        expect(canonDraftOf(item('time', withScenes), { scenes: true })!.content).toBe(
            'Note: Story calendar\nText: Calendar: Twelve moons.',
        );
        expect(canonDraftOf(item('time', { date: '12 Зимня', time: 'вечер' }), { scenes: true })).toBeNull();
        expect(canonDraftOf(item('secret', { text: 'x' }))).toBeNull();
    });
});

describe('prepare apply: mechanics', () => {
    const data = {
        ...emptyData('mechanic'),
        name: 'Доверие',
        english: 'Trust',
        summary: 'Trust of the people.',
        holders: 'named' as const,
        holderNames: ['Вера'],
        attributes: [
            {
                name: 'Доверие',
                english: 'Trust',
                kind: 'number' as const,
                min: 0,
                max: 100,
                initial: '50',
                levels: [],
                options: [],
            },
            {
                name: 'Отношение',
                english: 'Attitude',
                kind: 'scale' as const,
                min: null,
                max: null,
                initial: 'cold',
                levels: ['cold', 'warm'],
                options: [],
            },
        ],
        initial: [
            { holder: 'Вера', attribute: 'trust', value: '140' },
            { holder: 'Вера', attribute: 'Отношение', value: 'Warm' },
            { holder: 'Вера', attribute: 'Unknown', value: '1' },
            { holder: 'Вера', attribute: 'Attitude', value: 'hot' },
        ],
    };

    it('makes a new definition from the item', () => {
        const def = mechanicDefOf(data, null, { kind: 'chat', chatId: 'c1' }, ['trust']);
        expect(def.id).toBe('trust_2');
        expect(def).toMatchObject({
            name: 'Доверие',
            promptName: 'Trust',
            holders: { kind: 'named', names: ['Вера'] },
        });
        expect(def.attributes.map((attribute) => [attribute.id, attribute.kind, attribute.initial])).toEqual([
            ['trust', 'number', 50],
            ['attitude', 'scale', 'cold'],
        ]);
        const values = startingValues(data, def);
        expect(values.values).toEqual([
            { holder: 'Вера', attribute: 'trust', value: 100 },
            { holder: 'Вера', attribute: 'attitude', value: 'warm' },
        ]);
        expect(values.dropped).toBe(2);
    });

    it('lays the item over a template definition', () => {
        const base: MechanicDef = {
            id: 'money',
            name: 'Деньги',
            summary: 'Coins.',
            rules: 'Spend wisely.',
            attributes: [{ id: 'gold', name: 'Золото', promptName: 'Gold', kind: 'number', min: 0 }],
            holders: { kind: 'persona' },
            checks: [],
            tracking: 'background',
            scope: { kind: 'global' },
        };
        const def = mechanicDefOf(
            {
                ...data,
                name: 'Кошелёк',
                english: '',
                rules: 'Debts count.',
                attributes: [...data.attributes, { ...data.attributes[0]!, name: 'Gold', english: 'Gold' }],
            },
            base,
            { kind: 'card', avatar: 'a.png' },
            [],
        );
        expect(def.id).toBe('money');
        expect(def.name).toBe('Кошелёк');
        expect(def.rules).toBe('Spend wisely.\nDebts count.');
        expect(def.scope).toEqual({ kind: 'card', avatar: 'a.png' });
        expect(def.attributes.map((attribute) => attribute.id)).toEqual(['gold', 'trust', 'attitude']);
        expect(base.attributes).toHaveLength(1);
        expect(findAttribute(def, 'золото')?.id).toBe('gold');
    });

    it('reads starting values for every attribute kind', () => {
        expect(attributeValue({ id: 'a', name: 'A', promptName: 'A', kind: 'number', max: 10 }, '~15,5 coins')).toBe(
            10,
        );
        expect(attributeValue({ id: 'a', name: 'A', promptName: 'A', kind: 'number' }, 'many')).toBeNull();
        expect(
            attributeValue(
                { id: 'a', name: 'A', promptName: 'A', kind: 'list', options: ['fire', 'ice'], multi: true },
                'Fire, ice, mud',
            ),
        ).toEqual(['fire', 'ice']);
        expect(
            attributeValue({ id: 'a', name: 'A', promptName: 'A', kind: 'list', options: ['fire'] }, 'mud'),
        ).toBeNull();
        expect(attributeValue({ id: 'a', name: 'A', promptName: 'A', kind: 'text' }, ' calm ')).toBe('calm');
        expect(attributeValue({ id: 'a', name: 'A', promptName: 'A', kind: 'text' }, ' ')).toBeNull();
    });
});

describe('prepare apply: «Готово к игре»', () => {
    it('lists passports, portraits, places and backgrounds that are missing', () => {
        expect(
            missingForPlay({
                applied: false,
                characters: [
                    { name: 'Вера', present: true, passport: false, portrait: false },
                    { name: 'Томас', present: false, passport: true, portrait: false },
                ],
                places: [
                    { name: 'Таверна', registered: true, background: false },
                    { name: 'Форт', registered: false, background: false },
                    { name: 'Гавань', registered: true, background: true },
                ],
            }),
        ).toEqual([
            { kind: 'plan', name: '' },
            { kind: 'passport', name: 'Вера' },
            { kind: 'portrait', name: 'Вера' },
            { kind: 'background', name: 'Таверна' },
            { kind: 'place', name: 'Форт' },
        ]);
    });
});

describe('prepare plan helpers', () => {
    it('names and counts items', () => {
        const items = [
            item('character', { name: 'Вера', english: 'Vera', forms: ['веры', 'Вера'] }),
            item('time', { date: 'День 1', time: 'вечер' }),
        ];
        expect(itemNames(items[0]!)).toEqual(['Вера', 'Vera', 'веры']);
        expect(itemTitle(items[1]!)).toBe('День 1, вечер');
        expect(sectionCounts(items)).toEqual({ character: 1, time: 1 });
        expect(itemIdOf('promise', { ...emptyData('promise'), what: 'Pay.' })).toMatch(/^promise:[0-9a-z]+$/);
    });
});
