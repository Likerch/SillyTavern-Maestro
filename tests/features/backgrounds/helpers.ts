// Test app for M29 (backgrounds): the ST mock with a `#bg1` layer, chat metadata, a background library served at
// /api/backgrounds/all and /folders, thumbnails, a read-only backgrounds.js (`background_settings`) and spies on
// everything that would touch the GLOBAL background (saveSettingsDebounced, slash commands, settings saves). Real bus,
// files and chat store (pointers live in chat metadata); recording journal, autonomy and inbox; a fake place
// registry; a fake DES adapter reading tracker records from the mock chat; a fake NAI adapter for generation.
import { vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import { backgroundsModule } from '../../../src/features/backgrounds';
import type { BackgroundsService, GenerateBackgroundInput } from '../../../src/features/backgrounds';
import { EVAL_DELAY_MS } from '../../../src/features/backgrounds/service';
import { BACKGROUNDS_STRINGS } from '../../../src/features/backgrounds/strings';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import type { App, CoreSettings, PultTab, SettingsService, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger, switchChat } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeAutonomy, FakeInbox, FakeJournal, FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export const GLOBAL_URL = 'url("backgrounds/global.jpg")';
export const url = (file: string) => `url("backgrounds/${encodeURIComponent(file)}")`;
/** Enough fake time for a trigger to settle and the evaluation to run. */
export const SETTLE = EVAL_DELAY_MS + 100;

export class FakePlaces implements PlacesApi {
    places: Place[] = [];
    currentId: string | null = null;
    readonly updates: { id: string; patch: Record<string, unknown> }[] = [];
    readonly enterListeners = new Set<(place: Place | null, previous: Place | null) => void>();
    readonly changeListeners = new Set<() => void>();
    private next = 0;

    add(name: string, extra: Partial<Place> = {}): Place {
        const place: Place = {
            id: `p${++this.next}`,
            name,
            aliases: [],
            forms: [],
            parent: null,
            createdAt: 0,
            firstSeen: 0,
            lastSeen: 0,
            visits: [],
            ...extra,
        };
        this.places.push(place);
        return structuredClone(place);
    }

    list(): Place[] {
        return this.places.map((place) => structuredClone(place));
    }
    get(id: string): Place | undefined {
        const place = this.places.find((item) => item.id === id);
        return place ? structuredClone(place) : undefined;
    }
    current(): Place | null {
        return this.currentId ? (this.get(this.currentId) ?? null) : null;
    }
    resolve(): Place | undefined {
        return undefined;
    }
    candidates() {
        return [];
    }
    async create(): Promise<Place> {
        throw new Error('not in this fake');
    }
    async update(id: string, patch: Partial<Omit<Place, 'id' | 'visits'>>): Promise<void> {
        const place = this.places.find((item) => item.id === id);
        if (!place) throw new Error('no place');
        this.updates.push({ id, patch: structuredClone(patch) as Record<string, unknown> });
        const target = place as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) delete target[key];
            else target[key] = structuredClone(value);
        }
        for (const listener of [...this.changeListeners]) listener();
    }
    async merge(): Promise<void> {}
    async remove(): Promise<void> {}
    async ensureEntry(): Promise<{ world: string; uid: number }> {
        return { world: 'w', uid: 0 };
    }
    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }
    onEnter(listener: (place: Place | null, previous: Place | null) => void): Unsubscribe {
        this.enterListeners.add(listener);
        return () => this.enterListeners.delete(listener);
    }
    path(id: string): string[] {
        const names: string[] = [];
        let place = this.places.find((item) => item.id === id);
        while (place) {
            names.unshift(place.name);
            const parent: string | null = place.parent;
            place = parent ? this.places.find((item) => item.id === parent) : undefined;
        }
        return names;
    }
    /** The scene enters a place (as M24 announces it after a committed turn). */
    enter(id: string | null): void {
        const previous = this.current();
        this.currentId = id;
        const place = this.current();
        for (const listener of [...this.enterListeners]) listener(place, previous);
    }
}

export class FakeNai {
    readonly id = 'nai';
    isPresent = true;
    hasApi = true;
    naiSettings: unknown = { anlas: { freeOnly: true } };
    readonly calls: GenerateBackgroundInput[] = [];
    readonly failedListeners = new Set<(detail: unknown) => void>();
    /** The adapter's answer; the default «uploads» a file and returns its name. */
    respond: (input: GenerateBackgroundInput) => Promise<{ file: string } | null>;
    private count = 0;

