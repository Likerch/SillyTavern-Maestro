// Edge cases of the preparation domain: fallbacks of names, kinds and values the main tests do not reach.
import { describe, expect, it } from 'vitest';
import type { MechanicDef } from '../../src/domain/mechanics-defs';
import {
    applyOrder,
    attributeValue,
    canonDraftOf,
    findAttribute,
    mechanicDefOf,
    selectItems,
} from '../../src/domain/prepare-apply';
import { buildPrepareMessages, neutralizeData, parsePrepareAnswer } from '../../src/domain/prepare-extract';
import { emptySnapshot, markExisting, mergeData, mergeItems, sameItem } from '../../src/domain/prepare-merge';
import { emptyData, isEmptyData, itemIdOf, itemTitle, uniqueNames } from '../../src/domain/prepare-plan';
import type { AnyPrepareItem, MechanicData, PrepareDataMap, PrepareKind } from '../../src/domain/prepare-plan';
import { bookSources, cardSources, greetingText } from '../../src/domain/prepare-sources';

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

function mechanic(data: Partial<MechanicData>): MechanicData {
    return { ...emptyData('mechanic'), ...data };
}

describe('prepare edges: names and titles', () => {
    it('falls back between names and texts', () => {
        expect(itemTitle(item('mechanic', { english: 'Trust' }))).toBe('Trust');
        expect(itemTitle(item('secret', { text: 'A secret.' }))).toBe('A secret.');
        expect(itemTitle(item('secret', { text: 'A secret.', about: 'Вера' }))).toBe('Вера');
        expect(itemTitle(item('promise', { what: 'Pay.' }))).toBe('Pay.');
        expect(itemTitle(item('scene', { place: 'Таверна' }))).toBe('Таверна');
        expect(itemTitle(item('direction', { genre: 'Mystery' }))).toBe('Mystery');
        expect(itemTitle(item('world', { english: 'Velmar' }))).toBe('Velmar');
        expect(itemIdOf('mechanic', mechanic({ template: 'money' }))).toBe('mechanic:money');
        expect(uniqueNames(['a', 'A', ' ', 5, 'ё', 'е'])).toEqual(['a', 'ё']);
        expect(isEmptyData(emptyData('scene'))).toBe(true);
        expect(isEmptyData({ ...emptyData('scene'), present: ['Вера'] })).toBe(false);
    });

    it('builds sources from sparse cards and books', () => {
        const sources = cardSources(
            {
                name: 'X',
                description: '',
                personality: '',
                scenario: '',
                firstMessage: '',
                alternateGreetings: ['Second.'],
                examples: '',
                creatorNotes: '',
                systemPrompt: '',
                postHistory: '',
                depthPrompt: '',
                greeting: 0,
            },
            { name: '', description: 'Only a description.' },
        );
        expect(sources.map((source) => [source.id, source.text])).toEqual([
            ['persona', 'Only a description.'],
            ['greeting:1', 'Second.'],
        ]);
        expect(greetingText({ firstMessage: 'First', alternateGreetings: [] }, 1)).toBe('First');
        const book = bookSources('B', [{ uid: 3, title: '', keys: [], content: 'Text.' }], 'chat', 100);
        expect(book[0]).toMatchObject({ label: 'B · #3', text: 'Text.', origin: 'chat' });
    });
});

