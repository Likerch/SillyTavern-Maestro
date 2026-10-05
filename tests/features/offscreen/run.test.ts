import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenPayload } from '../../../src/features/offscreen';
import { OFFSCREEN_TASK } from '../../../src/features/offscreen';
import {
    answer,
    createOffscreenEnv,
    entity,
    event,
    place,
    relation,
    seedMira,
    seedScene,
    trackerMessage,
    userMessage,
} from './helpers';
import type { OffscreenEnv, TrackerParts } from './helpers';

let env: OffscreenEnv;

const TAVERN: TrackerParts = {
    location: 'Таверна',
    present: ['Лиза'],
    quests: { main: null, optional: ['Найти амулет Миры', 'Купить хлеб'] },
};

/** Mira was at the market with Liza six committed turns ago; since then the scene is the tavern. */
function story(): void {
    env.mock.chat.push(
        trackerMessage('Мира торгуется на рынке.', {
            present: ['Лиза', 'Mira'],
            location: 'Рынок',
            date: '1 марта',
            time: '10:00',
        }),
        userMessage('Пойдём.'),
    );
    for (let i = 0; i < 6; i++) env.mock.chat.push(trackerMessage(`Таверна ${i}`, TAVERN), userMessage(`Ход ${i}`));
    env.mock.chat.push(trackerMessage('Черновик ответа', TAVERN));
}

const LAST_COMMITTED = 12;

