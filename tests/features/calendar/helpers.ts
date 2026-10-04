// Test app for M17 (calendar): the ST mock with assistant messages carrying a DES tracker date/time, a real bus,
// files and chat store, a switchable leader, a fake revision (deferred cards, runs, dismissal) and a fake world model
// (names, aliases, mentions). Fake timers drive the settle and intake delays.
import { vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import { calendarModule } from '../../../src/features/calendar';
import type { CalendarService } from '../../../src/features/calendar/service';
import { CALENDAR_STRINGS } from '../../../src/features/calendar/strings';
import type { DeferredCard, RevisionApi, RevisionRun } from '../../../src/features/revision/api';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type { App, PultTab, SettingsService, Signal, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger, switchChat } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

/** Module defaults: settle 400 ms after a send, intake 300 ms after a revision change. */
export const SETTLE = 450;
export const INTAKE = 350;

export interface TimeSpec {
    date?: string;
    start?: string;
    end?: string;
    text?: string;
}

let sent = 0;

/** An assistant message with a DES tracker (date and time) for swipe 0. */
export function reply(spec: TimeSpec = {}): STChatMessage {
    const infoBox: Record<string, unknown> = { location: { value: 'Таверна' } };
    if (spec.date) infoBox.date = { value: spec.date };
    if (spec.start || spec.end)
        infoBox.time = { ...(spec.start ? { start: spec.start } : {}), ...(spec.end ? { end: spec.end } : {}) };
    return message(spec.text ?? 'История продолжается.', {
        send_date: `d${++sent}`,
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [{ quests: null, infoBox: JSON.stringify(infoBox), characterThoughts: null }],
        },
    });
}

export function userMessage(text = 'Дальше'): STChatMessage {
    return message(text, { is_user: true, name: 'Алекс', send_date: `d${++sent}` });
}

export class FakeRevision implements RevisionApi {
    cards: DeferredCard[] = [];
    dismissed: string[] = [];
    readonly runListeners = new Set<(run: RevisionRun) => void>();
    readonly changeListeners = new Set<() => void>();
    private next = 0;

    async run(): Promise<void> {}
    runs(): RevisionRun[] {
        return [];
    }
    deferred(): DeferredCard[] {
        return this.cards.map((card) => ({ ...card }));
    }
    onRun(listener: (run: RevisionRun) => void): Unsubscribe {
        this.runListeners.add(listener);
        return () => this.runListeners.delete(listener);
    }
    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }
    async dismissDeferred(id: string): Promise<void> {
        this.dismissed.push(id);
        this.cards = this.cards.filter((card) => card.id !== id);
        for (const listener of [...this.changeListeners]) listener();
    }
    /** Parks a card the way the revision does. */
    card(
        value: string,
        evidence: string,
        sourceMessage: number,
        entityName = 'Anna',
        target: DeferredCard['target'] = 'deferred.promise',
    ): DeferredCard {
        const card: DeferredCard = {
            id: `def-${++this.next}`,
            target,
            entityName,
            value,
            evidence,
            sourceMessage,
            at: 1,
        };
        this.cards.push(card);
        return card;
    }
    /** A finished revision run. */
    finish(): void {
        const run: RevisionRun = {
            id: 'rev-1',
            at: 1,
            reason: 'manual',
            fromMessage: 0,
            toMessage: 0,
            changes: [],
            rejected: [],
            costUsd: 0,
        };
        for (const listener of [...this.runListeners]) listener(run);
    }
}

/** World model with a few people: resolve by name or alias, mentions by any name in the text. */
export function fakeWorld(people: { name: string; aliases?: string[]; kind?: Entity['kind'] }[]): WorldModelApi {
    const entities: Entity[] = people.map((person) => ({
        id: `${person.kind ?? 'character'}:${person.name.toLowerCase()}`,
        kind: person.kind ?? 'character',
        name: person.name,
        aliases: person.aliases ?? [],
        forms: [],
        sources: [],
    }));
    const names = (entity: Entity) => [entity.name, ...entity.aliases].map((name) => name.toLowerCase());
    return {
        entities: () => entities,
        get: (id) => entities.find((entity) => entity.id === id),
        resolve: (name) => entities.find((entity) => names(entity).includes(name.trim().toLowerCase())),
        mentions: (text) =>
            entities.filter((entity) => names(entity).some((name) => text.toLowerCase().includes(name))),
        facts: () => [],
        rebuild: async () => {},
        chatAliases: () => ({}),
        setChatAlias: async () => {},
        merge: async () => {},
        separate: async () => {},
        mergeCandidates: () => [],
        onChange: () => () => {},
    };
}

export interface CalendarEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    modules: FakeModules;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string> };
    leader: { value: boolean };
    slices: Record<string, Record<string, unknown>>;
    signals: Signal[];
    revision: FakeRevision;
    logLines: LogLineRecord[];
    start(): Promise<CalendarService>;
    stop(): Promise<void>;
    service(): CalendarService;
    tick(ms?: number): Promise<void>;
    /** One turn: the reply is in the chat, the user answers, the reply is committed. Returns its index. */
    turn(spec?: TimeSpec): Promise<number>;
    /** Switches the chat the way ST and the turn pipeline do (CHAT_CHANGED, then the bus event). */
    switchTo(chatId: string | undefined, chat?: STChatMessage[]): Promise<void>;
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

export function createCalendarEnv(locale: 'en' | 'ru' = 'en'): CalendarEnv {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const i18n = createI18n(() => locale);
    i18n.register(CORE_STRINGS);
    i18n.register(CALENDAR_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
    const revision = new FakeRevision();
    modules.expose('revision', revision);
    const leader = { value: true };
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
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const bus = createBus(log);
    const signals: Signal[] = [];
    bus.on('signal', (signal) => {
        signals.push(signal);
    });
    const app = {
        host,
        turn: new FakeTurn(),
        log,
        i18n,
        settings: {
            core: () => ({ mode: 'balanced' }),
            module: <T extends object>(key: string) => (slices[key] ??= {}) as T,
            isModuleEnabled: () => true,
            setModuleEnabled() {},
            save() {},
            onChange: () => () => {},
            notify() {},
        } as unknown as SettingsService,
        files,
        chat,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks: new FakeTasks(),
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

    let disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    const tick = async (ms = 10) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    const env: CalendarEnv = {
        app,
        mock,
        host,
        chat,
        modules,
        ui,
        leader,
        slices,
        signals,
        revision,
        logLines,
        async start() {
            disposers = [];
            await calendarModule.init({
                app,
                settings: (slices.calendar ??= {}) as never,
                log,
                own: (dispose) => disposers.push(dispose),
            });
            await tick(50);
            return env.service();
        },
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            modules.apis.delete('calendar');
        },
        service() {
            const service = modules.api<CalendarService>('calendar');
            if (!service) throw new Error('not started');
            return service;
        },
        tick,
        async turn(spec = {}) {
            mock.chat.push(reply(spec));
            const index = mock.chat.length - 1;
            mock.chat.push(userMessage());
            await bus.emit('turn:committed', { messageIndex: index });
            await tick(SETTLE);
            return index;
        },
        async switchTo(chatId, messages = []) {
            mock.chat = messages;
            await switchChat(mock, chatId);
            await bus.emit('chat:changed', { chatId: chatId ?? null });
            await tick(50);
        },
    };
    return env;
}
