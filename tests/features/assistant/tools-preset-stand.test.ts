// @vitest-environment happy-dom
// The assistant's preset tools (M33 over M34, plan-2 §1) against the real preset store and layer on the ST stand:
// edits go to the layer of the chosen scope (and the card's scope switch), the working copy follows unless a higher
// scope wins, the preset file is never written by an edit, a base block is switched off instead of deleted, packs
// apply in part and undo at once, new presets and bindings, saving edits made outside, versions, and the read tools.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPrompt } from '../../../src/domain/preset-layer-apply';
import type { ToolContext, ToolSpec, WritePlan } from '../../../src/features/assistant/api';
import { builtinTools } from '../../../src/features/assistant/tools';
import { UNDO_TARGETS } from '../../../src/features/assistant/tools/write/common';
import { createPresetLayer } from '../../../src/features/presetStudio/layer';
import type { PresetLayerHandle } from '../../../src/features/presetStudio/layer';
import { createStoreEnv } from '../presetStudio/helpers-store';
import type { StoreEnv } from '../presetStudio/helpers-store';
import { fakeSettings, toolNamed } from './tools-helpers';
import type { Loose } from './tools-helpers';

type Dict = Record<string, unknown>;

let stand: StoreEnv;
let layer: PresetLayerHandle;
let tools: ToolSpec[];

async function settle(): Promise<void> {
    await layer.ready?.();
    await layer.whenContext?.();
    await layer.flush?.();
    await stand.store.whenIdle();
}

beforeEach(async () => {
    stand = await createStoreEnv();
    const ctx = stand.env.mock.context;
    ctx.characters = [
        { name: 'Alice', avatar: 'alice.png' },
        { name: 'Bob', avatar: 'bob.png' },
    ] as never;
    ctx.characterId = 0;
    stand.env.mock.chatId = 'chat-1';
    layer = createPresetLayer(stand.env.app, stand.env.app.log, stand.store);
    layer.install();
    stand.env.apis.set('presetLayer', layer);
    stand.env.apis.set('presetStore', stand.store);
    await settle();
    tools = builtinTools(stand.env.app, stand.env.app.log);
});

afterEach(async () => {
    layer.dispose();
    await stand.stop();
});

function context(locale: 'en' | 'ru' = 'en', resultChars = 12000): ToolContext {
    return { app: stand.env.app, log: stand.env.app.log, locale, settings: fakeSettings({}), resultChars };
}

function plan(name: string, args: Dict, locale: 'en' | 'ru' = 'en'): Promise<WritePlan> {
    return toolNamed(tools, name).plan!(args, context(locale));
}