beforeEach(() => {
    vi.useFakeTimers();
    env = createOffscreenEnv();
    seedScene(env);
    seedMira(env);
    env.places.places.push(place({ id: 'port', name: 'Порт' }), place({ id: 'market', name: 'Рынок', parent: 'port' }));
    story();
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

const userPrompt = (index = 0) => env.llm.requests[index]?.messages[1]?.content ?? '';

describe('picking characters', () => {
    it('absent and important only: not present, not the persona, not seen lately, not on cooldown', async () => {
        env.world.list.push(
            entity({ name: 'Oleg', sources: [{ kind: 'lore.entry', ref: 'W#2', label: 'Oleg', world: 'W', uid: 2 }] }),
            entity({ name: 'Grim', sources: [{ kind: 'qvink.memory', ref: '3', label: 'Grim' }] }),
            entity({ name: 'Vera', sources: [{ kind: 'nai.passport', ref: 'p', label: 'Vera', passportId: 'p' }] }),
            entity({ name: 'Ivan', sources: [{ kind: 'ck.archive', ref: 'R#1', label: 'Ivan', world: 'R', uid: 1 }] }),
            entity({ name: 'Hidden', sources: [{ kind: 'card', ref: 'x', label: 'Hidden' }] }),
        );
        env.des.known.push('Oleg', 'Vera', 'Ivan', 'Ghost', 'Hidden');
        env.des.removed.push('Ghost');
        // Oleg is in the current scene; Vera was there a turn ago.
        env.mock.chat.splice(
            10,
            5,
            trackerMessage('Вера ушла', { ...TAVERN, present: ['Лиза', 'Vera'] }),
            userMessage('…'),
            trackerMessage('Олег здесь', { ...TAVERN, present: ['Лиза', 'Oleg'] }),
            userMessage('…'),
            trackerMessage('Черновик', TAVERN),
        );
        const service = await env.start();
        expect(service.candidates()).toEqual([
            { name: 'Ivan', absent: null, preferred: true },
            { name: 'Mira', absent: 6, preferred: true },
            { name: 'Vera', absent: 1, preferred: false },
        ]);
        // Ivan gets an event: he cools down (the picker still offers him, the automatic pick does not).
        env.llm.script = [answer(event({ character: 'Ivan', text: 'Ivan repaired the old mill.', rumour: '' }))];
        await service.execute('manual', ['Ivan']);
        expect(service.candidates()).toEqual([
            { name: 'Ivan', absent: null, preferred: false },
            { name: 'Mira', absent: 6, preferred: true },
            { name: 'Vera', absent: 1, preferred: false },
        ]);
        await service.runNow();
        expect(env.tasks.queued.at(-1)?.payload).toMatchObject({ reason: 'manual', characters: ['Mira'] });
    });

    it('never picks a character known only to global stores; this chat’s books and words make one local', async () => {
        env.world.list.push(
            entity({
                name: 'Florence',
                forms: ['Флоренс', 'Флоренсу'],
                sources: [{ kind: 'ck.archive', ref: 'Archive#7', label: 'Florence', world: 'Archive', uid: 7 }],
            }),
            entity({
                name: 'Bram',
                sources: [{ kind: 'lore.entry', ref: 'ChatBook#1', label: 'Bram', world: 'ChatBook', uid: 1 }],
            }),
        );
        (env.mock.chatMetadata as Record<string, unknown>).world_info = 'ChatBook';
        const service = await env.start();
        const names = () => service.candidates().map((candidate) => candidate.name);
        expect(names()).not.toContain('Florence');
        expect(names()).toContain('Bram');
        env.mock.chat.push(userMessage('Я вспомнил о Флоренс.'));
        expect(names()).toContain('Florence');
    });

    it('takes back, once, events saved earlier for characters from outside this chat', async () => {
        env.world.list.push(
            entity({
                name: 'Florence',
                sources: [{ kind: 'ck.archive', ref: 'Archive#7', label: 'Florence', world: 'Archive', uid: 7 }],
            }),
        );
        const saved = {
            character: 'Florence',
            characterKey: 'florence',
            status: 'saved',
            messageIndex: 3,
            turn: 2,
            at: 1,
        };
        await env.app.chat.put('offscreen', {
            turns: 6,
            lastCommitted: 10,
            lastRunTurn: 6,
            seen: {},
            runs: [],
            bootstrapped: true,
            events: [
                { ...saved, id: 'e1', text: 'Florence cooked soup.', canonUid: 5 },
                { ...saved, id: 'e2', character: 'Mira', characterKey: 'mira', text: 'Mira sold herbs.', canonUid: 6 },
            ],
        });
        const service = await env.start();
        await vi.runAllTimersAsync();
        expect(env.canon.removed).toEqual([5]);
        expect(service.events().map((item) => [item.character, item.status])).toEqual([
            ['Mira', 'saved'],
            ['Florence', 'rejected'],
        ]);
        expect(env.ui.notices.at(-1)?.text).toContain('Florence');
        // Once per chat.
        await env.stop();
        await env.start();
        await vi.runAllTimersAsync();
        expect(env.canon.removed).toEqual([5]);
    });

    it('a narrator card that never appears in a scene is not a character', async () => {
        env.world.list = env.world.list.filter((item) => item.name !== 'Mira');
        env.des.known = [];
        (env.mock.context as unknown as Record<string, unknown>).name2 = 'Narrator';
        env.world.list.push(entity({ name: 'Narrator', sources: [{ kind: 'card', ref: 'n.png', label: 'Narrator' }] }));
        const service = await env.start();
        expect(service.candidates()).toEqual([]);
        await expect(service.runNow()).rejects.toThrow('Nobody to look in on');
    });

    it('runNow: names by any alias, the persona dropped; errors without a chat, canon or anybody', async () => {
        const service = await env.start();
        await service.runNow(['Мира', 'Алекс', 'Mira']);
        expect(env.tasks.queued.at(-1)?.payload.characters).toEqual(['Mira']);
        await expect(service.runNow(['Алекс'])).rejects.toThrow('Nobody to look in on');
        env.modules.apis.delete('canon');
        await expect(service.runNow()).rejects.toThrow('The chat canon is off');
        env.host.group = true;
        await expect(service.runNow()).rejects.toThrow('group chats');
        env.host.group = false;
        env.mock.chatId = undefined;
        await expect(service.runNow()).rejects.toThrow('No chat is open.');
    });
});

describe('the request', () => {
    beforeEach(() => {
        env.modules.expose('dossier', env.dossier);
        env.modules.expose('calendar', env.calendar);
        env.dossier.pages.set('character:mira', [
            { kind: 'canon', title: 'Mira', text: 'Mira runs a herb shop in the port.' },
            { kind: 'lore', title: 'Mira (World)', text: 'Mira is a herbalist with a quiet temper.' },
            { kind: 'tags', title: 'Tags', text: '<TRAIT:SHY>' },
            { kind: 'lore', title: 'Empty', text: '  ' },
        ]);
        env.relations.list.push(relation('Mira', 'Алекс', 'Дружба'), relation('Лиза', 'Mira', 'Соперница'));
        env.calendar.list.push({
            id: 'p1',
            who: ['Mira'],
            toWhom: ['Алекс'],
            what: 'Return the borrowed knife',
            quote: '',
            due: { label: '5 марта', day: 5 },
            status: 'open',
            sourceMessage: 2,
            createdAt: 0,
        });
        env.qvink.present = true;
        env.qvink.memories.set(8, { memory: 'Алекс и Лиза сбежали от стражи.', include: 'long', remember: false });
        env.qvink.memories.set(10, { memory: 'Они спрятались в таверне.', include: 'short', remember: false });
        env.chronicle.list.push({ uid: 7, title: 'Порт', from: 0, to: 4, keys: [], secondary: [], chars: 31 });
        env.canon.items.push({
            uid: 7,
            entry: { content: 'The heroes arrived at the port.' },
            meta: {
                kind: 'addition',
                status: 'active',
                origin: 'chronicle',
                type: 'chapter',
                createdAt: 0,
                updatedAt: 0,
            },
        });
    });

    it('carries the dossier, the last sighting, relationships, quests, story time and the summary — fenced', async () => {
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        const request = env.llm.requests[0]!;
        expect(request).toMatchObject({ task: 'offscreen', maxTokens: 900 });
        const schema = request.schema?.schema as {
            properties: { events: { items: { properties: Record<string, unknown> } } };
        };
        expect(schema.properties.events.items.properties.character).toEqual({ type: 'string', enum: ['Mira'] });
        expect(request.messages[0]?.content).toContain('untrusted story data');
        const text = userPrompt();
        expect(text).toContain("The user's character: Алекс");
        expect(text).toContain('Story time now: 3 марта, 14:00');
        expect(text).toContain("The user's character is at: Таверна");
        expect(text).toContain('- Chapter «Порт»: The heroes arrived at the port.');
        expect(text).toContain('- Алекс и Лиза сбежали от стражи.\n- Они спрятались в таверне.');
        expect(text).toContain('## Mira (also: Мира)');
        expect(text).toContain('Last seen: 6 turns ago, at Порт › Рынок, story time 1 марта, 10:00');
        expect(text).toContain('Relationships: Mira → Алекс: Дружба; Лиза → Mira: Соперница');
        expect(text).toContain('Open quests and promises: Найти амулет Миры; Return the borrowed knife (due 5 марта)');
        expect(text).not.toContain('Купить хлеб');
        expect(text).toContain(
            'Dossier:\n- Mira runs a herb shop in the port.\n- Mira is a herbalist with a quiet temper.',
        );
        expect(text).not.toContain('TRAIT');
        // The contradiction check sees the same dossier and quests, inline.
        expect(env.contradictions.checks[0]).toMatchObject({
            input: { statement: event().text, entities: ['Mira'] },
            options: { inline: true },
        });
        expect(env.contradictions.checks[0]!.input.against.map((item) => item.label)).toEqual([
            'canon: Mira',
            'lore: Mira (World)',
            'quest',
            'quest',
        ]);
    });

    it('without the dossier it reads the stores; earlier events go into the next request', async () => {
        env.modules.apis.delete('dossier');
        (env.mock.context as unknown as Record<string, unknown>).loadWorldInfo = async (name: string) =>
            name === 'World' ? { entries: { 1: { uid: 1, content: 'Mira is a herbalist (lore).' } } } : null;
        env.world.list[2]!.sources.push({ kind: 'canon.entry', ref: 'c#7', label: 'Mira canon', uid: 7 });
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(userPrompt()).toContain('- The heroes arrived at the port.\n- Mira is a herbalist (lore).');
        await service.execute('manual', ['Mira']);
        expect(userPrompt(1)).toContain('Earlier off-screen: Mira sold rare herbs to a ship captain');
    });
});

describe('reading the answer', () => {
    it('one more try after an unreadable answer', async () => {
        env.llm.script = [{ ok: false, error: 'parse' }, answer(event())];
        const service = await env.start();
        const run = await service.execute('manual', ['Mira']);
        expect(env.llm.requests).toHaveLength(2);
        expect(run).toMatchObject({ events: 1, characters: ['Mira'] });
        expect(run?.error).toBeUndefined();
    });

    it.each([
        [
            [
                { ok: true, data: { events: 'nope' } },
                { ok: true, data: { foo: 1 } },
            ],
            'parse',
            2,
        ],
        [
            [
                { ok: true, data: { events: [] } },
                { ok: true, data: { events: [{ character: 'Stranger', text: 'x' }] } },
            ],
            'empty',
            2,
        ],
        [[{ ok: false, refusal: true, error: 'refusal' }], 'refusal', 1],
        [[{ ok: false, error: 'timeout' }], 'timeout', 1],
    ])('a run without events is recorded with its reason (%#)', async (script, error, requests) => {
        env.llm.script = script as typeof env.llm.script;
        const service = await env.start();
        const run = await service.execute('interval', ['Mira']);
        expect(run).toMatchObject({ error, events: 0 });
        expect(env.llm.requests).toHaveLength(requests);
        expect(service.status().lastRun).toMatchObject({ error, reason: 'interval' });
        expect(env.canon.puts).toEqual([]);
    });

    it('keeps the readable items, accepts an alias, ignores strangers', async () => {
        env.llm.script = [answer(event({ character: 'Мира' }), event({ character: 'Stranger' }), 'junk' as never)];
        const service = await env.start();
        const run = await service.execute('manual', ['Mira']);
        expect(run?.events).toBe(1);
        expect(service.events()[0]?.character).toBe('Mira');
    });
});

describe('checks and routing', () => {
    it('a clean event is saved to the canon by itself, journaled, with undo', async () => {
        env.llm.script = [answer(event({ location: 'Порт' }))];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(env.canon.puts).toEqual([
            {
                entry: {
                    key: ['Mira', 'Мира', 'Миру', 'Миры'],
                    keysecondary: [],
                    comment: 'Offscreen: Mira',
                    content:
                        'Offscreen (3 марта, 14:00): Mira sold rare herbs to a ship captain and earned a small fortune. Whereabouts now: Порт.',
                },
                meta: {
                    kind: 'addition',
                    status: 'active',
                    origin: 'backstage',
                    type: 'event',
                    sourceMessage: LAST_COMMITTED,
                },
            },
        ]);
        expect(env.autonomy.proposals[0]).toMatchObject({
            module: 'M16',
            kind: 'offscreen.event',
            title: 'Backstage: Mira',
        });
        const [saved] = service.events();
        expect(saved).toMatchObject({
            character: 'Mira',
            status: 'saved',
            canonUid: 100,
            storyTime: '3 марта, 14:00',
            location: 'Порт',
            rumour: 'They say the herbalist got rich overnight.',
            messageIndex: LAST_COMMITTED,
        });
        expect(saved).not.toHaveProperty('turn');
        expect(saved).not.toHaveProperty('characterKey');
        const record = env.journal.records.find((item) => item.kind === 'offscreen.event')!;
        expect(record.changes[0]).toMatchObject({ target: 'offscreen.event', before: null });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.canon.removed).toEqual([100]);
        expect(service.events()[0]?.status).toBe('rejected');
    });

    it('a contradiction with the canon goes to the Inbox instead', async () => {
        env.modules.expose('dossier', env.dossier);
        env.dossier.pages.set('character:mira', [
            { kind: 'canon', title: 'Mira', text: 'Mira never leaves the port.' },
        ]);
        env.contradictions.result = {
            clean: false,
            askedAi: true,
            costUsd: 0.0005,
            contradictions: [
                {
                    label: 'canon: Mira',
                    statement: 'left',
                    conflicting: 'never leaves the port',
                    kind: 'ai',
                    confidence: 0.9,
                },
            ],
        };
        env.llm.script = [answer(event({ text: 'Mira left the port for the capital.' }))];
        const service = await env.start();
        const run = await service.execute('manual', ['Mira']);
        expect(run?.costUsd).toBeCloseTo(0.0015, 6);
        expect(env.canon.puts).toEqual([]);
        expect(env.autonomy.proposals).toEqual([]);
        const card = env.inbox.added[0]!;
        expect(card).toMatchObject({ kind: 'offscreen.event', sourceMessage: LAST_COMMITTED });
        expect(card.description).toContain('Contradicts the canon: canon: Mira: «never leaves the port»');
        expect(card.payload).toMatchObject({
            m16: 1,
            entityName: 'Mira',
            value: 'Mira left the port for the capital.',
            editable: true,
            drastic: false,
        });
        expect(service.events()[0]).toMatchObject({
            status: 'inbox',
            conflict: 'canon: Mira: «never leaves the port»',
        });
    });

    it('a failed check keeps the event in the Inbox; without the service it is not checked', async () => {
        env.modules.expose('dossier', env.dossier);
        env.dossier.pages.set('character:mira', [{ kind: 'canon', title: 'Mira', text: 'Mira is a herbalist.' }]);
        env.contradictions.fail = true;
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(env.inbox.added[0]?.description).toContain('The contradiction check could not run.');
        env.contradictions.fail = false;
        env.contradictions.result = { clean: false, askedAi: false, costUsd: 0, contradictions: [] };
        await env.runTasks();
        await service.execute('manual', ['Mira']);
        expect(env.inbox.added).toHaveLength(2);
        env.modules.apis.delete('contradictions');
        await service.execute('manual', ['Mira']);
        expect(env.canon.puts).toHaveLength(1);
    });

    it.each([
        ['the model flags it', event({ drastic: true, text: 'Mira joined a smugglers’ crew.' })],
        ['the rules catch it', event({ text: 'Mira was arrested by the city watch for smuggling.' })],
    ])('a drastic event always waits in the Inbox (%s)', async (_label, item) => {
        env.autonomy.levels.set('offscreen.event', 'auto');
        env.llm.script = [answer(item)];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(env.canon.puts).toEqual([]);
        expect(env.inbox.added[0]?.description).toContain('A drastic turn');
        expect(service.events()[0]).toMatchObject({ status: 'inbox', drastic: true });
    });

    it('follows the autonomy level of the kind', async () => {
        env.autonomy.levels.set('offscreen.event', 'inbox');
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(service.events()[0]?.status).toBe('inbox');
        env.autonomy.levels.set('offscreen.event', 'off');
        await env.runTasks();
        await service.execute('manual', ['Mira']);
        expect(service.events()[0]?.status).toBe('rejected');
        expect(env.canon.puts).toEqual([]);
    });

    it('an Inbox card applies the edited text later, once; a rejected card marks the event', async () => {
        env.llm.script = [answer(event({ drastic: true }))];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        const payload = env.inbox.added[0]!.payload as OffscreenPayload;
        const card = env.inbox.appliers.get('offscreen.event')!;
        expect(await card.valid?.(payload)).toBe(true);
        expect(await card.valid?.({ junk: true })).toBe(false);
        await card.apply({ ...payload, value: 'Mira opened a second shop. She hired two apprentices.' });
        expect(env.canon.puts[0]?.entry.content).toBe(
            'Offscreen (3 марта, 14:00): Mira opened a second shop. She hired two apprentices.',
        );
        expect(service.events()[0]).toMatchObject({
            status: 'saved',
            text: 'Mira opened a second shop. She hired two apprentices.',
        });
        expect(await card.valid?.(payload)).toBe(false);
        await expect(card.apply({ junk: true })).rejects.toThrow('bad offscreen card');
        await expect(card.apply({ ...payload, value: '  ' })).rejects.toThrow('The event text is empty.');

        env.llm.script = [answer(event({ drastic: true }))];
        await service.execute('manual', ['Mira']);
        const second = env.inbox.added[1]!.payload as OffscreenPayload;
        await card.reject?.(second);
        expect(service.events()[0]?.status).toBe('rejected');
        await card.reject?.({ junk: true });
    });

    it('an edited or deleted committed message drops its Inbox events', async () => {
        env.llm.script = [answer(event({ drastic: true }))];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        await env.app.bus.emit('message:invalidated', { messageIndex: LAST_COMMITTED, reason: 'edited' });
        expect(service.events()[0]?.status).toBe('rejected');
    });

    it('keeps two offscreen items of a character active; older ones are archived', async () => {
        const old = (uid: number, createdAt: number) => ({
            uid,
            entry: { comment: 'Offscreen: Mira', content: `old ${uid}` },
            meta: {
                kind: 'addition' as const,
                status: 'active' as const,
                origin: 'backstage' as const,
                createdAt,
                updatedAt: 0,
            },
        });
        env.canon.items.push(old(1, 10), old(2, 20));
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(env.canon.statuses).toEqual([[1, 'archived']]);
    });

    it('undo without the event record finds the item by its text', async () => {
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        const record = env.journal.records.find((item) => item.kind === 'offscreen.event')!;
        const handler = env.journal.handlers.get('offscreen.event')!;
        const change = { ...record.changes[0]!, ref: { eventId: 'gone' } };
        expect(await handler(change)).toBe(true);
        expect(env.canon.removed).toEqual([100]);
        env.modules.apis.delete('canon');
        expect(await handler(change)).toBe(false);
    });
});

describe('a run re-checks before asking', () => {
    it('drops characters who came back and the persona; stops without canon, budget or profile', async () => {
        const service = await env.start();
        env.mock.chat.splice(
            12,
            3,
            trackerMessage('Мира вернулась', { ...TAVERN, present: ['Лиза', 'Mira'] }),
            userMessage('…'),
            trackerMessage('Черновик', TAVERN),
        );
        expect(await service.execute('manual', ['Mira', 'Алекс'])).toMatchObject({
            error: 'noCandidates',
            characters: [],
        });
        env.mock.chat.splice(
            12,
            3,
            trackerMessage('Таверна', TAVERN),
            userMessage('…'),
            trackerMessage('Черновик', TAVERN),
        );
        env.modules.apis.delete('canon');
        expect(await service.execute('manual', ['Mira'])).toMatchObject({ error: 'noCanon' });
        env.modules.expose('canon', env.canon);
        env.capped.value = true;
        expect(await service.execute('manual', ['Mira'])).toMatchObject({ error: 'cap' });
        env.capped.value = false;
        env.llm.available = false;
        expect(await service.execute('manual', ['Mira'])).toMatchObject({ error: 'noProfile' });
        expect(env.llm.requests).toEqual([]);
    });

    it('the queued task runs the run and never throws', async () => {
        env.llm.script = [answer(event())];
        const service = await env.start();
        await service.runNow(['Mira']);
        expect(env.tasks.queued[0]?.kind).toBe(OFFSCREEN_TASK);
        await env.runTasks();
        expect(service.events()).toHaveLength(1);
        await env.tasks.runners.get(OFFSCREEN_TASK)!(
            { reason: 'manual', characters: ['Mira'], chatId: 'other chat' },
            {
                id: 'x',
                kind: OFFSCREEN_TASK,
                payload: {},
                state: 'running',
                attempts: 1,
                createdAt: 0,
            },
        );
        expect(env.llm.requests).toHaveLength(1);
    });
});
