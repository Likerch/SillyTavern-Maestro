// A stand for adapter tests: the ST mock plus a minimal Host (caps, events, module loader), installed
// extensions with manifests, lorebooks, module scripts on the page (happy-dom) and a fake ES-module importer.
import type { Capabilities, CapabilityReport, Host, Logger } from '../../src/shared/contracts';
import { EVENT_TYPES, installStMock } from './st-mock';
import type { StMock } from './st-mock';

type Probe = () => boolean | Promise<boolean>;
type Namespace = Record<string, unknown>;

export class FakeCaps implements Capabilities {
    readonly probes = new Map<string, { probe: Probe; detail?: string }>();
    private readonly results = new Map<string, boolean>();

    register(id: string, probe: Probe, detail?: string): void {
        this.probes.set(id, { probe, detail });
    }

    has(id: string): boolean {
        return this.results.get(id) === true;
    }

    report(): CapabilityReport[] {
        return [...this.probes].map(([id, { detail }]) => ({ id, ok: this.has(id), detail }));
    }

    async refresh(): Promise<void> {
        for (const [id, { probe }] of this.probes) this.results.set(id, await probe());
    }
}

export const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    scope: () => silentLog,
};

export interface Manifest {
    display_name?: string;
    version?: string;
    js?: string;
    homePage?: string;
    generate_interceptor?: string;
}

export interface AdapterStand {
    mock: StMock;
    host: Host;
    caps: FakeCaps;
    /** Installed extensions: internal name → manifest (served by getExtensionManifest and extensions.js). */
    extensions: Map<string, Manifest>;
    /** Lorebooks served by loadWorldInfo / getWorldInfoNames. */
    books: Map<string, { entries: Record<string, Record<string, unknown>> }>;
    /** world-info.js live bindings. */
    worldInfo: { selected_world_info: string[]; world_info: { charLore: { name: string; extraBooks: string[] }[] } };
    /** Fake ES modules by absolute URL. */
    imports: Map<string, Namespace>;
    importedUrls: string[];
    importModule: (url: string) => Promise<Namespace>;
    /** Requests passed to the manifest fetch fallback. */
    fetched: string[];
    fetchManifest: (url: string) => Promise<Response>;
    loadCalls: string[];
    /** Makes extensions.js unavailable (host.modules.load rejects). */
    noExtensionList: boolean;
    /** Sets a context member that global.d.ts does not declare. */
    setCtx(key: string, value: unknown): void;
    disable(name: string): void;
    /** Installs an extension; `loaded` also puts its module script on the page. */
    install(name: string, manifest: Manifest, options?: { loaded?: boolean }): void;
    addScript(name: string, js?: string): void;
}

export const ORIGIN = 'http://localhost:8000';

export function scriptUrl(name: string, js = 'index.js'): string {
    return `${ORIGIN}/scripts/extensions/${name}/${js}`;
}

export function createStand(): AdapterStand {
    const mock = installStMock();
    const caps = new FakeCaps();
    const stand = {
        mock,
        caps,
        extensions: new Map<string, Manifest>(),
        books: new Map<string, { entries: Record<string, Record<string, unknown>> }>(),
        worldInfo: {
            selected_world_info: [] as string[],
            world_info: { charLore: [] as { name: string; extraBooks: string[] }[] },
        },
        imports: new Map<string, Namespace>(),
        importedUrls: [] as string[],
        fetched: [] as string[],
        loadCalls: [] as string[],
        noExtensionList: false,
    } as AdapterStand;

    const ctx = mock.context as unknown as Record<string, unknown>;
    stand.setCtx = (key, value) => {
        ctx[key] = value;
    };
    stand.setCtx('getExtensionManifest', (name: string) => {
        const manifest = stand.extensions.get(name) ?? stand.extensions.get(`third-party/${name}`);
        return manifest ? structuredClone(manifest) : null;
    });
    stand.setCtx('getWorldInfoNames', () => [...stand.books.keys()]);
    stand.setCtx('loadWorldInfo', async (name: string) => {
        const book = stand.books.get(name);
        return book ? structuredClone(book) : null;
    });
    mock.extensionSettings.disabledExtensions = [];

    stand.disable = (name) => {
        (mock.extensionSettings.disabledExtensions as string[]).push(name);
    };
    // happy-dom does not run scripts; without this it logs an error for every module script we add.
    const happyDom = (
        globalThis as unknown as { happyDOM?: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }
    ).happyDOM;
    if (happyDom) happyDom.settings.handleDisabledFileLoadingAsSuccess = true;
    stand.addScript = (name, js = 'index.js') => {
        const script = document.createElement('script');
        script.setAttribute('type', 'module');
        script.setAttribute('src', scriptUrl(name, js));
        document.head.append(script);
    };
    stand.install = (name, manifest, options = {}) => {
        stand.extensions.set(name, manifest);
        if (options.loaded) stand.addScript(name, manifest.js);
    };
    stand.importModule = async (url) => {
        stand.importedUrls.push(url);
        const namespace = stand.imports.get(url);
        if (!namespace) throw new Error(`no module at ${url}`);
        return namespace;
    };
    stand.fetchManifest = async (url) => {
        stand.fetched.push(url);
        const match = /\/scripts\/extensions\/(.+)\/manifest\.json$/.exec(url);
        const manifest = match?.[1] ? stand.extensions.get(decodeURIComponent(match[1])) : undefined;
        return manifest
            ? new Response(JSON.stringify(manifest), { status: 200 })
            : new Response('nope', { status: 404 });
    };

    const host: Host = {
        ctx: () => SillyTavern.getContext(),
        events: {
            on(event, handler) {
                mock.eventSource.on(event, handler);
                return () => mock.eventSource.removeListener(event, handler);
            },
            reassertOrder() {},
            emit: (event, ...args) => mock.eventSource.emit(event, ...args),
            name: (key) => EVENT_TYPES[key],
        },
        modules: {
            worldInfo: async () => stand.worldInfo as unknown as Namespace,
            script: async () => ({}),
            openai: async () => ({}),
            presetManager: async () => ({}),
            chats: async () => ({}),
            regexEngine: async () => ({}),
            utils: async () => ({}),
            load: async (path) => {
                stand.loadCalls.push(path);
                if (path === 'extensions.js' && !stand.noExtensionList)
                    return { extensionNames: [...stand.extensions.keys()] };
                throw new Error(`no module ${path}`);
            },
        },
        caps,
        fetchGate: { beforeRequest: () => () => {}, afterResponse: () => () => {} },
        version: () => '1.19.0',
        chatId: () => mock.chatId ?? null,
        isGroupChat: () => !!mock.context.groupId,
        isChatCompletion: () => mock.context.mainApi === 'openai',
    };
    stand.host = host;
    return stand;
}

/** Removes the module scripts added by a test. */
export function clearScripts(): void {
    for (const script of document.querySelectorAll('script')) script.remove();
}
