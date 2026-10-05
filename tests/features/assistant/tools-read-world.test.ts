// Read tools over the story world: dossier, relations, who knows what, places, calendar, wardrobe, scene passports.
import { describe, expect, it } from 'vitest';
import { readTools } from '../../../src/features/assistant/tools';
import type { Entity } from '../../../src/features/world/api';
import { fakeApp, msg, runTool, toolContext, userMsg } from './tools-helpers';
import type { Loose } from './tools-helpers';

const ANNA: Entity = {
    id: 'character:anna',
    kind: 'character',
    name: 'Anna',
    aliases: ['Аня', 'Анна'],
    forms: ['Анну', 'Анны'],
    present: true,
    sources: [
        { kind: 'card', ref: 'anna.png', label: 'Card Anna', avatar: 'anna.png' },
        { kind: 'lore.entry', ref: 'World#2', label: 'Anna', world: 'World', uid: 2 },
    ],
};
const KAI: Entity = { id: 'character:kai', kind: 'character', name: 'Kai', aliases: ['Кай'], forms: [], sources: [] };

const world = {
    resolve: (name: string) =>
        [ANNA, KAI].find((entity) => [entity.name, ...entity.aliases, ...entity.forms].includes(name)),
    entities: () => [ANNA, KAI],
    facts: (id: string) =>
        id === ANNA.id
            ? [{ entity: id, text: 'Anna cut her hair', source: ANNA.sources[1], confidence: 1, status: 'active' }]
            : [],
};

describe('dossier', () => {
    it('resolves a case form and joins the world model and the dossier', async () => {
        const fake = fakeApp({
            apis: {
                world,
                dossier: {
                    build: async () => ({
                        entityId: ANNA.id,
                        name: 'Anna',
                        kind: 'character',
                        builtAt: 1,
                        sections: [{ kind: 'lore', title: 'Lore', text: 'x'.repeat(1000), fields: { hair: 'short' } }],
                        findings: [{ kind: 'missingPassport', severity: 'warn', text: 'No NAI passport', sources: [] }],
                    }),
                },
            },
        });
        const output = await runTool(
            readTools(fake.app),
            'dossier',
            { name: 'Анну' },
            toolContext(fake, { locale: 'ru' }),
        );
        const data = output.data as Loose;
        expect(data.entity).toMatchObject({
            id: 'character:anna',
            name: 'Anna',
            present: true,
            forms: ['Анну', 'Анны'],
        });
        expect(data.entity.sources.items[1]).toEqual({ kind: 'lore.entry', label: 'Anna', book: 'World', uid: 2 });
        expect(data.sections[0].text.length).toBeLessThanOrEqual(400);
        expect(data.sections[0].fields).toEqual({ hair: 'short' });
        expect(data.findings).toEqual([{ kind: 'missingPassport', severity: 'warn', text: 'No NAI passport' }]);
        expect(data.facts).toEqual([{ text: 'Anna cut her hair', status: 'active' }]);
        expect(output.summary).toBe('Досье: Anna');
        expect(output.untrusted).toBe(true);
    });

    it('accepts a unique partial name and lists the known names otherwise', async () => {
        const fake = fakeApp({ apis: { world } });
        const tools = readTools(fake.app);
        const partial = await runTool(tools, 'dossier', { name: 'ka' }, toolContext(fake));
        expect((partial.data as Loose).entity.name).toBe('Kai');
        const missing = await runTool(tools, 'dossier', { name: 'Zed' }, toolContext(fake));
        expect(missing.data).toMatchObject({ known: ['Anna', 'Kai'] });
        expect(missing.summary).toBe('No entity named «Zed».');
    });
});

