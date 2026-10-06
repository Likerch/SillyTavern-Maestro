import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairKey } from '../../../src/domain/world-names';
import { worldModule } from '../../../src/features/world';
import type { WorldModelApi } from '../../../src/features/world/api';
import type { Dict, WorldEnv } from './helpers';
import {
    addCard,
    createWorldEnv,
    emitSt,
    FakeDesRu,
    FakeNaiApi,
    startModule,
    trackerMessage,
    userMessage,
    wi,
} from './helpers';

let env: WorldEnv;
let world: WorldModelApi;
let stop: () => Promise<void>;
let desru: FakeDesRu;

const LIZA_FORMS = ['Лиза', 'Лизы', 'Лизе', 'Лизу', 'Лизой'];
const generating = { type: 'normal', dryRun: false, quiet: false };

async function tick(ms = 10): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

async function start(): Promise<void> {
    const started = await startModule(env, worldModule);
    stop = () => started.stop();
    world = env.modules.api<WorldModelApi>('world')!;
}

async function worldDoc(): Promise<Dict> {
    return env.app.chat.get<Dict>('world', () => ({}));
}

beforeEach(async () => {
    vi.useFakeTimers();
    env = createWorldEnv();
    desru = new FakeDesRu();
    desru.forms = { Лиза: LIZA_FORMS, Анна: ['Анна', 'Анны', 'Анне', 'Анну', 'Анной'] };
    env.neighbours.desru = desru;
    const index = addCard(env, 'Elizabeth', {
        world: 'Card Book',
        nai_studio: {
            passports: [
                { id: 'p1', kind: 'character', name: '', aliases: ['Liz'] },
                { id: 'p2', kind: 'character', name: 'Анна Петрова', aliases: [] },
                { id: 'p3', kind: 'world', name: 'Мир', aliases: [] },
            ],
        },
    });
    // Анна Петрова is of the card (plan-2 §9): her card passport joins without a question.
    (env.mock.context.characters[index] as STCharacter).description = 'Elizabeth и её подруга Анна Петрова.';
    (env.mock.context as unknown as Dict).name1 = 'Алекс';
    env.neighbours.desKnown = ['Лиза', 'Анна', 'Алекс', 'Скрытый'];
    env.neighbours.desRemoved = ['скрытый'];
    env.neighbours.desAliases = { Elizabeth: ['Лиза'] };
    env.mock.chat.push(
        trackerMessage('Привет', [
            { name: 'Лиза', relationship: { status: 'Friendly' }, details: { appearance: 'red hair', mood: 'calm' } },
            { name: 'Анна', present: false },
        ]),
        userMessage('Привет!'),
    );
    await start();
});

afterEach(async () => {
    await stop();
    vi.useRealTimers();
});

describe('M7 world model: resolution', () => {
    it('glues the card, the DES cast, DES aliases, passports and the persona', () => {
        const entities = world.entities();
        expect(entities.map((entity) => `${entity.kind}:${entity.name}`)).toEqual([
            'persona:Алекс',
            'character:Анна',
            'character:Анна Петрова',
            'character:Elizabeth',
        ]);
        const elizabeth = world.get('character:elizabeth')!;
        expect(elizabeth.aliases).toEqual(expect.arrayContaining(['Лиза', 'Liz']));
        expect(elizabeth.forms).toEqual(['Лизы', 'Лизе', 'Лизу', 'Лизой']);
        expect(elizabeth.sources.map((source) => source.kind)).toEqual(
            expect.arrayContaining(['card', 'des.character', 'nai.passport', 'des.alias']),
        );
        expect(elizabeth.present).toBe(true);
        expect(world.resolve('Анна')?.present).toBe(false);
        expect(world.resolve('Скрытый')).toBeUndefined();
        expect(world.entities('persona')).toHaveLength(1);
    });

    it('resolves Russian case forms through the fake DESRU_API', () => {
        expect(world.resolve('Лизой')?.id).toBe('character:elizabeth');
        expect(world.resolve('liz')?.id).toBe('character:elizabeth');
        expect(world.resolve('Анной')?.name).toBe('Анна');
        expect(world.resolve('Элизабет')).toBeUndefined();
        expect(world.resolve('Анна', 'place')).toBeUndefined();
    });

    it('finds mentions with a left boundary, in order', () => {
        const found = world.mentions('Вчера Лизой восхищались, а Анна молчала. Ромашка не в счёт.');
        expect(found.map((entity) => entity.name)).toEqual(['Elizabeth', 'Анна']);
        expect(world.mentions('Аннушка и Лизавета')).toEqual([]);
    });

    it('falls back to stems for mentions without DES-RU', async () => {
        env.neighbours.desru = undefined;
        await world.rebuild();
        expect(world.get('character:elizabeth')?.forms).toEqual([]);
        expect(world.mentions('с Лизой').map((entity) => entity.name)).toEqual(['Elizabeth']);
    });

    it('proposes a short first name as a merge candidate', () => {
        expect(world.mergeCandidates()).toEqual([
            { a: 'character:анна петрова', b: 'character:анна', reason: 'firstName', score: 0.7, name: 'Анна' },
        ]);
    });

    it('returns copies', () => {
        world.get('character:elizabeth')!.aliases.push('Mutated');
        expect(world.get('character:elizabeth')?.aliases).not.toContain('Mutated');
    });
});

