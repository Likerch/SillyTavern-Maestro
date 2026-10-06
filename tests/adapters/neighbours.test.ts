// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { readPassport } from '../../src/adapters/nai';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';
import { message } from '../helpers/st-mock';

const globals = globalThis as unknown as Record<string, unknown>;
const GLOBALS = ['CarrotKernel', 'CarrotKernelFullsheetRag', 'memory_intercept_messages', 'NAIST_ProcessTriggers'];

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    clearScripts();
    document.body.innerHTML = '';
    for (const name of GLOBALS) delete globals[name];
});

describe('DesRuAdapter', () => {
    const NAME = 'third-party/SillyTavern-DES-RU';
    const MANIFEST = {
        display_name: "SillyTavern - Doom's Enhancement Suite - RU",
        version: '0.7.0',
        js: 'index.js',
        homePage: 'https://github.com/Likerch/SillyTavern-Doom-Enhancement-Suite-RU',
    };

    it('is present when installed, enabled and loaded', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.desru.ready();
        expect(adapters.desru.present()).toBe(true);
        expect(adapters.desru.version()).toBe('0.7.0');
        await stand.caps.refresh();
        for (const id of ['desru.present', 'desru.names', 'desru.bunnymo', 'desru.carrotKernel'])
            expect(stand.caps.has(id)).toBe(true);
    });

    it('reads module switches from extension_settings.desru', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        stand.mock.extensionSettings.desru = { modules: { bunnymo: { enabled: false }, names: 'junk' } };
        await adapters.desru.ready();
        expect(adapters.desru.moduleEnabled('bunnymo')).toBe(false);
        expect(adapters.desru.moduleEnabled('names')).toBe(true);
        expect(adapters.desru.moduleEnabled('carrotKernel')).toBe(true);
        expect(adapters.desru.capabilities()).toEqual(['desru.present', 'desru.names', 'desru.carrotKernel']);
    });

    it('accepts its settings panel as the runtime marker and is absent when disabled or not loaded', async () => {
        stand.install(NAME, MANIFEST);
        await adapters.desru.ready();
        expect(adapters.desru.present()).toBe(false);
        document.body.innerHTML = '<div id="desru-settings"></div>';
        expect(adapters.desru.present()).toBe(true);
        stand.disable(NAME);
        expect(adapters.desru.present()).toBe(false);
    });
});

describe('CkAdapter', () => {
    const NAME = 'third-party/CarrotKernel';
    const MANIFEST = { display_name: 'CarrotKernel', version: '1.0.0', js: 'index.js' };

    it('needs window.CarrotKernel', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.ck.ready();
        expect(adapters.ck.version()).toBe('1.0.0');
        expect(adapters.ck.present()).toBe(false);
        globals.CarrotKernel = { scanSelectedLorebooks: () => undefined };
        expect(adapters.ck.present()).toBe(true);
        expect(adapters.ck.kernel()).toBe(globals.CarrotKernel);
        stand.disable(NAME);
        expect(adapters.ck.present()).toBe(false);
    });

    it('reads repos, tag libraries and RAG state from its settings', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        globals.CarrotKernel = {};
        stand.mock.extensionSettings.CarrotKernel = {
            enabled: false,
            characterRepoBooks: ['Архив', 7],
            tagLibraries: ['Теги'],
            rag: { enabled: true },
        };
        await adapters.ck.ready();
        expect(adapters.ck.repoBooks()).toEqual(['Архив']);
        expect(adapters.ck.tagLibraries()).toEqual(['Теги']);
        expect(adapters.ck.enabled()).toBe(false);
        expect(adapters.ck.ragEnabled()).toBe(true);
        await stand.caps.refresh();
        expect(stand.caps.has('ck.repos')).toBe(true);
        expect(stand.caps.has('ck.rag')).toBe(false);
        globals.CarrotKernelFullsheetRag = {};
        await stand.caps.refresh();
        expect(stand.caps.has('ck.rag')).toBe(true);
    });

    it('has no repos without settings', () => {
        expect(adapters.ck.repoBooks()).toEqual([]);
        expect(adapters.ck.tagLibraries()).toEqual([]);
        expect(adapters.ck.ragEnabled()).toBe(false);
        expect(adapters.ck.enabled()).toBe(true);
    });
});