describe('relations', () => {
    const relation = {
        from: 'Anna',
        to: 'Ivan',
        current: 'Friendly',
        history: Array.from({ length: 9 }, (_, index) => ({
            messageIndex: index,
            status: index < 5 ? 'Cold' : 'Friendly',
            source: 'des' as const,
        })),
    };
    const relations = {
        all: () => [relation, { ...relation, from: 'Kai' }],
        of: (name: string) => (name === 'Anna' ? [relation] : []),
        between: (from: string, to: string) => (from === 'Anna' && to === 'Ivan' ? relation : undefined),
    };

    it('gives one character relations with recent history, between two, or all', async () => {
        const fake = fakeApp({ apis: { relations, world } });
        const tools = readTools(fake.app);
        const ctx = toolContext(fake);
        const of = await runTool(tools, 'relations', { name: 'Аня' }, ctx);
        const data = of.data as { relations: Loose[]; total: number };
        expect(data.total).toBe(1);
        expect(data.relations[0]!.history).toHaveLength(6);
        expect(data.relations[0]!.now).toBe('Friendly');
        const between = await runTool(tools, 'relations', { name: 'Anna', with: 'Ivan' }, ctx);
        expect((between.data as { total: number }).total).toBe(1);
        const all = await runTool(tools, 'relations', {}, toolContext(fake, { locale: 'ru' }));
        expect(all.summary).toBe('Отношения: 2');
    });
});

