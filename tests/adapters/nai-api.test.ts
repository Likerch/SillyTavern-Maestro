// @vitest-environment happy-dom
// NAI Studio 0.10.0 `NAI_STUDIO_API` (plan §16, stage 3) as the NaiAdapter exposes it: read live, only version 1
// with every method, `nai.api` only while NAI Studio is present; chat passports as typed copies; events passed through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters, NaiPassport, NaiSceneProvider, NaiStudioApi, NaiStudioEvents } from '../../src/adapters';
import { NAI_API_GLOBAL, NAI_INTERCEPTOR, readNaiApi } from '../../src/adapters/nai';
import { clearScripts, createStand, silentLog } from '../helpers/adapters-host';
import type { AdapterStand } from '../helpers/adapters-host';

const globals = globalThis as unknown as Record<string, unknown>;

const NAME = 'third-party/SillyTavern-NAI-Studio';
const MANIFEST = {
    display_name: 'NAI Studio',
    version: '0.10.0',
    js: 'dist/index.js',
    generate_interceptor: 'NAIST_ProcessTriggers',
};

let stand: AdapterStand;
let adapters: Adapters;

beforeEach(() => {
    stand = createStand();
    adapters = createAdapters(stand.host, silentLog, { importModule: stand.importModule, fetch: stand.fetchManifest });
});

afterEach(() => {
    clearScripts();
    document.body.innerHTML = '';
    delete globals[NAI_API_GLOBAL];
    delete globals[NAI_INTERCEPTOR];
});

function passport(id: string, name: string, extra: Partial<NaiPassport> = {}): NaiPassport {
    return {
        id,
        kind: 'character',
        name,
        aliases: [],
        tags: '',
        slots: { hair: 'silver hair' },
        outfits: [{ name: 'Armor', tags: 'armor' }],
        activeOutfit: '',
        states: [{ id: 'wet', tags: 'wet', enabled: false }],
        negative: '',
        ...extra,
    };
}

/** A NAI Studio API double with the semantics of NAI src/integration/public-api.ts (chat overrides by id). */
function fakeNai() {
    const card: NaiPassport[] = [passport('p1', ''), passport('p2', 'Bram')];
    const chatOwn: NaiPassport[] = [];
    const overrides = new Map<string, Partial<NaiPassport>>();
    const listeners = { passportsSaved: new Set<(d: unknown) => void>(), imageReady: new Set<(d: unknown) => void>() };
    const providers: NaiSceneProvider[] = [];
    const emit = <K extends keyof NaiStudioEvents>(event: K, detail: NaiStudioEvents[K]) =>
        listeners[event].forEach((listener) => listener(structuredClone(detail)));
    const resolved = (p: NaiPassport) => structuredClone({ ...p, ...overrides.get(p.id) });
    const find = (id: string) => card.find((p) => p.id === id) ?? chatOwn.find((p) => p.id === id);
    const api: NaiStudioApi = {
        version: 1,
        passports: (scope) => {
            if (scope?.chat) return chatOwn.map(resolved);
            return [...card, ...chatOwn].map(resolved);
        },
        getPassport: (id) => {
            const found = find(id);
            return found ? resolved(found) : null;
        },
        savePassport: async (p, scope) => {
            if (scope === 'chat' && !card.some((c) => c.id === p.id)) chatOwn.push(structuredClone(p));
            else if (scope === 'chat') overrides.set(p.id, { ...overrides.get(p.id), ...structuredClone(p) });
            else card.splice(card.findIndex((c) => c.id === p.id) >>> 0, 1, structuredClone(p));
            emit('passportsSaved', { ids: [p.id], scope });
        },
        setOutfit: async (id, outfit, scope = 'chat') => {
            const found = find(id);
            if (!found) throw new Error(`NAI Studio API: no passport "${id}" in this chat`);
            if (outfit && !found.outfits.some((o) => o.name === outfit))
                throw new Error(`NAI Studio API: passport "${id}" has no outfit "${outfit}"`);
            if (scope === 'chat') overrides.set(id, { ...overrides.get(id), activeOutfit: outfit });
            else found.activeOutfit = outfit;
            emit('passportsSaved', { ids: [id], scope });
        },
        setState: async (id, stateId, enabled, scope = 'chat') => {
            const view = resolved(find(id)!);
            const states = view.states.map((s) => (s.id === stateId ? { ...s, enabled } : s));
            overrides.set(id, { ...overrides.get(id), states });
            emit('passportsSaved', { ids: [id], scope });
        },
        clearChatOverride: async (id) => {
            overrides.delete(id);
            emit('passportsSaved', { ids: [id], scope: 'chat' });
        },
        on: (event, listener) => {
            const set = listeners[event] as Set<(d: unknown) => void>;
            set.add(listener as (d: unknown) => void);
            return () => void set.delete(listener as (d: unknown) => void);
        },
        registerSceneProvider: (provider) => {
            providers.push(provider);
            return () => void providers.splice(providers.indexOf(provider) >>> 0, 1);
        },
    };
    return { api, card, overrides, providers, emit };
}

