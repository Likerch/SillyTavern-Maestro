// A small App for M22 tests: the ST mock (with a message formatter, slash commands and tool calling added), real
// Settings / I18n / Bus, and recording fakes of the journal, autonomy, inbox, tasks, turn hooks, UI and adapters.
import { createBus } from '../../src/core/bus';
import { createI18n } from '../../src/core/i18n';
import { Settings } from '../../src/core/settings';
import { CORE_STRINGS } from '../../src/core/strings';
import { defaultRulesSettings } from '../../src/features/rules/engine';
import { RULES_STRINGS } from '../../src/features/rules/strings';
import type {
    App,
    AutonomyLevel,
    Decision,
    GenerationInfo,
    Inbox,
    Journal,
    JournalAction,
    JournalChange,
    JournalRecord,
    ModuleManager,
    NeighbourAdapter,
    Proposal,
    PultTab,
    TaskQueue,
    TaskRunner,
    TaskSpec,
    TurnHooks,
    Ui,
    UndoHandler,
    Unsubscribe,
} from '../../src/shared/contracts';
import type { LoreJournalApi, SimulateOptions, TurnLoreRecord } from '../../src/features/loreJournal/api';
import { createTestHost, createTestLogger } from './core-host';
import type { LogLineRecord, TestHost } from './core-host';
import { installStMock } from './st-mock';
import type { StMock } from './st-mock';

export class FakeJournal implements Journal {
    readonly records: JournalRecord[] = [];
    readonly handlers = new Map<string, UndoHandler>();
    private next = 1;

    async record(action: JournalAction): Promise<string> {
        const id = `j${this.next++}`;
        this.records.push({ ...structuredClone(action), id, at: Date.now(), chatId: 'chat-1' });
        return id;
    }

    async undo(id: string): Promise<boolean> {
        const record = this.records.find((item) => item.id === id);
        if (!record || record.undone) return false;
        for (const change of [...record.changes].reverse()) {
            const handler = this.handlers.get(change.target);
            if (!handler || !(await handler(change))) return false;
        }
        record.undone = true;
        return true;
    }

    async undoForMessage(): Promise<number> {
        return 0;
    }

    list(): JournalRecord[] {
        return this.records;
    }

    registerUndo(target: string, handler: UndoHandler): void {
        this.handlers.set(target, handler);
    }
}

export class FakeAutonomy {
    readonly levels = new Map<string, AutonomyLevel>();
    readonly proposals: Proposal[] = [];

    constructor(private readonly journal: FakeJournal) {}

    level(kind: string, fallback: AutonomyLevel): AutonomyLevel {
        return this.levels.get(kind) ?? fallback;
    }

    async decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision> {
        this.proposals.push(proposal as Proposal);
        const level = this.level(proposal.kind, fallback);
        if (level === 'off') return 'skipped';
        if (level === 'inbox') return 'queued';
        if (level === 'notify') return 'notified';
        if (proposal.stillValid && !(await proposal.stillValid())) return 'skipped';
        await proposal.apply(proposal.payload);
        await this.journal.record({
            module: proposal.module,
            kind: proposal.kind,
            summary: proposal.title,
            changes: proposal.changes,
        });
        return 'applied';
    }

    record(): void {}
    stats() {
        return [];
    }
    neverAuto(): void {}
}

export class FakeInbox implements Inbox {
    readonly appliers = new Map<string, (payload: unknown) => Promise<void>>();
    registerApplier(kind: string, apply: (payload: unknown) => Promise<void>): Unsubscribe {
        this.appliers.set(kind, apply);
        return () => this.appliers.delete(kind);
    }
    async add(): Promise<string> {
        return 'card';
    }
    list() {
        return [];
    }
    async accept(): Promise<boolean> {
        return true;
    }
    async reject(): Promise<void> {}
    async snooze(): Promise<void> {}
    async invalidateMessage(): Promise<number> {
        return 0;
    }
    onChange(): Unsubscribe {
        return () => {};
    }
    count(): number {
        return 0;
    }
}

export class FakeTasks implements TaskQueue {
    readonly runners = new Map<string, TaskRunner>();
    readonly queued: TaskSpec[] = [];
    register(kind: string, runner: TaskRunner): Unsubscribe {
        this.runners.set(kind, runner);
        return () => this.runners.delete(kind);
    }
    async enqueue(task: TaskSpec): Promise<string> {
        this.queued.push(task);
        return `t${this.queued.length}`;
    }
    list() {
        return [];
    }
    kick(): void {}
    /** Runs the runner of the latest queued task of a kind. */
    async runLatest(kind: string): Promise<void> {
        const task = [...this.queued].reverse().find((item) => item.kind === kind);
        const runner = this.runners.get(kind);
        if (!task || !runner) throw new Error(`no ${kind} task or runner`);
        await runner(task.payload, { ...task, id: 'x', state: 'running', attempts: 1, createdAt: 0 });
    }
}

