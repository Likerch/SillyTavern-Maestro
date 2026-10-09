// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionLocator, createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { DesAdapter } from '../../src/adapters/des';
import { clearScripts, createStand, scriptUrl, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';
import { message } from '../helpers/st-mock';

const DES = 'third-party/Dooms-Enhancement-Suite';
const DES_MANIFEST = {
    display_name: "Doom's Enhancement Suite",
    version: '2.6.0',
    js: 'index.js',
    homePage: 'https://github.com/DangerDaza/Dooms-Enhancement-Suite',
};

function desModules(stand: AdapterStand, name = DES): { settings: Record<string, unknown>; invalidated: string[] } {
    const settings: Record<string, unknown> = {
        enabled: true,
        generationMode: 'together',
        characterAliases: { Аня: ['Анечка', 'Аннушка'], broken: 'x' },
    };
    const invalidated: string[] = [];
    const base = scriptUrl(name);
    stand.imports.set(new URL('src/core/state.js', base).href, { extensionSettings: settings, lastGeneratedData: {} });
    stand.imports.set(new URL('src/core/persistence.js', base).href, {
        saveSettings: () => {},
        saveChatData: () => {},
    });
    stand.imports.set(new URL('src/systems/lorebook/lorebookAPI.js', base).href, {
        invalidateWICache: (book: string) => invalidated.push(book),
    });
    stand.imports.set(new URL('src/systems/generation/promptBuilder.js', base).href, {
        DEFAULT_HTML_PROMPT: 'Built-in HTML rules',
        DEFAULT_DIALOGUE_COLORING_PROMPT: 'Built-in colours',
        DEFAULT_NARRATOR_PROMPT: 'Built-in narrator',
        DEFAULT_CONTEXT_INSTRUCTIONS_PROMPT: 'Built-in context',
        getAssembledTrackerPrompt: ({ generatedOnly }: { generatedOnly?: boolean } = {}) =>
            !generatedOnly && settings.customTrackerPrompt ? settings.customTrackerPrompt : 'Generated tracker block',
    });
    return { settings, invalidated };
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

describe('DesAdapter', () => {
    it('is absent when DES is not installed', async () => {
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(false);
        expect(adapters.des.version()).toBeUndefined();
        expect(adapters.des.trackerFor(0)).toBeNull();
        expect(adapters.des.knownCharacters()).toEqual([]);
        expect(adapters.des.aliases()).toEqual({});
        adapters.des.invalidateLoreCache('Book');
        await stand.caps.refresh();
        expect(stand.caps.report().filter((cap) => cap.id.startsWith('des.'))).toEqual(
            ['des.present', 'des.state', 'des.enabled', 'des.together', 'des.lore'].map((id) => ({
                id,
                ok: false,
                detail: undefined,
            })),
        );
    });

    it('locates DES, imports its modules from its own script URL and reports capabilities', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const { invalidated } = desModules(stand);
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(true);
        expect(adapters.des.version()).toBe('2.6.0');
        expect(adapters.des.verified()).toBe(true);
        expect(adapters.des.extensionName()).toBe(DES);
        expect(stand.importedUrls).toEqual([
            `${scriptUrl(DES).replace('index.js', '')}src/core/state.js`,
            `${scriptUrl(DES).replace('index.js', '')}src/core/persistence.js`,
            `${scriptUrl(DES).replace('index.js', '')}src/systems/lorebook/lorebookAPI.js`,
            `${scriptUrl(DES).replace('index.js', '')}src/systems/generation/promptBuilder.js`,
        ]);
        await stand.caps.refresh();
        for (const id of ['des.present', 'des.state', 'des.enabled', 'des.together', 'des.lore'])
            expect(stand.caps.has(id)).toBe(true);
        expect(adapters.des.capabilities()).toEqual([
            'des.present',
            'des.state',
            'des.enabled',
            'des.together',
            'des.lore',
        ]);
        adapters.des.invalidateLoreCache('Book');
        expect(invalidated).toEqual(['Book']);
        // ready() is idempotent once connected.
        await adapters.des.ready();
        expect(stand.importedUrls).toHaveLength(4);
    });

    it('reads mode, switch and aliases from the live settings object', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const { settings } = desModules(stand);
        await adapters.des.ready();
        expect(adapters.des.aliases()).toEqual({ Аня: ['Анечка', 'Аннушка'] });
        settings.generationMode = 'separate';
        settings.enabled = false;
        expect(adapters.des.generationMode()).toBe('separate');
        expect(adapters.des.enabled()).toBe(false);
        await stand.caps.refresh();
        expect(stand.caps.has('des.together')).toBe(false);
        expect(stand.caps.has('des.enabled')).toBe(false);
        settings.generationMode = 'weird';
        expect(adapters.des.generationMode()).toBe('together');
    });

    it('reads and writes DES prompt overrides; built-in texts come from promptBuilder.js', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const { settings } = desModules(stand);
        await adapters.des.ready();
        expect(adapters.des.promptOverride('customHtmlPrompt')).toBe('');
        expect(adapters.des.promptBuiltin('customHtmlPrompt')).toBe('Built-in HTML rules');
        expect(adapters.des.promptBuiltin('customNarratorPrompt')).toBe('Built-in narrator');
        expect(adapters.des.promptBuiltin('customTrackerPrompt')).toBe('Generated tracker block');
        expect(adapters.des.promptBuiltin('customTrackerInstructionsPrompt')).toBeNull();
        const saves = stand.mock.saveSettingsCalls;
        expect(adapters.des.setPromptOverride('customHtmlPrompt', 'No HTML.')).toBe(true);
        expect(settings.customHtmlPrompt).toBe('No HTML.');
        expect(adapters.des.promptOverride('customHtmlPrompt')).toBe('No HTML.');
        // DES's own saveSettings (persistence.js) is used, not ST's.
        expect(stand.mock.saveSettingsCalls).toBe(saves);
        expect(adapters.des.setPromptOverride('enabled' as never, 'x')).toBe(false);
    });

    it('is absent when disabled in ST, and does not import anything', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        desModules(stand);
        stand.disable(DES);
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(false);
        expect(adapters.des.version()).toBe('2.6.0');
        expect(stand.importedUrls).toEqual([]);
    });

    it('retries on the next ready() when the script is not on the page yet', async () => {
        stand.install(DES, DES_MANIFEST);
        desModules(stand);
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(false);
        expect(stand.importedUrls).toEqual([]);
        stand.addScript(DES);
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(true);
        expect(stand.importedUrls).toHaveLength(4);
    });

    it('keeps working without optional modules and falls back to saved settings', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        stand.mock.extensionSettings[DES] = {
            enabled: true,
            generationMode: 'external',
            characterAliases: { A: ['B'] },
        };
        await adapters.des.ready();
        expect(adapters.des.present()).toBe(true);
        expect(adapters.des.generationMode()).toBe('external');
        expect(adapters.des.aliases()).toEqual({ A: ['B'] });
        await stand.caps.refresh();
        expect(stand.caps.has('des.state')).toBe(false);
        expect(stand.caps.has('des.lore')).toBe(false);
        adapters.des.invalidateLoreCache('Book');
    });

    it('rejects modules with missing exports', async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const base = scriptUrl(DES);
        stand.imports.set(new URL('src/core/state.js', base).href, { extensionSettings: null });
        stand.imports.set(new URL('src/systems/lorebook/lorebookAPI.js', base).href, {
            invalidateWICache: () => {
                throw new Error('boom');
            },
        });
        await adapters.des.ready();
        await stand.caps.refresh();
        expect(stand.caps.has('des.state')).toBe(false);
        expect(stand.caps.has('des.lore')).toBe(true);
        expect(() => adapters.des.invalidateLoreCache('Book')).not.toThrow();
    });

    it('finds DES in a per-user folder through the page script when the extension list is unavailable', async () => {
        const name = 'third-party/my-des-copy';
        stand.noExtensionList = true;
        stand.install(name, DES_MANIFEST, { loaded: true });
        desModules(stand, name);
        await adapters.des.ready();
        expect(adapters.des.extensionName()).toBe(name);
        expect(adapters.des.present()).toBe(true);
    });

    it('reads manifests over HTTP on an ST without getExtensionManifest', async () => {
        stand.setCtx('getExtensionManifest', undefined);
        stand.install(DES, { ...DES_MANIFEST, version: '2.7.0' }, { loaded: true });
        desModules(stand);
        const fresh = new DesAdapter({
            host: stand.host,
            log: silentLog,
            locator: new ExtensionLocator(stand.host, silentLog, stand.fetchManifest),
            importModule: stand.importModule,
        });
        await fresh.ready();
        expect(fresh.version()).toBe('2.7.0');
        expect(fresh.verified()).toBe(false);
        expect(stand.fetched).toEqual(['/scripts/extensions/third-party/Dooms-Enhancement-Suite/manifest.json']);
    });

    it('parses the tracker of a message for its current swipe', async () => {
        stand.mock.chat.push(
            message('hi', { is_user: true }),
            message('reply', {
                swipe_id: 1,
                extra: {
                    dooms_tracker_swipes: {
                        0: { quests: null, infoBox: '{"location":"Old"}', characterThoughts: null },
                        1: {
                            quests: '{"main":{"title":"Find the key"},"optional":[]}',
                            infoBox: '{"location":{"value":"Tavern"},"time":{"start":"18:00","end":"19:00"}}',
                            characterThoughts: '[{"name":"Аня","relationship":{"status":"Friend"}}]',
                        },
                    },
                },
            }),
        );
        const snapshot = adapters.des.trackerFor(1);
        expect(snapshot?.infoBox?.location).toBe('Tavern');
        expect(snapshot?.quests?.main).toBe('Find the key');
        expect(snapshot?.characters[0]).toMatchObject({ name: 'Аня', relationship: 'Friend' });
        expect(adapters.des.trackerFor(0)).toBeNull();
        expect(adapters.des.trackerFor(5)).toBeNull();
    });

    it("tells whether DES keeps the roster in the chat (its accessor else hands out DES's global one)", async () => {
        stand.install(DES, DES_MANIFEST, { loaded: true });
        const { settings } = desModules(stand);
        await adapters.des.ready();
        expect(adapters.des.rosterPerChat()).toBe(false);
        settings.perChatCharacterTracking = true;
        expect(adapters.des.rosterPerChat()).toBe(false);
        stand.mock.chatMetadata.dooms_tracker = { knownCharacters: {} };
        expect(adapters.des.rosterPerChat()).toBe(true);
    });

    it('reads the chat roster and the Workshop state', () => {
        stand.mock.chatMetadata.dooms_tracker = {
            knownCharacters: { Аня: { emoji: '😊' }, Борис: {} },
            removedCharacters: ['Борис', 3],
        };
        expect(adapters.des.knownCharacters()).toEqual(['Аня', 'Борис']);
        expect(adapters.des.removedCharacters()).toEqual(['Борис']);
        expect(adapters.des.isWorkshopOpen()).toBe(false);
        const popup = document.createElement('div');
        popup.id = 'character-workshop-popup';
        popup.className = 'is-open';
        document.body.append(popup);
        expect(adapters.des.isWorkshopOpen()).toBe(true);
    });

    it("opens DES's character sheet the way its portrait menu does (M39)", async () => {
        expect(await adapters.des.openCharacterSheet('Аня')).toBe(false);
        stand.install(DES, DES_MANIFEST, { loaded: true });
        desModules(stand);
        await adapters.des.ready();
        const base = scriptUrl(DES).replace('index.js', '');
        const calls: string[] = [];
        stand.imports.set(`${base}src/core/lazyUI.js`, {
            ensureSettingsUI: async () => void calls.push('ensureSettingsUI'),
        });
        // DES imports characterSheet.js lazily: Maestro asks for it after ensureSettingsUI, by the same URL.
        stand.imports.set(`${base}src/systems/ui/characterSheet.js`, {
            openCharacterSheet: (name: string) => void calls.push(`open:${name}`),
        });
        const before = stand.importedUrls.length;
        expect(await adapters.des.openCharacterSheet('  ')).toBe(false);
        expect(await adapters.des.openCharacterSheet(' Аня ')).toBe(true);
        expect(calls).toEqual(['ensureSettingsUI', 'open:Аня']);
        expect(stand.importedUrls.slice(before)).toEqual([
            `${base}src/core/lazyUI.js`,
            `${base}src/systems/ui/characterSheet.js`,
        ]);
        // A DES without the export, or whose modal UI fails to load, says no.
        stand.imports.set(`${base}src/systems/ui/characterSheet.js`, {});
        expect(await adapters.des.openCharacterSheet('Аня')).toBe(false);
        stand.imports.set(`${base}src/core/lazyUI.js`, {
            ensureSettingsUI: async () => {
                throw new Error('template missing');
            },
        });
        expect(await adapters.des.openCharacterSheet('Аня')).toBe(false);
        stand.disable(DES);
        expect(await adapters.des.openCharacterSheet('Аня')).toBe(false);
    });
});
