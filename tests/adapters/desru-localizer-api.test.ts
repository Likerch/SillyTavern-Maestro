// @vitest-environment happy-dom
// The public APIs of our own neighbours (plan §16): DES-RU 0.8.0 `DESRU_API` and Lorebook Localizer 0.2.0
// `LOREBOOK_LOCALIZER_API`, as the adapters expose them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { DESRU_API_GLOBAL, readDesRuApi } from '../../src/adapters/desru';
import type { DesRuApi } from '../../src/adapters/desru';
import { LOCALIZER_API_GLOBAL, readLocalizerApi } from '../../src/adapters/localizer';
import type { LocalizerApi } from '../../src/adapters/localizer';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';

const globals = globalThis as unknown as Record<string, unknown>;

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    clearScripts();
    document.body.innerHTML = '';
    delete globals[DESRU_API_GLOBAL];
    delete globals[LOCALIZER_API_GLOBAL];
});

/** A DES-RU API double with the semantics of DES-RU src/maestro-api.js. */
function fakeDesRu(offered = ['bunnymo.structuralPatches', 'ck.consistencyRebuild', 'bunnymo.scanTags']) {
    let owned: string[] = [];
    const calls: string[][] = [];
    const listeners = new Set<() => void>();
    const api: DesRuApi = {
        version: 1,
        nameForms: (name) => (name ? [name, `${name}-форма`] : []),
        nameFormsKey: (name) => (name ? `/${name}/iu` : null),
        aliases: () => ({ Аня: ['Ани'] }),
        onNamesChanged(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        functions: () => [...offered],
        setMaestroOwned(ids) {
            calls.push(ids);
            owned = offered.filter((id) => ids.includes(id));
        },
        maestroOwned: () => [...owned],
    };
    return { api, calls, listeners };
}

describe('DesRuAdapter.api', () => {
    const NAME = 'third-party/SillyTavern-DES-RU';
    const MANIFEST = {
        display_name: "SillyTavern - Doom's Enhancement Suite - RU",
        version: '0.8.0',
        js: 'index.js',
        homePage: 'https://github.com/Likerch/SillyTavern-Doom-Enhancement-Suite-RU',
    };

    it('reads DESRU_API live and reports desru.api only while DES-RU is present', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.desru.ready();
        expect(adapters.desru.api()).toBeUndefined();
        await stand.caps.refresh();
        expect(stand.caps.has('desru.api')).toBe(false);

        const { api } = fakeDesRu();
        globals[DESRU_API_GLOBAL] = api;
        expect(adapters.desru.api()).toBe(api);
        expect(adapters.desru.api()?.nameForms('Аня')).toEqual(['Аня', 'Аня-форма']);
        await stand.caps.refresh();
        expect(stand.caps.has('desru.api')).toBe(true);
        expect(adapters.desru.capabilities()).toContain('desru.api');

        stand.disable(NAME);
        await stand.caps.refresh();
        expect(stand.caps.has('desru.api')).toBe(false);
    });

    it('rejects other versions and incomplete objects', () => {
        const { api } = fakeDesRu();
        expect(readDesRuApi(api)).toBe(api);
        expect(readDesRuApi({ ...api, version: 2 })).toBeUndefined();
        expect(readDesRuApi({ ...api, setMaestroOwned: undefined })).toBeUndefined();
        expect(readDesRuApi(null)).toBeUndefined();
        expect(readDesRuApi('DESRU')).toBeUndefined();
    });

    it('setMaestroOwned passes through only the functions DES-RU offers', () => {
        expect(adapters.desru.setMaestroOwned(['ck.consistencyRebuild'])).toBe(false);
        const { api, calls } = fakeDesRu(['ck.consistencyRebuild', 'bunnymo.scanTags']);
        globals[DESRU_API_GLOBAL] = api;
        expect(
            adapters.desru.setMaestroOwned([
                'ck.consistencyRebuild',
                'bunnymo.structuralPatches',
                'ck.consistencyRebuild',
            ]),
        ).toBe(true);
        expect(calls).toEqual([['ck.consistencyRebuild']]);
        expect(api.maestroOwned()).toEqual(['ck.consistencyRebuild']);
        expect(adapters.desru.setMaestroOwned([])).toBe(true);
        expect(api.maestroOwned()).toEqual([]);
    });

    it('claim and release keep what other modules own', () => {
        expect(adapters.desru.claim('ck.consistencyRebuild')).toBe(false);
        const { api } = fakeDesRu();
        globals[DESRU_API_GLOBAL] = api;
        expect(adapters.desru.claim('bunnymo.scanTags')).toBe(true);
        expect(adapters.desru.claim('ck.consistencyRebuild')).toBe(true);
        expect(api.maestroOwned().sort()).toEqual(['bunnymo.scanTags', 'ck.consistencyRebuild']);
        expect(adapters.desru.release('bunnymo.scanTags')).toBe(true);
        expect(api.maestroOwned()).toEqual(['ck.consistencyRebuild']);
    });

    it('setMaestroOwned survives a DES-RU that throws', () => {
        const { api } = fakeDesRu();
        globals[DESRU_API_GLOBAL] = {
            ...api,
            setMaestroOwned: () => {
                throw new TypeError('nope');
            },
        };
        expect(adapters.desru.setMaestroOwned(['bunnymo.scanTags'])).toBe(false);
    });
});

