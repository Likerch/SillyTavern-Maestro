import { describe, expect, it } from 'vitest';
import { CERTAIN, analyseContradictions, quickContradictions, roleKey } from '../../src/domain/contradictions-rules';
import type { RuleHit } from '../../src/domain/contradictions-rules';

const check = (statement: string, entities: string[], text: string, label = 'canon') =>
    analyseContradictions({ statement, entities, against: [{ label, text }] });

const only = (hits: RuleHit[]) => hits.map((hit) => [hit.kind, hit.confidence]);

describe('contradiction rules: numbers', () => {
    it('finds different ages of the same person (English and Russian)', () => {
        const english = check('Anna is 25 years old.', ['Anna'], 'Anna is a healer. She is 30 years old.');
        expect(english.hits).toEqual([
            {
                label: 'canon',
                statement: 'Anna is 25 years old.',
                conflicting: 'She is 30 years old.',
                kind: 'number',
                confidence: 0.65,
            },
        ]);
        expect(english.suspicious).toBe(true);
        expect(only(check('Anna is 25-year-old.', ['Anna'], 'Anna is 30 years old.').hits)).toEqual([['number', 0.85]]);
        expect(only(check('Анне 25 лет.', ['Анна'], 'Анне было 30 лет.').hits)).toEqual([['number', 0.85]]);
        expect(only(check('Anna, aged 25, came.', ['Anna'], 'Anna is 30.').hits)).toEqual([['number', 0.85]]);
        expect(only(check('Анна — 25-летняя целительница.', ['Анна'], 'Анне 30 лет.').hits)).toEqual([
            ['number', 0.85],
        ]);
    });

    it('compares counts of the same thing, not durations or other subjects', () => {
        expect(only(check('Anna has two brothers.', ['Anna'], 'Anna has three brothers and a sister.').hits)).toEqual([
            ['number', 0.6],
        ]);
        expect(only(check('Анна прожила там 5 лет назад.', ['Анна'], 'Анне 30 лет.').hits)).toEqual([]);
        expect(only(check('Через 5 лет Анна вернулась.', ['Анна'], 'Анне 30 лет.').hits)).toEqual([]);
        expect(check('Anna is 25 years old.', ['Anna'], 'The tavern is 200 years old.').hits).toEqual([]);
        expect(check('Anna stood at 18:30.', ['Anna'], 'Anna stood at 19:30.').hits).toEqual([]);
        expect(check('Anna is 25 years old.', ['Anna'], 'Anna is 25 years old.').hits).toEqual([]);
    });

    it('works without entities on shared words', () => {
        expect(
            only(
                quickContradictions({
                    statement: 'The tavern has 3 floors.',
                    entities: [],
                    against: [{ label: 'x', text: 'The tavern has 2 floors and a cellar.' }],
                }),
            ),
        ).toEqual([['number', 0.6]]);
        // Capitalised names of the statement stand in for entities.
        expect(
            only(
                quickContradictions({
                    statement: 'Marcus owns 3 ships.',
                    entities: [],
                    against: [{ label: 'x', text: 'Marcus owns 5 ships.' }],
                }),
            ),
        ).toEqual([['number', 0.6]]);
    });
});

describe('contradiction rules: dates', () => {
    it('finds different years of the same event', () => {
        expect(only(check('Anna was born in 1850.', ['Anna'], 'Anna was born in 1852 in Ravenholm.').hits)).toEqual([
            ['date', 0.85],
        ]);
        expect(only(check('Анна родилась в 1850 году.', ['Анна'], 'Анна родилась в 1852 году.').hits)).toEqual([
            ['date', 0.85],
        ]);
        expect(only(check('Анна родилась в 1850 году.', ['Анна'], 'Анна родился в 1852 году.').hits)).toEqual([
            ['date', 0.85],
        ]);
    });

    it('compares days and months, needs a shared event word', () => {
        expect(
            only(check('The feast of Anna is on March 5, 1856.', ['Anna'], 'Anna holds the feast on 7 March.').hits),
        ).toEqual([['date', 0.6]]);
        expect(check('Anna was born in 1850.', ['Anna'], 'Anna moved to Ravenholm in 1870.').hits).toEqual([]);
        expect(check('Anna was born on March 5.', ['Anna'], 'Anna was born on March 5, 1850.').hits).toEqual([]);
        expect(only(check('Anna married in 1870.', ['Anna'], 'Anna married in 1871.').hits)).toEqual([['date', 0.85]]);
    });
});

describe('contradiction rules: negations', () => {
    it('finds the same claim with and without a negation', () => {
        expect(only(check('Anna can use magic.', ['Anna'], 'Anna cannot use magic.').hits)).toEqual([
            ['negation', 0.85],
        ]);
        expect(only(check('Анна умеет колдовать.', ['Анна'], 'Анна не умеет колдовать.').hits)).toEqual([
            ['negation', 0.85],
        ]);
        expect(
            only(
                check('Ivan is no longer the captain of the Swift.', ['Ivan'], 'Ivan is the captain of the Swift.')
                    .hits,
            ),
        ).toEqual([['negation', 0.85]]);
        expect(only(check('Иван больше не капитан «Стрижа».', ['Иван'], 'Иван — капитан «Стрижа».').hits)).toEqual([
            ['negation', 0.85],
        ]);
        expect(only(check('Anna never lies.', ['Anna'], 'Anna lies often to strangers.').hits)).toEqual([]);
        expect(only(check('Anna can use magic.', ['Anna'], "Anna can't use magic since the curse.").hits)).toEqual([
            ['negation', 0.65],
        ]);
    });

    it('ignores claims about other people', () => {
        expect(check('Anna can use magic.', ['Anna', 'Ivan'], 'Ivan cannot use magic.').hits).toEqual([]);
    });
});

