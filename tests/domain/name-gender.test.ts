import { describe, expect, it } from 'vitest';
import { genderKey, nameGender } from '../../src/domain/name-gender';

describe('nameGender', () => {
    it('reads feminine names ending in -а/-я, also in Latin letters', () => {
        for (const name of ['Офелия', 'Вера', 'Мария Сергеевна', 'Anna', 'Ophelia Grey', 'Мира']) {
            expect(nameGender(name), name).toBe('f');
        }
    });

    it('knows male names and diminutives, and names ending in -й', () => {
        for (const name of ['Никита', 'Илья', 'Миша', 'Алексей', 'Кай', 'Иван Петров', 'John', 'Luca', 'Игорь']) {
            expect(nameGender(name), name).toBe('m');
        }
    });

    it('does not guess names that fit both or foreign names ending in a consonant', () => {
        for (const name of ['Саша', 'Женя', 'Элис', 'Кармен', 'Любовь', 'Robin', 'Ruth', 'Mary', '', 'Я', '  ']) {
            expect(nameGender(name), name).toBeNull();
        }
    });

    it('gives the key of the phrase: feminine, masculine or neutral', () => {
        expect(genderKey('m27.card.wear', 'Вера')).toBe('m27.card.wear.f');
        expect(genderKey('m27.card.wear', 'Кай')).toBe('m27.card.wear.m');
        expect(genderKey('m27.card.wear', 'Элис')).toBe('m27.card.wear.n');
    });
});
