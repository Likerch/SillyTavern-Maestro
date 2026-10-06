// @vitest-environment happy-dom
// «Области действия» of «Твой слой» (plan-2: везде / этот персонаж / этот чат) with the real preset store over the ST
// stand: the parts laid over the working copy in order, a chat switch swapping the character and chat parts without
// making the preset unsaved, no file save ever getting them, the binding of a whole preset, and undo.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPrompt, textHash } from '../../../src/domain/preset-layer-apply';
import { createPresetLayer, PRESET_SCOPE_KIND } from '../../../src/features/presetStudio/layer';
import type { PresetLayerHandle } from '../../../src/features/presetStudio/layer';
import type { LayerScope } from '../../../src/features/presetStudio/layer-api';
import { createStoreEnv } from './helpers-store';
import type { StoreEnv } from './helpers-store';

type Dict = Record<string, unknown>;

let stand: StoreEnv;
let layer: PresetLayerHandle;
const layers: PresetLayerHandle[] = [];

function start(): PresetLayerHandle {
    const handle = createPresetLayer(stand.env.app, stand.env.app.log, stand.store);
    handle.install();
    stand.env.apis.set('presetLayer', handle);
    layers.push(handle);
    return handle;
}

async function settle(target = layer): Promise<void> {
    await target.ready?.();
    await target.whenContext?.();
    await target.flush?.();
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
    layer = start();
    await settle();
});

afterEach(async () => {
    for (const handle of layers.splice(0)) handle.dispose();
    await stand.stop();
});

const mainOf = (body: unknown): unknown => findPrompt(body, 'main')?.content;
const liveMain = (): unknown => mainOf({ prompts: stand.oai.prompts });

/** An edit of the main block the way the studio makes it: recorded in the scope, then put into the working copy. */
async function edit(scope: LayerScope, text: string, target = layer): Promise<void> {
    const baseText = String(mainOf(target.below?.('Marinara', scope)) ?? '');
    await target.record(
        'Marinara',
        { op: 'edit', identifier: 'main', patch: { content: text }, baseHash: textHash(baseText), baseText },
        scope,
    );
    await stand.store.updatePrompt('main', { content: text });
}

async function openChat(chatId: string, characterId: number | string = 0): Promise<void> {
    stand.env.mock.chatId = chatId;
    stand.env.mock.context.characterId = characterId;
    await stand.env.app.bus.emit('chat:changed', { chatId });
    await settle();
}

