// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionLocator, adaptersOf, createAdapters } from '../../src/adapters';
import type { NeighbourAdapter } from '../../src/shared/contracts';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';

afterEach(() => clearScripts());

const ALL_CAPABILITIES = [
    'des.present',
    'des.state',
    'des.enabled',
    'des.together',
    'des.lore',
    'desru.present',
    'desru.names',
    'desru.bunnymo',
    'desru.carrotKernel',
    'desru.api',
    'ck.present',
    'ck.repos',
    'ck.rag',
    'bunnymo.core',
    'bunnymo.packs',
    'bunnymo.archives',
    'qvink.present',
    'qvink.chat',
    'qvink.removeMessages',
    'nai.present',
    'nai.api',
    'nai.qualityGate',
    'localizer.present',
    'localizer.api',
    'preset.cc',
    'preset.marinara',
];

describe('createAdapters', () => {
    it('builds all eight adapters and registers every capability', async () => {
        const stand = createStand();
        const adapters = createAdapters(stand.host, silentLog, {
            importModule: stand.importModule,
            fetch: stand.fetchManifest,
        });
        const record: Record<NeighbourAdapter['id'], NeighbourAdapter> = adapters;
        expect(Object.keys(record)).toEqual(['des', 'desru', 'ck', 'bunnymo', 'qvink', 'nai', 'localizer', 'preset']);
        for (const [id, adapter] of Object.entries(record)) expect(adapter.id).toBe(id);
        expect([...stand.caps.probes.keys()]).toEqual(ALL_CAPABILITIES);
        expect(Object.values(adapters).flatMap((adapter) => adapter.capabilityIds())).toEqual(ALL_CAPABILITIES);

        // Nothing installed: every adapter settles and reports nothing.
        await Promise.all(Object.values(record).map((adapter) => adapter.ready()));
        await stand.caps.refresh();
        expect(stand.caps.report().filter((cap) => cap.ok)).toEqual([]);
        for (const adapter of Object.values(record)) {
            expect(adapter.present()).toBe(false);
            expect(adapter.capabilities()).toEqual([]);
        }
        // The extension list is read once for every adapter.
        expect(stand.loadCalls).toEqual(['extensions.js']);
    });

    it('gives features a typed view of app.adapters', () => {
        const stand = createStand();
        const adapters = createAdapters(stand.host, silentLog, {
            importModule: stand.importModule,
            fetch: stand.fetchManifest,
        });
        const app: { adapters: Record<NeighbourAdapter['id'], NeighbourAdapter> } = { adapters };
        expect(adaptersOf(app).des.knownCharacters()).toEqual([]);
    });

    it('uses the default fetch when no seam is given', () => {
        const stand = createStand();
        expect(() => createAdapters(stand.host, silentLog)).not.toThrow();
    });
});

describe('ExtensionLocator', () => {
    it('resolves relative script sources against the page and ignores broken ones', () => {
        const stand = createStand();
        const locator = new ExtensionLocator(stand.host, silentLog, stand.fetchManifest);
        const base = document.createElement('base');
        base.href = 'http://st.local/';
        document.head.append(base);
        for (const src of ['', 'http://[broken', '/scripts/extensions/third-party/My%20Ext/dist/index.js']) {
            const script = document.createElement('script');
            script.setAttribute('type', 'module');
            script.setAttribute('src', src);
            document.head.append(script);
        }
        const found = locator.scriptOf({ name: 'third-party/My Ext', manifest: { js: 'dist/index.js' } });
        expect(found).toBe('http://st.local/scripts/extensions/third-party/My%20Ext/dist/index.js');
        expect(locator.scriptOf({ name: 'third-party/Other', manifest: {} })).toBeNull();
        base.remove();
    });

    it('lists page scripts when ST has no extension list, and memoises manifests', async () => {
        const stand = createStand();
        stand.noExtensionList = true;
        stand.setCtx('getExtensionManifest', () => {
            throw new Error('broken');
        });
        stand.install('third-party/Loaded', { display_name: 'Loaded', version: '1' }, { loaded: true });
        stand.install('third-party/Known', { display_name: 'Known', version: '2' });
        const locator = new ExtensionLocator(stand.host, silentLog, stand.fetchManifest);
        expect(await locator.names()).toEqual(['third-party/Loaded']);
        expect(await locator.find((m) => m.display_name === 'Known', ['third-party/Known'])).toEqual({
            name: 'third-party/Known',
            manifest: { display_name: 'Known', version: '2' },
        });
        expect(await locator.find((m) => m.display_name === 'Missing', ['third-party/Nope'])).toBeNull();
        await locator.manifest('third-party/Loaded');
        expect(stand.fetched).toEqual([
            '/scripts/extensions/third-party/Loaded/manifest.json',
            '/scripts/extensions/third-party/Known/manifest.json',
            '/scripts/extensions/third-party/Nope/manifest.json',
        ]);
    });

    it('survives a failing fetch and junk manifests', async () => {
        const stand = createStand();
        stand.setCtx('getExtensionManifest', () => 'junk');
        const failing = new ExtensionLocator(stand.host, silentLog, async () => {
            throw new Error('offline');
        });
        expect(await failing.manifest('third-party/X')).toBeNull();
        stand.setCtx('getExtensionManifest', undefined);
        expect(await failing.manifest('third-party/Y')).toBeNull();
        expect(failing.isDisabled('third-party/X')).toBe(false);
    });
});
