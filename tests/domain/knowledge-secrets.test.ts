import { describe, expect, it } from 'vitest';
import type { NameInfo } from '../../src/domain/knowledge-facts';
import { parseSecretKnowers, secretKnownBy, secretTopics } from '../../src/domain/knowledge-secrets';

const PEOPLE: NameInfo[] = [
    { name: 'Anna', aliases: ['Annie'], forms: ['Анна', 'Анны', 'Анной'] },
    { name: 'Bob' },
    { name: 'Corvin', forms: ['Корвин', 'Корвина'] },
    { name: 'Kai', forms: ['Кай', 'Кая'] },
    { name: 'Duke Varr' },
];

function parse(value: string) {
    return parseSecretKnowers(value, PEOPLE);
}

describe('who knows a secret', () => {
    it('reads knowers', () => {
        expect(parse('Anna is a spy for Duke Varr; only Bob knows.')).toEqual({ knows: ['Bob'], unaware: [] });
        expect(parse('Anna and Bob know that Corvin stole the ring.')).toEqual({ knows: ['Anna', 'Bob'], unaware: [] });
        expect(parse('The plan is known only to Anna, Bob and Corvin.')).toEqual({
            knows: ['Anna', 'Bob', 'Corvin'],
            unaware: [],
        });
        expect(parse('Anna confided to Kai that she is ill.')).toEqual({ knows: ['Anna', 'Kai'], unaware: [] });
        expect(parse('Bob told Corvin everything.')).toEqual({ knows: ['Bob', 'Corvin'], unaware: [] });
        expect(parse('Corvin was told about the map.')).toEqual({ knows: ['Corvin'], unaware: [] });
        expect(parse('Annie’s brother found out.')).toEqual({ knows: [], unaware: [] });
        expect(parse('Annie found out.')).toEqual({ knows: ['Anna'], unaware: [] });
    });

    it('reads the unaware, who never count as knowers', () => {
        expect(parse('Anna is pregnant; Kai does not know.')).toEqual({ knows: [], unaware: ['Kai'] });
        expect(parse("Bob and Corvin don't know about the ring.")).toEqual({ knows: [], unaware: ['Bob', 'Corvin'] });
        expect(parse('Kai is still unaware of the debt.')).toEqual({ knows: [], unaware: ['Kai'] });
        expect(parse('The truth is hidden from Bob and Corvin.')).toEqual({ knows: [], unaware: ['Bob', 'Corvin'] });
        expect(parse('Anna left without Kai knowing.')).toEqual({ knows: [], unaware: ['Kai'] });
        expect(parse('Anna left without Kai.')).toEqual({ knows: [], unaware: [] });
        expect(parse('Bob knows, but Kai doesn’t know that Bob knows.')).toEqual({ knows: ['Bob'], unaware: ['Kai'] });
        expect(parse('Kai knew nothing; Kai never knew.')).toEqual({ knows: [], unaware: ['Kai'] });
    });

    it('needs whole names and gives nothing for an empty statement', () => {
        expect(parse('Bobby knows.')).toEqual({ knows: [], unaware: [] });
        expect(parse('')).toEqual({ knows: [], unaware: [] });
        expect(parseSecretKnowers('Bob knows.', [])).toEqual({ knows: [], unaware: [] });
    });

    it('falls back to the cast of the source turn, adds the subject, drops the unaware', () => {
        expect(secretKnownBy({ knows: ['Bob'], unaware: [] }, { cast: ['Anna', 'Kai'], subject: 'Anna' })).toEqual([
            'Anna',
            'Bob',
        ]);
        expect(secretKnownBy({ knows: [], unaware: ['Kai'] }, { cast: ['Anna', 'Kai', 'Bob'] })).toEqual([
            'Anna',
            'Bob',
        ]);
        expect(secretKnownBy({ knows: [], unaware: ['anna'] }, { cast: ['Bob'], subject: 'Anna' })).toEqual(['Bob']);
    });
});

describe('secret topics', () => {
    it('names the subject and everyone the statement or the quote mentions, with their forms, then a few words', () => {
        expect(
            secretTopics('Anna is secretly a spy for Duke Varr.', 'Корвин видел, как она писала письмо.', {
                names: PEOPLE,
                subject: 'Anna',
                persona: ['Kai', 'Кай', 'Кая'],
            }),
        ).toEqual(['Anna', 'Annie', 'Анна', 'Анны', 'Анной', 'Duke Varr', 'Corvin', 'Корвин', 'Корвина']);
    });

    it('leaves the persona out and uses the lookup first', () => {
        expect(
            secretTopics('Kai owes money to the guild', '', {
                names: PEOPLE,
                persona: ['Kai', 'Кай', 'Кая'],
                lookup: (name) => (name === 'Kai' ? { name: 'Kai', forms: ['Кай', 'Каю'] } : null),
            }),
        ).toEqual(['Каю', 'money', 'guild']);
        expect(secretTopics('', '', { names: [] })).toEqual([]);
    });
});
