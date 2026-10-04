import { describe, expect, it } from 'vitest';
import {
    contentSignature,
    findAssistantAtDepth,
    findKeyIssues,
    findPackDuplicates,
    keySignature,
    newerBook,
    versionOf,
} from '../../src/domain/doctor-lore';
import type { BunnyBookKind } from '../../src/domain/doctor-types';
import { entry } from '../helpers/doctor-entries';

const packs = (...books: string[]) => new Map<string, BunnyBookKind>(books.map((book) => [book, 'pack']));
const none = new Map<string, BunnyBookKind>();

describe('versions', () => {
    it('reads version numbers and picks the newer book', () => {
        expect(versionOf('MBTI V2')).toEqual([2]);
        expect(versionOf('BunnyMo V3.0')).toEqual([3, 0]);
        expect(versionOf('Species')).toBeNull();
        expect(newerBook('MBTI v1 (Retired)', 'MBTI V2')).toBe('MBTI V2');
        expect(newerBook('MBTI V2', 'Old MBTI')).toBe('MBTI V2');
        expect(newerBook('Pack v1.2', 'Pack v1.10')).toBe('Pack v1.10');
        expect(newerBook('Pack v2', 'Pack v1')).toBe('Pack v2');
        expect(newerBook('Pack v1', 'Pack ver. 1')).toBeNull();
        expect(newerBook('CarrotCast', 'CarrotCast Limited')).toBeNull();
    });

    it('builds signatures from normalised keys or constants', () => {
        expect(keySignature(entry('A', { key: ['<b>', '<A: x>'] }))).toBe('["<A:X>","<B>"]');
        expect(keySignature(entry('A', { constant: true }))).toBe('#constant');
        expect(keySignature(entry('A', {}))).toBeNull();
        expect(contentSignature(' a \n\n b ')).toBe('a b');
    });
});

describe('findPackDuplicates', () => {
    it('aggregates identical entries per book pair and keeps the first book', () => {
        const entries = [
            entry('MBTI v1', { key: ['<INTJ-H>'], content: 'Same text', comment: 'Mastermind' }),
            entry('MBTI v1', { key: ['<INTP-H>'], content: 'Other', comment: 'Logician' }),
            entry('MBTI V2', { key: ['<intj-h>'], content: 'Same   text', comment: 'Mastermind' }),
            entry('MBTI V2', { key: ['<INTP-H>'], content: 'Other', comment: 'Logician' }),
            entry('MBTI V2', { key: ['<ENTJ-H>'], content: 'Only here' }),
        ];
        const issues = findPackDuplicates(entries, packs('MBTI v1', 'MBTI V2'));
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            kind: 'pack.duplicate',
            fixRule: 'pack.duplicates',
            fileFix: false,
            params: { a: 'MBTI v1', b: 'MBTI V2', count: 2, chars: 'Same   text'.length + 'Other'.length },
            target: { books: ['MBTI v1', 'MBTI V2'], book: 'MBTI V2' },
        });
        expect(issues[0]?.params?.sample).toBe('Mastermind, Logician');
    });

    it('reports version conflicts between BunnyMo books only, with the newer guess', () => {
        const entries = [
            entry('MBTI v1 (Retired)', { key: ['<INTJ-U>'], content: 'The Schemer' }),
            entry('MBTI V2', { key: ['<INTJ-U>'], content: 'The Cynic' }),
            entry('Lore', { key: ['Anna'], content: 'Anna the baker' }),
            entry('Archive', { key: ['Anna'], content: 'Anna the character' }),
        ];
        const issues = findPackDuplicates(entries, packs('MBTI v1 (Retired)', 'MBTI V2'));
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            kind: 'pack.versionConflict',
            messageKey: 'm5.f.packVersionConflict',
            params: { newer: 'MBTI V2', count: 1, sample: '<INTJ-U>' },
            fileFix: false,
        });
        const unsure = findPackDuplicates(
            [
                entry('CarrotCast', { key: ['<GENRE:X>'], content: 'one' }),
                entry('CarrotCast Limited', { key: ['<GENRE:X>'], content: 'two' }),
            ],
            packs('CarrotCast', 'CarrotCast Limited'),
        );
        expect(unsure[0]?.messageKey).toBe('m5.f.packVersionConflictUnsure');
        expect(unsure[0]?.params?.newer).toBeUndefined();
    });

    it('skips the intended BSM-5 + CoT Lenses pair, disabled, empty and keyless entries', () => {
        const entries = [
            entry('BSM-5', { key: ['<PTSD>'], content: 'clinical' }),
            entry('CoT Lenses', { key: ['<PTSD>'], content: 'lens', comment: 'CoT LENS: PTSD' }),
            entry('A', { key: ['x'], content: 'dup', disable: true }),
            entry('B', { key: ['x'], content: 'dup' }),
            entry('A', { key: ['y'], content: '   ' }),
            entry('B', { key: ['y'], content: '   ' }),
            entry('A', { content: 'never fires' }),
            entry('B', { content: 'never fires' }),
        ];
        expect(findPackDuplicates(entries, packs('BSM-5', 'CoT Lenses'))).toEqual([]);
    });

    it('allows a file fix for duplicates outside BunnyMo and counts constants', () => {
        const entries = [
            entry('World', { constant: true, content: 'Rules of magic' }),
            entry('World copy', { constant: true, content: 'Rules of magic' }),
            entry('World', { key: ['k'], content: 'a', comment: '' }),
            entry('World copy', { key: ['k'], content: 'b' }),
        ];
        const issues = findPackDuplicates(entries, none);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ kind: 'pack.duplicate', fileFix: true, params: { count: 1 } });
    });

    it('points version conflicts to their stage-2 rule and ignores pack constants (stage 2)', () => {
        const issues = findPackDuplicates(
            [
                entry('MBTI v1', { key: ['<INTJ-U>'], content: 'Schemer' }),
                entry('MBTI V2', { key: ['<INTJ-U>'], content: 'Cynic' }),
                entry('MBTI v1', { constant: true, content: 'Read me v1' }),
                entry('MBTI V2', { constant: true, content: 'Read me V2' }),
            ],
            packs('MBTI v1', 'MBTI V2'),
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            kind: 'pack.versionConflict',
            fixRule: 'pack.versionConflict',
            fileFix: false,
            params: { count: 1 },
        });
    });
});