describe('M7 world model: Inbox cards and decisions', () => {
    it('the leader proposes one card per candidate once the lorebooks are read, and only once', async () => {
        world.entities();
        expect(env.inbox.cards).toHaveLength(0);
        await tick();
        expect(env.inbox.cards).toHaveLength(1);
        const card = env.inbox.cards[0]!;
        expect(card.kind).toBe('world.merge');
        expect(card.payload).toEqual({ a: 'character:анна петрова', b: 'character:анна' });
        expect(card.changes[0]?.target).toBe('world-merge');
        await world.rebuild();
        await tick();
        expect(env.inbox.cards).toHaveLength(1);
        expect((await worldDoc()).proposed).toEqual([pairKey('character:анна петрова', 'character:анна')]);
    });

    it('other tabs do not propose', async () => {
        env.leader.value = false;
        world.entities();
        await tick();
        expect(env.inbox.cards).toHaveLength(0);
    });

    it('accepting the card merges: chat alias written, the short name resolves to the full one', async () => {
        world.entities();
        await tick();
        await env.inbox.accept(env.inbox.cards[0]!.id);
        expect(world.get('character:анна')?.id).toBe('character:анна петрова');
        expect(world.resolve('Анна')?.name).toBe('Анна Петрова');
        expect(world.chatAliases()).toEqual({ Анна: 'character:анна петрова' });
        expect(world.mergeCandidates()).toEqual([]);
        expect((await worldDoc()).merged).toEqual({ 'character:анна': 'character:анна петрова' });
    });

    it('rejecting the card separates the pair and it is not proposed again', async () => {
        world.entities();
        await tick();
        expect(env.inbox.appliers.get('world.merge')?.args).toHaveLength(2);
        await env.inbox.reject(env.inbox.cards[0]!.id);
        await tick();
        expect((await worldDoc()).separated).toEqual([pairKey('character:анна петрова', 'character:анна')]);
        expect(world.mergeCandidates()).toEqual([]);
        await world.rebuild();
        await tick();
        expect(env.inbox.cards).toHaveLength(0);
    });

    it('a snoozed card is not a rejection', async () => {
        world.entities();
        await tick();
        await env.inbox.snooze(env.inbox.cards[0]!.id);
        await tick();
        expect((await worldDoc()).separated).toEqual([]);
    });

    it('the applier reports invalid cards and the fourth argument separates', async () => {
        world.entities();
        await tick();
        const [stillValid, onReject] = env.inbox.appliers.get('world.merge')!.args as [
            (payload: unknown) => Promise<boolean>,
            (payload: unknown) => Promise<void>,
        ];
        expect(await stillValid({ a: 'character:анна петрова', b: 'character:анна' })).toBe(true);
        expect(await stillValid({ a: 'character:анна петрова', b: 'character:nobody' })).toBe(false);
        expect(await stillValid('junk')).toBe(false);
        await onReject({ a: 'character:анна петрова', b: 'character:анна' });
        expect(world.mergeCandidates()).toEqual([]);
    });

    it('merge() writes a chat alias, separate() takes it back', async () => {
        await world.merge('character:анна петрова', 'character:анна');
        expect(world.resolve('Анна')?.id).toBe('character:анна петрова');
        await world.merge('character:анна петрова', 'character:анна');
        await world.separate('character:анна петрова', 'character:анна');
        expect(world.resolve('Анна')?.id).toBe('character:анна');
        expect(world.chatAliases()).toEqual({});
        expect(world.mergeCandidates()).toEqual([]);
        await expect(world.merge('character:nobody', 'character:анна')).rejects.toThrow();
        await world.separate('x', 'x');
    });

    it('edits chat aliases', async () => {
        await world.setChatAlias('Рыжая', 'character:elizabeth');
        expect(world.resolve('рыжая')?.id).toBe('character:elizabeth');
        expect((await worldDoc()).aliases).toEqual({ Рыжая: 'character:elizabeth' });
        await world.setChatAlias('РЫЖАЯ', 'character:анна');
        expect(world.chatAliases()).toEqual({ РЫЖАЯ: 'character:анна' });
        await world.setChatAlias('рыжая', null);
        expect(world.chatAliases()).toEqual({});
        await expect(world.setChatAlias(' ', 'character:анна')).rejects.toThrow('Enter an alias.');
        await expect(world.setChatAlias('X', 'character:nobody')).rejects.toThrow();
    });
});

