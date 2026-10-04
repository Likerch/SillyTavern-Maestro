// «Твой слой» (M34 п.5–6) over the ST mock: real files, journal and events; ST's preset switch emulated like
// openai.js onSettingsPresetChange (clone of the cached body → OAI_PRESET_CHANGED_BEFORE → keys into oai_settings →
// OAI_PRESET_CHANGED_AFTER).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { applyLayer, findPrompt, globalOrder, textHash } from '../../../src/domain/preset-layer-apply';
import type { LayerBody } from '../../../src/domain/preset-layer-apply';
import type { DriftItem, GuardianApi } from '../../../src/features/guardian/api';
import type { LayerOp } from '../../../src/features/presetStudio/layer-api';
import { LAYER_INDEX_FILE } from '../../../src/features/presetStudio/layer-files';
import { createPresetLayer, LAYER_TARGET } from '../../../src/features/presetStudio/layer';
import type { PresetLayerHandle } from '../../../src/features/presetStudio/layer';
import type { PresetBody, PresetStore } from '../../../src/features/presetStudio/store-api';
import { baseBody, own } from '../../domain/preset-layer-fixtures';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

type Dict = Record<string, unknown>;

/** Preset key → oai_settings key (openai.js settingsToUpdate, the part these tests use). */
const KEYS: Record<string, string> = {
    temperature: 'temp_openai',
    top_p: 'top_p_openai',
    prompts: 'prompts',
    prompt_order: 'prompt_order',
    extensions: 'extensions',
};

interface Stand {
    env: FeatureEnv;
    live: Dict;
    cache: LayerBody[];
    names: Record<string, number>;
    selectPreset: Mock<(value: unknown) => Promise<void>>;
    savePreset: Mock<(name: string, body: unknown) => Promise<void>>;
    /** ST selecting a preset from the list. */
    select(name: string): Promise<Dict>;
    working(): LayerBody;
    layers: PresetLayerHandle[];
    start(store?: PresetStore): PresetLayerHandle;
}

async function stand(): Promise<Stand> {
    const env = await createFeatureEnv();
    const other: LayerBody = {
        temperature: 0.8,
        prompts: [own('main', 'Other main', { name: 'Main Prompt' }), own('rules', 'Rules\n</task>')],
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'rules', enabled: true },
                ],
            },
        ],
    };
    const cache: LayerBody[] = [baseBody(), other];
    const names: Record<string, number> = { Marinara: 0, Other: 1 };
    const first = structuredClone(cache[0]) as LayerBody;
    const live: Dict = {
        preset_settings_openai: 'Marinara',
        temp_openai: first.temperature,
        top_p_openai: first.top_p,
        prompts: first.prompts,
        prompt_order: first.prompt_order,
        extensions: first.extensions,
    };
    (env.mock.context as unknown as Dict).chatCompletionSettings = live;
    const working = (): LayerBody => {
        const body: Dict = {};
        for (const [presetKey, settingsKey] of Object.entries(KEYS))
            body[presetKey] = structuredClone(live[settingsKey]);
        return body as LayerBody;
    };
    const select = async (name: string): Promise<Dict> => {
        const index = names[name];
        if (index === undefined) throw new Error(`no preset ${name}`);
        const presetNameBefore = live.preset_settings_openai;
        live.preset_settings_openai = name;
        const preset = structuredClone(cache[index]) as Dict;
        await env.mock.eventSource.emit('oai_preset_changed_before', {
            preset,
            presetName: name,
            settingsToUpdate: {},
            settings: live,
            savePreset: async () => {},
            presetNameBefore,
        });
        for (const [presetKey, settingsKey] of Object.entries(KEYS)) {
            if (preset[presetKey] !== undefined) live[settingsKey] = preset[presetKey];
        }
        await env.mock.eventSource.emit('oai_preset_changed_after');
        return preset;
    };
    const selectPreset = vi.fn(async (value: unknown) => {
        const name = Object.keys(names).find((key) => String(names[key]) === value);
        if (name) await select(name);
    });
    const savePreset = vi.fn(async (name: string, body: unknown) => {
        names[name] = cache.length;
        cache.push(structuredClone(body) as LayerBody);
        await select(name);
    });
    env.stModules.openai = {
        get openai_settings() {
            return cache;
        },
        get openai_setting_names() {
            return names;
        },
        getChatCompletionPreset: working,
    };
    env.stModules.presetManager = {
        getPresetManager: () => ({
            findPreset: (name: string) => (names[name] === undefined ? undefined : String(names[name])),
            selectPreset,
            savePreset,
        }),
    };
    const layers: PresetLayerHandle[] = [];
    return {
        env,
        live,
        cache,
        names,
        selectPreset,
        savePreset,
        select,
        working,
        layers,
        start(store?: PresetStore) {
            const layer = createPresetLayer(env.app, env.app.log, store);
            layer.install();
            layers.push(layer);
            return layer;
        },
    };
}

