import { describe, expect, it } from 'vitest';
import {
    buildGlossary,
    containsWithLeftBoundary,
    escapeForKey,
    formatGlosses,
    hasCyrillic,
    hasLatin,
    isRegexKey,
    leftBoundaryKey,
    matchGlossary,
    normalizeForMatch,
    pairsFromAliases,
    pairsFromKeys,
    pairsFromLocalizer,
    russianKeysFrom,
    russianStem,
    uniqueStrings,
} from '../../src/domain/canon-keys';
import { parseRegexKey } from '../../src/domain/lore-match';

describe('character classes', () => {
    it('tells Cyrillic, Latin and regex keys apart', () => {
        expect(hasCyrillic('Маша')).toBe(true);
        expect(hasCyrillic('Masha')).toBe(false);
        expect(hasLatin('Masha')).toBe(true);
        expect(hasLatin('Маша')).toBe(false);
        expect(isRegexKey('/маш/iu')).toBe(true);
        expect(isRegexKey(' /a/ ')).toBe(true);
        expect(isRegexKey('маш')).toBe(false);
        expect(normalizeForMatch('Ёлка ЕЛЬ')).toBe('елка ель');
    });
});

describe('escapeForKey', () => {
    it('never escapes the hyphen, writes braces as classes and stays valid under the u flag', () => {
        const escaped = escapeForKey('Анна-Мария {x} a.b/c (1+1)? [z] | $^*\\');
        expect(escaped).not.toContain('\\-');
        expect(escaped).toContain('[{]x[}]');
        expect(escaped).toContain('\\/');
        expect(escaped).toContain('\\s+');
        const regex = new RegExp(escaped, 'u');
        expect(regex.test('Анна-Мария {x} a.b/c (1+1)? [z] | $^*\\')).toBe(true);
        expect(regex.test('Анна-Мария {x} aXb/c (1+1)? [z] | $^*\\')).toBe(false);
    });

    it('matches е and ё both ways and any whitespace run', () => {
        const regex = new RegExp(escapeForKey('Пётр  Еремей'), 'u');
        expect(regex.test('Петр\tЁремей')).toBe(true);
        expect(regex.test('Пётр Еремей')).toBe(true);
    });
});

describe('russianStem and leftBoundaryKey', () => {
    it('drops one final vowel when the stem keeps three letters', () => {
        expect(russianStem('Маша')).toBe('Маш');
        expect(russianStem('Анна')).toBe('Анн');
        expect(russianStem('Элизабет')).toBe('Элизабет');
        expect(russianStem('Ия')).toBe('Ия');
        expect(russianStem('Masha')).toBe('Masha');
        expect(russianStem('Анна Петрова')).toBe('Анна Петрова');
    });

    it('builds a key that ST parses and that matches case forms only after a word boundary', () => {
        const key = leftBoundaryKey('Маша');
        expect(key).toBe('/(?:^|[^\\p{L}\\p{N}_])Маш/iu');
        const regex = parseRegexKey(key!);
        expect(regex).not.toBeNull();
        expect(regex!.test('Я видел Машей вчера')).toBe(true);
        expect(regex!.test('машина у дома')).toBe(true);
        expect(regex!.test('Ромашка')).toBe(false);
        expect(regex!.test('Маши нет')).toBe(true);
    });

    it('refuses non-Cyrillic, macro and empty terms', () => {
        expect(leftBoundaryKey('Masha')).toBeNull();
        expect(leftBoundaryKey('{{char}} Маша')).toBeNull();
        expect(leftBoundaryKey('  ')).toBeNull();
    });
});

describe('russianKeysFrom', () => {
    it('prefers DES-RU plain forms, then its key, then the fallback', () => {
        expect(russianKeysFrom('Маша', ['Маша', 'Маши', 'Маша', ' ', 7, '{{x}}'], '/x/')).toEqual(['Маша', 'Маши']);
        expect(russianKeysFrom('Маша', [], ' /маш/iu ')).toEqual(['/маш/iu']);
        expect(russianKeysFrom('Маша', undefined, '{{bad}}')).toEqual(['Маша', '/(?:^|[^\\p{L}\\p{N}_])Маш/iu']);
        expect(russianKeysFrom('Masha', null, null)).toEqual(['Masha']);
        expect(russianKeysFrom('  ', null, null)).toEqual([]);
    });

    it('uniqueStrings keeps first-seen order and drops junk', () => {
        expect(uniqueStrings(['a', ' a ', 'b', '', 3, null, 'b'])).toEqual(['a', 'b']);
    });
});

