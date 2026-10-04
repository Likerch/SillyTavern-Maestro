import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardianModule } from '../../../src/features/guardian';
import type { GuardianApi } from '../../../src/features/guardian/api';
import { BASELINE_FILE } from '../../../src/features/guardian/baseline';
import type { BaselineFile } from '../../../src/features/guardian/baseline';
import { DRIFT_KIND, RESTORE_KIND } from '../../../src/features/guardian/service';
import type { GuardianService } from '../../../src/features/guardian/service';
import { storedJson } from '../../helpers/core-host';
import { installSettingsServer, trackedStack } from '../../helpers/guardian-env';
import type { TrackedStack } from '../../helpers/guardian-env';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

type Dict = Record<string, unknown>;

let env: FeatureEnv;
let stack: TrackedStack;
let stop: () => Promise<void>;

function service(): GuardianService {
    return env.apis.get('guardian') as GuardianService;
}

function baselineFile(): BaselineFile {
    return storedJson<BaselineFile>(env.mock, BASELINE_FILE)!;
}

function ext(key: string): Dict {
    return env.mock.extensionSettings[key] as Dict;
}

beforeEach(async () => {
    env = await createFeatureEnv();
    installSettingsServer(env);
    stack = trackedStack(env);
    env.leader.value = false;
    stop = await env.start(guardianModule);
    await flush();
});

afterEach(async () => {
    await stop();
});

describe('baseline', () => {
    it('is taken at the first start with the curated keys only', () => {
        const file = baselineFile();
        expect(file.reason).toBe('first-start');
        const values = file.values;
        expect(values['qvink.auto_summarize']).toBe(true);
        expect(values).not.toHaveProperty('qvink.profiles');
        expect(values['ck.characterRepoBooks']).toEqual(['Archive']);
        expect(values['ck.rag.enabled']).toBe(false);
        expect(values).not.toHaveProperty('ck.scannedCache');
        expect(typeof values['ck.templates']).toBe('string');
        expect(file.restore['ck.templates']).toEqual({ a: 'long template' });
        expect(values['nai.scene']).toEqual({ framing: 'auto' });
        expect(values['nai.des']).toEqual({ enabled: true });
        expect(values).not.toHaveProperty('nai.vibes');
        expect(values['des.generationMode']).toBe('together');
        expect(values['des.lorebook.enabled']).toBe(true);
        expect(values).not.toHaveProperty('des.quests');
        expect(file.restore['des.customTrackerPrompt']).toBe('A long custom prompt');
        expect(values['preset.name']).toBe('Marinara');
        expect(values['preset.order']).toEqual(['main', 'chatHistory', 'jb']);
        expect(values['preset.toggles']).toEqual({ main: true, chatHistory: true, jb: true });
        expect(values['preset.roles']).toMatchObject({ main: 'system', jb: 'system' });
        expect(Object.keys(values['preset.contents'] as Dict)).toEqual(['main', 'jb']);
        const body = (file.restore['preset.body'] as { body: Dict }).body;
        expect(body).not.toHaveProperty('proxy_password');
        expect(body).not.toHaveProperty('reverse_proxy');
        expect(values['regex.r1']).toMatchObject({ name: 'Clean HTML', disabled: false, placement: [2] });
        expect(values['worldInfo.world_info_budget']).toBe(25);
        expect(values['worldInfo.globalSelect']).toEqual(['World']);
        expect(values['profiles.list']).toEqual(['Flash#p1']);
        expect(values['extensions.disabled']).toEqual([]);
        expect(values['extensions.versions.des']).toBe('2.6.0');
        expect(JSON.stringify(file)).not.toContain('secret');
        expect(service().hasBaseline()).toBe(true);
    });

    it('is kept on the next start and replaced on demand', async () => {
        await stop();
        const before = baselineFile().takenAt;
        stop = await env.start(guardianModule);
        await flush();
        expect(baselineFile().takenAt).toBe(before);
        await service().takeBaseline('manual');
        expect(baselineFile().reason).toBe('manual');
    });
});

