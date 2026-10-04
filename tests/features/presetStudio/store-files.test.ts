// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFetchGate } from '../../../src/host/fetch-gate';
import type { FetchTarget } from '../../../src/host/fetch-gate';
import { FILE_TARGET } from '../../../src/features/presetStudio/store';
import { createStoreEnv, ev, eventNames, versionsFile } from './helpers-store';
import type { StoreEnv } from './helpers-store';

type Dict = Record<string, unknown>;

let stand: StoreEnv;

beforeEach(async () => {
    stand = await createStoreEnv();
});

afterEach(async () => {
    await stand.stop();
});

function noForbiddenCalls(): void {
    expect(stand.manager.savePreset).not.toHaveBeenCalled();
    expect(stand.manager.updatePreset).not.toHaveBeenCalled();
    expect(stand.manager.renamePreset).not.toHaveBeenCalled();
    expect(stand.manager.deletePreset).not.toHaveBeenCalled();
    expect(stand.eventSavePreset).not.toHaveBeenCalled();
}

function options(): string[][] {
    return [...stand.select.options].map((option) => [option.value, option.text]);
}

function ext(): Dict {
    return stand.env.mock.extensionSettings;
}

describe('save', () => {
    it('posts an explicit body: working copy over the cached body, unknown keys and extension sub-keys kept', async () => {
        const cachedEntry = stand.cache.list[0];
        await stand.store.setKeys({ temperature: 0.4 });
        await stand.store.updatePrompt('style', { content: 'Sharper.' });
        // Another extension wrote its field into the file only (writePresetExtensionField for another name).
        ((stand.cache.list[0] as Dict).extensions as Dict).late_ext = { x: 1 };
        await stand.store.save();
        const request = stand.server.saves.at(-1)!;
        expect(request.apiId).toBe('openai');
        expect(request.name).toBe('Marinara');
        expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
        const preset = request.preset;
        expect(preset.temperature).toBe(0.4);
        expect(preset).not.toHaveProperty('temp_openai');
        expect(preset.marinara_version).toBe('7.2');
        expect(preset.extensions).toEqual({
            regex_scripts: [{ id: 'r1', scriptName: 'Strip' }],
            other_ext: { keep: true },
            late_ext: { x: 1 },
        });
        expect((preset.prompts as Dict[]).find((prompt) => prompt.identifier === 'style')!.content).toBe('Sharper.');
        // ST's cache: same object, now equal to the file; no `change`, no events.
        expect(stand.cache.list[0]).toBe(cachedEntry);
        expect(stand.cache.list[0]).toEqual(stand.server.files.get('Marinara'));
        expect(eventNames(stand)).not.toContain(ev('OAI_PRESET_CHANGED_BEFORE'));
        expect(stand.store.draft().dirty).toBe(false);
        expect(stand.acknowledge).toHaveBeenCalledWith(['preset']);
        noForbiddenCalls();
    });

    it('records the state before and after as versions and journals the save with undo', async () => {
        await stand.store.setKeys({ temperature: 0.4 });
        await stand.store.save(undefined, 'Cooler');
        const versions = await stand.store.versions('Marinara');
        expect(versions.map((version) => [version.by, version.summary])).toEqual([
            ['user', 'Cooler'],
            ['st', 'First snapshot'],
        ]);
        expect(versions[0]!.body).not.toHaveProperty('proxy_password');
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        expect(record.kind).toBe('presetStudio.save');
        expect(record.changes[0]!.target).toBe(FILE_TARGET);
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect(stand.server.files.get('Marinara')!.temperature).toBe(1);
        // Secrets of the file are kept by the undo (versions never store them).
        expect(stand.server.files.get('Marinara')!.proxy_password).toBe('secret');
        expect((stand.cache.list[0] as Dict).temperature).toBe(1);
        // The working copy keeps the edit: it is a draft again.
        expect(stand.store.draft().changedKeys).toContain('temperature');
    });

    it('goes through window.fetch: a save the tab guard vetoes throws and leaves the cache alone', async () => {
        const gate = createFetchGate(stand.env.app.log, globalThis as unknown as FetchTarget);
        gate.install();
        const off = gate.beforeRequest(/\/api\/presets\/save/, () => new Response('stale', { status: 409 }));
        try {
            await stand.store.setKeys({ temperature: 0.4 });
            await expect(stand.store.save()).rejects.toMatchObject({ code: 'http', status: 409 });
            expect((stand.cache.list[0] as Dict).temperature).toBe(1);
            expect(stand.acknowledge).not.toHaveBeenCalled();
        } finally {
            off();
            gate.dispose();
        }
    });

    it('does not save while a generation runs (P-084)', async () => {
        stand.generating.value = true;
        await expect(stand.store.save()).rejects.toMatchObject({ code: 'busy' });
        expect(stand.server.saves).toHaveLength(0);
    });
});

