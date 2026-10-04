// Test app for M9: the ST mock with Qvink records on messages (and their swipes), real settings, i18n, bus, files and
// chat store, recording fakes of the journal, autonomy, inbox, tasks, ephemeral, LLM and UI, a fake chat canon with
// chapters, and fake world model / places / Lore Studio APIs.
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import type { CanonApi, CanonDraft, CanonItem, CanonStatus } from '../../../src/features/canon/api';
import { ChapterService } from '../../../src/features/chronicle/chapters';
import { createChronicleEnv } from '../../../src/features/chronicle/env';
import type { ChronicleEnv } from '../../../src/features/chronicle/env';
import { AutoMemory } from '../../../src/features/chronicle/memory';
import { RecapService } from '../../../src/features/chronicle/recap';
import {
    CHRONICLE_KEY,
    defaultChronicleSettings,
    readChronicleSettings,
} from '../../../src/features/chronicle/settings';
import type { ChronicleSettings } from '../../../src/features/chronicle/settings';
import { ChronicleStore } from '../../../src/features/chronicle/store';
import { CHRONICLE_STRINGS } from '../../../src/features/chronicle/strings';
import type { Place } from '../../../src/features/places/api';
import type { Entity } from '../../../src/features/world/api';
import type {
    App,
    GenerationInfo,
    InjectionSpec,
    LlmRequest,
    LlmResult,
    MaestroModule,
    PultTab,
    Ui,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createTestHost, createTestLogger } from '../../helpers/core-host';
