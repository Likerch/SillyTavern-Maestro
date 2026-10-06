// The assistant's preset read tools over fakes (M33 over M34/M36, plan-2 §1): the dry run assembles the prompt from the
// studio's map without any request (conditions resolved with the flags set now, macros filled in except those with
// side effects, lore and history as sizes only, fitted to the result size), the findings with the model's hints, and
// the neighbours' prompts; neighbour_prompt_set changes a text everywhere or as a copy and refuses what it must not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeighbourPrompt, NeighbourPromptsApi } from '../../../src/features/neighbourPrompts/api';
import { NeighbourPromptError } from '../../../src/features/neighbourPrompts/api';
import type { MapSlot, PresetAnalysisApi } from '../../../src/features/presetStudio/analysis-api';
import type { PresetPrompt, PresetStore } from '../../../src/features/presetStudio/store-api';
import { readTools } from '../../../src/features/assistant/tools';
import { fakeApp, toolContext, toolNamed } from './tools-helpers';
import type { FakeApp, Loose } from './tools-helpers';
import { planError, writeFake } from './tools-write-fakes';

const PROMPTS: PresetPrompt[] = [
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Hello {{char}}, write the reply.' },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true },
    { identifier: 'combat', name: 'Combat', role: 'system', content: '{{if .maestro_scene_combat}}Fight hard.{{/if}}' },
    { identifier: 'vars', name: 'Vars', role: 'system', content: '{{setvar::x::1}}Keep {{char}} in mind.' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
    {
        identifier: 'note',
        name: 'Note',
        role: 'user',
        content: 'Remember {{char}}.',
        injection_position: 1,
        injection_depth: 2,
    },
];

function slotOf(prompt: PresetPrompt, patch: Partial<MapSlot> = {}): MapSlot {
    return {
        identifier: prompt.identifier,
        name: prompt.name,
        role: (prompt.role as MapSlot['role']) ?? 'system',
        placement: prompt.injection_position === 1 ? 'depth' : 'relative',
        depth: prompt.injection_position === 1 ? 2 : undefined,
        tokens: 25,
        enabled: true,
        marker: prompt.marker === true,
        injections: [],
        ...patch,
    };
}

function fakeStore(): PresetStore {
    return {
        names: () => ['Marinara', 'Other'],
        current: () => 'Marinara',
        working: () => ({ prompts: structuredClone(PROMPTS), temperature: 1 }),
        saved: () => ({ prompts: structuredClone(PROMPTS) }),
        draft: () => ({ dirty: false, changedPrompts: [], changedKeys: [] }),
        prompts: () => PROMPTS.map((prompt) => ({ item: { identifier: prompt.identifier, enabled: true }, prompt })),
        onChange: () => () => {},
    } as unknown as PresetStore;
}

function fakeAnalysis(): PresetAnalysisApi & { map: ReturnType<typeof vi.fn> } {
    const slots = PROMPTS.map((prompt) =>
        slotOf(
            prompt,
            prompt.identifier === 'worldInfoBefore'
                ? { tokens: 900, injections: [{ owner: 'canon', key: 'c', tokens: 120 }] }
                : {},
        ),
    );
    return {
        map: vi.fn(async () => slots),
        findings: async () => [
            {
                kind: 'contradiction',
                severity: 'warn',
                identifier: 'main',
                otherIdentifier: 'vars',
                text: 'Two rules disagree.',
            },
            { kind: 'unsaved', severity: 'info', text: 'Unsaved edits.' },
        ],
        hints: () => [
            {
                model: 'deepseek/deepseek-v4-flash',
                text: 'An assistant prefill ends the reply at once.',
                key: 'prefillEos',
            },
        ],
    } as unknown as PresetAnalysisApi & { map: ReturnType<typeof vi.fn> };
}

let fake: FakeApp;
let substitute: ReturnType<typeof vi.fn>;
let flags: Record<string, string>;
const fetchSpy = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => {
    flags = {};
    substitute = vi.fn((text: string) => text.replaceAll('{{char}}', 'Alice'));
    fake = fakeApp({
        apis: {
            presetStore: fakeStore(),
            presetAnalysis: fakeAnalysis(),
            director: { flags: () => flags, catalogue: () => [] },
            mechanics: { flagsOn: () => ['maestro_mech_mana'] },
        },
        ctx: { substituteParams: substitute, powerUserSettings: { experimental_macro_engine: true } },
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

async function run(name: string, args: Record<string, unknown> = {}, resultChars = 12000): Promise<Loose> {
    const ctx = { ...toolContext(fake), resultChars };
    const output = await toolNamed(readTools(fake.app), name).run!(args, ctx);
    // Block texts and the neighbours' prompts are other people's content: untrusted data (a notice is not).
    const data = output.data as Loose;
    if (data.note === undefined) expect(output.untrusted).toBe(true);
    return data;
}

describe('preset_dry_run', () => {
    it('assembles without any request: conditions with the flags now, macros filled, lore only as a size', async () => {
        const data = await run('preset_dry_run');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(data).toMatchObject({ preset: 'Marinara', type: 'normal', sent: false, macroEngine: 'on' });
        expect(data.flagsNow).toEqual(['maestro_mech_mana']);
        expect(data.messages.map((row: Loose) => row.name)).toEqual([
            'Main Prompt',
            'World Info (before)',
            'Vars',
            'Chat History',
            'Note',
        ]);
        expect(data.messages[0].preview).toBe('Hello Alice, write the reply.');
        expect(data.messages[1]).toEqual({
            n: 2,
            name: 'World Info (before)',
            role: 'system',
            tokens: 900,
            kind: 'marker',
            injections: ['canon (120 tokens)'],
        });
        // A macro with side effects is not run for a preview.
        expect(data.messages[2].preview).toBe('{{setvar::x::1}}Keep {{char}} in mind.');
        expect(substitute).not.toHaveBeenCalledWith(expect.stringContaining('setvar'));
        expect(data.messages[4]).toMatchObject({ depth: 2, role: 'user', preview: 'Remember Alice.' });
        expect(data.notSent).toEqual([{ name: 'Combat', why: 'condition is off now' }]);
        expect(data.tokens.total).toBe(25 * 4 + 900);
    });

    it('sends the combat block when its flag is set, and passes the generation type to the map', async () => {
        flags = { maestro_scene_combat: '1' };
        const data = await run('preset_dry_run', { type: 'continue' });
        expect(data.messages.map((row: Loose) => row.name)).toContain('Combat');
        expect(data.messages.find((row: Loose) => row.name === 'Combat').preview).toBe('Fight hard.');
        const analysis = fake.apis.get('presetAnalysis') as { map: ReturnType<typeof vi.fn> };
        expect(analysis.map).toHaveBeenLastCalledWith(undefined, { type: 'continue' });
    });

    it('fits the answer into the result size', async () => {
        const big = PROMPTS.map((prompt) =>
            prompt.content ? { ...prompt, content: `${prompt.content} ${'word '.repeat(2000)}` } : prompt,
        );
        const store = fakeStore();
        (store as unknown as { working: () => unknown }).working = () => ({ prompts: big });
        (store as unknown as { prompts: () => unknown }).prompts = () =>
            big.map((prompt) => ({ item: { identifier: prompt.identifier, enabled: true }, prompt }));
        fake.apis.set('presetStore', store);
        const data = await run('preset_dry_run', { preview_chars: 600 }, 2500);
        expect(JSON.stringify(data).length).toBeLessThan(2500);
    });

    it('says when the old macro engine sends conditions as text', async () => {
        fake.hostCtx.powerUserSettings = { experimental_macro_engine: false };
        const data = await run('preset_dry_run');
        expect(data.macroEngine).toBe('off: {{if}} and its branches go to the model as text');
        expect(data.messages.map((row: Loose) => row.name)).toContain('Combat');
    });
});

describe('preset_findings', () => {
    it('gives the findings with block names and the hints for the model', async () => {
        const data = await run('preset_findings');
        expect(data.findings).toEqual([
            {
                kind: 'contradiction',
                severity: 'warn',
                block: 'Main Prompt',
                other: 'Vars',
                text: 'Two rules disagree.',
            },
            { kind: 'unsaved', severity: 'info', text: 'Unsaved edits.' },
        ]);
        expect(data.hints).toEqual([
            { model: 'deepseek/deepseek-v4-flash', text: 'An assistant prefill ends the reply at once.' },
        ]);
    });
});

/* ------------------------------------------------------------------ neighbour prompts */

function entry(id: string, patch: Partial<NeighbourPrompt> = {}): NeighbourPrompt {
    return {
        id,
        owner: 'des',
        label: id,
        description: `What ${id} does.`,
        present: true,
        text: `${id} text`,
        globalText: `${id} text`,
        scoped: {},
        editable: true,
        scopable: true,
        usedIn: 'prompt',
        ...patch,
    };
}

function fakeNeighbours(): NeighbourPromptsApi & { calls: unknown[][] } {
    const entries = [
        entry('des.trackerInstructions', {
            label: 'Tracker instructions',
            scoped: { chat: 'chat copy' },
            text: 'chat copy',
        }),
        entry('desru.languageLock', { owner: 'desru', label: 'Language rule', editable: false }),
        entry('ck.consistency', { owner: 'ck', label: 'Character Consistency', editable: false, scopable: false }),
        entry('maestro.director', {
            owner: 'maestro',
            label: 'Director',
            editable: false,
            scopable: false,
            note: 'Edited in the module settings.',
        }),
        entry('qvink.prompt', { owner: 'qvink', label: 'Summary prompt', scopable: false, usedIn: 'background' }),
    ];
    const calls: unknown[][] = [];
    return {
        calls,
        list: () => entries,
        get: (id: string) => entries.find((item) => item.id === id) ?? null,
        setGlobal: async (...args: unknown[]) => {
            calls.push(['setGlobal', ...args]);
        },
        setScoped: async (...args: unknown[]) => {
            calls.push(['setScoped', ...args]);
        },
        effective: () => '',
        lastReport: () => ({ at: 1, replaced: ['des.trackerInstructions'], notFound: [] }),
        ready: async () => {},
        onChange: () => () => {},
    } as unknown as NeighbourPromptsApi & { calls: unknown[][] };
}

describe('neighbour_prompts', () => {
    it('lists the entries and gives one with its texts', async () => {
        fake.apis.set('neighbourPrompts', fakeNeighbours());
        const list = await run('neighbour_prompts');
        expect(list.entries).toHaveLength(5);
        expect(list.entries[0]).toMatchObject({
            id: 'des.trackerInstructions',
            editableEverywhere: true,
            copyable: true,
            copy: { chat: true },
        });
        expect(list.lastGeneration).toEqual({ copiesUsed: ['des.trackerInstructions'] });
        const one = await run('neighbour_prompts', { id: 'des.trackerInstructions' });
        expect(one).toMatchObject({
            textHere: 'chat copy',
            extensionText: 'des.trackerInstructions text',
            copies: { chat: 'chat copy' },
        });
        expect((await run('neighbour_prompts', { id: 'nope' })).ids).toHaveLength(5);
    });
});

describe('neighbour_prompt_set', () => {
    function setup() {
        const neighbours = fakeNeighbours();
        const write = writeFake({
            apis: {
                neighbourPrompts: neighbours,
                presetLayer: {
                    context: () => ({ character: { avatar: 'a.png', name: 'Alice' }, chat: { id: 'chat-1' } }),
                },
            },
        });
        return { write, neighbours };
    }

    it('changes a text everywhere or as a copy; the card switch picks the scope', async () => {
        const { write, neighbours } = setup();
        const plan = await write.plan(
            'neighbour_prompt_set',
            { id: 'des.trackerInstructions', text: 'New rules.' },
            'ru',
        );
        expect(plan.summary).toBe('«Tracker instructions»: новый текст');
        expect(plan.target).toBe('Промпты расширений · «Tracker instructions»');
        expect(plan.before).toEqual({ Текст: 'chat copy' });
        expect(plan.after).toEqual({
            Текст: 'New rules.',
            'Обрати внимание': [
                'У этого персонажа или чата своя копия: здесь продолжит работать она, новый текст — в остальных чатах.',
            ],
        });
        expect(plan.scopes).toEqual([
            { value: 'global', label: 'Везде (настройка расширения)' },
            { value: 'character', label: 'Копия для этого персонажа (Alice)' },
            { value: 'chat', label: 'Копия для этого чата' },
        ]);
        expect(plan.full).toBe(true);
        await plan.apply();
        await plan.apply({ scope: 'character' });
        expect(neighbours.calls).toEqual([
            ['setGlobal', 'des.trackerInstructions', 'New rules.'],
            ['setScoped', 'des.trackerInstructions', 'character', 'New rules.'],
        ]);
        const reset = await write.plan('neighbour_prompt_set', {
            id: 'des.trackerInstructions',
            reset: true,
            scope: 'chat',
        });
        expect(reset.summary).toBe('«Tracker instructions»: back to how it was');
        await reset.apply();
        expect(neighbours.calls.at(-1)).toEqual(['setScoped', 'des.trackerInstructions', 'chat', null]);
        const copy = await write.plan('neighbour_prompt_set', {
            id: 'desru.languageLock',
            text: 'Пиши по-русски.',
            scope: 'chat',
        });
        expect(copy.scopes?.map((option) => option.value)).toEqual(['character', 'chat']);
    });

    it('refuses CarrotKernel and BunnyMo, read-only entries, scopes an entry has not and unknown ids', async () => {
        const { write } = setup();
        expect(await planError(write.plan('neighbour_prompt_set', { id: 'ck.consistency', text: 'x' }))).toBe(
            '«Character Consistency» belongs to CarrotKernel or BunnyMo packs: Maestro never changes them.',
        );
        expect(await planError(write.plan('neighbour_prompt_set', { id: 'maestro.director', text: 'x' }))).toBe(
            '«Director» cannot be changed from here. Edited in the module settings.',
        );
        expect(await planError(write.plan('neighbour_prompt_set', { id: 'desru.languageLock', text: 'x' }))).toBe(
            '«Language rule» cannot be changed everywhere, only as a copy for a character or a chat.',
        );
        expect(
            await planError(write.plan('neighbour_prompt_set', { id: 'qvink.prompt', text: 'x', scope: 'chat' })),
        ).toBe('«Summary prompt» cannot get a copy here (chat).');
        expect(await planError(write.plan('neighbour_prompt_set', { id: 'nope', text: 'x' }))).toContain(
            'There is no entry «nope». Entries: des.trackerInstructions',
        );
    });

    it('translates the module refusals at apply time', async () => {
        const { write, neighbours } = setup();
        neighbours.setGlobal = async () => {
            throw new NeighbourPromptError('busy', 'busy');
        };
        const plan = await write.plan('neighbour_prompt_set', { id: 'des.trackerInstructions', text: 'x' });
        await expect(plan.apply()).rejects.toThrow('DES Workshop is open: close it and try again.');
    });
});
