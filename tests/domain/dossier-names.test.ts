import { describe, expect, it } from 'vitest';
import {
    entityIdFor,
    entityKindOf,
    isCyrillicPlainKey,
    keyCovers,
    keysCover,
    mentionMatcher,
    mentionsAny,
    nameAgrees,
    namesOverlap,
    normName,
    normSet,
    uncoveredForms,
} from '../../src/domain/dossier-names';

describe('normName', () => {
    it('folds case, ё, underscores and whitespace', () => {
        expect(normName('  Пётр_Великий  ')).toBe('петр великий');
        expect(normName('Elizabeth   Smith')).toBe('elizabeth smith');
        expect(normName(42)).toBe('');
        expect(normName(undefined)).toBe('');
    });

    it('builds and splits entity ids', () => {
        expect(entityIdFor('character', 'Лира  Ёлкина')).toBe('character:лира елкина');
        expect(entityKindOf('place:tavern')).toBe('place');
        expect(entityKindOf('nokind')).toBe('');
        expect(entityKindOf(':x')).toBe('');
    });
});

describe('keyCovers', () => {
    it('tests regex keys on the name and on its normalised form', () => {
        expect(keyCovers('/лир(а|у|ой)/iu', 'Лиру')).toBe(true);
        expect(keyCovers('/^петр$/i', 'Пётр')).toBe(true);
        expect(keyCovers('/dragon/i', 'Лира')).toBe(false);
        expect(keyCovers('/(broken/i', 'Лира')).toBe(false);
    });

    it('lets a Cyrillic stem cover inflected forms at a word start only', () => {
        expect(keyCovers('Лира', 'лира')).toBe(true);
        expect(keyCovers('Лир', 'Лирой')).toBe(true);
        expect(keyCovers('Лир', 'Анна Лирова')).toBe(true);
        expect(keyCovers('ира', 'Лира')).toBe(false);
        expect(keyCovers('Ли', 'Лира')).toBe(false);
        expect(keyCovers('Лира', 'Лиру')).toBe(false);
    });

    it('needs whole words for Latin keys', () => {
        expect(keyCovers('Lyra', 'Lyra Belacqua')).toBe(true);
        expect(keyCovers('Belacqua', 'Lyra Belacqua')).toBe(true);
        expect(keyCovers('Lyra', 'Lady Lyra Belacqua')).toBe(true);
        expect(keyCovers('Lyr', 'Lyra')).toBe(false);
        expect(keyCovers('Ann', 'Annual')).toBe(false);
    });

    it('ignores empty keys and macros', () => {
        expect(keyCovers('', 'Lyra')).toBe(false);
        expect(keyCovers('Lyra', ' ')).toBe(false);
        expect(keyCovers('{{char}}', 'Lyra')).toBe(false);
        expect(keyCovers('_', 'Lyra')).toBe(false);
    });

    it('checks lists and finds uncovered forms', () => {
        expect(keysCover(['dragon', 'Лир'], 'Лиры')).toBe(true);
        expect(keysCover([], 'Лиры')).toBe(false);
        expect(uncoveredForms(['Лира', '/лиру/i'], ['Лира', 'Лиры', 'Лиру', 'Лиры'])).toEqual(['Лиры']);
    });

    it('recognises plain Cyrillic keys', () => {
        expect(isCyrillicPlainKey('Лира')).toBe(true);
        expect(isCyrillicPlainKey('/лира/i')).toBe(false);
        expect(isCyrillicPlainKey('Lyra')).toBe(false);
        expect(isCyrillicPlainKey('{{user}} Лира')).toBe(false);
    });
});

describe('names', () => {
    it('agrees on equal, known and word-subset names', () => {
        expect(nameAgrees('', 'Lyra')).toBe(true);
        expect(nameAgrees('Lyra', '')).toBe(true);
        expect(nameAgrees('LYRA', 'Lyra')).toBe(true);
        expect(nameAgrees('Лира', 'Lyra', ['Лира'])).toBe(true);
        expect(nameAgrees('Elizabeth_Smith', 'Elizabeth')).toBe(true);
        expect(nameAgrees('Mara', 'Lyra', ['Ly'])).toBe(false);
    });

    it('builds normalised sets and overlaps', () => {
        expect([...normSet(['Ёж', 'еж', '', 5])]).toEqual(['еж']);
        expect(namesOverlap(['Lyra', 'Ly'], ['ly'])).toBe(true);
        expect(namesOverlap(['Lyra'], ['Mara'])).toBe(false);
    });
});

describe('mentions', () => {
    it('finds Russian names in any case form and English names as whole words', () => {
        const matcher = mentionMatcher(['Лира', 'Ann', 'Анна Каренина', 'x']);
        expect(matcher.open).toContain('лир');
        expect(matcher.open).toContain('анна каренина');
        expect(matcher.closed).toEqual(['ann']);
        expect(mentionsAny(matcher, 'Вчера с Лирой спорили')).toBe(true);
        expect(mentionsAny(matcher, 'Анну Каренину видели — нет')).toBe(false);
        expect(mentionsAny(matcher, 'Анна Каренина пришла')).toBe(true);
        expect(mentionsAny(matcher, 'Ann_ walked in')).toBe(true);
        expect(mentionsAny(matcher, 'Annual fair')).toBe(false);
        expect(mentionsAny(matcher, 'the fair of Ann.')).toBe(true);
        expect(mentionsAny(matcher, 'Малира')).toBe(false);
    });

    it('is false for empty input', () => {
        expect(mentionsAny(mentionMatcher([]), 'Лира')).toBe(false);
        expect(mentionsAny(mentionMatcher(['Лира']), '')).toBe(false);
    });

    it('keeps short Russian names without a stem', () => {
        const matcher = mentionMatcher(['Ия']);
        expect(matcher.open).toEqual(['ия']);
        expect(mentionsAny(matcher, 'Ия ушла')).toBe(true);
    });
});
