// Test app for S4 (signals): the ST mock with chat messages carrying DES tracker data, real settings, i18n, bus, files
// and chat store, a switchable leader, fake neighbour adapters (DES tracker read from the chat, aliases, roster; Qvink
// memories by message index) and recording fakes of the UI and modules.
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import type { SignalBatch } from '../../../src/features/signals/api';
import { defaultSignalsSettings } from '../../../src/features/signals/service';
import { SIGNALS_STRINGS } from '../../../src/features/signals/strings';
import type { App, MaestroModule, PultTab, Signal, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

/** Lets zero-delay jobs and the mocked file I/O finish (spins on setImmediate: timers cost ~15 ms on Windows). */
export async function settle(ms = 15): Promise<void> {
    const end = Date.now() + ms;
    do {
        await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < end);
}

export interface CharacterSpec {
    name: string;
    present?: boolean;
    relationship?: string;
    appearance?: string;
    outfit?: string;
}

export interface ReplySpec {
    characters?: CharacterSpec[];
    location?: string;
    date?: string;
    time?: string;
    main?: string;
    optional?: string[];
    text?: string;
}

let dates = 0;

/** An assistant message with a DES tracker record for swipe 0. */
export function reply(spec: ReplySpec = {}): STChatMessage {
    const infoBox: Record<string, unknown> = {};
    if (spec.location) infoBox.location = { value: spec.location };
    if (spec.date) infoBox.date = { value: spec.date };
    if (spec.time) infoBox.time = { start: spec.time };
    const characters = (spec.characters ?? []).map((character) => ({
        name: character.name,
        ...(character.present === false ? { present: false } : {}),
        ...(character.relationship ? { relationship: { status: character.relationship } } : {}),
        details: {
            ...(character.appearance ? { appearance: character.appearance } : {}),
            ...(character.outfit ? { outfit: character.outfit } : {}),
        },
    }));
    const quests =
        spec.main !== undefined || spec.optional ? { main: spec.main ?? 'None', optional: spec.optional ?? [] } : null;
    return message(spec.text ?? 'The story goes on.', {
        send_date: `d${++dates}`,
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: quests ? JSON.stringify(quests) : null,
                    infoBox: Object.keys(infoBox).length ? JSON.stringify(infoBox) : null,
                    characterThoughts: characters.length ? JSON.stringify(characters) : null,
                },
            ],
        },
    });
}

export function userMessage(text = 'go on'): STChatMessage {
    return message(text, { is_user: true, send_date: `d${++dates}` });
}

export interface Neighbours {
    desPresent: boolean;
    desAliases: Record<string, string[]>;
    roster: string[];
    qvinkPresent: boolean;
    qvink: Record<number, { memory: string; remember: boolean; include?: string | null }>;
    trackerCalls: number;
}

export interface SignalsTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string> };
    modules: FakeModules;
    tasks: FakeTasks;
    neighbours: Neighbours;
    leader: { value: boolean; listeners: Set<(leader: boolean) => void> };
    logLines: LogLineRecord[];
    settings: Settings;
    /** Signals seen on the bus. */
    bus: Signal[];
}

function adapter(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    };
}

export function createSignalsTestApp(): SignalsTestApp {
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
    settings.registerModule('signals', defaultSignalsSettings, true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(SIGNALS_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
    const tasks = new FakeTasks();
    const leader = { value: true, listeners: new Set<(leader: boolean) => void>() };
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
    const neighbours: Neighbours = {
        desPresent: true,
        desAliases: {},
        roster: [],
        qvinkPresent: true,
        qvink: {},
        trackerCalls: 0,
    };
    const adapters = {
        des: adapter('des', {
            present: () => neighbours.desPresent,
            aliases: () => structuredClone(neighbours.desAliases),
            knownCharacters: () => [...neighbours.roster],
            trackerFor: (index: number) => {
                neighbours.trackerCalls++;
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
        }),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink', {
            present: () => neighbours.qvinkPresent,
            memoryOf: (index: number) => {
                const raw = neighbours.qvink[index];
                return raw ? { exclude: false, lagging: false, edited: false, include: null, ...raw } : null;
            },
        }),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const bus = createBus(log);
    const seen: Signal[] = [];
    bus.on('signal', (signal) => {
        seen.push(signal);
    });
    const app = {
        host,
        turn: new FakeTurn(),
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
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal: {} as App['journal'],
        autonomy: {} as App['autonomy'],
        inbox: {} as App['inbox'],
        ephemeral: {} as App['ephemeral'],
        bus,
        ui,
        adapters,
        modules,
    } as App;
    return { app, mock, host, chat, ui, modules, tasks, neighbours, leader, logLines, settings, bus: seen };
}

/** Starts a module the way the module manager does; stop() runs the owned disposers in reverse. */
export async function startModule<S extends object>(
    env: SignalsTestApp,
    module: MaestroModule<S>,
): Promise<{ stop(): Promise<void> }> {
    const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    await module.init({
        app: env.app,
        settings: env.settings.module<S>(module.key),
        log: env.app.log,
        own: (dispose) => disposers.push(dispose),
    });
    return {
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            env.modules.apis.delete(module.key);
        },
    };
}

/** One turn: the reply is in the chat, the user answers, the reply is committed (P14). Returns its index. */
export async function turn(env: SignalsTestApp, spec: ReplySpec = {}): Promise<number> {
    env.mock.chat.push(reply(spec));
    const index = env.mock.chat.length - 1;
    env.mock.chat.push(userMessage());
    await env.app.bus.emit('turn:committed', { messageIndex: index });
    await settle();
    return index;
}

/** Collects batches. */
export function batches(api: { onBatch(listener: (batch: SignalBatch) => void): Unsubscribe }): SignalBatch[] {
    const list: SignalBatch[] = [];
    api.onBatch((batch) => list.push(batch));
    return list;
}
