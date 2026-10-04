import { describe, expect, it } from 'vitest';
import { matchKey, parseRegexKey } from '../../src/domain/lore-match';
import {
    LEFT_BOUNDARY,
    convertKeyList,
    effectiveFlag,
    escapeKeyRegex,
    isLeftBoundaryCandidate,
    leftBoundaryKey,
} from '../../src/domain/rules-keys';

/** ST's matching of one key (plain keys lower-cased when case-insensitive, regex keys as they are). */
const st = (haystack: string, key: string, wholeWords = true) =>
    matchKey(haystack, key, { caseSensitive: false, matchWholeWords: wholeWords });

describe('escapeKeyRegex', () => {
    it('escapes regex syntax and the slash, keeps the hyphen and spells braces as classes', () => {
        expect(escapeKeyRegex('Анна-Мария')).toBe('Анна-Мария');
        expect(escapeKeyRegex('a.b*c+d?e^f$g(h)i[j]k|l\\m/n')).toBe(
            'a\\.b\\*c\\+d\\?e\\^f\\$g\\(h\\)i\\[j\\]k\\|l\\\\m\\/n',
        );
        expect(escapeKeyRegex('Ко{т}')).toBe('Ко[{]т[}]');
        expect(escapeKeyRegex('Ко{т}')).not.toMatch(/\\[{}]/);
    });

    it('gives patterns that compile in u mode and match the literal text', () => {
        for (const text of ['Анна-Мария', 'Ко{т}', 'a.b*c+d?', '(Ёж)', 'x/y', 'a\\b', '[Тег]', 'x|y', '^$']) {
            const regex = new RegExp(`^${escapeKeyRegex(text)}$`, 'u');
            expect(regex.test(text)).toBe(true);
        }
    });
});

describe('isLeftBoundaryCandidate', () => {
    it('takes plain one-word Cyrillic keys only', () => {
        expect(isLeftBoundaryCandidate('Иван')).toBe(true);
        expect(isLeftBoundaryCandidate(' аня ')).toBe(true);
        expect(isLeftBoundaryCandidate('Анна-Мария')).toBe(true);
        expect(isLeftBoundaryCandidate('Anna')).toBe(false);
        expect(isLeftBoundaryCandidate('Аня Петрова')).toBe(false);
        expect(isLeftBoundaryCandidate('/аня/i')).toBe(false);
        expect(isLeftBoundaryCandidate('{{char}}')).toBe(false);
        expect(isLeftBoundaryCandidate('Привет{{user}}')).toBe(false);
        expect(isLeftBoundaryCandidate('')).toBe(false);
        expect(isLeftBoundaryCandidate(42)).toBe(false);
    });
});

describe('leftBoundaryKey', () => {
    it('builds an ST regex key with the left boundary and the case flag', () => {
        expect(leftBoundaryKey(' Иван ', false)).toBe(`/${LEFT_BOUNDARY}Иван/iu`);
        expect(leftBoundaryKey('Иван', true)).toBe(`/${LEFT_BOUNDARY}Иван/u`);
        expect(parseRegexKey(leftBoundaryKey('Анна-Мария', false))).toBeInstanceOf(RegExp);
        expect(parseRegexKey(leftBoundaryKey('Ко{т}', false))).toBeInstanceOf(RegExp);
        expect(parseRegexKey(leftBoundaryKey('Сид/Нэнси', false))).toBeInstanceOf(RegExp);
    });

    it('keeps Russian inflections and stops matches inside other words (Q35)', () => {
        const ivan = leftBoundaryKey('Иван', false);
        expect(st('Отдай это Ивану.', ivan)).toBe(true);
        expect(st('с Иваном', ivan)).toBe(true);
        expect(st('ИВАН!', ivan)).toBe(true);
        expect(st('Ливан далеко', ivan)).toBe(false);
        const anya = leftBoundaryKey('аня', false);
        expect(st('Аня пришла', anya)).toBe(true);
        expect(st('«Аня»', anya)).toBe(true);
        expect(st('\u0001Аня', anya)).toBe(true);
        expect(st('Таня пришла', anya)).toBe(false);
        expect(st('баня', anya)).toBe(false);
        expect(st('2аня', anya)).toBe(false);
        // ST's own whole-word matching of the plain key: a substring for Cyrillic (the bug).
        expect(st('Таня пришла', 'аня')).toBe(true);
        expect(st('Отдай это Ивану.', 'Иван')).toBe(true);
    });

    it('matches case-sensitively without the i flag, and literally with hyphens and braces', () => {
        const ivan = leftBoundaryKey('Иван', true);
        expect(st('Иван', ivan)).toBe(true);
        expect(st('иван', ivan)).toBe(false);
        expect(st('Это Анна-Мария.', leftBoundaryKey('Анна-Мария', false))).toBe(true);
        expect(st('кот Ко{т}', leftBoundaryKey('Ко{т}', false))).toBe(true);
        expect(st('кот Кот', leftBoundaryKey('Ко{т}', false))).toBe(false);
    });
});

describe('convertKeyList', () => {
    it('returns a new list with candidates converted, or null when nothing changes', () => {
        const keys = Object.freeze(['Иван', 'Ivan', '/иван/i', '{{char}}', 'Иван Петров']);
        const converted = convertKeyList(keys, false);
        expect(converted).toEqual([`/${LEFT_BOUNDARY}Иван/iu`, 'Ivan', '/иван/i', '{{char}}', 'Иван Петров']);
        expect(converted).not.toBe(keys);
        expect(convertKeyList(['Ivan', '/x/'], false)).toBeNull();
        expect(convertKeyList(undefined, false)).toBeNull();
    });
});

describe('effectiveFlag', () => {
    it('follows ST: null and undefined mean the global setting', () => {
        expect(effectiveFlag(null, true)).toBe(true);
        expect(effectiveFlag(undefined, false)).toBe(false);
        expect(effectiveFlag(false, true)).toBe(false);
        expect(effectiveFlag(true, false)).toBe(true);
    });
});
