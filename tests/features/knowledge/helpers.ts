// Test app for M18 «Кто что знает»: the ST mock with chat messages carrying DES tracker data, real settings, i18n, bus,
// files and chat store, a recording journal with undo, a switchable leader, a DES adapter with hidden names, and small
// fakes of the world model (the voices test one), the signals service and the revision. The knowledge service starts
// the way its module does it, with short waits.
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import type { KnowledgeApi } from '../../../src/features/knowledge/api';
import { KnowledgeService } from '../../../src/features/knowledge/service';
import { defaultKnowledgeSettings, readKnowledgeSettings } from '../../../src/features/knowledge/settings';
import type { KnowledgeSettings } from '../../../src/features/knowledge/settings';
import { KNOWLEDGE_STRINGS } from '../../../src/features/knowledge/strings';
import type { DeferredCard, RevisionApi, RevisionRun } from '../../../src/features/revision/api';
import type { SignalBatch, SignalsApi } from '../../../src/features/signals/api';
import type { App, PultTab, Signal, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeJournal, FakeModules } from '../../helpers/rules-app';
import { installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';
import { FakeWorld } from '../voices/helpers';
import type { EntitySpec } from '../voices/helpers';

export { trackerReply, userMessage } from '../voices/helpers';

/** Lets zero-delay jobs and the mocked file I/O finish (spins on setImmediate: timers cost ~15 ms on Windows). */
export async function settle(ms = 30): Promise<void> {
    const end = Date.now() + ms;
    do {
        await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < end);
}

export const WORLD: EntitySpec[] = [
    { name: 'Kai', kind: 'persona', forms: ['Кай', 'Кая', 'Каю', 'Каем'] },
    { name: 'Anna', aliases: ['Annie'], forms: ['Анна', 'Анны', 'Анне', 'Анну', 'Анной'] },
    { name: 'Corvin', forms: ['Корвин', 'Корвина', 'Корвину'] },
    { name: 'Bob', forms: ['Боб', 'Боба'] },
];

export class FakeSignals implements SignalsApi {
    pendingList: Signal[] = [];
    private readonly listeners = new Set<(batch: SignalBatch) => void>();
    pending(): Signal[] {
        return this.pendingList;
    }
    async consume(): Promise<void> {}
    last(): SignalBatch | null {
        return null;
    }
    messagesSinceRevision(): number {
        return 0;
    }
    onBatch(listener: (batch: SignalBatch) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(batch: SignalBatch): void {
        for (const listener of [...this.listeners]) listener(batch);
    }
    listenerCount(): number {
        return this.listeners.size;
    }
}

export class FakeRevision implements RevisionApi {
    cards: DeferredCard[] = [];
    readonly dismissed: string[] = [];
    private readonly changeListeners = new Set<() => void>();
    private readonly runListeners = new Set<(run: RevisionRun) => void>();
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
        this.changed();
    }
    changed(): void {
        for (const listener of [...this.changeListeners]) listener();
    }
    add(card: Partial<DeferredCard> & { value: string }): DeferredCard {
        const full: DeferredCard = {
            id: `def-${this.cards.length + 1}`,
            target: 'deferred.secret',
            entityName: 'Anna',
            evidence: '',
            sourceMessage: 1,
            at: Date.now(),
            ...card,
        };
        this.cards.push(full);
        return full;
    }
}

/** A signal of the signals service for a committed reply. */
export function signal(kind: string, messageIndex: number, data: Record<string, unknown> = {}): Signal {
    return { kind, chatId: 'chat-1', messageIndex, data, at: Date.now() };
}

export interface KnowledgeTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    journal: FakeJournal;
    modules: FakeModules;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string> };
    leader: { value: boolean };
    hidden: string[];
    world: FakeWorld;
    settings: Settings;
    logLines: LogLineRecord[];
    knowledgeSettings(): KnowledgeSettings;
}

export function createKnowledgeTestApp(world: EntitySpec[] = WORLD): KnowledgeTestApp {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    mock.context.name1 = 'Kai';
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('knowledge', defaultKnowledgeSettings, true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(KNOWLEDGE_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new FakeJournal();
    const modules = new FakeModules();
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
    const hidden: string[] = [];
    const adapter = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    });
    const adapters = {
        des: adapter('des', { removedCharacters: () => [...hidden] }),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink'),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const fakeWorld = new FakeWorld(world);
    modules.expose('world', fakeWorld);
    const app = {
        host,
        turn: {} as App['turn'],
        log,
        i18n,
        settings,
        files,
        chat,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks: {} as App['tasks'],
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal,
        autonomy: {} as App['autonomy'],
        inbox: {} as App['inbox'],
        ephemeral: {} as App['ephemeral'],
        bus: createBus(log),
        ui,
        adapters,
        modules,
    } as App;
    return {
        app,
        mock,
        host,
        chat,
        journal,
        modules,
        ui,
        leader,
        hidden,
        world: fakeWorld,
        settings,
        logLines,
        knowledgeSettings: () => readKnowledgeSettings(settings.module<Partial<KnowledgeSettings>>('knowledge')),
    };
}

export interface Started {
    service: KnowledgeService;
    api: KnowledgeApi;
    stop(): void;
}

/** Starts the service the way the module does (short waits) and exposes its API. */
export function startKnowledge(env: KnowledgeTestApp, options: { batchWaitMs?: number } = {}): Started {
    const service = new KnowledgeService(env.app, env.app.log, env.knowledgeSettings, {
        batchWaitMs: options.batchWaitMs ?? 40,
        settleMs: 5,
    });
    const offs = service.install();
    const api = service.api();
    env.modules.expose('knowledge', api);
    return {
        service,
        api,
        stop() {
            for (const off of offs.splice(0).reverse()) off();
            env.modules.apis.delete('knowledge');
        },
    };
}

/** One turn: the reply is in the chat, the user answers, the reply is committed (P14). Returns its index. */
export async function commit(env: KnowledgeTestApp, reply: STChatMessage, answer = 'go on'): Promise<number> {
    env.mock.chat.push(reply);
    const index = env.mock.chat.length - 1;
    env.mock.chat.push({ name: 'Kai', is_user: true, is_system: false, send_date: '', mes: answer, extra: {} });
    await env.app.bus.emit('turn:committed', { messageIndex: index });
    return index;
}
