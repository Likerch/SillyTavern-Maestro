// Read tools over the game layer: mechanics, the director, the preset's blocks and flags.
import { describe, expect, it } from 'vitest';
import { readTools } from '../../../src/features/assistant/tools';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { fakeApp, runTool, toolContext } from './tools-helpers';
import type { Loose } from './tools-helpers';

const MAGIC: MechanicDef = {
    id: 'magic',
    name: 'Магия',
    summary: 'Mana for spells.',
    rules: 'Each spell costs mana.',
    attributes: [
        {
            id: 'mana',
            name: 'Мана',
            promptName: 'Mana',
            kind: 'number',
            min: 0,
            max: 100,
            events: [{ id: 'e', when: { op: '<=', value: 0 }, text: 'x' }],
        },
    ],
    holders: { kind: 'characters', includePersona: true },
    checks: [
        {
            id: 'cast',
            name: 'Колдовство',
            promptName: 'Spellcasting',
            dice: '1d100<=@mana',
            difficulty: null,
            triggers: ['колду', 'cast'],
        },
    ],
    tracking: 'block',
    scope: { kind: 'global' },
};

describe('mechanics_state', () => {
    it('gives the definitions, values, history, checks, events and flags', async () => {
        const fake = fakeApp({
            apis: {
                mechanics: {
                    list: () => [MAGIC, { ...MAGIC, id: 'money', name: 'Деньги' }],
                    active: () => [MAGIC],
                    state: (holder?: string) =>
                        [
                            { mechanicId: 'magic', holder: 'Anna', values: { mana: 40 }, updatedAt: 3 },
                            { mechanicId: 'magic', holder: 'Kai', values: { mana: 90 }, updatedAt: 3 },
                        ].filter((row) => !holder || row.holder === holder),
                    history: () => [
                        {
                            id: 'h',
                            mechanicId: 'magic',
                            holder: 'Anna',
                            attribute: 'mana',
                            from: 60,
                            to: 40,
                            source: 'block',
                            messageIndex: 3,
                            at: 1,
                        },
                    ],
                    checks: () => [{ text: 'Spellcasting check (Anna): rolled 30 — success.' }],
                    events: () => [{ text: 'Anna is out of mana.' }],
                    flagCatalogue: () => [{ flag: 'maestro_mech_magic', label: 'Магия' }],
                    flagsOn: () => ['maestro_mech_magic'],
                },
            },
        });
        const tools = readTools(fake.app);
        const output = await runTool(tools, 'mechanics_state', {}, toolContext(fake, { locale: 'ru' }));
        const data = output.data as Loose;
        expect(data.mechanics[0]).toMatchObject({
            id: 'magic',
            active: true,
            scope: 'global',
            tracking: 'block',
            holders: 'characters',
            attributes: [{ id: 'mana', name: 'Мана', kind: 'number', min: 0, max: 100, events: 1 }],
            checks: [{ id: 'cast', dice: '1d100<=@mana', difficulty: null, triggers: ['колду', 'cast'] }],
        });
        expect(data.mechanics[1].active).toBe(false);
        expect(data.state.total).toBe(2);
        expect(data.recentChanges[0]).toMatchObject({ holder: 'Anna', from: 60, to: 40, source: 'block' });
        expect(data.checks).toEqual(['Spellcasting check (Anna): rolled 30 — success.']);
        expect(data.flags).toEqual({ catalogue: ['maestro_mech_magic'], on: ['maestro_mech_magic'] });
        expect(output.summary).toBe('Механики: активных 1 из 2');
        expect(output.untrusted).toBe(true);
        const one = await runTool(tools, 'mechanics_state', { holder: 'Kai' }, toolContext(fake));
        expect((one.data as Loose).state.items).toEqual([{ mechanic: 'magic', holder: 'Kai', values: { mana: 90 } }]);
    });
});

