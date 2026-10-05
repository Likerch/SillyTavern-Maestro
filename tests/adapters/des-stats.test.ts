// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { clearScripts, createStand, scriptUrl, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';

const DES = 'third-party/Dooms-Enhancement-Suite';
const DES_MANIFEST = {
    display_name: "Doom's Enhancement Suite",
    version: '2.6.0',
    js: 'index.js',
    homePage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite',
};

function liveSettings(): Record<string, unknown> {
    return {
        enabled: true,
        trackerConfig: {
            presentCharacters: {
                customFields: [{ id: 'appearance', name: 'Appearance', enabled: true }],
                characterStats: {
                    enabled: false,
                    customStats: [{ id: 'health', name: 'Health', enabled: true, color: '#f00' }],
                },
            },
        },
        presetManager: {
            activePresetId: 'p1',
            presets: {
                p1: { id: 'p1', name: 'Default', trackerConfig: { presentCharacters: { customFields: [] } } },
                p2: { id: 'p2', name: 'Other', trackerConfig: { presentCharacters: {} } },
            },
        },
    };
}

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    clearScripts();
    document.body.innerHTML = '';
});

function modules(options: { persistence?: boolean; settings?: Record<string, unknown> } = {}) {
    const settings = options.settings ?? liveSettings();
    let saves = 0;
    const base = scriptUrl(DES);
    stand.imports.set(new URL('src/core/state.js', base).href, { extensionSettings: settings });
    if (options.persistence !== false) {
        stand.imports.set(new URL('src/core/persistence.js', base).href, {
            saveSettings: () => {
                saves++;
            },
            saveChatData: () => {},
        });
    }
    return { settings, saves: () => saves };
}

describe('DesAdapter.setCharacterStats', () => {
    it('writes the live settings, mirrors the active preset and saves through DES', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const { settings, saves } = modules();
        await adapters.des.ready();
        const ok = adapters.des.setCharacterStats(
            [
                { id: 'health', name: 'Health', enabled: true },
                { id: 'maestro_mana', name: ' Mana ', enabled: true },
                { id: '', name: 'Luck', enabled: false },
                { id: 'x', name: '  ', enabled: true },
            ],
            { enable: true },
        );
        expect(ok).toBe(true);
        const present = (settings.trackerConfig as { presentCharacters: Record<string, unknown> }).presentCharacters;
        expect(present.characterStats).toEqual({
            enabled: true,
            customStats: [
                { id: 'health', name: 'Health', enabled: true, color: '#f00' },
                { id: 'maestro_mana', name: 'Mana', enabled: true },
                { id: 'Luck', name: 'Luck', enabled: false },
            ],
        });
        expect(present.customFields).toEqual([{ id: 'appearance', name: 'Appearance', enabled: true }]);
        type Preset = { trackerConfig: { presentCharacters: Record<string, unknown> } };
        const presets = (settings.presetManager as { presets: Record<string, Preset> }).presets;
        expect(presets.p1?.trackerConfig.presentCharacters.characterStats).toEqual(present.characterStats);
        expect(presets.p1?.trackerConfig.presentCharacters.characterStats).not.toBe(present.characterStats);
        expect(presets.p2?.trackerConfig.presentCharacters.characterStats).toBeUndefined();
        expect(saves()).toBe(1);
        expect(stand.mock.saveSettingsCalls).toBe(0);
        // Without `enable` the switch stays as it is; `enable: false` turns it off.
        adapters.des.setCharacterStats([]);
        expect((present.characterStats as { enabled: boolean }).enabled).toBe(true);
        adapters.des.setCharacterStats([], { enable: false });
        expect(present.characterStats).toEqual({ enabled: false, customStats: [] });
    });

    it('creates missing config objects and saves through ST without DES persistence', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const { settings } = modules({
            persistence: false,
            settings: { enabled: true, presetManager: { activePresetId: 'gone', presets: {} } },
        });
        await adapters.des.ready();
        expect(adapters.des.setCharacterStats([{ id: 'hp', name: 'HP', enabled: true }])).toBe(true);
        expect(settings.trackerConfig).toEqual({
            presentCharacters: {
                characterStats: { enabled: false, customStats: [{ id: 'hp', name: 'HP', enabled: true }] },
            },
        });
        expect(stand.mock.extensionSettings[DES]).toBe(settings);
        expect(stand.mock.saveSettingsCalls).toBe(1);
    });

    it('falls back to ST when DES saveSettings throws', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const base = scriptUrl(DES);
        const settings = liveSettings();
        stand.imports.set(new URL('src/core/state.js', base).href, { extensionSettings: settings });
        stand.imports.set(new URL('src/core/persistence.js', base).href, {
            saveSettings: () => {
                throw new Error('boom');
            },
            saveChatData: () => {},
        });
        await adapters.des.ready();
        expect(adapters.des.setCharacterStats([])).toBe(true);
        expect(stand.mock.saveSettingsCalls).toBe(1);
    });

    it('refuses without DES or its live state', async () => {
        expect(adapters.des.setCharacterStats([])).toBe(false);
        stand.install(DES, DES_MANIFEST, { loaded: true });
        stand.mock.extensionSettings[DES] = liveSettings();
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(true);
        expect(adapters.des.setCharacterStats([{ id: 'a', name: 'A', enabled: true }])).toBe(false);
        expect(stand.mock.saveSettingsCalls).toBe(0);
    });
});