function fakeStore(s: Stand): PresetStore & { updatePrompt: Mock; saveAs: Mock; select: Mock } {
    return {
        names: () => Object.keys(s.names),
        current: () => String(s.live.preset_settings_openai),
        working: () => s.working(),
        saved: (name: string) => {
            const index = s.names[name];
            return index === undefined ? null : ((s.cache[index] as PresetBody | undefined) ?? null);
        },
        updatePrompt: vi.fn(async (identifier: string, patch: Dict) => {
            const prompts = s.live.prompts as Dict[];
            const at = prompts.findIndex((prompt) => prompt.identifier === identifier);
            if (at >= 0) prompts[at] = { ...prompts[at], ...patch };
        }),
        saveAs: vi.fn(async (name: string) => {
            s.names[name] = s.cache.length;
            s.cache.push(s.working());
            return name;
        }),
        select: vi.fn(async (name: string) => {
            await s.select(name);
        }),
    } as unknown as PresetStore & { updatePrompt: Mock; saveAs: Mock; select: Mock };
}

const mainEdit: LayerOp = { op: 'edit', identifier: 'main', patch: { content: 'Mine' }, baseHash: '' };
const ownAdd: LayerOp = {
    op: 'add',
    prompt: own('mine', 'My block'),
    anchor: { kind: 'after', identifier: 'task' },
    enabled: true,
};

function readFile(env: FeatureEnv, name: string): Dict | null {
    const text = env.mock.files.get(name);
    return text === undefined ? null : (JSON.parse(text) as Dict);
}

const order = (body: Dict): string[] => (globalOrder(body as LayerBody) ?? []).map((item) => item.identifier);

let s: Stand;

beforeEach(async () => {
    s = await stand();
});

afterEach(() => {
    for (const layer of s.layers) layer.dispose();
});

describe('storage', () => {
    it('records ops with base values, writes one file per base plus the index, and loads them eagerly', async () => {
        const layer = s.start();
        await layer.ready?.();
        await layer.record('Marinara', mainEdit);
        await layer.record('Marinara', { op: 'key', key: 'temperature', value: 0.5 });
        expect(layer.get('Marinara')?.ops[0]).toMatchObject({
            baseHash: textHash('Main text'),
            baseText: 'Main text',
        });
        await layer.flush?.();
        const name = s.env.app.files.fileName('preset-layer', 'Marinara');
        expect(name).toMatch(/^maestro-preset-layer-[0-9a-z]+\.json$/);
        expect(readFile(s.env, name)).toMatchObject({
            schema: 1,
            base: 'Marinara',
            ops: [{ op: 'edit' }, { op: 'key' }],
        });
        expect(readFile(s.env, LAYER_INDEX_FILE)).toEqual({ schema: 1, bases: ['Marinara'] });

        const again = s.start();
        await again.ready?.();
        expect(again.get('Marinara')?.ops).toEqual(layer.get('Marinara')?.ops);
        expect(again.get('Other')).toBeNull();
    });

    it('merges with another tab instead of overwriting it', async () => {
        const mine = s.start();
        const theirs = s.start();
        await Promise.all([mine.ready?.(), theirs.ready?.()]);
        await mine.record('Marinara', mainEdit);
        await theirs.record('Marinara', { op: 'toggle', identifier: 'nsfw', enabled: true });
        await mine.flush?.();
        await theirs.flush?.();
        const file = readFile(s.env, s.env.app.files.fileName('preset-layer', 'Marinara'));
        expect((file?.ops as Dict[]).map((op) => op.op)).toEqual(['edit', 'toggle']);
        expect(theirs.get('Marinara')?.ops).toHaveLength(2);
    });

    it('removes the file and the index entry when the last op goes', async () => {
        const layer = s.start();
        await layer.record('Marinara', mainEdit);
        await layer.flush?.();
        await layer.remove('Marinara', 0);
        await layer.remove('Marinara', 5);
        await layer.flush?.();
        expect(layer.get('Marinara')).toBeNull();
        expect(readFile(s.env, s.env.app.files.fileName('preset-layer', 'Marinara'))).toBeNull();
        expect(readFile(s.env, LAYER_INDEX_FILE)).toEqual({ schema: 1, bases: [] });
    });
});

