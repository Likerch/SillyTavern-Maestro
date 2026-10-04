import { describe, expect, it } from 'vitest';
import {
    WI_LOGIC,
    buildScanText,
    entryMatchOptions,
    escapeRegex,
    findTriggerKey,
    findVia,
    matchKey,
    parseRegexKey,
} from '../../src/domain/lore-match';

const plain = { caseSensitive: false, matchWholeWords: false };

describe('parseRegexKey (port of parseRegexFromString)', () => {
    it('parses /pattern/flags', () => {
        const regex = parseRegexKey('/an+a/i');
        expect(regex).toBeInstanceOf(RegExp);
        expect(regex?.flags).toBe('i');
        expect(regex?.test('ANNA')).toBe(true);
    });

    it('rejects plain text, unescaped slashes and invalid syntax', () => {
        expect(parseRegexKey('Anna')).toBeNull();
        expect(parseRegexKey('/a/b/')).toBeNull();
        expect(parseRegexKey('/(unclosed/')).toBeNull();
    });

    it('unescapes an escaped delimiter', () => {
        expect(parseRegexKey('/a\\/b/')?.test('a/b')).toBe(true);
    });
});

describe('matchKey (port of WorldInfoBuffer.matchKeys)', () => {
    it('matches substrings case-insensitively by default', () => {
        expect(matchKey('\x01Hello ANNA', 'anna', plain)).toBe(true);
        expect(matchKey('\x01Hello', 'anna', plain)).toBe(false);
    });

    it('honours case sensitivity', () => {
        expect(matchKey('Hello ANNA', 'anna', { caseSensitive: true, matchWholeWords: false })).toBe(false);
        expect(matchKey('Hello Anna', 'Anna', { caseSensitive: true, matchWholeWords: false })).toBe(true);
    });

    it('uses ASCII word boundaries for single words, substrings for phrases', () => {
        const whole = { caseSensitive: false, matchWholeWords: true };
        expect(matchKey('the cat sat', 'cat', whole)).toBe(true);
        expect(matchKey('concatenate', 'cat', whole)).toBe(false);
        expect(matchKey('a big cat sat', 'big cat', whole)).toBe(true);
        // Cyrillic letters are \W for JavaScript: whole-word Cyrillic keys behave like substrings.
        expect(matchKey('Аннушка пришла', 'анн', whole)).toBe(true);
        expect(matchKey('xАннаx', 'анна', whole)).toBe(false);
        expect(matchKey('Анна пришла', 'анна', whole)).toBe(true);
    });

    it('treats regex keys as regexes and creates them fresh every time', () => {
        expect(matchKey('Elf ranger', '/elf|dwarf/i', plain)).toBe(true);
        const global = '/elf/g';
        expect(matchKey('elf', global, plain)).toBe(true);
        expect(matchKey('elf', global, plain)).toBe(true);
    });

    it('accepts ST’s own parser', () => {
        const calls: string[] = [];
        const parse = (key: string): RegExp | null => {
            calls.push(key);
            return null;
        };
        expect(matchKey('abc', 'b', { ...plain, parseRegex: parse })).toBe(true);
        expect(calls).toEqual(['b']);
    });

    it('escapes regex characters of plain keys', () => {
        expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
        expect(matchKey('x a.b y', 'a.b', { caseSensitive: false, matchWholeWords: true })).toBe(true);
        expect(matchKey('x aXb y', 'a.b', { caseSensitive: false, matchWholeWords: true })).toBe(false);
    });
});

describe('entryMatchOptions', () => {
    it('falls back to the global settings when the entry has null', () => {
        const globals = { caseSensitive: true, matchWholeWords: true };
        expect(entryMatchOptions({ caseSensitive: null, matchWholeWords: false }, globals)).toEqual({
            caseSensitive: true,
            matchWholeWords: false,
        });
        const parse = (): RegExp | null => null;
        expect(entryMatchOptions({}, globals, parse).parseRegex).toBe(parse);
    });
});

