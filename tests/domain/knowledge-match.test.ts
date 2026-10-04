import { describe, expect, it } from 'vitest';
import type { KnowledgeFactData } from '../../src/domain/knowledge-facts';
import {
    castAt,
    factsOnTopic,
    lastUserIndex,
    recentStoryText,
    storyText,
    topicNeedles,
    unknownAmong,
    unknownFacts,
    unknownLine,
} from '../../src/domain/knowledge-match';

function fact(id: string, fields: Partial<KnowledgeFactData> = {}): KnowledgeFactData {
    return {
        id,
        text: `Fact ${id}`,
        topics: [],
        knownBy: [],
        secret: false,
        sourceMessage: 1,
        at: 1,
        ...fields,
    };
}

describe('topic needles', () => {
    it('lets Russian names take a case ending, from their stem too', () => {
        expect(topicNeedles('Анна')).toEqual([
            { needle: 'анна', tail: 2 },
            { needle: 'анн', tail: 3 },
        ]);
        expect(topicNeedles('Старый Мельник')).toEqual([{ needle: 'старый мельник', tail: 2 }]);
    });

    it('needs a right boundary for Latin names and a prefix for keywords', () => {
        expect(topicNeedles('Ann')).toEqual([{ needle: 'ann', tail: 0 }]);
        expect(topicNeedles('kiss')).toEqual([{ needle: 'kiss', tail: 3 }]);
        expect(topicNeedles('поцелуй')).toEqual([{ needle: 'поцел', tail: 6 }]);
        expect(topicNeedles('смерть')).toEqual([{ needle: 'смерт', tail: 6 }]);
        expect(topicNeedles('тайна')).toEqual([{ needle: 'тайн', tail: 6 }]);
        expect(topicNeedles('лиса')).toEqual([{ needle: 'лиса', tail: 6 }]);
        expect(topicNeedles('старая мельница')).toEqual([{ needle: 'старая мельница', tail: 6 }]);
    });

    it('skips needles that are too short to mean anything', () => {
        expect(topicNeedles('')).toEqual([]);
        expect(topicNeedles('A')).toEqual([]);
        expect(topicNeedles('ab')).toEqual([]);
        expect(topicNeedles('мир')).toEqual([]);
        expect(topicNeedles('Ив')).toEqual([{ needle: 'ив', tail: 2 }]);
    });

    it('normalises story text', () => {
        expect(storyText(' Ёлка\n  и  ЕЛЬ ')).toBe('елка и ель');
    });
});

describe('the topic came up', () => {
    const facts = [
        fact('anna', { topics: ['Anna', 'Анна', 'Анной'] }),
        fact('kiss', { topics: ['поцелуй', 'kiss'] }),
        fact('ann', { topics: ['Ann'] }),
        fact('map', { topics: ['карту'] }),
        fact('none', { topics: [] }),
    ];

    it('matches Russian forms with a left boundary', () => {
        expect(factsOnTopic(facts, 'Я говорил с Анной вчера.').map((item) => item.id)).toEqual(['anna']);
        expect(factsOnTopic(facts, 'Её поцеловали.').map((item) => item.id)).toEqual(['kiss']);
        expect(factsOnTopic(facts, 'Где карта?').map((item) => item.id)).toEqual(['map']);
        expect(factsOnTopic(facts, 'Ганна пришла').map((item) => item.id)).toEqual([]);
    });

    it('matches English words with their right boundary rules', () => {
        expect(factsOnTopic(facts, 'Ann said hello').map((item) => item.id)).toEqual(['ann']);
        expect(factsOnTopic(facts, 'An annual feast').map((item) => item.id)).toEqual([]);
        expect(factsOnTopic(facts, 'They kissed.').map((item) => item.id)).toEqual(['kiss']);
        expect(factsOnTopic(facts, '')).toEqual([]);
    });
});