describe('prepare edges: the reader and the request', () => {
    it('reads mechanics, named sections and promises with every fallback', () => {
        const parsed = parsePrepareAnswer(
            {
                characters: 'none',
                places: [{ name: 'Гавань', forms: 'Гавани' }],
                factions: [{ english: 'House Arden' }, { name: '' }],
                items: [{ name: 'Карта' }],
                traditions: [{ name: 'Праздник', when: 'Autumn' }],
                promises: [{ what: '' }, { what: 'Pay fifty crowns.', who: ['Элизабет'], due: 'Friday' }],
                secrets: 'none',
                mechanics: [
                    { template: 'money' },
                    { english: 'Trust', attributes: [{ english: 'Trust Level' }, { name: '' }] },
                    { name: '' },
                ],
                world: 'none',
                time: { date: '', time: '', calendar: '' },
                scenes: [{ greeting: 0, place: 'Таверна', present: ['Вера'], outfits: 'none' }, 'junk'],
                direction: { firstScene: 'drama' },
            },
            { refs: new Map([['S1', 'greeting:0']]) },
        );
        const items = parsed!.items;
        const byKind = (kind: string) => items.filter((row) => row.kind === kind);
        const place = byKind('place')[0]!;
        expect(place.kind === 'place' && place.data.forms).toEqual([]);
        expect(byKind('faction').map((row) => itemTitle(row))).toEqual(['House Arden']);
        expect(byKind('item')).toHaveLength(1);
        expect(byKind('tradition')).toHaveLength(1);
        expect(byKind('promise').map((row) => row.kind === 'promise' && row.data.due)).toEqual(['Friday']);
        const mechanics = byKind('mechanic');
        expect(mechanics.map((row) => row.kind === 'mechanic' && [row.data.name, row.data.english])).toEqual([
            ['money', ''],
            ['Trust', 'Trust'],
        ]);
        const trust = mechanics[1]!;
        expect(trust.kind === 'mechanic' && trust.data.attributes.map((row) => [row.name, row.english])).toEqual([
            ['Trust Level', 'Trust Level'],
        ]);
        expect(byKind('scene')[0]).toMatchObject({ id: 'scene:0', sources: ['greeting:0'] });
        const direction = byKind('direction')[0]!;
        expect(direction.kind === 'direction' && direction.data.firstScene).toBe('drama');
        expect(byKind('time')).toEqual([]);
        expect(parsed!.rejected.map((row) => row.kind).sort()).toEqual(['faction', 'mechanic', 'promise']);
    });

    it('lists long known names with a count and works without templates', () => {
        const names = Array.from({ length: 85 }, (_, index) => `N${index}`);
        const user = buildPrepareMessages({
            cardName: 'X',
            personaName: ' ',
            known: { canon: names, places: [], passports: ['Вера'] },
            templates: [],
            mechanics: [{ id: 'm', name: 'M', attributes: [] }],
            part: { index: 0, total: 1, core: true },
            sources: [],
        })[1]!.content;
        expect(user).toContain('(+5)');
        expect(user).toContain("The player's character: {{user}}.");
        expect(user).toContain('Visual passports: Вера');
        expect(user).toContain('m — M\n');
        expect(user).not.toContain('<templates>');
        expect(neutralizeData(undefined as unknown as string)).toBe('');
    });
});

