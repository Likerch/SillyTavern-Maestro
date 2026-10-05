import { describe, expect, it } from 'vitest';
import {
    compileRunPattern,
    fillMacros,
    RUN_NOTE_TEXT,
    runRegex,
    stRegexFromString,
    stReplace,
} from '../../src/domain/assistant-explain-regex-run';

describe('stRegexFromString (ST regexFromString)', () => {
    it('reads /source/flags and bare sources without flags', () => {
        expect(stRegexFromString('/a+/gi')?.flags).toBe('gi');
        expect(stRegexFromString('/a+/gi')?.source).toBe('a+');
        const bare = stRegexFromString('a+');
        expect(bare?.source).toBe('a+');
        expect(bare?.global).toBe(false);
    });

    it('falls back to the whole input on unknown flags and gives null on bad syntax', () => {
        // Invalid flags: ST compiles the input itself as the pattern.
        expect(stRegexFromString('/a/zz')?.source).toBe('\\/a\\/zz');
        expect(stRegexFromString('/(a/g')).toBeNull();
        expect(stRegexFromString('')).toBeNull();
    });
});

describe('compileRunPattern', () => {
    it('takes the pattern as a bare source when flags are given', () => {
        const { regex } = compileRunPattern('/a.b/', 'gs');
        expect(regex?.source).toBe('a.b');
        expect(regex?.flags).toBe('gs');
        expect(compileRunPattern('a(', 'g').error).toBeTruthy();
    });

    it('reports a syntax error of an ST-style pattern', () => {
        expect(compileRunPattern('a(').error).toBeTruthy();
        expect(compileRunPattern('a(').regex).toBeNull();
    });
});

describe('fillMacros', () => {
    it('fills known macros case-insensitively and reports the others', () => {
        expect(fillMacros('{{User}} and {{char}} at {{time}}', { user: 'Ivan', char: 'Anna' })).toEqual({
            text: 'Ivan and Anna at {{time}}',
            unknown: ['time'],
        });
    });
});

describe('stReplace (ST runRegexScript semantics)', () => {
    it('expands {{match}}, $0, $1 and $<name>, and leaves $& literal', () => {
        const regex = /(?<first>\w+) (\w+)/g;
        expect(stReplace('john smith', regex, '[{{match}}] $2, $<first> | $0 | $&').text).toBe(
            '[john smith] smith, john | john smith | $&',
        );
    });

    it('gives an empty string for a group that did not take part', () => {
        expect(stReplace('ac', /a(b)?c/, 'x$1y').text).toBe('xy');
    });

    it('removes trim strings from inserted groups (macros inside them filled)', () => {
        expect(stReplace('<b>Anna</b>', /<b>(.*?)<\/b>/g, '$1!', ['nn', '{{char}}'], { char: 'A' }).text).toBe('a!');
    });

    it('fills macros after the groups and reports missing groups', () => {
        const result = stReplace('hi', /hi/, '{{user}}:$2', [], { user: 'Ivan' });
        // ST reads args[2] = the whole input (match, offset, input).
        expect(result.text).toBe('Ivan:hi');
        expect(result.missingGroup).toBe(true);
        expect(stReplace('hi', /(?<a>hi)/, '$<b>').missingGroup).toBe(true);
        expect(stReplace('hi', /hi/, '{{time}}').unknownMacros).toEqual(['time']);
    });
});

describe('runRegex', () => {
    it('lists every match with groups and replaces with the g flag', () => {
        const run = runRegex({
            pattern: '/(\\d+)-(?<unit>[a-z]+)/g',
            replacement: '<$1 $<unit>>',
            sample: '5-kg and 10-m',
        });
        expect(run.ok).toBe(true);
        expect(run.matchCount).toBe(2);
        expect(run.matches).toEqual([
            { index: 0, text: '5-kg', groups: ['5', 'kg'], named: { unit: 'kg' } },
            { index: 9, text: '10-m', groups: ['10', 'm'], named: { unit: 'm' } },
        ]);
        expect(run.result).toBe('<5 kg> and <10 m>');
        expect(run.changed).toBe(true);
        expect(run.notes).toEqual([]);
    });

    it('replaces only the first match without g (a bare ST pattern)', () => {
        const run = runRegex({ pattern: 'a', replacement: 'b', sample: 'aaa' });
        expect(run.result).toBe('baa');
        expect(run.matchCount).toBe(1);
        expect(run.notes).toContain('noGlobal');
    });

    it('honours explicit flags (i, s, m, u) and reports null groups', () => {
        expect(runRegex({ pattern: 'ANNA', flags: 'gi', sample: 'anna Anna' }).matchCount).toBe(2);
        expect(runRegex({ pattern: 'a.b', flags: 'gs', sample: 'a\nb' }).matchCount).toBe(1);
        expect(runRegex({ pattern: 'a.b', flags: 'g', sample: 'a\nb' }).matchCount).toBe(0);
        expect(runRegex({ pattern: '^x', flags: 'gm', sample: 'x\nx' }).matchCount).toBe(2);
        expect(runRegex({ pattern: '\\p{L}+', flags: 'gu', sample: 'Привет мир' }).matchCount).toBe(2);
        expect(runRegex({ pattern: 'a(b)?', flags: 'g', sample: 'a' }).matches[0]!.groups).toEqual([null]);
    });

    it('notes unsupported $&, unknown macros, missing groups, empty matches and sticky', () => {
        expect(runRegex({ pattern: '/a/g', replacement: '$&', sample: 'a' }).notes).toContain('unsupportedDollar');
        expect(runRegex({ pattern: '/a/g', replacement: '{{time}}', sample: 'a' }).unknownMacros).toEqual(['time']);
        expect(runRegex({ pattern: '/a/g', replacement: '$2', sample: 'a' }).notes).toContain('missingGroup');
        expect(runRegex({ pattern: '/x*/g', sample: 'ab' }).notes).toContain('emptyMatch');
        expect(runRegex({ pattern: 'a', flags: 'y', sample: 'ba' }).notes).toContain('sticky');
        // ST's regexFromString does not accept y: the whole input becomes a literal pattern.
        expect(runRegex({ pattern: '/a/y', sample: 'ba' }).matchCount).toBe(0);
    });

    it('caps listed matches and their length but counts them', () => {
        const run = runRegex({ pattern: '/./g', sample: 'x'.repeat(30) }, { maxMatches: 5, maxMatchChars: 3 });
        expect(run.matches).toHaveLength(5);
        expect(run.matchCount).toBe(30);
        expect(run.notes).toContain('matchesCapped');
        const long = runRegex({ pattern: '/.+/', sample: 'y'.repeat(50) }, { maxMatchChars: 10 });
        expect(long.matches[0]!.text).toHaveLength(10);
        expect(runRegex({ pattern: '/./g', sample: 'x'.repeat(50) }, { countCap: 7 }).matchCount).toBe(7);
    });

    it('leaves an empty sample untouched and reports a bad pattern', () => {
        const empty = runRegex({ pattern: '/a/g', replacement: 'b', sample: '' });
        expect(empty.result).toBe('');
        expect(empty.changed).toBe(false);
        const bad = runRegex({ pattern: '(a', flags: 'g', sample: 'a' });
        expect(bad.ok).toBe(false);
        expect(bad.error).toBeTruthy();
        expect(runRegex({ pattern: '/(a/g', sample: 'a' }).ok).toBe(false);
    });

    it('has a text for every note in both languages', () => {
        for (const locale of ['en', 'ru'] as const) {
            for (const text of Object.values(RUN_NOTE_TEXT[locale])) expect(text.length).toBeGreaterThan(10);
        }
    });
});