describe('drift and restore', () => {
    function drift(): void {
        ext('qvink_memory').auto_summarize = false;
        ext('qvink_memory').new_option = 1;
        delete ext('CarrotKernel').characterRepoBooks;
        ((env.mock.extensionSettings.regex as Dict[])[0] as Dict).disabled = true;
        stack.wi.world_info_budget = 40;
        stack.selected.push('Other');
        (stack.live.prompt_order[0]!.order as Dict[])[2]!.enabled = false;
        (stack.live.prompts[2] as Dict).role = 'assistant';
        (env.adapters.des.settings as Dict).generationMode = 'separate';
    }

    it('lists changes with their groups and what can be restored', async () => {
        drift();
        const items = await service().drift();
        const byPath = Object.fromEntries(items.map((item) => [item.path, item]));
        expect(byPath['qvink.auto_summarize']).toMatchObject({ group: 'qvink', kind: 'changed', restorable: true });
        expect(byPath['qvink.new_option']).toMatchObject({ kind: 'added', restorable: false });
        expect(byPath['ck.characterRepoBooks']).toMatchObject({ kind: 'removed', restorable: true });
        expect(byPath['regex.r1']).toMatchObject({ group: 'regex', restorable: true });
        expect(byPath['worldInfo.world_info_budget']).toMatchObject({ baseline: 25, current: 40, restorable: true });
        expect(byPath['worldInfo.globalSelect']).toMatchObject({ restorable: false });
        expect(byPath['preset.toggles']).toMatchObject({ restorable: true });
        expect(byPath['preset.roles']).toMatchObject({ restorable: true });
        expect(byPath['des.generationMode']).toMatchObject({ group: 'des', restorable: true });
    });

    it('restores, journals and undoes', async () => {
        drift();
        const paths = (await service().drift()).filter((item) => item.restorable).map((item) => item.path);
        expect(await service().restoreNow(paths)).toBe(paths.length);
        expect(ext('qvink_memory').auto_summarize).toBe(true);
        expect(ext('CarrotKernel').characterRepoBooks).toEqual(['Archive']);
        expect(((env.mock.extensionSettings.regex as Dict[])[0] as Dict).disabled).toBe(false);
        expect(stack.updateWorldInfoSettings).toHaveBeenCalledWith({ world_info_budget: 25 });
        expect((stack.live.prompt_order[0]!.order as Dict[])[2]!.enabled).toBe(true);
        expect((stack.live.prompts[2] as Dict).role).toBe('system');
        expect((env.adapters.des.settings as Dict).generationMode).toBe('together');
        expect(env.mock.extensionSettings['third-party/Dooms-Enhancement-Suite']).toBe(env.adapters.des.settings);
        expect(stack.render).toHaveBeenCalled();
        const left = await service().drift();
        expect(left.map((item) => item.path).sort()).toEqual(['qvink.new_option', 'worldInfo.globalSelect']);

        await env.journal.load();
        const record = env.journal.list({ module: 'M4' })[0]!;
        expect(record.kind).toBe(RESTORE_KIND);
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(ext('qvink_memory').auto_summarize).toBe(false);
        expect(ext('CarrotKernel')).not.toHaveProperty('characterRepoBooks');
        expect(((env.mock.extensionSettings.regex as Dict[])[0] as Dict).disabled).toBe(true);
    });

    it('restores a deleted regex and refuses to undo over newer edits', async () => {
        env.mock.extensionSettings.regex = [];
        expect(await service().restoreNow(['regex.r1'])).toBe(1);
        expect((env.mock.extensionSettings.regex as Dict[])[0]).toMatchObject({ id: 'r1', scriptName: 'Clean HTML' });
        ((env.mock.extensionSettings.regex as Dict[])[0] as Dict).scriptName = 'Renamed';
        await env.journal.load();
        const record = env.journal.list({ module: 'M4' })[0]!;
        expect(await env.journal.undo(record.id)).toBe(false);
    });

    it('restores the whole preset only after confirmation and keeps its secrets', async () => {
        stack.live.temp_openai = 0.5;
        expect((await service().drift()).map((item) => item.path)).toContain('preset.body');
        env.ui.confirmAnswer = false;
        expect(await service().restoreNow(['preset.body'])).toBe(0);
        expect(stack.savePreset).not.toHaveBeenCalled();
        env.ui.confirmAnswer = true;
        expect(await service().restoreNow(['preset.body', 'preset.contents'])).toBe(1);
        expect(stack.savePreset).toHaveBeenCalledTimes(1);
        const [name, body] = stack.savePreset.mock.calls[0]! as [string, Dict];
        expect(name).toBe('Marinara');
        expect(body.temperature).toBe(1);
        expect(body.proxy_password).toBe('file-secret');
        expect(body.reverse_proxy).toBe('http://proxy');
    });

    it('selects the baseline preset by name', async () => {
        stack.live.preset_settings_openai = 'Other';
        await service().restoreNow(['preset.name']);
        expect(stack.selectPreset).toHaveBeenCalledWith('Marinara');
    });

    it('restores the prompt order', async () => {
        const order = stack.live.prompt_order[0]!.order as Dict[];
        stack.live.prompt_order[0]!.order = [order[2], order[0], order[1]];
        await service().restoreNow(['preset.order']);
        expect((stack.live.prompt_order[0]!.order as Dict[]).map((item) => item.identifier)).toEqual([
            'main',
            'chatHistory',
            'jb',
        ]);
    });

    it('acknowledges changes made on purpose', async () => {
        drift();
        const api = env.apis.get('guardian') as GuardianApi;
        await api.acknowledge(['qvink', 'preset.roles']);
        const paths = (await api.drift()).map((item) => item.path);
        expect(paths).not.toContain('qvink.auto_summarize');
        expect(paths).not.toContain('qvink.new_option');
        expect(paths).not.toContain('preset.roles');
        expect(paths).toContain('preset.toggles');
        expect(baselineFile().values['qvink.new_option']).toBe(1);
        await api.acknowledge([]);
    });

    it('exposes the tab state', () => {
        expect((env.apis.get('guardian') as GuardianApi).tabState()).toBe('fresh');
    });
});