describe('record validation', () => {
    it('rejects malformed ops and blocks the base does not have', async () => {
        const layer = s.start();
        await expect(
            layer.record('Marinara', { op: 'toggle', identifier: 'chatHistory', enabled: false }),
        ).rejects.toThrow(/chatHistory/);
        await expect(
            layer.record('Marinara', { op: 'edit', identifier: 'gone', patch: { content: 'x' }, baseHash: '' }),
        ).rejects.toThrow(/no block gone/);
        await expect(layer.record('Marinara', { op: 'key', key: 'proxy_password', value: 'x' })).rejects.toThrow(
            /never stored/,
        );
        await expect(
            layer.record('Unknown', { op: 'edit', identifier: 'main', patch: { content: 'x' }, baseHash: '' }),
        ).rejects.toThrow(/base text/);
    });

    it('gives a picked block an identifier of its own when the base uses it', async () => {
        const layer = s.start();
        const [picked] = layer.importForeign({ prompts: [own('task', 'Foreign task')] });
        expect(picked).toBeDefined();
        await layer.record('Marinara', { op: 'add', prompt: picked!, anchor: { kind: 'end' }, enabled: true });
        await layer.record('Marinara', {
            op: 'add',
            prompt: { ...own('', 'Nameless') },
            anchor: { kind: 'end' },
            enabled: true,
        });
        const ops = layer.get('Marinara')?.ops ?? [];
        const ids = ops.map((op) => (op.op === 'add' ? op.prompt.identifier : ''));
        expect(ids).toHaveLength(2);
        expect(ids).not.toContain('task');
        expect(ids).not.toContain('');
        // An own block's later edit goes into its add op.
        await layer.record('Marinara', {
            op: 'edit',
            identifier: ids[0] as string,
            patch: { content: 'Edited' },
            baseHash: '',
        });
        expect(layer.get('Marinara')?.ops[0]).toMatchObject({ op: 'add', prompt: { content: 'Edited' } });
    });
});