describe('findTriggerKey', () => {
    const text = '\x01User: we walk to the old forest with Anna';

    it('returns the first matching primary key', () => {
        expect(findTriggerKey({ key: ['Boris', 'Anna', 'forest'] }, text, plain)).toBe('Anna');
        expect(findTriggerKey({ key: ['Boris'] }, text, plain)).toBeNull();
        expect(findTriggerKey({ key: 'Anna' }, text, plain)).toBeNull();
    });

    it('ignores secondary keys when the entry is not selective', () => {
        expect(findTriggerKey({ key: ['Anna'], keysecondary: ['castle'], selective: false }, text, plain)).toBe('Anna');
        expect(findTriggerKey({ key: ['Anna'], keysecondary: ['castle'] }, text, plain)).toBe('Anna');
    });

    it('applies every secondary logic', () => {
        const base = { key: ['Anna'], selective: true, keysecondary: ['forest', 'castle'] };
        expect(findTriggerKey({ ...base, selectiveLogic: WI_LOGIC.AND_ANY }, text, plain)).toBe('Anna + forest');
        expect(findTriggerKey({ ...base }, text, plain)).toBe('Anna + forest');
        expect(findTriggerKey({ ...base, selectiveLogic: WI_LOGIC.NOT_ALL }, text, plain)).toBe('Anna + ¬castle');
        expect(
            findTriggerKey(
                { ...base, keysecondary: ['castle', 'moat'], selectiveLogic: WI_LOGIC.NOT_ANY },
                text,
                plain,
            ),
        ).toBe('Anna + ¬(castle, moat)');
        expect(
            findTriggerKey({ ...base, keysecondary: ['forest', 'old'], selectiveLogic: WI_LOGIC.AND_ALL }, text, plain),
        ).toBe('Anna + forest + old');
        // Secondary condition not met on this text: the primary key is still the best answer.
        expect(findTriggerKey({ ...base, selectiveLogic: WI_LOGIC.AND_ALL }, text, plain)).toBe('Anna');
    });

    it('substitutes macros in keys and skips empty ones', () => {
        const substitute = (key: string): string => key.replace('{{char}}', 'Anna').replace('{{empty}}', '');
        expect(findTriggerKey({ key: ['{{empty}}', '{{char}}'] }, text, plain, substitute)).toBe('{{char}}');
        expect(
            findTriggerKey(
                { key: ['Anna'], selective: true, keysecondary: ['{{empty}}'], selectiveLogic: WI_LOGIC.AND_ANY },
                text,
                plain,
                substitute,
            ),
        ).toBe('Anna');
    });
});

describe('buildScanText', () => {
    it('joins messages up to the depth with ST’s separators', () => {
        expect(buildScanText({ messages: ['  third ', 'second', 'first'], depth: 2 })).toBe('\x01third\n\x01second');
        expect(buildScanText({ messages: ['a'], depth: 0 })).toBe('');
    });

    it('adds opted-in card fields, injections and the recursion buffer', () => {
        const text = buildScanText({
            messages: ['m'],
            depth: 5,
            global: { personaDescription: 'P', characterDescription: 'D', scenario: '', creatorNotes: 'N' },
            flags: {
                matchPersonaDescription: true,
                matchCharacterDescription: false,
                matchScenario: true,
                matchCreatorNotes: true,
            },
            injects: ['I1', 'I2'],
            recursion: ['R'],
        });
        expect(text).toBe('\x01m\n\x01P\n\x01N\n\x01I1\n\x01I2\n\x01R');
    });
});

describe('findVia', () => {
    const candidates = [
        { world: 'W', uid: 2, content: 'Mentions the Silver Tower.' },
        { world: 'W', uid: 1, content: '' },
        { world: 'W', uid: 3, content: 'Also the silver tower here.' },
    ];

    it('returns the first candidate containing a key', () => {
        expect(findVia({ key: ['silver tower'] }, candidates, plain)).toEqual({ world: 'W', uid: 2 });
        expect(findVia({ key: ['Silver Tower'], caseSensitive: true }, candidates.slice(2), plain)).toBeUndefined();
    });

    it('returns undefined without keys or matches', () => {
        expect(findVia({ key: [] }, candidates, plain)).toBeUndefined();
        expect(findVia({ key: ['dragon'] }, candidates, plain)).toBeUndefined();
    });
});