describe('drift in the Inbox', () => {
    async function cards() {
        await env.inbox.load();
        return env.inbox.list().filter((card) => card.kind === DRIFT_KIND);
    }

    it('proposes one card per drift from the leader tab only', async () => {
        ext('qvink_memory').auto_summarize = false;
        stack.selected.push('Other');
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
        env.leader.set(true);
        await flush();
        await service().checkDrift();
        const list = await cards();
        expect(list).toHaveLength(1);
        expect(list[0]!.title).toContain('2');
        expect(list[0]!.description).toContain('Qvink · auto_summarize: was true → now false');
        expect(list[0]!.changes).toHaveLength(1);

        expect(await env.inbox.accept(list[0]!.id)).toBe(true);
        expect(ext('qvink_memory').auto_summarize).toBe(true);
        // What cannot be restored becomes the new baseline.
        expect(baselineFile().values['worldInfo.globalSelect']).toEqual(['Other', 'World']);
        expect(await service().drift()).toEqual([]);

        // The same drift coming back later is proposed again.
        ext('qvink_memory').auto_summarize = false;
        await service().checkDrift();
        expect(await cards()).toHaveLength(1);
    });

    it('does not ask again about a dismissed drift', async () => {
        env.leader.value = true;
        ext('qvink_memory').auto_summarize = false;
        await service().checkDrift();
        const [card] = await cards();
        await env.inbox.reject(card!.id);
        await flush();
        expect(baselineFile().dismissed).toHaveLength(1);
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
        // A different drift is proposed again.
        ext('qvink_memory').prompt = 'Other';
        await service().checkDrift();
        expect(await cards()).toHaveLength(1);
    });

    it('drops a card that no longer matches the settings', async () => {
        env.leader.value = true;
        ext('qvink_memory').auto_summarize = false;
        await service().checkDrift();
        ext('qvink_memory').auto_summarize = true;
        const [card] = await cards();
        expect(await env.inbox.accept(card!.id)).toBe(false);
        expect(await cards()).toHaveLength(0);
    });

    it('keeps version changes out of the Inbox', async () => {
        env.leader.value = true;
        (env.host as { version: () => string }).version = () => '1.19.1';
        expect((await service().drift()).map((item) => item.path)).toEqual(['extensions.versions.st']);
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
    });

    it('does nothing without a chat or in a group chat', async () => {
        env.leader.value = true;
        ext('qvink_memory').auto_summarize = false;
        env.group.value = true;
        await service().checkDrift();
        env.group.value = false;
        env.mock.chatId = undefined;
        await service().checkDrift();
        env.mock.chatId = 'chat-1';
        expect(await cards()).toHaveLength(0);
    });

    it('describes report-only and opaque changes', async () => {
        const items = [
            {
                path: 'regex.r1',
                kind: 'changed' as const,
                baseline: { name: 'Clean HTML' },
                current: { name: 'Clean HTML' },
            },
            { path: 'preset.order', kind: 'changed' as const, baseline: ['a'], current: ['b'] },
            { path: 'qvink.x', kind: 'added' as const, baseline: undefined, current: 1 },
            { path: 'qvink.y', kind: 'removed' as const, baseline: 1, current: undefined },
            { path: 'custom', kind: 'changed' as const, baseline: 'a'.repeat(50), current: 'b' },
        ];
        const text = service().describe(items, { values: {}, restore: {} });
        expect(text).toContain('Regex · Clean HTML: changed');
        expect(text).toContain('Preset · prompt order: changed');
        expect(text).toContain('Qvink · x: added');
        expect(text).toContain('Qvink · y: removed');
        expect(text).toContain('custom: changed');
    });
});
