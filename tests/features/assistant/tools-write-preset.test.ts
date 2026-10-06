// preset_block_add and preset_block_condition (M33 part C over M34): additions and conditions go to the user's layer
// (presetLayer.record) and the working copy (presetStore.addPrompt / updatePrompt); the base preset is never saved.
import { describe, expect, it } from 'vitest';
import { stableHash } from '../../../src/domain/hash';
import { fakeMechanics, fakePreset, planError, prompt, writeFake } from './tools-write-fakes';
import type { FakePreset } from './tools-write-fakes';

function setup(options: { locale?: 'en' | 'ru'; director?: boolean; engineOff?: boolean } = {}) {
    const preset = fakePreset([
        prompt('main', 'Main Prompt', 'Write the next reply.', { system_prompt: true }),
        prompt('chatHistory', 'Chat History', '', { marker: true, system_prompt: true }),
        prompt('jailbreak', 'Post-History', 'Stay in character.', { system_prompt: true }),
    ]);
    const apis: Record<string, unknown> = { presetStore: preset.store, presetLayer: preset.layer };
    if (options.director !== false) {
        apis.director = {
            flags: () => ({}),
            catalogue: () => [
                { name: 'maestro_scene_combat', titleKey: 'a', descriptionKey: 'b' },
                { name: 'maestro_explicit', titleKey: 'a', descriptionKey: 'b' },
            ],
        };
    }
    apis.mechanics = { ...fakeMechanics(), flagCatalogue: () => [{ flag: 'maestro_mech_magic', label: 'Magic' }] };
    const fake = writeFake({
        apis,
        locale: options.locale ?? 'en',
        ctx: {
            uuidv4: () => 'blk-1',
            powerUserSettings: { experimental_macro_engine: options.engineOff ? false : true },
        },
    });
    return { fake, preset };
}

function methods(preset: FakePreset): string[] {
    return preset.calls.map((call) => call.method);
}

