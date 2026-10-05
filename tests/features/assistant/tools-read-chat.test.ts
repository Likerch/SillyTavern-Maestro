// Read tools over the story itself (1.10.0): chat_read, chat_search, card_read (alternate greetings, group chats),
// persona_read, scenario_overview; caps, the untrusted flag, chips in both languages, the system prompt and the guide.
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../src/features/assistant/prompt';
import { readTools } from '../../../src/features/assistant/tools';
import { knowledgeBase } from '../../../src/features/assistant/tools/knowledge';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { searchDocs } from '../../../src/domain/assistant-docs';
import { fakeApp, jsonSize, msg, runTool, toolContext, userMsg } from './tools-helpers';
import type { FakeApp, FakeAppOptions, Loose } from './tools-helpers';

const TRACKER = {
    infoBox: { location: 'Tavern', date: 'Day 3', time: { start: '18:00' } },
    characters: [
        { name: 'Anna', relationship: { status: 'Friend' }, stats: { Health: 80 } },
        { name: 'Kai', thoughts: 'Not currently in the scene.' },
    ],
    quests: { main: 'Find the map', optional: [] },
};
const TRACKED = `\`\`\`json\n${JSON.stringify(TRACKER)}\n\`\`\`\nAnna pours the ale. <b>Rain</b> drums on the roof. [nai:img:x1]`;

const ANNA = {
    name: 'Anna',
    avatar: 'anna.png',
    description: 'Anna is a ranger of the northern woods.',
    personality: 'Brave, curious.',
    scenario: 'The war is over; the roads are not safe.',
    first_mes: 'Hello, {{user}}! Rain again — the road to the north has been washed away for three days now.',
    mes_example: '<START>\n{{char}}: Hm.',
    tags: ['fantasy'],
    data: {
        alternate_greetings: [
            'At the city gate, {{user}} waits while the guards argue about the toll for the night.',
            'In the tavern, {{char}} counts the coins that are left after the long hard winter.',
            'On the battlefield, {{char}} bandages a wound while the crows circle above the hill.',
        ],
        creator_notes: 'Works best with DES.',
        system_prompt: 'Write vividly.',
        post_history_instructions: 'Stay in character.',
        extensions: {
            world: 'Northern World',
            depth_prompt: { prompt: 'Anna hides a letter.', depth: 4, role: 'system' },
        },
        character_book: { name: 'Anna lore', entries: [{ keys: ['letter'], comment: 'The letter', enabled: true }] },
    },
};
const KAI = { name: 'Kai', avatar: 'kai.png', description: 'Kai is a smuggler.', first_mes: 'Kai nods.' };

function storyChat(): STChatMessage[] {
    return [
        msg('In the tavern, Anna counts the coins that are left after the long hard winter.', {
            name: 'Anna',
            swipes: ['a', 'b', 'c', 'd'],
            swipe_id: 2,
            send_date: 'October 1, 2026 9:00pm',
        }),
        userMsg('Ёлки-палки, сколько монет у Анны?'),
        msg(TRACKED, { name: 'Anna' }),
        msg('A hidden note.', { name: 'Anna', is_system: true }),
        msg('The narrator speaks.', { name: 'System', extra: { type: 'narrator' } }),
        userMsg('Я уговариваю Кая помочь.'),
    ];
}

function storyApp(options: FakeAppOptions = {}): FakeApp {
    return fakeApp({
        chat: storyChat(),
        ...options,
        ctx: {
            characters: [ANNA, KAI],
            characterId: 0,
            name1: 'Alex',
            tags: [{ id: 't1', name: 'adventure' }],
            tagMap: { 'anna.png': ['t1'] },
            chatMetadata: {},
            powerUserSettings: {},
            ...(options.ctx ?? {}),
        },
    });
}

function setPersonaModule(fake: FakeApp, avatar: string): void {
    (fake.app.host.modules as unknown as { load: (path: string) => Promise<Record<string, unknown>> }).load = async (
        path,
    ) => (path === 'personas.js' ? { user_avatar: avatar } : {});
}

