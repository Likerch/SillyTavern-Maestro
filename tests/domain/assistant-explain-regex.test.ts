import { describe, expect, it } from 'vitest';
import { explainRegex, splitPattern } from '../../src/domain/assistant-explain-regex';

const codes = (source: string, flags = '', locale: 'en' | 'ru' = 'en') =>
    explainRegex(source, flags, locale).warnings.map((warning) => warning.code);

describe('splitPattern', () => {
    it('reads /source/flags and bare sources', () => {
        expect(splitPattern('/a+b/gi')).toEqual({ source: 'a+b', flags: 'gi' });
        expect(splitPattern('a+b')).toEqual({ source: 'a+b', flags: '' });
        expect(splitPattern('a+b', 'm')).toEqual({ source: 'a+b', flags: 'm' });
        expect(splitPattern('/x/g', 'i')).toEqual({ source: 'x', flags: 'i' });
    });
});

describe('explainRegex', () => {
    it('tells literal text, classes, quantifiers and anchors in English', () => {
        const result = explainRegex('^Hello\\s+[a-z0-9_]{2,4}$', 'g', 'en');
        expect(result.ok).toBe(true);
        expect(result.summary).toBe(
            'the start of the text, then the text "Hello", then a whitespace character [one or more times], then one of [a–z, 0–9, "_"] [2 to 4 times], then the end of the text',
        );
        expect(result.flagNotes).toEqual(['g — every match (without it only the first one)']);
        expect(result.warnings).toEqual([]);
    });

    it('tells the same in Russian', () => {
        const result = explainRegex('^Привет\\d?', '', 'ru');
        expect(result.summary).toBe('начало текста, затем текст «Привет», затем цифра [необязательно]');
        expect(result.warnings.map((warning) => warning.code)).toEqual(['noGlobal']);
        expect(result.warnings[0]!.text).toContain('только первое');
    });

    it('numbers capture groups, names named groups and explains back-references', () => {
        const result = explainRegex('(\\w+) (?<last>\\w+) \\1 \\k<last>', 'g', 'en');
        expect(result.groups).toEqual([
            { index: 1, matches: 'a Latin letter, digit or _ [one or more times]' },
            { index: 2, name: 'last', matches: 'a Latin letter, digit or _ [one or more times]' },
        ]);
        expect(result.summary).toContain('group 1 (');
        expect(result.summary).toContain('group 2 "last" (');
        expect(result.summary).toContain('the same text as group 1');
        expect(result.summary).toContain('the same text as group "last"');
        expect(result.warnings.map((warning) => warning.code)).toContain('latinOnly');
    });

    it('describes look-arounds, alternation and non-capturing groups', () => {
        const en = explainRegex('(?<=@)(?:cat|dog)(?!s)(?=!)(?<!x)', 'g', 'en').summary;
        expect(en).toBe(
            'preceded by ("@"), then (either the text "cat", or the text "dog"), then not followed by ("s"), then followed by ("!"), then not preceded by ("x")',
        );
        const ru = explainRegex('(?<=@)(?:cat|dog)(?!s)(?=!)(?<!x)', 'g', 'ru').summary;
        expect(ru).toBe(
            'перед этим («@»), затем (либо текст «cat», либо текст «dog»), затем дальше не идёт («s»), затем дальше идёт («!»), затем перед этим не («x»)',
        );
    });

    it('binds a quantifier to the last character of a text run', () => {
        expect(explainRegex('abc+', 'g', 'en').summary).toBe('the text "ab", then "c" [one or more times]');
    });

    it('describes every quantifier form, lazy ones included', () => {
        const summary = explainRegex('a*b+?c{3}d{2,}e{1,5}f{1}', 'g', 'en').summary;
        expect(summary).toContain('"a" [zero or more times]');
        expect(summary).toContain('"b" [one or more times, as few as possible]');
        expect(summary).toContain('"c" [exactly 3 times]');
        expect(summary).toContain('"d" [2 or more times]');
        expect(summary).toContain('"e" [1 to 5 times]');
        expect(summary).toContain('"f" [exactly 1 time]');
        const ru = explainRegex('a{1}b{3}c{5}d{2,7}e{2,}f*', 'g', 'ru').summary;
        expect(ru).toContain('«a» [ровно 1 раз]');
        expect(ru).toContain('«b» [ровно 3 раза]');
        expect(ru).toContain('«c» [ровно 5 раз]');
        expect(ru).toContain('«d» [от 2 до 7 раз]');
        expect(ru).toContain('«e» [2 или больше раз]');
        expect(ru).toContain('«f» [ноль или больше раз]');
    });

    it('treats a brace that is not a quantifier as text', () => {
        expect(explainRegex('a{x}', 'g', 'en').summary).toBe('the text "a{x}"');
    });

    it('knows the dot with and without the s flag, and the m flag anchors', () => {
        expect(explainRegex('.', 'g', 'en').summary).toBe('any character except a line break');
        expect(explainRegex('.', 'gs', 'en').summary).toBe('any character');
        expect(explainRegex('^x$', 'gm', 'en').summary).toBe('the start of a line, then "x", then the end of a line');
        expect(explainRegex('^x$', 'gm', 'ru').summary).toBe('начало строки, затем «x», затем конец строки');
    });

    it('warns about a greedy dot-star and nested repetition', () => {
        expect(codes('<.*>', 'g')).toContain('greedyDot');
        expect(codes('<.*?>', 'g')).not.toContain('greedyDot');
        expect(codes('(a+)+$', 'g')).toContain('nestedRepeat');
        expect(codes('(?:ab|cd*)*', 'g')).toContain('nestedRepeat');
        expect(codes('(a{2})+', 'g')).not.toContain('nestedRepeat');
    });

    it('warns that \\b and \\w are Latin-only', () => {
        expect(codes('\\bАнна\\b', 'g')).toContain('latinOnly');
        expect(codes('[\\W]', 'g')).toContain('latinOnly');
        expect(codes('\\Bx', 'g')).toContain('latinOnly');
    });

    it('warns about А-Я without Ё unless the class has it', () => {
        expect(codes('[А-Яа-я]+', 'g')).toContain('cyrillicRangeYo');
        expect(codes('[А-Яа-яЁё]+', 'g')).not.toContain('cyrillicRangeYo');
        const ru = explainRegex('[^а-я]', 'g', 'ru');
        expect(ru.summary).toBe('любой символ, кроме [а–я]');
        expect(ru.warnings[0]!.text).toContain('Ё');
    });

    it('explains Unicode property escapes and warns without the u flag', () => {
        expect(explainRegex('\\p{L}\\P{Lu}\\p{Script=Cyrillic}', 'gu', 'en').summary).toBe(
            'a letter of any alphabet, then not an uppercase letter, then a Cyrillic character',
        );
        expect(explainRegex('\\p{sc=Cyrillic}\\p{Script=Latin}\\p{sc=Greek}\\p{Alphabetic}', 'gu', 'ru').summary).toBe(
            'кириллический символ, затем латинский символ, затем символ письменности Greek, затем символ со свойством Юникода Alphabetic',
        );
        expect(explainRegex('[\\p{L}\\d]', 'gu', 'en').summary).toBe('one of [a letter of any alphabet, a digit]');
        expect(explainRegex('\\P{N}', 'gu', 'ru').summary).toBe('не символ числа');
        expect(codes('\\p{L}', 'g')).toContain('propWithoutUnicode');
    });

    it('names special characters and escapes', () => {
        const summary = explainRegex('\\n\\r\\t\\v\\f\\0\\x41\\u0042\\cJ\\.', 'g', 'en').summary;
        expect(summary).toBe(
            'a line break, then a carriage return, then a tab, then a vertical tab, then a form feed, then a NUL character, then "A" (U+0041), then "B" (U+0042), then "J" (ctrl-J), then "."',
        );
        expect(explainRegex('\\u{1F600}', 'gu', 'en').summary).toBe('"😀" (U+1F600)');
        expect(explainRegex('[\\b\\n-]', 'g', 'en').summary).toBe('one of [a backspace, a line break, "-"]');
        expect(explainRegex('[\\d-z]', 'g', 'en').summary).toBe('one of [a digit, "-", "z"]');
    });

    it('explains every escape class in both languages', () => {
        expect(explainRegex('\\d\\D\\s\\S\\W', 'g', 'en').summary).toBe(
            'a digit, then a non-digit, then a whitespace character, then a non-whitespace character, then a character other than a Latin letter, digit or _',
        );
        expect(explainRegex('\\d\\D\\s\\S\\w', 'g', 'ru').summary).toBe(
            'цифра, затем не цифра, затем пробельный символ, затем непробельный символ, затем латинская буква, цифра или _',
        );
        expect(explainRegex('\\b\\B', 'g', 'ru').summary).toBe('граница слова, затем место, где нет границы слова');
    });

    it('warns about an empty alternative', () => {
        expect(codes('a|', 'g')).toContain('emptyAlternative');
        expect(explainRegex('(|a)', 'g', 'en').summary).toBe('group 1 (either nothing (the empty string), or "a")');
    });

    it('treats modifier groups as plain groups and cuts deep nesting', () => {
        expect(explainRegex('(?i:ab)', 'g', 'en').summary).toBe('the text "ab"');
        const deep = explainRegex('((((x))))', 'g', 'en', { maxDepth: 2 });
        expect(deep.summary).toBe('group 1 (group 2 (group 3 (…)))');
    });

    it('caps a long summary', () => {
        const long = explainRegex('(a)'.repeat(80), 'g', 'en', { maxChars: 100 });
        expect(long.summary.length).toBeLessThanOrEqual(100);
        expect(long.summary.endsWith('…')).toBe(true);
    });

    it('reports a syntax error instead of explaining', () => {
        const result = explainRegex('(a', 'g', 'en');
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.summary).toBe('');
    });

    it('lists every flag in both languages', () => {
        expect(explainRegex('a', 'dgimsuy', 'en').flagNotes).toHaveLength(7);
        expect(explainRegex('a', 'gv', 'ru').flagNotes).toEqual([
            'g — все совпадения (без него только первое)',
            'v — режим наборов Юникода',
        ]);
    });
});