describe('preset_block_add', () => {
    it('adds a block to the layer and the working copy, never saving the preset', async () => {
        const { fake, preset } = setup({ locale: 'ru' });
        const plan = await fake.plan(
            'preset_block_add',
            {
                name: 'Боевые правила',
                content: 'Describe wounds plainly.',
                position: { place: 'after', block: 'Main Prompt' },
                condition: { flag: 'maestro_scene_combat', mode: 'only' },
            },
            'ru',
        );
        expect(plan.summary).toBe(
            'Новый блок «Боевые правила» (система) после «Main Prompt», только при maestro_scene_combat',
        );
        expect(plan.target).toBe('Пресет «Marinara» · твой слой');
        expect(plan.before).toBeNull();
        expect(plan.after).toEqual({
            Название: 'Боевые правила',
            Роль: 'система',
            Где: 'после «Main Prompt»',
            Состояние: 'включён',
            Текст: '{{if .maestro_scene_combat}}Describe wounds plainly.{{/if}}',
        });
        // «Везде» by default; outside a character chat there is nothing to switch to.
        expect(plan.scope).toBe('global');
        expect(plan.scopes).toEqual([{ value: 'global', label: 'Везде' }]);
        expect(preset.calls).toEqual([]);
        const { result } = await plan.apply();
        expect(result).toEqual({ identifier: 'blk-1', preset: 'Marinara', scope: 'global' });
        expect(methods(preset)).toEqual(['layer.record', 'addPrompt']);
        const [base, op] = preset.calls[0]!.args as [string, Record<string, unknown>];
        expect(base).toBe('Marinara');
        expect(op).toMatchObject({
            op: 'add',
            anchor: { kind: 'after', identifier: 'main' },
            enabled: true,
            prompt: {
                identifier: 'blk-1',
                name: 'Боевые правила',
                role: 'system',
                injection_position: 0,
                system_prompt: false,
                marker: false,
            },
        });
        expect(preset.calls[1]!.args[1]).toBe('main');
        expect(preset.order.map((item) => item.identifier)).toEqual(['main', 'blk-1', 'chatHistory', 'jailbreak']);
        expect(methods(preset)).not.toContain('save');
        expect(methods(preset)).not.toContain('saveAs');
    });

    it('places blocks at the end, at the start, before a block and into the chat at a depth', async () => {
        const end = setup();
        await (
            await end.fake.plan('preset_block_add', { name: 'E', content: 'e', position: { place: 'end' } })
        ).apply();
        expect(end.preset.calls[0]!.args[1]).toMatchObject({ anchor: { kind: 'end' } });
        expect(end.preset.calls[1]!.args[1]).toBe('jailbreak');

        const start = setup();
        await (
            await start.fake.plan('preset_block_add', { name: 'S', content: 's', position: { place: 'start' } })
        ).apply();
        expect(start.preset.calls[1]!.args[1]).toBeUndefined();
        expect(start.preset.order[0]!.identifier).toBe('blk-1');

        const before = setup();
        const plan = await before.fake.plan('preset_block_add', {
            name: 'B',
            role: 'user',
            content: 'b',
            position: { place: 'before', block: 'jailbreak', depth: 2 },
            enabled: false,
        });
        expect(plan.summary).toBe('New block «B» (user) before «Post-History», in the chat at depth 2');
        expect((plan.after as Record<string, unknown>).Note).toEqual(['The block is added switched off.']);
        await plan.apply();
        expect(before.preset.calls[0]!.args[1]).toMatchObject({
            anchor: { kind: 'before', identifier: 'jailbreak' },
            enabled: false,
            prompt: { injection_position: 1, injection_depth: 2, role: 'user' },
        });
        expect(before.preset.calls[1]!.args[1]).toBe('chatHistory');
        expect(before.preset.order.find((item) => item.identifier === 'blk-1')!.enabled).toBe(false);
    });

    it('refuses unknown anchors, missing anchors and unknown flags', async () => {
        const { fake } = setup();
        expect(
            await planError(
                fake.plan('preset_block_add', { name: 'X', content: 'x', position: { place: 'after', block: 'Nope' } }),
            ),
        ).toBe('There is no block «Nope» in the preset «Marinara».');
        expect(
            await planError(fake.plan('preset_block_add', { name: 'X', content: 'x', position: { place: 'before' } })),
        ).toBe('Name the block to put the new one «before».');
        expect(
            await planError(
                fake.plan('preset_block_add', {
                    name: 'X',
                    content: 'x',
                    position: { place: 'end' },
                    condition: { flag: 'combat', mode: 'only' },
                }),
            ),
        ).toBe(
            'Unknown flag «combat»: take one from the catalogue or a maestro_… name. Catalogue: maestro_scene_combat, maestro_explicit, maestro_mech_magic.',
        );
        expect(
            await planError(
                fake.plan('preset_block_add', {
                    name: 'X',
                    content: 'x',
                    position: { place: 'end' },
                    condition: { flag: 'bad flag', mode: 'only' },
                }),
            ),
        ).toBe('«bad flag» cannot be a flag name.');
    });

    it('warns when nothing sets a maestro_ flag and when the macro engine is off', async () => {
        const { fake } = setup({ director: false, engineOff: true });
        const plan = await fake.plan('preset_block_add', {
            name: 'X',
            content: 'x',
            position: { place: 'end' },
            condition: { flag: 'maestro_scene_combat', mode: 'except' },
        });
        expect(plan.summary).toBe('New block «X» (system) at the end, except when maestro_scene_combat');
        expect((plan.after as Record<string, unknown>).Text).toBe('{{if !.maestro_scene_combat}}x{{/if}}');
        expect((plan.after as Record<string, unknown>).Note).toEqual([
            'Nothing sets «maestro_scene_combat» yet: until something does, an «only when» block stays silent and an «except» block is always sent.',
            'The new macro engine of SillyTavern is not on: {{if}} would reach the model as plain text.',
        ]);
        const mech = await fake.plan('preset_block_add', {
            name: 'Y',
            content: 'y',
            position: { place: 'end' },
            condition: { flag: 'maestro_mech_magic', mode: 'only' },
        });
        expect((mech.after as Record<string, unknown>).Note).toEqual([
            'The new macro engine of SillyTavern is not on: {{if}} would reach the model as plain text.',
        ]);
    });

    it('stops when the preset was switched before the user confirmed', async () => {
        const { fake, preset } = setup();
        const plan = await fake.plan('preset_block_add', { name: 'X', content: 'x', position: { place: 'end' } });
        preset.current.name = 'Other';
        await expect(plan.apply()).rejects.toThrow('The preset changed after the plan («Marinara» → «Other»).');
        expect(preset.calls).toEqual([]);
    });
});

