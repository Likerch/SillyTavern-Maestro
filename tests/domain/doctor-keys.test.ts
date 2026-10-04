import { describe, expect, it } from 'vitest';
import {
    cyrillicShare,
    escapeRegexLikeSt,
    hasCyrillic,
    isAsciiWordChar,
    isBareTagKey,
    isCyrillicWholeWordKey,
    isMbtiTag,
    isRussianChat,
    isTagKey,
    looksLikeRegexKey,
    matchKey,
    normalizePackKey,
    parseRegexKey,
    regexKeyProblem,
} from '../../src/domain/doctor-keys';
import { entryLabel, enabledEntries, sample, toDoctorEntry } from '../../src/domain/doctor-types';

describe('Cyrillic detection', () => {
    it('finds Cyrillic letters and measures their share', () => {
        expect(hasCyrillic('Anna и Таня')).toBe(true);
        expect(hasCyrillic('Anna')).toBe(false);
        expect(cyrillicShare(['абв', 'ab'])).toEqual({ share: 0.6, letters: 5 });
        expect(cyrillicShare(['123 !!'])).toEqual({ share: 0, letters: 0 });
    });

    it('calls a chat Russian only with enough letters and a real share', () => {
        const russian = 'Анна посмотрела на него и улыбнулась. '.repeat(10);
        expect(isRussianChat([russian, '<SPECIES:ELF> Elizabeth'])).toBe(true);
        expect(isRussianChat(['Привет'])).toBe(false);
        expect(isRussianChat(['English text only. '.repeat(30)])).toBe(false);
        expect(isRussianChat(['Короткий'], 3)).toBe(true);
    });
});

describe('regex keys (ST parseRegexFromString)', () => {
    it('parses valid regex keys and rejects everything else', () => {
        expect(parseRegexKey('/anna/i')?.flags).toBe('i');
        expect(parseRegexKey('/a\\/b/')?.source).toBe('a\\/b');
        expect(parseRegexKey('anna')).toBeNull();
        expect(parseRegexKey('/a/b/')).toBeNull();
        expect(parseRegexKey('/(/')).toBeNull();
        expect(parseRegexKey('/a/x')).toBeNull();
    });

    it('tells why a regex-looking key does not work', () => {
        expect(regexKeyProblem('plain')).toBeNull();
        expect(regexKeyProblem('/ok/iu')).toBeNull();
        expect(regexKeyProblem('/abc/x')).toBe('flags');
        expect(regexKeyProblem('/a/b/')).toBe('slash');
        expect(regexKeyProblem('/a/b/i')).toBe('slash');
        expect(regexKeyProblem('/Ан\\-на/iu')).toBe('syntax');
        expect(regexKeyProblem('/a\\{2\\}/')).toBe('braces');
        expect(looksLikeRegexKey(' /x/ ')).toBe(true);
        expect(looksLikeRegexKey('x/')).toBe(false);
    });
});

describe('tags', () => {
    it('recognises tag, bare tag and MBTI keys', () => {
        expect(isTagKey('<SPECIES:ELF>')).toBe(true);
        expect(isTagKey('Anna')).toBe(false);
        expect(isBareTagKey('<NSFW>')).toBe(true);
        expect(isBareTagKey('<SPECIES:ELF>')).toBe(false);
        expect(isMbtiTag('<intj-u>')).toBe(true);
        expect(isMbtiTag('<NSFW>')).toBe(false);
    });

    it('normalises pack keys like research §1.6', () => {
        expect(normalizePackKey(' <ling: horny> ')).toBe('<LING:HORNY>');
        expect(normalizePackKey('/Anna/i')).toBe('/Anna/i');
    });
});

describe('matchKey (ST WorldInfoBuffer.matchKeys)', () => {
    const plain = { caseSensitive: false, wholeWords: false };
    const whole = { caseSensitive: false, wholeWords: true };

    it('matches plain keys as substrings, case-insensitively by default', () => {
        expect(matchKey('He met ANNA.', 'anna', plain)).toBe(true);
        expect(matchKey('He met ANNA.', 'anna', { ...plain, caseSensitive: true })).toBe(false);
        expect(matchKey('herself', 'elf', plain)).toBe(true);
        expect(matchKey('text', '   ', plain)).toBe(false);
    });

    it('uses ASCII word boundaries in whole-word mode', () => {
        expect(matchKey('herself', 'elf', whole)).toBe(false);
        expect(matchKey('an elf.', 'elf', whole)).toBe(true);
        expect(matchKey('two words here', 'two words', whole)).toBe(true);
        // The Cyrillic bug: every Cyrillic letter is \W, so "аня" fires inside "Таня".
        expect(matchKey('Таня пришла', 'аня', whole)).toBe(true);
        expect(matchKey('text<nsfw>', '<NSFW>', whole)).toBe(false);
    });

    it('runs regex keys as they are, ignoring the other options', () => {
        expect(matchKey('Ивану', '/иван/i', whole)).toBe(true);
        expect(matchKey('Петру', '/иван/i', whole)).toBe(false);
        expect(isCyrillicWholeWordKey('Аня')).toBe(true);
        expect(isCyrillicWholeWordKey('Анна Каренина')).toBe(false);
        expect(isCyrillicWholeWordKey('/аня/i')).toBe(false);
        expect(isCyrillicWholeWordKey('Anna')).toBe(false);
    });

    it('escapes like ST and knows ASCII word characters', () => {
        expect(escapeRegexLikeSt('a-b.c')).toBe('a\\-b\\.c');
        expect(isAsciiWordChar('a')).toBe(true);
        expect(isAsciiWordChar('я')).toBe(false);
        expect(isAsciiWordChar(undefined)).toBe(false);
        expect(isAsciiWordChar('')).toBe(false);
    });
});

describe('toDoctorEntry and helpers', () => {
    it('normalises raw entries with ST defaults', () => {
        const entry = toDoctorEntry('Book', { key: [' a ', '', 5], content: 7, depth: '3', role: null }, 4);
        expect(entry).toMatchObject({
            book: 'Book',
            uid: 4,
            key: ['a', '5'],
            content: '7',
            position: 0,
            depth: 3,
            role: null,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            disable: false,
        });
        const full = toDoctorEntry(
            'B',
            { uid: 9, role: 2, scanDepth: 1, matchWholeWords: true, disable: true, comment: 'C', depth: 'x' },
            0,
            ['k'],
        );
        expect(full).toMatchObject({ uid: 9, role: 2, scanDepth: 1, matchWholeWords: true, disable: true, depth: 4 });
        expect(full.localizerKeys).toEqual(['k']);
        expect(toDoctorEntry('B', { comment: undefined, role: '' }, 1).comment).toBe('');
        expect(toDoctorEntry('B', { role: 'x' }, 1).role).toBeNull();
    });

    it('labels entries, samples lists and filters disabled ones', () => {
        expect(entryLabel({ comment: '  ', uid: 3 })).toBe('#3');
        expect(entryLabel({ comment: 'x'.repeat(90), uid: 3 })).toHaveLength(78);
        expect(sample(['a', 'b', 'a', 'c', 'd'])).toBe('a, b, c, …');
        expect(sample(['a'])).toBe('a');
        const list = [toDoctorEntry('B', { disable: true }, 1), toDoctorEntry('B', {}, 2)];
        expect(enabledEntries(list).map((item) => item.uid)).toEqual([2]);
    });
});
