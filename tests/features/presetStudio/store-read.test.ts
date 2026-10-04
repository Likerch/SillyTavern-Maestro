// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PresetLayerApi } from '../../../src/features/presetStudio/layer-api';
import { KEYS_TARGET, PRESET_LAYER_KEY, PresetStoreError } from '../../../src/features/presetStudio/store';
import { createStoreEnv, ev } from './helpers-store';
import type { StoreEnv } from './helpers-store';

type Dict = Record<string, unknown>;

let stand: StoreEnv;

beforeEach(async () => {
    stand = await createStoreEnv();
});

afterEach(async () => {
    await stand.stop();
});

describe('reading', () => {
    it('lists the presets in ST order and reads the current one', () => {
        expect(stand.store.names()).toEqual(['Marinara', 'Other']);
        expect(stand.store.current()).toBe('Marinara');
    });

    it('gives the working copy by preset keys, without undefined keys', () => {
        const working = stand.store.working();
        expect(working.temperature).toBe(1);
        expect(working).not.toHaveProperty('temp_openai');
        expect(working.top_p).toBe(0.9);
        expect(working.seed).toBe(-1);
        expect(Object.values(working)).not.toContain(undefined);
        // Prompt Manager added the missing built-ins to the working copy.
        expect((working.prompts ?? []).map((prompt) => prompt.identifier)).toContain('nsfw');
    });

    it('reads the saved body from ST cache as a copy', () => {
        const saved = stand.store.saved('Marinara')!;
        expect(saved.marinara_version).toBe('7.2');
        saved.temperature = 5;
        expect(stand.store.saved('Marinara')!.temperature).toBe(1);
        expect(stand.store.saved('Nope')).toBeNull();
    });

    it('resolves the active order with the prompt objects (null for a dangling entry)', () => {
        const order = stand.pm.getPromptOrderForCharacter({ id: 100001 });
        order.push({ identifier: 'ghost', enabled: true });
        const rows = stand.store.prompts();
        expect(rows.map((row) => row.item.identifier)).toEqual([
            'main',
            'style',
            'chatHistory',
            'depth',
            'jailbreak',
            'ghost',
        ]);
        expect(rows[3]!.item.enabled).toBe(false);
        expect(rows[1]!.prompt?.content).toBe('Write vividly.');
        expect(rows[5]!.prompt).toBeNull();
    });

    it('falls back to the select when the module cache is not loaded', async () => {
        await stand.stop();
        stand = await createStoreEnv();
        stand.openai.openai_settings = undefined;
        expect(stand.store.names()).toEqual(['Marinara', 'Other']);
    });
});

describe('draft', () => {
    it('is clean right after the preset was applied (missing built-ins and absent keys are no draft)', () => {
        expect(stand.store.draft()).toEqual({ dirty: false, changedPrompts: [], changedKeys: [] });
    });

    it('treats numeric strings like ST input handlers do', () => {
        (stand.cache.list[0] as Dict).temperature = '1';
        (stand.cache.list[0] as Dict).openai_max_tokens = '1024';
        expect(stand.store.draft().dirty).toBe(false);
    });

    it('reports changed keys, prompts, switches and the order', async () => {
        await stand.store.setKeys({ temperature: 0.5 });
        await stand.store.updatePrompt('style', { content: 'Write tersely.' });
        await stand.store.setEnabled(['depth'], true);
        await stand.store.reorder(['main', 'chatHistory', 'style']);
        const draft = stand.store.draft();
        expect(draft.dirty).toBe(true);
        expect(draft.changedKeys).toEqual(expect.arrayContaining(['temperature', 'prompt_order']));
        expect(draft.changedPrompts).toEqual(expect.arrayContaining(['style', 'depth']));
    });

    it('sees a new block and a changed extension field, not a field only the file has', async () => {
        stand.oai.extensions = { regex_scripts: [{ id: 'r1', scriptName: 'Strip' }] };
        expect(stand.store.draft().dirty).toBe(false);
        await stand.store.addPrompt({ name: 'Mine', content: 'x' }, 'style');
        stand.oai.extensions = { other_ext: { keep: false } };
        const draft = stand.store.draft();
        expect(draft.changedKeys).toContain('extensions');
        expect(draft.changedPrompts).toHaveLength(1);
    });

    it('compares with the layer applied when the layer module has one for the preset', async () => {
        await stand.store.setKeys({ temperature: 0.3 });
        const layer: Partial<PresetLayerApi> = {
            get: (base) =>
                base === 'Marinara'
                    ? { base, ops: [{ op: 'key', key: 'temperature', value: 0.3 }], updatedAt: 1 }
                    : null,
            apply: (_base, body) => ({
                body: { ...body, temperature: 0.3 },
                report: { applied: 1, conflicts: [], orphaned: [] },
            }),
            strip: (_base, body) => ({ ...body, temperature: 1 }),
        };
        stand.env.apis.set(PRESET_LAYER_KEY, layer);
        expect(stand.store.draft().dirty).toBe(false);
        // Saving the base strips the layer: the file keeps the base value.
        await stand.store.save();
        expect(stand.server.saves.at(-1)!.preset.temperature).toBe(1);
    });
});