describe('M7 world model: sources', () => {
    beforeEach(() => {
        env.neighbours.active = ['Card Book', 'Pack'];
        env.neighbours.ckRepos = ['Repo'];
        env.books.book('Card Book', [
            wi(1, {
                comment: 'Таверна «Дракон»',
                key: ['Таверна', 'Трактир'],
                extensions: { maestro: { type: 'place', typeFields: { name: 'Таверна' } } },
            }),
            wi(2, { comment: 'Elizabeth', key: ['Elizabeth', 'Лиза'], content: 'Her story.' }),
            wi(3, { comment: 'Random note', key: ['/regex/'] }),
            wi(4, { comment: 'Ghost', key: ['Ghost'], disable: true, extensions: { maestro: { type: 'character' } } }),
            wi(5, { comment: 'Sword', key: ['Sword'] }),
            wi(6, { comment: 'Rule of magic', key: ['magic'], extensions: { maestro: { type: 'rule' } } }),
        ]);
        env.books.book('Pack', [
            wi(1, { comment: 'Elf', key: ['Elf'], extensions: { maestro: { type: 'character' } } }),
        ]);
        env.books.book('Repo', [
            wi(10, {
                comment: 'Анна Character Archive',
                key: ['Анна', 'Аннушка'],
                content: '<BunnymoTags><Name:Анна>, <GENRE:FANTASY></BunnymoTags>',
            }),
            wi(11, {
                comment: 'Stranger archive',
                key: ['Stranger'],
                content: '<BunnymoTags><Name:Stranger>, <SPECIES:ELF></BunnymoTags>',
            }),
        ]);
        env.modules.expose('bookRoles', {
            roleOf: (book: string) => (book === 'Pack' ? { book, role: 'bunnymo.pack' } : { book, role: 'card' }),
            entryMeta: (book: string, uid: number) =>
                book === 'Card Book' && uid === 5 ? { type: 'item', typeFields: { name: 'Меч' } } : undefined,
            loadEntryMeta: async () => undefined,
            onChange: () => () => {},
        });
        env.modules.expose('canon', {
            bookName: () => 'Maestro · канон · 1',
            list: async () => [
                {
                    uid: 1,
                    meta: { kind: 'addition', status: 'active', origin: 'user', type: 'character' },
                    entry: { comment: 'Elizabeth', key: ['Elizabeth'], content: 'Elizabeth is a knight now.' },
                },
                {
                    uid: 2,
                    meta: { kind: 'addition', status: 'archived', origin: 'user' },
                    entry: { comment: 'Анна', key: ['Анна'], content: 'Anna left town.' },
                },
            ],
            onChange: () => () => {},
        });
    });

    it('reads typed entries, archives, entries named after an entity and the canon lazily', async () => {
        expect(env.books.loads).toBe(0);
        world.entities();
        expect(env.books.loads).toBe(0);
        await tick();
        expect(env.books.loads).toBe(2);
        const place = world.resolve('Трактир');
        expect(place?.kind).toBe('place');
        expect(place?.sources[0]).toMatchObject({ kind: 'lore.entry', world: 'Card Book', uid: 1 });
        expect(world.resolve('Меч')?.kind).toBe('item');
        const elizabeth = world.get('character:elizabeth')!;
        expect(elizabeth.sources.map((source) => source.ref)).toEqual(
            expect.arrayContaining(['Card Book#2', 'Maestro · канон · 1#1']),
        );
        const anna = world.resolve('Анна')!;
        expect(anna.sources.some((source) => source.kind === 'ck.archive' && source.ref === 'Repo#10')).toBe(true);
        expect(anna.sources.some((source) => source.ref === 'Maestro · канон · 1#2')).toBe(true);
        expect(world.resolve('Stranger')).toBeUndefined();
        expect(world.resolve('Ghost')).toBeUndefined();
        expect(world.resolve('Elf')).toBeUndefined();
        expect(world.resolve('magic')).toBeUndefined();
    });

    it('gives structured facts: DES fields as provisional, canon items with their status', async () => {
        world.entities();
        await tick();
        const facts = world.facts('character:elizabeth');
        expect(facts.map((fact) => [fact.text, fact.status])).toEqual([
            ['relationship: Friendly', 'provisional'],
            ['appearance: red hair', 'provisional'],
            ['Elizabeth is a knight now.', 'active'],
        ]);
        expect(facts[0]).toMatchObject({ messageIndex: 0, storyTime: '3 марта, 14:00' });
        expect(world.facts(world.resolve('Анна')!.id).map((fact) => fact.status)).toEqual(['stale']);
        expect(world.facts('character:nobody')).toEqual([]);
    });

    it('re-reads lorebooks after WORLDINFO_UPDATED of a book it read, not of others', async () => {
        world.entities();
        await tick();
        const loads = env.books.loads;
        await env.books.updated('Other');
        await tick(500);
        expect(env.books.loads).toBe(loads);
        env.books.book('Card Book', [
            wi(7, { comment: 'Башня', key: ['Башня'], extensions: { maestro: { type: 'place' } } }),
        ]);
        await env.books.updated('Card Book');
        await tick(500);
        expect(env.books.loads).toBe(loads + 2);
        expect(world.resolve('Башня')?.kind).toBe('place');
        expect(world.resolve('Трактир')).toBeUndefined();
        await emitSt(env, 'WORLDINFO_SETTINGS_UPDATED');
        await tick(500);
        expect(env.books.loads).toBe(loads + 4);
    });

    it('reads places from the registry with their ids and follows its changes', async () => {
        let listener: () => void = () => {};
        let places = [{ id: 'p1', name: 'Таверна', aliases: ['Кабак'], forms: ['Таверне'] }];
        env.modules.expose('places', {
            list: () => places,
            onChange: (next: () => void) => {
                listener = next;
                return () => {};
            },
        });
        await world.rebuild();
        expect(world.resolve('Таверне')?.id).toBe('place:p1');
        expect(world.resolve('Трактир')?.id).toBe('place:p1');
        places = [...places, { id: 'p2', name: 'Порт', aliases: [], forms: [] }];
        listener();
        await tick(500);
        expect(world.entities('place').map((entity) => entity.id)).toEqual(['place:p2', 'place:p1']);
    });

    it('without the NAI API reads card passports and the persona passport from NAI settings', async () => {
        (env.mock.context.powerUserSettings as Dict).personas = { 'user.png': 'Алекс' };
        env.neighbours.naiSettings = {
            scene: { personaPassports: { 'user.png': { id: 'pp', kind: 'character', name: '', aliases: ['Сашка'] } } },
        };
        await world.rebuild();
        expect(world.resolve('Сашка')?.kind).toBe('persona');
        expect(world.resolve('Liz')?.id).toBe('character:elizabeth');
    });

    it('with the NAI API reads passports as the chat sees them and follows passportsSaved', async () => {
        const nai = new FakeNaiApi();
        nai.byAvatar['Elizabeth.png'] = [{ id: 'p1', kind: 'character', name: '', aliases: ['Лизонька'] }];
        nai.persona = [{ id: 'pp2', kind: 'character', name: '', aliases: ['Шурик'] }];
        nai.chat = [{ id: 'c1', kind: 'location', name: 'Башня', aliases: ['Шпиль'] }];
        env.neighbours.naiApi = nai;
        await world.rebuild();
        expect(world.resolve('Лизонька')?.id).toBe('character:elizabeth');
        expect(world.resolve('Liz')).toBeUndefined();
        expect(world.resolve('Шурик')?.kind).toBe('persona');
        const tower = world.resolve('Шпиль');
        expect(tower?.kind).toBe('place');
        expect(tower?.sources[0]).toMatchObject({ kind: 'nai.passport', ref: 'chat#c1', passportId: 'c1' });
        nai.chat = [{ id: 'c2', kind: 'object', name: 'Меч', aliases: [] }];
        nai.fire();
        await tick(500);
        expect(world.resolve('Шпиль')).toBeUndefined();
        expect(world.resolve('Меч')?.kind).toBe('item');
    });
});