    constructor(private readonly library: string[]) {
        this.respond = async (input) => {
            const file = `maestro-${input.locationName.length}-${++this.count}.png`;
            this.library.push(file);
            return { file };
        };
    }
    present(): boolean {
        return this.isPresent;
    }
    version(): string | undefined {
        return '0.12.0';
    }
    capabilities(): string[] {
        return [];
    }
    async ready(): Promise<void> {}
    settings(): unknown {
        return this.naiSettings;
    }
    api(): { generateBackground?: unknown } | undefined {
        return this.hasApi ? { generateBackground: () => undefined } : {};
    }
    on(event: string, listener: (detail: unknown) => void): () => void {
        if (event !== 'requestFailed') return () => {};
        this.failedListeners.add(listener);
        return () => this.failedListeners.delete(listener);
    }
    async generateBackground(input: GenerateBackgroundInput): Promise<{ file: string } | null> {
        this.calls.push(structuredClone(input));
        return this.respond(input);
    }
    /** NAI Studio's `requestFailed` event. */
    fail(detail: Record<string, unknown>): void {
        for (const listener of [...this.failedListeners]) listener(detail);
    }
}

export interface SceneSpec {
    time?: string;
    weather?: string;
    date?: string;
}

let sent = 0;

/** An assistant message with a DES tracker (time, weather, date) for swipe 0. */
export function reply(spec: SceneSpec = {}): STChatMessage {
    const infoBox: Record<string, unknown> = { location: { value: 'Somewhere' } };
    if (spec.time) infoBox.time = { start: spec.time };
    if (spec.weather) infoBox.weather = { forecast: spec.weather };
    if (spec.date) infoBox.date = { value: spec.date };
    return message('История продолжается.', {
        send_date: `d${++sent}`,
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [{ quests: null, infoBox: JSON.stringify(infoBox), characterThoughts: null }],
        },
    });
}

export function userMessage(): STChatMessage {
    return message('Дальше', { is_user: true, send_date: `d${++sent}` });
}

class ValidatingInbox extends FakeInbox {
    readonly validators = new Map<string, (payload: unknown) => Promise<boolean>>();
    override registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
    ): Unsubscribe {
        if (stillValid) this.validators.set(kind, stillValid);
        const off = super.registerApplier(kind, apply);
        return () => {
            this.validators.delete(kind);
            off();
        };
    }
}

export interface BgEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    modules: FakeModules;
    places: FakePlaces;
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: ValidatingInbox;
    nai: FakeNai;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string> };
    leader: { value: boolean };
    core: { mode: CoreSettings['mode'] };
    slices: Record<string, Record<string, unknown>>;
    /** Files of the ST background library (mutable). */
    library: string[];
    folders: { id: string; name: string; files: string[] }[];
    listFails: boolean;
    listCalls: number;
    metadataSaves: number;
    slashCalls: string[];
    caps: string[];
    globalSettings: { name: string; url: string };
    logLines: LogLineRecord[];
    start(): Promise<BackgroundsService>;
    stop(): Promise<void>;
    service(): BackgroundsService;
    tick(ms?: number): Promise<void>;
    layer(): HTMLElement;
    /** The chat background value in chat metadata ('' = none). */
    live(): string;
    /** One turn: the reply with DES fields is in the chat, the user answers, the reply is committed. */
    turn(spec?: SceneSpec): Promise<number>;
    /** The scene enters a place and the evaluation runs. */
    enter(placeId: string | null): Promise<void>;
    /** The user sets (or with '' removes) the chat background the way ST does. */
    userSets(value: string): Promise<void>;
    notifySettings(path: string): void;
    switchTo(chatId: string | undefined, metadata?: Record<string, unknown>): Promise<void>;
}