describe('findAssistantAtDepth', () => {
    it('flags only enabled at-depth entries with the assistant role', () => {
        const entries = [
            entry('BunnyMo', { position: 4, role: 2, depth: 3, comment: 'AUTO-FILTRATION: LINGUISTICS' }),
            entry('Archive', { position: 4, role: 2, depth: 2, comment: 'Анна' }),
            entry('BunnyMo', { position: 4, role: 1, depth: 0 }),
            entry('Lore', { position: 1, role: 2 }),
            entry('Lore', { position: 4, role: 2, disable: true }),
        ];
        const issues = findAssistantAtDepth(entries, new Map([['BunnyMo', 'core']]));
        expect(issues.map((issue) => issue.target.book)).toEqual(['BunnyMo', 'Archive']);
        expect(issues[0]).toMatchObject({ fixRule: 'role.assistantToSystem', fileFix: false, params: { depth: 3 } });
        expect(issues[1]?.fileFix).toBe(true);
    });
});

describe('findKeyIssues', () => {
    const base = { russianChat: true, wholeWordsGlobal: false, bunnyBooks: packs('Species') };

    it('reports English-only prose keys per book in a Russian chat', () => {
        const entries = [
            entry('Flora', { key: ['Elizabeth'], comment: 'Elizabeth' }),
            entry('Flora', { key: ['ballroom'], comment: 'Ballroom' }),
            entry('Flora', { key: ['Элизабет', 'Elizabeth'] }),
            entry('Flora', { key: ['/\\bmanor\\b/i'] }),
            entry('Flora', { key: ['Lady'] }, ['Леди']),
            entry('Flora', { key: ['<SPECIES:ELF>'] }),
            entry('Flora', { key: ['!fullsheet'] }),
            entry('Flora', { key: ['Hall'], constant: true }),
            entry('Flora', { key: ['Hidden'], disable: true }),
            entry('Species', { key: ['Elf'] }),
        ];
        const issues = findKeyIssues(entries, base).filter((issue) => issue.kind === 'keys.noRussian');
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ params: { book: 'Flora', count: 2, sample: 'Elizabeth, Ballroom' } });
        expect(findKeyIssues(entries, { ...base, russianChat: false })).toEqual([]);
    });

    it('reports Cyrillic keys under whole-word matching, per entry or global setting', () => {
        const entries = [
            entry('Archive', { key: ['Аня'], keysecondary: ['Таня'], matchWholeWords: true }),
            entry('Archive', { key: ['Петя'] }),
            entry('Lore', { key: ['Аня Петрова', '/аня/i'], matchWholeWords: true }),
        ];
        const local = findKeyIssues(entries, { ...base, russianChat: false });
        expect(local).toHaveLength(1);
        expect(local[0]).toMatchObject({
            kind: 'keys.cyrillicWholeWord',
            severity: 'info',
            params: { book: 'Archive', count: 2, sample: 'Аня, Таня' },
        });
        const global = findKeyIssues(entries, { ...base, russianChat: false, wholeWordsGlobal: true });
        expect(global[0]?.params?.count).toBe(3);
    });

    it('reports broken Localizer keys with the first problem', () => {
        const entries = [
            entry('Lore', { key: ['Anna', '/Ан\\-на/iu'], comment: 'Anna' }, ['/Ан\\-на/iu', '/ok/iu']),
            entry('Lore', { key: ['Ivan'] }, ['/И\\{1\\}ван/i']),
            entry('Lore', { key: ['Ok'] }, ['/ок/iu']),
        ];
        const issues = findKeyIssues(entries, { ...base, russianChat: false });
        expect(issues.map((issue) => [issue.messageKey, issue.severity])).toEqual([
            ['m5.f.localizerBroken.syntax', 'error'],
            ['m5.f.localizerBroken.braces', 'warn'],
        ]);
        expect(issues[0]?.params).toMatchObject({ key: '/Ан\\-на/iu', count: 1, entry: 'Anna' });
    });

    it('points Cyrillic whole-word keys to the left-boundary rule, with a file fix outside BunnyMo (stage 2)', () => {
        const entries = [
            entry('Archive', { key: ['Аня'], matchWholeWords: true }),
            entry('Species', { key: ['Эльф'], matchWholeWords: true }),
        ];
        const issues = findKeyIssues(entries, { ...base, russianChat: false });
        expect(issues.map((issue) => [issue.params?.book, issue.fixRule, issue.fileFix])).toEqual([
            ['Archive', 'keys.cyrillicLeftBoundary', true],
            ['Species', 'keys.cyrillicLeftBoundary', false],
        ]);
    });
});
