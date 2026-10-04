// A small App for M1/M2 feature tests: the ST mock, a test host with fake ST modules (world-info.js, openai.js,
// script.js), a real bus and i18n, an in-memory chat store, fake adapters and a UI fake that keeps tabs.
import { createBus } from '../../src/core/bus';
import { createI18n } from '../../src/core/i18n';
import type {
    App,
    ChatStore,
    GenerationInfo,
    I18nParts,
    MaestroModule,
    ModuleManager,
    PultTab,
    SettingsService,
    Ui,
    Unsubscribe,
} from '../../src/shared/contracts';
import { createTestHost, createTestLogger, settle, switchChat } from './core-host';
import { EVENT_TYPES, installStMock } from './st-mock';
import type { StMock } from './st-mock';

export { settle } from './core-host';

/** Per-chat documents kept in memory (one object per chat and kind, like the real store's cache). */
export class MemoryChatStore implements ChatStore {
    readonly docs = new Map<string, object>();
    readonly owners = new WeakMap<object, string>();
    puts: { chatId: string; kind: string }[] = [];
    /** Next put() calls that report a newer version written by another tab. */
    conflicts = 0;

    constructor(private readonly chatId: () => string | null) {}

    private key(chatId: string, kind: string): string {
        return `${chatId}\u0000${kind}`;
    }

    async get<T extends object>(kind: string, defaults: () => T): Promise<T> {
        const chatId = this.chatId();
        return chatId ? this.getFor(chatId, kind, defaults) : defaults();
    }

    async getFor<T extends object>(chatId: string, kind: string, defaults: () => T): Promise<T> {
        const key = this.key(chatId, kind);
        let doc = this.docs.get(key);
        if (!doc) {
            doc = defaults();
            this.docs.set(key, doc);
        }
        this.owners.set(doc, chatId);
        return doc as T;
    }

    async put<T extends object>(kind: string, data: T): Promise<boolean> {
        const chatId = this.owners.get(data) ?? this.chatId();
        if (!chatId) return false;
        if (this.conflicts > 0) {
            this.conflicts--;
            return false;
        }
        this.docs.set(this.key(chatId, kind), data);
        this.puts.push({ chatId, kind });
        return true;
    }

    doc<T>(chatId: string, kind: string): T | undefined {
        return this.docs.get(this.key(chatId, kind)) as T | undefined;
    }

    pointer<T>(): T | undefined {
        return undefined;
    }
    async setPointer(): Promise<void> {}
    migration(): void {}
    async exportChat(): Promise<Record<string, unknown>> {
        return {};
    }
    async importChat(): Promise<void> {}
}

export interface FakeAdapters {
    bunnymo: { core: string[]; packs: string[]; archives: string[] };
    ckRepos: string[];
    ckPresent: boolean;
    desPresent: boolean;
    desSettings: Record<string, unknown> | null;
    presetPrompts: { identifier: string; name: string; role: string; marker: boolean; content?: string }[];
    presetName: string | undefined;
}

export interface LoreTestApp {
    mock: StMock;
    app: App;
    chat: MemoryChatStore;
    tabs: PultTab[];
    styles: Map<string, string>;
    adapters: FakeAdapters;
    /** world-info.js namespace (live bindings of the fake). */
    worldInfo: Record<string, unknown>;
    /** openai.js namespace. */
    openai: Record<string, unknown>;
    script: Record<string, unknown>;
    caps: Set<string>;
    /** Value of app.turn.current(). */
    generation: GenerationInfo | null;
    books: Map<string, { entries: Record<string, Record<string, unknown>> }>;
    ctx: Record<string, unknown>;
    /** Starts a module like the module manager does; returns its stop(). */
    start<S extends object>(module: MaestroModule<S>, settings?: S): Promise<{ settings: S; stop(): Promise<void> }>;
    emit(key: string, ...args: unknown[]): Promise<void>;
    listenerCount(key: string): number;
}

export const ALL_CAPS = [
    'st.events.scanDone',
    'st.events.entriesLoaded',
    'st.events.wiActivated',
    'st.events.ccPromptReady',
    'st.oai.promptManager',
    'st.wi.module',
];

