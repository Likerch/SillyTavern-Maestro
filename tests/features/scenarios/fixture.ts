// A small App for feature tests of M34s (scenarios) and M31 (sheets): the ST mock with real ordered host events,
// the real bus, settings, i18n and autonomy, and fakes for the journal, inbox, UI, turn hooks and adapters.
import { createAutonomy } from '../../../src/core/autonomy';
import { createBus } from '../../../src/core/bus';
import type { EventBus } from '../../../src/core/bus';
import { Settings } from '../../../src/core/settings';
import { createHostEvents } from '../../../src/host/events';
import type {
    App,
    GenerationInfo,
    Inbox,
    Journal,
    JournalAction,
    JournalRecord,
    MaestroModule,
    Proposal,
    UndoHandler,
} from '../../../src/shared/contracts';
import type { DesTrackerSnapshot } from '../../../src/domain/des-tracker';
import { createFakeUi, createTestHost, createTestI18n, createTestLogger } from '../../helpers/core-host';
import type { FakeUi } from '../../helpers/core-host';
import { EVENT_TYPES, installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export const ST_EVENTS: Record<string, string> = {
    ...EVENT_TYPES,
    GENERATE_AFTER_DATA: 'generate_after_data',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    MESSAGE_UPDATED: 'message_updated',
};

export interface FakeJournal extends Journal {
    records: JournalRecord[];
    handlers: Map<string, UndoHandler>;
}

export interface FakeAdapters {
    trackers: Map<number, DesTrackerSnapshot>;
    ck: { present: boolean; settings: Record<string, unknown> | null; repos: string[] };
    bunnymo: { core: string[]; archives: string[] };
    qvink: { present: boolean; chatEnabled: boolean };
}

export interface Fixture {
    mock: StMock;
    app: App;
    bus: EventBus;
    ui: FakeUi;
    journal: FakeJournal;
    inbox: Inbox & { cards: Proposal[]; appliers: Map<string, (payload: unknown) => Promise<void>> };
    adapters: FakeAdapters;
    apis: Map<string, unknown>;
    /** Capability ids the fake host reports. */
    caps: Set<string>;
    /** Lorebooks served by ctx().loadWorldInfo. */
    books: Map<string, { entries: Record<string, Record<string, unknown>> }>;
    /** Calls of the fake hideChatMessageRange. */
    hides: [number, number, boolean][];
    /** Slash commands run through executeSlashCommandsWithOptions. */
    commands: string[];
    reasserts: number;
    /** Runs Maestro's intercept handlers like the generate_interceptor would. */
    intercept(chat: STChatMessage[], info: GenerationInfo): Promise<void>;
    emit(key: string, ...args: unknown[]): Promise<void>;
    start<S extends object>(
        module: MaestroModule<S>,
        settings?: Partial<S>,
    ): Promise<{ settings: S; dispose(): Promise<void> }>;
}

export function info(overrides: Partial<GenerationInfo> = {}): GenerationInfo {
    return { type: 'normal', dryRun: false, quiet: false, ...overrides };
}

export function createFixture(): Fixture {
    const mock = installStMock();
    const log = createTestLogger();
    (mock.context as unknown as { eventTypes: Record<string, string> }).eventTypes = ST_EVENTS;

    const caps = new Set(['st.chats.hide']);
    const hides: [number, number, boolean][] = [];
    const commands: string[] = [];
    const books = new Map<string, { entries: Record<string, Record<string, unknown>> }>();

    const base = createTestHost(mock);
    const events = createHostEvents(() => mock.context, log);
    let reasserts = 0;
    const host = {
        ...base,
        events: {
            ...events,
            on: events.on.bind(events),
            emit: events.emit.bind(events),
            name: events.name.bind(events),
            reassertOrder: () => {
                reasserts++;
                events.reassertOrder();
            },
        },
        modules: {
            ...base.modules,
            chats: async () => ({
                hideChatMessageRange: async (start: number, end: number, unhide: boolean) => {
                    hides.push([start, end, unhide]);
                    for (let i = start; i <= end; i++) {
                        const message = mock.chat[i];
                        if (message) message.is_system = !unhide;
                    }
                },
            }),
        },
        caps: { register() {}, has: (id: string) => caps.has(id), report: () => [], refresh: async () => {} },
    };

    const context = mock.context as unknown as Record<string, unknown>;
    context.loadWorldInfo = async (name: string) => structuredClone(books.get(name) ?? null);
    context.updateMessageBlock = () => {};
    context.SlashCommandParser = { commands: { 'qm-toggle-exclude': {} }, addCommandObject() {} };
    context.executeSlashCommandsWithOptions = async (text: string) => {
        commands.push(text);
        return {};
    };

    const bus = createBus(log);
    const records: JournalRecord[] = [];
    const handlers = new Map<string, UndoHandler>();
    const journal: FakeJournal = {
        records,
        handlers,
        async record(action: JournalAction) {
            const record: JournalRecord = { ...action, id: `j${records.length + 1}`, at: Date.now(), chatId: 'chat-1' };
            records.push(record);
            return record.id;
        },
        async undo(id: string) {
            const record = records.find((item) => item.id === id);
            if (!record) return false;
            for (const change of [...record.changes].reverse()) {
                const handler = handlers.get(change.target);
                if (!handler || !(await handler(change))) return false;
            }
            record.undone = true;
            return true;
        },
        async undoForMessage() {
            return 0;
        },
        list: () => [...records],
        registerUndo(target, handler) {
            handlers.set(target, handler);
        },
    };

    const cards: Proposal[] = [];
    const appliers = new Map<string, (payload: unknown) => Promise<void>>();
    const inbox = {
        cards,
        appliers,
        registerApplier(kind: string, apply: (payload: unknown) => Promise<void>) {
            appliers.set(kind, apply);
            return () => appliers.delete(kind);
        },
        add: async (proposal: Proposal) => {
            cards.push(proposal);
            return `card-${cards.length}`;
        },
        list: () => [],
        accept: async () => true,
        reject: async () => {},
        snooze: async () => {},
        invalidateMessage: async () => 0,
        onChange: () => () => {},
        count: () => cards.length,
    };

    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    const i18n = createTestI18n('ru');
    const ui = createFakeUi();
    const autonomy = createAutonomy({ settings, journal, log });
    autonomy.bind({ inbox, ui, i18n });

    const intercepts = new Set<(chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>>();
    const apis = new Map<string, unknown>();
    const fakeAdapters: FakeAdapters = {
        trackers: new Map(),
        ck: { present: false, settings: null, repos: [] },
        bunnymo: { core: ['BunnyMo'], archives: [] },
        qvink: { present: false, chatEnabled: true },
    };
    const adapters = {
        des: { present: () => true, trackerFor: (index: number) => fakeAdapters.trackers.get(index) ?? null },
        ck: {
            present: () => fakeAdapters.ck.present,
            enabled: () => fakeAdapters.ck.settings?.enabled !== false,
            settings: () => fakeAdapters.ck.settings,
            repoBooks: () => [...fakeAdapters.ck.repos],
        },
        bunnymo: {
            present: () => fakeAdapters.bunnymo.core.length > 0,
            books: () => ({
                core: [...fakeAdapters.bunnymo.core],
                packs: [],
                archives: [...fakeAdapters.bunnymo.archives],
            }),
            refresh: async () => {},
        },
        qvink: { present: () => fakeAdapters.qvink.present, chatEnabled: () => fakeAdapters.qvink.chatEnabled },
        desru: { present: () => false },
        nai: { present: () => false },
        localizer: { present: () => false },
        preset: { present: () => false },
    };

    const app = {
        host,
        turn: {
            onIntercept(handler: (chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>) {
                intercepts.add(handler);
                return () => intercepts.delete(handler);
            },
            lastAssistantIndex: () => -1,
            current: () => null,
        },
        log,
        i18n,
        settings,
        bus,
        ui,
        journal,
        autonomy,
        inbox,
        adapters,
        modules: {
            list: () => [],
            enable: async () => {},
            disable: async () => {},
            api: <T>(key: string) => apis.get(key) as T | undefined,
            expose: (key: string, api: unknown) => apis.set(key, api),
        },
    } as unknown as App;

    const fixture: Fixture = {
        mock,
        app,
        bus,
        ui,
        journal,
        inbox,
        adapters: fakeAdapters,
        apis,
        caps,
        books,
        hides,
        commands,
        get reasserts() {
            return reasserts;
        },
        async intercept(chat, generation) {
            for (const handler of [...intercepts]) await handler(chat, generation);
        },
        emit: (key, ...args) => mock.eventSource.emit(ST_EVENTS[key] ?? key, ...args),
        async start(module, overrides) {
            const disposers: (() => unknown)[] = [];
            const slice = { ...module.defaults(), ...overrides };
            if (module.i18n) i18n.register(module.i18n);
            await module.init({ app, settings: slice, log, own: (dispose) => void disposers.push(dispose) });
            return {
                settings: slice,
                async dispose() {
                    for (const dispose of disposers.splice(0).reverse()) await dispose();
                    apis.delete(module.key);
                },
            };
        },
    };
    return fixture;
}

/** Lets promise chains and zero-delay timers run. */
export async function flush(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
