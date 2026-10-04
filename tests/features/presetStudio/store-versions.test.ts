// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERSION_LIMIT } from '../../../src/domain/preset-store-versions';
import { createStoreEnv, ev, versionsFile } from './helpers-store';
import type { StoreEnv } from './helpers-store';

type Dict = Record<string, unknown>;

let stand: StoreEnv;

beforeEach(async () => {
    stand = await createStoreEnv();
});

afterEach(async () => {
    await stand.stop();
});

describe('versions file', () => {
    it('lives in a Maestro file named by the preset hash, packs long prompt texts once', async () => {
        const long = 'L'.repeat(600);
        await stand.store.updatePrompt('style', { content: long });
        await stand.store.save();
        await stand.store.setKeys({ temperature: 0.5 });
        await stand.store.save();
        const name = stand.store.history.fileName('Marinara');
        expect(name).toMatch(/^maestro-preset-versions-[0-9a-z]+\.json$/);
        const file = versionsFile(stand, 'Marinara')!;
        expect(file.name).toBe('Marinara');
        expect((file.versions as Dict[]).length).toBe(3);
        expect(Object.values(file.blobs as Dict)).toEqual([long]);
        const versions = await stand.store.versions('Marinara');
        expect((versions[0]!.body.prompts as Dict[]).find((prompt) => prompt.identifier === 'style')!.content).toBe(
            long,
        );
    });

    it(`keeps the last ${VERSION_LIMIT} versions and skips saves that change nothing`, async () => {
        for (let i = 0; i < VERSION_LIMIT + 3; i++) {
            await stand.store.setKeys({ openai_max_tokens: 100 + i });
            await stand.store.save();
        }
        await stand.store.save();
        const versions = await stand.store.versions('Marinara');
        expect(versions).toHaveLength(VERSION_LIMIT);
        expect(versions[0]!.body.openai_max_tokens).toBe(100 + VERSION_LIMIT + 2);
    });
});

describe('saves made outside Maestro', () => {
    it('take a first snapshot, then a version by «st» when ST changed the cached body', async () => {
        await stand.store.checkOutsideSave();
        let versions = await stand.store.versions('Marinara');
        expect(versions.map((version) => version.by)).toEqual(['st']);
        expect(versions[0]!.summary).toBe('First snapshot');
        // ST's «update preset»: Object.assign into the cache (OAI:4613-4620), no event of its own.
        Object.assign(stand.cache.list[0] as Dict, { temperature: 1.3 });
        await stand.env.mock.eventSource.emit(ev('SETTINGS_UPDATED'));
        await stand.store.checkOutsideSave();
        versions = await stand.store.versions('Marinara');
        expect(versions.map((version) => [version.by, version.body.temperature])).toEqual([
            ['st', 1.3],
            ['st', 1],
        ]);
        expect(versions[0]!.summary).toBe('Saved outside Maestro');
        // Nothing new: no read, no version.
        await stand.store.checkOutsideSave();
        expect(await stand.store.versions('Marinara')).toHaveLength(2);
    });

    it('run on their own after OAI_PRESET_CHANGED_AFTER (debounced)', async () => {
        await stand.store.select('Other');
        await new Promise((resolve) => setTimeout(resolve, 1700));
        await stand.store.whenIdle();
        expect((await stand.store.versions('Other')).map((version) => version.by)).toEqual(['st']);
    });

    it('do not repeat a file state after a draft snapshot', async () => {
        await stand.store.checkOutsideSave();
        await stand.store.setKeys({ temperature: 0.4 });
        await stand.store.select('Other');
        await stand.store.select('Marinara');
        await stand.store.whenIdle();
        await stand.store.checkOutsideSave();
        expect((await stand.store.versions('Marinara')).map((version) => version.by)).toEqual(['draft', 'st']);
    });

    it('follow ST own rename (PRESET_RENAMED from the preset manager)', async () => {
        await stand.store.save();
        await stand.env.mock.eventSource.emit('PRESET_RENAMED', {
            apiId: 'openai',
            oldName: 'Marinara',
            newName: 'M2',
        });
        await stand.store.whenIdle();
        expect(await stand.store.versions('Marinara')).toHaveLength(0);
        expect((await stand.store.versions('M2')).length).toBeGreaterThan(0);
    });
});

describe('restoreVersion', () => {
    it('writes the version body through the explicit-body save, keeps secrets of the file and applies it', async () => {
        await stand.store.setKeys({ temperature: 0.4 });
        await stand.store.save();
        const old = (await stand.store.versions('Marinara')).find((version) => version.body.temperature === 1)!;
        const before = stand.events.length;
        await stand.store.restoreVersion('Marinara', old.id);
        const file = stand.server.files.get('Marinara')!;
        expect(file.temperature).toBe(1);
        expect(file.proxy_password).toBe('secret');
        expect((stand.cache.list[0] as Dict).temperature).toBe(1);
        // The current preset takes the restored body (ST change); its clean copy is not snapped as a draft.
        expect(stand.oai.temp_openai).toBe(1);
        expect(stand.events.slice(before).map((item) => item.name)).toContain(ev('OAI_PRESET_CHANGED_AFTER'));
        await stand.store.whenIdle();
        const versions = await stand.store.versions('Marinara');
        expect(versions[0]!.by).toBe('user');
        expect(versions.some((version) => version.by === 'draft')).toBe(false);
        expect(stand.manager.savePreset).not.toHaveBeenCalled();
    });

    it('snaps real unsaved edits before applying the restored body', async () => {
        await stand.store.save();
        await stand.store.setKeys({ temperature: 0.4 });
        await stand.store.save();
        const old = (await stand.store.versions('Marinara')).find((version) => version.body.temperature === 1)!;
        await stand.store.setKeys({ temperature: 0.9 });
        await stand.store.restoreVersion('Marinara', old.id);
        await stand.store.whenIdle();
        const drafts = (await stand.store.versions('Marinara')).filter((version) => version.by === 'draft');
        expect(drafts.map((version) => version.body.temperature)).toEqual([0.9]);
    });

    it('restores a deleted preset from its versions and refuses unknown ids', async () => {
        await stand.store.save();
        const [version] = await stand.store.versions('Other');
        expect(version).toBeUndefined();
        await stand.store.checkOutsideSave();
        const marinara = (await stand.store.versions('Marinara'))[0]!;
        await stand.store.select('Other');
        await stand.store.remove('Marinara');
        await stand.store.restoreVersion('Marinara', marinara.id);
        expect(stand.store.names()).toContain('Marinara');
        await expect(stand.store.restoreVersion('Marinara', 'v-nope')).rejects.toMatchObject({ code: 'not-found' });
    });
});
