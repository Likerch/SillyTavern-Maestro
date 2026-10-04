import { describe, expect, it } from 'vitest';
import {
    analyzeDecorators,
    analyzeKeys,
    englishTerms,
    formatKeys,
    isRegexKey,
    keyKind,
    mergeKeys,
    parseKeyInput,
    splitKeywordsAndRegexes,
    stringList,
    testEntry,
} from '../../src/domain/lore-form-keys';

const GLOBALS = { caseSensitive: false, matchWholeWords: false };

describe('splitKeywordsAndRegexes (port of ST 1.19)', () => {
    it('splits by commas and trims', () => {
        expect(splitKeywordsAndRegexes('Anna,  Annie ,Bob')).toEqual(['Anna', 'Annie', 'Bob']);
        expect(splitKeywordsAndRegexes('')).toEqual([]);
        expect(splitKeywordsAndRegexes(' , ,a')).toEqual(['a']);
    });

    it('keeps commas inside a regex', () => {
        expect(splitKeywordsAndRegexes('/An{1,2}a/i, Bob')).toEqual(['/An{1,2}a/i', 'Bob']);
        expect(splitKeywordsAndRegexes('a, /b,c/')).toEqual(['a', '/b,c/']);
        expect(splitKeywordsAndRegexes('/a\\/b/, c')).toEqual(['/a\\/b/', 'c']);
    });

    it('cuts a finished token that looks like an invalid regex at every comma', () => {
        expect(splitKeywordsAndRegexes('/a,b/x, c')).toEqual(['/a', 'b/x', 'c']);
        // ST pushes the empty piece too.
        expect(splitKeywordsAndRegexes('/a,,b/x, c')).toEqual(['/a', '', 'b/x', 'c']);
    });

    it('keeps ST quirks: a slash right after a comma does not open a regex, an unpaired slash swallows commas', () => {
        expect(splitKeywordsAndRegexes('a,/b,c/')).toEqual(['a', '/b', 'c/']);
        expect(splitKeywordsAndRegexes('and/or, foo')).toEqual(['and/or, foo']);
        expect(splitKeywordsAndRegexes('/open,regex')).toEqual(['/open,regex']);
    });

    it('parseKeyInput drops empty keys and round-trips with formatKeys', () => {
        expect(parseKeyInput('/a,,b/x, c')).toEqual(['/a', 'b/x', 'c']);
        const keys = ['Anna', '/An{1,2}a/i', 'Bob'];
        expect(parseKeyInput(formatKeys(keys))).toEqual(keys);
    });
});

describe('key kinds and diagnostics', () => {
    it('classifies keys', () => {
        expect(isRegexKey('/abc/i')).toBe(true);
        expect(keyKind('/abc/')).toBe('regex');
        expect(keyKind('/ab[/')).toBe('badRegex');
        expect(keyKind('/abc/x')).toBe('badRegex');
        expect(keyKind('abc')).toBe('plain');
        expect(stringList(['a', 1, null, 'b'])).toEqual(['a', 'b']);
        expect(stringList('a')).toEqual([]);
    });

    it('reports the issues of each key', () => {
        const infos = analyzeKeys(
            ['/abc/x', 'and/or, foo', '/\\{x/', '{{char}}', 'Аня', 'Анна Каренина', 'Anna', 'anna'],
            {
                matchWholeWords: true,
                caseSensitive: false,
            },
        );
        expect(infos.map((info) => info.issues)).toEqual([
            ['badRegex'],
            ['comma'],
            ['macroBrace'],
            ['macro'],
            ['cyrillicWholeWord'],
            [],
            [],
            ['duplicate'],
        ]);
        expect(infos[4]).toMatchObject({ kind: 'plain', cyrillic: true });
        const relaxed = analyzeKeys(['Аня', 'Anna', 'anna'], { matchWholeWords: false, caseSensitive: true });
        expect(relaxed.map((info) => info.issues)).toEqual([[], [], []]);
    });

    it('finds English terms and merges new keys case-insensitively', () => {
        expect(englishTerms(['Anna', 'Аня', '/x/', '123', 'Dark Lord', 'Aнна'])).toEqual(['Anna', 'Dark Lord']);
        expect(mergeKeys(['Anna'], ['anna', 'Анна', ' Анну ', '', 'Анна'])).toEqual(['Anna', 'Анна', 'Анну']);
        expect(mergeKeys(['Anna'], ['anna'], true)).toEqual(['Anna', 'anna']);
        const base = ['x'];
        expect(mergeKeys(base, ['y'])).not.toBe(base);
    });
});

