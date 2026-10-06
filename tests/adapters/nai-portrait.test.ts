// @vitest-environment happy-dom
// NAI Studio 0.14.0 `requestDesPortrait(name, {reason})` through the NaiAdapter (release 1.11, wardrobe): feature
// detected (the method, and 'requestDesPortrait' in `features` when NAI Studio lists them), false whenever it cannot.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { NAI_API_GLOBAL } from '../../src/adapters/nai';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';

const globals = globalThis as unknown as Record<string, unknown>;

let adapters: Adapters;

function api(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const noop = () => {};
    return {
        version: 1,
        passports: () => [],
        getPassport: () => null,
        savePassport: async () => {},
        setOutfit: async () => {},
        setState: async () => {},
        clearChatOverride: async () => {},
        on: () => noop,
        registerSceneProvider: () => noop,
        ...extra,
    };
}

beforeEach(() => {
    const stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    clearScripts();
    delete globals[NAI_API_GLOBAL];
});

describe('NaiAdapter.requestDesPortrait', () => {
    it('is false without NAI Studio or without the 0.14 member', async () => {
        expect(adapters.nai.canRequestDesPortrait()).toBe(false);
        expect(await adapters.nai.requestDesPortrait('Офелия')).toBe(false);
        globals[NAI_API_GLOBAL] = api();
        expect(adapters.nai.canRequestDesPortrait()).toBe(false);
        expect(await adapters.nai.requestDesPortrait('Офелия')).toBe(false);
    });

    it('asks NAI Studio when the feature is listed (or the list is absent)', async () => {
        const calls: unknown[][] = [];
        const requestDesPortrait = async (...args: unknown[]) => {
            calls.push(args);
            return args[0] !== 'Кай';
        };
        globals[NAI_API_GLOBAL] = api({ requestDesPortrait, features: ['excludePassport', 'requestDesPortrait'] });
        expect(adapters.nai.canRequestDesPortrait()).toBe(true);
        expect(await adapters.nai.requestDesPortrait(' Офелия ', { reason: 'outfit' })).toBe(true);
        expect(await adapters.nai.requestDesPortrait('Кай')).toBe(false);
        expect(await adapters.nai.requestDesPortrait('  ')).toBe(false);
        expect(calls).toEqual([
            ['Офелия', { reason: 'outfit' }],
            ['Кай', {}],
        ]);
        globals[NAI_API_GLOBAL] = api({ requestDesPortrait });
        expect(await adapters.nai.requestDesPortrait('Офелия')).toBe(true);
    });

    it('is false when the feature list leaves it out or NAI Studio fails', async () => {
        globals[NAI_API_GLOBAL] = api({ requestDesPortrait: async () => true, features: ['excludePassport'] });
        expect(adapters.nai.canRequestDesPortrait()).toBe(false);
        expect(await adapters.nai.requestDesPortrait('Офелия')).toBe(false);
        globals[NAI_API_GLOBAL] = api({
            requestDesPortrait: async () => {
                throw new Error('NAI Studio API: boom');
            },
        });
        expect(await adapters.nai.requestDesPortrait('Офелия')).toBe(false);
    });
});