describe('knowledge_who', () => {
    const facts = [
        {
            id: 'f1',
            text: 'Anna is a spy for the Duke',
            topics: ['шпион', 'герцог'],
            knownBy: ['Anna'],
            secret: true,
            sourceMessage: 4,
            at: 1,
        },
        {
            id: 'f2',
            text: 'The mill burned down',
            topics: ['мельница'],
            knownBy: ['Anna', 'Kai'],
            secret: false,
            sourceMessage: 7,
            at: 2,
        },
    ];

    it('tells what a character knows and does not know about recent topics', async () => {
        const calls: string[] = [];
        const fake = fakeApp({
            chat: [userMsg('Кай, ты слышал про шпиона?'), msg('Нет.')],
            apis: {
                world,
                knowledge: {
                    facts: () => facts,
                    unknownFor: (character: string, recent: string) => {
                        calls.push(`${character}|${recent}`);
                        return [facts[0]];
                    },
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'knowledge_who', { name: 'Кай' }, toolContext(fake));
        const data = output.data as Loose;
        expect(data.character).toBe('Kai');
        expect(data.knows.items.map((fact: { id: string }) => fact.id)).toEqual(['f2']);
        expect(data.doesNotKnow.items[0]).toMatchObject({ id: 'f1', secret: true });
        expect(calls[0]).toBe('Kai|Кай, ты слышал про шпиона?\nНет.');
        expect(output.untrusted).toBe(true);
    });

    it('finds facts by words', async () => {
        const fake = fakeApp({ apis: { knowledge: { facts: () => facts, unknownFor: () => [] } } });
        const output = await runTool(
            readTools(fake.app),
            'knowledge_who',
            { fact: 'мельницы' },
            toolContext(fake, { locale: 'ru' }),
        );
        expect((output.data as Loose).facts.items.map((fact: { id: string }) => fact.id)).toEqual(['f2']);
        expect(output.summary).toBe('Кто знает: фактов 1');
    });
});

describe('places_current and calendar_now', () => {
    it('describes the current place with its path and last visit', async () => {
        const place = {
            id: 'p1',
            name: 'Tavern',
            aliases: ['Таверна'],
            forms: [],
            parent: 'p0',
            createdAt: 1,
            firstSeen: 1,
            lastSeen: 9,
            visits: [{ from: 1, to: null, present: ['Anna'], storyDate: 'Day 3', events: ['A fight broke out'] }],
            entry: { world: 'Maestro · канон', uid: 4 },
            state: { time: 'night' },
        };
        const fake = fakeApp({
            apis: {
                places: {
                    current: () => place,
                    list: () => [place, { ...place, id: 'p0', name: 'Town', lastSeen: 3 }],
                    candidates: () => [{ label: 'Old mill', seen: [5, 6] }],
                    path: () => ['Town', 'Tavern'],
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'places_current', {}, toolContext(fake, { locale: 'ru' }));
        const data = output.data as Loose;
        expect(data.current).toMatchObject({
            id: 'p1',
            path: ['Town', 'Tavern'],
            state: { time: 'night' },
            entry: 'Maestro · канон#4',
            lastVisit: { from: 1, to: null, present: ['Anna'], date: 'Day 3', events: ['A fight broke out'] },
            visits: 1,
        });
        expect(data.recent).toEqual([{ id: 'p0', name: 'Town', lastSeen: 3 }]);
        expect(data.candidates).toEqual([{ label: 'Old mill', seen: 2 }]);
        expect(output.summary).toBe('Место: Tavern');
        const none = fakeApp({ apis: { places: { current: () => null, list: () => [], candidates: () => [] } } });
        expect((await runTool(readTools(none.app), 'places_current', {}, toolContext(none))).summary).toBe(
            'No current place',
        );
    });

    it('gives story time and the open promises (all on request)', async () => {
        const promise = (id: string, status: string) => ({
            id,
            who: ['Anna'],
            toWhom: ['Ivan'],
            what: 'Meet at the mill',
            quote: '«Встретимся у мельницы»',
            due: { label: 'Day 4', day: 4 },
            status,
            sourceMessage: 3,
            createdAt: 1,
        });
        const fake = fakeApp({
            apis: {
                calendar: {
                    now: () => ({ label: 'Day 3', day: 3 }),
                    promises: () => [promise('a', 'open'), promise('b', 'done'), promise('c', 'overdue')],
                },
            },
        });
        const tools = readTools(fake.app);
        const open = await runTool(tools, 'calendar_now', {}, toolContext(fake));
        expect((open.data as Loose).promises.map((item: { id: string }) => item.id)).toEqual(['a', 'c']);
        expect(open.summary).toBe('Story time: Day 3; promises: 2');
        const all = await runTool(tools, 'calendar_now', { all: true }, toolContext(fake, { locale: 'ru' }));
        expect((all.data as Loose).total).toBe(3);
        expect(all.summary).toBe('Время истории: Day 3; обещаний: 3');
    });
});

describe('wardrobe and passports_scene', () => {
    it('lists the outfits of a character and the recent state changes', async () => {
        const asked: (string | undefined)[] = [];
        const fake = fakeApp({
            apis: {
                world,
                wardrobe: {
                    outfits: (character?: string) => {
                        asked.push(character);
                        return [
                            {
                                passportId: 'p',
                                character: 'Anna',
                                name: 'leather jacket',
                                tags: 'black leather jacket, torn jeans',
                                seenAs: ['кожаная куртка', 'куртка', 'жакет', 'пальто'],
                                firstSeen: 1,
                                lastSeen: 5,
                                active: true,
                            },
                        ];
                    },
                    changes: () => [
                        { kind: 'character', subject: 'Anna', state: 'wet', enabled: true, messageIndex: 5, at: 1 },
                    ],
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'wardrobe', { name: 'Аня' }, toolContext(fake));
        expect(asked).toEqual(['Anna']);
        const data = output.data as Loose;
        expect(data.outfits[0]).toMatchObject({ character: 'Anna', active: true });
        expect(data.outfits[0].seenAs).toHaveLength(3);
        expect(data.stateChanges).toEqual([{ kind: 'character', subject: 'Anna', state: 'wet', on: true, message: 5 }]);
        expect(output.summary).toBe('Wardrobe: 1 outfits');
    });

    it('lists the passports of the scene and what was sent', async () => {
        const fake = fakeApp({
            apis: {
                lorePassports: {
                    forScene: () => [
                        { world: 'World', uid: 2, name: 'Sword', passport: { kind: 'item', tags: ['silver sword'] } },
                        {
                            world: 'World',
                            uid: 3,
                            name: 'Mill',
                            passport: { kind: 'location', tags: 'old mill, river' },
                        },
                    ],
                    lastSent: () => ({ at: 1_760_000_000_000, messageIndex: 7, passports: [{}, {}] }),
                    generator: () => ({ kind: 'nai' }),
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'passports_scene', {}, toolContext(fake, { locale: 'ru' }));
        const data = output.data as Loose;
        expect(data.scene).toEqual([
            { book: 'World', uid: 2, name: 'Sword', kind: 'item', tags: '["silver sword"]' },
            { book: 'World', uid: 3, name: 'Mill', kind: 'location', tags: 'old mill, river' },
        ]);
        expect(data.lastSent).toMatchObject({ message: 7, count: 2 });
        expect(data.generator).toEqual({ kind: 'nai' });
        expect(output.summary).toBe('Паспорта сцены: 2');
    });
});