describe('setKeys', () => {
    it('writes oai_settings by settings key through the control ST listens to', async () => {
        await stand.store.setKeys({ temperature: '0.65', openai_max_tokens: 2048 });
        expect(stand.oai.temp_openai).toBe(0.65);
        expect(stand.oai.openai_max_tokens).toBe(2048);
        expect((document.getElementById('temp_openai') as HTMLInputElement).value).toBe('0.65');
        expect(stand.controls.inputs).toEqual(expect.arrayContaining(['temp_openai', 'openai_max_tokens']));
        expect(stand.env.mock.saveSettingsCalls).toBeGreaterThan(0);
        expect(stand.store.working().temperature).toBe(0.65);
    });

    it('types checkboxes and refreshes the source lists for connection keys like ST', async () => {
        await stand.store.setKeys({ stream_openai: 'false', chat_completion_source: 'deepseek' });
        expect(stand.oai.stream_openai).toBe(false);
        expect((document.getElementById('stream_toggle') as HTMLInputElement).checked).toBe(false);
        expect(stand.oai.chat_completion_source).toBe('deepseek');
        expect(stand.controls.changes).toContain('chat_completion_source');
    });

    it('refuses prompt keys and unknown keys without touching anything', async () => {
        await expect(stand.store.setKeys({ prompts: [] })).rejects.toBeInstanceOf(PresetStoreError);
        await expect(stand.store.setKeys({ temperature: 0.1, not_a_key: 1 })).rejects.toMatchObject({
            code: 'invalid',
        });
        expect(stand.oai.temp_openai).toBe(1);
    });

    it('does nothing (no journal) when the values are the same', async () => {
        await stand.store.setKeys({ temperature: 1 });
        expect(stand.env.journal.list().filter((record) => record.module === 'M34')).toHaveLength(0);
    });

    it('is journaled and undone', async () => {
        await stand.store.setKeys({ temperature: 0.2, bias_preset_selected: 'Other bias' });
        expect(stand.controls.changes).toContain('openai_logit_bias_preset');
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        expect(record.changes[0]!.target).toBe(KEYS_TARGET);
        expect(record.changes[0]!.before).toEqual({ temperature: 1, bias_preset_selected: 'Default (none)' });
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect(stand.oai.temp_openai).toBe(1);
        expect(stand.oai.bias_preset_selected).toBe('Default (none)');
    });

    it('does not undo keys changed again since', async () => {
        await stand.store.setKeys({ temperature: 0.2 });
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        await stand.store.setKeys({ temperature: 0.4 });
        expect(await stand.env.journal.undo(record.id)).toBe(false);
        expect(stand.oai.temp_openai).toBe(0.4);
    });
});

describe('change notifications', () => {
    it('reports own edits at once and outside edits after SETTINGS_UPDATED', async () => {
        const reasons: string[] = [];
        stand.store.onChange((reason) => reasons.push(reason));
        await stand.store.setKeys({ temperature: 0.3 });
        expect(reasons).toEqual(['keys']);
        // Another writer (PM's classic editor, /setpromptentry) changes the working copy.
        stand.pm.getPromptOrderEntry({ id: 100001 }, 'depth')!.enabled = true;
        await stand.env.mock.eventSource.emit(ev('SETTINGS_UPDATED'));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(reasons).toEqual(['keys', 'prompts']);
    });

    it('reports a preset switch after OAI_PRESET_CHANGED_AFTER', async () => {
        const reasons: string[] = [];
        const off = stand.store.onChange((reason) => reasons.push(reason));
        await stand.store.select('Other');
        expect(reasons).toContain('preset');
        off();
        await stand.store.select('Marinara');
        expect(reasons.filter((reason) => reason === 'preset')).toHaveLength(1);
    });
});
