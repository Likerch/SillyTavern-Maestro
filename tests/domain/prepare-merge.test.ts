import { describe, expect, it } from 'vitest';
import {
    canonMatch,
    disagrees,
    emptySnapshot,
    joinText,
    markExisting,
    mergeItems,
    reusePlan,
    sameItem,
} from '../../src/domain/prepare-merge';
import { emptyData, itemIdOf } from '../../src/domain/prepare-plan';
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

describe('prepare merge: one plan from the parts', () => {
    it('merges the same character found in two parts', () => {
        const first = item(
            'character',
            {
                name: 'Элизабет',
                english: 'Elizabeth',
                appearance: 'Dark green cloak.',
                relations: [{ to: 'Кай', relation: 'Hires him.' }],
            },
            { sources: ['card.description'], russian: 'Наследница дома Арден.' },
        );
        const second = item(
            'character',
            {
                name: 'Elizabeth',
                english: 'Elizabeth',
                forms: ['Лиз'],
                appearance: 'Proud heiress with grey eyes.',
                present: true,
                relations: [
                    { to: 'кай', relation: 'Pays well.' },
                    { to: 'Вера', relation: 'Does not trust her.' },
                ],
            },
            { sources: ['book:World#1'] },
        );
        const merged = mergeItems([[first], [second]]);
        expect(merged).toHaveLength(1);
        const one = merged[0]!;
        if (one.kind !== 'character') throw new Error('character expected');
        expect(one.data.name).toBe('Элизабет');
        expect(one.data.forms).toEqual(['Лиз']);
        expect(one.data.appearance).toBe('Dark green cloak. Proud heiress with grey eyes.');
        expect(one.data.present).toBe(true);
        expect(one.data.relations).toEqual([
            { to: 'Кай', relation: 'Hires him. Pays well.' },
            { to: 'Вера', relation: 'Does not trust her.' },
        ]);
        expect(one.sources).toEqual(['card.description', 'book:World#1']);
        expect(one.russian).toBe('Наследница дома Арден.');
    });

    it('keeps namesakes apart and puts sections in plan order', () => {
        const alexander = item('character', { name: 'Александр', forms: ['Александра'] });
        const alexandra = item('character', { name: 'Александра' });
        const harbour = item('place', { name: 'Гавань' });
        const world = item('world', { setting: 'North.' });
        const world2 = item('world', { setting: 'Cold coast.', era: 'Sail' });
        const merged = mergeItems([
            [alexander, harbour, world],
            [alexandra, world2],
        ]);
        expect(merged.map((row) => row.kind)).toEqual(['world', 'place', 'character', 'character']);
        expect(sameItem(alexander, alexandra)).toBe(false);
        const worldItem = merged[0]!;
        expect(worldItem.kind === 'world' && worldItem.data.setting).toBe('North. Cold coast.');
        expect(worldItem.kind === 'world' && worldItem.data.era).toBe('Sail');
    });

    it('merges mechanics by template and secrets by text', () => {
        const a = item('mechanic', {
            name: 'Деньги',
            template: 'money',
            initial: [{ holder: 'Кай', attribute: 'Gold', value: '5' }],
        });
        const b = item('mechanic', {
            name: 'Money',
            english: 'Money',
            template: 'money',
            initial: [{ holder: 'кай', attribute: 'gold', value: '9' }],
        });
        const s1 = item('secret', { text: 'Vera is a spy.' });
        const s2 = item('secret', { text: 'vera is a spy.', knownBy: ['Вера'] });
        const merged = mergeItems([
            [a, s1],
            [b, s2],
        ]);
        expect(merged).toHaveLength(2);
        const mechanic = merged.find((row) => row.kind === 'mechanic')!;
        expect(mechanic.kind === 'mechanic' && mechanic.data.initial).toEqual([
            { holder: 'Кай', attribute: 'Gold', value: '5' },
        ]);
        const secret = merged.find((row) => row.kind === 'secret')!;
        expect(secret.kind === 'secret' && secret.data.knownBy).toEqual(['Вера']);
    });

    it('joins texts without repeating them', () => {
        expect(joinText('A port.', 'a port')).toBe('A port.');
        expect(joinText('Old', 'Old fort by the sea')).toBe('Old fort by the sea');
        expect(joinText('', 'B')).toBe('B');
        expect(joinText('One', 'Two', 6)).toBe('One.…');
    });
});