export class FakeTurn implements TurnHooks {
    readonly handlers = new Set<(chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>>();
    onIntercept(handler: (chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>): Unsubscribe {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
    lastAssistantIndex(): number {
        return -1;
    }
    current(): GenerationInfo | null {
        return null;
    }
    async intercept(chat: STChatMessage[], info: Partial<GenerationInfo> = {}): Promise<void> {
        const full: GenerationInfo = { type: 'normal', dryRun: false, quiet: false, ...info };
        for (const handler of [...this.handlers]) await handler(chat, full);
    }
}

export class FakeModules implements ModuleManager {
    readonly apis = new Map<string, unknown>();
    list() {
        return [];
    }
    async enable(): Promise<void> {}
    async disable(): Promise<void> {}
    api<T>(key: string): T | undefined {
        return this.apis.get(key) as T | undefined;
    }
    expose(key: string, api: unknown): void {
        this.apis.set(key, api);
    }
}

export interface RecordingUi extends Ui {
    tabs: PultTab[];
    styles: Map<string, string>;
    notices: string[];
}

export function recordingUi(): RecordingUi {
    const ui: RecordingUi = {
        tabs: [],
        styles: new Map(),
        notices: [],
        addTab(tab) {
            ui.tabs.push(tab);
            return () => {
                ui.tabs = ui.tabs.filter((item) => item !== tab);
            };
        },
        addHealthCheck: () => () => {},
        addWizardStep: () => () => {},
        addSlashCommand: () => () => {},
        openPult() {},
        refresh() {},
        notice(text) {
            ui.notices.push(text);
        },
        async confirm() {
            return true;
        },
        messageBadge: () => () => {},
        style(id, css) {
            ui.styles.set(id, css);
            return () => {
                if (ui.styles.get(id) === css) ui.styles.delete(id);
            };
        },
    };
    return ui;
}

/** Neighbour state the fake adapters report (live, like the real probes). */
export interface NeighbourState {
    qvink: { present: boolean; chat: boolean; removeMessages: boolean; settings: Record<string, unknown> | null };
    ck: { present: boolean };
    des: { present: boolean };
}

function fakeAdapter(id: NeighbourAdapter['id'], caps: () => string[], extra: Record<string, unknown> = {}) {
    return {
        id,
        present: () => caps().length > 0,
        version: () => undefined,
        capabilities: caps,
        ready: async () => {},
        ...extra,
    };
}

function fakeAdapters(state: NeighbourState): App['adapters'] {
    const qvinkCaps = () => {
        const q = state.qvink;
        if (!q.present) return [];
        const list = ['qvink.present'];
        if (q.chat) list.push('qvink.chat');
        if (q.chat && q.removeMessages) list.push('qvink.removeMessages');
        return list;
    };
    const none = () => [];
    return {
        qvink: fakeAdapter('qvink', qvinkCaps, {
            chatEnabled: () => state.qvink.chat,
            removesMessages: () => state.qvink.removeMessages,
            settings: () => state.qvink.settings,
        }),
        ck: fakeAdapter('ck', () => (state.ck.present ? ['ck.present'] : [])),
        des: fakeAdapter('des', () => (state.des.present ? ['des.present'] : [])),
        desru: fakeAdapter('desru', none),
        bunnymo: fakeAdapter('bunnymo', none),
        nai: fakeAdapter('nai', none),
        localizer: fakeAdapter('localizer', none),
        preset: fakeAdapter('preset', none),
    } as unknown as App['adapters'];
}

export interface FormatterHook {
    fn: (mes: string, info: STMessageFormattingInfo) => string;
    options?: { stage?: string; order?: number };
}

export interface RulesTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    settings: Settings;
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: FakeInbox;
    tasks: FakeTasks;
    turn: FakeTurn;
    modules: FakeModules;
    ui: RecordingUi;
    log: ReturnType<typeof createTestLogger>;
    logLines: LogLineRecord[];
    /** Host capabilities that are present (`st.*`). */
    caps: Set<string>;
    neighbours: NeighbourState;
    /** STscript lines run through executeSlashCommandsWithOptions. */
    slash: string[];
    hooks: FormatterHook[];
    /** Marks the first-run wizard done (lore rules default on). */
    finishWizard(): void;
}

export const ST_CAPS = [
    'st.events.entriesLoaded',
    'st.events.scanDone',
    'st.messageFormatter',
    'st.events.ccPromptReady',
];

export function createRulesTestApp(options: { firstRunDone?: boolean } = {}): RulesTestApp {
    const mock = installStMock();
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const caps = new Set(ST_CAPS);
    host.caps = { register() {}, has: (id) => caps.has(id), report: () => [], refresh: async () => {} };

    const slash: string[] = [];
    const hooks: FormatterHook[] = [];
    Object.assign(mock.context as unknown as Record<string, unknown>, {
        messageFormatter: {
            addHook(fn: FormatterHook['fn'], hookOptions?: FormatterHook['options']) {
                hooks.push({ fn, options: hookOptions });
            },
        },
        executeSlashCommandsWithOptions: async (text: string) => {
            slash.push(text);
            return { isError: false };
        },
        SlashCommandParser: {
            addCommandObject() {},
            commands: { 'qm-summarize': {}, 'qm-toggle-exclude': {} },
        },
        isToolCallingSupported: () => false,
    });

    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('rules', defaultRulesSettings, true);
    if (options.firstRunDone) settings.core().firstRunDone = true;

    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(RULES_STRINGS);

    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new FakeInbox();
    const tasks = new FakeTasks();
    const turn = new FakeTurn();
    const modules = new FakeModules();
    const ui = recordingUi();
    const neighbours: NeighbourState = {
        qvink: { present: true, chat: true, removeMessages: true, settings: {} },
        ck: { present: true },
        des: { present: true },
    };

    const app = {
        host,
        turn,
        log,
        i18n,
        settings,
        files: {} as App['files'],
        chat: {} as App['chat'],
        leader: { isLeader: () => true, onChange: () => () => {} },
        tasks,
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral: {} as App['ephemeral'],
        bus: createBus(log),
        ui,
        adapters: fakeAdapters(neighbours),
        modules,
    } as App;

    return {
        app,
        mock,
        host,
        settings,
        journal,
        autonomy,
        inbox,
        tasks,
        turn,
        modules,
        ui,
        log,
        logLines,
        caps,
        neighbours,
        slash,
        hooks,
        finishWizard() {
            settings.core().firstRunDone = true;
            settings.notify('core.firstRunDone');
        },
    };
}

/** Errors logged through the test logger (rules swallow their own exceptions). */
export function loggedErrors(env: RulesTestApp): unknown[][] {
    return env.logLines.filter((line) => line.level === 'error').map((line) => line.args);
}

/**
 * A fake of M1 that runs a given scan function as its "dry run": simulating() and suspendedRules() reflect the
 * options while the scan runs, and the activations come from what the scan returns.
 */
export class FakeLoreJournal implements LoreJournalApi {
    private active = false;
    private suspendedIds: string[] = [];
    readonly calls: SimulateOptions[] = [];

    constructor(private readonly scan: () => Promise<TurnLoreRecord['activations']>) {}

    turns(): TurnLoreRecord[] {
        return [];
    }
    last(): TurnLoreRecord | undefined {
        return undefined;
    }
    async whyActive() {
        return [];
    }
    summary() {
        return {
            turns: 3,
            heaviestBooks: [{ world: 'Big World', activations: 12, avgChars: 18000 }],
            heaviestEntries: [],
            alwaysActive: [],
            neverActive: [],
            avgTotalChars: 20000,
            avgCanonChars: 0,
        };
    }
    async simulate(options: SimulateOptions = {}): Promise<TurnLoreRecord> {
        this.calls.push(options);
        this.active = true;
        this.suspendedIds = options.suspendRules ?? [];
        try {
            const activations = await this.scan();
            const live = activations.filter((item) => !item.cut);
            return {
                messageIndex: -1,
                at: 0,
                generationType: 'normal',
                activations,
                totalChars: live.reduce((sum, item) => sum + item.chars, 0),
                totalTokens: live.reduce((sum, item) => sum + item.tokens, 0),
                overflow: false,
                simulated: true,
            };
        } finally {
            this.active = false;
            this.suspendedIds = [];
        }
    }
    async attributeKeys(record: TurnLoreRecord): Promise<TurnLoreRecord> {
        return record;
    }
    onTurn(): Unsubscribe {
        return () => {};
    }
    simulating(): boolean {
        return this.active;
    }
    suspendedRules(): string[] {
        return this.suspendedIds;
    }
}

export type { JournalChange };