describe('analyzeDecorators (port of parseDecorators)', () => {
    it('reads known decorators and cuts them', () => {
        expect(analyzeDecorators('@@activate\nText')).toEqual({ known: ['@@activate'], unknown: [], content: 'Text' });
        expect(analyzeDecorators('Plain')).toEqual({ known: [], unknown: [], content: 'Plain' });
    });

    it('drops unknown lines and reads @@@ after an unknown one', () => {
        expect(analyzeDecorators('@@foo\n@@@activate\nText')).toEqual({
            known: ['@@activate'],
            unknown: ['@@foo'],
            content: 'Text',
        });
        expect(analyzeDecorators('@@@dont_activate\nText')).toEqual({ known: [], unknown: [], content: 'Text' });
    });

    it('cuts nothing when the content is only decorators', () => {
        expect(analyzeDecorators('@@dont_activate')).toEqual({
            known: ['@@dont_activate'],
            unknown: [],
            content: '@@dont_activate',
        });
    });
});

describe('testEntry', () => {
    const entry = { key: ['Anna', '/sil(ver)?/i'], keysecondary: ['forest', 'tower'], selective: true, content: 'x' };

    it('reports hits and ST outcomes in order', () => {
        expect(testEntry({ ...entry, disable: true }, 'Anna', GLOBALS).outcome).toBe('disabled');
        expect(testEntry({ ...entry, content: '@@activate\nx' }, 'nothing', GLOBALS)).toMatchObject({
            outcome: 'activateDecorator',
            activates: true,
        });
        expect(testEntry({ ...entry, content: '@@dont_activate\nx', constant: true }, 'Anna', GLOBALS).outcome).toBe(
            'dontActivate',
        );
        expect(testEntry({ ...entry, constant: true }, 'nothing', GLOBALS)).toMatchObject({
            outcome: 'constant',
            activates: true,
        });
        expect(testEntry({ key: [] }, 'Anna', GLOBALS).outcome).toBe('noKeys');
        expect(testEntry(entry, 'nobody', GLOBALS).outcome).toBe('noPrimary');
        const result = testEntry(entry, 'Anna walks in the forest', GLOBALS);
        expect(result).toMatchObject({
            outcome: 'activated',
            activates: true,
            primaryMatched: true,
            secondaryUsed: true,
        });
        expect(result.primary).toEqual([
            { key: 'Anna', kind: 'plain', matched: true },
            { key: '/sil(ver)?/i', kind: 'regex', matched: false },
        ]);
        expect(result.secondary.map((hit) => hit.matched)).toEqual([true, false]);
    });

    it('applies the four secondary logics', () => {
        const text = 'Anna in the forest';
        const run = (selectiveLogic: number) => testEntry({ ...entry, selectiveLogic }, text, GLOBALS).outcome;
        expect(run(0)).toBe('activated'); // AND ANY
        expect(run(3)).toBe('secondaryFailed'); // AND ALL
        expect(run(1)).toBe('activated'); // NOT ALL
        expect(run(2)).toBe('secondaryFailed'); // NOT ANY
        expect(run(9)).toBe('secondaryFailed');
        expect(testEntry({ ...entry, selectiveLogic: 3 }, 'Anna forest tower', GLOBALS).outcome).toBe('activated');
        expect(testEntry({ ...entry, selectiveLogic: 2 }, 'Anna alone', GLOBALS).outcome).toBe('activated');
    });

    it('ignores secondary keys of non-selective entries and substitutes macros', () => {
        const result = testEntry({ ...entry, selective: false }, 'Anna', GLOBALS);
        expect(result).toMatchObject({ outcome: 'activated', secondaryUsed: false, secondaryPassed: true });
        const macro = testEntry({ key: ['{{char}}'] }, 'Seraphina smiles', GLOBALS, (value) =>
            value.replace('{{char}}', 'Seraphina'),
        );
        expect(macro.outcome).toBe('activated');
        expect(testEntry({ key: ['{{char}}'] }, 'x', GLOBALS, () => '').outcome).toBe('noPrimary');
    });

    it('uses the entry case setting over the global one', () => {
        expect(testEntry({ key: ['Anna'], caseSensitive: true }, 'anna', GLOBALS).outcome).toBe('noPrimary');
        expect(testEntry({ key: ['Anna'] }, 'anna', { caseSensitive: true, matchWholeWords: false }).outcome).toBe(
            'noPrimary',
        );
        expect(
            testEntry({ key: ['Anna'], caseSensitive: false }, 'anna', { caseSensitive: true, matchWholeWords: false })
                .outcome,
        ).toBe('activated');
    });
});