async function planError(name: string, args: Dict, locale: 'en' | 'ru' = 'en'): Promise<string> {
    try {
        await plan(name, args, locale);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('the plan was expected to fail');
}

async function read(name: string, args: Dict = {}, resultChars = 12000): Promise<Loose> {
    const output = await toolNamed(tools, name).run!(args, context('en', resultChars));
    return output.data as Loose;
}

const textOf = (identifier: string): unknown => findPrompt({ prompts: stand.oai.prompts }, identifier)?.content;
const enabledOf = (identifier: string): boolean | undefined =>
    stand.store.prompts().find((row) => row.item.identifier === identifier)?.item.enabled;
const order = (): string[] => stand.store.prompts().map((row) => row.item.identifier);

async function openChat(chatId: string, characterId: number | string = 0): Promise<void> {
    stand.env.mock.chatId = chatId;
    stand.env.mock.context.characterId = characterId;
    await stand.env.app.bus.emit('chat:changed', { chatId });
    await settle();
}

describe('block edits go to the layer of a scope', () => {
    it('edits a text everywhere: the working copy follows, the preset stays saved, the file is not written', async () => {
        const long = `${'A new and very long instruction. '.repeat(200)}End.`;
        const card = await plan('preset_block_edit', { block: 'Main Prompt', content: long });
        expect(card.summary).toBe('Block «Main Prompt»: text');
        expect(card.target).toBe('Preset «Marinara» · your layer · «Main Prompt»');
        expect(card.full).toBe(true);
        expect(card.before).toEqual({ Text: 'You are the GM.' });
        expect((card.after as Dict).Text).toBe(long);
        expect(card.scope).toBe('global');
        expect(card.scopes).toEqual([
            { value: 'global', label: 'Everywhere' },
            { value: 'character', label: 'This character (Alice)' },
            { value: 'chat', label: 'This chat' },
        ]);
        const saves = stand.server.saves.length;
        const outcome = await card.apply();
        expect(outcome.result).toMatchObject({ identifier: 'main', scope: 'global' });
        await settle();
        expect(textOf('main')).toBe(long);
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ op: 'edit', identifier: 'main', scope: 'global', patch: { content: long } }),
        ]);
        expect(stand.store.draft().dirty).toBe(false);
        expect(stand.server.saves.length).toBe(saves);
    });

    it('changes part of a text by exact replacements; the card switch sends it to this chat only', async () => {
        const card = await plan('preset_block_edit', {
            block: 'style',
            replace: [{ find: 'vividly', with: 'plainly' }],
        });
        expect(card.after).toEqual({ Text: 'Write plainly.' });
        await card.apply({ scope: 'chat' });
        await settle();
        expect(textOf('style')).toBe('Write plainly.');
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ op: 'edit', identifier: 'style', scope: 'chat', owner: 'chat-1' }),
        ]);
        await openChat('chat-2');
        expect(textOf('style')).toBe('Write vividly.');
        await openChat('chat-1');
        expect(textOf('style')).toBe('Write plainly.');
        expect(await planError('preset_block_edit', { block: 'style', replace: [{ find: 'nope', with: 'x' }] })).toBe(
            'The block has no text «nope»: read it again and copy the exact piece.',
        );
    });

    it('changes the role and the place in the chat; markers keep their text', async () => {
        const card = await plan(
            'preset_block_edit',
            { block: 'depth', role: 'system', depth: 0, name: 'Plot note' },
            'ru',
        );
        expect(card.summary).toBe('Блок «Depth note»: название, роль, место');
        expect(card.before).toEqual({ Название: 'Depth note', Роль: 'пользователь', Где: 'в чате на глубине 2' });
        expect(card.after).toEqual({ Название: 'Plot note', Роль: 'система', Где: 'в чате на глубине 0' });
        await card.apply();
        const prompt = findPrompt({ prompts: stand.oai.prompts }, 'depth');
        expect(prompt).toMatchObject({ role: 'system', injection_depth: 0, name: 'Plot note' });
        expect(await planError('preset_block_edit', { block: 'chatHistory', content: 'x' })).toBe(
            '«Chat History» is filled by SillyTavern itself: its text cannot be edited.',
        );
        expect(await planError('preset_block_edit', { block: 'style', content: 'Write vividly.' })).toBe(
            'Nothing changes in «Style».',
        );
        expect(await planError('preset_block_edit', { block: 'style', content: 'x', scope: 'galaxy' })).toContain(
            '«scope» must be one of',
        );
    });

    it('a higher scope wins for a state; a text edit below a chat edit turns it into a conflict', async () => {
        await (await plan('preset_block_toggle', { block: 'style', enabled: false, scope: 'chat' })).apply();
        const on = await plan('preset_block_toggle', { block: 'style', enabled: true });
        // The chat switched it off: switching it on everywhere does not show in this chat.
        expect(on.after).toEqual({
            State: 'on',
            Note: [
                'In «This chat» this is already changed differently: here that edit wins, this one works where it does not.',
            ],
        });
        await on.apply();
        await settle();
        expect(enabledOf('style')).toBe(false);
        expect(stand.store.draft().dirty).toBe(false);
        await (await plan('preset_block_edit', { block: 'main', content: 'Chat GM', scope: 'chat' })).apply();
        const card = await plan('preset_block_edit', { block: 'main', content: 'Global GM' });
        expect((card.after as Dict).Note).toEqual([
            'In «This chat» this block has its own text edit: it becomes a conflict to resolve in the Preset Studio (the «Your layer» tab), and until then this text works there too.',
        ]);
        await card.apply();
        await settle();
        // The working copy is what the layer gives: the chat edit is a conflict, the new text works.
        expect(textOf('main')).toBe('Global GM');
        expect(layer.lastReport()?.conflicts).toEqual([expect.objectContaining({ identifier: 'main', scope: 'chat' })]);
        expect(stand.store.draft().dirty).toBe(false);
        const param = await plan('preset_params_set', { params: { temperature: 0.2 }, scope: 'chat' });
        await param.apply();
        const shadowed = await plan('preset_params_set', { params: { temperature: 0.9 } });
        expect((shadowed.after as Dict).Note).toEqual([
            'In «This chat» this is already changed differently: here that edit wins, this one works where it does not.',
        ]);
        await shadowed.apply();
        await settle();
        expect(stand.oai.temp_openai).toBe(0.2);
        expect(stand.store.draft().dirty).toBe(false);
        expect(
            layer
                .get('Marinara')
                ?.ops.filter((op) => op.op === 'key')
                .map((op) => op.scope),
        ).toEqual(['global', 'chat']);
    });

    it('a block the layer added stays in its own scope', async () => {
        const add = await plan('preset_block_add', {
            name: 'Chat rule',
            content: 'Only here.',
            position: { place: 'after', block: 'main' },
            scope: 'chat',
        });
        const added = (await add.apply()).result as Dict;
        await settle();
        const identifier = String(added.identifier);
        const card = await plan('preset_block_edit', { block: 'Chat rule', content: 'Still only here.' });
        expect(card.scope).toBe('chat');
        expect(card.scopes).toEqual([{ value: 'chat', label: 'This chat' }]);
        await card.apply({ scope: 'global' });
        await settle();
        const ops = layer.get('Marinara')?.ops ?? [];
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: 'add', scope: 'chat', prompt: { content: 'Still only here.' } });
        expect(textOf(identifier)).toBe('Still only here.');
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('refuses a character or chat scope when no character chat is open', async () => {
        await openChat('chat-5', '');
        expect(await planError('preset_block_edit', { block: 'main', content: 'x', scope: 'character' })).toBe(
            '«This character» is not available now: open a chat with a character first.',
        );
        const card = await plan('preset_block_edit', { block: 'main', content: 'x' });
        expect(card.scopes?.map((option) => option.value)).toEqual(['global', 'chat']);
    });
});