describe('what a character does not know', () => {
    const facts = [
        fact('old', { text: 'Quest begun: Find the map', topics: ['карту'], knownBy: ['Anna'], sourceMessage: 2 }),
        fact('kiss', {
            text: 'Kiss involving Anna and Kai',
            topics: ['Anna'],
            knownBy: ['Anna', 'Kai'],
            sourceMessage: 5,
        }),
        fact('kiss2', { text: 'Kiss involving Anna and Kai', topics: ['Anna'], knownBy: ['Corvin'], sourceMessage: 7 }),
        fact('secret', { text: 'Anna is a spy', topics: ['Anna'], knownBy: ['Anna'], secret: true, sourceMessage: 1 }),
        fact('left', { text: 'Anna left the scene', topics: ['Anna'], knownBy: ['Kai'], sourceMessage: 9, at: 2 }),
        fact('came', { text: 'Anna joined the scene', topics: ['Anna'], knownBy: ['Kai'], sourceMessage: 9, at: 3 }),
    ];

    it('gives secrets first, then the newest, at most three, only when the topic came up', () => {
        const unknown = unknownFacts(facts, 'Bob', 'Анна? Anna! Где карту искать?');
        expect(unknown.map((item) => item.id)).toEqual(['secret', 'came', 'left']);
        expect(unknownFacts(facts, 'Bob', 'Где карту искать?').map((item) => item.id)).toEqual(['old']);
        expect(unknownFacts(facts, 'Bob', 'Nothing here.')).toEqual([]);
        expect(unknownFacts(facts, 'Bob', 'Anna', { max: 10 }).map((item) => item.id)).toEqual([
            'secret',
            'came',
            'left',
            'kiss2',
        ]);
    });

    it('leaves out what the character or one of its aliases knows, also from another fact with the same text', () => {
        expect(unknownFacts(facts, 'Corvin', 'Anna', { max: 10 }).map((item) => item.id)).toEqual([
            'secret',
            'came',
            'left',
        ]);
        expect(unknownFacts(facts, 'The Spy', 'Anna', { aliases: ['anna'] }).map((item) => item.id)).toEqual([
            'came',
            'left',
        ]);
        expect(unknownFacts(facts, '  ', 'Anna')).toEqual([]);
        const onTopic = factsOnTopic(facts, 'Anna');
        expect(unknownAmong(onTopic, facts, 'Kai', { max: 1 }).map((item) => item.id)).toEqual(['secret']);
    });

    it('writes the card line', () => {
        expect(unknownLine([{ text: 'Anna is a spy.' }, { text: 'Kiss involving Anna and Kai' }])).toBe(
            'Anna is a spy; Kiss involving Anna and Kai',
        );
        expect(unknownLine([])).toBe('');
    });
});

describe('recent story text', () => {
    const chat = [
        { mes: 'one', is_user: false },
        { mes: 'two', is_user: true },
        { mes: 'hidden', is_user: false, is_system: true },
        { mes: 'three <b>bold</b>', is_user: false },
        { mes: 'four', is_user: true },
        { mes: 'the reply being swiped', is_user: false },
    ];

    it('reads the last messages up to the user’s answer, without hidden ones', () => {
        expect(lastUserIndex(chat)).toBe(4);
        expect(recentStoryText(chat)).toBe('one\ntwo\nthree bold\nfour');
        expect(recentStoryText(chat, 2)).toBe('three bold\nfour');
    });

    it('counts messages that clean to nothing and reads to the end without a user message', () => {
        expect(recentStoryText([{ mes: 'a' }, { mes: '' }, null, { mes: 'b' }], 2)).toBe('b');
        expect(lastUserIndex([{ mes: 'a' }])).toBe(-1);
        expect(
            recentStoryText([{ mes: 'a' }, { mes: 'b' }], 4, (message) =>
                String((message as { mes: string }).mes).toUpperCase(),
            ),
        ).toBe('A\nB');
        expect(recentStoryText([])).toBe('');
    });
});

describe('the cast at a reply', () => {
    const tracker = (characters: unknown[] | null) => ({
        is_user: false,
        mes: 'reply',
        extra: {
            dooms_tracker_swipes: [
                { characterThoughts: characters ? JSON.stringify(characters) : null, infoBox: null, quests: null },
            ],
        },
    });
    const chat = [
        tracker([{ name: 'Anna' }, { name: 'Bob', present: false }, { name: 'Corvin' }]),
        { is_user: true, mes: 'go' },
        { is_user: false, is_system: true, mes: 'hidden' },
        tracker(null),
        { is_user: true, mes: 'on' },
    ];

    it('reads the reply’s tracker, or the nearest earlier one with characters', () => {
        expect(castAt(chat, 0)).toEqual(['Anna', 'Corvin']);
        expect(castAt(chat, 3)).toEqual(['Anna', 'Corvin']);
        expect(castAt(chat, 3, ['corvin'])).toEqual(['Anna']);
        expect(castAt(chat, 99)).toEqual(['Anna', 'Corvin']);
    });

    it('gives up after the look-back or without any tracker', () => {
        expect(castAt(chat, 3, [], 0)).toBeNull();
        expect(castAt([{ is_user: false, mes: 'plain' }], 0)).toBeNull();
        expect(castAt([], 0)).toBeNull();
    });
});