describe('OAI_PRESET_CHANGED_BEFORE / AFTER', () => {
    it('lays the layer over event.preset in place with fresh arrays, and remembers the result', async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        await layer.record('Marinara', mainEdit);
        await layer.record('Marinara', { op: 'key', key: 'temperature', value: 0.5 });
        const changes = vi.fn();
        layer.onChange(changes);
        let original: unknown;
        s.env.mock.eventSource.makeFirst('oai_preset_changed_before', (payload) => {
            original = (payload as { preset: Dict }).preset.prompts;
        });
        const preset = await s.select('Marinara');
        expect(preset.prompts).not.toBe(original);
        expect((original as unknown[]).length).toBe(7);
        expect(order(s.live)).toEqual(['main', 'task', 'mine', 'style', 'nsfw', 'chatHistory', 'jailbreak']);
        expect(findPrompt(s.live as LayerBody, 'main')?.content).toBe('Mine');
        expect(s.live.temp_openai).toBe(0.5);
        expect(findPrompt(s.cache[0], 'main')?.content).toBe('Main text');
        expect(layer.lastReport()).toEqual({ applied: 3, conflicts: [], orphaned: [] });
        expect(changes).toHaveBeenCalled();
        await layer.flush?.();
        const file = readFile(s.env, s.env.app.files.fileName('preset-layer', 'Marinara'));
        expect(file?.applied).toMatchObject({ fingerprint: expect.any(String), baseFingerprint: expect.any(String) });
    });

    it('skips a rename in progress, an empty preset and a preset without a layer', async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        const es = s.env.mock.eventSource;
        await es.emit('preset_renamed_before', { apiId: 'openai', oldName: 'Marinara', newName: 'Marinara 2' });
        const during = { preset: structuredClone(s.cache[0]) as Dict, presetName: 'Marinara' };
        await es.emit('oai_preset_changed_before', during);
        expect(findPrompt(during.preset as LayerBody, 'mine')).toBeUndefined();
        await es.emit('preset_renamed', { apiId: 'openai', oldName: 'Marinara', newName: 'Marinara 2' });
        expect(layer.get('Marinara')).toBeNull();
        expect(layer.get('Marinara 2')?.ops).toHaveLength(1);

        const empty = { preset: {} as Dict, presetName: 'Marinara 2' };
        await es.emit('oai_preset_changed_before', empty);
        expect(empty.preset).toEqual({});
        const none = { preset: structuredClone(s.cache[1]) as Dict, presetName: 'Other' };
        await es.emit('oai_preset_changed_before', none);
        expect(none.preset).toEqual(s.cache[1]);
        await es.emit('oai_preset_changed_before', null);
        await es.emit('preset_renamed_before', { apiId: 'textgenerationwebui', oldName: 'a', newName: 'b' });
        await es.emit('preset_renamed', { apiId: 'openai' });
        // The renamed preset (ST baked the layer into it) gets the layer again without duplicates or conflicts.
        s.names['Marinara 2'] = s.cache.length;
        s.cache.push(applyLayer(s.cache[0] as LayerBody, layer.get('Marinara 2')?.ops ?? []).body);
        await s.select('Marinara 2');
        expect(order(s.live).filter((id) => id === 'mine')).toHaveLength(1);
        expect(layer.lastReport()?.conflicts).toEqual([]);
    });

    it('waits for layers still loading at start', async () => {
        const first = s.start();
        await first.record('Marinara', ownAdd);
        await first.flush?.();
        first.dispose();
        const late = s.start();
        await s.select('Marinara');
        expect(order(s.live)).toContain('mine');
        expect(late.get('Marinara')).not.toBeNull();
    });

    it('acknowledges the preset parts of the M4 baseline after laying the layer', async () => {
        const acknowledge = vi.fn(async () => {});
        const drift = vi.fn(async (): Promise<DriftItem[]> => [
            { path: 'preset.contents', group: 'preset', baseline: 1, current: 2 },
        ]);
        s.env.apis.set('guardian', { hasBaseline: () => true, drift, acknowledge } as unknown as GuardianApi);
        const layer = s.start();
        await layer.record('Marinara', mainEdit);
        await s.select('Marinara');
        await flush();
        expect(acknowledge).toHaveBeenCalledWith([
            'preset.order',
            'preset.toggles',
            'preset.roles',
            'preset.contents',
            'preset.body',
        ]);
        acknowledge.mockClear();
        drift.mockResolvedValue([{ path: 'preset.name', group: 'preset', baseline: 'A', current: 'B' }]);
        await s.select('Marinara');
        await flush();
        expect(acknowledge).not.toHaveBeenCalled();
    });

    it('reports a changed base as a conflict and keeps the base text', async () => {
        const layer = s.start();
        await layer.record('Marinara', mainEdit);
        const main = findPrompt(s.cache[0], 'main');
        if (main) main.content = 'New main';
        await s.select('Marinara');
        expect(findPrompt(s.live as LayerBody, 'main')?.content).toBe('New main');
        expect(layer.lastReport()?.conflicts).toEqual([
            { identifier: 'main', oldBase: 'Main text', newBase: 'New main', mine: 'Mine' },
        ]);
        await s.select('Other');
        expect(layer.lastReport()).toBeNull();
    });
});

