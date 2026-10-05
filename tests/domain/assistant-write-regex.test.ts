import { describe, expect, it } from 'vitest';
import { ArgError } from '../../src/domain/assistant-write-args';
import {
    buildRegexScript,
    expectedMismatches,
    findRegexString,
    isForeignScriptRef,
    locateScript,
    placementNames,
    regexWarnings,
    runSamples,
    scriptMode,
    scriptView,
} from '../../src/domain/assistant-write-regex';
import type { RegexDraft } from '../../src/domain/assistant-write-regex';

function draft(patch: Partial<RegexDraft> = {}): RegexDraft {
    return {
        name: 'Stars',
        find: '\\*+',
        replace: '',
        placement: ['ai_output'],
        mode: 'display',
        runOnEdit: true,
        trimStrings: [],
        minDepth: null,
        maxDepth: null,
        substitute: 'none',
        disabled: false,
        ...patch,
    };
}

function codeOf(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof ArgError) return error.code;
        throw error;
    }
    return 'none';
}

describe('findRegexString', () => {
    it('always gives the /pattern/flags form ST compiles with its flags', () => {
        expect(findRegexString('a+')).toBe('/a+/g');
        expect(findRegexString('a+', 'gi')).toBe('/a+/gi');
        expect(findRegexString('a+', '')).toBe('/a+/');
        expect(findRegexString('/a+/i')).toBe('/a+/i');
        expect(findRegexString('/a+/gi', 'ig')).toBe('/a+/gi');
        expect(findRegexString('a/b')).toBe('/a/b/g');
    });

    it('refuses flags ST cannot take, contradicting flags and broken patterns', () => {
        expect(codeOf(() => findRegexString('a', 'gg'))).toBe('regexFlags');
        expect(codeOf(() => findRegexString('a', 'y'))).toBe('regexFlags');
        expect(codeOf(() => findRegexString('/a/i', 'g'))).toBe('regexFlagsConflict');
        expect(codeOf(() => findRegexString('(a'))).toBe('regexCompile');
        // A literal line break is not read the same way by ST's parser.
        expect(codeOf(() => findRegexString('a\nb'))).toBe('regexCompile');
    });
});

describe('buildRegexScript', () => {
    it('builds the script in ST shape with the mode flags', () => {
        expect(buildRegexScript(draft({ placement: ['world_info', 'user_input', 'user_input'] }), 'id-1')).toEqual({
            id: 'id-1',
            scriptName: 'Stars',
            findRegex: '/\\*+/g',
            replaceString: '',
            trimStrings: [],
            placement: [1, 5],
            disabled: false,
            markdownOnly: true,
            promptOnly: false,
            runOnEdit: true,
            substituteRegex: 0,
            minDepth: null,
            maxDepth: null,
        });
        const both = buildRegexScript(
            draft({ mode: 'displayAndPrompt', substitute: 'escaped', trimStrings: ['', '~'] }),
            'x',
        );
        expect([both.markdownOnly, both.promptOnly, both.substituteRegex, both.trimStrings]).toEqual([
            true,
            true,
            2,
            ['~'],
        ]);
        const prompt = buildRegexScript(draft({ mode: 'prompt' }), 'x');
        expect([prompt.markdownOnly, prompt.promptOnly]).toEqual([false, true]);
        const edit = buildRegexScript(draft({ mode: 'edit' }), 'x');
        expect([edit.markdownOnly, edit.promptOnly]).toEqual([false, false]);
    });

    it('refuses empty names, no placement and inverted depths', () => {
        expect(codeOf(() => buildRegexScript(draft({ name: ' ' }), 'x'))).toBe('argEmpty');
        expect(codeOf(() => buildRegexScript(draft({ placement: [] }), 'x'))).toBe('argMissing');
        expect(codeOf(() => buildRegexScript(draft({ minDepth: 3, maxDepth: 1 }), 'x'))).toBe('regexDepth');
    });

    it('describes stored scripts', () => {
        const script = buildRegexScript(draft({ minDepth: 0, maxDepth: 4, trimStrings: ['~'], disabled: true }), 'x');
        expect(scriptMode(script)).toBe('display');
        expect(scriptMode({ markdownOnly: true, promptOnly: true })).toBe('displayAndPrompt');
        expect(scriptMode({ markdownOnly: false, promptOnly: true })).toBe('prompt');
        expect(scriptMode({ markdownOnly: false, promptOnly: false })).toBe('edit');
        expect(placementNames([0, 2, 6, 4])).toEqual(['ai_output', 'reasoning']);
        expect(scriptView(script)).toEqual({
            name: 'Stars',
            find: '/\\*+/g',
            replace: '',
            placement: ['ai_output'],
            mode: 'display',
            trimStrings: ['~'],
            minDepth: 0,
            maxDepth: 4,
            disabled: true,
        });
    });
});

