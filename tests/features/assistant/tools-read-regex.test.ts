// Read tools over ST's regex scripts: the inventory (the Doctor's or the settings), the explainer, the tester.
import { describe, expect, it } from 'vitest';
import type { RegexInfo } from '../../../src/features/doctor/api';
import { readTools } from '../../../src/features/assistant/tools';
import { fakeApp, runTool, toolContext } from './tools-helpers';
import type { Loose } from './tools-helpers';

const SETTINGS_SCRIPTS = [
    {
        id: 'uuid-1',
        scriptName: 'Hide tracker',
        findRegex: '/```json[\\s\\S]*?```/g',
        replaceString: '',
        trimStrings: [],
        placement: [2],
        markdownOnly: true,
        promptOnly: false,
        disabled: false,
    },
    {
        id: 'uuid-2',
        scriptName: 'Bold names',
        findRegex: '/\\b(Kai|Anna)\\b/g',
        replaceString: '**{{match}}**',
        trimStrings: ['x'],
        placement: [1, 2],
        disabled: true,
    },
];

function settingsFake(extra: Record<string, unknown> = {}) {
    return fakeApp({
        ctx: {
            name1: 'Ivan',
            name2: 'Anna',
            extensionSettings: { regex: SETTINGS_SCRIPTS, disabledExtensions: ['regex'] },
            characterId: 0,
            characters: [
                {
                    name: 'Anna',
                    avatar: 'anna.png',
                    data: { extensions: { regex_scripts: [{ id: 'c1', scriptName: 'Card', findRegex: 'x' }] } },
                },
            ],
            chatCompletionSettings: {
                preset_settings_openai: 'Marinara',
                extensions: {
                    regex_scripts: [{ id: 'p1', scriptName: 'Preset one', findRegex: '/y/g', placement: [5] }],
                },
            },
        },
        ...extra,
    });
}

const INVENTORY: RegexInfo[] = [
    {
        id: 'global:uuid-1',
        name: 'Hide tracker',
        type: 'global',
        disabled: false,
        placement: [2],
        promptOnly: false,
        markdownOnly: true,
        owner: 'des',
        find: '/```json[\\s\\S]*?```/g',
        replace: '',
        allowed: true,
    },
];

describe('regex_list', () => {
    it('reads the scripts from the settings in ST order when the Doctor is off', async () => {
        const fake = settingsFake();
        const output = await runTool(readTools(fake.app), 'regex_list', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.scripts.map((script: { id: string }) => script.id)).toEqual([
            'global:uuid-1',
            'global:uuid-2',
            'preset:p1',
            'scoped:c1',
        ]);
        expect(data.scripts[0]).toEqual({
            id: 'global:uuid-1',
            name: 'Hide tracker',
            type: 'global',
            placement: ['AI output'],
            mode: 'display',
            find: '/```json[\\s\\S]*?```/g',
            replace: '',
        });
        expect(data.scripts[1]).toMatchObject({ disabled: true, mode: 'edit', placement: ['user input', 'AI output'] });
        // Not allowed: no preset or character allow-list.
        expect(data.scripts[2]).toMatchObject({ allowed: false, placement: ['world info'] });
        expect(data.regexExtensionOff).toBe(true);
        expect(data.modes.display).toContain('see');
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Regexes: 4');
    });

    it('filters by type, state and text', async () => {
        const fake = settingsFake();
        const tools = readTools(fake.app);
        const ctx = toolContext(fake, { locale: 'ru' });
        const global = await runTool(tools, 'regex_list', { type: 'global', include_disabled: false }, ctx);
        expect((global.data as { total: number }).total).toBe(1);
        const query = await runTool(tools, 'regex_list', { query: 'kai' }, ctx);
        expect((query.data as { scripts: { name: string }[] }).scripts.map((script) => script.name)).toEqual([
            'Bold names',
        ]);
        expect(query.summary).toBe('Регексы: 1');
    });

    it('uses the Doctor inventory with its findings', async () => {
        const fake = settingsFake({
            apis: {
                doctor: {
                    regexInventory: async () => INVENTORY,
                    findings: () => [
                        {
                            id: 'f',
                            kind: 'regex.breaksJson',
                            severity: 'error',
                            messageKey: 'm5.json',
                            params: { name: 'Hide tracker' },
                            target: { name: 'Hide tracker' },
                        },
                        { id: 'g', kind: 'keys.noRussian', severity: 'warn', messageKey: 'x', target: {} },
                    ],
                },
            },
            strings: { en: { 'm5.json': '{name} breaks the DES JSON' }, ru: {} },
        });
        const output = await runTool(readTools(fake.app), 'regex_list', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.scripts).toEqual([
            {
                id: 'global:uuid-1',
                name: 'Hide tracker',
                type: 'global',
                placement: ['AI output'],
                mode: 'display',
                owner: 'des',
                find: '/```json[\\s\\S]*?```/g',
                replace: '',
            },
        ]);
        expect(data.findings).toEqual([
            {
                kind: 'regex.breaksJson',
                severity: 'error',
                script: 'Hide tracker',
                text: 'Hide tracker breaks the DES JSON',
            },
        ]);
        expect(output.summary).toBe('Regexes: 1, 1 findings');
    });
});

