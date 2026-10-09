// @vitest-environment happy-dom
// NAI Studio's personas by key (feature 'personaKeys', M41) through the NaiAdapter: feature-detected (the `features`
// entry and both members), the persona passport read and saved by its avatar file key, the avatar drawn for it; every
// member answers «no» without the feature; the generator gets `persona: true` passed on.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters, NaiPassport } from '../../src/adapters';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';
import { generatedPassport, installFakeNaiPersona, removeFakeNaiPersona } from '../helpers/nai-persona';

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

const passport = (): NaiPassport => ({
    ...generatedPassport({ name: 'Мира', kind: 'character', description: '' }),
    outfits: [{ name: 'Повседневный', tags: 'linen shirt', looks: ['льняная рубаха'] }],
    activeOutfit: 'Повседневный',
});

describe('NaiAdapter personas by key', () => {
    it('answers «no» without NAI Studio or without the feature', async () => {
        expect(adapters.nai.canUsePersonaKeys()).toBe(false);
        expect(adapters.nai.personaPassport('1-Mira.png')).toBeNull();
        expect(await adapters.nai.savePersonaPassport('1-Mira.png', passport())).toBe(false);
        expect(await adapters.nai.generatePersonaAvatar({ personaKey: '1-Mira.png' })).toEqual({
            ok: false,
            error: 'unavailable',
        });
        const fake = installFakeNaiPersona({ personaKeys: false });
        expect(adapters.nai.canUsePersonaKeys()).toBe(false);
        expect(await adapters.nai.savePersonaPassport('1-Mira.png', passport())).toBe(false);
        expect(fake.saved).toEqual([]);
        // The members without the `features` entry do not count either.
        fake.api.getPersonaPassport = () => null;
        fake.api.generatePersonaAvatar = async () => ({ ok: true });
        expect(adapters.nai.canUsePersonaKeys()).toBe(false);
    });

    it('reports nai.personaKeys only with the feature while NAI Studio is present', async () => {
        await stand.caps.refresh();
        expect(stand.caps.has('nai.personaKeys')).toBe(false);
        installFakeNaiPersona();
        await stand.caps.refresh();
        expect(stand.caps.has('nai.personaKeys')).toBe(true);
        removeFakeNaiPersona();
        await stand.caps.refresh();
        expect(stand.caps.has('nai.personaKeys')).toBe(false);
    });

    it('saves and reads the passport of any persona by its key', async () => {
        const fake = installFakeNaiPersona();
        expect(adapters.nai.canUsePersonaKeys()).toBe(true);
        expect(await adapters.nai.savePersonaPassport('1-Mira.png', passport())).toBe(true);
        expect(fake.saved).toEqual([{ passport: passport(), scope: 'card', target: { personaKey: '1-Mira.png' } }]);
        const read = adapters.nai.personaPassport('1-Mira.png');
        expect(read?.outfits).toEqual([{ name: 'Повседневный', tags: 'linen shirt', looks: ['льняная рубаха'] }]);
        expect(read?.activeOutfit).toBe('Повседневный');
        expect(adapters.nai.personaPassport('2-Other.png')).toBeNull();
        expect(adapters.nai.personaPassport('')).toBeNull();
        expect(await adapters.nai.savePersonaPassport('', passport())).toBe(false);
    });

    it('is false when NAI Studio refuses to save', async () => {
        installFakeNaiPersona({ saveFails: true });
        expect(await adapters.nai.savePersonaPassport('1-Mira.png', passport())).toBe(false);
    });

    it('draws the avatar of a persona and passes NAI Studio errors on', async () => {
        const controller = new AbortController();
        const fake = installFakeNaiPersona();
        expect(
            await adapters.nai.generatePersonaAvatar({
                personaKey: '1-Mira.png',
                passport: passport(),
                signal: controller.signal,
            }),
        ).toEqual({ ok: true, path: 'User Avatars/1-Mira.png' });
        expect(fake.avatars[0]?.personaKey).toBe('1-Mira.png');
        expect(fake.avatars[0]?.signal).toBe(controller.signal);
        expect(fake.avatars[0]?.passport?.activeOutfit).toBe('Повседневный');

        installFakeNaiPersona({ avatar: () => ({ ok: false, error: 'free-only: the picture would cost Anlas' }) });
        expect(await adapters.nai.generatePersonaAvatar({ personaKey: '1-Mira.png' })).toEqual({
            ok: false,
            error: 'free-only: the picture would cost Anlas',
        });
        const thrown = installFakeNaiPersona();
        thrown.api.generatePersonaAvatar = async () => {
            throw new Error('NAI Studio API: boom');
        };
        expect(await adapters.nai.generatePersonaAvatar({ personaKey: '1-Mira.png' })).toEqual({
            ok: false,
            error: 'NAI Studio API: boom',
        });
        const junk = installFakeNaiPersona();
        junk.api.generatePersonaAvatar = async () => 'yes';
        expect(await adapters.nai.generatePersonaAvatar({ personaKey: '1-Mira.png' })).toEqual({
            ok: false,
            error: 'no answer',
        });
        expect(await adapters.nai.generatePersonaAvatar({ personaKey: '' })).toEqual({
            ok: false,
            error: 'unavailable',
        });
    });

    it('passes the persona flag to the passport generator', async () => {
        const fake = installFakeNaiPersona();
        const result = await adapters.nai.generatePassport({
            name: 'Мира',
            kind: 'character',
            description: 'adult woman',
            language: 'ru',
            persona: true,
        });
        expect(result?.name).toBe('Мира');
        expect(fake.generated).toEqual([
            { name: 'Мира', kind: 'character', description: 'adult woman', language: 'ru', persona: true },
        ]);
    });
});