describe('chat_read', () => {
    it('reads the latest messages cleaned, with the tracker summarised, roles, swipes and hidden marks', async () => {
        const fake = storyApp();
        const output = await runTool(readTools(fake.app), 'chat_read', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Chat: #0–#5 (6 of 6)');
        expect(data.chat).toEqual({ messages: 6, first: 0, last: 5 });
        expect(data.truncated).toBe(false);
        expect(data.messages[0]).toMatchObject({ index: 0, name: 'Anna', role: 'char', swipe: '3/4' });
        expect(data.messages[0].date).toBe('October 1, 2026 9:00pm');
        expect(data.messages[2].text).toBe('Anna pours the ale. Rain drums on the roof.');
        expect(data.messages[2].tracker).toEqual({ location: 'Tavern', time: 'Day 3, 18:00', present: ['Anna'] });
        expect(JSON.stringify(data.messages[2])).not.toContain('infoBox');
        expect(data.messages[3]).toMatchObject({ hidden: true, text: 'A hidden note.' });
        expect(data.messages[4]).toMatchObject({ role: 'system', system: 'narrator' });
        const ru = await runTool(readTools(fake.app), 'chat_read', { last: 2 }, toolContext(fake, { locale: 'ru' }));
        expect(ru.summary).toBe('Чат: №4–№5 (2 из 6)');
        expect((ru.data as Loose).note).toBe('4 more messages in this range: use from/to.');
        expect((ru.data as Loose).truncated).toBe(true);
    });

    it('reads a range, one role, or the raw text', async () => {
        const fake = storyApp();
        const tools = readTools(fake.app);
        const range = (await runTool(tools, 'chat_read', { from: 1, to: 2 }, toolContext(fake))).data as Loose;
        expect(range.messages.map((row: Loose) => row.index)).toEqual([1, 2]);
        expect(range.shown).toEqual({ from: 1, to: 2, count: 2 });
        const users = (await runTool(tools, 'chat_read', { role: 'user' }, toolContext(fake))).data as Loose;
        expect(users.messages.map((row: Loose) => row.index)).toEqual([1, 5]);
        const chars = (await runTool(tools, 'chat_read', { role: 'char', last: 1 }, toolContext(fake))).data as Loose;
        expect(chars.messages.map((row: Loose) => row.index)).toEqual([3]);
        const raw = (await runTool(tools, 'chat_read', { from: 2, last: 1, clean: false }, toolContext(fake)))
            .data as Loose;
        expect(raw.messages[0].text).toContain('"infoBox"');
        expect(raw.shown.raw).toBe(true);
        const backwards = await runTool(tools, 'chat_read', { from: 4, to: 1 }, toolContext(fake));
        expect(backwards.summary).toBe('`from` is after `to`.');
    });

    it('cuts long texts with their full length and keeps 60 long messages within the size cap', async () => {
        const long = 'Слово '.repeat(2000);
        const fake = fakeApp({ chat: Array.from({ length: 80 }, (_, index) => msg(`${index} ${long}`)) });
        const tools = readTools(fake.app);
        const one = (await runTool(tools, 'chat_read', { from: 5, to: 5 }, toolContext(fake))).data as Loose;
        expect(one.messages[0].text.length).toBeLessThanOrEqual(7000);
        expect(one.messages[0].cut).toBe(long.trim().length + 2);
        expect(one.truncated).toBe(true);
        expect(one.note).toMatch(/^Texts over 7000 characters are cut/);
        const many = await runTool(tools, 'chat_read', { last: 60 }, toolContext(fake));
        expect((many.data as Loose).messages).toHaveLength(60);
        expect(jsonSize(many.data)).toBeLessThanOrEqual(11000);
        const capped = (await runTool(tools, 'chat_read', { last: 500 }, toolContext(fake))).data as Loose;
        expect(capped.messages).toHaveLength(60);
    });

    it('answers on an empty chat', async () => {
        const fake = fakeApp();
        const output = await runTool(readTools(fake.app), 'chat_read', {}, toolContext(fake, { locale: 'ru' }));
        expect(output.summary).toBe('Чат пуст.');
    });
});

describe('chat_search', () => {
    it('finds Russian word forms and ё = е, best matches first, with a snippet', async () => {
        const fake = storyApp();
        const tools = readTools(fake.app);
        const anna = await runTool(tools, 'chat_search', { query: 'Анна' }, toolContext(fake, { locale: 'ru' }));
        const data = anna.data as Loose;
        expect(anna.untrusted).toBe(true);
        expect(anna.summary).toBe('Поиск по чату «Анна»: сообщений — 1');
        expect(data.hits[0]).toMatchObject({ index: 1, role: 'user' });
        expect(data.hits[0].snippet).toContain('Анны');
        const yo = (await runTool(tools, 'chat_search', { query: 'елки' }, toolContext(fake))).data as Loose;
        expect(yo.hits.map((hit: Loose) => hit.index)).toEqual([1]);
        const both = await runTool(tools, 'chat_search', { query: 'уговаривать Кай' }, toolContext(fake));
        expect((both.data as Loose).hits[0]).toMatchObject({ index: 5, matched: '2/2' });
        expect(both.summary).toBe('Chat search «уговаривать Кай»: 1 messages');
        const english = (await runTool(tools, 'chat_search', { query: 'coins', limit: 1 }, toolContext(fake)))
            .data as Loose;
        expect(english.hits).toHaveLength(1);
        expect(english.hits[0].index).toBe(0);
        const tracker = (await runTool(tools, 'chat_search', { query: 'infoBox' }, toolContext(fake))).data as Loose;
        expect(tracker.found).toBe(0);
        const empty = await runTool(tools, 'chat_search', { query: '  ' }, toolContext(fake));
        expect(empty.summary).toBe('Give words to search for.');
    });

    it('reports partial matches when no message has all the words', async () => {
        const fake = storyApp();
        const output = await runTool(readTools(fake.app), 'chat_search', { query: 'coins dragon' }, toolContext(fake));
        expect(output.data).toMatchObject({ found: 1, allWords: 0 });
        expect((output.data as Loose).note).toBe('No message has all the words: partial matches are shown.');
    });
});

describe('card_read', () => {
    it('gives the card with every alternate greeting numbered and the one the chat opened with', async () => {
        const fake = storyApp({ ctx: { chatMetadata: { scenario: 'Override: a siege.' } } });
        const output = await runTool(readTools(fake.app), 'card_read', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Card: Anna (+3 greetings)');
        expect(data).toMatchObject({
            name: 'Anna',
            description: ANNA.description,
            personality: 'Brave, curious.',
            scenario: ANNA.scenario,
            chatOverrides: { scenario: 'Override: a siege.' },
            firstMessage: ANNA.first_mes,
            greetingInChat: 'alternate greeting 2',
            creatorNotes: 'Works best with DES.',
            systemPrompt: 'Write vividly.',
            postHistory: 'Stay in character.',
            depthPrompt: { depth: 4, role: 'system', text: 'Anna hides a letter.' },
            tags: ['fantasy', 'adventure'],
            world: 'Northern World',
            book: { name: 'Anna lore', entries: 1, names: ['The letter'] },
        });
        expect(data.alternateGreetings.total).toBe(3);
        expect(data.alternateGreetings.items.map((item: Loose) => item.n)).toEqual([1, 2, 3]);
        expect(data.alternateGreetings.items[2].text).toContain('battlefield');
        expect(data.sizes.greetings).toHaveLength(3);
        expect(data.sizes.description).toBe(ANNA.description.length);
        expect(data.note).toBeUndefined();
        const ru = await runTool(readTools(fake.app), 'card_read', {}, toolContext(fake, { locale: 'ru' }));
        expect(ru.summary).toBe('Карточка: Anna (доп. приветствий: 3)');
    });

    it('caps a huge card and reads one part or one starting scene whole', async () => {
        const huge = {
            ...ANNA,
            description: 'D'.repeat(20000),
            data: {
                ...ANNA.data,
                alternate_greetings: Array.from({ length: 25 }, (_, n) => `${n} ${'G'.repeat(3000)}`),
            },
        };
        const fake = storyApp({ ctx: { characters: [huge, KAI] } });
        const tools = readTools(fake.app);
        const overview = await runTool(tools, 'card_read', {}, toolContext(fake));
        const data = overview.data as Loose;
        expect(jsonSize(data)).toBeLessThanOrEqual(11000);
        expect(data.alternateGreetings.items).toHaveLength(25);
        expect(data.sizes.description).toBe(20000);
        expect(data.note).toMatch(/^Long fields are cut/);
        const part = (await runTool(tools, 'card_read', { part: 'description' }, toolContext(fake))).data as Loose;
        expect(part).toMatchObject({ part: 'description', size: 20000 });
        expect(part.text.length).toBe(9000);
        const scene = await runTool(tools, 'card_read', { greeting: 3 }, toolContext(fake, { locale: 'ru' }));
        expect(scene.data).toMatchObject({
            greeting: 3,
            kind: 'alternate greeting',
            alternateGreetings: 25,
            size: 3002,
        });
        expect((scene.data as Loose).text.startsWith('2 GGG')).toBe(true);
        expect(scene.summary).toBe('Карточка Anna: стартовая сцена 3');
        const first = (await runTool(tools, 'card_read', { greeting: 0 }, toolContext(fake))).data as Loose;
        expect(first).toMatchObject({ kind: 'first message', text: ANNA.first_mes });
        const missing = await runTool(tools, 'card_read', { greeting: 40 }, toolContext(fake));
        expect(missing.summary).toBe(
            'No starting scene 40: the card has the first message and 25 alternate greetings.',
        );
        const all = (await runTool(tools, 'card_read', { part: 'greetings' }, toolContext(fake))).data as Loose;
        expect(all.items).toHaveLength(26);
        expect(all.items[0]).toMatchObject({ n: 0, kind: 'first message' });
        expect(jsonSize(all)).toBeLessThanOrEqual(11000);
        const book = (await runTool(tools, 'card_read', { part: 'book' }, toolContext(fake))).data as Loose;
        expect(book.items).toEqual([{ title: 'The letter', keys: ['letter'] }]);
        const depth = (await runTool(tools, 'card_read', { part: 'depth_prompt' }, toolContext(fake))).data as Loose;
        expect(depth).toMatchObject({ depth: 4, role: 'system', text: 'Anna hides a letter.' });
    });

    it('lists the members of a group chat and reads one by name', async () => {
        const fake = storyApp({
            ctx: {
                characterId: undefined,
                groupId: 'g1',
                groups: [{ id: 'g1', name: 'Party', members: ['anna.png', 'kai.png'], disabled_members: ['kai.png'] }],
            },
        });
        const tools = readTools(fake.app);
        const list = await runTool(tools, 'card_read', {}, toolContext(fake, { locale: 'ru' }));
        expect(list.summary).toBe('Группа «Party»: участников 2');
        expect(list.untrusted).toBe(true);
        expect((list.data as Loose).members).toEqual([
            { name: 'Anna', avatar: 'anna.png', description: ANNA.description, alternateGreetings: 3 },
            { name: 'Kai', avatar: 'kai.png', muted: true, description: 'Kai is a smuggler.' },
        ]);
        const kai = await runTool(tools, 'card_read', { name: 'kai' }, toolContext(fake));
        expect(kai.data).toMatchObject({ name: 'Kai', group: 'Party', firstMessage: 'Kai nods.' });
        expect((kai.data as Loose).greetingInChat).toBeUndefined();
        const nobody = await runTool(tools, 'card_read', { name: 'Zed' }, toolContext(fake));
        expect(nobody.summary).toBe('No card named «Zed» here.');
        expect(nobody.data).toMatchObject({ known: ['Anna', 'Kai'] });
    });

    it('loads a shallow card first and answers without a character', async () => {
        const shallow = { name: 'Anna', avatar: 'anna.png', shallow: true };
        const characters: unknown[] = [shallow];
        let loaded = 0;
        const fake = storyApp({
            ctx: {
                characters,
                unshallowCharacter: async (id: number) => {
                    loaded++;
                    characters[id] = ANNA;
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'card_read', {}, toolContext(fake));
        expect(loaded).toBe(1);
        expect((output.data as Loose).description).toBe(ANNA.description);
        const none = fakeApp();
        const empty = await runTool(readTools(none.app), 'card_read', {}, toolContext(none, { locale: 'ru' }));
        expect(empty.summary).toBe('Карточка персонажа не открыта.');
        const other = await runTool(readTools(fake.app), 'card_read', { name: 'Kai' }, toolContext(fake));
        expect(other.summary).toBe('No card named «Kai» here.');
    });
});

describe('persona_read', () => {
    const power = {
        persona_description: `Alex is tall. ${'x'.repeat(5000)}`,
        persona_description_position: 4,
        persona_description_depth: 2,
        persona_description_role: 0,
        persona_description_lorebook: 'Alex book',
        personas: { 'me.png': 'Alex' },
        default_persona: 'me.png',
        persona_descriptions: {
            'me.png': { title: 'Traveller', connections: [{ type: 'character', id: 'anna.png' }] },
        },
    };

    it('gives the description (cut), its place in the prompt and the lock states', async () => {
        const fake = storyApp({ ctx: { powerUserSettings: power, chatMetadata: { persona: 'me.png' } } });
        setPersonaModule(fake, 'me.png');
        const output = await runTool(readTools(fake.app), 'persona_read', {}, toolContext(fake, { locale: 'ru' }));
        const data = output.data as Loose;
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Персона: Alex (закреплена за чатом)');
        expect(data).toMatchObject({
            name: 'Alex',
            avatar: 'me.png',
            title: 'Traveller',
            size: power.persona_description.length,
            position: 'in the chat at a depth',
            depth: 2,
            role: 'system',
            lorebook: 'Alex book',
            lock: { chat: true, character: true, default: true },
            connections: 1,
        });
        expect(data.description.length).toBeLessThanOrEqual(3000);
    });

    it('finds the avatar by name when personas.js is not there', async () => {
        const fake = storyApp({ ctx: { powerUserSettings: { ...power, persona_description_position: 0 } } });
        const output = await runTool(readTools(fake.app), 'persona_read', {}, toolContext(fake));
        expect(output.summary).toBe('Persona: Alex (connected to this character)');
        expect(output.data).toMatchObject({ avatar: 'me.png', position: 'in the prompt (after the card)' });
        expect((output.data as Loose).depth).toBeUndefined();
        const unknown = fakeApp({ ctx: { name1: 'Nobody' } });
        const bare = await runTool(readTools(unknown.app), 'persona_read', {}, toolContext(unknown));
        expect(bare.data).toMatchObject({ name: 'Nobody', lock: { chat: false, character: false, default: false } });
        expect((bare.data as Loose).note).toMatch(/avatar is unknown/);
    });
});

describe('scenario_overview', () => {
    const MAGIC: MechanicDef = {
        id: 'magic',
        name: 'Магия',
        summary: 'Mana.',
        rules: 'Spells cost mana.',
        attributes: [{ id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100 }],
        holders: { kind: 'characters' },
        checks: [{ id: 'cast', name: 'Колдовство', promptName: 'Cast', dice: '1d20', difficulty: 10, triggers: [] }],
        tracking: 'block',
        scope: { kind: 'global' },
    };

    it('joins the card, starting scenes, latest messages, tracker, mechanics and lorebooks', async () => {
        const fake = storyApp({
            apis: {
                mechanics: {
                    list: () => [MAGIC],
                    active: () => [MAGIC],
                    templates: () => [{ id: 'health', titleKey: 'tpl.health', descriptionKey: 'x', build: () => ({}) }],
                },
                director: { scene: () => ({ type: 'dialogue', confidence: 1, messageIndex: 2, by: 'rules' }) },
                loreJournal: { whyActive: async () => [{ book: 'Northern World' }, { book: 'Common' }] },
            },
            strings: { en: { 'tpl.health': 'Health and stamina' } },
            ctx: { powerUserSettings: { persona_description: 'Alex is tall.' } },
        });
        const output = await runTool(readTools(fake.app), 'scenario_overview', { messages: 3 }, toolContext(fake));
        const data = output.data as Loose;
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Scenario: Anna, 6 messages');
        expect(data.chat).toEqual({ messages: 6, character: 'Anna', scene: 'dialogue' });
        expect(data.card).toMatchObject({ name: 'Anna', scenario: ANNA.scenario, world: 'Northern World' });
        expect(data.persona).toEqual({ name: 'Alex', description: 'Alex is tall.' });
        expect(data.startingScenes.total).toBe(4);
        expect(data.startingScenes.chatOpenedWith).toBe(2);
        expect(data.startingScenes.items.map((item: Loose) => item.n)).toEqual([0, 1, 2, 3]);
        expect(data.recent.map((row: Loose) => row.index)).toEqual([3, 4, 5]);
        expect(data.tracker).toMatchObject({
            message: 2,
            location: 'Tavern',
            present: ['Anna'],
            offScene: ['Kai'],
            quests: { main: 'Find the map' },
        });
        expect(data.mechanics.existing).toEqual([
            {
                id: 'magic',
                name: 'Магия',
                active: true,
                holders: 'characters',
                attributes: ['Мана: number 0–100'],
                checks: ['Колдовство'],
            },
        ]);
        expect(data.mechanics.templates).toEqual([{ id: 'health', title: 'Health and stamina' }]);
        expect(data.lorebooks).toEqual({ active: ['Northern World', 'Common'], card: 'Northern World' });
        expect(data.next).toContain('mechanic_save');
        const ru = await runTool(readTools(fake.app), 'scenario_overview', {}, toolContext(fake, { locale: 'ru' }));
        expect(ru.summary).toBe('Сценарий: Anna, сообщений 6');
        expect((ru.data as Loose).recent).toHaveLength(6);
    });

    it('keeps greetings short, fits the size cap, and says when mechanics are off', async () => {
        const huge = {
            ...ANNA,
            description: 'D'.repeat(20000),
            data: { ...ANNA.data, alternate_greetings: Array.from({ length: 30 }, () => 'G'.repeat(3000)) },
        };
        const fake = fakeApp({
            chat: Array.from({ length: 40 }, () => msg('M'.repeat(5000))),
            ctx: { characters: [huge], characterId: 0 },
        });
        const output = await runTool(readTools(fake.app), 'scenario_overview', { messages: 20 }, toolContext(fake));
        const data = output.data as Loose;
        expect(jsonSize(data)).toBeLessThanOrEqual(11000);
        expect(data.startingScenes.items).toHaveLength(31);
        expect(data.startingScenes.items.every((item: Loose) => item.text.length <= 400)).toBe(true);
        expect(data.recent).toHaveLength(20);
        expect(data.mechanics).toMatchObject({ off: true });
        expect(data.tracker).toBeUndefined();
    });

    it('lists the members in a group chat', async () => {
        const fake = storyApp({
            ctx: {
                characterId: undefined,
                groupId: 'g1',
                groups: [{ id: 'g1', name: 'Party', members: ['anna.png', 'kai.png'] }],
                chatMetadata: { scenario: 'A heist.' },
            },
        });
        const output = await runTool(readTools(fake.app), 'scenario_overview', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(output.summary).toBe('Scenario: Party, 6 messages');
        expect(data.card).toBeUndefined();
        expect(data.members.map((member: Loose) => member.name)).toEqual(['Anna', 'Kai']);
        expect(data.groupScenario).toBe('A heist.');
    });
});

describe('the system prompt and the guide', () => {
    it('points the model at the chat, card, persona and overview tools', () => {
        const prompt = buildSystemPrompt({ locale: 'ru', chatOpen: true });
        for (const name of ['chat_read', 'chat_search', 'card_read', 'persona_read', 'scenario_overview']) {
            expect(prompt).toContain(`\`${name}\``);
        }
        expect(prompt).toMatch(/scenario_overview`, then one `mechanic_save` per proposal/);
    });

    it('has a guide on how the assistant reads the chat and the card', () => {
        const topics = knowledgeBase();
        const guide = topics.find((topic) => topic.id === 'guide.chat-card');
        expect(guide?.title).toEqual({
            en: 'How the assistant reads the chat and the card',
            ru: 'Как ассистент читает чат и карточку',
        });
        expect(guide?.body.en).toContain('scenario_overview');
        expect(guide?.body.ru).toContain('chat_read');
        const first = (query: string, locale: 'en' | 'ru') => searchDocs(topics, query, { locale })[0]?.id;
        expect(first('как ассистент читает чат и карточку', 'ru')).toBe('guide.chat-card');
        expect(first('стартовые сцены карточки', 'ru')).toBe('guide.chat-card');
        expect(first('how does the assistant read the chat', 'en')).toBe('guide.chat-card');
    });
});
