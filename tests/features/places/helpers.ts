// Test app for M24: the ST mock with chat messages carrying DES tracker data, real settings, i18n, bus, files and
// chat store, recording fakes of the journal, autonomy, inbox, UI, modules and adapters, and a fake chat canon.
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import type { CanonApi, CanonDraft, CanonItem } from '../../../src/features/canon/api';
import { defaultPlacesSettings } from '../../../src/features/places/service';
import { PLACES_STRINGS } from '../../../src/features/places/strings';
import type { App, MaestroModule, PultTab, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeAutonomy, FakeInbox, FakeJournal, FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

/**
 * Lets the service's zero-delay jobs and the mocked file I/O finish. Spins on setImmediate for a few milliseconds
 * instead of chaining setTimeout(0): on Windows each timer wait costs ~15 ms.
 */
export async function settle(ms = 10): Promise<void> {
    const end = Date.now() + ms;
    do {
        await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < end);
}

export interface Character {
    name: string;
    present?: boolean;
    thoughts?: string;
}

export interface ReplyOptions {
    characters?: Character[];
    date?: string;
    time?: string;
    events?: string[];
}

let dates = 0;

/** An assistant message with a DES tracker record for swipe 0. */
export function reply(location: string | null, options: ReplyOptions = {}): STChatMessage {
    const infoBox: Record<string, unknown> = {};
    if (location !== null) infoBox.location = { value: location };
    if (options.date) infoBox.date = { value: options.date };
    if (options.time) infoBox.time = { start: options.time };
    if (options.events) infoBox.recentEvents = options.events;
    const characters = (options.characters ?? []).map((character) => ({
        name: character.name,
        ...(character.present === false ? { present: false } : {}),
        ...(character.thoughts ? { thoughts: { content: character.thoughts } } : {}),
    }));
    return message('reply', {
        send_date: `d${++dates}`,
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: null,
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

export class FakeCanon implements CanonApi {
    readonly items: CanonItem[] = [];
    readonly drafts: CanonDraft[] = [];
    book = 'Maestro · канон · 00000001';
    forms: Record<string, string[]> = {};
    private uid = 0;

    bookName(): string {
        return this.book;
    }
    async ensureBook(): Promise<string> {
        return this.book;
    }
    async list(filter?: { kind?: string }): Promise<CanonItem[]> {
        return this.items.filter((item) => !filter?.kind || item.meta.kind === filter.kind);
    }
    async put(draft: CanonDraft): Promise<number> {
        this.drafts.push(structuredClone(draft));
        const uid = this.uid++;
        this.items.push({ uid, meta: { ...draft.meta, createdAt: 1, updatedAt: 1 }, entry: { ...draft.entry, uid } });
        return uid;
    }
    async remove(uid: number): Promise<void> {
        const index = this.items.findIndex((item) => item.uid === uid);
        if (index >= 0) this.items.splice(index, 1);
    }
    async setStatus(): Promise<void> {}
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
        return { limitChars: 0, usedChars: 0 };
    }
    async russianKeys(term: string): Promise<string[]> {
        return this.forms[term] ?? [term];
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

/** FakeInbox that also keeps the reject handlers. */
export class RecordingInbox extends FakeInbox {
    readonly rejecters = new Map<string, (payload: unknown) => Promise<void>>();
    override registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        _stillValid?: (payload: unknown) => Promise<boolean>,
        onReject?: (payload: unknown) => Promise<void>,
    ): Unsubscribe {
        if (onReject) this.rejecters.set(kind, onReject);
        return super.registerApplier(kind, apply);
    }
}

export interface Neighbours {
    desAliases: Record<string, string[]>;
    desruApi: unknown;
    qvink: Record<number, unknown>;
}

export interface TestUi extends FakeUi {
    tabs: PultTab[];
    styles: Map<string, string>;
    closed: number;
}

export interface PlacesTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: RecordingInbox;
    ui: TestUi;
    modules: FakeModules;
    neighbours: Neighbours;
    leader: { value: boolean; listeners: Set<(leader: boolean) => void> };
    logLines: LogLineRecord[];
    settings: Settings;
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

export function createPlacesTestApp(): PlacesTestApp {
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
    settings.registerModule('places', defaultPlacesSettings, true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(PLACES_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new RecordingInbox();
    const modules = new FakeModules();
    const leader = { value: true, listeners: new Set<(leader: boolean) => void>() };
    const base = createFakeUi();
    const ui: TestUi = Object.assign(base, { tabs: [] as PultTab[], styles: new Map<string, string>(), closed: 0 });
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
    ui.closePult = () => {
        ui.closed++;
    };
    const neighbours: Neighbours = { desAliases: {}, desruApi: undefined, qvink: {} };
    const adapters = {
        des: adapter('des', { aliases: () => neighbours.desAliases }),
        desru: adapter('desru', { api: () => neighbours.desruApi }),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink', { memoryOf: (index: number) => neighbours.qvink[index] ?? null }),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
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
        tasks: new FakeTasks(),
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral: {} as App['ephemeral'],
        bus: createBus(log),
        ui,
        adapters,
        modules,
    } as App;
    return { app, mock, host, chat, journal, autonomy, inbox, ui, modules, neighbours, leader, logLines, settings };
}

/** Starts a module the way the module manager does; stop() runs the owned disposers in reverse. */
export async function startModule<S extends object>(
    env: PlacesTestApp,
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
export async function turn(env: PlacesTestApp, location: string | null, options: ReplyOptions = {}): Promise<number> {
    env.mock.chat.push(reply(location, options));
    const index = env.mock.chat.length - 1;
    env.mock.chat.push(userMessage());
    await env.app.bus.emit('turn:committed', { messageIndex: index });
    await settle();
    return index;
}