/** A Localizer API double with the semantics of LL src/api.js. */
function fakeLocalizer() {
    const jobs: { book: string; uids: number[]; options?: unknown }[] = [];
    const api: LocalizerApi = {
        version: 1,
        buildKeyRegex: (forms) => (forms.length ? `/${forms.join('|')}/iu` : null),
        buildPlainKeys: (forms) => [...forms],
        cleanForms: (forms) => forms.filter(Boolean),
        async localizeEntries(book, uids, options) {
            if (book === 'BunnyMo') throw new Error('"BunnyMo" is a BunnyMo book or pack, those are never localized');
            jobs.push({ book, uids, options });
            return { added: uids.length, entries: uids.length, failures: 0 };
        },
        isProtectedBook: async (book) => book === 'BunnyMo',
    };
    return { api, jobs };
}

describe('LocalizerAdapter.api', () => {
    const NAME = 'third-party/SillyTavern-LorebookLocalizer';
    const MANIFEST = {
        display_name: 'Lorebook Localizer',
        version: '0.2.0',
        js: 'index.js',
        homePage: 'https://github.com/Likerch/SillyTavern-LorebookLocalizer.git',
    };

    it('reads LOREBOOK_LOCALIZER_API live and reports localizer.api only while the Localizer is present', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.localizer.ready();
        expect(adapters.localizer.api()).toBeUndefined();
        await stand.caps.refresh();
        expect(stand.caps.has('localizer.api')).toBe(false);

        const { api, jobs } = fakeLocalizer();
        globals[LOCALIZER_API_GLOBAL] = api;
        await stand.caps.refresh();
        expect(stand.caps.has('localizer.api')).toBe(true);
        const localizer = adapters.localizer.api();
        expect(localizer).toBe(api);
        expect(await localizer?.localizeEntries('Мир', [3, 5], { language: 'ru' })).toEqual({
            added: 2,
            entries: 2,
            failures: 0,
        });
        expect(jobs).toEqual([{ book: 'Мир', uids: [3, 5], options: { language: 'ru' } }]);
        expect(await localizer?.isProtectedBook('BunnyMo')).toBe(true);
        await expect(localizer?.localizeEntries('BunnyMo', [1])).rejects.toThrow(/never localized/);
        expect(localizer?.buildKeyRegex([])).toBeNull();

        stand.disable(NAME);
        await stand.caps.refresh();
        expect(stand.caps.has('localizer.api')).toBe(false);
    });

    it('rejects other versions and incomplete objects', () => {
        const { api } = fakeLocalizer();
        expect(readLocalizerApi(api)).toBe(api);
        expect(readLocalizerApi({ ...api, version: '1' })).toBeUndefined();
        expect(readLocalizerApi({ ...api, isProtectedBook: 'no' })).toBeUndefined();
        expect(readLocalizerApi(undefined)).toBeUndefined();
    });
});