describe('switching, moving and removing blocks', () => {
    it('switches several blocks as one pack and applies the ticked ones', async () => {
        const card = await plan('preset_block_toggle', { blocks: ['style', 'jailbreak'], enabled: false }, 'ru');
        expect(card.items?.map((item) => item.summary)).toEqual([
            'Блок «Style»: выключить',
            'Блок «Post-History Instructions»: выключить',
        ]);
        expect(card.summary).toContain('Пакет правок (2)');
        expect(card.items?.[0]?.before).toEqual({ Состояние: 'включён' });
        const outcome = await card.apply({ selected: ['c2'] });
        expect(outcome.items).toEqual([
            { id: 'c1', status: 'skipped' },
            { id: 'c2', status: 'applied' },
        ]);
        await settle();
        expect(enabledOf('style')).toBe(true);
        expect(enabledOf('jailbreak')).toBe(false);
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ op: 'toggle', identifier: 'jailbreak', enabled: false, scope: 'global' }),
        ]);
        expect(await planError('preset_block_toggle', { block: 'jailbreak', enabled: false })).toBe(
            '«Post-History Instructions» is already off.',
        );
        expect(await planError('preset_block_toggle', { block: 'chatHistory', enabled: false })).toBe(
            'Chat History must stay on: without it the model gets no chat at all.',
        );
    });

    it('moves a block in the order through a move op', async () => {
        const card = await plan('preset_block_move', { block: 'jailbreak', place: 'after', anchor: 'Main Prompt' });
        expect(card.before).toEqual({ 'Place in the list': 'after «Depth note»' });
        expect(card.after).toEqual({ 'Place in the list': 'after «Main Prompt»' });
        await card.apply();
        await settle();
        expect(order()).toEqual(['main', 'jailbreak', 'style', 'chatHistory', 'depth']);
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({
                op: 'move',
                identifier: 'jailbreak',
                anchor: { kind: 'after', identifier: 'main' },
            }),
        ]);
        expect(stand.store.draft().dirty).toBe(false);
        expect(await planError('preset_block_move', { block: 'jailbreak', place: 'after', anchor: 'main' })).toBe(
            'The block already stands there.',
        );
    });

    it('switches a base block off instead of deleting it; a block of the layer is removed', async () => {
        const base = await plan('preset_block_remove', { block: 'style' });
        expect(base.summary).toBe('Block «Style»: switch off (the layer cannot delete a block of the preset)');
        expect((base.after as Dict).Note).toEqual(['The preset file keeps the block: you can switch it back on.']);
        await base.apply();
        await settle();
        expect(enabledOf('style')).toBe(false);
        expect(findPrompt({ prompts: stand.oai.prompts }, 'style')).toBeDefined();

        const added = (
            await (
                await plan('preset_block_add', { name: 'Mine', content: 'Mine.', position: { place: 'end' } })
            ).apply()
        ).result as Dict;
        await settle();
        const own = await plan('preset_block_remove', { block: 'Mine' });
        expect(own.summary).toBe('Remove the block «Mine» (it was added by your layer)');
        expect(own.after).toBeNull();
        await own.apply();
        await settle();
        expect(findPrompt({ prompts: stand.oai.prompts }, String(added.identifier))).toBeUndefined();
        expect(layer.get('Marinara')?.ops).toEqual([expect.objectContaining({ op: 'toggle', identifier: 'style' })]);
        expect(stand.store.draft().dirty).toBe(false);
    });
});