describe('prepare edges: merging and what exists', () => {
    it('merges numbers, lists of attributes and the scope', () => {
        const a = mechanic({
            attributes: [
                {
                    ...emptyData('mechanic').attributes[0]!,
                    name: 'A',
                    english: '',
                    kind: 'number',
                    min: null,
                    max: null,
                    initial: '',
                    levels: [],
                    options: [],
                },
            ],
        });
        const b = mechanic({
            attributes: [
                { name: 'a', english: '', kind: 'number', min: 1, max: 5, initial: '', levels: [], options: [] },
            ],
        });
        expect(mergeData('mechanic', a, b).attributes).toHaveLength(1);
        const left = { ...a, attributes: [{ ...a.attributes[0]!, min: null }] };
        expect(mergeData('mechanic', left, b).attributes[0]!.min).toBeNull();
        const merged = mergeItems([
            [item('promise', { what: 'Pay.' })],
            [item('promise', { what: 'pay.' }, { russian: 'Заплатить вовремя за работу.', scope: 'character' })],
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({ russian: 'Заплатить вовремя за работу.', scope: 'character' });
        expect(sameItem(item('time', { date: '1' }), item('time', { date: '2' }))).toBe(true);
        expect(sameItem(item('secret', { text: 'a' }), item('promise', { what: 'a' }))).toBe(false);
        expect(sameItem(item('scene', { place: 'a' }), item('direction', { genre: 'a' }))).toBe(false);
    });

    it('marks the persona by name and mechanics by their English name', () => {
        const marked = markExisting(
            [
                item('character', { name: 'Кай' }),
                item('mechanic', { english: 'Wealth' }),
                item('world', { setting: 'x' }),
            ],
            {
                ...emptySnapshot(),
                personaName: 'Кай',
                mechanics: [{ id: 'gold', name: 'Золото', promptName: 'Wealth' }],
            },
        );
        expect(marked[0]!.exists).toEqual({ where: 'persona', label: 'Кай' });
        expect(marked[1]!.links).toEqual({ mechanicId: 'gold' });
        expect(marked[2]!.exists).toBeUndefined();
        const persona = markExisting([item('character', { name: 'Игрок', persona: true })], emptySnapshot());
        expect(persona[0]!.exists).toEqual({ where: 'persona', label: 'Игрок' });
    });
});

describe('prepare edges: apply builders', () => {
    it('orders places with a loop and keeps a saved item for the character', () => {
        const a = item('place', { name: 'A', parent: 'B' });
        const b = item('place', { name: 'B', parent: 'A' });
        expect(applyOrder([a, b]).map((row) => itemTitle(row))).toEqual(['A', 'B']);
        const saved = item('secret', { text: 'S' }, { scope: 'character' });
        expect(selectItems([saved], [{ id: saved.id }], 'chat')[0]!.scope).toBe('character');
    });

    it('drafts entries with only one of the names', () => {
        expect(canonDraftOf(item('character', { english: 'Vera' }))!.title).toBe('Vera');
        expect(canonDraftOf(item('place', { name: 'Форт' }))!.content).toBe('Place: Форт');
        expect(canonDraftOf(item('faction', { name: 'Дом' }))!.content).toBe('Faction: Дом');
        expect(canonDraftOf(item('item', { name: 'Карта', english: 'Map', owner: 'Вера' }))!.content).toBe(
            'Item: Map\nAliases: Карта\nOwner: Вера',
        );
        expect(canonDraftOf(item('world', { era: 'Sail' }))!.title).toBe('World');
        expect(canonDraftOf(item('time', {}))).toBeNull();
        expect(canonDraftOf(item('time', { calendar: 'Moons.' }))!.content).toBe(
            'Note: Story calendar\nText: Calendar: Moons.',
        );
    });

    it('makes holders and attributes of every kind', () => {
        const scope = { kind: 'chat' as const, chatId: 'c' };
        const row = (patch: Partial<MechanicData['attributes'][number]>) => ({
            name: 'A',
            english: '',
            kind: 'number' as const,
            min: null,
            max: null,
            initial: '',
            levels: [],
            options: [],
            ...patch,
        });
        const holders = (kind: MechanicData['holders']) =>
            mechanicDefOf(mechanic({ name: 'M', holders: kind, holderNames: ['Arden'] }), null, scope, []).holders;
        expect(holders('persona')).toEqual({ kind: 'persona' });
        expect(holders('world')).toEqual({ kind: 'world' });
        expect(holders('factions')).toEqual({ kind: 'factions', names: ['Arden'] });
        expect(holders('characters')).toEqual({ kind: 'characters', includePersona: true });
        const def = mechanicDefOf(
            mechanic({
                english: 'Magic',
                attributes: [
                    row({ name: 'Школы', kind: 'list', options: ['fire', 'ice'], initial: 'fire' }),
                    row({ name: 'Заметка', kind: 'text', initial: 'calm' }),
                    row({ name: 'Сила', initial: 'lots' }),
                    row({ name: 'Ранг', kind: 'scale', levels: ['low', 'high'] }),
                ],
            }),
            null,
            scope,
            [],
        );
        expect(def.name).toBe('Magic');
        expect(def.attributes.map((attribute) => [attribute.id, attribute.initial ?? null])).toEqual([
            ['shkoly', ['fire']],
            ['zametka', 'calm'],
            ['sila', null],
            ['rang', null],
        ]);
        const base: MechanicDef = { ...def, name: 'Base', promptName: 'Base' };
        const kept = mechanicDefOf(mechanic({}), base, scope, []);
        expect([kept.name, kept.promptName, kept.summary]).toEqual(['Base', 'Base', '']);
        expect(findAttribute(def, '')).toBeUndefined();
    });

    it('reads values against bounds, levels and options', () => {
        const number = { id: 'n', name: 'N', promptName: 'N', kind: 'number' as const, min: 5 };
        expect(attributeValue(number, '-3')).toBe(5);
        expect(attributeValue({ id: 's', name: 'S', promptName: 'S', kind: 'scale' }, 'high')).toBeNull();
        expect(attributeValue({ id: 'l', name: 'L', promptName: 'L', kind: 'list' }, 'fire')).toBeNull();
        expect(
            attributeValue(
                { id: 'l', name: 'L', promptName: 'L', kind: 'list', options: ['fire', 'ice'] },
                'ice, fire',
            ),
        ).toEqual(['ice']);
    });
});
