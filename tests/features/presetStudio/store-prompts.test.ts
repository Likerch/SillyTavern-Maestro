// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROMPT_TARGET, PresetStoreError } from '../../../src/features/presetStudio/store';
import { createStoreEnv } from './helpers-store';
import type { StoreEnv } from './helpers-store';

type Dict = Record<string, unknown>;

let stand: StoreEnv;

beforeEach(async () => {
    stand = await createStoreEnv();
});

afterEach(async () => {
    await stand.stop();
});

function live(identifier: string): Dict {
    return stand.pm.getPromptById(identifier)!;
}

function order(): { identifier: unknown; enabled: unknown }[] {
    return stand.pm
        .getPromptOrderForCharacter({ id: 100001 })
        .map((entry) => ({ identifier: entry.identifier, enabled: entry.enabled }));
}

function records() {
    return stand.env.journal.list({ module: 'M34' });
}

describe('updatePrompt', () => {
    it('edits the prompt object PM holds, with ST-strict types, then saves settings and re-renders', async () => {
        const object = live('style');
        await stand.store.updatePrompt('style', {
            content: 'New text',
            injection_position: '1' as unknown as 1,
            injection_depth: '3' as unknown as number,
            injection_order: '99' as unknown as number,
            role: 'User' as unknown as 'user',
            system_prompt: 'true' as unknown as boolean,
        });
        expect(live('style')).toBe(object);
        expect(object).toMatchObject({
            content: 'New text',
            injection_position: 1,
            injection_depth: 3,
            injection_order: 99,
            role: 'user',
            system_prompt: false,
            marker: false,
            mystery_field: 'kept',
        });
        expect(stand.pm.saves).toBe(1);
        expect(stand.pm.renders).toEqual([false]);
        // Prompt edits never write the preset file.
        expect(stand.server.saves).toHaveLength(0);
    });

    it('keeps the quick-edit fields in step for main/nsfw/jailbreak (P-012)', async () => {
        await stand.store.updatePrompt('main', { content: 'You narrate.' });
        expect(stand.pm.quickEdits).toEqual(['main']);
        expect(live('main').system_prompt).toBe(true);
    });

    it('is journaled with before/after and undone', async () => {
        await stand.store.updatePrompt('style', { content: 'Changed' });
        const record = records()[0]!;
        expect(record.changes[0]).toMatchObject({
            target: PROMPT_TARGET,
            ref: { preset: 'Marinara', part: 'prompt', identifier: 'style' },
        });
        expect((record.changes[0]!.before as Dict).content).toBe('Write vividly.');
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect(live('style').content).toBe('Write vividly.');
    });

    it('does not undo a prompt edited again since, nor after a preset switch', async () => {
        await stand.store.updatePrompt('style', { content: 'One' });
        const first = records()[0]!;
        await stand.store.updatePrompt('style', { content: 'Two' });
        expect(await stand.env.journal.undo(first.id)).toBe(false);
        const second = records()[0]!;
        await stand.store.select('Other');
        expect(await stand.env.journal.undo(second.id)).toBe(false);
    });

    it('skips no-op edits and refuses unknown prompts', async () => {
        await stand.store.updatePrompt('style', { content: 'Write vividly.' });
        expect(records()).toHaveLength(0);
        await expect(stand.store.updatePrompt('nope', { content: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    });
});

describe('addPrompt', () => {
    it('adds through PM, places the block after the anchor switched on', async () => {
        const id = await stand.store.addPrompt(
            { name: 'Scene', content: 'Scene rules', injection_depth: '2' as unknown as number },
            'style',
        );
        expect(live(id)).toMatchObject({
            identifier: id,
            name: 'Scene',
            system_prompt: false,
            marker: false,
            enabled: false,
            injection_depth: 2,
        });
        expect(order().slice(0, 3)).toEqual([
            { identifier: 'main', enabled: true },
            { identifier: 'style', enabled: true },
            { identifier: id, enabled: true },
        ]);
    });

    it('without an anchor puts the block first and switched off, like PM «insert prompt»', async () => {
        const id = await stand.store.addPrompt({ identifier: 'mine', name: 'Mine', content: 'x' });
        expect(id).toBe('mine');
        expect(order()[0]).toEqual({ identifier: 'mine', enabled: false });
        await expect(stand.store.addPrompt({ identifier: 'mine', name: 'Again' })).rejects.toBeInstanceOf(
            PresetStoreError,
        );
    });

    it('undo removes the block and its order entry', async () => {
        const id = await stand.store.addPrompt({ name: 'Temp', content: 'x' }, 'main');
        expect(await stand.env.journal.undo(records()[0]!.id)).toBe(true);
        expect(stand.pm.getPromptById(id)).toBeNull();
        expect(order().map((entry) => entry.identifier)).not.toContain(id);
    });
});

describe('removePrompt', () => {
    it('refuses built-ins (P-029, P-037)', async () => {
        await expect(stand.store.removePrompt('main')).rejects.toMatchObject({ code: 'protected' });
        await expect(stand.store.removePrompt('chatHistory')).rejects.toMatchObject({ code: 'protected' });
    });

    it('removes a user block and its order entry; undo puts both back in place', async () => {
        const index = stand.pm.getPromptIndexById('style');
        await stand.store.removePrompt('style');
        expect(stand.pm.getPromptById('style')).toBeNull();
        expect(order().map((entry) => entry.identifier)).toEqual(['main', 'chatHistory', 'depth', 'jailbreak']);
        expect(await stand.env.journal.undo(records()[0]!.id)).toBe(true);
        expect(stand.pm.getPromptIndexById('style')).toBe(index);
        expect(order().map((entry) => entry.identifier)).toEqual([
            'main',
            'style',
            'chatHistory',
            'depth',
            'jailbreak',
        ]);
    });
});

describe('detachPrompt', () => {
    it('takes a user block out of the order through PM, keeps the block, undoes', async () => {
        await stand.store.detachPrompt('style');
        expect(order().map((entry) => entry.identifier)).toEqual(['main', 'chatHistory', 'depth', 'jailbreak']);
        expect(live('style')).toBeTruthy();
        await stand.store.detachPrompt('style');
        expect(records()).toHaveLength(1);
        await expect(stand.store.detachPrompt('main')).rejects.toMatchObject({ code: 'protected' });
        await expect(stand.store.detachPrompt('nope')).rejects.toMatchObject({ code: 'not-found' });
        expect(await stand.env.journal.undo(records()[0]!.id)).toBe(true);
        expect(order().map((entry) => entry.identifier)).toContain('style');
    });
});

describe('setEnabled and reorder', () => {
    it('switches order entries (not the prompt) and forgets stale token counts', async () => {
        stand.pm.counts.depth = 12;
        await stand.store.setEnabled(['depth', 'style'], true);
        expect(order().find((entry) => entry.identifier === 'depth')!.enabled).toBe(true);
        expect(live('depth').enabled).toBeUndefined();
        expect(stand.pm.counts.depth).toBeNull();
        expect(records()).toHaveLength(1);
    });

    it('inserts a block that is not in the order first', async () => {
        await stand.store.setEnabled(['nsfw'], true);
        expect(order()[0]).toEqual({ identifier: 'nsfw', enabled: true });
        await stand.store.setEnabled(['nothing'], true);
        expect(records()).toHaveLength(1);
    });

    it('reorders like PM drag-and-drop (list replaced) and undoes', async () => {
        const listBefore = stand.pm.getPromptOrderForCharacter({ id: 100001 });
        await stand.store.reorder(['jailbreak', 'main']);
        expect(order().map((entry) => entry.identifier)).toEqual([
            'jailbreak',
            'main',
            'style',
            'chatHistory',
            'depth',
        ]);
        expect(stand.pm.getPromptOrderForCharacter({ id: 100001 })).not.toBe(listBefore);
        await stand.store.reorder(['jailbreak', 'main']);
        expect(records()).toHaveLength(1);
        expect(await stand.env.journal.undo(records()[0]!.id)).toBe(true);
        expect(order().map((entry) => entry.identifier)).toEqual([
            'main',
            'style',
            'chatHistory',
            'depth',
            'jailbreak',
        ]);
    });
});

describe('without Prompt Manager', () => {
    it('edits the same oai_settings directly and saves settings', async () => {
        await stand.stop();
        stand = await createStoreEnv({ withoutPromptManager: true });
        const calls = stand.env.mock.saveSettingsCalls;
        const id = await stand.store.addPrompt({ name: 'Raw', content: 'x' }, 'main');
        await stand.store.reorder([id]);
        await stand.store.setEnabled([id], false);
        await stand.store.removePrompt(id);
        expect(stand.store.prompts().map((row) => row.item.identifier)).not.toContain(id);
        expect(stand.env.mock.saveSettingsCalls).toBeGreaterThan(calls);
        expect(stand.pm.saves).toBe(0);
    });
});