import type { LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeAutonomy, FakeInbox, FakeJournal, FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

type Dict = Record<string, unknown>;

/** Lets zero-delay jobs and the mocked file I/O finish (real timers). */
export async function settle(ms = 10): Promise<void> {
    const end = Date.now() + ms;
    do {
        await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < end);
}

/* ------------------------------------------------------------------ messages */

let sent = 0;
const BASE_TIME = Date.UTC(2026, 9, 1, 12, 0, 0);

export interface QvinkRecord {
    memory?: string;
    remember?: boolean;
    exclude?: boolean;
    include?: 'short' | 'long' | null;
    lagging?: boolean;
}

/** An assistant reply with a unique ISO send_date and, optionally, a Qvink record. */
export function reply(text: string, qvink?: QvinkRecord, extra: Partial<STChatMessage> = {}): STChatMessage {
    const options: Partial<STChatMessage> = {
        send_date: new Date(BASE_TIME + ++sent * 60_000).toISOString(),
        extra: qvink ? { qvink_memory: { include: null, lagging: false, ...qvink } } : {},
        ...extra,
    };
    return message(text, options);
}

export function userMessage(text = 'go on'): STChatMessage {
    return message(text, { is_user: true, send_date: new Date(BASE_TIME + ++sent * 60_000).toISOString() });
}

/** A record of a message as the fake adapter reads it. */
function memoryOf(chat: STChatMessage[], index: number) {
    const raw = chat[index]?.extra?.qvink_memory;
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Dict;
    return {
        memory: typeof record.memory === 'string' ? record.memory : '',
        remember: record.remember === true,
        exclude: record.exclude === true,
        include: record.include === 'short' || record.include === 'long' ? record.include : null,
        lagging: record.lagging === true,
        edited: false,
    };
}

export function qvinkOf(chatMessage: STChatMessage | undefined): Dict {
    return (chatMessage?.extra?.qvink_memory ?? {}) as Dict;
}

/* ------------------------------------------------------------------ fakes */

export class FakeCanon implements CanonApi {
    readonly items: CanonItem[] = [];
    readonly calls: string[] = [];
    book = 'Maestro · канон · 0000chat';
    limit = 8000;
    forms: Record<string, string[]> = {};
    private readonly listeners = new Set<() => void>();
    private clock = 1;

    bookName(): string {
        return this.book;
    }
    async ensureBook(): Promise<string> {
        return this.book;
    }
    async list(filter?: { kind?: string; status?: string; origin?: string }): Promise<CanonItem[]> {
        return structuredClone(
            this.items.filter(
                (item) =>
                    (!filter?.kind || item.meta.kind === filter.kind) &&
                    (!filter?.status || item.meta.status === filter.status) &&
                    (!filter?.origin || item.meta.origin === filter.origin),
            ),
        );
    }
    async put(draft: CanonDraft, options: { uid?: number } = {}): Promise<number> {
        this.calls.push(`put${options.uid !== undefined ? `:${options.uid}` : ''}`);
        const uid = options.uid ?? this.freeUid();
        const index = this.items.findIndex((item) => item.uid === uid);
        const createdAt = index >= 0 ? (this.items[index] as CanonItem).meta.createdAt : this.clock;
        const item: CanonItem = {
            uid,
            meta: { ...structuredClone(draft.meta), createdAt, updatedAt: ++this.clock },
            entry: { ...structuredClone(draft.entry), uid },
        };
        if (index >= 0) this.items[index] = item;
        else this.items.push(item);
        this.emit();
        return uid;
    }
    async remove(uid: number): Promise<void> {
        this.calls.push(`remove:${uid}`);
        const index = this.items.findIndex((item) => item.uid === uid);
        if (index >= 0) this.items.splice(index, 1);
        this.emit();
    }
    async setStatus(uid: number, status: CanonStatus): Promise<void> {
        this.calls.push(`status:${uid}:${status}`);
        const item = this.items.find((candidate) => candidate.uid === uid);
        if (item) item.meta = { ...item.meta, status, updatedAt: ++this.clock };
        this.emit();
    }
    async promote(): Promise<boolean> {
        return false;
    }
    async baseDrift() {
        return [];
    }
    async exportPlain(): Promise<string> {
        return '';
    }
    budget() {
        return { limitChars: this.limit, usedChars: 0 };
    }
    async russianKeys(term: string): Promise<string[]> {
        return this.forms[term] ?? [term];
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    chapters(): CanonItem[] {
        return this.items.filter((item) => item.meta.origin === 'chronicle');
    }
    private freeUid(): number {
        let uid = 0;
        while (this.items.some((item) => item.uid === uid)) uid++;
        return uid;
    }
    private emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

/** A tiny world model: entities found by case-insensitive substring of their names and forms. */
export class FakeWorld {
    entitiesList: Entity[] = [];
    entities(): Entity[] {
        return this.entitiesList;
    }
    mentions(text: string): Entity[] {
        const lower = text.toLowerCase();
        return this.entitiesList.filter((entity) =>
            [entity.name, ...entity.aliases, ...entity.forms].some((name) => lower.includes(name.toLowerCase())),
        );
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export function entity(kind: Entity['kind'], name: string, extra: Partial<Entity> = {}): Entity {
    return { id: `${kind}:${name.toLowerCase()}`, kind, name, aliases: [], forms: [], sources: [], ...extra };
}

export class FakePlaces {
    placesList: Place[] = [];
    list(): Place[] {
        return this.placesList;
    }
}

export function place(id: string, name: string, visits: [number, number | null][], forms: string[] = []): Place {
    return {
        id,
        name,
        aliases: [],
        forms,
        parent: null,
        createdAt: 0,
        firstSeen: 0,
        lastSeen: 0,
        visits: visits.map(([from, to]) => ({ from, to, present: [], events: [] })),
    };
}

export class FakeEphemeral {
    readonly producers = new Map<string, (gen: GenerationInfo) => void | Promise<void>>();
    readonly injections = new Map<string, InjectionSpec>();
    setFlag(): void {}
    setInjection(key: string, spec: InjectionSpec): void {
        this.injections.set(key, spec);
    }
    addProducer(name: string, producer: (gen: GenerationInfo) => void | Promise<void>): Unsubscribe {
        this.producers.set(name, producer);
        return () => this.producers.delete(name);
    }
    clearAll(): void {
        this.injections.clear();
    }
    async run(info: Partial<GenerationInfo> = {}): Promise<void> {
        this.clearAll();
        const gen: GenerationInfo = { type: 'normal', dryRun: false, quiet: false, ...info };
        for (const producer of [...this.producers.values()]) await producer(gen);
    }
}

export class FakeLlm {
    readonly requests: LlmRequest[] = [];
    isAvailable = true;
    answer: LlmResult<unknown> = { ok: true, text: 'Alice and Bob met in the tavern.' };
    available(): boolean {
        return this.isAvailable;
    }
    async request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
        this.requests.push(request);
        return this.answer as LlmResult<T>;
    }
}

export class TestTurn extends FakeTurn {
    generation: GenerationInfo | null = null;
    override current(): GenerationInfo | null {
        return this.generation;
    }
}

/** FakeInbox that keeps the validity and reject handlers too. */
export class TestInbox extends FakeInbox {
    readonly valid = new Map<string, (payload: unknown) => Promise<boolean>>();
    readonly rejecters = new Map<string, (payload: unknown) => Promise<void>>();
    override registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
        onReject?: (payload: unknown) => Promise<void>,
    ): Unsubscribe {
        if (stillValid) this.valid.set(kind, stillValid);
        if (onReject) this.rejecters.set(kind, onReject);
        return super.registerApplier(kind, apply);
    }
}

export interface TestUi extends Ui {
    tabs: PultTab[];
    styles: Map<string, string>;
    notices: { text: string; options?: Parameters<Ui['notice']>[1] }[];
    opened: (string | undefined)[];
    closed: number;
}

function testUi(): TestUi {
    const ui: TestUi = {
        tabs: [],
        styles: new Map(),
        notices: [],
        opened: [],
        closed: 0,
        addTab(tab) {
            ui.tabs.push(tab);
            return () => {
                ui.tabs = ui.tabs.filter((item) => item !== tab);
            };
        },
        addHealthCheck: () => () => {},
        addWizardStep: () => () => {},
        addSlashCommand: () => () => {},
        openPult(tabId) {
            ui.opened.push(tabId);
        },
        closePult() {
            ui.closed++;
        },
        refresh() {},
        notice(text, options) {
            ui.notices.push({ text, options });
        },
        async confirm() {
            return true;
        },
        messageBadge: () => () => {},
        style(id, css) {
            ui.styles.set(id, css);
            return () => ui.styles.delete(id);
        },
    };
    return ui;
}

export interface QvinkState {
    present: boolean;
    chat: boolean;
    busy: boolean;
}

export interface ChronicleTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: TestInbox;
    tasks: FakeTasks;
    turn: TestTurn;
    ephemeral: FakeEphemeral;
    llm: FakeLlm;
    ui: TestUi;
    modules: FakeModules;
    canon: FakeCanon;
    world: FakeWorld;
    places: FakePlaces;
    qvink: QvinkState;
    leader: { value: boolean; listeners: Set<(leader: boolean) => void> };
    settings: Settings;
    slash: string[];
    saves: { count: number };
    studio: { opened: [string | undefined, number | undefined][] };
    logLines: LogLineRecord[];
    /** Chronicle settings slice (live). */
    slice(): ChronicleSettings;
}

export function createChronicleTestApp(): ChronicleTestApp {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule(CHRONICLE_KEY, defaultChronicleSettings, true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(CHRONICLE_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new TestInbox();
    const tasks = new FakeTasks();
    const turn = new TestTurn();
    const ephemeral = new FakeEphemeral();
    const llm = new FakeLlm();
    const ui = testUi();
    const modules = new FakeModules();
    const canon = new FakeCanon();
    const world = new FakeWorld();
    const places = new FakePlaces();
    const studio = { opened: [] as [string | undefined, number | undefined][] };
    modules.expose('canon', canon);
    modules.expose('world', world);
    modules.expose('places', places);
    modules.expose('loreStudio', { open: (book?: string, uid?: number) => studio.opened.push([book, uid]) });
    const leader = { value: true, listeners: new Set<(leader: boolean) => void>() };
    const qvink: QvinkState = { present: true, chat: true, busy: false };
    const adapter = (id: string, extra: Dict = {}) => ({
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    });
    const adapters = {
        des: adapter('des'),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink', {
            present: () => qvink.present,
            chatEnabled: () => qvink.chat,
            isBusy: () => qvink.busy,
            settings: () => ({}),
            memoryOf: (index: number) => memoryOf(mock.chat, index),
        }),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const slash: string[] = [];
    const saves = { count: 0 };
    const context = mock.context as unknown as Dict;
    context.SlashCommandParser = { commands: { 'qm-refresh': {}, 'qm-summarize': {} }, addCommandObject() {} };
    context.executeSlashCommandsWithOptions = async (command: string) => {
        slash.push(command);
        return { isError: false };
    };
    context.saveChat = async () => {
        saves.count++;
    };
    context.name1 = 'Alex';
    context.name2 = 'Sera';
    const app = {
        host,
        turn,
        log,
        i18n,
        settings,
        files,
        chat,
        leader: {
            isLeader: () => leader.value,
            onChange: (listener: (value: boolean) => void) => {
                leader.listeners.add(listener);
                return () => leader.listeners.delete(listener);
            },
        },
        tasks,
        llm,
        cost: {} as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral,
        bus: createBus(log),
        ui,
        adapters,
        modules,
    } as unknown as App;
    return {
        app,
        mock,
        host,
        chat,
        journal,
        autonomy,
        inbox,
        tasks,
        turn,
        ephemeral,
        llm,
        ui,
        modules,
        canon,
        world,
        places,
        qvink,
        leader,
        settings,
        slash,
        saves,
        studio,
        logLines,
        slice: () => settings.module<ChronicleSettings>(CHRONICLE_KEY),
    };
}

export interface Services {
    env: ChronicleEnv;
    store: ChronicleStore;
    chapters: ChapterService;
    memory: AutoMemory;
    recap: RecapService;
    stop(): void;
}

/** The services wired like the module does, without the module's timers started. */
export function createServices(t: ChronicleTestApp): Services {
    const offs: Unsubscribe[] = [];
    const store = new ChronicleStore(t.app, t.app.log);
    offs.push(...store.install());
    const env = createChronicleEnv(t.app, t.app.log, store, () => readChronicleSettings(t.slice()));
    const chapters = new ChapterService(env);
    offs.push(...chapters.install());
    const memory = new AutoMemory(env);
    offs.push(...memory.install());
    const recap = new RecapService(env, chapters);
    offs.push(...recap.install());
    return {
        env,
        store,
        chapters,
        memory,
        recap,
        stop: () => {
            for (const off of offs.splice(0).reverse()) off();
        },
    };
}

/** Starts a module the way the module manager does; stop() runs the owned disposers in reverse. */
export async function startModule<S extends object>(
    t: ChronicleTestApp,
    module: MaestroModule<S>,
): Promise<{ stop(): Promise<void> }> {
    const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    await module.init({
        app: t.app,
        settings: t.settings.module<S>(module.key),
        log: t.app.log,
        own: (dispose) => disposers.push(dispose),
    });
    return {
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
        },
    };
}

/** The stored chronicle document of the current chat. */
export async function storedDoc(t: ChronicleTestApp): Promise<Dict> {
    return t.app.chat.get<Dict>('chronicle', () => ({}));
}
