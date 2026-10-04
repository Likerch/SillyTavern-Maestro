// Preset Studio analysis (M34 п.1, п.3, п.9): the prompt map over a Marinara-like working copy, the findings of every
// kind, provider hints and the token cache, on the ST mock with a fake preset store, Prompt Manager and lore journal.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresetAnalysis } from '../../../src/features/presetStudio/analysis';
import type { PresetAnalysis } from '../../../src/features/presetStudio/analysis';
import type { FindingKind, PresetFinding } from '../../../src/features/presetStudio/analysis-api';
import type { PresetBody, PresetDraftState, PresetStore } from '../../../src/features/presetStudio/store-api';
import type { App } from '../../../src/shared/contracts';
import { createTestHost, createTestI18n, createTestLogger } from '../../helpers/core-host';
import type { TestHost } from '../../helpers/core-host';
import { installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

const TRACKER_TEXT =
    'After every reply output the tracker block in json format with the fields time location weather and characters present';
const LORE_TEXT = 'The tavern never closes and the innkeeper knows every rumour that passes through the old port town';

type Prompt = Record<string, unknown>;

function prompts(): Prompt[] {
    return [
        {
            identifier: 'main',
            name: 'Main Prompt',
            system_prompt: true,
            content: 'You are {{char}}. <instructions>Story.',
        },
        { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
        { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
        { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
        { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
        { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
        {
            identifier: 'rules',
            name: 'Rules',
            system_prompt: false,
            content: 'Write in third person. {{char}} speaks softly.',
        },
        { identifier: 'pov', name: 'Point of view', system_prompt: false, content: 'Narrate in first person.' },
        { identifier: 'legacy', name: 'Legacy', content: 'An old block without the flag.' },
        {
            identifier: 'dup1',
            name: 'Dup one',
            system_prompt: false,
            content: 'Keep the scene moving forward at all times.',
        },
        {
            identifier: 'dup2',
            name: 'Dup two',
            system_prompt: false,
            content: 'Keep the scene moving forward at all times.',
        },
        { identifier: 'tracker', name: 'Tracker copy', system_prompt: false, content: TRACKER_TEXT },
        { identifier: 'loreCopy', name: 'Lore copy', system_prompt: false, content: `Setting: ${LORE_TEXT}.` },
        {
            identifier: 'heavy',
            name: 'Heavy',
            system_prompt: false,
            content: 'lorem ipsum dolor sit amet '.repeat(120),
        },
        {
            identifier: 'cond',
            name: 'Conditional',
            system_prompt: false,
            content: '\n{{if .maestro_x}}Only sometimes{{/if}}\n',
        },
        { identifier: 'blank', name: 'Blank', system_prompt: false, content: '   ' },
        {
            identifier: 'reminder',
            name: 'Reminder',
            system_prompt: false,
            role: 'system',
            injection_position: 1,
            injection_depth: 2,
            content: 'Remember the plot.',
        },
        {
            identifier: 'fakeReply',
            name: 'Fake reply',
            system_prompt: false,
            role: 'assistant',
            injection_position: 1,
            injection_depth: 3,
            content: 'I nod.',
        },
        {
            identifier: 'posString',
            name: 'Position as text',
            system_prompt: false,
            injection_position: '1',
            content: 'Pos.',
        },
        { identifier: 'prefill', name: 'Prefill', system_prompt: false, role: 'assistant', content: '<thinking>' },
    ];
}

const ORDER = [
    'main',
    'worldInfoBefore',
    'charDescription',
    'rules',
    'pov',
    'legacy',
    'dup1',
    'dup2',
    'tracker',
    'loreCopy',
    'heavy',
    'cond',
    'blank',
    'dialogueExamples',
    'chatHistory',
    'reminder',
    'fakeReply',
    'posString',
    'prefill',
];

function body(disabled: string[] = ['dialogueExamples'], ids: string[] = ORDER): PresetBody {
    return {
        prompts: prompts() as PresetBody['prompts'],
        prompt_order: [
            {
                character_id: 100001,
                order: ids.map((identifier) => ({ identifier, enabled: !disabled.includes(identifier) })),
            },
        ],
    };
}

/** The order with the scenario and world-info-after markers in place (nothing is appended after the prefill). */
const FULL_ORDER = [...ORDER.slice(0, 3), 'scenario', 'worldInfoAfter', ...ORDER.slice(3)];

interface Env {
    mock: StMock;
    host: TestHost;
    app: App;
    apis: Map<string, unknown>;
    counts: Record<string, number> | null;
    draft: PresetDraftState;
    tokenizer: ReturnType<typeof vi.fn>;
    analysis: PresetAnalysis;
    working: PresetBody;
}

let env: Env;

function setup(options: { store?: boolean; pm?: boolean } = {}): Env {
    const mock = installStMock();
    const host = createTestHost(mock);
    const state = {
        counts: { worldInfoBefore: 120, charDescription: 300, chatHistory: 2000, rules: 42, main: 5000 } as Record<
            string,
            number
        > | null,
    };
    if (options.pm !== false) {
        host.modules.openai = async () => ({
            promptManager: { tokenHandler: { getCounts: () => state.counts } },
        });
    }
    const context = mock.context as unknown as Record<string, unknown>;
    const working = body();
    context.chatCompletionSettings = {
        chat_completion_source: 'openrouter',
        openrouter_model: 'deepseek/deepseek-v4-flash',
        reasoning_effort: 'min',
        show_thoughts: false,
        temp_openai: 0.8,
        prompts: working.prompts,
        prompt_order: working.prompt_order,
    };
    context.extensionPrompts = {
        'dooms-tracker-inject': { value: TRACKER_TEXT, position: 1, depth: 0, scan: false, role: 1 },
        customDepthWI_2_0: { value: 'Lore at depth two', position: 1, depth: 2, scan: false, role: 0 },
        carrotkernel_rag: { value: 'RAG text', position: 2, depth: 0, scan: false, role: 0 },
        qvink_memory_long: { value: 'Long memory', position: 0, depth: 0, scan: false, role: 0 },
        maestro_flag: { value: '', position: 1, depth: 1, scan: false, role: 0 },
    };
    context.powerUserSettings = { experimental_macro_engine: true, user_prompt_bias: '' };
    context.characters = [
        { name: 'Вера', avatar: 'v.png', description: 'A tall woman', scenario: 'In a tavern by the sea', data: {} },
    ];
    const tokenizer = vi.fn(async (text: string) => Math.ceil(text.length / 4));
    context.getTokenCountAsync = tokenizer;

    const apis = new Map<string, unknown>();
    apis.set('loreJournal', {
        last: () => ({
            activations: [
                { position: 0, tokens: 50 },
                { position: 1, tokens: 30 },
                { position: 1, tokens: 99, cut: true },
            ],
        }),
        lastContents: () => [{ world: 'World', uid: 7, comment: 'Tavern', content: LORE_TEXT }],
    });
    const draft: PresetDraftState = { dirty: true, changedPrompts: ['rules', 'pov'], changedKeys: ['temperature'] };
    const store = {
        working: () => working,
        draft: () => draft,
    } as unknown as PresetStore;
    if (options.store !== false) apis.set('presetStore', store);
    const app = {
        host,
        i18n: createTestI18n('en'),
        log: createTestLogger(),
        modules: {
            list: () => [],
            enable: async () => {},
            disable: async () => {},
            api: <T>(key: string) => apis.get(key) as T | undefined,
            expose: (key: string, api: unknown) => apis.set(key, api),
        },
    } as unknown as App;
    const analysis = createPresetAnalysis(app, createTestLogger(), options.store === false ? undefined : store);
    analysis.install();
    return {
        mock,
        host,
        app,
        apis,
        get counts() {
            return state.counts;
        },
        set counts(value) {
            state.counts = value;
        },
        draft,
        tokenizer,
        analysis,
        working,
    };
}

function kinds(findings: PresetFinding[], kind: FindingKind): PresetFinding[] {
    return findings.filter((finding) => finding.kind === kind);
}

beforeEach(() => {
    env = setup();
});

describe('analysis.map', () => {
    it('reconstructs the assembly order with markers, in-chat blocks and appended markers', async () => {
        const map = await env.analysis.map();
        expect(map.map((slot) => slot.identifier)).toEqual([
            ...ORDER.slice(0, ORDER.indexOf('chatHistory') + 1),
            'fakeReply',
            'reminder',
            'posString',
            'prefill',
            // Not in the list but carrying text (lore of the last turn, the card's scenario): appended after the history.
            'worldInfoAfter',
            'scenario',
        ]);
        expect(map.at(-2)).toMatchObject({ name: 'World Info (after)', tokens: 30, tokensFrom: 'count' });
        const reminder = map.find((slot) => slot.identifier === 'reminder')!;
        expect(reminder).toMatchObject({ placement: 'depth', depth: 2, order: 100, role: 'system', enabled: true });
        expect(map.at(-1)).toMatchObject({ identifier: 'scenario', marker: true, noteCodes: ['notInList'] });
        expect(map.at(-1)?.note).toContain('not in the list');
    });

    it('counts tokens with ST: PM numbers for markers and macro blocks, the tokenizer for the rest', async () => {
        const map = await env.analysis.map();
        const by = (id: string) => map.find((slot) => slot.identifier === id)!;
        expect(by('worldInfoBefore')).toMatchObject({ tokens: 120, tokensFrom: 'st' });
        expect(by('charDescription')).toMatchObject({ tokens: 300, tokensFrom: 'st' });
        expect(by('chatHistory')).toMatchObject({ tokens: 2000, tokensFrom: 'st' });
        expect(by('rules')).toMatchObject({ tokens: 42, tokensFrom: 'st' });
        // Main's PM count holds the injections around it: Maestro counts its own text.
        const main = prompts()[0]!.content as string;
        expect(by('main')).toMatchObject({ tokens: Math.ceil(main.length / 4), tokensFrom: 'count' });
        expect(by('pov')).toMatchObject({
            tokens: Math.ceil('Narrate in first person.'.length / 4),
            tokensFrom: 'count',
        });
        expect(by('scenario')).toMatchObject({
            tokens: Math.ceil('In a tavern by the sea'.length / 4),
            tokensFrom: 'count',
        });
    });

    it('shows extension prompts where they land, with owners and tokens', async () => {
        const map = await env.analysis.map();
        const by = (id: string) => map.find((slot) => slot.identifier === id)!;
        expect(by('main').injections).toEqual([
            { owner: 'ck', key: 'carrotkernel_rag', tokens: 2, where: 'start' },
            { owner: 'qvink', key: 'qvink_memory_long', tokens: 3, where: 'end' },
        ]);
        expect(by('reminder').injections).toEqual([
            { owner: 'wiDepth', key: 'customDepthWI_2_0', tokens: 5, where: 'chat', depth: 2, role: 'system' },
        ]);
        expect(by('reminder').note).toContain('extension prompts');
        expect(by('chatHistory').injections).toEqual([
            {
                owner: 'des',
                key: 'dooms-tracker-inject',
                tokens: Math.ceil(TRACKER_TEXT.length / 4),
                where: 'chat',
                depth: 0,
                role: 'user',
            },
        ]);
    });

    it('explains why enabled blocks are not sent, in the user’s language', async () => {
        const map = await env.analysis.map();
        const legacy = map.find((slot) => slot.identifier === 'legacy')!;
        expect(legacy.droppedCode).toBe('systemPrompt');
        expect(legacy.dropped).toBe(
            'Not sent: system_prompt is undefined, and ST sends its own blocks only when it is exactly false.',
        );
        expect(map.find((slot) => slot.identifier === 'dialogueExamples')).toMatchObject({ enabled: false });
        expect(map.find((slot) => slot.identifier === 'dialogueExamples')?.dropped).toBeUndefined();
        const position = map.find((slot) => slot.identifier === 'posString')!;
        expect(position).toMatchObject({ placement: 'relative', noteCodes: ['positionString'] });
        expect(position.dropped).toBeUndefined();

        const noHistory = await env.analysis.map(body(['dialogueExamples', 'chatHistory']));
        expect(noHistory.find((slot) => slot.identifier === 'reminder')).toMatchObject({
            droppedCode: 'noHistory',
            dropped: 'Not inserted: the chat history is off, and in-chat blocks live inside it.',
        });
    });

    it('assembles for another generation type', async () => {
        const prompt = prompts();
        const triggered = {
            ...body(),
            prompts: [
                ...prompt,
                { identifier: 'cont', system_prompt: false, injection_trigger: ['continue'], content: 'c' },
            ] as PresetBody['prompts'],
        };
        triggered.prompt_order![0]!.order.push({ identifier: 'cont', enabled: true });
        const normal = await env.analysis.map(triggered);
        expect(normal.find((slot) => slot.identifier === 'cont')).toMatchObject({
            droppedCode: 'trigger',
            triggers: ['continue'],
            dropped: 'Not sent for “normal” generations: triggers continue.',
        });
        const forContinue = await env.analysis.map(triggered, { type: 'continue' });
        expect(forContinue.find((slot) => slot.identifier === 'cont')?.dropped).toBeUndefined();
    });

    it('caches token counts by model and text hash', async () => {
        await env.analysis.map();
        const calls = env.tokenizer.mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        await env.analysis.map();
        await env.analysis.findings();
        expect(env.tokenizer.mock.calls.length).toBe(calls);
        // Another model may use another tokenizer: counted again.
        (
            env.mock.context as unknown as { chatCompletionSettings: Record<string, unknown> }
        ).chatCompletionSettings.openrouter_model = 'deepseek/deepseek-v4-pro';
        await env.analysis.map();
        expect(env.tokenizer.mock.calls.length).toBe(calls * 2);
        // dispose() drops the cache.
        env.analysis.dispose();
        await env.analysis.map();
        expect(env.tokenizer.mock.calls.length).toBe(calls * 3);
    });

    it('estimates when the tokenizer fails, and counts parallel requests once', async () => {
        env.tokenizer.mockImplementation(async () => {
            throw new Error('no tokenizer');
        });
        const map = await env.analysis.map();
        expect(map.find((slot) => slot.identifier === 'pov')?.tokens).toBe(
            Math.ceil('Narrate in first person.'.length / 3.5),
        );
        env.analysis.dispose();
        env.tokenizer.mockImplementation(async (text: string) => text.length);
        const [a, b] = await Promise.all([env.analysis.map(), env.analysis.map()]);
        expect(a.map((slot) => slot.tokens)).toEqual(b.map((slot) => slot.tokens));
    });

    it('works without the store and without the Prompt Manager: live settings, card texts and lore for markers', async () => {
        env = setup({ store: false, pm: false });
        const map = await env.analysis.map();
        const by = (id: string) => map.find((slot) => slot.identifier === id)!;
        expect(map.length).toBeGreaterThan(10);
        expect(by('charDescription')).toMatchObject({
            tokens: Math.ceil('A tall woman'.length / 4),
            tokensFrom: 'count',
        });
        expect(by('worldInfoBefore')).toMatchObject({ tokens: 50, tokensFrom: 'count' });
        expect(by('rules').tokensFrom).toBe('count');
        expect(by('chatHistory').tokens).toBe(0);
        const findings = await env.analysis.findings();
        expect(kinds(findings, 'unsaved')).toEqual([]);
    });
});

describe('analysis.findings', () => {
    it('reports every kind on the fixture, warnings first', async () => {
        const findings = await env.analysis.findings();
        const firstInfo = findings.findIndex((finding) => finding.severity === 'info');
        expect(findings.slice(firstInfo).every((finding) => finding.severity === 'info')).toBe(true);

        expect(kinds(findings, 'unsaved')).toEqual([
            {
                kind: 'unsaved',
                severity: 'warn',
                text: 'Unsaved changes in the working copy: blocks 2, settings 1. Switching the preset drops them silently.',
            },
        ]);
        expect(kinds(findings, 'neverIncluded')).toEqual([
            expect.objectContaining({ severity: 'warn', identifier: 'worldInfoAfter' }),
            expect.objectContaining({
                severity: 'warn',
                identifier: 'scenario',
                text: '“Scenario”: The marker is not in the list: ST puts its text at the very end, after the history.',
            }),
        ]);
        const types = kinds(findings, 'typeMismatch');
        expect(types.map((finding) => finding.identifier)).toEqual(['legacy', 'posString']);
        expect(types[1]!.text).toBe('“Position as text”: position "1"; ST understands only the numbers 0 and 1.');
        expect(kinds(findings, 'emptyMessage').map((finding) => finding.identifier)).toEqual(['cond', 'blank']);
        expect(kinds(findings, 'contradiction')).toEqual([
            expect.objectContaining({
                severity: 'warn',
                identifier: 'rules',
                otherIdentifier: 'pov',
                text: '“Rules” and “Point of view” disagree on the narration person: third person vs first person.',
            }),
        ]);
        expect(kinds(findings, 'duplicateBlock')).toEqual([
            expect.objectContaining({ severity: 'warn', identifier: 'dup1', otherIdentifier: 'dup2' }),
        ]);
        expect(kinds(findings, 'duplicateWithInjection')).toEqual([
            expect.objectContaining({
                identifier: 'tracker',
                text: expect.stringContaining('des extension prompt dooms-tracker-inject'),
            }),
        ]);
        expect(kinds(findings, 'duplicateWithLore')).toEqual([
            expect.objectContaining({ identifier: 'loreCopy', text: expect.stringContaining('“Tavern” of World') }),
        ]);
        expect(kinds(findings, 'heavyBlock')).toEqual([
            expect.objectContaining({ identifier: 'heavy', severity: 'info' }),
        ]);
        expect(kinds(findings, 'macroEngineOff')).toEqual([]);
    });

    it('reports the DeepSeek V4 quirks of the OpenRouter connection', async () => {
        // With the appended markers the scenario would close the prompt: here they stand in the list.
        expect(kinds(await env.analysis.findings(), 'modelQuirk')[0]?.severity).toBe('info');
        const quirks = kinds(await env.analysis.findings(body(['dialogueExamples'], FULL_ORDER)), 'modelQuirk');
        expect(quirks).toEqual([
            {
                kind: 'modelQuirk',
                severity: 'warn',
                identifier: 'prefill',
                text: 'DeepSeek V4 Flash: the prompt ends with an assistant message (block “Prefill”). Through OpenRouter such a prefill is closed by EOS and the reply ends at once.',
            },
            expect.objectContaining({
                severity: 'info',
                identifier: 'reminder',
                text: expect.stringContaining('(«Reminder» @2, wiDepth ×1)'),
            }),
            expect.objectContaining({
                severity: 'info',
                identifier: 'fakeReply',
                text: expect.stringContaining('«Fake reply» @3'),
            }),
        ]);
    });

    it('reports «Start reply with» as the prefill, and nothing for another model', async () => {
        const context = env.mock.context as unknown as Record<string, Record<string, unknown>>;
        context.powerUserSettings!.user_prompt_bias = 'Sure,';
        const withBias = kinds(
            await env.analysis.findings(body(['dialogueExamples', 'prefill'], FULL_ORDER)),
            'modelQuirk',
        );
        expect(withBias[0]?.text).toContain('(“Start Reply With”)');
        expect(withBias[0]?.identifier).toBeUndefined();

        context.chatCompletionSettings!.openrouter_model = 'anthropic/claude-sonnet';
        expect(kinds(await env.analysis.findings(), 'modelQuirk')).toEqual([]);
    });

    it('warns about {{if}} with the old macro engine, the missing history and lost injections', async () => {
        const context = env.mock.context as unknown as Record<string, Record<string, unknown>>;
        context.powerUserSettings!.experimental_macro_engine = false;
        const order = ORDER.filter((id) => id !== 'chatHistory' && id !== 'main');
        const noMain: PresetBody = {
            ...body(),
            prompt_order: [{ character_id: 100001, order: order.map((identifier) => ({ identifier, enabled: true })) }],
        };
        const findings = await env.analysis.findings(noMain);
        expect(kinds(findings, 'macroEngineOff')).toEqual([
            expect.objectContaining({
                severity: 'warn',
                identifier: 'cond',
                text: expect.stringContaining('«Conditional»'),
            }),
        ]);
        const never = kinds(findings, 'neverIncluded');
        expect(never.map((finding) => finding.identifier)).toEqual([
            'chatHistory',
            'worldInfoAfter',
            'scenario',
            'main',
        ]);
        expect(never[0]!.text).toContain('(not in the list)');
        expect(never[3]!.text).toContain('carrotkernel_rag, qvink_memory_long');
        // A body given explicitly is not the working copy: no draft warning.
        expect(kinds(findings, 'unsaved')).toEqual([]);

        const disabled = await env.analysis.findings(body(['chatHistory']));
        expect(kinds(disabled, 'neverIncluded')[0]?.text).toContain('(switched off)');
        const prompt = prompts().map((item) =>
            item.identifier === 'chatHistory' ? { ...item, injection_trigger: ['quiet'] } : item,
        );
        const triggered = await env.analysis.findings({ ...body(), prompts: prompt as PresetBody['prompts'] });
        expect(kinds(triggered, 'neverIncluded')[0]?.text).toContain('its trigger does not fit “normal”');
    });

    it('reports in-chat injections lost to a bad depth, empty and missing blocks as info', async () => {
        const context = env.mock.context as unknown as Record<string, Record<string, unknown>>;
        context.extensionPrompts!.weird = { value: 'Odd depth', position: 1, depth: 1.5, scan: false, role: 0 };
        const extra: PresetBody = {
            ...body(),
            prompts: [
                ...prompts(),
                { identifier: 'empty', name: 'Empty', system_prompt: false, content: '' },
            ] as PresetBody['prompts'],
        };
        extra.prompt_order![0]!.order.push(
            { identifier: 'empty', enabled: true },
            { identifier: 'gone', enabled: true },
        );
        const findings = await env.analysis.findings(extra);
        const never = kinds(findings, 'neverIncluded');
        expect(never.find((finding) => finding.identifier === 'empty')).toMatchObject({ severity: 'info' });
        expect(never.find((finding) => finding.identifier === 'gone')?.text).toContain('does not exist');
        expect(never.find((finding) => finding.text.includes('weird'))).toMatchObject({ severity: 'warn' });
    });

    it('survives a failing store and reports typed values ST tolerates as info', async () => {
        const store = env.apis.get('presetStore') as { draft: () => unknown };
        store.draft = () => {
            throw new Error('not ready');
        };
        const odd: PresetBody = {
            prompts: [
                { identifier: 'chatHistory', name: 'Chat History', marker: true },
                { identifier: 'odd', name: 'Odd', system_prompt: false, content: 'x', injection_trigger: 'normal' },
            ] as PresetBody['prompts'],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'chatHistory', enabled: true },
                        { identifier: 'odd', enabled: 'true' as unknown as boolean },
                    ],
                },
            ],
        };
        const findings = await env.analysis.findings(odd);
        expect(kinds(findings, 'typeMismatch').map((finding) => [finding.severity, finding.text])).toEqual([
            ['info', '“Odd”: the switch is stored as "true", not true/false; ST only checks truthiness.'],
            ['info', '“Odd”: triggers "normal" are not a list, ST ignores them.'],
        ]);
        // The working copy with a broken store: no draft warning, no crash.
        expect(kinds(await env.analysis.findings(), 'unsaved')).toEqual([]);
    });
});

describe('analysis.hints and the factory', () => {
    it('gives the DeepSeek V4 hints for the OpenRouter connection', () => {
        const hints = env.analysis.hints();
        expect(hints.map((hint) => hint.key)).toEqual([
            'reasoningOff',
            'prefillEos',
            'systemMerge',
            'assistantDepth',
            'temperature',
            'openrouterProvider',
        ]);
        expect(hints[0]).toMatchObject({ model: 'deepseek/deepseek-v4-flash' });
        expect(hints[4]!.text).toBe(
            'DeepSeek V4 Flash: a starting temperature range through OpenRouter is 0.6–1 (now 0.8); verify live, providers may scale it differently.',
        );
        const context = env.mock.context as unknown as Record<string, Record<string, unknown>>;
        delete context.chatCompletionSettings!.temp_openai;
        expect(env.analysis.hints()[4]!.text).toContain('(now —)');
        env.host.isChatCompletion = () => false;
        expect(env.analysis.hints()).toEqual([]);
    });

    it('returns the API itself with `api`, install() disposers and dispose()', () => {
        const { analysis, app } = env;
        expect(typeof analysis.map).toBe('function');
        expect(typeof analysis.api.findings).toBe('function');
        expect(analysis.api.hints()).toEqual(analysis.hints());
        const disposers = analysis.install();
        expect(disposers).toHaveLength(1);
        expect(() => disposers[0]!()).not.toThrow();
        expect(app.i18n.t('m34.an.drop.empty')).toBe('Empty text: ST drops empty messages.');
    });
});