describe('preset_block_condition', () => {
    it('wraps a base block in a condition as a layer edit with the base fingerprint', async () => {
        const { fake, preset } = setup({ locale: 'ru' });
        const plan = await fake.plan(
            'preset_block_condition',
            { block: 'jailbreak', flag: 'maestro_explicit', mode: 'except' },
            'ru',
        );
        expect(plan.summary).toBe('Блок «Post-History»: кроме maestro_explicit');
        expect(plan.target).toBe('Пресет «Marinara» · твой слой · «Post-History»');
        expect(plan.before).toEqual({ Текст: 'Stay in character.' });
        expect(plan.after).toEqual({ Текст: '{{if !.maestro_explicit}}Stay in character.{{/if}}' });
        expect(plan.full).toBe(true);
        await plan.apply();
        expect(methods(preset)).toEqual(['layer.record', 'updatePrompt']);
        expect(preset.calls[0]!.args[1]).toEqual({
            op: 'edit',
            identifier: 'jailbreak',
            patch: { content: '{{if !.maestro_explicit}}Stay in character.{{/if}}' },
            baseHash: stableHash('Stay in character.'),
            baseText: 'Stay in character.',
        });
        expect(preset.calls[1]!.args).toEqual([
            'jailbreak',
            { content: '{{if !.maestro_explicit}}Stay in character.{{/if}}' },
        ]);
        expect(methods(preset)).not.toContain('save');
    });

    it("edits a block of the user's layer with an empty base text and removes a condition with «always»", async () => {
        const { fake, preset } = setup();
        await (
            await fake.plan('preset_block_add', {
                name: 'Mine',
                content: 'Fight!',
                position: { place: 'end' },
                condition: { flag: 'maestro_scene_combat', mode: 'only' },
            })
        ).apply();
        preset.calls.length = 0;
        const plan = await fake.plan('preset_block_condition', { block: 'Mine', mode: 'always' });
        expect(plan.summary).toBe('Block «Mine»: always (no condition)');
        expect(plan.after).toEqual({ Text: 'Fight!' });
        await plan.apply();
        expect(preset.calls[0]!.args[1]).toMatchObject({
            op: 'edit',
            identifier: 'blk-1',
            baseText: '',
            baseHash: stableHash(''),
        });
    });

    it('refuses markers, blocks outside the saved preset and the layer, unchanged texts and stray tags', async () => {
        const { fake, preset } = setup();
        expect(
            await planError(
                fake.plan('preset_block_condition', { block: 'chatHistory', flag: 'maestro_explicit', mode: 'only' }),
            ),
        ).toBe('«Chat History» is filled by SillyTavern itself: its text cannot get a condition.');
        preset.prompts.push(prompt('loose', 'Loose', 'free text'));
        expect(
            await planError(
                fake.plan('preset_block_condition', { block: 'loose', flag: 'maestro_explicit', mode: 'only' }),
            ),
        ).toBe('«Loose» is neither in the saved preset nor in your layer (made outside the studio and not saved).');
        expect(await planError(fake.plan('preset_block_condition', { block: 'main', mode: 'always' }))).toBe(
            '«Main Prompt» already has this condition.',
        );
        expect(await planError(fake.plan('preset_block_condition', { block: 'main', mode: 'only' }))).toBe(
            'The mode «only» needs a flag.',
        );
        preset.prompts[0]!.content = 'text {{/if}}';
        preset.saved.set('Marinara', { prompts: structuredClone(preset.prompts) });
        expect(
            await planError(
                fake.plan('preset_block_condition', { block: 'main', flag: 'maestro_explicit', mode: 'only' }),
            ),
        ).toBe('The block text has stray {{if}}/{{else}}/{{/if}} tags: fix them first.');
    });

    it('stops when the block changed before the user confirmed', async () => {
        const { fake, preset } = setup();
        const plan = await fake.plan('preset_block_condition', {
            block: 'main',
            flag: 'maestro_explicit',
            mode: 'only',
        });
        preset.prompts[0]!.content = 'Edited meanwhile.';
        await expect(plan.apply()).rejects.toThrow('The block «Main Prompt» changed after the plan: ask again.');
        expect(preset.calls).toEqual([]);
    });

    it('is offered only with the preset store and its layer', () => {
        const { fake } = setup();
        const tool = fake.tools.find((item) => item.name === 'preset_block_condition')!;
        expect(tool.available?.(fake.app)).toBe(true);
        fake.apis.delete('presetLayer');
        expect(tool.available?.(fake.app)).toBe(false);
    });
});
