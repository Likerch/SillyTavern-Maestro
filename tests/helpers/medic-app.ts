// A Maestro App for feature tests of M3 «Медик» and M4 «Страж» over the ST mock: real core services (settings,
// i18n, files, chat store, journal, autonomy, inbox, bus, fetch gate), and fakes for the rest — UI (recording),
// leader, LLM, adapters (state-driven), ST modules (by path) and capabilities (a switchable set).
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { readLocalizerMarker } from '../../src/adapters/localizer';
import { createAutonomy } from '../../src/core/autonomy';
import type { AutonomyService } from '../../src/core/autonomy';
import { createBus } from '../../src/core/bus';
import { createChatStore } from '../../src/core/chat-store';
import { createFileStore } from '../../src/core/files';
import { createI18n } from '../../src/core/i18n';
import { createInbox } from '../../src/core/inbox';
import type { InboxService } from '../../src/core/inbox';
import { createJournal } from '../../src/core/journal';
import type { JournalService } from '../../src/core/journal';
import { Settings } from '../../src/core/settings';
import { CORE_STRINGS } from '../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../src/domain/des-tracker';
import { createFetchGate } from '../../src/host/fetch-gate';
import type { FetchGateImpl } from '../../src/host/fetch-gate';
import type {
    App,
    CapabilityReport,
    GenerationInfo,
    HealthCheck,
    Host,
    I18nParts,
    LlmRequest,
    LlmResult,
    MaestroModule,
    ModuleManager,
    PultTab,
    Ui,
    Unsubscribe,
} from '../../src/shared/contracts';
import { createTestLogger } from './core-host';
import { EVENT_TYPES, installStMock } from './st-mock';
import type { StMock } from './st-mock';

type Dict = Record<string, unknown>;
type Namespace = Record<string, unknown>;

export const DES_NAME = 'third-party/Dooms-Enhancement-Suite';
export const DES_BASE = `/scripts/extensions/${DES_NAME}/`;

/* ------------------------------------------------------------------ UI */

export interface RecordingUi extends Ui {
    checks: Map<string, HealthCheck>;
    tabs: PultTab[];
    notices: { text: string; options?: Parameters<Ui['notice']>[1] }[];
    confirms: { title: string; body: string | HTMLElement }[];
    confirmAnswer: boolean;
    styles: Map<string, string>;
    refreshes: number;
}

export function recordingUi(): RecordingUi {
    const ui: RecordingUi = {
        checks: new Map(),
        tabs: [],
        notices: [],
        confirms: [],
        confirmAnswer: true,
        styles: new Map(),
        refreshes: 0,
        addTab(tab) {
            ui.tabs.push(tab);
            return () => {
                ui.tabs = ui.tabs.filter((item) => item !== tab);
            };
        },
        addHealthCheck(check) {
            ui.checks.set(check.id, check);
            return () => ui.checks.delete(check.id);
        },
        addWizardStep: () => () => {},
        addSlashCommand: () => () => {},
        openPult() {},
        refresh() {
            ui.refreshes++;
        },
        notice(text, options) {
            ui.notices.push({ text, options });
        },
        async confirm(title, body) {
            ui.confirms.push({ title, body });
            return ui.confirmAnswer;
        },
        messageBadge: () => () => {},
        style(id, css) {
            ui.styles.set(id, css);
            return () => ui.styles.delete(id);
        },
    };
    return ui;
}

/* ------------------------------------------------------------------ adapters */

export interface AdapterState {
    des: {
        present: boolean;
        enabled: boolean;
        mode: 'together' | 'separate' | 'external';
        settings: Dict;
        workshopOpen: boolean;
        name: string | undefined;
    };
    desru: { present: boolean };
    qvink: { present: boolean; chatEnabled: boolean; removes: boolean };
    nai: { present: boolean };
    ck: { present: boolean };
    localizer: { present: boolean };
}

export function defaultAdapterState(): AdapterState {
    return {
        des: {
            present: true,
            enabled: true,
            mode: 'together',
            settings: { enabled: true, showInfoBox: true, showCharacterThoughts: true, showQuests: false },
            workshopOpen: false,
            name: DES_NAME,
        },
        desru: { present: false },
        qvink: { present: false, chatEnabled: true, removes: true },
        nai: { present: false },
        ck: { present: false },
        localizer: { present: false },
    };
}

function dictOrNull(value: unknown): Dict | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Dict) : null;
}