describe('contradiction rules: names', () => {
    it('finds two holders of one exclusive role', () => {
        expect(only(check('Peter is the father of Anna.', ['Anna'], "Anna's father is Marcus.").hits)).toEqual([
            ['name', 0.75],
        ]);
        expect(only(check('The father of Anna is Peter.', ['Anna'], 'Marcus is the father of Anna.').hits)).toEqual([
            ['name', 0.75],
        ]);
        expect(only(check('Peter is Anna’s father.', [], 'The father of Anna was called Marcus.').hits)).toEqual([
            ['name', 0.75],
        ]);
        expect(only(check('Отец Анны — Пётр.', ['Анна'], 'Отцом Анны является Марк.').hits)).toEqual([['name', 0.75]]);
        expect(only(check('Анна является женой Ивана.', ['Анна'], 'Жена Ивана — Мария.').hits)).toEqual([
            ['name', 0.75],
        ]);
    });

    it('rates shared roles low and skips indefinite ones and the same person', () => {
        expect(only(check('Анна — сестра Ивана.', ['Анна', 'Иван'], 'Сестра Ивана — Мария.').hits)).toEqual([
            ['name', 0.45],
        ]);
        expect(check('Anna is a sister of Ivan.', ['Anna'], 'Maria is the sister of Ivan.').hits).toEqual([]);
        expect(check('Anna is the wife of Ivan.', ['Anna'], 'Anna Petrova is the wife of Ivan.').hits).toEqual([]);
        expect(check('Anna is the wife of Ivan.', ['Anna'], 'Anna is the wife of Ivan.').hits).toEqual([]);
        expect(check('Anna — красавица Ивана.', ['Anna'], 'Мария — красавица Ивана.').hits).toEqual([]);
    });

    it('finds one person in two exclusive family roles', () => {
        expect(only(check("Anna is Ivan's sister.", ['Anna'], "Anna is Ivan's wife.").hits)).toEqual([['name', 0.5]]);
        expect(check("Anna is Ivan's sister.", ['Anna'], "Anna is Ivan's friend.").hits).toEqual([]);
    });

    it('maps role words to stems', () => {
        expect(roleKey('отцом')).toBe('отец');
        expect(roleKey('матери')).toBe('мать');
        expect(roleKey('fathers')).toBe('father');
        expect(roleKey('table')).toBeNull();
        expect(roleKey('')).toBeNull();
    });
});

describe('contradiction rules: input and suspicion', () => {
    it('handles empty and junk input', () => {
        expect(analyseContradictions({ statement: '', entities: [], against: [{ label: 'a', text: 'x' }] })).toEqual({
            hits: [],
            suspicious: false,
        });
        expect(analyseContradictions({ statement: 'Anna is 25.', entities: ['Anna'], against: [] })).toEqual({
            hits: [],
            suspicious: false,
        });
        expect(
            analyseContradictions({
                statement: 5 as unknown as string,
                entities: null as unknown as string[],
                against: null as unknown as [],
            }),
        ).toEqual({ hits: [], suspicious: false });
        expect(
            analyseContradictions({
                statement: 'Anna is 25 years old.',
                entities: ['Anna', '', 5 as unknown as string, 'Al'],
                against: [
                    { label: 'a', text: '' },
                    { label: 'b', text: 'Anna is 30 years old.' },
                ],
            }).hits.map((hit) => hit.label),
        ).toEqual(['b']);
    });

    it('is suspicious when figures meet figures, or a negation meets a similar claim, even without a hit', () => {
        expect(check('Anna has 3 swords.', ['Anna'], 'Anna was born in 1850.').suspicious).toBe(true);
        expect(
            check('Anna does not trust Ivan anymore.', ['Anna'], 'Anna trusts Ivan and his brother completely.')
                .suspicious,
        ).toBe(true);
        expect(check('Anna loves Ivan.', ['Anna'], 'Anna is a healer from Ravenholm.').suspicious).toBe(false);
        expect(check('Anna is 25 years old.', ['Anna'], 'Anna is 25 years old.').suspicious).toBe(true);
    });

    it('keeps certain hits certain and sorts by confidence', () => {
        const result = analyseContradictions({
            statement: 'Anna was born in 1850. Anna has two brothers.',
            entities: ['Anna'],
            against: [
                { label: 'a', text: 'Anna has three brothers.' },
                { label: 'b', text: 'Anna was born in 1852.' },
            ],
        });
        expect(result.hits.map((hit) => [hit.label, hit.kind])).toEqual([
            ['b', 'date'],
            ['a', 'number'],
        ]);
        expect(result.hits[0]!.confidence).toBeGreaterThanOrEqual(CERTAIN);
    });

    it('cuts long quotes', () => {
        const long = `Anna is 25 years old and ${'very '.repeat(60)}tall.`;
        const [hit] = check(long, ['Anna'], 'Anna is 30 years old.').hits;
        expect(hit!.statement.length).toBeLessThanOrEqual(161);
        expect(hit!.statement.endsWith('…')).toBe(true);
    });
});
