// regex_create and regex_toggle (M33 part C, «регексы с испытанием»): the required test in the card, risky effects
// reported, global scripts written into extension_settings.regex (through ST's engine or directly), journal and undo;
// character-card and preset scripts are never touched.
import { describe, expect, it } from 'vitest';
import { planError, writeFake } from './tools-write-fakes';

interface RegexEnv {
    settings: { regex: unknown[]; disabledExtensions?: string[] };
    saves: number;
    engineSaves: { scripts: unknown[]; type: number }[];
    acknowledged: string[][];
    scans: number;
}

function setup(options: { engine?: boolean; scripts?: unknown[]; locale?: 'en' | 'ru'; off?: boolean } = {}) {
    const env: RegexEnv = {
        settings: { regex: options.scripts ?? [], ...(options.off ? { disabledExtensions: ['regex'] } : {}) },
        saves: 0,
        engineSaves: [],
        acknowledged: [],
        scans: 0,
    };
    const engine = {
        SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
        getRegexScripts: () => env.settings.regex,
        getScriptsByType: (type: number) => (type === 0 ? env.settings.regex : []),
        saveScriptsByType: (scripts: unknown[], type: number) => {
            env.engineSaves.push({ scripts, type });
            env.settings.regex = scripts;
        },
    };
    const fake = writeFake({
        locale: options.locale ?? 'en',
        caps: options.engine ? ['st.regex'] : [],
        hostModules: options.engine ? { regexEngine: engine } : {},
        apis: {
            guardian: { acknowledge: async (paths: string[]) => void env.acknowledged.push(paths) },
            doctor: {
                lastScanAt: () => 1,
                scan: async () => {
                    env.scans += 1;
                    return [];
                },
            },
        },
        ctx: {
            extensionSettings: env.settings,
            saveSettingsDebounced: () => {
                env.saves += 1;
            },
            uuidv4: () => 'uuid-1',
        },
    });
    return { fake, env };
}

const STARS = {
    name: 'No asterisks',
    find: '\\*+',
    replace: '',
    placement: ['ai_output'],
    samples: ['*She smiles.* Hello', 'Plain text'],
};