describe('director_scene', () => {
    it('gives the scene, the stall, the notes and the flags', async () => {
        const fake = fakeApp({
            apis: {
                director: {
                    scene: () => ({ type: 'combat', confidence: 0.8, messageIndex: 7, by: 'rules', held: 2 }),
                    stall: () => ({ turns: 0, reasons: [] }),
                    notes: () =>
                        Array.from({ length: 5 }, (_, index) => ({
                            at: 1,
                            messageIndex: index,
                            text: `Note ${index}`,
                            source: 'quest',
                        })),
                    flags: () => ({ maestro_scene_combat: '1', maestro_lang_ru: '1' }),
                    pending: () => ({ at: 1, messageIndex: 8, text: 'A twist', source: 'thread', detail: 'The ring' }),
                    override: () => null,
                    candidate: () => ({ type: 'drama', confidence: 0.6 }),
                    suppressed: () => ({ at: 1, messageIndex: 6, reason: 'plot' }),
                    catalogue: () => [{ name: 'maestro_scene_combat', titleKey: 'a', descriptionKey: 'b' }],
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'director_scene', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.scene.type).toBe('combat');
        expect(data.candidate).toEqual({ type: 'drama', confidence: 0.6 });
        expect(data.pendingNote).toMatchObject({ message: 8, source: 'thread', text: 'A twist', detail: 'The ring' });
        expect(data.suppressed).toEqual({ reason: 'plot', message: 6 });
        expect(data.notes.map((note: { text: string }) => note.text)).toEqual(['Note 2', 'Note 3', 'Note 4']);
        expect(data.flags).toEqual({ maestro_scene_combat: '1', maestro_lang_ru: '1' });
        expect(data.catalogue).toEqual(['maestro_scene_combat']);
        expect(output.summary).toBe('Scene: combat');
        const none = fakeApp({
            apis: {
                director: {
                    scene: () => null,
                    stall: () => ({ turns: 3, reasons: ['loop'] }),
                    notes: () => [],
                    flags: () => ({}),
                },
            },
        });
        const empty = await runTool(readTools(none.app), 'director_scene', {}, toolContext(none, { locale: 'ru' }));
        expect(empty.summary).toBe('Тип сцены ещё не определён');
        expect((empty.data as Loose).pendingNote).toBeNull();
    });
});

describe('preset_blocks', () => {
    const prompts = [
        {
            item: { identifier: 'main', enabled: true },
            prompt: { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write the story.' },
        },
        {
            item: { identifier: 'chatHistory', enabled: true },
            prompt: { identifier: 'chatHistory', name: 'Chat History', marker: true },
        },
        {
            item: { identifier: 'combat', enabled: true },
            prompt: {
                identifier: 'combat',
                name: 'Combat rules',
                role: 'system',
                content: '{{if .maestro_scene_combat}}Fight fast.{{/if}}',
            },
        },
        {
            item: { identifier: 'calm', enabled: false },
            prompt: {
                identifier: 'calm',
                name: 'Calm',
                role: 'user',
                injection_position: 1,
                injection_depth: 2,
                content: 'Breathe. {{if !.maestro_explicit}}Fade out.{{/if}}',
            },
        },
        { item: { identifier: 'ghost', enabled: true }, prompt: null },
    ];

    function presetFake() {
        return fakeApp({
            ctx: { powerUserSettings: { experimental_macro_engine: true } },
            apis: {
                presetStore: {
                    prompts: () => prompts,
                    current: () => 'Marinara',
                    draft: () => ({ dirty: true, changedPrompts: [], changedKeys: [] }),
                },
                director: {
                    flags: () => ({ maestro_scene_combat: '1' }),
                    catalogue: () => [{ name: 'maestro_scene_combat', titleKey: 'a', descriptionKey: 'b' }],
                },
                mechanics: {
                    flagCatalogue: () => [{ flag: 'maestro_mech_magic', label: 'Магия' }, { bad: true }],
                    flagsOn: () => [],
                },
            },
        });
    }

    it('lists blocks with conditions, flags in use, the flag catalogue and the macro engine', async () => {
        const fake = presetFake();
        const output = await runTool(readTools(fake.app), 'preset_blocks', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.preset).toBe('Marinara');
        expect(data.unsaved).toBe(true);
        expect(data.macroEngine).toBe('on');
        expect(data.blocks).toEqual([
            { id: 'main', name: 'Main Prompt', on: true, role: 'system', chars: 16 },
            { id: 'chatHistory', name: 'Chat History', on: true, marker: true },
            {
                id: 'combat',
                name: 'Combat rules',
                on: true,
                role: 'system',
                chars: 46,
                condition: 'only when maestro_scene_combat',
            },
            { id: 'calm', name: 'Calm', on: false, role: 'user', depth: 2, chars: 50, flags: ['!maestro_explicit'] },
        ]);
        expect(data.flags).toEqual({
            director: ['maestro_scene_combat'],
            mechanics: ['maestro_mech_magic'],
            preset: ['maestro_scene_combat', 'maestro_explicit'],
            nowSet: { director: { maestro_scene_combat: '1' } },
        });
        expect(output.summary).toBe('Preset blocks: 4');
        expect(output.untrusted).toBe(true);
    });

    it('filters conditional blocks or by text with a preview', async () => {
        const fake = presetFake();
        const tools = readTools(fake.app);
        const conditional = await runTool(tools, 'preset_blocks', { conditional_only: true }, toolContext(fake));
        expect((conditional.data as Loose).blocks.map((block: { id: string }) => block.id)).toEqual(['combat', 'calm']);
        const query = await runTool(tools, 'preset_blocks', { query: 'write' }, toolContext(fake, { locale: 'ru' }));
        const blocks = (query.data as Loose).blocks;
        expect(blocks).toHaveLength(1);
        expect(blocks[0].preview).toBe('Write the story.');
        expect(query.summary).toBe('Блоки пресета: 1');
    });

    it('reports the macro engine as off or unknown', async () => {
        const off = fakeApp({
            ctx: { powerUserSettings: { experimental_macro_engine: false } },
            apis: { presetStore: { prompts: () => [], current: () => 'X', draft: () => ({ dirty: false }) } },
        });
        expect(
            ((await runTool(readTools(off.app), 'preset_blocks', {}, toolContext(off))).data as Loose).macroEngine,
        ).toBe('off');
        const unknown = fakeApp({
            apis: { presetStore: { prompts: () => [], current: () => 'X', draft: () => null } },
        });
        expect(
            ((await runTool(readTools(unknown.app), 'preset_blocks', {}, toolContext(unknown))).data as Loose)
                .macroEngine,
        ).toBe('unknown');
    });
});
