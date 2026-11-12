// @vitest-environment happy-dom
// NAI Studio 0.16 through the NaiAdapter (release 1.33): every member is feature-detected through `features` and
// answers «no» without it; the illustrator's registration, who writes the markers, the rules, a reply's markers, an
// illustrator's marker, a picture into no message, a card's avatar, free-only backgrounds and scene poses.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';
import { installFakeNaiPersona, removeFakeNaiPersona } from '../helpers/nai-persona';

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    clearScripts();
    removeFakeNaiPersona();
});

const FEATURES = ['illustrator', 'requestImage', 'drawPicture', 'cardAvatar', 'backgroundFreeOnly', 'scenePoses'];

function install016(features = FEATURES) {
    const fake = installFakeNaiPersona();
    const calls: { name: string; args: unknown[] }[] = [];
    const record =
        (name: string, answer: unknown) =>
        (...args: unknown[]) => {
            calls.push({ name, args });
            return typeof answer === 'function' ? (answer as (...a: unknown[]) => unknown)(...args) : answer;
        };
    Object.assign(fake.api, {
        features: [...(fake.api.features as string[]), ...features],
        registerIllustrator: record('registerIllustrator', () => () => calls.push({ name: 'unregister', args: [] })),
        markerWriter: record('markerWriter', { setting: 'fallback', effective: 'nonsense' }),
        setMarkerWriter: record('setMarkerWriter', undefined),
        markerRules: record('markerRules', Promise.resolve('<images>R</images>')),
        messageMarkers: record('messageMarkers', [
            { imageId: 'a', marker: { prompt: 'p' }, status: 'done', path: 'user/images/x.png' },
            'junk',
        ]),
        requestImage: record('requestImage', Promise.resolve({ ok: true, imageId: 'img' })),
        drawPicture: record('drawPicture', Promise.resolve({ ok: false, error: 'free-only-blocked' })),
        generateCardAvatar: record('generateCardAvatar', Promise.resolve({ ok: true, backup: 'user/images/b.png' })),
    });
    return calls;
}

describe('NaiAdapter pictures (NAI Studio 0.16)', () => {
    it('answers «no» without NAI Studio or without the features', async () => {
        const nai = adapters.nai;
        expect(nai.canIllustrate()).toBe(false);
        expect(nai.markerWriter()).toBeNull();
        expect(nai.setMarkerWriter('illustrator')).toBe(false);
        expect(await nai.markerRules()).toBe('');
        expect(nai.messageMarkers(1)).toEqual([]);
        expect(await nai.requestImage({ messageIndex: 1, marker: { prompt: 'x' } })).toEqual({
            ok: false,
            error: 'unavailable',
        });
        expect(nai.canDrawPicture()).toBe(false);
        expect(nai.canCardAvatar()).toBe(false);
        expect(nai.canBackgroundFreeOnly()).toBe(false);
        expect(nai.canScenePoses()).toBe(false);
        const off = nai.registerIllustrator('maestro');
        expect(typeof off).toBe('function');
        // Members without their `features` entries do not count.
        install016([]);
        expect(nai.canIllustrate()).toBe(false);
        expect(nai.canCardAvatar()).toBe(false);
    });

    it('passes the requests on and reads the answers defensively', async () => {
        const calls = install016();
        const nai = adapters.nai;
        expect(nai.canIllustrate()).toBe(true);
        expect(nai.canDrawPicture()).toBe(true);
        expect(nai.canCardAvatar()).toBe(true);
        expect(nai.canBackgroundFreeOnly()).toBe(true);
        expect(nai.canScenePoses()).toBe(true);
        const off = nai.registerIllustrator('maestro');
        off();
        expect(calls.map((call) => call.name)).toEqual(['registerIllustrator', 'unregister']);
        expect(nai.markerWriter()).toEqual({ setting: 'fallback', effective: 'main' });
        expect(nai.setMarkerWriter('illustrator')).toBe(true);
        expect(await nai.markerRules()).toBe('<images>R</images>');
        expect(nai.messageMarkers(3)).toEqual([
            { imageId: 'a', marker: { prompt: 'p' }, status: 'done', path: 'user/images/x.png' },
        ]);
        expect(await nai.requestImage({ messageIndex: 3, marker: { prompt: 'x' }, freeOnly: true })).toEqual({
            ok: true,
            imageId: 'img',
        });
        expect(await nai.drawPicture({ marker: { prompt: 'x' } })).toEqual({ ok: false, error: 'free-only-blocked' });
        expect(await nai.generateCardAvatar({ avatar: 'Mira.png' })).toEqual({ ok: true, backup: 'user/images/b.png' });
        expect(calls.find((call) => call.name === 'requestImage')?.args[0]).toEqual({
            messageIndex: 3,
            marker: { prompt: 'x' },
            freeOnly: true,
        });
    });
});