describe('QvinkAdapter', () => {
    const NAME = 'third-party/SillyTavern-MessageSummarize';
    const MANIFEST = {
        display_name: 'qvink_memory',
        version: '1.3.29',
        js: 'index.js',
        generate_interceptor: 'memory_intercept_messages',
    };

    it('is present when its interceptor is registered; defaults follow Qvink', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.qvink.ready();
        expect(adapters.qvink.version()).toBe('1.3.29');
        expect(adapters.qvink.present()).toBe(false);
        globals.memory_intercept_messages = () => {};
        expect(adapters.qvink.present()).toBe(true);
        expect(adapters.qvink.chatEnabled()).toBe(true);
        expect(adapters.qvink.removesMessages()).toBe(true);
        await stand.caps.refresh();
        for (const id of ['qvink.present', 'qvink.chat', 'qvink.removeMessages']) expect(stand.caps.has(id)).toBe(true);
    });

    it('reads and writes its text settings, into the active profile too', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.qvink.ready();
        globals.memory_intercept_messages = () => {};
        stand.mock.extensionSettings.qvink_memory = {
            prompt: 'Summarize.',
            profile: 'Default',
            profiles: { Default: { prompt: 'Summarize.' }, Other: { prompt: 'Other.' } },
        };
        expect(adapters.qvink.textSetting('prompt')).toBe('Summarize.');
        expect(adapters.qvink.textSetting('short_template')).toBeNull();
        expect(adapters.qvink.setTextSetting('prompt', 'Retell.')).toBe(true);
        const settings = stand.mock.extensionSettings.qvink_memory as Record<string, unknown>;
        expect(settings.prompt).toBe('Retell.');
        expect(settings.profiles).toEqual({ Default: { prompt: 'Retell.' }, Other: { prompt: 'Other.' } });
        delete globals.memory_intercept_messages;
        expect(adapters.qvink.setTextSetting('prompt', 'x')).toBe(false);
    });

    it('follows the per-chat and global toggles like chat_enabled()', () => {
        globals.memory_intercept_messages = () => {};
        stand.mock.extensionSettings.qvink_memory = {
            exclude_messages_after_threshold: false,
            default_chat_enabled: false,
        };
        expect(adapters.qvink.chatEnabled()).toBe(false);
        expect(adapters.qvink.removesMessages()).toBe(false);
        stand.mock.chatMetadata.qvink_memory = { enabled: true };
        expect(adapters.qvink.chatEnabled()).toBe(true);
        stand.mock.extensionSettings.qvink_memory = { use_global_toggle_state: true, global_toggle_state: false };
        expect(adapters.qvink.chatEnabled()).toBe(false);
    });

    it('reads memories as typed copies', () => {
        stand.mock.chat.push(
            message('a', {
                extra: {
                    qvink_memory: {
                        memory: 'Alice cut her hair.',
                        remember: true,
                        include: 'long',
                        lagging: false,
                        error: 'x',
                    },
                },
            }),
            message('b', { extra: { qvink_memory: { include: 'weird', memory: 5 } } }),
            message('c'),
        );
        expect(adapters.qvink.memoryOf(0)).toEqual({
            memory: 'Alice cut her hair.',
            remember: true,
            exclude: false,
            include: 'long',
            lagging: false,
            edited: false,
            error: 'x',
        });
        expect(adapters.qvink.memoryOf(1)).toMatchObject({ memory: '', include: null });
        expect(adapters.qvink.memoryOf(2)).toBeNull();
        expect(adapters.qvink.memoryOf(9)).toBeNull();
    });

    it('guesses busy from the progress bar and pending texts', () => {
        expect(adapters.qvink.isBusy()).toBe(false);
        globals.memory_intercept_messages = () => {};
        document.body.innerHTML =
            '<div id="chat"><div class="mes"><div class="qvink_memory_text">Memory: done</div></div></div>';
        expect(adapters.qvink.isBusy()).toBe(false);
        document.body.innerHTML =
            '<div id="chat"><div class="qvink_memory_text"><span>Summarizing...</span></div></div>';
        expect(adapters.qvink.isBusy()).toBe(true);
        document.body.innerHTML = '<div class="summarize qvink_progress_bar"></div>';
        expect(adapters.qvink.isBusy()).toBe(true);
    });
});

