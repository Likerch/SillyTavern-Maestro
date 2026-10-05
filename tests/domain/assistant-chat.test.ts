// The assistant's pure readers of the story (M33, 1.10.0): message views, the DES tracker summary (per-swipe record
// and the together-mode JSON in the text), word search with Russian forms, the card's fields and starting scenes,
// the persona's avatar and lock states.
import { describe, expect, it } from 'vitest';
import {
    cardView,
    greetingInChat,
    latestTracker,
    leadingTrackerJson,
    matchTerms,
    messageRole,
    messageTracker,
    messageView,
    personaAvatarByName,
    personaLock,
    searchTerms,
    snippetAround,
    trackerBrief,
    trackerScene,
} from '../../src/domain/assistant-chat';

const TRACKER_JSON = {
    infoBox: { location: 'Tavern «Oak»', date: 'Day 3', time: { start: '18:00', end: '19:00' }, weather: '🌧 rain' },
    characters: [
        { name: 'Anna', relationship: { status: 'Friend' }, stats: { Health: 80 }, thoughts: 'Warm here.' },
        { name: 'Kai', thoughts: 'Not currently in the scene.' },
    ],
    quests: { main: 'Find the map', optional: ['Pay the debt'] },
};

function trackerMessage(text: string): Record<string, unknown> {
    return { name: 'Anna', is_user: false, is_system: false, mes: text, extra: {} };
}

describe('messages', () => {
    it('tells roles apart and marks hidden, system, swipes, dates and picture posts', () => {
        expect(messageRole({ is_user: true })).toBe('user');
        expect(messageRole({ is_user: false, extra: { type: 'narrator' } })).toBe('system');
        expect(messageRole({ is_user: false })).toBe('char');
        expect(messageRole(null)).toBe('char');
        const view = messageView(
            {
                name: 'Anna',
                is_user: false,
                is_system: true,
                send_date: 'October 5, 2026 3:24pm',
                mes: '<p>Hello <b>there</b></p> [nai:img:abc]',
                swipes: ['a', 'b', 'c'],
                swipe_id: 1,
                extra: {},
            },
            4,
        );
        expect(view).toEqual({
            index: 4,
            name: 'Anna',
            role: 'char',
            swipe: '2/3',
            date: 'October 5, 2026 3:24pm',
            hidden: true,
            text: 'Hello there',
        });
        const raw = messageView(
            { name: 'Sys', is_user: false, mes: '<i>x</i>', extra: { type: 'narrator' } },
            0,
            false,
        );
        expect(raw).toMatchObject({ role: 'system', system: 'narrator', text: '<i>x</i>' });
        expect(messageView({ name: 'N', mes: 'pic', send_date: 1700000000000, extra: { nai_studio: {} } }, 1)).toEqual({
            index: 1,
            name: 'N',
            role: 'char',
            date: new Date(1700000000000).toISOString(),
            image: true,
            text: '',
        });
    });
});

describe('DES tracker', () => {
    it('reads the per-swipe record DES keeps', () => {
        const message = {
            ...trackerMessage('Story.'),
            swipe_id: 0,
            extra: {
                dooms_tracker_swipes: [
                    {
                        infoBox: JSON.stringify(TRACKER_JSON.infoBox),
                        characterThoughts: JSON.stringify(TRACKER_JSON.characters),
                        quests: JSON.stringify(TRACKER_JSON.quests),
                    },
                ],
            },
        };
        expect(trackerBrief(messageTracker(message))).toEqual({
            location: 'Tavern «Oak»',
            time: 'Day 3, 18:00–19:00',
            present: ['Anna'],
        });
    });

    it('falls back to the together-mode JSON at the start of the text, and the text is cleaned of it', () => {
        const text = `\`\`\`json\n${JSON.stringify(TRACKER_JSON)}\n\`\`\`\nShe smiled.`;
        expect(leadingTrackerJson(text)).toMatchObject({ quests: { main: 'Find the map' } });
        expect(leadingTrackerJson('No tracker here.')).toBeNull();
        const message = trackerMessage(text);
        const scene = trackerScene(messageTracker(message));
        expect(scene).toMatchObject({
            location: 'Tavern «Oak»',
            present: ['Anna'],
            offScene: ['Kai'],
            weather: '🌧 rain',
            quests: { main: 'Find the map', optional: ['Pay the debt'] },
        });
        expect(scene?.characters?.[0]).toEqual({ name: 'Anna', relationship: 'Friend', stats: 'Health 80' });
        expect(messageView(message, 0).text).toBe('She smiled.');
        expect(messageTracker({ ...message, is_user: true })).toBeNull();
        expect(trackerBrief(null)).toBeNull();
    });

    it('finds the latest message with a tracker', () => {
        const chat = [
            trackerMessage(`{"infoBox": {"location": "Gate"}}\nOld.`),
            { name: 'User', is_user: true, mes: 'Go' },
            trackerMessage('No JSON.'),
        ];
        expect(latestTracker(chat)).toMatchObject({ index: 0 });
        expect(trackerBrief(latestTracker(chat)!.snapshot)).toEqual({ location: 'Gate' });
        expect(latestTracker([])).toBeNull();
    });
});