describe('regex_explain', () => {
    it('explains a stored script with where it runs and what it changes', async () => {
        const fake = settingsFake();
        const output = await runTool(
            readTools(fake.app),
            'regex_explain',
            { script: 'bold names' },
            toolContext(fake, { locale: 'ru' }),
        );
        const data = output.data as Loose;
        expect(data.ok).toBe(true);
        expect(data.summary).toBe(
            'граница слова, затем группа 1 (либо текст «Kai», либо текст «Anna»), затем граница слова',
        );
        expect(data.warnings.map((warning: { code: string }) => warning.code)).toEqual(['latinOnly']);
        expect(data.script).toMatchObject({
            id: 'global:uuid-2',
            disabled: true,
            placement: ['user input', 'AI output'],
            replace: '**{{match}}**',
            trimStrings: ['x'],
        });
        expect(data.script.changes).toContain('переписывает');
        expect(output.summary).toBe('Регекс разобран: Bold names');
    });

    it('explains a pattern with flags, and reports bad input', async () => {
        const fake = fakeApp();
        const tools = readTools(fake.app);
        const ctx = toolContext(fake);
        const output = await runTool(tools, 'regex_explain', { pattern: '\\d+', flags: 'g' }, ctx);
        expect((output.data as Loose).summary).toBe('a digit [one or more times]');
        expect(output.summary).toBe('Regex explained');
        const slashed = await runTool(tools, 'regex_explain', { pattern: '/a|b/i' }, ctx);
        expect((slashed.data as Loose).flags).toBe('i');
        const bad = await runTool(tools, 'regex_explain', { pattern: '(' }, ctx);
        expect(bad.summary).toBe('The pattern does not compile');
        expect((await runTool(tools, 'regex_explain', {}, ctx)).summary).toBe('Give a script or a pattern.');
        expect((await runTool(tools, 'regex_explain', { script: 'nope' }, ctx)).summary).toBe(
            'No regex script «nope».',
        );
    });
});

describe('regex_test', () => {
    it('runs a pattern with ST semantics: {{match}}, groups, macros, first match without g', async () => {
        const fake = settingsFake();
        const tools = readTools(fake.app);
        const ctx = toolContext(fake);
        const output = await runTool(
            tools,
            'regex_test',
            { pattern: '(\\w+)@(\\w+)', flags: 'g', replacement: '{{user}}: [{{match}}] $2/$1 $&', sample: 'a@b c@d' },
            ctx,
        );
        const data = output.data as Loose;
        expect(data.result).toBe('Ivan: [a@b] b/a $& Ivan: [c@d] d/c $&');
        expect(data.matches).toEqual([
            { index: 0, text: 'a@b', groups: ['a', 'b'] },
            { index: 4, text: 'c@d', groups: ['c', 'd'] },
        ]);
        expect(data.notes.map((note: { code: string }) => note.code)).toEqual(['unsupportedDollar']);
        expect(output.summary).toBe('Regex test: 2 matches, text changed');
        expect(output.untrusted).toBe(true);
        const first = await runTool(tools, 'regex_test', { pattern: 'a', replacement: 'b', sample: 'aaa' }, ctx);
        expect((first.data as Loose).result).toBe('baa');
    });

    it('tests a stored script (trim strings) and adds the ST engine result through the Doctor', async () => {
        const fake = settingsFake({
            apis: {
                doctor: {
                    regexInventory: async () => [
                        ...INVENTORY,
                        {
                            id: 'global:uuid-2',
                            name: 'Bold names',
                            type: 'global',
                            disabled: true,
                            placement: [1, 2],
                            promptOnly: false,
                            markdownOnly: false,
                            owner: 'user',
                            find: '/\\b(Kai|Anna)\\b/g',
                            replace: '**$1**',
                        },
                    ],
                    findings: () => [],
                    testRegex: async (id: string, text: string) => `${id}:${text.toUpperCase()}`,
                },
            },
        });
        const output = await runTool(
            readTools(fake.app),
            'regex_test',
            { script: 'global:uuid-2', sample: 'Kai met Anna' },
            toolContext(fake, { locale: 'ru' }),
        );
        const data = output.data as Loose;
        expect(data.result).toBe('**Kai** met **Anna**');
        expect(data.engineResult).toBe('global:uuid-2:KAI MET ANNA');
        expect(data.script).toEqual({ id: 'global:uuid-2', name: 'Bold names', disabled: true });
        expect(output.summary).toBe('Испытание регекса: совпадений 2, текст изменён');
        const trimmed = await runTool(
            readTools(fake.app),
            'regex_test',
            { script: 'Bold names', sample: 'Kai', replacement: '<$1>' },
            toolContext(fake),
        );
        expect((trimmed.data as Loose).result).toBe('<Kai>');
    });

    it('asks for what is missing and reports a bad pattern', async () => {
        const fake = fakeApp();
        const tools = readTools(fake.app);
        const ctx = toolContext(fake, { locale: 'ru' });
        expect((await runTool(tools, 'regex_test', { pattern: 'a' }, ctx)).summary).toBe('Нужен пример текста.');
        expect((await runTool(tools, 'regex_test', { sample: 'a' }, ctx)).summary).toBe('Нужен скрипт или шаблон.');
        expect((await runTool(tools, 'regex_test', { sample: 'a', script: 'x' }, ctx)).summary).toBe(
            'Нет регекса «x».',
        );
        const bad = await runTool(tools, 'regex_test', { sample: 'a', pattern: '(', flags: 'g' }, ctx);
        expect(bad.summary).toBe('Шаблон не компилируется');
        expect((bad.data as Loose).ok).toBe(false);
    });
});