describe('NaiAdapter', () => {
    const NAME = 'third-party/SillyTavern-NAI-Studio';
    const MANIFEST = {
        display_name: 'NAI Studio',
        version: '0.9.10',
        js: 'dist/index.js',
        generate_interceptor: 'NAIST_ProcessTriggers',
    };

    it('is present with its interceptor; the API capability stays off', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.nai.ready();
        expect(adapters.nai.version()).toBe('0.9.10');
        expect(adapters.nai.present()).toBe(false);
        globals.NAIST_ProcessTriggers = () => {};
        expect(adapters.nai.present()).toBe(true);
        stand.mock.extensionSettings.nai_studio = { scene: {} };
        expect(adapters.nai.settings()).toEqual({ scene: {} });
        await stand.caps.refresh();
        expect(stand.caps.has('nai.present')).toBe(true);
        expect(stand.caps.has('nai.api')).toBe(false);
    });

    it('reads and writes the marker instruction settings', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.nai.ready();
        globals.NAIST_ProcessTriggers = () => {};
        expect(adapters.nai.markerSettings()).toBeNull();
        stand.mock.extensionSettings.nai_studio = {
            markers: { enabled: true, preset: 'odd', template: 'T', min: 2, max: 'x', captionLanguage: 'Russian' },
        };
        expect(adapters.nai.markerSettings()).toEqual({
            enabled: true,
            inject: true,
            preset: 'natural',
            template: 'T',
            min: 2,
            max: 3,
            captionLanguage: 'Russian',
        });
        expect(adapters.nai.setMarkerInstruction({ preset: 'custom', template: 'Mine' })).toBe(true);
        expect((stand.mock.extensionSettings.nai_studio as { markers: unknown }).markers).toMatchObject({
            preset: 'custom',
            template: 'Mine',
        });
    });

    it('reads passports as typed copies, with the legacy single passport as fallback', () => {
        const stored = {
            version: 1,
            id: 'p1',
            kind: 'location',
            name: 'Таверна',
            aliases: ['Трактир', 3],
            tags: 'tavern',
            slots: { base: 'indoors', hair: 5 },
            outfits: [{ name: 'gown', tags: 'ballgown' }, 'junk'],
            activeOutfit: 'gown',
            states: [{ id: 'wet', tags: 'wet', enabled: true }, null],
            negative: '',
            position: { x: 1, y: 2 },
        };
        const characters = stand.mock.context.characters as STCharacter[];
        characters.push(
            { name: 'A', avatar: 'a.png', data: { extensions: { nai_studio: { passports: [stored, 'junk'] } } } },
            { name: 'B', avatar: 'b.png', data: { extensions: { nai_studio: { passport: { slots: {} } } } } },
            { name: 'C', avatar: 'c.png' },
        );
        const [passport] = adapters.nai.passportsOf(0);
        expect(passport).toMatchObject({
            id: 'p1',
            kind: 'location',
            name: 'Таверна',
            aliases: ['Трактир'],
            slots: { base: 'indoors' },
            outfits: [{ name: 'gown', tags: 'ballgown' }],
            states: [{ id: 'wet', tags: 'wet', enabled: true }],
            position: { x: 1, y: 2 },
        });
        passport!.slots.base = 'changed';
        expect(stored.slots.base).toBe('indoors');
        expect(adapters.nai.passportsOf(1)).toMatchObject([{ id: 'main', kind: 'character', name: '' }]);
        expect(adapters.nai.passportsOf(2)).toEqual([]);
        expect(adapters.nai.passportsOf(9)).toEqual([]);
        expect(readPassport('junk')).toBeNull();
    });
});

describe('LocalizerAdapter', () => {
    const NAME = 'third-party/SillyTavern-LorebookLocalizer';
    const MANIFEST = {
        display_name: 'Lorebook Localizer',
        version: '0.1.0',
        js: 'index.js',
        homePage: 'https://github.com/Likerch/SillyTavern-LorebookLocalizer.git',
    };

    it('is present when installed, enabled and loaded', async () => {
        stand.install(NAME, MANIFEST);
        await adapters.localizer.ready();
        expect(adapters.localizer.present()).toBe(false);
        stand.mock.extensionSettings.lorebookLocalizer = { language: 'ru' };
        expect(adapters.localizer.present()).toBe(true);
        expect(adapters.localizer.settings()).toEqual({ language: 'ru' });
        stand.disable(NAME);
        expect(adapters.localizer.present()).toBe(false);
    });

    it('accepts the module script or its button as the marker', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.localizer.ready();
        expect(adapters.localizer.present()).toBe(true);
        clearScripts();
        expect(adapters.localizer.present()).toBe(false);
        document.body.innerHTML = '<div id="lorebook_localizer_button"></div>';
        expect(adapters.localizer.present()).toBe(true);
    });

    it('reads the provenance marker of an entry', () => {
        const entry = {
            extensions: {
                lorebook_localizer: {
                    version: 1,
                    languages: {
                        ru: {
                            language: 'Russian',
                            sources: ['tavern'],
                            added: { key: ['/таверн/i'], keysecondary: ['трактир'] },
                        },
                        uk: { sources: 'junk' },
                        bad: 'junk',
                    },
                },
            },
        };
        expect(adapters.localizer.markerOf(entry)).toEqual({
            version: 1,
            languages: {
                ru: {
                    language: 'Russian',
                    sources: ['tavern'],
                    added: { key: ['/таверн/i'], keysecondary: ['трактир'] },
                },
                uk: { language: 'uk', sources: [], added: { key: [], keysecondary: [] } },
            },
        });
        expect([...adapters.localizer.addedKeysOf(entry)]).toEqual(['/таверн/i', 'трактир']);
        expect(adapters.localizer.markerOf({ extensions: {} })).toBeNull();
        expect(adapters.localizer.markerOf({ extensions: { lorebook_localizer: {} } })).toEqual({
            version: 0,
            languages: {},
        });
        expect(adapters.localizer.markerOf(null)).toBeNull();
        expect(adapters.localizer.addedKeysOf({}).size).toBe(0);
    });
});