describe('regex_create', () => {
    it('runs the required test and shows each sample before/after in the card', async () => {
        const { fake } = setup({ locale: 'ru' });
        const plan = await fake.plan('regex_create', STARS, 'ru');
        expect(plan.summary).toBe(
            'Новый регекс «No asterisks» (ответы ИИ; только показ); проверка: изменено примеров — 1 из 2',
        );
        expect(plan.target).toBe('Регексы ST · общие');
        expect(plan.before).toEqual({ regex: null, samples: ['*She smiles.* Hello', 'Plain text'] });
        expect(plan.after).toEqual({
            regex: { name: 'No asterisks', find: '/\\*+/g', replace: '', placement: ['ai_output'], mode: 'display' },
            samples: ['She smiles. Hello', 'Plain text'],
        });
    });

    it('writes a global script in ST shape into extension_settings.regex and undo removes it', async () => {
        const { fake, env } = setup({ scripts: [{ id: 'old', scriptName: 'Old' }] });
        const plan = await fake.plan('regex_create', { ...STARS, options: { mode: 'edit', trimStrings: ['~'] } });
        expect(env.settings.regex).toHaveLength(1);
        const { result } = await plan.apply();
        expect(result).toEqual({ id: 'uuid-1', name: 'No asterisks' });
        expect(env.settings.regex).toEqual([
            { id: 'old', scriptName: 'Old' },
            {
                id: 'uuid-1',
                scriptName: 'No asterisks',
                findRegex: '/\\*+/g',
                replaceString: '',
                trimStrings: ['~'],
                placement: [2],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: true,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            },
        ]);
        expect(env.saves).toBe(1);
        expect(env.acknowledged).toEqual([['regex']]);
        expect(env.scans).toBe(1);
        const change = fake.undoJournal.records[0]!.changes[0]!;
        expect(change.target).toBe('assistant-regex');
        expect(change.ref).toEqual({ op: 'create', scriptId: 'uuid-1', name: 'No asterisks' });
        expect(await fake.undoJournal.undoLast()).toBe(true);
        expect(env.settings.regex).toEqual([{ id: 'old', scriptName: 'Old' }]);
    });

    it("saves through ST's regex engine when it is loaded", async () => {
        const { fake, env } = setup({ engine: true });
        await (await fake.plan('regex_create', STARS)).apply();
        expect(env.engineSaves).toHaveLength(1);
        expect(env.engineSaves[0]!.type).toBe(0);
        expect((env.settings.regex[0] as Record<string, unknown>).scriptName).toBe('No asterisks');
        expect(env.saves).toBe(0);
    });

    it('does not undo a script the user edited since', async () => {
        const { fake, env } = setup();
        await (await fake.plan('regex_create', STARS)).apply();
        (env.settings.regex[0] as Record<string, unknown>).findRegex = '/x/g';
        expect(await fake.undoJournal.undoLast()).toBe(false);
        expect(env.settings.regex).toHaveLength(1);
    });

    it('fails the test when no sample changes or a result differs from the expected one', async () => {
        const { fake } = setup({ locale: 'ru' });
        expect(await planError(fake.plan('regex_create', { ...STARS, samples: ['nothing here'] }, 'ru'))).toMatch(
            /^Проверка не прошла: регекс не меняет ни один пример/,
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, expected: ['She smiles. Hello', 'Plain'] }))).toBe(
            'Test failed on sample 2: expected «Plain», got «Plain text».',
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, expected: ['x'] }))).toBe(
            '«expected» needs one text per sample (2).',
        );
        const ok = await fake.plan('regex_create', { ...STARS, expected: ['She smiles. Hello', 'Plain text'] });
        expect(ok.summary).toContain('1 of 2');
    });

    it('refuses regexes ST would not compile the same way', async () => {
        const { fake } = setup();
        expect(await planError(fake.plan('regex_create', { ...STARS, find: '(unclosed' }))).toMatch(
            /^The regex does not compile: /,
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, flags: 'gy' }))).toBe(
            'Flags «gy» do not fit: SillyTavern takes g, i, m, s, u (each once).',
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, find: '/a/i', flags: 'g' }))).toBe(
            'The flags are given twice and differ: «i» in find, «g» in flags.',
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, placement: ['everywhere'] }))).toBe(
            '«placement» must be one of: user_input, ai_output, slash_command, world_info, reasoning.',
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, samples: [] }))).toBe(
            'The parameter «samples» is missing.',
        );
        expect(await planError(fake.plan('regex_create', { ...STARS, options: { minDepth: 5, maxDepth: 2 } }))).toBe(
            'minDepth is above maxDepth.',
        );
    });

    it('warns about DES JSON, BunnyMo tags, NAI markers, empty matches and macros', async () => {
        const { fake } = setup();
        const braces = await fake.plan('regex_create', {
            ...STARS,
            name: 'Braces',
            find: '[{}]',
            samples: ['{a}'],
        });
        expect((braces.after as Record<string, unknown>).warnings).toEqual([
            'Breaks the DES tracker JSON in replies.',
            'Damages NAI Studio image markers.',
        ]);
        const tags = await fake.plan('regex_create', {
            ...STARS,
            name: 'Tags',
            find: '<[^>]+>',
            replace: '{{user}}',
            samples: ['<b>x</b>'],
        });
        expect((tags.after as Record<string, unknown>).warnings).toEqual([
            'Removes BunnyMo tags.',
            'Damages NAI Studio image markers.',
            'Macros ({{…}}) were not filled in during the test.',
        ]);
        const empty = await fake.plan('regex_create', {
            ...STARS,
            name: 'Empty',
            find: 'x*',
            placement: ['user_input'],
        });
        expect((empty.after as Record<string, unknown>).warnings).toEqual([
            'Matches empty text: the replacement goes between characters.',
        ]);
    });

    it('warns about World Info without «prompt only», a taken name and the Regex extension being off', async () => {
        const { fake } = setup({ scripts: [{ id: 'a', scriptName: 'no asterisks' }], off: true });
        const plan = await fake.plan('regex_create', { ...STARS, placement: ['world_info'] });
        expect((plan.after as Record<string, unknown>).warnings).toEqual([
            'On World Info a regex works only in the «prompt only» mode.',
            'A global regex with this name already exists.',
            'The Regex extension is disabled in SillyTavern: no script runs.',
        ]);
        const prompt = await fake.plan('regex_create', {
            ...STARS,
            name: 'Lore',
            placement: ['world_info'],
            options: { mode: 'prompt' },
        });
        expect((prompt.after as Record<string, unknown>).warnings).toEqual([
            'The Regex extension is disabled in SillyTavern: no script runs.',
        ]);
    });

    it('is offered when ST regex scripts can be reached', () => {
        const fake = writeFake({ ctx: { extensionSettings: {} } });
        const tool = fake.tools.find((item) => item.name === 'regex_create')!;
        expect(tool.available?.(fake.app)).toBe(false);
        expect(tool.available?.(setup().fake.app)).toBe(true);
        expect(tool.available?.(setup({ engine: true }).fake.app)).toBe(true);
    });
});