describe('saveAs', () => {
    it('adds the new name to the cache and the list, then selects it through ST', async () => {
        await stand.store.setKeys({ temperature: 0.3 });
        const name = await stand.store.saveAs('My: copy');
        expect(name).toBe('My copy');
        expect(stand.cache.names['My copy']).toBe(2);
        expect(stand.cache.list[2]).toEqual(stand.server.files.get('My copy'));
        expect(options()).toEqual([
            ['0', 'Marinara'],
            ['1', 'Other'],
            ['2', 'My copy'],
        ]);
        expect(stand.store.current()).toBe('My copy');
        expect(stand.manager.selectPreset).toHaveBeenCalledWith('2');
        expect(eventNames(stand)).toEqual(
            expect.arrayContaining([ev('OAI_PRESET_CHANGED_BEFORE'), ev('OAI_PRESET_CHANGED_AFTER'), 'PRESET_CHANGED']),
        );
        expect(stand.store.names()).toEqual(['Marinara', 'Other', 'My copy']);
        expect(stand.store.draft().dirty).toBe(false);
        // Unknown keys of the source travel with the copy; the source file is untouched.
        expect(stand.server.files.get('My copy')!.marinara_version).toBe('7.2');
        expect(stand.server.files.get('Marinara')!.temperature).toBe(1);
        // No draft snapshot of the source for the store's own switch.
        expect(versionsFile(stand, 'Marinara')).toBeUndefined();
        noForbiddenCalls();
    });

    it('refuses a name that differs from an existing one only by case', async () => {
        await expect(stand.store.saveAs('marinara')).rejects.toMatchObject({ code: 'exists' });
        await expect(stand.store.saveAs('  ')).rejects.toMatchObject({ code: 'invalid' });
    });

    it('undo of a created copy deletes it and goes back to the preset it came from', async () => {
        await stand.store.saveAs('Copy');
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect(stand.store.names()).toEqual(['Marinara', 'Other']);
        expect(stand.server.files.has('Copy')).toBe(false);
        expect(stand.store.current()).toBe('Marinara');
    });
});

