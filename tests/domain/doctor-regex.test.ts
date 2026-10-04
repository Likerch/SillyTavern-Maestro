import { describe, expect, it } from 'vitest';
import {
    DES_SCRIPT_NAMES,
    compileFind,
    findRegexIssues,
    firesOn,
    guessOwner,
    normalizeScript,
    probeBreaksJson,
    probeBreaksMarkers,
    probeStripsTags,
    regexMode,
    simulateReplace,
} from '../../src/domain/doctor-regex';
import type { RegexCheckContext, RegexScriptInfo, RegexType } from '../../src/domain/doctor-regex';

let seq = 0;
function script(raw: Record<string, unknown>, type: RegexType = 'global', allowed = true): RegexScriptInfo {
    return normalizeScript(
        { id: `id${++seq}`, scriptName: `S${seq}`, replaceString: '', placement: [2], trimStrings: [], ...raw },
        type,
        seq,
        allowed,
    );
}

/** DES's own "Clean HTML (From Outgoing Prompt)" (research/des.md §5). */
const CLEAN_HTML = { findRegex: '/\\s?<(?!\\!--)(?:"[^"]*"|\'[^\']*\'|[^\'">])*>/g', promptOnly: true };
const FIX_QUOTES = { findRegex: '/[“”]/g', replaceString: '"' };
const quiet: RegexCheckContext = { bunnymo: false, des: 'off', nai: false };

describe('normalizeScript and modes', () => {
    it('normalises raw scripts defensively', () => {
        const info = normalizeScript(
            {
                scriptName: 'X',
                findRegex: '/a/',
                placement: [1, 'x'],
                trimStrings: ['t', 3],
                substituteRegex: '2',
                minDepth: 2,
            },
            'preset',
            4,
            false,
        );
        expect(info).toMatchObject({
            id: 'preset:4',
            scriptId: '',
            placement: [1],
            trimStrings: ['t'],
            substituteRegex: 2,
            minDepth: 2,
            maxDepth: null,
            allowed: false,
        });
        expect(normalizeScript(null, 'global', 0, true)).toMatchObject({ id: 'global:0', name: '', find: '' });
        expect(normalizeScript({ substituteRegex: 1, id: 'u' }, 'scoped', 0, true)).toMatchObject({
            id: 'scoped:u',
            substituteRegex: 1,
        });
    });

    it('tells display, prompt, both and edit-time scripts apart', () => {
        expect(regexMode({ markdownOnly: true, promptOnly: false })).toBe('display');
        expect(regexMode({ markdownOnly: false, promptOnly: true })).toBe('prompt');
        expect(regexMode({ markdownOnly: true, promptOnly: true })).toBe('displayAndPrompt');
        expect(regexMode({ markdownOnly: false, promptOnly: false })).toBe('edit');
    });
});