describe('scoped edits', () => {
    it('records a chat edit in the chat document, tagged with its scope; the preset stays saved', async () => {
        await edit('chat', 'Chat GM');
        expect(liveMain()).toBe('Chat GM');
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ op: 'edit', identifier: 'main', scope: 'chat', owner: 'chat-1' }),
        ]);
        expect(layer.get('Marinara', { scope: 'global' })).toBeNull();
        expect(stand.store.draft().dirty).toBe(false);
        const doc = (await stand.env.app.chat.getFor('chat-1', PRESET_SCOPE_KIND, () => ({}))) as Dict;
        expect((doc.layers as Dict).Marinara).toMatchObject({ ops: [{ op: 'edit', patch: { content: 'Chat GM' } }] });
        expect(JSON.stringify(doc)).not.toContain('"scope"');
        expect(layer.context?.()).toEqual({
            character: { avatar: 'alice.png', name: 'Alice' },
            chat: { id: 'chat-1' },
        });
    });

    it('lays global → character → chat; a chat switch swaps the character and chat parts, the preset stays saved', async () => {
        await edit('global', 'Global GM');
        await edit('character', 'Alice GM');
        await edit('chat', 'Chat GM');
        await layer.record('Marinara', { op: 'key', key: 'temperature', value: 0.3 }, 'character');
        await stand.store.setKeys({ temperature: 0.3 });
        expect(liveMain()).toBe('Chat GM');
        expect(stand.oai.temp_openai).toBe(0.3);
        expect(layer.get('Marinara')?.ops.map((op) => op.scope)).toEqual(['global', 'character', 'character', 'chat']);
        expect(stand.store.draft().dirty).toBe(false);

        await openChat('chat-2');
        expect(liveMain()).toBe('Alice GM');
        expect(stand.store.draft().dirty).toBe(false);

        await openChat('chat-3', 1);
        expect(liveMain()).toBe('Global GM');
        expect(stand.oai.temp_openai).toBe(1);
        expect(stand.store.draft().dirty).toBe(false);

        await openChat('chat-1');
        expect(liveMain()).toBe('Chat GM');
        expect(stand.oai.temp_openai).toBe(0.3);
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('a value set everywhere after a chat value survives leaving that chat', async () => {
        // The chat sets 0.2 first, then 0.9 is set everywhere (the chat value stays on top in this chat).
        await layer.record('Marinara', { op: 'key', key: 'temperature', value: 0.2 }, 'chat');
        await stand.store.setKeys({ temperature: 0.2 });
        await layer.record('Marinara', { op: 'key', key: 'temperature', value: 0.9 }, 'global');
        expect(stand.oai.temp_openai).toBe(0.2);
        await openChat('chat-2');
        expect(stand.oai.temp_openai).toBe(0.9);
        await openChat('chat-1');
        expect(stand.oai.temp_openai).toBe(0.2);
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('keeps unsaved edits of the working copy through a chat switch', async () => {
        await edit('chat', 'Chat GM');
        await stand.store.updatePrompt('style', { content: 'Unsaved style' });
        expect(stand.store.draft()).toMatchObject({ dirty: true, changedPrompts: ['style'] });
        await openChat('chat-2');
        expect(liveMain()).toBe('You are the GM.');
        expect(findPrompt({ prompts: stand.oai.prompts }, 'style')?.content).toBe('Unsaved style');
        expect(stand.store.draft()).toMatchObject({ dirty: true, changedPrompts: ['style'] });
    });

    it('gives an own block of the chat to that chat only', async () => {
        await layer.record(
            'Marinara',
            {
                op: 'add',
                prompt: { identifier: 'chatOwn', name: 'Chat block', content: 'Only here' },
                anchor: { kind: 'after', identifier: 'main' },
                enabled: true,
            },
            'chat',
        );
        // The studio adds the block typed like the layer does (preset-ui-blocks normalizePrompt).
        await stand.store.addPrompt(
            { identifier: 'chatOwn', name: 'Chat block', role: 'system', content: 'Only here' },
            'main',
        );
        expect(stand.store.draft().dirty).toBe(false);
        await openChat('chat-2');
        expect(findPrompt({ prompts: stand.oai.prompts }, 'chatOwn')).toBeUndefined();
        expect(stand.store.prompts().map((row) => row.item.identifier)).not.toContain('chatOwn');
        await openChat('chat-1');
        expect(stand.store.prompts().map((row) => row.item.identifier)).toEqual([
            'main',
            'chatOwn',
            'style',
            'chatHistory',
            'depth',
            'jailbreak',
        ]);
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('refuses a character or chat edit when no such card or chat is open', async () => {
        await openChat('chat-5', '');
        await expect(edit('character', 'x')).rejects.toThrow(/no character/);
        expect(layer.context?.()).toEqual({ character: null, chat: { id: 'chat-5' } });
    });
});

describe('the preset file never gets character or chat edits', () => {
    it('«Сохранить базу» writes the base; «Сохранить как» writes base + global only', async () => {
        await edit('global', 'Global GM');
        await edit('chat', 'Chat GM');
        await stand.store.save();
        expect(mainOf(stand.server.files.get('Marinara'))).toBe('You are the GM.');
        expect(liveMain()).toBe('Chat GM');
        const saved = await stand.store.saveAs('Copy');
        expect(saved).toBe('Copy');
        expect(mainOf(stand.server.files.get('Copy'))).toBe('Global GM');
        expect(stand.store.current()).toBe('Copy');
        expect(liveMain()).toBe('Global GM');
    });

    it('ST’s own «Обновить пресет» is written without them, and its cached copy is cleaned', async () => {
        await edit('global', 'Global GM');
        await edit('chat', 'Chat GM');
        const openai = stand.openai as { getChatCompletionPreset(): Dict };
        const presetBody = openai.getChatCompletionPreset();
        const init: RequestInit = {
            method: 'POST',
            body: JSON.stringify({ apiId: 'openai', name: 'Marinara', preset: presetBody }),
        };
        await stand.env.stFetch('/api/presets/save', init);
        const sent = JSON.parse(String(stand.env.server.requests.at(-1)?.init?.body)) as { preset: Dict };
        expect(mainOf(sent.preset)).toBe('Global GM');
        // ST then puts the body it built into its cache (openai.js saveOpenAIPreset).
        Object.assign(stand.cache.list[0] as Dict, structuredClone(presetBody));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(mainOf(stand.cache.list[0])).toBe('Global GM');
        expect(liveMain()).toBe('Chat GM');
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('leaves alone a body written without them (the studio’s own saves) and other APIs', async () => {
        await edit('chat', 'Chat GM');
        const plain = JSON.stringify({
            apiId: 'openai',
            name: 'Marinara',
            preset: { prompts: [{ identifier: 'main', content: 'x' }] },
        });
        const init: RequestInit = { method: 'POST', body: plain };
        await stand.env.stFetch('/api/presets/save', init);
        expect(init.body).toBe(plain);
        const novel = JSON.stringify({ apiId: 'novel', name: 'N', preset: { prompts: [] } });
        const other: RequestInit = { method: 'POST', body: novel };
        await stand.env.stFetch('/api/presets/save', other);
        expect(other.body).toBe(novel);
    });

    it('ST’s own «Сохранить как» selects the copy without the chat edits', async () => {
        await edit('chat', 'Chat GM');
        const openai = stand.openai as { getChatCompletionPreset(): Dict };
        const presetBody = openai.getChatCompletionPreset();
        await stand.env.stFetch('/api/presets/save', {
            method: 'POST',
            body: JSON.stringify({ apiId: 'openai', name: 'Mine', preset: presetBody }),
        });
        // openai.js: the body it built goes into the cache and the list, then the list's change selects it.
        stand.cache.list.push(structuredClone(presetBody));
        stand.cache.names.Mine = stand.cache.list.length - 1;
        const option = document.createElement('option');
        option.value = String(stand.cache.names.Mine);
        option.text = 'Mine';
        stand.select.append(option);
        await stand.manager.selectPreset(option.value);
        await settle();
        expect(stand.store.current()).toBe('Mine');
        expect(liveMain()).toBe('You are the GM.');
    });
});

describe('moving, conflicts, undo', () => {
    it('moves an op into another scope with the base values of its new place; undo moves it back', async () => {
        await edit('global', 'Global GM');
        await layer.moveOp?.('Marinara', 0, 'chat');
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ scope: 'chat', baseText: 'You are the GM.', patch: { content: 'Global GM' } }),
        ]);
        expect(liveMain()).toBe('Global GM');
        expect(stand.store.draft().dirty).toBe(false);
        await openChat('chat-2');
        expect(liveMain()).toBe('You are the GM.');
        await openChat('chat-1');
        const record = stand.env.journal.list({ module: 'M34' })[0];
        expect(record?.kind).toBe('preset.layer');
        expect(await stand.env.journal.undo(record?.id ?? '')).toBe(true);
        expect(layer.get('Marinara')?.ops.map((op) => op.scope)).toEqual(['global']);
    });

    it('tags a conflict of the chat part with its scope and settles it there', async () => {
        await edit('chat', 'Chat GM');
        // A later global edit changes the text the chat edit was made on.
        await layer.record('Marinara', {
            op: 'edit',
            identifier: 'main',
            patch: { content: 'Global GM' },
            baseHash: textHash('You are the GM.'),
            baseText: 'You are the GM.',
        });
        expect(layer.lastReport()?.conflicts).toEqual([
            expect.objectContaining({ identifier: 'main', newBase: 'Global GM', mine: 'Chat GM', scope: 'chat' }),
        ]);
        await layer.resolveConflict('Marinara', 'main', 'mine', 'chat');
        expect(layer.lastReport()?.conflicts).toEqual([]);
        expect(layer.get('Marinara', { scope: 'chat' })?.ops[0]).toMatchObject({ baseText: 'Global GM' });
    });

    it('undoes a chat edit from the journal', async () => {
        await edit('chat', 'Chat GM');
        const record = stand.env.journal.list({ module: 'M34' }).find((item) => item.kind === 'preset.layer');
        expect(record?.changes[0]?.ref).toMatchObject({ base: 'Marinara', scope: 'chat', owner: 'chat-1' });
        expect(record?.summary).toContain('in this chat only');
        expect(await stand.env.journal.undo(record?.id ?? '')).toBe(true);
        expect(layer.get('Marinara')).toBeNull();
    });
});

describe('page load and the global layer files', () => {
    it('reads an existing layer file as the global scope (no rewrite)', async () => {
        await edit('global', 'Global GM');
        await settle();
        const name = stand.env.app.files.fileName('preset-layer', 'Marinara');
        const stored = JSON.parse(stand.env.mock.files.get(name) ?? '{}') as { ops: Dict[] };
        expect(stored.ops[0]).not.toHaveProperty('scope');
        const again = start();
        await settle(again);
        expect(again.get('Marinara')?.ops[0]).toMatchObject({ scope: 'global', patch: { content: 'Global GM' } });
    });

    it('strips the edits of the chat the working copy was saved with when the page opens another chat', async () => {
        await edit('chat', 'Chat GM');
        expect(stand.env.app.settings.module<Dict>('presetStudio').scopeApplied).toEqual({
            base: 'Marinara',
            avatar: 'alice.png',
            chatId: 'chat-1',
        });
        layer.dispose();
        stand.env.mock.chatId = 'chat-2';
        const again = start();
        await settle(again);
        expect(liveMain()).toBe('You are the GM.');
        expect(stand.store.draft().dirty).toBe(false);
    });
});

describe('disabling', () => {
    it('takes the character and chat edits out of the working copy; the global layer stays (P11)', async () => {
        await edit('global', 'Global GM');
        await edit('chat', 'Chat GM');
        layer.dispose();
        await stand.store.whenIdle();
        expect(liveMain()).toBe('Global GM');
        expect(stand.env.app.settings.module<Dict>('presetStudio').scopeApplied).toMatchObject({ chatId: null });
    });
});

describe('a whole preset bound to the card or the chat', () => {
    it('binds, shows and unbinds, journaled with undo', async () => {
        await layer.bind?.('chat', 'Other');
        expect(layer.bindings?.()).toMatchObject({
            chat: 'Other',
            character: null,
            active: { scope: 'chat', preset: 'Other' },
        });
        await layer.bind?.('character', 'Marinara');
        expect(layer.bindings?.().active).toEqual({ scope: 'chat', preset: 'Other' });
        await openChat('chat-2');
        expect(layer.bindings?.()).toMatchObject({ chat: null, character: 'Marinara' });
        await openChat('chat-1');
        const record = stand.env.journal.list({ module: 'M34' }).find((item) => item.kind === 'preset.binding');
        expect(record?.changes[0]).toMatchObject({ target: 'preset-binding', before: null, after: 'Marinara' });
        expect(await stand.env.journal.undo(record?.id ?? '')).toBe(true);
        expect(layer.bindings?.().character).toBeNull();
        await layer.bind?.('chat', null);
        expect(layer.bindings?.().active).toBeNull();
    });
});
