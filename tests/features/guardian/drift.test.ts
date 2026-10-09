import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { valueHash } from '../../../src/domain/settings-diff';
import { guardianModule } from '../../../src/features/guardian';
import type { GuardianApi } from '../../../src/features/guardian/api';
import { BASELINE_FILE } from '../../../src/features/guardian/baseline';
import type { BaselineFile } from '../../../src/features/guardian/baseline';
import { DRIFT_KIND, RESTORE_KIND } from '../../../src/features/guardian/service';
import type { GuardianService } from '../../../src/features/guardian/service';
import { inScope } from '../../../src/features/guardian/tracked';
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

function nai(section: string): Dict {
    return ext('nai_studio')[section] as Dict;
}

function qvinkProfiles(): Record<string, Dict> {
    return ext('qvink_memory').profiles as Record<string, Dict>;
}

async function driftPaths(): Promise<string[]> {
    return (await service().drift()).map((item) => item.path);
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
    it('is taken at the first start with system settings only', () => {
        const file = baselineFile();
        expect(file.schema).toBe(2);
        expect(file.reason).toBe('first-start');
        const values = file.values;
        // Qvink: the saved profiles and its global switch, never the live copy of the chat's profile.
        expect(typeof values['qvink.profiles.Default']).toBe('string');
        expect(file.restore['qvink.profiles.Default']).toEqual({ auto_summarize: true, prompt: 'Summarise' });
        expect(values).toHaveProperty('qvink.profiles.Short');
        expect(values['qvink.notify_on_profile_switch']).toBe(false);
        for (const key of ['auto_summarize', 'prompt', 'profile', 'global_toggle_state', 'character_profiles'])
            expect(values).not.toHaveProperty(`qvink.${key}`);
        expect(values['ck.enabled']).toBe(true);
        expect(values['ck.rag.enabled']).toBe(false);
        expect(typeof values['ck.templates']).toBe('string');
        expect(file.restore['ck.templates']).toEqual({ a: 'long template' });
        expect(values['nai.generation']).toEqual({ model: 'nai-diffusion-4-5-full', steps: 23 });
        expect(file.restore['nai.prompts']).toEqual({ prefix: 'best quality' });
        expect(values['nai.inline']).toEqual({ saveToServer: true });
        expect(values['nai.scene']).toEqual({ allowNsfw: false });
        expect(values['nai.des']).toEqual({ enabled: true });
        expect(values['des.generationMode']).toBe('together');
        expect(values['des.lorebook.enabled']).toBe(true);
        expect(values['des.externalApiSettings']).toEqual({ model: 'small', maxTokens: 8192 });
        expect(file.restore['des.customTrackerPrompt']).toBe('A long custom prompt');
        expect(values['preset.name']).toBe('Marinara');
        expect(values['preset.order']).toEqual(['main', 'chatHistory', 'jb']);
        expect(values['preset.toggles']).toEqual({ main: true, chatHistory: true, jb: true });
        expect(values['preset.roles']).toMatchObject({ main: 'system', jb: 'system' });
        expect(Object.keys(values['preset.contents'] as Dict)).toEqual(['main', 'jb']);
        const body = (file.restore['preset.body'] as { body: Dict }).body;
        expect(body).not.toHaveProperty('proxy_password');
        expect(body).not.toHaveProperty('reverse_proxy');
        // The body keeps the connection for restore; its hash leaves it to the api.* paths.
        expect(body.deepseek_model).toBe('deepseek-v4-flash');
        expect(values['regex.r1']).toMatchObject({ name: 'Clean HTML', disabled: false, placement: [2] });
        expect(values['worldInfo.world_info_budget']).toBe(25);
        expect(values['profiles.list']).toEqual(['Flash#p1']);
        expect(values['extensions.disabled']).toEqual([]);
        expect(values['extensions.versions.des']).toBe('2.6.0');
        expect(values).toMatchObject({
            'api.mainApi': 'openai',
            'api.profile': 'Flash',
            'api.model': 'deepseek-v4-flash (deepseek)',
            'api.maxContext': 65536,
            'api.maxTokens': 300,
            'api.reasoningEffort': 'auto',
            'api.showThoughts': true,
            'api.stream': true,
            'api.reasoningTemplate': 'DeepSeek',
            'api.reasoningParse': true,
            'api.reasoningAddToPrompts': false,
        });
        // Text Completion templates matter only there.
        expect(values).not.toHaveProperty('api.context');
        expect(JSON.stringify(file)).not.toContain('secret');
        expect(JSON.stringify(file)).not.toContain('sk-tracker');
        expect(service().hasBaseline()).toBe(true);
    });

    it('never holds content or play state', () => {
        const file = baselineFile();
        for (const path of Object.keys(file.values)) expect(inScope(path), path).toBe(true);
        for (const path of Object.keys(file.restore)) expect(inScope(path), path).toBe(true);
        const text = JSON.stringify(file);
        for (const word of ['globalSelect', 'selectedLorebooks', 'characterRepoBooks', 'tagLibraries'])
            expect(text).not.toContain(word);
        for (const word of ['activeStyle', 'legacyPortraits', 'insertMode', 'framing', 'personaPassports'])
            expect(text).not.toContain(word);
        for (const word of ['historyPersistence', 'quests', 'Find the key', 'a cat', 'scannedCache'])
            expect(text).not.toContain(word);
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

    it('collects Text Completion templates there', async () => {
        env.chatCompletion.value = false;
        (env.mock.context as unknown as Dict).mainApi = 'textgenerationwebui';
        const power = (env.mock.context as unknown as Dict).powerUserSettings as Record<string, Dict>;
        power.instruct!.enabled = true;
        await service().takeBaseline('manual');
        const values = baselineFile().values;
        expect(values).toMatchObject({
            'api.mainApi': 'textgenerationwebui',
            'api.instruct': 'Alpaca',
            'api.context': 'Default',
            'api.sysprompt': 'Neutral - Chat',
            'api.reasoningTemplate': 'DeepSeek',
        });
        expect(values).not.toHaveProperty('api.model');
        expect(values).not.toHaveProperty('preset.body');
        power.sysprompt!.enabled = false;
        power.instruct!.preset = 'ChatML';
        const items = await service().drift();
        expect(items.map((item) => [item.path, item.kind, item.restorable])).toEqual([
            ['api.instruct', 'changed', false],
            ['api.sysprompt', 'removed', false],
        ]);
        expect(service().label(items[0]!)).toBe('Connection · instruct template');
    });
});

describe('scope', () => {
    it('defines system settings', () => {
        for (const path of [
            'preset.body',
            'api.model',
            'api.maxTokens',
            'regex.r1',
            'worldInfo.world_info_budget',
            'qvink.profiles.Default',
            'qvink.profiles.My.Profile',
            'qvink.notify_on_profile_switch',
            'ck.rag.enabled',
            'nai.markers',
            'des.generationMode',
            'profiles.list',
            'extensions.versions.st',
        ])
            expect(inScope(path), path).toBe(true);
        for (const path of [
            'worldInfo.globalSelect',
            'ck.selectedLorebooks',
            'ck.characterRepoBooks',
            'ck.tagLibraries',
            'qvink.auto_summarize',
            'qvink.profile',
            'qvink.global_toggle_state',
            'qvink.profiles',
            'des.historyPersistence',
            'des.quests',
            'nai.vibes',
            'api.secret',
            'regex',
            'preset.unknown',
        ])
            expect(inScope(path), path).toBe(false);
    });

    it('ignores lorebooks, chat switches and panel choices', async () => {
        // Lore Studio and DES campaigns switch global lorebooks; CK fills its own book lists.
        stack.selected.push('Other');
        (ext('CarrotKernel').selectedLorebooks as string[]).push('Another pack');
        ext('CarrotKernel').characterRepoBooks = ['Archive', 'Kai'];
        ext('CarrotKernel').tagLibraries = [];
        // Qvink's auto_load_profile on a chat switch: Object.assign of another profile over the live settings.
        const qvink = ext('qvink_memory');
        Object.assign(qvink, structuredClone(qvinkProfiles().Short));
        qvink.profile = 'Short';
        qvink.global_toggle_state = false;
        qvink.character_profiles = { 'kai.png': 'Short' };
        qvink.disabled_group_characters = { g1: ['kai.png'] };
        qvink.memory_edit_interface_settings = { filter: 'all' };
        // NAI Studio's panel: another style, a typed prompt, the composer's last choices, portraits.
        nai('prompts').activeStyle = 'Watercolor';
        nai('prompts').characterPrompts = { kai: { positive: 'red hair', negative: '' } };
        nai('generation').prompt = 'a dog';
        nai('generation').ucPreset = 'light';
        nai('generation').seed = 42;
        nai('scene').framing = 'close-up';
        nai('scene').camera = 'side';
        nai('inline').insertMode = 'you';
        nai('inline').readingMode = true;
        nai('des').legacyPortraits = { Kai: 'kai-2.png' };
        // DES loads the character's tracker preset; quests change every turn.
        const des = env.adapters.des.settings as Dict;
        des.historyPersistence = { enabled: true, messageCount: 3 };
        des.quests = { main: 'Run' };
        expect(await service().drift()).toEqual([]);
    });
});

describe('drift and restore', () => {
    function drift(): void {
        qvinkProfiles().Default!.auto_summarize = false;
        qvinkProfiles().New = { auto_summarize: true, prompt: 'New' };
        ext('qvink_memory').notify_on_profile_switch = true;
        delete ext('CarrotKernel').templates;
        ((env.mock.extensionSettings.regex as Dict[])[0] as Dict).disabled = true;
        stack.wi.world_info_budget = 40;
        stack.selected.push('Other');
        (stack.live.prompt_order[0]!.order as Dict[])[2]!.enabled = false;
        (stack.live.prompts[2] as Dict).role = 'assistant';
        (env.adapters.des.settings as Dict).generationMode = 'separate';
        stack.live.openai_max_tokens = 500;
    }

    it('lists changes with their groups and what can be restored', async () => {
        drift();
        const items = await service().drift();
        const byPath = Object.fromEntries(items.map((item) => [item.path, item]));
        expect(byPath['qvink.profiles.Default']).toMatchObject({ group: 'qvink', kind: 'changed', restorable: true });
        expect(byPath['qvink.profiles.New']).toMatchObject({ kind: 'added', restorable: false });
        expect(byPath['qvink.notify_on_profile_switch']).toMatchObject({ kind: 'changed', restorable: true });
        expect(byPath['ck.templates']).toMatchObject({ kind: 'removed', restorable: true });
        expect(byPath['regex.r1']).toMatchObject({ group: 'regex', restorable: true });
        expect(byPath['worldInfo.world_info_budget']).toMatchObject({ baseline: 25, current: 40, restorable: true });
        expect(byPath['preset.toggles']).toMatchObject({ restorable: true });
        expect(byPath['preset.roles']).toMatchObject({ restorable: true });
        expect(byPath['des.generationMode']).toMatchObject({ group: 'des', restorable: true });
        expect(byPath['api.maxTokens']).toMatchObject({ group: 'api', baseline: 300, current: 500, restorable: true });
        // The reply length has its own readable line: the preset body hash does not change with it.
        expect(byPath).not.toHaveProperty('preset.body');
        expect(byPath).not.toHaveProperty('worldInfo.globalSelect');
    });

    it('restores, journals and undoes', async () => {
        drift();
        // The live Qvink settings follow the active profile.
        ext('qvink_memory').auto_summarize = false;
        const paths = (await service().drift()).filter((item) => item.restorable).map((item) => item.path);
        expect(await service().restoreNow(paths)).toBe(paths.length);
        expect(qvinkProfiles().Default!.auto_summarize).toBe(true);
        // Default is the active profile: it is loaded into the live settings at once.
        expect(ext('qvink_memory').auto_summarize).toBe(true);
        expect(ext('qvink_memory').profile).toBe('Default');
        expect(ext('qvink_memory').notify_on_profile_switch).toBe(false);
        expect(ext('CarrotKernel').templates).toEqual({ a: 'long template' });
        expect(((env.mock.extensionSettings.regex as Dict[])[0] as Dict).disabled).toBe(false);
        expect(stack.updateWorldInfoSettings).toHaveBeenCalledWith({ world_info_budget: 25 });
        expect((stack.live.prompt_order[0]!.order as Dict[])[2]!.enabled).toBe(true);
        expect((stack.live.prompts[2] as Dict).role).toBe('system');
        expect((env.adapters.des.settings as Dict).generationMode).toBe('together');
        expect(env.mock.extensionSettings['third-party/Dooms-Enhancement-Suite']).toBe(env.adapters.des.settings);
        expect(stack.live.openai_max_tokens).toBe(300);
        expect(stack.render).toHaveBeenCalled();
        expect(stack.savePreset).not.toHaveBeenCalled();
        expect(await driftPaths()).toEqual(['qvink.profiles.New']);

        await env.journal.load();
        const record = env.journal.list({ module: 'M4' })[0]!;
        expect(record.kind).toBe(RESTORE_KIND);
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(qvinkProfiles().Default!.auto_summarize).toBe(false);
        expect(ext('CarrotKernel')).not.toHaveProperty('templates');
        expect(((env.mock.extensionSettings.regex as Dict[])[0] as Dict).disabled).toBe(true);
        expect(stack.live.openai_max_tokens).toBe(500);
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

    it('restores a deleted Qvink profile without touching the active one', async () => {
        delete qvinkProfiles().Short;
        expect(await driftPaths()).toEqual(['qvink.profiles.Short']);
        expect(await service().restoreNow(['qvink.profiles.Short'])).toBe(1);
        expect(qvinkProfiles().Short).toEqual({ auto_summarize: false, prompt: 'Brief' });
        expect(ext('qvink_memory').auto_summarize).toBe(true);
    });

    it('restores the whole preset only after confirmation and keeps its secrets', async () => {
        stack.live.temp_openai = 0.5;
        expect(await driftPaths()).toEqual(['preset.body']);
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

    it('names the model in words and puts it back with the whole preset', async () => {
        stack.live.deepseek_model = 'deepseek-v4-pro';
        const items = await service().drift();
        expect(items).toEqual([
            {
                path: 'api.model',
                group: 'api',
                kind: 'changed',
                baseline: 'deepseek-v4-flash (deepseek)',
                current: 'deepseek-v4-pro (deepseek)',
                restorable: true,
            },
        ]);
        expect(service().label(items[0]!)).toBe('Connection · source and model');
        expect(service().describe(await detailEntries(), baselineFile())).toBe(
            '• Connection · source and model: was «deepseek-v4-flash (deepseek)» → now «deepseek-v4-pro (deepseek)»',
        );
        expect(await service().restoreNow(['api.model'])).toBe(1);
        const [name, body] = stack.savePreset.mock.calls[0]! as [string, Dict];
        expect(name).toBe('Marinara');
        expect(body).toMatchObject({ chat_completion_source: 'deepseek', deepseek_model: 'deepseek-v4-flash' });
    });

    it('reports the connection profile and API type without restoring them', async () => {
        const manager = ext('connectionManager');
        (manager.profiles as Dict[]).push({ id: 'p2', name: 'Pro' });
        manager.selectedProfile = 'p2';
        const items = await service().drift();
        expect(items.find((item) => item.path === 'api.profile')).toMatchObject({
            baseline: 'Flash',
            current: 'Pro',
            restorable: false,
        });
        expect(items.find((item) => item.path === 'profiles.list')).toMatchObject({ restorable: false });
        expect(await service().restoreNow(['api.profile'])).toBe(0);
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
        let paths = await driftPaths();
        expect(paths).not.toContain('qvink.profiles.Default');
        expect(paths).not.toContain('qvink.profiles.New');
        expect(paths).not.toContain('preset.roles');
        expect(paths).toContain('preset.toggles');
        expect(baselineFile().values).toHaveProperty('qvink.profiles.New');
        // The preset body carries the connection: acknowledging it covers the reply length too.
        await api.acknowledge(['preset.body']);
        paths = await driftPaths();
        expect(paths).not.toContain('api.maxTokens');
        expect(paths).toContain('preset.toggles');
        // Paths outside the scope change nothing.
        const before = baselineFile();
        await api.acknowledge(['worldInfo.globalSelect', 'qvink.auto_summarize']);
        expect(baselineFile()).toEqual(before);
        await api.acknowledge([]);
    });

    it('exposes the tab state', () => {
        expect((env.apis.get('guardian') as GuardianApi).tabState()).toBe('fresh');
    });
});

async function detailEntries() {
    return (await service().detail(true)).entries;
}

describe('baseline from M4 before the scope (schema 1)', () => {
    /** The file M4 1.x wrote for the same settings: no api.* or Qvink profiles, content paths, old hashes. */
    function schemaOne(): Dict {
        const file = baselineFile();
        const keep = (path: string) => !path.startsWith('api.') && !path.startsWith('qvink.profiles.');
        const values = Object.fromEntries(Object.entries(file.values).filter(([path]) => keep(path)));
        const restore = Object.fromEntries(Object.entries(file.restore).filter(([path]) => keep(path)));
        Object.assign(values, {
            'worldInfo.globalSelect': ['World'],
            'ck.selectedLorebooks': ['Pack'],
            'ck.characterRepoBooks': ['Archive'],
            'qvink.auto_summarize': true,
            'qvink.prompt': 'Summarise',
            'qvink.profile': 'Default',
            'qvink.global_toggle_state': true,
            'des.historyPersistence': { enabled: false, messageCount: 5 },
            'des.externalApiSettings': { baseUrl: 'http://tracker', apiKey: 'sk-old', model: 'small', maxTokens: 8192 },
            'nai.des': { enabled: true, legacyPortraits: { Kai: 'kai.png' } },
            'nai.scene': { allowNsfw: false, framing: 'auto', camera: 'front' },
        });
        // 1.x hashed the whole body (with the connection) and NAI's prompts with the picked style.
        const rest = { ...(restore['preset.body'] as { body: Dict }).body };
        delete rest.prompts;
        delete rest.prompt_order;
        values['preset.body'] = valueHash(rest);
        const prompts = { ...(restore['nai.prompts'] as Dict), activeStyle: 'Ink', styles: [{ name: 'Ink' }] };
        restore['nai.prompts'] = prompts;
        values['nai.prompts'] = valueHash(prompts);
        return { schema: 1, takenAt: 123, reason: 'wizard', values, restore, dismissed: ['old-hash'] };
    }

    async function restart(file: Dict): Promise<void> {
        await stop();
        env.mock.files.set(BASELINE_FILE, JSON.stringify(file));
        stop = await env.start(guardianModule);
        await flush();
    }

    it('is migrated to system settings, takes the new paths silently and shows no drift', async () => {
        const old = schemaOne();
        expect((old.values as Dict)['preset.body']).not.toBe(baselineFile().values['preset.body']);
        await restart(old);
        const file = baselineFile();
        expect(file).toMatchObject({ schema: 2, takenAt: 123, reason: 'wizard', dismissed: [] });
        expect(file).not.toHaveProperty('adoptMissing');
        for (const path of Object.keys(file.values)) expect(inScope(path), path).toBe(true);
        expect(file.values['des.externalApiSettings']).toEqual({ model: 'small', maxTokens: 8192 });
        expect(JSON.stringify(file)).not.toContain('sk-old');
        expect(file.values['api.model']).toBe('deepseek-v4-flash (deepseek)');
        expect(file.restore['qvink.profiles.Short']).toEqual({ auto_summarize: false, prompt: 'Brief' });
        expect(await service().drift()).toEqual([]);
    });

    it('keeps a real change recorded in the old file', async () => {
        const old = schemaOne();
        (old.values as Dict)['worldInfo.world_info_budget'] = 30;
        await restart(old);
        expect(await service().drift()).toEqual([
            expect.objectContaining({ path: 'worldInfo.world_info_budget', baseline: 30, current: 25 }),
        ]);
    });

    it('does not take a later change of a new path into the baseline', async () => {
        await restart(schemaOne());
        stack.live.openai_max_tokens = 800;
        expect(await driftPaths()).toEqual(['api.maxTokens']);
    });
});

describe('drift in the Inbox', () => {
    async function cards() {
        await env.inbox.load();
        return env.inbox.list().filter((card) => card.kind === DRIFT_KIND);
    }

    it('proposes one card per drift from the leader tab only', async () => {
        stack.wi.world_info_budget = 40;
        qvinkProfiles().New = { auto_summarize: true };
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
        env.leader.set(true);
        await flush();
        await service().checkDrift();
        const list = await cards();
        expect(list).toHaveLength(1);
        expect(list[0]!.title).toBe('2 settings changed since the baseline — put them back?');
        // The card says where in words; setting keys and raw values are under «Подробнее».
        expect(list[0]!.description).toContain(
            'by an update: Qvink · profile "New", Lorebook settings · budget (% of context).',
        );
        expect(list[0]!.description).not.toContain('world_info_budget');
        expect(list[0]!.details).toContain('Lorebook settings · budget (% of context): was 25 → now 40');
        expect(list[0]!.details).toContain('Qvink · profile "New": added');
        expect(list[0]!.changes).toHaveLength(1);

        expect(await env.inbox.accept(list[0]!.id)).toBe(true);
        expect(stack.wi.world_info_budget).toBe(25);
        // What cannot be restored becomes the new baseline.
        expect(baselineFile().values).toHaveProperty('qvink.profiles.New');
        expect(await service().drift()).toEqual([]);

        // The same drift coming back later is proposed again.
        stack.wi.world_info_budget = 40;
        await service().checkDrift();
        expect(await cards()).toHaveLength(1);
    });

    it('does not ask again about a dismissed drift', async () => {
        env.leader.value = true;
        stack.wi.world_info_budget = 40;
        await service().checkDrift();
        const [card] = await cards();
        await env.inbox.reject(card!.id);
        await flush();
        expect(baselineFile().dismissed).toHaveLength(1);
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
        // A different drift is proposed again.
        stack.wi.world_info_depth = 5;
        await service().checkDrift();
        expect(await cards()).toHaveLength(1);
    });

    it('drops a card that no longer matches the settings', async () => {
        env.leader.value = true;
        stack.wi.world_info_budget = 40;
        await service().checkDrift();
        stack.wi.world_info_budget = 25;
        const [card] = await cards();
        expect(await env.inbox.accept(card!.id)).toBe(false);
        expect(await cards()).toHaveLength(0);
    });

    it('does not bother about lorebooks or a chat switch', async () => {
        env.leader.value = true;
        stack.selected.push('Other');
        Object.assign(ext('qvink_memory'), structuredClone(qvinkProfiles().Short), { profile: 'Short' });
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
    });

    it('keeps version changes out of the Inbox', async () => {
        env.leader.value = true;
        (env.host as { version: () => string }).version = () => '1.19.1';
        expect(await driftPaths()).toEqual(['extensions.versions.st']);
        await service().checkDrift();
        expect(await cards()).toHaveLength(0);
    });

    it('does nothing without a chat or in a group chat', async () => {
        env.leader.value = true;
        stack.wi.world_info_budget = 40;
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
            { path: 'qvink.profiles.Default', kind: 'changed' as const, baseline: 'h1', current: 'h2' },
            { path: 'api.maxContext', kind: 'changed' as const, baseline: 65536, current: 32768 },
            { path: 'extensions.versions.des', kind: 'changed' as const, baseline: '2.6.0', current: '2.7.0' },
            { path: 'custom', kind: 'changed' as const, baseline: 'a'.repeat(70), current: 'b' },
        ];
        const text = service().describe(items, { values: {}, restore: { 'qvink.profiles.Default': {} } });
        expect(text).toContain('Regex · Clean HTML: changed');
        expect(text).toContain('Preset · prompt order: changed');
        expect(text).toContain('Qvink · x: added');
        expect(text).toContain('Qvink · y: removed');
        expect(text).toContain('Qvink · profile "Default": changed');
        expect(text).toContain('Connection · context size: was 65536 → now 32768');
        expect(text).toContain('Extensions · version of des: was «2.6.0» → now «2.7.0»');
        expect(text).toContain('custom: changed');
        // In words: named settings, other settings by their extension only, each once.
        expect(service().where(items)).toBe(
            'Regex · Clean HTML, Preset · prompt order, Qvink, Qvink · profile "Default", Connection · context size, Extensions, custom',
        );
    });
});
