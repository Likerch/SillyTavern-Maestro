import { beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';

let stand: AdapterStand;
let adapters: Adapters;
let settings: Record<string, unknown>;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
    settings = {
        preset_settings_openai: 'Default',
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'Write.' },
            { identifier: 'chatHistory', name: 'Chat History', marker: true },
            'junk',
        ],
        prompt_order: [{ character_id: 100001, order: [] }],
    };
    stand.setCtx('chatCompletionSettings', settings);
});

describe('PresetAdapter', () => {
    it('is present on Chat Completion with a Prompt Manager list', async () => {
        await adapters.preset.ready();
        expect(adapters.preset.present()).toBe(true);
        expect(adapters.preset.version()).toBeUndefined();
        expect(adapters.preset.presetName()).toBe('Default');
        expect(adapters.preset.prompts()).toEqual([
            { identifier: 'main', name: 'Main Prompt', role: 'system', marker: false },
            { identifier: 'chatHistory', name: 'Chat History', role: 'system', marker: true },
        ]);
        await stand.caps.refresh();
        expect(stand.caps.has('preset.cc')).toBe(true);
        expect(stand.caps.has('preset.marinara')).toBe(false);
    });

    it('is absent on other APIs or without prompts', () => {
        stand.mock.context.mainApi = 'textgenerationwebui';
        expect(adapters.preset.present()).toBe(false);
        stand.mock.context.mainApi = 'openai';
        settings.prompts = [];
        expect(adapters.preset.present()).toBe(false);
        stand.setCtx('chatCompletionSettings', undefined);
        expect(adapters.preset.present()).toBe(false);
        expect(adapters.preset.prompts()).toEqual([]);
        expect(adapters.preset.presetName()).toBeUndefined();
        expect(adapters.preset.isMarinara()).toBe(false);
    });

    it('recognises Marinara by name or by its section tags', () => {
        settings.preset_settings_openai = "Marinara's Spaghetti Recipe";
        expect(adapters.preset.isMarinara()).toBe(true);
        settings.preset_settings_openai = 'My copy';
        expect(adapters.preset.isMarinara()).toBe(false);
        settings.prompts = [
            { identifier: 'a', content: '<instructions>\nRules\n' },
            { identifier: 'b', content: '<output_format>\nFormat' },
        ];
        expect(adapters.preset.isMarinara()).toBe(true);
        expect(adapters.preset.capabilities()).toEqual(['preset.cc', 'preset.marinara']);
    });
});
