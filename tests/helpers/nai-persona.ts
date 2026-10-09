// A NAI Studio `NAI_STUDIO_API` double for M41 (persona for a character): version 1 with every 0.10.0 method, the
// 0.12.0 passport generator, and — with `personaKeys` — the members of the parallel NAI Studio change: `features`
// listing 'personaKeys', `getPersonaPassport(key)`, `savePassport(…, 'card', { personaKey })` for any persona and
// `generatePersonaAvatar({ personaKey, passport, signal })`. Records every call.
import type { NaiPassport, NaiPassportGenInput, NaiPersonaAvatarInput } from '../../src/adapters';
import { NAI_API_GLOBAL, NAI_INTERCEPTOR } from '../../src/adapters/nai';

const globals = globalThis as unknown as Record<string, unknown>;

export interface FakeNaiPersonaOptions {
    /** The parallel change is there: `features` lists 'personaKeys' and the members exist. Default true. */
    personaKeys?: boolean;
    /** `generatePassport` exists (NAI Studio 0.12.0+). Default true. */
    generator?: boolean;
    /** What the generator answers; null = it failed (a `requestFailed` event is emitted first). */
    generate?: (input: NaiPassportGenInput) => NaiPassport | null;
    /** What `generatePersonaAvatar` answers. */
    avatar?: (input: NaiPersonaAvatarInput) => { ok: boolean; path?: string; error?: string };
    /** `savePassport` rejects. */
    saveFails?: boolean;
}

export interface FakeNaiPersona {
    api: Record<string, unknown>;
    generated: NaiPassportGenInput[];
    saved: { passport: NaiPassport; scope: string; target: Record<string, unknown> | undefined }[];
    avatars: NaiPersonaAvatarInput[];
    /** Persona passports by key. */
    personas: Map<string, NaiPassport>;
}

export function generatedPassport(input: NaiPassportGenInput): NaiPassport {
    return {
        id: 'nai-gen-1',
        kind: 'character',
        name: input.name,
        aliases: [],
        tags: '',
        slots: { base: '1girl, adult', hair: 'blonde hair, braid', eyes: 'grey eyes', clothing: 'tunic' },
        outfits: [{ name: 'Default', tags: 'tunic, trousers' }],
        activeOutfit: '',
        states: [],
        negative: '',
    };
}

/** Puts the double on `globalThis` (with NAI Studio's interceptor, so the adapter sees it present). */
export function installFakeNaiPersona(options: FakeNaiPersonaOptions = {}): FakeNaiPersona {
    const personaKeys = options.personaKeys ?? true;
    const listeners = new Map<string, Set<(detail: unknown) => void>>();
    const fake: FakeNaiPersona = { api: {}, generated: [], saved: [], avatars: [], personas: new Map() };
    const emit = (event: string, detail: unknown) => listeners.get(event)?.forEach((listener) => listener(detail));
    const api: Record<string, unknown> = {
        version: 1,
        features: personaKeys ? ['excludePassport', 'requestDesPortrait', 'personaKeys'] : ['excludePassport'],
        passports: () => [],
        getPassport: () => null,
        savePassport: async (passport: NaiPassport, scope: string, target?: Record<string, unknown>) => {
            if (options.saveFails) throw new Error('NAI Studio API: cannot save');
            fake.saved.push({ passport: structuredClone(passport), scope, target });
            if (typeof target?.personaKey === 'string') fake.personas.set(target.personaKey, structuredClone(passport));
        },
        setOutfit: async () => {},
        setState: async () => {},
        clearChatOverride: async () => {},
        on: (event: string, listener: (detail: unknown) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
        },
        registerSceneProvider: () => () => {},
    };
    if (options.generator ?? true) {
        api.generatePassport = async (input: NaiPassportGenInput) => {
            fake.generated.push(structuredClone(input));
            const result = options.generate ? options.generate(input) : generatedPassport(input);
            if (!result) {
                emit('requestFailed', {
                    request: 'passport',
                    name: input.name,
                    code: 'nai',
                    message: 'не хватает Anlas',
                });
            }
            return result;
        };
    }
    if (personaKeys) {
        api.getPersonaPassport = (key: string) => structuredClone(fake.personas.get(key) ?? null);
        api.generatePersonaAvatar = async (input: NaiPersonaAvatarInput) => {
            fake.avatars.push({ ...input });
            return options.avatar ? options.avatar(input) : { ok: true, path: `User Avatars/${input.personaKey}` };
        };
    }
    fake.api = api;
    globals[NAI_API_GLOBAL] = api;
    globals[NAI_INTERCEPTOR] = () => {};
    return fake;
}

export function removeFakeNaiPersona(): void {
    delete globals[NAI_API_GLOBAL];
    delete globals[NAI_INTERCEPTOR];
}