describe('search', () => {
    it('matches Russian case forms, ё = е and English endings', () => {
        expect(searchTerms('Анну и ёлку')).toEqual(['анн', 'елк']);
        const text = 'Вчера Анна принесла ЕЛКИ домой, а потом убедила Кая.';
        expect(matchTerms(text, searchTerms('Анну'))).toEqual({ matched: 1, at: 6 });
        expect(matchTerms(text, searchTerms('ёлка'))?.matched).toBe(1);
        expect(matchTerms(text, searchTerms('убедить Кай'))?.matched).toBe(2);
        expect(matchTerms('The swords were drawn.', searchTerms('sword drawing'))?.matched).toBe(2);
        expect(matchTerms(text, searchTerms('дракон'))).toBeNull();
        expect(matchTerms('', ['анн'])).toBeNull();
        expect(searchTerms('и а')).toEqual([]);
    });

    it('cuts a snippet around the match on word boundaries', () => {
        const text = `${'word '.repeat(60)}TARGET ${'tail '.repeat(60)}`;
        const snippet = snippetAround(text, text.indexOf('TARGET'), 40);
        expect(snippet.startsWith('…word')).toBe(true);
        expect(snippet.endsWith('tail…')).toBe(true);
        expect(snippet).toContain('TARGET');
        expect(snippetAround('short text', 0)).toBe('short text');
    });
});

describe('card', () => {
    const character = {
        name: 'Anna',
        avatar: 'anna.png',
        description: 'A ranger.',
        personality: 'Brave.',
        scenario: 'A war.',
        first_mes: 'Hello, {{user}}! The rain has not stopped for three days and the road is gone.',
        mes_example: '<START>',
        creatorcomment: 'Old notes',
        tags: ['fantasy'],
        data: {
            name: 'Anna',
            description: 'A ranger (data).',
            alternate_greetings: [
                'At the gate, {{user}} waits while the guards argue about the toll for the night.',
                '  ',
                'In the tavern, {{char}} counts the coins that are left after the long winter.',
            ],
            creator_notes: 'Use with DES.',
            system_prompt: 'Be vivid.',
            post_history_instructions: 'Stay in character.',
            tags: ['fantasy', 'ranger'],
            extensions: {
                world: 'Anna World',
                depth_prompt: { prompt: 'Anna hides a secret.', depth: 4, role: 'system' },
            },
            character_book: {
                name: 'Anna book',
                entries: [
                    { keys: ['sword'], comment: 'Sword', enabled: true },
                    { keys: ['map'], comment: '', enabled: false },
                ],
            },
            creator: 'someone',
            character_version: '2',
        },
    };

    it('reads the fields SillyTavern uses (top level first) and the V2-only ones', () => {
        const card = cardView(character)!;
        expect(card).toMatchObject({
            name: 'Anna',
            avatar: 'anna.png',
            description: 'A ranger.',
            personality: 'Brave.',
            scenario: 'A war.',
            examples: '<START>',
            creatorNotes: 'Use with DES.',
            systemPrompt: 'Be vivid.',
            postHistory: 'Stay in character.',
            depthPrompt: { text: 'Anna hides a secret.', depth: 4, role: 'system' },
            tags: ['fantasy', 'ranger'],
            world: 'Anna World',
            creator: 'someone',
            version: '2',
        });
        expect(card.alternateGreetings).toHaveLength(2);
        expect(card.book).toEqual({
            name: 'Anna book',
            entries: [
                { title: 'Sword', keys: ['sword'], enabled: true },
                { title: 'map', keys: ['map'], enabled: false },
            ],
        });
        expect(cardView({ name: 'Bare', data: { description: 'From data.' } })).toMatchObject({
            description: 'From data.',
            alternateGreetings: [],
            depthPrompt: null,
            book: null,
        });
        expect(cardView(null)).toBeNull();
    });

    it('tells which starting scene the chat opened with (swipes, else the text)', () => {
        const card = cardView(character)!;
        const bySwipe = [{ name: 'Anna', is_user: false, mes: 'x', swipes: ['a', 'b', 'c'], swipe_id: 2 }];
        expect(greetingInChat(bySwipe, card)).toBe(2);
        const byText = [
            {
                name: 'Anna',
                is_user: false,
                mes: 'At the gate, Alex waits while the guards argue about the toll for the night.',
            },
        ];
        expect(greetingInChat(byText, card)).toBe(1);
        expect(greetingInChat([{ is_user: true, mes: 'hi' }], card)).toBeUndefined();
        expect(greetingInChat([{ is_user: false, mes: 'Something else entirely, nothing alike.' }], card)).toBe(
            undefined,
        );
        expect(greetingInChat([], card)).toBeUndefined();
    });
});

describe('persona', () => {
    const power = {
        personas: { 'me.png': 'Alex', 'twin.png': 'Sam', 'twin2.png': 'Sam' },
        default_persona: 'me.png',
        persona_descriptions: {
            'me.png': {
                description: 'Tall.',
                connections: [
                    { type: 'character', id: 'anna.png' },
                    { type: 'group', id: 'g1' },
                ],
            },
        },
    };

    it('finds the avatar by a unique name', () => {
        expect(personaAvatarByName(power, 'Alex')).toBe('me.png');
        expect(personaAvatarByName(power, 'Sam')).toBeUndefined();
        expect(personaAvatarByName({}, 'Alex')).toBeUndefined();
    });

    it('computes the lock states like ST', () => {
        expect(personaLock(power, { persona: 'me.png' }, 'me.png', { characterAvatar: 'anna.png' })).toEqual({
            chat: true,
            character: true,
            default: true,
        });
        expect(personaLock(power, {}, 'me.png', { characterAvatar: 'kai.png' })).toEqual({
            chat: false,
            character: false,
            default: true,
        });
        expect(personaLock(power, {}, 'me.png', { characterAvatar: 'anna.png', groupId: 'g1' }).character).toBe(true);
        expect(personaLock(power, {}, 'me.png', { groupId: 'g2' }).character).toBe(false);
        expect(personaLock(power, { persona: 'me.png' }, '', {})).toEqual({
            chat: false,
            character: false,
            default: false,
        });
    });
});