describe('page load', () => {
    async function applied(): Promise<void> {
        const first = s.start();
        await first.record('Marinara', mainEdit);
        await first.record('Marinara', ownAdd);
        await s.select('Marinara');
        await first.flush?.();
        first.dispose();
        s.env.ui.notices.length = 0;
    }

    async function load(): Promise<PresetLayerHandle> {
        const layer = s.start();
        await s.env.mock.eventSource.emit('app_ready');
        await layer.ready?.();
        await flush();
        return layer;
    }

    it('offers to reselect when the working copy loaded without the layer; the action reselects through ST', async () => {
        const first = s.start();
        await first.record('Marinara', mainEdit);
        await first.flush?.();
        first.dispose();
        s.env.ui.notices.length = 0;
        await load();
        expect(s.env.ui.notices).toHaveLength(1);
        const notice = s.env.ui.notices[0];
        expect(notice?.text).toContain('«Marinara»');
        expect(notice?.text).toContain('not laid over');
        expect(notice?.options?.urgent).toBe(true);
        notice?.options?.action?.run();
        await flush();
        expect(s.selectPreset).toHaveBeenCalledWith('0');
        expect(findPrompt(s.live as LayerBody, 'main')?.content).toBe('Mine');
    });

    it('stays quiet when the working copy holds the layer over an unchanged base', async () => {
        await applied();
        const layer = await load();
        expect(s.env.ui.notices).toEqual([]);
        expect(layer.lastReport()?.conflicts).toEqual([]);
        // Only once per install.
        await s.env.mock.eventSource.emit('settings_loaded');
        await flush();
        expect(s.env.ui.notices).toEqual([]);
    });

    it('offers to reselect when the base changed on the server', async () => {
        await applied();
        const task = findPrompt(s.cache[0], 'task');
        if (task) task.content = 'Updated task\n</task>';
        await load();
        expect(s.env.ui.notices).toHaveLength(1);
        expect(s.env.ui.notices[0]?.text).toContain('changed on the server');
    });

    it('treats a base changed under an edited block as a base change', async () => {
        await applied();
        const main = findPrompt(s.cache[0], 'main');
        if (main) main.content = 'New main';
        const layer = await load();
        expect(s.env.ui.notices[0]?.text).toContain('changed on the server');
        expect(layer.lastReport()?.conflicts).toHaveLength(1);
    });

    it('does not count a base that holds the layer (saved with ST’s button) as a change from elsewhere', async () => {
        await applied();
        s.cache[0] = s.working();
        await load();
        expect(s.env.ui.notices).toEqual([]);
    });

    it('does nothing for Text Completion or a preset without a layer', async () => {
        await applied();
        s.env.chatCompletion.value = false;
        await load();
        expect(s.env.ui.notices).toEqual([]);
        s.env.chatCompletion.value = true;
        s.live.preset_settings_openai = 'Other';
        await load();
        expect(s.env.ui.notices).toEqual([]);
    });
});

describe('journal, conflicts, migration, transfer', () => {
    it('undoes layer changes from the journal, newest first', async () => {
        const layer = s.start();
        await layer.record('Marinara', mainEdit);
        await layer.record('Marinara', { op: 'edit', identifier: 'main', patch: { name: 'Mine too' }, baseHash: '' });
        const records = s.env.journal.list({ module: 'M34' });
        expect(records).toHaveLength(2);
        expect(records[0]?.changes[0]?.target).toBe(LAYER_TARGET);
        // The older record cannot be undone while a newer one changed the same op.
        expect(await s.env.journal.undo(records[1]?.id ?? '')).toBe(false);
        expect(await s.env.journal.undo(records[0]?.id ?? '')).toBe(true);
        expect(layer.get('Marinara')?.ops[0]).toMatchObject({ patch: { content: 'Mine' } });
        expect(await s.env.journal.undo(records[1]?.id ?? '')).toBe(true);
        expect(layer.get('Marinara')).toBeNull();
    });

    it("resolves a conflict: 'mine' rebases and shows the text in the working copy", async () => {
        const store = fakeStore(s);
        const layer = s.start(store);
        await layer.record('Marinara', mainEdit);
        const main = findPrompt(s.cache[0], 'main');
        if (main) main.content = 'New main';
        await s.select('Marinara');
        expect(layer.lastReport()?.conflicts).toHaveLength(1);
        await layer.resolveConflict('Marinara', 'main', 'mine');
        expect(layer.get('Marinara')?.ops[0]).toMatchObject({ baseHash: textHash('New main'), baseText: 'New main' });
        expect(store.updatePrompt).toHaveBeenCalledWith('main', { content: 'Mine' });
        expect(layer.lastReport()?.conflicts).toEqual([]);
        await layer.resolveConflict('Marinara', 'main', 'newBase');
        expect(layer.get('Marinara')).toBeNull();
        await expect(layer.resolveConflict('Marinara', 'main', 'mine')).rejects.toThrow(/no op/);
        const records = s.env.journal.list({ module: 'M34' });
        expect(await s.env.journal.undo(records[0]?.id ?? '')).toBe(true);
        expect(layer.get('Marinara')?.ops[0]).toMatchObject({ baseText: 'New main' });
    });

    it('turns a colliding own block into an edit of the base block on resolve', async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        s.cache[0]?.prompts?.push(own('mine', 'Upstreamed block'));
        await s.select('Marinara');
        expect(layer.lastReport()?.conflicts[0]).toMatchObject({ identifier: 'mine', newBase: 'Upstreamed block' });
        await layer.resolveConflict('Marinara', 'mine', { text: 'Both' });
        expect(layer.get('Marinara')?.ops).toEqual([
            expect.objectContaining({ op: 'edit', identifier: 'mine', patch: { content: 'Both' } }),
        ]);
    });

    it('migrates the current customisations into the layer (Q23) and reproduces them', async () => {
        const layer = s.start();
        const edited = baseBody();
        const main = findPrompt(edited, 'main');
        if (main) main.content = 'My main';
        edited.prompts?.push(own('mine', 'My block', { system_prompt: false }));
        edited.prompt_order?.[1]?.order.splice(2, 0, { identifier: 'mine', enabled: true });
        edited.temperature = 0.3;
        const preview = layer.planMigration?.(baseBody(), edited);
        expect(preview?.ops).toHaveLength(3);
        expect(layer.get('Marinara')).toBeNull();
        const report = await layer.migrateFrom('Marinara', baseBody(), edited);
        expect(report).toEqual({ applied: 3, conflicts: [], orphaned: [], removed: [] });
        const result = layer.apply('Marinara', baseBody()).body;
        expect(globalOrder(result)).toEqual(globalOrder(edited));
        expect(layer.strip('Marinara', result)).toEqual(baseBody());
        expect(s.env.journal.list({ module: 'M34' })).toHaveLength(1);
    });

    it('transfers the layer to another preset by anchors', async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        await layer.record('Marinara', mainEdit);
        await layer.record('Marinara', { op: 'toggle', identifier: 'nsfw', enabled: true });
        const report = await layer.transfer('Marinara', 'Other');
        expect(report.applied).toBe(2);
        expect(report.orphaned.map((op) => op.op)).toEqual(['toggle']);
        expect(report.conflicts).toEqual([
            { identifier: 'main', oldBase: 'Main text', newBase: 'Other main', mine: 'Mine' },
        ]);
        expect(layer.get('Other')?.ops[0]).toMatchObject({ anchor: { kind: 'afterText', text: '</task>' } });
        expect(await layer.transfer('Marinara', 'Marinara')).toEqual({ applied: 0, conflicts: [], orphaned: [] });
        expect(layer.apply('Nothing', baseBody()).report.applied).toBe(0);
        expect(layer.strip('Nothing', baseBody())).toEqual(baseBody());
    });
});