describe('generation parameters', () => {
    it('sets a parameter in the layer and refuses connection settings', async () => {
        const card = await plan('preset_params_set', { params: { temperature: 0.5 } });
        expect(card.summary).toBe('temperature: 1 → 0.5');
        expect(card.before).toEqual({ temperature: 1 });
        await card.apply({ scope: 'character' });
        await settle();
        expect(stand.oai.temp_openai).toBe(0.5);
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ op: 'key', key: 'temperature', value: 0.5, scope: 'character' }),
        ]);
        const two = await plan('preset_params_set', { params: { top_p: 0.8, openai_max_tokens: 900 } });
        expect(two.items).toHaveLength(2);
        expect(await planError('preset_params_set', { params: { openrouter_model: 'x' } })).toBe(
            '«openrouter_model» is a connection setting (source, model, address or key): it is changed by hand only.',
        );
        expect(await planError('preset_params_set', { params: { proxy_password: 'x' } })).toContain(
            'changed by hand only',
        );
        expect(await planError('preset_params_set', { params: { temperature: 7 } })).toBe(
            '«temperature» must be from 0 to 2.',
        );
        expect(await planError('preset_params_set', { params: { temperature: 0.5 } })).toBe(
            '«temperature» already has this value.',
        );
    });
});

describe('packs', () => {
    it('applies a pack under one journal record; one undo brings everything back', async () => {
        const card = await plan('preset_pack', {
            summary: 'Tidy the preset',
            changes: [
                { tool: 'preset_block_edit', args: { block: 'main', content: 'New GM' } },
                { tool: 'preset_block_toggle', args: { block: 'style', enabled: false } },
                { tool: 'preset_params_set', args: { params: { temperature: 0.4 } } },
            ],
        });
        expect(card.summary).toBe('Pack of edits (3): Tidy the preset');
        expect(card.items?.map((item) => item.id)).toEqual(['c1', 'c2', 'c3']);
        expect(card.full).toBe(true);
        const outcome = await card.apply();
        expect(outcome.items?.map((item) => item.status)).toEqual(['applied', 'applied', 'applied']);
        await settle();
        expect(textOf('main')).toBe('New GM');
        expect(enabledOf('style')).toBe(false);
        expect(stand.oai.temp_openai).toBe(0.4);
        const records = stand.env.app.journal.list();
        const group = records.find((record) => record.kind === 'assistant.group');
        expect(group?.summary).toBe('Assistant: 3 edits of the preset «Marinara» at once');
        expect(group?.changes[0]?.target).toBe(UNDO_TARGETS.group);
        const members = group?.changes[0]?.ref['records'] as string[];
        expect(members.length).toBeGreaterThanOrEqual(6);
        expect(await stand.env.app.journal.undo(group!.id)).toBe(true);
        await settle();
        expect(textOf('main')).toBe('You are the GM.');
        expect(enabledOf('style')).toBe(true);
        expect(stand.oai.temp_openai).toBe(1);
        expect(layer.get('Marinara')).toBeNull();
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('reports a change that fails at apply time and keeps the others', async () => {
        const card = await plan('preset_pack', {
            changes: [
                { tool: 'preset_block_edit', args: { block: 'main', content: 'New GM' } },
                { tool: 'preset_block_edit', args: { block: 'style', content: 'Write tersely.' } },
            ],
        });
        await stand.store.updatePrompt('style', { content: 'Changed meanwhile.' });
        const outcome = await card.apply();
        expect(outcome.items).toEqual([
            { id: 'c1', status: 'applied' },
            { id: 'c2', status: 'error', error: 'The block «Style» changed after the plan: ask again.' },
        ]);
        expect(textOf('main')).toBe('New GM');
    });

    it('refuses a change twice, an unknown tool and names the change that is wrong', async () => {
        expect(
            await planError('preset_pack', {
                changes: [
                    { tool: 'preset_block_edit', args: { block: 'main', content: 'A' } },
                    { tool: 'preset_block_edit', args: { block: 'main', content: 'B' } },
                ],
            }),
        ).toBe('The pack changes the same thing twice («Block «Main Prompt»: text»): merge them into one edit.');
        expect(await planError('preset_pack', { changes: [{ tool: 'preset_create', args: { name: 'X' } }] })).toContain(
            'Edit 1 of the pack: «tool» must be one of',
        );
        expect(
            await planError('preset_pack', {
                changes: [
                    { tool: 'preset_block_toggle', args: { block: 'style', enabled: false } },
                    { tool: 'preset_block_edit', args: { block: 'nope', content: 'B' } },
                ],
            }),
        ).toBe('Edit 2 of the pack: There is no block «nope» in the preset «Marinara».');
        expect(
            await planError('preset_pack', {
                changes: Array.from({ length: 21 }, () => ({ tool: 'preset_block_toggle', args: { block: 'style' } })),
            }),
        ).toBe('A pack holds at most 20 edits (21 given).');
    });
});

describe('whole presets', () => {
    it('creates a preset from the current one with a block of another and binds it to this chat', async () => {
        const card = await plan('preset_create', {
            name: 'Mix',
            blocks: [
                { from_preset: 'Other', block: 'Main Prompt', name: 'Other main', place: 'end' },
                { name: 'Brevity', content: 'Be brief.', role: 'user' },
            ],
            bind: 'chat',
        });
        expect(card.summary).toBe('New preset «Mix»: 6 blocks, based on the current preset «Marinara» with your edits');
        expect(card.after).toMatchObject({
            Name: 'Mix',
            Added: ['«Other main» from Other', '«Brevity» (new)'],
            Bound: 'to this chat',
        });
        await card.apply();
        await settle();
        const file = stand.server.files.get('Mix') as Dict;
        const prompts = file.prompts as Dict[];
        expect(prompts.find((prompt) => prompt.name === 'Other main')).toMatchObject({ content: 'Other.' });
        expect(prompts.find((prompt) => prompt.name === 'Brevity')).toMatchObject({ role: 'user', marker: false });
        expect(stand.store.names()).toContain('Mix');
        expect(stand.store.current()).toBe('Marinara');
        expect(layer.bindings?.().chat).toBe('Mix');
        expect(await planError('preset_create', { name: 'other' })).toBe(
            'A preset «other» already exists: choose another name.',
        );
        expect(await planError('preset_create', { name: 'X', start: 'preset', preset: 'Nope' })).toBe(
            'There is no preset «Nope». Presets: Marinara, Other, Mix.',
        );
    });

    it('starts from scratch and takes blocks from a pasted preset', async () => {
        const pasted = JSON.stringify({
            prompts: [{ identifier: 'auto', name: 'Autonomy', role: 'system', content: 'Act on your own.' }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'auto', enabled: true }] }],
        });
        const card = await plan('preset_create', {
            name: 'Fresh',
            start: 'empty',
            pasted_preset: pasted,
            blocks: [{ pasted: true, block: 'Autonomy' }],
            select: true,
        });
        await card.apply();
        await settle();
        const file = stand.server.files.get('Fresh') as Dict;
        expect((file.prompts as Dict[]).map((prompt) => prompt.identifier)).toEqual(
            expect.arrayContaining(['main', 'chatHistory', 'auto']),
        );
        expect(stand.store.current()).toBe('Fresh');
        expect(await planError('preset_create', { name: 'Y', pasted_preset: '{nope' })).toBe(
            'The pasted text is not a preset (JSON of a preset file is needed).',
        );
    });

    it('binds and unbinds a preset of the character', async () => {
        const bind = await plan('preset_bind', { scope: 'character', preset: 'Other' }, 'ru');
        expect(bind.summary).toBe('Привязать пресет «Other» к персонажу Alice');
        expect(bind.before).toEqual({ 'Пресет персонажа': 'нет' });
        await bind.apply();
        await settle();
        expect(layer.bindings?.().character).toBe('Other');
        expect(await planError('preset_bind', { scope: 'character', preset: 'Other' })).toBe(
            '«Other» is already bound to Alice.',
        );
        await (await plan('preset_unbind', { scope: 'character' })).apply();
        await settle();
        expect(layer.bindings?.().character).toBeNull();
        expect(await planError('preset_unbind', { scope: 'chat' })).toBe('No preset is bound to this chat.');
    });

    it('saves edits made outside the layer, refuses when there are none, saves a copy under a new name', async () => {
        expect(await planError('preset_save', {})).toBe(
            'The preset «Marinara» has no unsaved edits: what the assistant changed is saved by «Apply» already.',
        );
        await stand.store.updatePrompt('style', { content: 'Unsaved style' });
        const card = await plan('preset_save', {});
        expect(card.before).toEqual({ 'Unsaved edits': 'blocks: 1, parameters: 0' });
        await card.apply();
        await settle();
        expect(findPrompt(stand.server.files.get('Marinara'), 'style')?.content).toBe('Unsaved style');
        expect(stand.store.draft().dirty).toBe(false);
        await (await plan('preset_save', { as_name: 'Copy' })).apply();
        expect(stand.store.current()).toBe('Copy');
    });

    it('lists versions and brings one back', async () => {
        await stand.store.updatePrompt('style', { content: 'Saved once' });
        await stand.store.save();
        const versions = await read('preset_versions');
        expect(versions.preset).toBe('Marinara');
        expect(versions.versions.length).toBeGreaterThan(0);
        const oldest = versions.versions.at(-1);
        const card = await plan('preset_version_restore', { version: oldest.id });
        expect(card.summary).toMatch(/^Bring the preset «Marinara» back to the version of /);
        await card.apply();
        await settle();
        expect(await planError('preset_version_restore', { version: 'nope' })).toBe(
            'The preset «Marinara» has no such version.',
        );
    });
});