describe('rename', () => {
    beforeEach(() => {
        ext().preset_allowed_regex = { openai: ['Marinara'] };
        ext().connectionManager = {
            profiles: [
                { id: 'p1', name: 'Flash', mode: 'cc', preset: 'Marinara' },
                { id: 'p2', name: 'Pro', mode: 'cc', preset: 'Other' },
                { id: 'p3', name: 'Local', mode: 'tc', preset: 'Marinara' },
            ],
        };
    });

    it('moves the file, the cache slot, the list entry, profiles (asked) and regex permission; keeps the draft', async () => {
        await stand.store.setKeys({ temperature: 0.2 });
        const from = stand.events.length;
        await stand.store.rename('Marinara', 'Marinara v8');
        // File: saved body (not the working copy) under the new name, old file deleted.
        expect(stand.server.files.get('Marinara v8')!.temperature).toBe(1);
        expect(stand.server.files.get('Marinara v8')!.marinara_version).toBe('7.2');
        expect(stand.server.files.has('Marinara')).toBe(false);
        // Cache and list: same slot, new name; still current, without re-applying.
        expect(stand.cache.names).toEqual({ 'Marinara v8': 0, Other: 1 });
        expect(options()[0]).toEqual(['0', 'Marinara v8']);
        expect(stand.store.current()).toBe('Marinara v8');
        expect(stand.store.draft().changedKeys).toEqual(['temperature']);
        // ST's events like PresetManager's rename, but no apply.
        expect(eventNames(stand, from)).toEqual(['PRESET_RENAMED_BEFORE', 'PRESET_RENAMED', 'PRESET_CHANGED']);
        expect(stand.events[from]!.data).toEqual({ apiId: 'openai', oldName: 'Marinara', newName: 'Marinara v8' });
        // Neighbours: profiles asked about and moved; the Text Completion profile is left alone.
        expect(stand.env.ui.confirms[0]!.body).toContain('«Flash»');
        const profiles = (ext().connectionManager as Dict).profiles as Dict[];
        expect(profiles.map((profile) => profile.preset)).toEqual(['Marinara v8', 'Other', 'Marinara']);
        expect(ext().preset_allowed_regex).toEqual({ openai: ['Marinara v8'] });
        expect(stand.acknowledge).toHaveBeenCalledWith(['preset']);
        noForbiddenCalls();
    });

    it('moves the regex permission itself when the regex extension is not there', async () => {
        await stand.stop();
        stand = await createStoreEnv({ regexExtension: false });
        ext().preset_allowed_regex = { openai: ['Other', 'Marinara'] };
        const storage = new Map<string, string>([['AlertRegex_openai_Marinara', 'true']]);
        (stand.env.mock.context as unknown as Dict).accountStorage = {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        };
        await stand.store.rename('Marinara', 'Renamed');
        expect(ext().preset_allowed_regex).toEqual({ openai: ['Other', 'Renamed'] });
        expect([...storage.keys()]).toEqual(['AlertRegex_openai_Renamed']);
    });

    it('leaves profiles when the user declines and says so', async () => {
        stand.env.ui.confirmAnswer = false;
        await stand.store.rename('Marinara', 'New');
        const profiles = (ext().connectionManager as Dict).profiles as Dict[];
        expect(profiles[0]!.preset).toBe('Marinara');
        expect(stand.env.ui.notices.at(-1)!.text).toContain('«Flash»');
    });

    it('takes the versions along', async () => {
        await stand.store.save();
        const oldFile = stand.store.history.fileName('Marinara');
        await stand.store.rename('Marinara', 'Moved');
        expect(stand.env.mock.files.has(oldFile)).toBe(false);
        expect((await stand.store.versions('Moved')).length).toBe(2);
        expect(versionsFile(stand, 'Moved')!.name).toBe('Moved');
    });

    it('renames a preset that is not current without touching the working copy', async () => {
        await stand.store.rename('Other', 'Other 2');
        expect(stand.store.current()).toBe('Marinara');
        expect(stand.store.names()).toEqual(['Marinara', 'Other 2']);
        expect(eventNames(stand)).not.toContain('PRESET_CHANGED');
    });

    it('refuses the same name (case, accents), an existing name and a missing preset', async () => {
        await expect(stand.store.rename('Marinara', 'MARINARA')).rejects.toMatchObject({ code: 'invalid' });
        await expect(stand.store.rename('Marinara', 'other')).rejects.toMatchObject({ code: 'exists' });
        await expect(stand.store.rename('Nope', 'X')).rejects.toMatchObject({ code: 'not-found' });
        await expect(stand.store.rename('Marinara', '???')).rejects.toMatchObject({ code: 'invalid' });
    });

    it('is undone with the profiles it moved', async () => {
        await stand.store.rename('Marinara', 'Tmp');
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect(stand.store.names()).toEqual(['Marinara', 'Other']);
        expect(stand.store.current()).toBe('Marinara');
        const profiles = (ext().connectionManager as Dict).profiles as Dict[];
        expect(profiles[0]!.preset).toBe('Marinara');
        expect(stand.server.files.has('Tmp')).toBe(false);
    });
});