describe('Подготовить к отключению (P11)', () => {
    it("'reselectBase' loads the base once without the layer", async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        await s.select('Marinara');
        expect(order(s.live)).toContain('mine');
        expect(await layer.prepareDisable?.('reselectBase')).toBe('Marinara');
        expect(order(s.live)).not.toContain('mine');
        await s.select('Marinara');
        expect(order(s.live)).toContain('mine');
    });

    it("'saveMerged' saves base + layer as a normal preset and selects it", async () => {
        const store = fakeStore(s);
        const layer = s.start(store);
        await layer.record('Marinara', ownAdd);
        await s.select('Marinara');
        expect(await layer.prepareDisable?.('saveMerged')).toBe('Marinara (with layer)');
        expect(store.saveAs).toHaveBeenCalledWith('Marinara (with layer)');
        expect(store.select).toHaveBeenCalledWith('Marinara (with layer)');
        expect(order(s.live)).toContain('mine');
        expect(layer.lastReport()).toBeNull();
    });

    it("'saveMerged' without the store uses ST's explicit-body save", async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        await s.select('Marinara');
        expect(await layer.prepareDisable?.('saveMerged', 'Merged')).toBe('Merged');
        expect(s.savePreset).toHaveBeenCalledWith('Merged', expect.objectContaining({ temperature: 1 }));
        expect(s.live.preset_settings_openai).toBe('Merged');
        expect(order(s.live)).toContain('mine');
    });

    it('dispose writes pending changes, stops laying the layer and says it stays until the next change', async () => {
        const layer = s.start();
        await layer.record('Marinara', ownAdd);
        layer.dispose();
        layer.dispose();
        await flush();
        expect(readFile(s.env, s.env.app.files.fileName('preset-layer', 'Marinara'))).not.toBeNull();
        expect(s.env.ui.notices).toHaveLength(1);
        expect(s.env.ui.notices[0]?.text).toContain('until the next preset change');
        await s.select('Marinara');
        expect(order(s.live)).not.toContain('mine');
        s.env.ui.notices[0]?.options?.action?.run();
        await flush();
        expect(s.selectPreset).toHaveBeenCalled();
        expect(layer.install()).toHaveLength(7);
        expect(layer.install()).toEqual([]);
    });
});