describe('reading the preset', () => {
    it('lists presets, bindings, scopes and the layer edits by scope', async () => {
        await (await plan('preset_block_edit', { block: 'main', content: 'Chat GM', scope: 'chat' })).apply();
        await (await plan('preset_params_set', { params: { temperature: 0.6 } })).apply();
        const data = await read('preset_list');
        expect(data).toMatchObject({
            current: 'Marinara',
            presets: ['Marinara', 'Other'],
            unsaved: false,
            bound: { character: null, chat: null },
            scopes: { character: 'Alice', chatOpen: true },
            layerEdits: { global: 1, character: 0, chat: 1 },
        });
    });

    it('reads a block whole, in parts, with the scopes that changed it and the base text', async () => {
        const long = `${'x'.repeat(3000)}|${'y'.repeat(3000)}`;
        await (await plan('preset_block_edit', { block: 'main', content: long })).apply();
        const first = await read('preset_block_read', { block: 'Main Prompt', with_base: true }, 4000);
        expect(first).toMatchObject({
            identifier: 'main',
            name: 'Main Prompt',
            role: 'system',
            placement: 'in the prompt list',
            enabled: true,
            chars: long.length,
            layer: [{ scope: 'global', change: 'edited (content)' }],
            baseText: 'You are the GM.',
        });
        expect(first.text.length).toBeLessThan(long.length);
        const rest = await read('preset_block_read', { block: 'main', offset: first.nextOffset }, 4000);
        expect(rest.from).toBe(first.nextOffset);
        const depth = await read('preset_block_read', { block: 'depth' });
        expect(depth).toMatchObject({ placement: 'in the chat', depth: 2, enabled: false, role: 'user' });
        const other = await read('preset_block_read', { block: 'main', preset: 'Other' });
        expect(other.text).toBe('Other.');
        expect((await read('preset_block_read', { block: 'nope' })).note).toBe('No such block.');
    });

    it('shows parameters without connection settings and secrets; compares two presets', async () => {
        const params = await read('preset_params');
        expect(params.params).toMatchObject({ temperature: 1, top_p: 0.9, openai_max_tokens: 1024 });
        expect(params.other).toMatchObject({ bias_preset_selected: 'Default (none)' });
        expect(params.hiddenConnectionSettings).toBeGreaterThanOrEqual(4);
        const json = JSON.stringify(params);
        expect(json).not.toContain('secret');
        expect(json).not.toContain('proxy.local');
        expect(json).not.toContain('deepseek');
        const compare = await read('preset_compare', { a: 'Marinara', b: 'Other', block: 'main' });
        expect(compare.onlyInA).toEqual(expect.arrayContaining(['Style', 'Depth note']));
        expect(compare.block).toEqual({ a: 'You are the GM.', b: 'Other.' });
        expect(compare.params).toEqual(expect.arrayContaining([{ key: 'temperature', a: 1, b: 0.7 }]));
        expect(JSON.stringify(compare)).not.toContain('secret');
        expect(JSON.stringify(compare)).not.toContain('deepseek');
    });
});