function baseAdapter(id: string, present: () => boolean, version?: string) {
    return {
        id,
        present,
        version: () => version,
        capabilities: () => [],
        ready: async () => {},
    };
}

export function fakeAdapters(mock: StMock, state: AdapterState): App['adapters'] {
    const ext = () => mock.extensionSettings;
    const adapters = {
        des: {
            ...baseAdapter('des', () => state.des.present, '2.6.0'),
            enabled: () => state.des.enabled,
            generationMode: () => state.des.mode,
            settings: () => state.des.settings,
            extensionName: () => state.des.name,
            isWorkshopOpen: () => state.des.workshopOpen,
            trackerFor: (index: number) => {
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
        },
        desru: {
            ...baseAdapter('desru', () => state.desru.present, '0.7.0'),
            settings: () => dictOrNull(ext().desru),
            moduleEnabled: (module: string) => {
                const modules = dictOrNull(dictOrNull(ext().desru)?.modules);
                const slice = dictOrNull(modules?.[module]);
                return !slice || slice.enabled !== false;
            },
        },
        qvink: {
            ...baseAdapter('qvink', () => state.qvink.present, '1.3.29'),
            settings: () => dictOrNull(ext().qvink_memory),
            chatEnabled: () => state.qvink.chatEnabled,
            removesMessages: () => state.qvink.removes,
        },
        nai: {
            ...baseAdapter('nai', () => state.nai.present, '0.9.10'),
            settings: () => dictOrNull(ext().nai_studio),
        },
        ck: {
            ...baseAdapter('ck', () => state.ck.present, '1.0.0'),
            settings: () => dictOrNull(ext().CarrotKernel),
        },
        localizer: {
            ...baseAdapter('localizer', () => state.localizer.present),
            markerOf: (entry: unknown) => readLocalizerMarker(entry),
        },
        bunnymo: baseAdapter('bunnymo', () => false),
        preset: baseAdapter('preset', () => true),
    };
    return adapters as unknown as App['adapters'];
}

/* ------------------------------------------------------------------ fake DES modules */

export interface FakeDes {
    state: { lastGeneratedData: Dict; committedTrackerData: Dict; isGenerating: boolean };
    saveChatData: Mock;
    parseQuests: Mock;
    renders: Mock;
    prompt: { role: string; content: string }[];
    modules: Map<string, Namespace>;
    /** Drops a module (load fails). */
    drop(path: string): void;
}

/** Parses the first JSON object of a model answer like DES's parser does (sections as JSON strings). */
function fakeParse(text: string): Dict {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const empty = { quests: null, infoBox: null, characterThoughts: null };
    if (start < 0 || end < start) return { ...empty, parsingFailed: true };
    try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as Dict;
        return {
            quests: parsed.quests ? JSON.stringify(parsed.quests) : null,
            infoBox: parsed.infoBox ? JSON.stringify(parsed.infoBox) : null,
            characterThoughts: parsed.characters ? JSON.stringify(parsed.characters) : null,
        };
    } catch {
        return { ...empty, parsingFailed: true };
    }
}