describe('runSamples and expectedMismatches', () => {
    it("runs samples with ST's replacement rules and compares with the expected results", () => {
        const script = buildRegexScript(draft({ find: '(\\w+)@(\\w+)', replace: '$2 at {{match}} ($1)' }), 'x');
        const results = runSamples(script, ['mail bob@home now', 'nothing']);
        expect(results).toEqual([
            { input: 'mail bob@home now', output: 'mail home at bob@home (bob) now', changed: true },
            { input: 'nothing', output: 'nothing', changed: false },
        ]);
        expect(expectedMismatches(results, ['mail home at bob@home (bob) now', 'nothing'])).toEqual([]);
        expect(expectedMismatches(results, ['x', 'nothing'])).toEqual([
            { index: 1, expected: 'x', actual: 'mail home at bob@home (bob) now' },
        ]);
        expect(codeOf(() => expectedMismatches(results, ['x']))).toBe('regexExpectedCount');
    });
});

describe('regexWarnings', () => {
    it('finds risky effects for AI output', () => {
        const braces = buildRegexScript(draft({ find: '[{}]' }), 'x');
        expect(regexWarnings(braces)).toEqual(['breaksJson', 'breaksMarkers']);
        const tags = buildRegexScript(draft({ find: '<[^>]+>', replace: '{{user}}' }), 'x');
        expect(regexWarnings(tags)).toEqual(['stripsTags', 'breaksMarkers', 'macros']);
        expect(regexWarnings(buildRegexScript(draft(), 'x'))).toEqual([]);
    });

    it('finds empty matches, World Info without prompt mode, macro substitution and taken names', () => {
        const empty = buildRegexScript(draft({ find: 'x*', placement: ['user_input'] }), 'x');
        expect(regexWarnings(empty)).toEqual(['matchesEmpty']);
        const lore = buildRegexScript(draft({ placement: ['world_info'], substitute: 'raw' }), 'x');
        expect(regexWarnings(lore, ['STARS'])).toEqual(['worldInfoNotPrompt', 'macros', 'sameName']);
        const loreTags = buildRegexScript(draft({ placement: ['world_info'], mode: 'prompt', find: '<[^>]+>' }), 'x');
        expect(regexWarnings(loreTags)).toEqual(['stripsTags']);
    });
});

describe('locateScript', () => {
    const list = [{ id: 'u1', scriptName: 'One' }, { scriptName: 'Two' }, { id: 'u3', scriptName: 'two' }, {}];

    it('finds by uuid, by "global:" id or index, by unique name', () => {
        expect(locateScript(list, 'u1')).toEqual({ index: 0, ambiguous: false });
        expect(locateScript(list, 'global:u3')).toEqual({ index: 2, ambiguous: false });
        expect(locateScript(list, 'global:1')).toEqual({ index: 1, ambiguous: false });
        expect(locateScript(list, 'one')).toEqual({ index: 0, ambiguous: false });
    });

    it('reports ambiguous names and unknown refs', () => {
        expect(locateScript(list, 'TWO')).toEqual({ index: -1, ambiguous: true });
        expect(locateScript(list, 'zzz')).toEqual({ index: -1, ambiguous: false });
        expect(locateScript(list, 'global:0')).toEqual({ index: -1, ambiguous: false });
        expect(locateScript(list, 'global:9')).toEqual({ index: -1, ambiguous: false });
    });

    it('tells card and preset scripts apart', () => {
        expect(isForeignScriptRef('scoped:abc')).toBe(true);
        expect(isForeignScriptRef(' preset:2')).toBe(true);
        expect(isForeignScriptRef('global:abc')).toBe(false);
        expect(isForeignScriptRef('abc')).toBe(false);
    });
});
