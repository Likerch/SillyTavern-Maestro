// A test App for M13/M14: the ST mock with the real turn pipeline, ephemeral flags and injections, bus, files and chat
// store; fakes of settings, the task queue, the LLM client, leader, cost, UI and the neighbour adapters (DES tracker
// from chat messages, DES roster, NAI Studio presence/settings/API, Qvink memories).
import { vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import { createEphemeral } from '../../../src/core/ephemeral';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { TurnPipeline } from '../../../src/core/turn';
import type { EphemeralRunner } from '../../../src/core/turn';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import { DirectorService, DIRECTOR_STRINGS, readDirectorSettings } from '../../../src/features/director';
import type { DirectorSettings, DirectorTimings } from '../../../src/features/director';
import type {
    App,
    LlmRequest,
    LlmResult,
    PultTab,
    SettingsService,
    TaskRunner,
    TaskSpec,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, TestHost } from '../../helpers/core-host';
import { FakeModules } from '../../helpers/rules-app';
import { EVENT_TYPES, installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export type Dict = Record<string, unknown>;

export const FAST: DirectorTimings = { draftMs: 50, lateMs: 50, saveMs: 20 };

export interface Prompt {
    value: string;
    position: number;
    depth: number;
    role: number;
}

export class FakeNai {
    readonly version = 1;
    providers: { id: string; priority: number; describe(context: unknown): unknown }[] = [];
    offs = 0;
    passports() {
        return [];
    }
    getPassport() {
        return null;
    }
    async savePassport() {}
    async setOutfit() {}
    async setState() {}
    async clearChatOverride() {}
    on() {
        return () => {};
    }
    registerSceneProvider(provider: { id: string; priority: number; describe(context: unknown): unknown }) {
        this.providers.push(provider);
        return () => {
            this.offs++;
            this.providers = this.providers.filter((item) => item !== provider);
        };
    }
}

export interface DirectorEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    modules: FakeModules;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string> };
    pipeline: TurnPipeline;
    ephemeral: EphemeralRunner;
    core: { mode: 'economy' | 'balanced' | 'cinema' };
    slices: Record<string, Dict>;
    leader: { value: boolean };
    llm: { available: boolean; respond: (request: LlmRequest) => LlmResult; requests: LlmRequest[] };
    tasks: { runners: Map<string, TaskRunner>; queued: TaskSpec[] };
    prompts: Map<string, Prompt>;
    nai: { present: boolean; settings: Dict | null; api: FakeNai | undefined };
    des: { known: string[] };
    qvink: { present: boolean; memories: Map<number, Dict> };
    settings(): DirectorSettings;
    start(timings?: Partial<DirectorTimings>): DirectorService;
    stop(): Promise<void>;
    service(): DirectorService;
    tick(ms?: number): Promise<void>;
    /** An assistant reply arrives (reply:ready) and its draft is read. */
    reply(text: string, tracker?: TrackerParts): Promise<number>;
    /** The user sends a message: the reply before is committed; then a normal generation runs and ends. */
    send(text: string, options?: { end?: boolean }): Promise<Record<string, unknown>>;
    /** Runs a generation of a type through the real interceptor; returns the flags it set (before the end). */
    generate(type: string, options?: { end?: boolean }): Promise<Record<string, unknown>>;
    end(): Promise<void>;
    runTasks(): Promise<void>;
    variables(): Record<string, unknown>;
}

export interface TrackerParts {
    location?: string;
    characters?: Dict[];
    quests?: Dict | null;
    info?: Dict;
}

let sent = 0;

export function trackerMessage(text: string, parts: TrackerParts = {}): STChatMessage {
    const info = {
        date: '3 марта',
        time: { start: '14:00' },
        ...(parts.location ? { location: parts.location } : {}),
        ...parts.info,
    };
    return message(text, {
        name: 'Лиза',
        swipe_id: 0,
        send_date: `date-${++sent}`,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: parts.quests ? JSON.stringify(parts.quests) : null,
                    infoBox: JSON.stringify(info),
                    characterThoughts: JSON.stringify(parts.characters ?? [{ name: 'Лиза' }]),
                },
            ],
        },
    });
}

function adapter(id: string, extra: Dict = {}): Dict {
    return {
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    };
}