export function fakeDes(): FakeDes {
    const renders = vi.fn();
    const des: FakeDes = {
        state: {
            lastGeneratedData: { quests: null, infoBox: '{"location":"old"}', characterThoughts: null, html: null },
            committedTrackerData: { quests: null, infoBox: '{"location":"old"}', characterThoughts: null },
            isGenerating: false,
        },
        saveChatData: vi.fn(async () => {}),
        parseQuests: vi.fn(),
        renders,
        prompt: [
            { role: 'system', content: 'Tracker for {{persona}}' },
            { role: 'user', content: 'Provide ONLY the requested data' },
        ],
        modules: new Map(),
        drop(path) {
            des.modules.delete(`${DES_BASE}${path}`);
        },
    };
    const add = (path: string, namespace: Namespace) => des.modules.set(`${DES_BASE}${path}`, namespace);
    // Getters mimic `export let` live bindings: always the current object.
    add('src/core/state.js', {
        get lastGeneratedData() {
            return des.state.lastGeneratedData;
        },
        get committedTrackerData() {
            return des.state.committedTrackerData;
        },
        get isGenerating() {
            return des.state.isGenerating;
        },
    });
    add('src/core/persistence.js', { saveChatData: des.saveChatData });
    add('src/systems/generation/parser.js', { parseResponse: fakeParse, parseQuests: des.parseQuests });
    add('src/systems/generation/promptBuilder.js', { generateSeparateUpdatePrompt: async () => des.prompt });
    add('src/systems/generation/lockManager.js', { removeLocks: (value: string) => value });
    add('src/systems/features/characterAliases.js', { applyCharacterAliases: (value: string) => value });
    add('src/utils/messageGuards.js', { isSyntheticTrackerMessage: () => false });
    add('src/systems/rendering/infoBox.js', { renderInfoBox: () => renders('infoBox') });
    add('src/systems/rendering/thoughts.js', {
        renderThoughts: () => renders('thoughts'),
        updateChatThoughts: () => renders('chatThoughts'),
    });
    add('src/systems/rendering/quests.js', { renderQuests: () => renders('quests') });
    add('src/systems/rendering/sceneHeaders.js', { updateChatSceneHeaders: () => renders('sceneHeaders') });
    add('src/systems/ui/portraitBar.js', { updatePortraitBar: () => renders('portraitBar') });
    add('src/systems/rendering/chatBubbles.js', { harvestNewSpeakerColors: () => renders('colors') });
    add('src/systems/rendering/trackerJsonInline.js', {
        syncTrackerJsonForMessage: (i: number) => renders(`json:${i}`),
    });
    add('src/systems/generation/injector.js', { clearBoostForAppearedFields: () => renders('boost') });
    return des;
}

/* ------------------------------------------------------------------ the App */

export interface FeatureEnv {
    mock: StMock;
    app: App;
    host: Host;
    ui: RecordingUi;
    settings: Settings;
    journal: JournalService;
    inbox: InboxService;
    autonomy: AutonomyService;
    adapters: AdapterState;
    des: FakeDes;
    /** ST modules by path (`host.modules.load`) and the named ones. */
    stModules: { openai: Namespace; worldInfo: Namespace; presetManager: Namespace; byPath: Map<string, Namespace> };
    caps: Set<string>;
    capReport: CapabilityReport[];
    leader: { value: boolean; listeners: Set<(leader: boolean) => void>; set(value: boolean): void };
    generation: { current: GenerationInfo | null };
    llm: { request: Mock<(request: LlmRequest) => Promise<LlmResult>>; available: Mock<(task: string) => boolean> };
    gate: FetchGateImpl;
    /** What window.fetch would reach behind the gate (ST's server). */
    server: { requests: { url: string; init?: RequestInit }[]; respond: (url: string) => Response };
    /** Calls window.fetch as ST would (through the gate). */
    stFetch(url: string, init?: RequestInit): Promise<Response>;
    apis: Map<string, unknown>;
    group: { value: boolean };
    chatCompletion: { value: boolean };
    /** Starts a module like the module manager does; returns its disposer. */
    start<S extends object>(module: MaestroModule<S>): Promise<() => Promise<void>>;
}