export function createLoreApp(options: { locale?: 'ru' | 'en' } = {}): LoreTestApp {
    const mock = installStMock();
    const host = createTestHost(mock);
    const log = createTestLogger();
    const i18n = createI18n(() => options.locale ?? 'en');
    const bus = createBus(log);
    const chat = new MemoryChatStore(() => host.chatId());
    const tabs: PultTab[] = [];
    const styles = new Map<string, string>();
    const apis = new Map<string, unknown>();
    const caps = new Set<string>(ALL_CAPS);
    const books = new Map<string, { entries: Record<string, Record<string, unknown>> }>();
    const ctx = mock.context as unknown as Record<string, unknown>;
    ctx.extensionPrompts = {};
    ctx.getWorldInfoNames = () => [...books.keys()];
    ctx.loadWorldInfo = async (name: string) => {
        const book = books.get(name);
        return book ? structuredClone(book) : null;
    };
    ctx.getCharacterCardFields = () => ({
        description: 'A ranger of the north.',
        personality: 'Quiet.',
        scenario: 'The forest road.',
        persona: 'A traveller.',
        charDepthPrompt: '',
        creatorNotes: '',
    });

    const worldInfo: Record<string, unknown> = {
        selected_world_info: [],
        world_info: { charLore: [] },
        world_info_depth: 2,
        world_info_include_names: true,
        world_info_case_sensitive: false,
        world_info_match_whole_words: false,
    };
    const openai: Record<string, unknown> = { promptManager: null };
    const script: Record<string, unknown> = { getMaxPromptTokens: () => 4000 };
    host.modules = {
        worldInfo: async () => worldInfo,
        script: async () => script,
        openai: async () => openai,
        presetManager: async () => ({}),
        chats: async () => ({}),
        regexEngine: async () => ({}),
        utils: async () => ({}),
        load: async () => ({}),
    };
    host.caps = { register() {}, has: (id) => caps.has(id), report: () => [], refresh: async () => {} };

    const adapters: FakeAdapters = {
        bunnymo: { core: [], packs: [], archives: [] },
        ckRepos: [],
        ckPresent: false,
        desPresent: false,
        desSettings: null,
        presetPrompts: [],
        presetName: 'Test preset',
    };

    const ui: Ui = {
        addTab(tab) {
            tabs.push(tab);
            return () => {
                const index = tabs.indexOf(tab);
                if (index >= 0) tabs.splice(index, 1);
            };
        },
        addHealthCheck: () => () => {},
        addWizardStep: () => () => {},
        addSlashCommand: () => () => {},
        openPult() {},
        refresh() {},
        notice() {},
        confirm: async () => true,
        messageBadge: () => () => {},
        style(id, css) {
            styles.set(id, css);
            return () => {
                styles.delete(id);
            };
        },
    };

    const modules: ModuleManager = {
        list: () => [],
        enable: async () => {},
        disable: async () => {},
        api: <T>(key: string) => apis.get(key) as T | undefined,
        expose: (key, api) => {
            apis.set(key, api);
        },
    };

    const settingsService = {
        notified: [] as string[],
        saves: 0,
        core: () => ({}),
        module: () => ({}),
        isModuleEnabled: () => true,
        setModuleEnabled() {},
        save() {
            settingsService.saves++;
        },
        onChange: () => () => {},
        notify(path: string) {
            settingsService.notified.push(path);
        },
    };

    const stand: LoreTestApp = {
        mock,
        chat,
        tabs,
        styles,
        adapters,
        worldInfo,
        openai,
        script,
        caps,
        generation: null,
        books,
        ctx,
        app: undefined as unknown as App,
        async start(module, settings) {
            if (module.i18n) i18n.register(module.i18n as I18nParts);
            const slice = settings ?? module.defaults();
            const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
            await module.init({ app: stand.app, settings: slice, log, own: (dispose) => disposers.push(dispose) });
            return {
                settings: slice,
                async stop() {
                    for (const dispose of disposers.splice(0).reverse()) await dispose();
                    apis.delete(module.key);
                },
            };
        },
        emit: (key, ...args) => mock.eventSource.emit(EVENT_TYPES[key] ?? key, ...args),
        listenerCount: (key) => mock.eventSource.events.get(EVENT_TYPES[key] ?? key)?.length ?? 0,
    };

    stand.app = {
        host,
        turn: {
            onIntercept: () => () => {},
            lastAssistantIndex: () => -1,
            current: () => stand.generation,
        },
        log,
        i18n,
        settings: settingsService as unknown as SettingsService,
        files: {} as App['files'],
        chat,
        leader: { isLeader: () => true, onChange: () => () => {} },
        tasks: {} as App['tasks'],
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal: {} as App['journal'],
        autonomy: {} as App['autonomy'],
        inbox: {} as App['inbox'],
        ephemeral: {} as App['ephemeral'],
        bus,
        ui,
        adapters: {
            bunnymo: { books: () => structuredClone(adapters.bunnymo) },
            ck: { present: () => adapters.ckPresent, repoBooks: () => [...adapters.ckRepos] },
            des: { present: () => adapters.desPresent, settings: () => adapters.desSettings },
            localizer: {
                markerOf: (entry: unknown) => {
                    const extensions = (entry as { extensions?: Record<string, unknown> }).extensions;
                    return extensions?.lorebook_localizer ? { version: 1, languages: {} } : null;
                },
            },
            preset: {
                prompts: () => adapters.presetPrompts,
                presetName: () => adapters.presetName,
                settings: () => ({ prompts: adapters.presetPrompts }),
            },
        } as unknown as App['adapters'],
        modules,
    };
    return stand;
}

/** A real, non-quiet generation start as ST emits it, plus Maestro's interceptor event. */
export async function startGeneration(stand: LoreTestApp, type = 'normal'): Promise<void> {
    stand.generation = { type, dryRun: false, quiet: false };
    await stand.emit('GENERATION_STARTED', type, {}, false);
    await stand.app.bus.emit('generation:before', stand.generation);
}

/** The reply was rendered: Maestro's `reply:ready`, then the generation ends. */
export async function finishReply(stand: LoreTestApp, messageIndex: number, type = 'normal'): Promise<void> {
    await stand.app.bus.emit('reply:ready', { messageIndex, type });
    stand.generation = null;
    await settle(50);
}

/** Switches chats like ST (new metadata, CHAT_CHANGED) and emits Maestro's `chat:changed` like the turn pipeline. */
export async function changeChat(stand: LoreTestApp, chatId: string | undefined): Promise<void> {
    await switchChat(stand.mock, chatId);
    await stand.app.bus.emit('chat:changed', { chatId: chatId ?? null });
    await settle(30);
}