describe('the engine port', () => {
    it('compiles like regexFromString', () => {
        expect(compileFind('/abc/gi')?.flags).toBe('gi');
        expect(compileFind('plain')?.source).toBe('plain');
        expect(compileFind('/a/gg')?.source).toBe('\\/a\\/gg');
        expect(compileFind('/(/')).toBeNull();
        expect(compileFind('')).toBeNull();
    });

    it('replaces with {{match}}, groups, named groups and trim strings', () => {
        expect(simulateReplace({ find: '/(b)(x)?/g', replace: '[{{match}}|$1|$2]', trimStrings: [] }, 'abc')).toBe(
            'a[b|b|]c',
        );
        expect(
            simulateReplace({ find: '/(?<word>an+a)/', replace: '<$<word>>', trimStrings: ['n'] }, 'Anna and anna'),
        ).toBe('Anna and <aa>');
        expect(simulateReplace({ find: '/(/', replace: 'x', trimStrings: [] }, 'abc')).toBe('abc');
        expect(simulateReplace({ find: '/a/', replace: 'x', trimStrings: [] }, '')).toBe('');
        expect(firesOn(/x/g, ['a', 'bx'])).toBe(true);
        expect(firesOn(/x/g, ['a'])).toBe(false);
    });

    it('probes tags, tracker JSON and NAI markers', () => {
        const clean = script(CLEAN_HTML);
        expect(probeStripsTags(clean, compileFind(clean.find)!)).toBe(true);
        const keepTags = script({
            findRegex: '/<(?![A-Z]+(?::[^>]+)?>|[EI][NS][FT][JP]-[UH]>)[^>]*>/g',
            promptOnly: true,
        });
        expect(probeStripsTags(keepTags, compileFind(keepTags.find)!)).toBe(false);
        const quotes = script(FIX_QUOTES);
        const json = probeBreaksJson(quotes, compileFind(quotes.find)!);
        expect(json.broken).toBe(true);
        expect(json.example).toContain('"ушла"');
        const fence = script({ findRegex: '/```[\\s\\S]*?```/g' });
        expect(probeBreaksJson(fence, compileFind(fence.find)!)).toEqual({ broken: true, example: '' });
        const harmless = script({ findRegex: '/Анна/g', replaceString: 'Anna' });
        expect(probeBreaksJson(harmless, compileFind(harmless.find)!).broken).toBe(false);
        expect(probeBreaksMarkers(clean, compileFind(clean.find)!)).toBe(true);
        expect(probeBreaksMarkers(harmless, compileFind(harmless.find)!)).toBe(false);
    });
});

describe('guessOwner', () => {
    it('recognises DES, [RM], Horae, RPG Companion and Marinara', () => {
        for (const name of DES_SCRIPT_NAMES) expect(guessOwner({ name, type: 'global' })).toBe('des');
        expect(guessOwner({ name: "Doom's thing", type: 'global' })).toBe('des');
        expect(guessOwner({ name: '[RM] ┌ hide reasoning', type: 'global' })).toBe('rm');
        expect(guessOwner({ name: 'Horae memory', type: 'global' })).toBe('horae');
        expect(guessOwner({ name: 'RPG Companion tracker', type: 'global' })).toBe('rpgCompanion');
        expect(guessOwner({ name: 'Fix Double Quotations', type: 'global' })).toBe('marinara');
        expect(guessOwner({ name: "Format Character's Thoughts (Only Display)", type: 'global' })).toBe('marinara');
        expect(guessOwner({ name: 'Anything', type: 'preset' }, { presetIsMarinara: true })).toBe('marinara');
        expect(guessOwner({ name: 'Mine', type: 'global' })).toBe('user');
        expect(guessOwner({ name: 'Card regex', type: 'scoped' })).toBe('unknown');
    });
});