describe('M7 world model: off the send path', () => {
    it('a committed turn only schedules the rebuild, which waits for the generation to end', async () => {
        world.entities();
        await tick();
        const reads = env.neighbours.rosterReads;
        env.turn.generation = generating;
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        expect(env.neighbours.rosterReads).toBe(reads);
        await tick(5000);
        expect(env.neighbours.rosterReads).toBe(reads);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await tick(500);
        expect(env.neighbours.rosterReads).toBe(reads + 1);
    });

    it('lorebooks asked for during a generation are read after it', async () => {
        env.neighbours.active = ['Card Book'];
        env.books.book('Card Book', [
            wi(1, { comment: 'Башня', key: ['Башня'], extensions: { maestro: { type: 'place' } } }),
        ]);
        env.turn.generation = generating;
        world.entities();
        await tick(5000);
        expect(env.books.loads).toBe(0);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await tick(500);
        expect(env.books.loads).toBe(1);
        expect(world.resolve('Башня')?.kind).toBe('place');
    });

    it('DES-RU name changes rebuild the cheap part', async () => {
        world.entities();
        await tick();
        env.neighbours.desAliases = { Elizabeth: ['Лиза'], 'Анна Петрова': ['Анна'] };
        desru.fire();
        await tick(500);
        expect(world.resolve('Анна')?.name).toBe('Анна Петрова');
        expect(world.mergeCandidates()).toEqual([]);
    });

    it('presence follows the committed tracker, not the reply in progress', async () => {
        world.entities();
        env.mock.chat.push(trackerMessage('Новый ответ', [{ name: 'Анна' }]));
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'swiped' });
        await tick(2000);
        expect(world.resolve('Анна')?.present).toBe(false);
        env.mock.chat.push(userMessage('Дальше'));
        await env.app.bus.emit('turn:committed', { messageIndex: 2 });
        await tick(2000);
        expect(world.resolve('Анна')?.present).toBe(true);
        expect(world.get('character:elizabeth')?.present).toBe(false);
    });

    it('a chat switch starts from scratch; disabling leaves nothing behind', async () => {
        await world.setChatAlias('Рыжая', 'character:elizabeth');
        env.mock.chatId = 'Other chat';
        env.mock.chatMetadata = {};
        await emitSt(env, 'CHAT_CHANGED', 'Other chat');
        await env.app.bus.emit('chat:changed', { chatId: 'Other chat' });
        await tick();
        expect(world.chatAliases()).toEqual({});
        expect(env.ui.tabs.map((tab) => tab.id)).toEqual(['world']);
        expect(env.ui.styles.has('m7w-view')).toBe(true);
        await stop();
        stop = async () => {};
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        const reads = env.neighbours.rosterReads;
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        desru.fire();
        await tick(5000);
        expect(env.neighbours.rosterReads).toBe(reads);
    });
});