describe('glossary', () => {
    const glossary = buildGlossary([
        { ru: 'Элизабет', en: 'Elizabeth', forms: ['Элизабет', 'Элизабетой'] },
        { ru: 'Маша', en: 'Masha' },
        { ru: '/(?:^|[^\\p{L}])Ёж/iu', en: 'Hedgehog' },
        { ru: '/hog/i', en: 'Hog' },
        { ru: 'Лиса', en: 'Fox' },
        { ru: 'Лисы', en: 'fox' },
        { ru: 'Кот', en: 'Кот' },
        { ru: 'Fox', en: 'Fox' },
        { ru: '', en: 'Empty' },
        { ru: '{{char}}', en: 'Macro' },
        { ru: 'Пёс', en: '/dog/' },
        { ru: 'Волк', en: '{{wolf}}' },
        { ru: 'Сова', en: 'Owl', forms: ['', 'Owl', 'совой'] },
    ]);

    it('keeps usable pairs only, merged per English name and sorted', () => {
        expect(glossary.rows.map((row) => row.en)).toEqual(['Elizabeth', 'Fox', 'Hedgehog', 'Masha', 'Owl']);
        const fox = glossary.rows.find((row) => row.en === 'Fox');
        expect(fox?.needles).toEqual(['лис']);
    });

    it('finds English names for Russian forms with a left word boundary', () => {
        expect(matchGlossary(glossary, 'Вчера с Элизабетой и Машей видели ёжика.')).toEqual([
            'Elizabeth',
            'Hedgehog',
            'Masha',
        ]);
        expect(matchGlossary(glossary, 'Ромашка и подмашинник')).toEqual([]);
        expect(matchGlossary(glossary, 'лисий хвост')).toEqual(['Fox']);
        expect(matchGlossary(glossary, '')).toEqual([]);
        expect(matchGlossary(buildGlossary([]), 'Маша')).toEqual([]);
        expect(matchGlossary(glossary, 'Маша и Лиса', 1)).toEqual(['Fox']);
    });

    it('checks the left boundary at every occurrence', () => {
        expect(containsWithLeftBoundary('ромашка маша', 'маш')).toBe(true);
        expect(containsWithLeftBoundary('ромашка', 'маш')).toBe(false);
        expect(containsWithLeftBoundary('маш', '')).toBe(false);
        expect(containsWithLeftBoundary('«маша»', 'маш')).toBe(true);
    });

    it('formats glosses within a character limit at name boundaries', () => {
        expect(formatGlosses(['Elizabeth', 'Masha', 'Fox'])).toBe('Elizabeth, Masha, Fox');
        expect(formatGlosses(['Elizabeth', 'Masha', 'Fox'], 16)).toBe('Elizabeth, Masha');
        expect(formatGlosses(['Elizabeth'], 3)).toBe('');
    });
});

describe('pair sources', () => {
    it('pairs Russian and English keys of one entry', () => {
        expect(pairsFromKeys(['Elizabeth', 'Элизабет', '/лиз/iu', 'Liz', '{{char}}', 42, 'Элизабет'])).toEqual([
            { ru: 'Элизабет', en: 'Elizabeth' },
            { ru: '/лиз/iu', en: 'Elizabeth' },
            { ru: 'Элизабет', en: 'Liz' },
            { ru: '/лиз/iu', en: 'Liz' },
        ]);
    });

    it('maps DES aliases in both directions', () => {
        expect(pairsFromAliases({ Elizabeth: ['Элизабет', 'Liz'], Маша: ['Masha'], Bob: 'x' })).toEqual([
            { ru: 'Элизабет', en: 'Elizabeth' },
            { ru: 'Элизабет', en: 'Liz' },
            { ru: 'Маша', en: 'Masha' },
        ]);
        expect(pairsFromAliases(null)).toEqual([]);
        expect(pairsFromAliases(['x'])).toEqual([]);
    });

    it('maps Localizer additions to the translated source keys, unless there are too many sources', () => {
        expect(pairsFromLocalizer(['Elizabeth'], ['Элизабет', 'Elizabeth', 'Элизабет'])).toEqual([
            { ru: 'Элизабет', en: 'Elizabeth' },
        ]);
        expect(pairsFromLocalizer(['a', 'b', 'c', 'd'], ['а'])).toEqual([]);
        expect(pairsFromLocalizer(['Маша'], ['Маши'])).toEqual([]);
    });
});