describe('findRegexIssues', () => {
    it('reports tag stripping, broken JSON and markers by neighbour state', () => {
        const scripts = [
            script({ ...CLEAN_HTML, scriptName: 'Clean HTML' }),
            script({ ...FIX_QUOTES, scriptName: 'Quotes' }),
        ];
        const context: RegexCheckContext = { bunnymo: true, des: 'together', nai: true };
        const issues = findRegexIssues(scripts, context);
        expect(issues.map((issue) => [issue.kind, issue.messageKey, issue.severity])).toEqual([
            ['regex.stripsTags', 'm5.f.stripsTagsPrompt', 'warn'],
            ['regex.breaksJson', 'm5.f.breaksJson', 'error'],
        ]);
        expect(issues[0]?.target).toEqual({ scripts: [{ id: scripts[0]!.id, name: 'Clean HTML', type: 'global' }] });
        expect(findRegexIssues(scripts, { ...context, des: 'on' })[1]?.severity).toBe('warn');
        expect(findRegexIssues(scripts, quiet)).toEqual([]);
        const edit = script({ ...CLEAN_HTML, promptOnly: false, scriptName: 'Strip' });
        const editIssues = findRegexIssues([edit], context).map((issue) => issue.messageKey);
        expect(editIssues).toEqual(['m5.f.stripsTagsStored', 'm5.f.breaksMarkers']);
        const dropJson = script({ findRegex: '/```[\\s\\S]*?```/g', scriptName: 'Drop JSON' });
        expect(findRegexIssues([dropJson], context).map((issue) => issue.messageKey)).toEqual(['m5.f.removesJson']);
        expect(findRegexIssues([script({ ...CLEAN_HTML, markdownOnly: true, promptOnly: false })], context)).toEqual(
            [],
        );
    });

    it('reports invalid, not allowed and World Info scripts without prompt-only', () => {
        const scripts = [
            script({ findRegex: '/(/', scriptName: 'Broken' }),
            script({ findRegex: '/a/', scriptName: 'P1' }, 'preset', false),
            script({ findRegex: '/b/', scriptName: 'P2' }, 'preset', false),
            script({ findRegex: '/c/', scriptName: 'Lore', placement: [5] }),
            script({ findRegex: '/d/', scriptName: 'Off', disabled: true }),
            script({ findRegex: '', scriptName: 'Empty' }),
        ];
        const issues = findRegexIssues(scripts, quiet);
        expect(issues.map((issue) => issue.messageKey)).toEqual([
            'm5.f.regexInvalid',
            'm5.f.regexNotAllowed.preset',
            'm5.f.regexWorldInfoNotPrompt',
        ]);
        expect(issues[1]?.params).toMatchObject({ count: 2, sample: 'P1, P2' });
    });

    it('finds duplicates and conflicts in the same mode and place', () => {
        const scripts = [
            script({ findRegex: '/x/g', replaceString: 'y', scriptName: 'One', markdownOnly: true }),
            script({ findRegex: '/x/g', replaceString: 'y', scriptName: 'Two', markdownOnly: true, placement: [1, 2] }),
            script({ findRegex: '/q/g', replaceString: '1', scriptName: 'Q1', promptOnly: true }),
            script({ findRegex: '/q/g', replaceString: '2', scriptName: 'Q2', promptOnly: true }, 'preset'),
            script({ findRegex: '/q/g', replaceString: '3', scriptName: 'Q3', markdownOnly: true }),
            script({ findRegex: '/z/g', replaceString: '', scriptName: 'Z1', promptOnly: true, placement: [1] }),
            script({ findRegex: '/z/g', replaceString: '', scriptName: 'Z2', promptOnly: true, placement: [2] }),
        ];
        const issues = findRegexIssues(scripts, quiet);
        expect(issues.map((issue) => [issue.kind, issue.params?.a, issue.params?.b])).toEqual([
            ['regex.duplicate', 'One', 'Two'],
            ['regex.conflict', 'Q1', 'Q2'],
        ]);
    });

    it('calls display/prompt scripts dead when nothing in this chat matches', () => {
        const scripts = [
            script({ findRegex: '/<thinking>/', scriptName: 'Thinking', markdownOnly: true }),
            script({ findRegex: '/Анна/', scriptName: 'Anna', promptOnly: true, placement: [1] }),
            script({ findRegex: '/reason/', scriptName: 'Reasoning', markdownOnly: true, placement: [6] }),
            script({ findRegex: '/tavern/', scriptName: 'Lore', promptOnly: true, placement: [5] }),
            script({ findRegex: '/never/', scriptName: 'Edit' }),
            script({ findRegex: '/never/', scriptName: 'Slash', promptOnly: true, placement: [3] }),
        ];
        const chat = { user: ['Анна пришла'], ai: ['ok'], reasoning: ['no'], checked: 12 };
        const issues = findRegexIssues(scripts, { ...quiet, chat, lore: ['A tavern.'] });
        expect(issues.map((issue) => issue.params?.name)).toEqual(['Thinking', 'Reasoning']);
        expect(issues[0]).toMatchObject({ kind: 'regex.dead', messageKey: 'm5.f.regexDead', params: { count: 12 } });
        expect(findRegexIssues(scripts, { ...quiet, chat: { ...chat, checked: 3 } })).toEqual([]);
        const noLore = findRegexIssues([scripts[3]!], { ...quiet, chat });
        expect(noLore).toEqual([]);
    });
});
