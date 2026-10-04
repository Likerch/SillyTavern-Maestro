import { describe, expect, it } from 'vitest';
import {
    applyTagChange,
    checkAlias,
    checkFactText,
    checkPassportTags,
    checkTagFormat,
    formatRejection,
    insertFact,
    invalidKeys,
    isExplicitAnatomy,
    mergeKeys,
    normalTag,
    parseRejection,
    parseTagList,
    sheetName,
    sheetTags,
    withoutStatement,
} from '../../src/domain/revision-checks';

const ARCHIVE =
    '<BunnymoTags><Name:Anna>, <GENDER:FEMALE>, <PERSONALITY><Dere:TSUNDERE>, <TRAIT:SHY>, <INTJ-U></PERSONALITY></BunnymoTags>\n<Linguistics>Speaks softly.</Linguistics>';

describe('rejections', () => {
    it('round-trips code and detail', () => {
        expect(formatRejection({ code: 'noChange' })).toBe('noChange');
        expect(formatRejection({ code: 'tag', detail: '<A:B>|x' })).toBe('tag|<A:B>|x');
        expect(parseRejection('tag|<A:B>|x')).toEqual({ code: 'tag', detail: '<A:B>|x' });
        expect(parseRejection('empty')).toEqual({ code: 'empty' });
    });
});

describe('canon facts', () => {
    it('accepts a short English statement, also with a Russian name', () => {
        expect(checkFactText('Anna now lives in Paris.')).toBeNull();
        expect(checkFactText('Аня now lives in Paris with {{user}}.')).toBeNull();
    });

    it('rejects empty, long, Russian, markup and placeholders', () => {
        expect(checkFactText('  ')).toEqual({ code: 'empty' });
        expect(checkFactText('a'.repeat(501))).toEqual({ code: 'tooLong' });
        expect(checkFactText('Аня теперь живёт в Париже.')).toEqual({ code: 'notEnglish' });
        expect(checkFactText('Anna is <Name:Anna> now')).toEqual({ code: 'markup' });
        expect(checkFactText('<BunnymoTags> stuff')).toEqual({ code: 'markup' });
        expect(checkFactText('Anna lives in TBD.')).toEqual({ code: 'placeholder' });
        expect(checkFactText('Anna lives in {{city}}.')).toEqual({ code: 'placeholder' });
    });

    it('replaces the outdated statement or appends; nothing when the fact is there', () => {
        expect(insertFact('Anna is shy. Anna lives in Rome.', 'Anna lives in Paris.', 'Anna lives in Rome.')).toEqual({
            content: 'Anna is shy. Anna lives in Paris.',
            replaced: true,
        });
        expect(insertFact('Anna is shy.  \n', 'Anna lives in Paris.', 'Anna lives in Berlin.')).toEqual({
            content: 'Anna is shy.\n\nAnna lives in Paris.',
            replaced: false,
        });
        expect(insertFact('', 'Anna lives in Paris.')).toEqual({ content: 'Anna lives in Paris.', replaced: false });
        expect(insertFact('Anna   lives in PARIS.', 'Anna lives in Paris.')).toBeNull();
        expect(insertFact('x', '  ')).toBeNull();
    });

    it('removes a statement for the contradiction check', () => {
        expect(withoutStatement('A.\n\nAnna lives in Rome.\n\n\nB.', 'Anna lives in Rome.')).toBe('A.\n\nB.');
        expect(withoutStatement('A.', undefined)).toBe('A.');
    });
});

