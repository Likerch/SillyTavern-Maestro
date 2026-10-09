import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES, createCapabilities, registerBuiltinProbes } from '../../src/host/caps';
import type { HostModules } from '../../src/shared/contracts';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { memoryLogger, settle } from '../helpers/host-fakes';

describe('capability registry', () => {
    it('runs sync and async probes on refresh and reports them', async () => {
        const caps = createCapabilities(memoryLogger());
        caps.register('a', () => true);
        caps.register('b', async () => false, 'needs b');
        caps.probe('c', async () => ({ ok: true, detail: 'v2' }));
        expect(caps.has('a')).toBe(false);
        expect(caps.report()).toEqual([
            { id: 'a', ok: false, detail: 'not probed yet' },
            { id: 'b', ok: false, detail: 'not probed yet' },
            { id: 'c', ok: false, detail: 'not probed yet' },
        ]);
        await caps.refresh();
        expect(caps.has('a')).toBe(true);
        expect(caps.has('b')).toBe(false);
        expect(caps.has('c')).toBe(true);
        expect(caps.has('missing')).toBe(false);
        expect(caps.report()).toEqual([
            { id: 'a', ok: true },
            { id: 'b', ok: false, detail: 'needs b' },
            { id: 'c', ok: true, detail: 'v2' },
        ]);
    });

    it('never throws: exceptions and rejections become missing capabilities', async () => {
        const caps = createCapabilities(memoryLogger());
        caps.register('sync', () => {
            throw new Error('sync failure');
        });
        caps.register('async', () => Promise.reject(new Error('import failed')));
        caps.probe('weird', () => ({}) as unknown as boolean);
        await expect(caps.refresh()).resolves.toBeUndefined();
        expect(caps.report()).toEqual([
            { id: 'sync', ok: false, detail: 'sync failure' },
            { id: 'async', ok: false, detail: 'import failed' },
            { id: 'weird', ok: false, detail: 'probe returned no result' },
        ]);
    });

    it('probes late registrations right away and re-probes on refresh', async () => {
        const caps = createCapabilities(memoryLogger());
        await caps.refresh();
        let value = true;
        caps.register('late', () => value);
        await settle();
        expect(caps.has('late')).toBe(true);
        value = false;
        await caps.refresh();
        expect(caps.has('late')).toBe(false);
        caps.unregister('late');
        expect(caps.report()).toEqual([]);
    });

    it('drops a stale async result after re-registration', async () => {
        const caps = createCapabilities(memoryLogger());
        let resolveSlow!: (value: boolean) => void;
        caps.register('x', () => new Promise<boolean>((resolve) => (resolveSlow = resolve)));
        const refreshing = caps.refresh();
        caps.register('x', () => false);
        resolveSlow(true);
        await refreshing;
        await settle();
        expect(caps.has('x')).toBe(false);
    });
});

