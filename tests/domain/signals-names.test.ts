import { describe, expect, it } from 'vitest';
import { findNameCandidates, isKnownName, knownNameKeys, nameKey } from '../../src/domain/signals-names';

const names = (text: string) => findNameCandidates(text).map((candidate) => candidate.name);

describe('findNameCandidates', () => {
    it('finds capitalised names in the middle of English sentences', () => {
        expect(names('Anna smiled at the stranger. The man called himself Marcus Blackwood and bowed.')).toEqual([
            'Marcus Blackwood',
        ]);
        expect(names('They rode toward the Order of Dawn and then to Ravenholm.')).toEqual([
            'Order of Dawn',
            'Ravenholm',
        ]);
    });

    it('skips sentence starts, dialogue openings, titles and common words', () => {
        expect(names('"Hello," she said. Then Marcus left.')).toEqual(['Marcus']);
        expect(names('Yes. I know. Oh, God, please! It is Monday in March.')).toEqual([]);
        expect(names('She bowed to Lord Ashford and Mr. Hale.')).toEqual(['Ashford', 'Hale']);
        expect(names('*Damn.* Marcus grinned.')).toEqual([]);
        expect(names('the NASA logo and an X mark')).toEqual([]);
        expect(names('a man named Al')).toEqual([]);
    });

    it('finds Russian names, not dialogue or sentence starts', () => {
        expect(names('— Привет, — сказала Анна и посмотрела на Кирилла.')).toEqual(['Анна', 'Кирилла']);
        expect(names('Вы правы, сэр. Да, господин Волков.')).toEqual(['Волков']);
    });

    it('finds «quoted» names after a common noun, not direct speech', () => {
        const found = findNameCandidates('Они зашли в таверну «Ржавый якорь». Он сказал: «Беги». Его звали «Хромой».');
        expect(found).toEqual([
            { name: 'Ржавый якорь', key: nameKey('Ржавый якорь'), quoted: true },
            { name: 'Хромой', key: nameKey('Хромой'), quoted: true },
        ]);
        expect(findNameCandidates('they called it "Shadow" and laughed').map((item) => item.quoted)).toEqual([true]);
        expect(names('она ответила «Нет» и ушла')).toEqual([]);
        expect(names('он прочёл «Это было давно, очень давно»')).toEqual([]);
        expect(names('ship «A»')).toEqual([]);
    });

    it('deduplicates by key and caps the list', () => {
        expect(names('they met Marcus, then Marcus again')).toEqual(['Marcus']);
        const many = Array.from({ length: 30 }, (_, i) => `and Name${String.fromCharCode(97 + (i % 26))}x${i}`).join(
            ' ',
        );
        expect(findNameCandidates(many).length).toBe(20);
        expect(findNameCandidates('')).toEqual([]);
        expect(findNameCandidates(undefined as unknown as string)).toEqual([]);
    });
});

describe('known names', () => {
    it('keys Russian case forms together', () => {
        expect(nameKey('Блэквуда')).toBe(nameKey('Блэквуд'));
        expect(nameKey('Order of Dawn')).toBe('order dawn');
    });

    it('knows a name by its key or any of its words', () => {
        const known = knownNameKeys(['Anna Petrova', 'Кирилл', '', 42]);
        expect(isKnownName(nameKey('Anna'), known)).toBe(true);
        expect(isKnownName(nameKey('Petrova'), known)).toBe(true);
        expect(isKnownName(nameKey('Кирилла'), known)).toBe(true);
        expect(isKnownName(nameKey('Marcus Petrova'), known)).toBe(true);
        expect(isKnownName(nameKey('Marcus'), known)).toBe(false);
    });
});