describe('CK tags', () => {
    it('reads tag lists and notices junk', () => {
        expect(parseTagList('<TRAIT:BRAVE>, <INTJ-H>')).toEqual({ tags: ['<TRAIT:BRAVE>', '<INTJ-H>'], junk: false });
        expect(parseTagList('<TRAIT:BRAVE> and more')).toEqual({ tags: ['<TRAIT:BRAVE>'], junk: true });
        expect(parseTagList('')).toEqual({ tags: [], junk: false });
    });

    it('checks the format before the dictionary', () => {
        expect(checkTagFormat(['<TRAIT:BRAVE>', '<INTJ-H>'])).toBeNull();
        expect(checkTagFormat(['<TRAIT:UNKNOWNVALUE>'])).toBeNull();
        expect(checkTagFormat(['<TRAIT:СМЕЛАЯ>'])).toMatchObject({ code: 'cyrillic' });
        expect(checkTagFormat(['<GENRE:BLANK>'])).toMatchObject({ code: 'placeholder' });
        expect(checkTagFormat(['<TRAIT:SHY → BRAVE>'])).toMatchObject({ code: 'transitional' });
        expect(checkTagFormat(['<TRAIT:BRAVE STRENGTHENING>'])).toMatchObject({ code: 'transitional' });
        expect(checkTagFormat(['<TRAIT BRAVE>'])).toMatchObject({ code: 'malformed' });
        expect(checkTagFormat(['<TRAIT:BRAVE>', '<TRAIT:BRAVE>'])).toMatchObject({ code: 'duplicate' });
        expect(checkTagFormat(['<Name:Anya>'])).toEqual({ code: 'name', detail: '<Name:Anya>' });
    });

    it('normalises tags and reads archives', () => {
        expect(normalTag('<trait: brave>')).toBe('<TRAIT:BRAVE>');
        expect(normalTag('nope')).toBeNull();
        expect(sheetTags(ARCHIVE)).toEqual(['<GENDER:FEMALE>', '<DERE:TSUNDERE>', '<TRAIT:SHY>', '<INTJ-U>']);
        expect(sheetName(ARCHIVE)).toBe('Anna');
        expect(sheetName('no block')).toBeNull();
    });

    it('replaces, flips MBTI and adds tags, keeping the name and the prose', () => {
        const result = applyTagChange(
            ARCHIVE,
            ['<DERE:TSUNDERE>', '<INTJ-U>'],
            ['<DERE:DANDERE>', '<INTJ-H>', '<TRAIT:BRAVE>'],
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.content).toContain('<Name:Anna>');
        expect(result.content).toContain('<DERE:DANDERE>');
        expect(result.content).toContain('<INTJ-H>');
        expect(result.content).not.toContain('<INTJ-U>');
        expect(result.content).not.toContain('TSUNDERE');
        expect(result.content).toContain('<TRAIT:BRAVE>');
        expect(result.content).toContain('<Linguistics>Speaks softly.</Linguistics>');
        expect(sheetName(result.content)).toBe('Anna');
    });

    it('removes MBTI without a replacement', () => {
        const result = applyTagChange(ARCHIVE, ['<INTJ-U>'], ['<TRAIT:BRAVE>']);
        expect(result.ok && !result.content.includes('INTJ')).toBe(true);
    });

    it('refuses what cannot be written cleanly', () => {
        const code = (result: ReturnType<typeof applyTagChange>) => (result.ok ? 'ok' : result.rejection.code);
        expect(code(applyTagChange(ARCHIVE, ['<TRAIT:BOLD>'], ['<TRAIT:BRAVE>']))).toBe('beforeMissing');
        expect(code(applyTagChange(ARCHIVE, ['<ENFP-H>'], ['<TRAIT:BRAVE>']))).toBe('beforeMissing');
        expect(code(applyTagChange('plain text', [], ['<TRAIT:BRAVE>']))).toBe('noTarget');
        expect(code(applyTagChange(`${ARCHIVE}\n<BunnymoTags><Name:Bob></BunnymoTags>`, [], ['<TRAIT:BRAVE>']))).toBe(
            'multiBlock',
        );
        expect(code(applyTagChange(ARCHIVE, [], ['<Name:Anya>']))).toBe('name');
        expect(code(applyTagChange(ARCHIVE, [], ['<DEPRESSION>']))).toBe('malformed');
        expect(code(applyTagChange(ARCHIVE, ['nope'], ['<TRAIT:BRAVE>']))).toBe('malformed');
        expect(code(applyTagChange(ARCHIVE, [], ['nope']))).toBe('malformed');
        expect(code(applyTagChange(ARCHIVE, [], ['<TRAIT:SHY>']))).toBe('noChange');
        expect(code(applyTagChange(ARCHIVE, [], ['<TRAIT:BAD\nVALUE>']))).toBe('malformed');
    });
});

describe('passport tags', () => {
    it('tidies English lower-case tags', () => {
        expect(checkPassportTags(' short_hair,  black hair , short hair ')).toEqual({
            ok: true,
            tags: 'short hair, black hair',
        });
    });

    it('rejects Russian, upper case, explicit anatomy, markup and empty values', () => {
        const code = (value: string) => {
            const result = checkPassportTags(value);
            return result.ok ? 'ok' : result.rejection.code;
        };
        expect(code('короткие волосы')).toBe('cyrillic');
        expect(code('Short Hair')).toBe('uppercase');
        expect(code('large breasts, nipples')).toBe('anatomy');
        expect(code('scar, <lora>')).toBe('malformed');
        expect(code(' , ')).toBe('empty');
        expect(isExplicitAnatomy('Pubic Hair')).toBe(true);
        expect(isExplicitAnatomy('cumulus clouds')).toBe(false);
    });
});

describe('aliases and keys', () => {
    it('accepts short plain nicknames only', () => {
        expect(checkAlias('Аня')).toBeNull();
        expect(checkAlias(' ')).toEqual({ code: 'empty' });
        expect(checkAlias('a very long nickname that never ends')).toEqual({ code: 'tooLong' });
        expect(checkAlias('x'.repeat(41))).toEqual({ code: 'tooLong' });
        expect(checkAlias('<Name:A>')).toMatchObject({ code: 'malformed' });
        expect(checkAlias('BLANK')).toMatchObject({ code: 'placeholder' });
    });

    it('finds broken keys', () => {
        expect(invalidKeys(['Аня', '/(?:^|[^\\p{L}])Ань/iu'])).toEqual([]);
        expect(invalidKeys(['', 'a\nb', '/(unclosed/i'])).toEqual(['', 'a\nb', '/(unclosed/i']);
    });

    it('merges keys by normalised name', () => {
        expect(mergeKeys(['Anna', 'Аня'], ['аня', 'Анечка', ' '])).toEqual(['Anna', 'Аня', 'Анечка']);
        expect(mergeKeys(['Anna'], ['anna'])).toBeNull();
    });
});