describe('NaiAdapter.api', () => {
    it('reads NAI_STUDIO_API live and reports nai.api only while NAI Studio is present', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.nai.ready();
        expect(adapters.nai.api()).toBeUndefined();
        expect(adapters.nai.chatPassports()).toEqual([]);
        const unsubscribe = adapters.nai.on('imageReady', () => {});
        expect(unsubscribe).toBeTypeOf('function');
        unsubscribe();

        const { api } = fakeNai();
        globals[NAI_API_GLOBAL] = api;
        await stand.caps.refresh();
        // Published but the interceptor is not there: not present, so no API capability.
        expect(stand.caps.has('nai.api')).toBe(false);
        globals[NAI_INTERCEPTOR] = () => {};
        await stand.caps.refresh();
        expect(stand.caps.has('nai.present')).toBe(true);
        expect(stand.caps.has('nai.api')).toBe(true);
        expect(adapters.nai.api()).toBe(api);
        expect(adapters.nai.capabilities()).toEqual(['nai.present', 'nai.api']);

        stand.disable(NAME);
        await stand.caps.refresh();
        expect(stand.caps.has('nai.api')).toBe(false);
    });

    it('accepts only version 1 with every method', () => {
        const { api } = fakeNai();
        expect(readNaiApi(api)).toBe(api);
        expect(readNaiApi({ ...api, version: 2 })).toBeUndefined();
        expect(readNaiApi({ ...api, version: '1' })).toBeUndefined();
        expect(readNaiApi({ ...api, registerSceneProvider: undefined })).toBeUndefined();
        expect(readNaiApi(null)).toBeUndefined();
        expect(readNaiApi('NAI_STUDIO_API')).toBeUndefined();
    });

    it('gives the chat passports as typed copies and passes events through', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.nai.ready();
        globals[NAI_INTERCEPTOR] = () => {};
        const fake = fakeNai();
        globals[NAI_API_GLOBAL] = fake.api;

        const saved: NaiStudioEvents['passportsSaved'][] = [];
        const off = adapters.nai.on('passportsSaved', (detail) => saved.push(detail));
        const api = adapters.nai.api()!;
        await api.setOutfit('p2', 'Armor');
        await api.setState('p2', 'wet', true);
        expect(saved).toEqual([
            { ids: ['p2'], scope: 'chat' },
            { ids: ['p2'], scope: 'chat' },
        ]);
        await expect(api.setOutfit('p2', 'Spacesuit')).rejects.toThrow(/no outfit/);

        const list = adapters.nai.chatPassports();
        expect(list.map((p) => [p.id, p.activeOutfit])).toEqual([
            ['p1', ''],
            ['p2', 'Armor'],
        ]);
        expect(list[1]!.states).toEqual([{ id: 'wet', tags: 'wet', enabled: true }]);
        list[1]!.activeOutfit = 'changed';
        expect(api.getPassport('p2')!.activeOutfit).toBe('Armor');

        await api.savePassport(passport('c1', 'Guard'), 'chat');
        expect(adapters.nai.chatPassports({ chat: true }).map((p) => p.name)).toEqual(['Guard']);
        await api.clearChatOverride('p2');
        expect(adapters.nai.chatPassports()[1]!.activeOutfit).toBe('');

        const images: NaiStudioEvents['imageReady'][] = [];
        adapters.nai.on('imageReady', (detail) => images.push(detail));
        fake.emit('imageReady', { messageIndex: 3, kind: 'marker', passportIds: ['p2'] });
        expect(images).toEqual([{ messageIndex: 3, kind: 'marker', passportIds: ['p2'] }]);

        off();
        await api.setOutfit('p1', '');
        expect(saved).toHaveLength(4);

        const unregister = api.registerSceneProvider({
            id: 'maestro',
            priority: 10,
            describe: ({ messageIndex }) => ({ locationId: `pl${messageIndex}` }),
        });
        expect(fake.providers).toHaveLength(1);
        expect(await fake.providers[0]!.describe({ messageIndex: 2, text: '' })).toEqual({ locationId: 'pl2' });
        unregister();
        expect(fake.providers).toHaveLength(0);
    });

    it('survives a throwing or junk passports()', async () => {
        stand.install(NAME, MANIFEST, { loaded: true });
        await adapters.nai.ready();
        const { api } = fakeNai();
        globals[NAI_API_GLOBAL] = {
            ...api,
            passports: vi.fn(() => {
                throw new Error('boom');
            }),
        };
        expect(adapters.nai.chatPassports()).toEqual([]);
        globals[NAI_API_GLOBAL] = { ...api, passports: () => 'junk' };
        expect(adapters.nai.chatPassports()).toEqual([]);
        globals[NAI_API_GLOBAL] = { ...api, passports: () => [passport('x', 'X'), 'junk'] };
        expect(adapters.nai.chatPassports().map((p) => p.id)).toEqual(['x']);
    });
});
