// @vitest-environment happy-dom
// DES per-character fields through the DesAdapter (release 1.11, wardrobe): the live tracker config and the active
// tracker preset get Maestro's clothing field, saved through DES; undo takes it away or restores the old field.
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

type Field = Record<string, unknown>;

function liveSettings(): Record<string, unknown> {
    return {
        enabled: true,
        trackerConfig: {
            presentCharacters: {
                customFields: [
                    {
                        id: 'appearance',
                        name: 'Внешность',
                        enabled: true,
                        description: 'Как выглядит',
                        persistInHistory: false,
                    },
                    { id: 'demeanor', name: 'Поведение', enabled: true, description: 'Настроение' },
                ],
            },
        },
        presetManager: {
            activePresetId: 'p1',
            presets: {
                p1: { id: 'p1', name: 'Default', trackerConfig: { presentCharacters: { customFields: [] } } },
                p2: { id: 'p2', name: 'Other', trackerConfig: { presentCharacters: { customFields: [] } } },
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

async function ready(settings = liveSettings()) {
    let saves = 0;
    stand.install(DES, DES_MANIFEST, { loaded: true });
    const base = scriptUrl(DES);
    stand.imports.set(new URL('src/core/state.js', base).href, { extensionSettings: settings });
    stand.imports.set(new URL('src/core/persistence.js', base).href, {
        saveSettings: () => {
            saves++;
        },
        saveChatData: () => {},
    });
    await adapters.des.ready();
    return { settings, saves: () => saves };
}

const liveFields = (settings: Record<string, unknown>) =>
    (settings.trackerConfig as { presentCharacters: { customFields: Field[] } }).presentCharacters.customFields;
const presetFields = (settings: Record<string, unknown>, id: string) =>
    (
        settings.presetManager as {
            presets: Record<string, { trackerConfig: { presentCharacters: { customFields: Field[] } } }>;
        }
    ).presets[id]!.trackerConfig.presentCharacters.customFields;

describe('DesAdapter character fields', () => {
    it('lists the per-character fields as copies', async () => {
        expect(adapters.des.characterFields()).toBeNull();
        const { settings } = await ready();
        const fields = adapters.des.characterFields()!;
        expect(fields).toEqual([
            { id: 'appearance', name: 'Внешность', enabled: true, description: 'Как выглядит' },
            { id: 'demeanor', name: 'Поведение', enabled: true, description: 'Настроение' },
        ]);
        fields[0]!.name = 'x';
        expect(liveFields(settings)[0]!.name).toBe('Внешность');
    });

    it('adds the field to the live config and the active preset, saves through DES, and takes it back', async () => {
        const { settings, saves } = await ready();
        const field = { id: 'outfit', name: 'Одежда', description: 'Во что одет' };
        expect(adapters.des.addCharacterField(field)).toEqual({ before: null });
        const added = { ...field, enabled: true, persistInHistory: false };
        expect(liveFields(settings).at(-1)).toEqual(added);
        expect(presetFields(settings, 'p1')).toEqual([added]);
        expect(presetFields(settings, 'p2')).toEqual([]);
        expect(saves()).toBe(1);
        expect(adapters.des.removeCharacterField('outfit')).toBe(true);
        expect(liveFields(settings).map((item) => item.id)).toEqual(['appearance', 'demeanor']);
        expect(presetFields(settings, 'p1')).toEqual([]);
        expect(saves()).toBe(2);
    });

    it('switches on a field that is there but off, and undo restores it', async () => {
        const settings = liveSettings();
        liveFields(settings).push({ id: 'outfit', name: 'Outfit', enabled: false, description: 'old' });
        await ready(settings);
        const result = adapters.des.addCharacterField({ id: 'outfit', name: 'Одежда', description: 'new' });
        expect(result).toEqual({ before: { id: 'outfit', name: 'Outfit', enabled: false, description: 'old' } });
        expect(liveFields(settings).at(-1)).toEqual({
            id: 'outfit',
            name: 'Outfit',
            enabled: true,
            description: 'old',
        });
        expect(adapters.des.removeCharacterField('outfit', result!.before)).toBe(true);
        expect(liveFields(settings).at(-1)).toEqual({
            id: 'outfit',
            name: 'Outfit',
            enabled: false,
            description: 'old',
        });
    });

    it('creates missing config objects and refuses without DES or a name', async () => {
        expect(adapters.des.addCharacterField({ id: 'outfit', name: 'Outfit', description: '' })).toBeNull();
        expect(adapters.des.removeCharacterField('outfit')).toBe(false);
        const { settings } = await ready({ enabled: true });
        expect(adapters.des.addCharacterField({ id: 'outfit', name: ' ', description: '' })).toBeNull();
        expect(adapters.des.addCharacterField({ id: 'outfit', name: 'Outfit', description: 'd' })).toEqual({
            before: null,
        });
        expect(liveFields(settings)).toEqual([
            { id: 'outfit', name: 'Outfit', enabled: true, description: 'd', persistInHistory: false },
        ]);
        expect(adapters.des.removeCharacterField('missing')).toBe(true);
    });
});