describe('regex_toggle', () => {
    const scripts = () => [
        { id: 'a1', scriptName: 'Trim', disabled: false },
        { id: 'b2', scriptName: 'Fix', disabled: true },
        { id: 'c3', scriptName: 'Twin' },
        { id: 'd4', scriptName: 'twin' },
    ];

    it('switches a global script off, journals it and undo switches it back', async () => {
        const { fake, env } = setup({ scripts: scripts(), locale: 'ru' });
        const plan = await fake.plan('regex_toggle', { id: 'global:a1', on: false }, 'ru');
        expect(plan.summary).toBe('Регекс «Trim»: выключить');
        expect(plan.before).toEqual({ name: 'Trim', enabled: true });
        expect(plan.after).toEqual({ name: 'Trim', enabled: false });
        await plan.apply();
        expect((env.settings.regex[0] as Record<string, unknown>).disabled).toBe(true);
        expect(env.saves).toBe(1);
        expect(fake.undoJournal.records[0]!.changes[0]).toMatchObject({
            target: 'assistant-regex',
            ref: { op: 'toggle', scriptId: 'a1', name: 'Trim' },
            before: { disabled: false },
            after: { disabled: true },
        });
        expect(await fake.undoJournal.undoLast()).toBe(true);
        expect((env.settings.regex[0] as Record<string, unknown>).disabled).toBe(false);
    });

    it('finds a script by its exact name and switches it on', async () => {
        const { fake, env } = setup({ scripts: scripts() });
        await (await fake.plan('regex_toggle', { id: 'Fix', on: true })).apply();
        expect((env.settings.regex[1] as Record<string, unknown>).disabled).toBe(false);
    });

    it('never switches character-card or preset scripts', async () => {
        const { fake, env } = setup({ scripts: scripts() });
        expect(await planError(fake.plan('regex_toggle', { id: 'scoped:x1', on: false }))).toBe(
            'Only global regexes can be switched here: «scoped:x1» belongs to a character card or a preset.',
        );
        expect(await planError(fake.plan('regex_toggle', { id: 'preset:3', on: false }))).toMatch(/preset/);
        expect(env.saves).toBe(0);
    });

    it('refuses unknown, ambiguous and unchanged scripts', async () => {
        const { fake } = setup({ scripts: scripts(), locale: 'ru' });
        expect(await planError(fake.plan('regex_toggle', { id: 'zzz', on: true }, 'ru'))).toBe(
            'Общего регекса «zzz» нет.',
        );
        expect(await planError(fake.plan('regex_toggle', { id: 'TWIN', on: true }, 'ru'))).toBe(
            'Общих регексов «TWIN» несколько — укажи id.',
        );
        expect(await planError(fake.plan('regex_toggle', { id: 'b2', on: false }, 'ru'))).toBe(
            'Регекс «Fix» и так выключен.',
        );
    });

    it('does not undo a script switched again since', async () => {
        const { fake, env } = setup({ scripts: scripts() });
        await (await fake.plan('regex_toggle', { id: 'a1', on: false })).apply();
        (env.settings.regex[0] as Record<string, unknown>).disabled = false;
        expect(await fake.undoJournal.undoLast()).toBe(false);
    });
});