describe('prepare merge: what exists', () => {
    const snapshot = {
        ...emptySnapshot(),
        personaName: 'Кай',
        canon: [
            {
                uid: 4,
                type: 'character',
                title: 'Vera',
                keys: ['Vera', 'Вера'],
                content: 'Character: Vera\nRole: Innkeeper of the docks tavern\nAppearance: Short, red hair.',
            },
            { uid: 5, title: 'Fort', keys: ['Старый форт'], content: 'An old fort.' },
        ],
        places: [{ id: 'p1', name: 'Серебряная Гавань', aliases: ['Silver Harbor'], forms: ['Гавани'] }],
        mechanics: [{ id: 'money', name: 'Деньги', template: 'money' }],
        passports: [{ id: 'np1', name: 'Элизабет', aliases: ['Elizabeth'] }],
        promises: ['Pay fifty crowns on delivery.'],
        secrets: ['Vera is a spy.'],
    };

    it('marks the canon, the persona, places, mechanics, passports, promises and secrets', () => {
        const items = markExisting(
            [
                item('character', {
                    name: 'Вера',
                    english: 'Vera',
                    role: 'Captain of the harbour watch',
                    appearance: 'Short, red hair.',
                }),
                item('character', { name: 'Кай' }),
                item('character', { name: 'Элизабет' }),
                item('place', { name: 'Гавань', english: 'Silver Harbor' }),
                item('place', { name: 'Старый форт' }),
                item('mechanic', { name: 'Золото', template: 'money' }),
                item('promise', { what: 'pay fifty crowns on delivery.' }),
                item('secret', { text: 'Vera is a spy.' }),
                item('faction', { name: 'Дом Арден' }),
            ],
            snapshot,
        );
        const [vera, kai, elizabeth, harbour, fort, money, promise, secret, house] = items;
        expect(vera!.exists).toEqual({ where: 'canon', label: 'Vera', ref: 4 });
        expect(vera!.links).toEqual({ canonUid: 4 });
        expect(vera!.conflicts).toEqual([
            {
                field: 'role',
                with: 'Vera',
                existing: 'Innkeeper of the docks tavern',
                proposed: 'Captain of the harbour watch',
            },
        ]);
        expect(kai!.exists?.where).toBe('persona');
        expect(kai!.kind === 'character' && kai!.data.persona).toBe(true);
        expect(elizabeth!.exists).toBeUndefined();
        expect(elizabeth!.links).toEqual({ passportId: 'np1' });
        expect(harbour!.exists).toEqual({ where: 'places', label: 'Серебряная Гавань', ref: 'p1' });
        expect(fort!.exists).toEqual({ where: 'canon', label: 'Fort', ref: 5 });
        expect(fort!.conflicts).toBeUndefined();
        expect(money!.exists?.where).toBe('mechanics');
        expect(money!.links).toEqual({ mechanicId: 'money' });
        expect(promise!.exists?.where).toBe('calendar');
        expect(secret!.exists?.where).toBe('knowledge');
        expect(house!.exists).toBeUndefined();
        expect(house!.links).toBeUndefined();
    });

    it('finds the canon entry of the item type first and compares only typed entries', () => {
        const vera = item('character', { name: 'Вера' });
        expect(canonMatch(vera, [{ uid: 1, type: 'place', title: 'Вера', keys: [], content: '' }])).toBeUndefined();
        expect(canonMatch(vera, [{ uid: 2, title: 'x', keys: ['вера'], content: '' }])?.uid).toBe(2);
        expect(disagrees('Tall man with a scar', 'Short woman, red hair, freckles')).toBe(true);
        expect(disagrees('Tall man with a scar and grey eyes', 'Tall man, a scar across the cheek')).toBe(false);
        expect(disagrees('Arden', 'Ardens')).toBe(false);
        expect(disagrees('', 'Anything')).toBe(false);
    });
});

describe('prepare merge: the saved preparation', () => {
    it('keeps untouched items and reads again what a change touches', () => {
        const saved = [
            item('character', { name: 'Вера' }, { sources: ['card.description'] }),
            item('place', { name: 'Форт' }, { sources: ['book:W#1', 'card.description'] }),
            item('place', { name: 'Топи' }, { sources: ['book:W#2', 'book:W#4'] }),
            item('item', { name: 'Карта' }, { sources: ['book:W#3'] }),
        ];
        const diff = { changed: ['book:W#2'], added: ['book:W#5'], removed: ['book:W#3'] };
        const current = ['card.description', 'book:W#1', 'book:W#2', 'book:W#4', 'book:W#5'];
        const plan = reusePlan(saved, diff, current);
        expect(plan.kept.map((row) => row.id)).toEqual(['character:вера', 'place:форт']);
        expect(plan.kept.every((row) => row.saved)).toBe(true);
        expect(plan.reread).toEqual(['book:W#2', 'book:W#4', 'book:W#5']);
    });
});
