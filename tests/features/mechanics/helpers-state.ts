// Test app for the state and tracking parts of M25: the ST mock (assistant replies with a DES tracker carrying
// stats), real bus, files and chat store, a switchable leader, a fake definitions part, a fake DES adapter (live
// settings with character stats, the tracker of a message, setCharacterStats), a fake world model (Russian aliases),
// a recording journal, an autonomy fake with levels ('ask' answers through `askAnswer`), a fake LLM and cost meter.
// Fake timers drive the settle delay.
import { vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { DEFAULT_MECHANICS_SETTINGS } from '../../../src/features/mechanics/parts';
import type { DefinitionsPart, MechanicsSettings, PartDeps } from '../../../src/features/mechanics/parts';
import { MechanicState } from '../../../src/features/mechanics/state';
import { STATE_STRINGS } from '../../../src/features/mechanics/strings-state';
import { MechanicTracking } from '../../../src/features/mechanics/tracking';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type {
    App,
    AutonomyLevel,
    Decision,
    LlmRequest,
    LlmResult,
    Proposal,
    SettingsService,
    Signal,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger, switchChat } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeInbox, FakeJournal, FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export const SETTLE = 550;

/** Magic: mana (number with an event at 0) and schools (list), characters and the persona, tracked by the block. */
export function magicDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Magic with mana and schools',
        rules: 'Every spell costs mana.',
        attributes: [
            {
                id: 'mana',
                name: 'Мана',
                promptName: 'Mana',
                kind: 'number',
                min: 0,
                max: 100,
                initial: 50,
                events: [{ id: 'empty', when: { op: '<=', value: 0 }, text: '{holder} has no mana left.' }],
            },
            {
                id: 'schools',
                name: 'Школы',
                promptName: 'Schools',
                kind: 'list',
                options: ['fire', 'water'],
                multi: true,
            },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

/** Health: DES stats of the characters (Health in DES), stamina parsed in the background. */
export function healthDef(): MechanicDef {
    return {
        id: 'health',
        name: 'Здоровье',
        summary: 'Health and stamina',
        rules: 'Wounds lower health.',
        attributes: [
            { id: 'hp', name: 'Здоровье', promptName: 'Health', kind: 'number', min: 0, max: 100, initial: 100 },
            {
                id: 'stamina',
                name: 'Выносливость',
                promptName: 'Stamina',
                kind: 'number',
                min: 0,
                max: 10,
                initial: 10,
                tracking: 'background',
            },
        ],
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'desStats',
        scope: { kind: 'global' },
    };
}

/** Reputation of factions, a scale parsed in the background. */
export function reputationDef(): MechanicDef {
    return {
        id: 'rep',
        name: 'Репутация',
        summary: 'Standing with factions',
        rules: '',
        attributes: [
            {
                id: 'standing',
                name: 'Отношение',
                promptName: 'Standing',
                kind: 'scale',
                levels: ['hated', 'neutral', 'liked'],
                initial: 'neutral',
            },
        ],
        holders: { kind: 'factions', names: ['Guild', 'Crown'] },
        checks: [],
        tracking: 'background',
        scope: { kind: 'global' },
        // Always in the scene (else only when named in the last messages).
        pinned: true,
    };
}

export class FakeDefs implements DefinitionsPart {
    defs: MechanicDef[] = [];
    readonly off = new Set<string>();
    private readonly listeners = new Set<() => void>();
    list(): MechanicDef[] {
        return this.defs;
    }
    active(): MechanicDef[] {
        return this.defs.filter((def) => !this.off.has(def.id));
    }
    get(id: string): MechanicDef | null {
        return this.defs.find((def) => def.id === id) ?? null;
    }
    async save(def: MechanicDef): Promise<MechanicDef> {
        this.defs = [...this.defs.filter((item) => item.id !== def.id), def];
        this.emit();
        return def;
    }
    async remove(id: string): Promise<void> {
        this.defs = this.defs.filter((item) => item.id !== id);
        this.emit();
    }
    async setEnabledInChat(id: string, on: boolean): Promise<void> {
        if (on) this.off.delete(id);
        else this.off.add(id);
        this.emit();
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    dispose(): void {}
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

/** DES with its live settings object, the tracker of a message and the stats writer. */
export class FakeDes {
    available = true;
    workshop = false;
    readonly writes: { next: unknown; options: unknown }[] = [];
    readonly live: Record<string, unknown> = {
        trackerConfig: {
            presentCharacters: {
                characterStats: {
                    enabled: false,
                    customStats: [
                        { id: 'health', name: 'Health', enabled: false },
                        { id: 'arousal', name: 'Arousal', enabled: true },
                    ],
                },
            },
        },
    };

    constructor(private readonly mock: StMock) {}

    readonly id = 'des';
    present(): boolean {
        return this.available;
    }
    version(): string {
        return '2.6.0';
    }
    capabilities(): string[] {
        return [];
    }
    async ready(): Promise<void> {}
    settings(): Record<string, unknown> {
        return this.live;
    }
    stats(): { enabled: boolean; customStats: { id: string; name: string; enabled: boolean }[] } {
        const tracker = this.live.trackerConfig as { presentCharacters: { characterStats: never } };
        return tracker.presentCharacters.characterStats;
    }
    trackerFor(index: number) {
        const record = desSwipeRecord(this.mock.chat[index]);
        return record ? parseDesTracker(record) : null;
    }
    setCharacterStats(next: { id: string; name: string; enabled: boolean }[], options: { enable?: boolean } = {}) {
        this.writes.push({ next: structuredClone(next), options });
        const stats = this.stats();
        stats.customStats = structuredClone(next);
        if (options.enable !== undefined) stats.enabled = options.enable;
        return true;
    }
    isWorkshopOpen(): boolean {
        return this.workshop;
    }
}

export class LevelAutonomy {
    readonly levels = new Map<string, AutonomyLevel>();
    readonly proposals: Proposal[] = [];
    readonly never = new Set<string>();
    askAnswer = true;

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
        if (level === 'ask' && !this.askAnswer) return 'rejected';
        if (proposal.stillValid && !(await proposal.stillValid())) return 'skipped';
        try {
            await proposal.apply(proposal.payload);
        } catch {
            return 'skipped';
        }
        await this.journal.record({
            module: proposal.module,
            kind: proposal.kind,
            summary: proposal.title,
            changes: proposal.changes,
            ...(proposal.sourceMessage !== undefined ? { sourceMessage: proposal.sourceMessage } : {}),
        });
        return 'applied';
    }

    record(): void {}
    stats() {
        return [];
    }
    neverAuto(kind: string): void {
        this.never.add(kind);
    }
}

export class FakeLlm {
    availableFlag = true;
    readonly requests: LlmRequest[] = [];
    readonly responses: LlmResult[] = [];
    available(): boolean {
        return this.availableFlag;
    }
    async request<T>(request: LlmRequest): Promise<LlmResult<T>> {
        this.requests.push(request);
        return (this.responses.shift() ?? { ok: false, error: 'no response' }) as LlmResult<T>;
    }
}

/** World model: Russian aliases of the cast. */
export function fakeWorld(): WorldModelApi {
    const entities: Entity[] = [
        { id: 'character:kai', kind: 'character', name: 'Kai', aliases: ['Кай'], forms: ['Кая'], sources: [] },
        { id: 'character:mira', kind: 'character', name: 'Mira', aliases: ['Мира'], forms: [], sources: [] },
        { id: 'persona:алекс', kind: 'persona', name: 'Алекс', aliases: ['Alex'], forms: [], sources: [] },
    ];
    const names = (entity: Entity) =>
        [entity.name, ...entity.aliases, ...entity.forms].map((name) => name.toLowerCase());
    return {
        entities: () => entities,
        get: (id) => entities.find((entity) => entity.id === id),
        resolve: (name, kind) =>
            entities.find(
                (entity) => (!kind || entity.kind === kind) && names(entity).includes(name.trim().toLowerCase()),
            ),
        mentions: () => [],
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

export interface CastMember {
    name: string;
    stats?: Record<string, number | string>;
    offScene?: boolean;
}

/** An assistant reply (swipe 0) with a DES tracker of these characters when given. */
export function reply(text: string, cast?: CastMember[]): STChatMessage {
    const characters = (cast ?? []).map((member) => ({
        name: member.name,
        ...(member.stats ? { stats: Object.entries(member.stats).map(([name, value]) => ({ name, value })) } : {}),
        ...(member.offScene ? { present: false } : {}),
    }));
    return message(text, {
        name: 'Kai',
        swipe_id: 0,
        swipes: [text],
        swipe_info: [{ extra: {} }],
        extra: cast
            ? { dooms_tracker_swipes: [{ quests: null, infoBox: null, characterThoughts: JSON.stringify(characters) }] }
            : {},
    });
}

export function userMessage(text = 'Дальше'): STChatMessage {
    return message(text, { is_user: true, name: 'Алекс' });
}

export interface MechanicsEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    ui: FakeUi;
    leader: { value: boolean };
    settings: MechanicsSettings;
    defs: FakeDefs;
    des: FakeDes;
    journal: FakeJournal;
    autonomy: LevelAutonomy;
    inbox: FakeInbox;
    tasks: FakeTasks;
    llm: FakeLlm;
    cost: { cap: boolean };
    modules: FakeModules;
    signals: Signal[];
    rerendered: number[];
    logLines: LogLineRecord[];
    state: MechanicState;
    tracking: MechanicTracking;
    start(options?: { tracking?: boolean }): Promise<void>;
    stop(): void;
    tick(ms?: number): Promise<void>;
    /** Pushes a reply and emits MESSAGE_RECEIVED for it; returns its index. */
    receive(text: string, cast?: CastMember[], type?: string): Promise<number>;
    /** The user answers: a user message, then turn:committed for the reply and the settle pause. */
    commit(index: number): Promise<void>;
    switchTo(chatId: string | undefined, chat?: STChatMessage[]): Promise<void>;
}

export function createMechanicsEnv(locale: 'en' | 'ru' = 'en'): MechanicsEnv {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    mock.context.name1 = 'Алекс';
    mock.context.name2 = 'Kai';
    const rerendered: number[] = [];
    (mock.context as unknown as { updateMessageBlock: (index: number) => void }).updateMessageBlock = (index) => {
        rerendered.push(index);
    };
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const i18n = createI18n(() => locale);
    i18n.register(CORE_STRINGS);
    i18n.register(STATE_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
    modules.expose('world', fakeWorld());
    const des = new FakeDes(mock);
    const leader = { value: true };
    const ui = createFakeUi();
    const bus = createBus(log);
    const journal = new FakeJournal();
    const autonomy = new LevelAutonomy(journal);
    const inbox = new FakeInbox();
    const tasks = new FakeTasks();
    const llm = new FakeLlm();
    const cost = { cap: false };
    const signals: Signal[] = [];
    bus.on('signal', (signal) => {
        signals.push(signal);
    });
    const adapter = (id: string) => ({
        id,
        present: () => false,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
    });
    const app = {
        host,
        turn: new FakeTurn(),
        log,
        i18n,
        settings: { core: () => ({ mode: 'balanced' }) } as unknown as SettingsService,
        files,
        chat,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks,
        llm,
        cost: { backgroundCapReached: () => cost.cap } as unknown as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral: {} as App['ephemeral'],
        bus,
        ui,
        adapters: {
            des,
            desru: adapter('desru'),
            ck: adapter('ck'),
            bunnymo: adapter('bunnymo'),
            qvink: adapter('qvink'),
            nai: adapter('nai'),
            localizer: adapter('localizer'),
            preset: adapter('preset'),
        } as unknown as App['adapters'],
        modules,
    } as App;
    const settings: MechanicsSettings = { ...DEFAULT_MECHANICS_SETTINGS };
    const deps: PartDeps = { app, log, settings: () => settings };
    const defs = new FakeDefs();
    const tick = async (ms = 10) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    const env: MechanicsEnv = {
        app,
        mock,
        host,
        ui,
        leader,
        settings,
        defs,
        des,
        journal,
        autonomy,
        inbox,
        tasks,
        llm,
        cost,
        modules,
        signals,
        rerendered,
        logLines,
        state: new MechanicState(deps, defs),
        tracking: undefined as unknown as MechanicTracking,
        async start(options = {}) {
            env.state.install();
            if (options.tracking !== false) {
                env.tracking = new MechanicTracking(deps, defs, env.state);
                env.tracking.install();
            }
            await tick(50);
        },
        stop() {
            env.tracking?.dispose();
            env.state.dispose();
        },
        tick,
        async receive(text, cast, type = 'normal') {
            mock.chat.push(reply(text, cast));
            const index = mock.chat.length - 1;
            await mock.eventSource.emit('message_received', index, type);
            return index;
        },
        async commit(index) {
            mock.chat.push(userMessage());
            await bus.emit('turn:committed', { messageIndex: index });
            await tick(SETTLE);
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