export async function createFeatureEnv(strings: I18nParts[] = []): Promise<FeatureEnv> {
    const mock = installStMock();
    const log = createTestLogger();
    const caps = new Set<string>(['st.cm', 'st.wi.module', 'st.oai.promptManager', 'st.presetManager']);
    const capReport: CapabilityReport[] = [];
    const stModules = {
        openai: {} as Namespace,
        worldInfo: {} as Namespace,
        presetManager: {} as Namespace,
        byPath: new Map<string, Namespace>(),
    };
    const des = fakeDes();
    const group = { value: false };
    const chatCompletion = { value: true };
    const server = {
        requests: [] as { url: string; init?: RequestInit }[],
        respond: ((): Response => new Response(JSON.stringify({ result: 'ok' }), { status: 200 })) as (
            url: string,
        ) => Response,
    };
    const target = {
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            server.requests.push({ url, init });
            return server.respond(url);
        },
    };
    const gate = createFetchGate(log, target);
    gate.install();

    const resolve = (event: string) => EVENT_TYPES[event] ?? event;
    const host: Host = {
        ctx: () => mock.context,
        events: {
            on(event, handler): Unsubscribe {
                mock.eventSource.on(resolve(event), handler);
                return () => mock.eventSource.removeListener(resolve(event), handler);
            },
            reassertOrder() {},
            emit: (event, ...args) => mock.eventSource.emit(resolve(event), ...args),
            name: (key) => EVENT_TYPES[key],
        },
        modules: {
            worldInfo: async () => stModules.worldInfo,
            script: async () => ({}),
            openai: async () => stModules.openai,
            presetManager: async () => stModules.presetManager,
            chats: async () => ({}),
            regexEngine: async () => ({}),
            utils: async () => ({}),
            load: async (path: string) => {
                const namespace = des.modules.get(path) ?? stModules.byPath.get(path);
                if (!namespace) throw new Error(`no module ${path}`);
                return namespace;
            },
        },
        caps: {
            register() {},
            has: (id) => caps.has(id),
            report: () => capReport,
            refresh: async () => {},
        },
        fetchGate: gate,
        version: () => '1.19.0',
        chatId: () => mock.chatId ?? null,
        isGroupChat: () => group.value,
        isChatCompletion: () => chatCompletion.value,
    };

    const settings = new Settings(
        () => mock.extensionSettings,
        () => mock.context.saveSettingsDebounced(),
        log,
    );
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    for (const part of strings) i18n.register(part);
    const bus = createBus(log);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = createJournal({ host, chat, log });
    const autonomy = createAutonomy({ settings, journal, log });
    const inbox = createInbox({ chat, journal, autonomy, bus, log });
    const ui = recordingUi();
    autonomy.bind({ inbox, ui, i18n });

    const leader = {
        value: true,
        listeners: new Set<(leader: boolean) => void>(),
        set(value: boolean) {
            leader.value = value;
            for (const listener of [...leader.listeners]) listener(value);
        },
    };
    const generation = { current: null as GenerationInfo | null };
    const llm = {
        request: vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => ({ ok: true, text: '{}' })),
        available: vi.fn<(task: string) => boolean>(() => true),
    };
    const apis = new Map<string, unknown>();
    const modules: ModuleManager = {
        list: () => [],
        enable: async () => {},
        disable: async () => {},
        api: <T>(key: string) => apis.get(key) as T | undefined,
        expose: (key, api) => {
            apis.set(key, api);
        },
    };
    const adapters = defaultAdapterState();

    const app: App = {
        host,
        turn: {
            onIntercept: () => () => {},
            lastAssistantIndex: () => {
                for (let i = mock.chat.length - 1; i >= 0; i--) {
                    const message = mock.chat[i];
                    if (message && !message.is_user && !message.is_system) return i;
                }
                return -1;
            },
            current: () => generation.current,
        },
        log,
        i18n,
        settings,
        files,
        chat,
        leader: {
            isLeader: () => leader.value,
            onChange: (listener) => {
                leader.listeners.add(listener);
                return () => leader.listeners.delete(listener);
            },
        },
        tasks: { register: () => () => {}, enqueue: async () => 'task', list: () => [], kick() {} },
        llm: llm as unknown as App['llm'],
        cost: {
            record() {},
            recordAnlas() {},
            summary: () => ({ todayUsd: 0, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0 }),
            backgroundCapReached: () => false,
            onChange: () => () => {},
        },
        journal,
        autonomy,
        inbox,
        ephemeral: { setFlag() {}, setInjection() {}, addProducer: () => () => {}, clearAll() {} },
        bus,
        ui,
        adapters: fakeAdapters(mock, adapters),
        modules,
    };

    const env: FeatureEnv = {
        mock,
        app,
        host,
        ui,
        settings,
        journal,
        inbox,
        autonomy,
        adapters,
        des,
        stModules,
        caps,
        capReport,
        leader,
        generation,
        llm,
        gate,
        server,
        stFetch: (url, init) => target.fetch(url, init),
        apis,
        group,
        chatCompletion,
        async start(module) {
            settings.registerModule(module.key, module.defaults as () => object, module.enabledByDefault);
            if (module.i18n) i18n.register(module.i18n);
            const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
            await module.init({
                app,
                settings: settings.module(module.key),
                log,
                own: (dispose) => disposers.push(dispose),
            });
            return async () => {
                for (const dispose of disposers.splice(0).reverse()) await dispose();
                apis.delete(module.key);
            };
        },
    };
    return env;
}

/** A message with DES tracker data for its current swipe. */
export function withTracker(message: STChatMessage, record: Dict, swipeId = 0): STChatMessage {
    message.swipe_id = swipeId;
    message.extra = { ...(message.extra ?? {}), dooms_tracker_swipes: { [swipeId]: record } };
    return message;
}

/** Waits for fire-and-forget promise chains (fetch mocks, timers at 0). */
export async function flush(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