export function createDirectorEnv(): DirectorEnv {
    const mock = installStMock();
    mock.chatId = 'Лиза - 2026-10-05@12h00m00s';
    const host = createTestHost(mock);
    const log = createTestLogger();
    const bus = createBus(log);
    const ephemeral = createEphemeral({ host, log });
    const pipeline = new TurnPipeline(host, bus, ephemeral, log);
    pipeline.install();
    const prompts = new Map<string, Prompt>();
    (mock.context as unknown as Dict).setExtensionPrompt = (
        key: string,
        value: string,
        position: number,
        depth: number,
        _scan: boolean,
        role: number,
    ) => {
        prompts.set(key, { value, position, depth, role });
    };
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(DIRECTOR_STRINGS);
    const files = createFileStore(host, log);
    const chatStore = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
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
    const core = { mode: 'balanced' as 'economy' | 'balanced' | 'cinema' };
    const slices: Record<string, Dict> = {};
    const leader = { value: true };
    const tasks = { runners: new Map<string, TaskRunner>(), queued: [] as TaskSpec[] };
    const nai = { present: true, settings: null as Dict | null, api: undefined as FakeNai | undefined };
    const des = { known: [] as string[] };
    const qvink = { present: false, memories: new Map<number, Dict>() };

    const adapters = {
        des: adapter('des', {
            trackerFor: (index: number) => {
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
            knownCharacters: () => [...des.known],
        }),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink', {
            present: () => qvink.present,
            memoryOf: (index: number) => qvink.memories.get(index) ?? null,
        }),
        nai: adapter('nai', {
            present: () => nai.present,
            settings: () => nai.settings,
            api: () => nai.api,
        }),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];

    const llm = {
        available: true,
        respond: (() => ({ ok: false, error: 'no answer' })) as (request: LlmRequest) => LlmResult,
        requests: [] as LlmRequest[],
    };

    const app = {
        host,
        turn: pipeline,
        log,
        i18n,
        settings: {
            core: () => core,
            module: <T extends object>(key: string) => (slices[key] ??= {}) as T,
            isModuleEnabled: () => true,
            setModuleEnabled() {},
            save() {},
            onChange: () => () => {},
            notify() {},
        } as unknown as SettingsService,
        files,
        chat: chatStore,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks: {
            register(kind: string, runner: TaskRunner): Unsubscribe {
                tasks.runners.set(kind, runner);
                return () => tasks.runners.delete(kind);
            },
            async enqueue(task: TaskSpec): Promise<string> {
                const index = tasks.queued.findIndex((item) => item.dedupeKey && item.dedupeKey === task.dedupeKey);
                if (index >= 0) tasks.queued.splice(index, 1);
                tasks.queued.push(structuredClone(task));
                return `task${tasks.queued.length}`;
            },
            list: () => [],
            kick() {},
        },
        llm: {
            available: () => llm.available,
            async request<T>(request: LlmRequest): Promise<LlmResult<T>> {
                llm.requests.push(request);
                return llm.respond(request) as LlmResult<T>;
            },
        },
        cost: { backgroundCapReached: () => false } as unknown as App['cost'],
        journal: {} as App['journal'],
        autonomy: {} as App['autonomy'],
        inbox: {} as App['inbox'],
        ephemeral,
        bus,
        ui,
        adapters,
        modules,
    } as App;

    let running: DirectorService | null = null;
    let disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];

    const tick = async (ms = 10) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    const runGeneration = async (type: string, end: boolean): Promise<Record<string, unknown>> => {
        await pipeline.intercept([...mock.chat], type);
        const flags = { ...((mock.chatMetadata.variables as Dict | undefined) ?? {}) };
        if (end) await env.end();
        return flags;
    };

    const env: DirectorEnv = {
        app,
        mock,
        host,
        modules,
        ui,
        pipeline,
        ephemeral,
        core,
        slices,
        leader,
        llm,
        tasks,
        prompts,
        nai,
        des,
        qvink,
        settings: () => readDirectorSettings((slices.director ??= {}) as Partial<DirectorSettings>),
        start(timings = {}) {
            const service = new DirectorService(app, log, env.settings, { ...FAST, ...timings });
            disposers = [];
            service.install((dispose) => disposers.push(dispose));
            running = service;
            modules.expose('director', service);
            return service;
        },
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            running = null;
        },
        service() {
            if (!running) throw new Error('not started');
            return running;
        },
        tick,
        async reply(text, tracker) {
            mock.chat.push(trackerMessage(text, tracker));
            const index = mock.chat.length - 1;
            await bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
            await tick(FAST.draftMs + 20);
            return index;
        },
        async send(text, options = {}) {
            mock.chat.push(message(text, { is_user: true, name: 'Алекс', send_date: `date-${++sent}` }));
            await mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, mock.chat.length - 1);
            return runGeneration('normal', options.end !== false);
        },
        generate(type, options = {}) {
            return runGeneration(type, options.end !== false);
        },
        async end() {
            await mock.eventSource.emit(EVENT_TYPES.GENERATION_ENDED!, mock.chat.length - 1);
            await tick(FAST.lateMs + 20);
        },
        async runTasks() {
            for (const task of tasks.queued.splice(0)) {
                const runner = tasks.runners.get(task.kind);
                if (runner) {
                    await runner(task.payload, {
                        ...task,
                        id: 't',
                        state: 'running',
                        attempts: 1,
                        createdAt: Date.now(),
                    });
                }
            }
            await tick(FAST.saveMs + 10);
        },
        variables: () => (mock.chatMetadata.variables as Dict | undefined) ?? {},
    };
    return env;
}

export function userMessage(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'Алекс', send_date: `date-${++sent}` });
}