describe('remove', () => {
    it('deletes the current preset like ST: first remaining applied, file deleted, PRESET_DELETED; links reported', async () => {
        ext().preset_allowed_regex = { openai: ['Marinara'] };
        ext().connectionManager = { profiles: [{ id: 'p1', name: 'Flash', mode: 'cc', preset: 'Marinara' }] };
        const from = stand.events.length;
        await stand.store.remove('Marinara');
        expect(stand.server.files.has('Marinara')).toBe(false);
        expect(stand.cache.names).toEqual({ Other: 1 });
        expect(options()).toEqual([['1', 'Other']]);
        expect(stand.store.current()).toBe('Other');
        expect(stand.oai.temp_openai).toBe(0.7);
        expect(eventNames(stand, from)).toEqual(
            expect.arrayContaining([ev('OAI_PRESET_CHANGED_BEFORE'), ev('OAI_PRESET_CHANGED_AFTER'), 'PRESET_DELETED']),
        );
        // Profiles are reported, not changed; ST's regex extension dropped the permission on PRESET_DELETED.
        const profiles = (ext().connectionManager as Dict).profiles as Dict[];
        expect(profiles[0]!.preset).toBe('Marinara');
        const notices = stand.env.ui.notices.map((notice) => notice.text);
        expect(notices.some((text) => text.includes('«Flash»'))).toBe(true);
        expect(notices.some((text) => text.includes('Regex'))).toBe(true);
        // Versions stay (P-182).
        expect((await stand.store.versions('Marinara')).length).toBe(1);
        noForbiddenCalls();
    });

    it('is undone: the preset comes back with its secrets and regex permission', async () => {
        ext().preset_allowed_regex = { openai: ['Marinara'] };
        await stand.store.remove('Marinara');
        expect(ext().preset_allowed_regex).toEqual({ openai: [] });
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect(stand.store.names()).toContain('Marinara');
        expect(stand.server.files.get('Marinara')!.proxy_password).toBe('secret');
        expect(stand.server.files.get('Marinara')!.marinara_version).toBe('7.2');
        expect(ext().preset_allowed_regex).toEqual({ openai: ['Marinara'] });
    });

    it('warns and sends no event when the server did not delete the file', async () => {
        stand.server.failDelete = 500;
        await stand.store.remove('Other');
        expect(eventNames(stand)).not.toContain('PRESET_DELETED');
        expect(stand.env.ui.notices.at(-1)!.options?.level).toBe('warn');
        expect(stand.store.current()).toBe('Marinara');
    });
});

describe('select', () => {
    it('switches through ST (BEFORE/AFTER) and snaps unsaved edits of the preset left as a draft version', async () => {
        await stand.store.setKeys({ temperature: 0.25 });
        await stand.store.select('Other');
        await stand.store.whenIdle();
        expect(stand.manager.selectPreset).toHaveBeenCalledWith('1');
        expect(stand.store.current()).toBe('Other');
        const versions = await stand.store.versions('Marinara');
        expect(versions[0]!.by).toBe('draft');
        expect(versions[0]!.body.temperature).toBe(0.25);
        // The draft keeps unknown keys of the file and never holds secrets.
        expect(versions[0]!.body.marinara_version).toBe('7.2');
        expect(versions[0]!.body).not.toHaveProperty('proxy_password');
    });

    it('snaps nothing when the working copy is clean', async () => {
        await stand.store.select('Other');
        await stand.store.whenIdle();
        expect(versionsFile(stand, 'Marinara')).toBeUndefined();
        await expect(stand.store.select('Nope')).rejects.toMatchObject({ code: 'not-found' });
    });
});