export function createBgEnv(locale: 'en' | 'ru' = 'en'): BgEnv {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const i18n = createI18n(() => locale);
    i18n.register(CORE_STRINGS);
    i18n.register(BACKGROUNDS_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
    const places = new FakePlaces();
    modules.expose('places', places);
    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new ValidatingInbox();
    const library: string[] = [];
    const nai = new FakeNai(library);
    const leader = { value: true };
    const core = { mode: 'balanced' as CoreSettings['mode'] };
    const base = createFakeUi();
    const ui = Object.assign(base, { tabs: [] as PultTab[], styles: new Map<string, string>() });
    ui.addTab = (tab) => {
        ui.tabs.push(tab);
        return () => {
            ui.tabs = ui.tabs.filter((item) => item !== tab);
        };
    };
    ui.style = (id, css) => {
        ui.styles.set(id, css);
        return () => ui.styles.delete(id);
    };
    const slices: Record<string, Record<string, unknown>> = {};
    const settingsListeners = new Set<(path: string) => void>();
    const globalSettings = { name: 'global.jpg', url: GLOBAL_URL };
    const caps: string[] = [];

    const env = {
        library,
        folders: [] as { id: string; name: string; files: string[] }[],
        listFails: false,
        listCalls: 0,
        metadataSaves: 0,
        slashCalls: [] as string[],
    } as BgEnv;

    // ST context members the module uses besides the mock's.
    Object.assign(mock.context as unknown as Record<string, unknown>, {
        getThumbnailUrl: (type: string, file: string) => `/thumbnail?type=${type}&file=${encodeURIComponent(file)}`,
        saveMetadataDebounced: () => {
            env.metadataSaves++;
        },
        executeSlashCommandsWithOptions: async (text: string) => {
            env.slashCalls.push(text);
            return {};
        },
    });
    host.modules.load = async (path: string) => {
        if (path === 'backgrounds.js') return { background_settings: globalSettings };
        return {};
    };
    host.caps.register = (id: string) => {
        caps.push(id);
    };

    const stFetch = globalThis.fetch;
    const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => {
        const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (address.includes('/api/backgrounds/all')) {
            env.listCalls++;
            if (env.listFails) return new Response('down', { status: 500 });
            return json({
                images: library.map((filename) => ({ filename, isAnimated: false })),
                config: { width: 160, height: 90 },
            });
        }
        if (address.includes('/api/backgrounds/folders')) {
            const imageFolderMap: Record<string, string[]> = {};
            for (const folder of env.folders) {
                for (const file of folder.files) (imageFolderMap[file] ??= []).push(folder.id);
            }
            return json({
                folders: env.folders.map(({ id, name }) => ({ id, name, thumbnailFile: '' })),
                imageFolderMap,
            });
        }
        return stFetch(input, init);
    }) as typeof fetch;

    // The background layer ST paints (`#bg1`), showing the global background.
    document.body.innerHTML = '';
    const layer = document.createElement('div');
    layer.id = 'bg1';
    layer.style.setProperty('background-image', GLOBAL_URL);
    document.body.appendChild(layer);
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;

    const adapter = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    });
    const adapters = {
        des: adapter('des', {
            trackerFor: (index: number) => {
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
        }),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink'),
        nai,
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];

    const bus = createBus(log);
    const settings = {
        core: () => ({ mode: core.mode, autonomy: {} }) as unknown as CoreSettings,
        module: <T extends object>(key: string) => (slices[key] ??= {}) as T,
        isModuleEnabled: () => true,
        setModuleEnabled() {},
        save() {},
        onChange: (listener: (path: string) => void) => {
            settingsListeners.add(listener);
            return () => settingsListeners.delete(listener);
        },
        notify: (path: string) => {
            for (const listener of [...settingsListeners]) listener(path);
        },
    } as unknown as SettingsService;

    const app = {
        host,
        turn: new FakeTurn(),
        log,
        i18n,
        settings,
        files,
        chat,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks: new FakeTasks(),
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral: {} as App['ephemeral'],
        bus,
        ui,
        adapters,
        modules,
    } as App;

    let disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    const tick = async (ms = 10) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    Object.assign(env, {
        app,
        mock,
        host,
        chat,
        modules,
        places,
        journal,
        autonomy,
        inbox,
        nai,
        ui,
        leader,
        core,
        slices,
        caps,
        globalSettings,
        logLines,
        async start() {
            disposers = [];
            await backgroundsModule.init({
                app,
                settings: (slices.backgrounds ??= {}) as never,
                log,
                own: (dispose) => disposers.push(dispose),
            });
            await tick(SETTLE);
            return env.service();
        },
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            modules.apis.delete('backgrounds');
        },
        service() {
            const service = modules.api<BackgroundsService>('backgrounds');
            if (!service) throw new Error('not started');
            return service;
        },
        tick,
        layer: () => document.getElementById('bg1') as HTMLElement,
        live: () => {
            const value = mock.chatMetadata.custom_background;
            return typeof value === 'string' ? value : '';
        },
        async turn(spec: SceneSpec = {}) {
            mock.chat.push(reply(spec));
            const index = mock.chat.length - 1;
            mock.chat.push(userMessage());
            await bus.emit('turn:committed', { messageIndex: index });
            await tick(SETTLE);
            return index;
        },
        async enter(placeId: string | null) {
            places.enter(placeId);
            await tick(SETTLE);
        },
        async userSets(value: string) {
            // ST's onSelectBackgroundClick with a locked chat background / onUnlockBackgroundClick.
            if (value) mock.chatMetadata.custom_background = value;
            else delete mock.chatMetadata.custom_background;
            layer.style.setProperty('background-image', value || GLOBAL_URL);
            await tick(10);
        },
        notifySettings(path: string) {
            settings.notify(path);
        },
        async switchTo(chatId: string | undefined, metadata: Record<string, unknown> = {}) {
            await switchChat(mock, chatId, metadata);
            await bus.emit('chat:changed', { chatId: chatId ?? null });
            await tick(SETTLE);
        },
    });
    return env;
}

/** The autonomy kinds recorded by the fake. */
export function proposalKinds(env: BgEnv): string[] {
    return env.autonomy.proposals.map((proposal) => proposal.kind);
}
