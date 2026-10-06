// @vitest-environment happy-dom
// Release 1.13 additions of the preset store: a preset file made from a body without dialogs (createFromBody), the
// comparison of two presets, and rewriting the working copy without a journal record (syncWorking).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPrompt } from '../../../src/domain/preset-layer-apply';
import { FILE_TARGET } from '../../../src/features/presetStudio/store';
import type { PresetBody } from '../../../src/features/presetStudio/store-api';
import { createStoreEnv, versionsFile } from './helpers-store';
import type { StoreEnv } from './helpers-store';

type Dict = Record<string, unknown>;

let stand: StoreEnv;

beforeEach(async () => {
    stand = await createStoreEnv();
});

afterEach(async () => {
    await stand.stop();
});

describe('createFromBody', () => {
    it('writes a new file from a body, keys it lacks from the current preset, no addresses from the body', async () => {
        const name = await stand.store.createFromBody('Built', {
            temperature: 0.4,
            reverse_proxy: 'http://evil',
            prompts: [
                { identifier: 'mine', name: 'Mine', content: 'Hello', system_prompt: 'nope' as unknown as boolean },
            ],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'mine', enabled: true }] }],
        });
        expect(name).toBe('Built');
        const file = stand.server.files.get('Built') as Dict;
        expect(file.temperature).toBe(0.4);
        expect(file.openai_max_tokens).toBe(1024);
        expect(file.reverse_proxy).toBe('http://proxy.local');
        expect(findPrompt(file, 'mine')).toMatchObject({ system_prompt: false, marker: false, role: 'system' });
        expect(stand.store.names()).toContain('Built');
        expect(stand.store.current()).toBe('Marinara');
        expect(versionsFile(stand, 'Built')).toBeDefined();
        const record = stand.env.journal.list({ module: 'M34' })[0];
        expect(record?.kind).toBe('presetStudio.create');
        expect(record?.changes[0]).toMatchObject({ target: FILE_TARGET, ref: { op: 'create', created: true } });
        // Undo deletes the new file.
        expect(await stand.env.journal.undo(record?.id ?? '')).toBe(true);
        expect(stand.server.files.has('Built')).toBe(false);
        expect(stand.store.names()).not.toContain('Built');
    });

    it('selects it when asked, refuses a taken name unless overwriting', async () => {
        await expect(stand.store.createFromBody('Other', { temperature: 0.2 })).rejects.toMatchObject({
            code: 'exists',
        });
        await expect(stand.store.createFromBody('  ', { temperature: 0.2 })).rejects.toMatchObject({ code: 'invalid' });
        await stand.store.createFromBody('Other', { temperature: 0.2 }, { overwrite: true });
        expect((stand.server.files.get('Other') as Dict).temperature).toBe(0.2);
        await stand.store.createFromBody('Fresh', { temperature: 0.6 }, { select: true });
        expect(stand.store.current()).toBe('Fresh');
        expect(stand.oai.temp_openai).toBe(0.6);
    });
});

describe('compare', () => {
    it('compares presets by name or body', () => {
        const result = stand.store.compare('Marinara', 'Other');
        expect(result.removed.map((block) => block.identifier)).toEqual(['chatHistory', 'jailbreak', 'style', 'depth']);
        expect(result.changed).toEqual([{ identifier: 'main', name: 'Main Prompt', fields: ['content'] }]);
        expect(result.params.find((param) => param.key === 'temperature')).toEqual({
            key: 'temperature',
            a: 1,
            b: 0.7,
        });
        expect(result.params.find((param) => param.key === 'proxy_password')).toEqual({
            key: 'proxy_password',
            a: '•••',
            b: null,
        });
        expect(stand.store.compare(stand.store.working(), 'Marinara').changed).toEqual([]);
        expect(() => stand.store.compare('Nope', 'Marinara')).toThrow(/no preset/);
    });
});

describe('syncWorking', () => {
    it('rewrites blocks, order and keys of the working copy without a journal record or a version', async () => {
        const before = stand.env.journal.list().length;
        const next = structuredClone(stand.store.working()) as Dict & { prompts: Dict[]; prompt_order: Dict[] };
        next.prompts = next.prompts.filter((prompt) => prompt.identifier !== 'depth');
        next.prompts.push({ identifier: 'own', name: 'Own', role: 'system', content: 'Mine', system_prompt: false });
        (next.prompts[0] as Dict).content = 'Changed GM';
        const order = (next.prompt_order[0] as { order: Dict[] }).order.filter((item) => item.identifier !== 'depth');
        order.splice(1, 0, { identifier: 'own', enabled: true });
        (next.prompt_order[0] as { order: Dict[] }).order = order;
        next.temperature = 0.2;
        expect(await stand.store.syncWorking(next as PresetBody)).toBe(true);
        expect(findPrompt({ prompts: stand.oai.prompts }, 'main')?.content).toBe('Changed GM');
        expect(findPrompt({ prompts: stand.oai.prompts }, 'depth')).toBeUndefined();
        expect(stand.store.prompts().map((row) => row.item.identifier)).toEqual([
            'main',
            'own',
            'style',
            'chatHistory',
            'jailbreak',
        ]);
        expect(stand.oai.temp_openai).toBe(0.2);
        expect(stand.env.journal.list()).toHaveLength(before);
        expect(stand.pm.renders.length).toBeGreaterThan(0);
        expect(await stand.store.syncWorking(next as PresetBody)).toBe(false);
    });
});