describe('built-in probes', () => {
    let mock: StMock;

    beforeEach(() => {
        mock = installStMock();
    });

    function fakeModules(
        overrides: Partial<Record<keyof HostModules, Record<string, unknown> | Error>> = {},
        loaded: Record<string, Record<string, unknown> | Error> = {},
    ): HostModules {
        const defaults: Record<string, Record<string, unknown>> = {
            worldInfo: { getSortedEntries: () => [], checkWorldInfo: () => ({}), world_info_position: { before: 0 } },
            script: { doNavbarIconClick: () => {} },
            openai: { promptManager: null, getChatCompletionPreset: () => ({}) },
            presetManager: { getPresetManager: () => ({}) },
            chats: { hideChatMessageRange: async () => {} },
            regexEngine: { getRegexScripts: () => [] },
            utils: {},
        };
        const get = (key: keyof HostModules) => async () => {
            const value = overrides[key] ?? defaults[key] ?? {};
            if (value instanceof Error) throw value;
            return value;
        };
        return {
            worldInfo: get('worldInfo'),
            script: get('script'),
            openai: get('openai'),
            presetManager: get('presetManager'),
            chats: get('chats'),
            regexEngine: get('regexEngine'),
            utils: get('utils'),
            load: async (path: string) => {
                const byPath: Record<string, Record<string, unknown> | Error> = {
                    '/scripts/personas.js': {
                        initPersona: async () => {},
                        getUserAvatars: async () => [],
                        setUserAvatar: async () => {},
                        user_avatar: 'user-default.png',
                    },
                    ...loaded,
                };
                const value = byPath[path] ?? {};
                if (value instanceof Error) throw value;
                return value;
            },
        };
    }

    async function probe(modules: HostModules, version: string | null = '1.19.0') {
        const caps = createCapabilities(memoryLogger());
        registerBuiltinProbes(caps, {
            ctx: () => SillyTavern.getContext(),
            modules,
            version: async () => version ?? undefined,
        });
        await caps.refresh();
        return caps;
    }

    it('registers every documented id', async () => {
        const caps = await probe(fakeModules());
        expect(caps.report().map((entry) => entry.id)).toEqual([...BUILTIN_CAPABILITIES]);
    });

    it('reports a healthy ST 1.19', async () => {
        const context = mock.context as unknown as Record<string, unknown>;
        context['messageFormatter'] = { addHook: () => {} };
        context['powerUserSettings'] = { experimental_macro_engine: true };
        mock.extensionSettings['disabledExtensions'] = [];
        const caps = await probe(fakeModules());
        const missing = caps.report().filter((entry) => !entry.ok);
        expect(missing).toEqual([]);
        expect(caps.report().find((entry) => entry.id === 'st.events.scanDone')?.detail).toBe('worldinfo_scan_done');
        expect(caps.report().find((entry) => entry.id === 'st.version.1.19')?.detail).toBe('1.19.0');
    });

    it('degrades per capability', async () => {
        const context = mock.context as unknown as Record<string, unknown>;
        context['mainApi'] = 'textgenerationwebui';
        context['eventTypes'] = { ...mock.context.eventTypes, WORLDINFO_FORCE_ACTIVATE: undefined };
        context['powerUserSettings'] = { experimental_macro_engine: false };
        mock.extensionSettings['disabledExtensions'] = ['connection-manager'];
        const caps = await probe(
            fakeModules(
                {
                    worldInfo: { getSortedEntries: () => [], checkWorldInfo: 'not a function' },
                    regexEngine: new Error('404'),
                },
                { '/scripts/personas.js': { initPersona: async () => {}, user_avatar: '' } },
            ),
            '1.20.1',
        );
        const byId = new Map(caps.report().map((entry) => [entry.id, entry]));
        expect(byId.get('st.chatCompletion')).toEqual({
            id: 'st.chatCompletion',
            ok: false,
            detail: 'main API is textgenerationwebui',
        });
        expect(byId.get('st.events.forceActivate')?.ok).toBe(false);
        expect(byId.get('st.events.scanDone')?.ok).toBe(true);
        expect(byId.get('st.cm')?.detail).toBe('the Connection Manager extension is disabled');
        expect(byId.get('st.messageFormatter')?.ok).toBe(false);
        expect(byId.get('st.macros.newEngine')?.detail).toBe('experimental_macro_engine is off');
        expect(byId.get('st.wi.module')).toEqual({
            id: 'st.wi.module',
            ok: false,
            detail: 'missing exports: checkWorldInfo, world_info_position',
        });
        expect(byId.get('st.regex')).toEqual({ id: 'st.regex', ok: false, detail: '404' });
        expect(byId.get('st.oai.promptManager')?.ok).toBe(true);
        expect(byId.get('st.version.1.19')).toEqual({
            id: 'st.version.1.19',
            ok: false,
            detail: 'ST 1.20.1; Maestro is tested with 1.19',
        });
        expect(byId.get('st.files')?.ok).toBe(true);
        expect(byId.get('st.personas')).toEqual({
            id: 'st.personas',
            ok: false,
            detail: 'missing exports: getUserAvatars, setUserAvatar',
        });
    });

    it('assumes 1.19 when the version is unknown', async () => {
        const caps = await probe(fakeModules(), null);
        expect(caps.report().find((entry) => entry.id === 'st.version.1.19')).toEqual({
            id: 'st.version.1.19',
            ok: true,
            detail: 'ST version unknown; assuming 1.19',
        });
    });

    it('does not wait forever for the version', async () => {
        const caps = createCapabilities(memoryLogger());
        registerBuiltinProbes(caps, {
            ctx: () => SillyTavern.getContext(),
            modules: fakeModules(),
            version: () => new Promise(() => {}),
            versionTimeoutMs: 10,
        });
        await caps.refresh();
        expect(caps.has('st.version.1.19')).toBe(true);
    });
});