describe('import', () => {
    function file(name: string, body: unknown): File {
        return new File([JSON.stringify(body)], name, { type: 'application/json' });
    }

    it('asks about sensitive fields like ST, normalises types, lets neighbours edit, saves and applies', async () => {
        const ctx = stand.env.mock.context as unknown as Dict;
        const asked: unknown[] = [];
        ctx.POPUP_TYPE = { CONFIRM: 2 };
        ctx.POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
        ctx.callGenericPopup = async (...args: unknown[]) => {
            asked.push(args);
            return 1;
        };
        stand.env.mock.eventSource.on(ev('OAI_PRESET_IMPORT_READY'), (data: unknown) => {
            ((data as { data: Dict }).data as Dict).neighbour = 'was here';
        });
        const name = await stand.store.importFile(
            file('Yablochny.json', {
                temperature: 0.8,
                reverse_proxy: 'http://evil',
                prompts: [
                    {
                        identifier: 'auto',
                        name: 'Autonomy',
                        content: 'Act.',
                        injection_position: '1',
                        injection_depth: '0',
                    },
                ],
                prompt_order: [{ character_id: 100001, order: [{ identifier: 'auto', enabled: true }] }],
            }),
        );
        expect(name).toBe('Yablochny');
        expect(asked).toHaveLength(1);
        const saved = stand.server.files.get('Yablochny')!;
        expect(saved).not.toHaveProperty('reverse_proxy');
        expect(saved.neighbour).toBe('was here');
        expect((saved.prompts as Dict[])[0]).toMatchObject({
            injection_position: 1,
            injection_depth: 0,
            system_prompt: false,
            marker: false,
        });
        expect(stand.store.current()).toBe('Yablochny');
        expect(stand.oai.temp_openai).toBe(0.8);
        const versions = await stand.store.versions('Yablochny');
        expect(versions[0]!.by).toBe('import');
    });

    it('cancels on «Cancel import» and on a declined overwrite', async () => {
        const ctx = stand.env.mock.context as unknown as Dict;
        ctx.POPUP_TYPE = { CONFIRM: 2 };
        ctx.POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
        ctx.callGenericPopup = async () => null;
        await expect(stand.store.importFile(file('A.json', { custom_url: 'http://x' }))).rejects.toMatchObject({
            code: 'cancelled',
        });
        stand.env.ui.confirmAnswer = false;
        await expect(stand.store.importFile(file('Other.json', { temperature: 2 }))).rejects.toMatchObject({
            code: 'cancelled',
        });
        await expect(stand.store.importFile(file('Bad.json', 'not a preset'))).rejects.toMatchObject({
            code: 'invalid',
        });
        expect(stand.server.saves).toHaveLength(0);
    });

    it('overwrites an existing preset after the question; undo brings the old body back', async () => {
        const name = await stand.store.importFile(file('Other.json', { temperature: 1.5, openai_max_tokens: 99 }));
        expect(name).toBe('Other');
        expect(stand.cache.list[1]).toEqual({ temperature: 1.5, openai_max_tokens: 99 });
        expect(stand.store.current()).toBe('Other');
        const record = stand.env.journal.list({ module: 'M34' })[0]!;
        expect(await stand.env.journal.undo(record.id)).toBe(true);
        expect((stand.cache.list[1] as Dict).temperature).toBe(0.7);
        expect(stand.oai.temp_openai).toBe(0.7);
    });
});

describe('export', () => {
    it('exports the saved body (not the working copy) without sensitive and connection data by default', async () => {
        await stand.store.setKeys({ temperature: 0.1 });
        stand.env.mock.eventSource.on(ev('OAI_PRESET_EXPORT_READY'), (preset: unknown) => {
            (preset as Dict).exported_by = 'neighbour';
        });
        await stand.store.exportPreset('Marinara');
        const download = stand.downloads[0]!;
        expect(download.name).toBe('Marinara.json');
        expect(download.type).toBe('application/json');
        const body = JSON.parse(download.text) as Dict;
        expect(body.temperature).toBe(1);
        expect(body).not.toHaveProperty('proxy_password');
        expect(body).not.toHaveProperty('reverse_proxy');
        expect(body).not.toHaveProperty('chat_completion_source');
        expect(body).not.toHaveProperty('openrouter_model');
        expect(body.marinara_version).toBe('7.2');
        expect(body.exported_by).toBe('neighbour');
        expect(download.text).toContain('\n    "');
    });

    it('keeps sensitive and connection data on request', async () => {
        await stand.store.exportPreset('Marinara', { withSensitive: true });
        const body = JSON.parse(stand.downloads[0]!.text) as Dict;
        expect(body.proxy_password).toBe('secret');
        expect(body.chat_completion_source).toBe('openrouter');
        await stand.store.exportPreset('Marinara', { withSensitive: true, withConnection: false });
        const noConnection = JSON.parse(stand.downloads[1]!.text) as Dict;
        // Proxy fields are connection data too (P-094): ST strips them with it.
        expect(noConnection).not.toHaveProperty('proxy_password');
        expect(noConnection).not.toHaveProperty('openrouter_model');
        expect(noConnection.temperature).toBe(1);
        await expect(stand.store.exportPreset('Nope')).rejects.toMatchObject({ code: 'not-found' });
    });
});
