// M44 «Агенты» test harness: a small fake App: the module's real store, chat state, runner and runtime; fakes of the
// host (chat, card, saveChat), files, chat documents, the LLM client, ephemeral injections, tasks and the journal.
import { vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { agentsModule } from '../../../src/features/agents';
import type { AgentsApi } from '../../../src/features/agents';
import type { AgentDef } from '../../../src/domain/agents/types';
import type {
    App,
    GenerationInfo,
    InjectionSpec,
    LlmRequest,
    LlmResult,
    MessageStripProvider,
    PultTab,
    TaskRunner,
    TaskSpec,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestI18n, createTestLogger, settle } from '../../helpers/core-host';
import { FakeJournal } from '../../helpers/rules-app';

export type Dict = Record<string, unknown>;

export interface Harness {
    app: App;
    api: AgentsApi;
    chat: STChatMessage[];
    llm: ReturnType<typeof vi.fn>;
    answers: ((request: LlmRequest) => LlmResult)[];
    injections: Map<string, InjectionSpec>;
    flags: Map<string, string>;
    producers: Map<string, (gen: GenerationInfo) => void | Promise<void>>;
    tasks: TaskSpec[];
    runners: Map<string, TaskRunner>;
    journal: FakeJournal;
    files: Map<string, unknown>;
    docs: Map<string, unknown>;
    disposers: (() => void | Promise<void>)[];
    produce(type?: string): Promise<void>;
    saved: number;
}

export function msg(text: string, user: boolean, extra: Partial<STChatMessage> = {}): STChatMessage {
    return {
        name: user ? 'Я' : 'Мира',
        is_user: user,
        is_system: false,
        mes: text,
        swipe_id: 0,
        swipes: [text],
        extra: {},
        ...extra,
    } as STChatMessage;
}

export interface HarnessOptions {
    quality?: boolean;
    seed?: Map<string, unknown>;
    /** M12's API (the after-verdict hook). */
    qualityApi?: unknown;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
    const log = createTestLogger();
    const chat: STChatMessage[] = [
        msg('Привет.', false),
        msg('Я вхожу в таверну.', true),
        msg('Мира улыбается тебе.', false),
    ];
    const files = new Map<string, unknown>(options.seed ?? []);
    const docs = new Map<string, unknown>();
    const injections = new Map<string, InjectionSpec>();
    const flags = new Map<string, string>();
    const producers = new Map<string, (gen: GenerationInfo) => void | Promise<void>>();
    const tasks: TaskSpec[] = [];
    const runners = new Map<string, TaskRunner>();
    const journal = new FakeJournal();
    const answers: ((request: LlmRequest) => LlmResult)[] = [];
    const llm = vi.fn(async (request: LlmRequest): Promise<LlmResult> => {
        const answer = answers.shift();
        return answer ? answer(request) : { ok: false, error: 'transport: no answer' };
    });
    const exposed = new Map<string, unknown>();
    if (options.qualityApi) exposed.set('quality', options.qualityApi);
    const bus = createBus(log);
    const h = { saved: 0 } as Harness;
    const ctx = {
        chat,
        name1: 'Я',
        name2: 'Мира',
        characterId: '0',
        characters: [
            {
                name: 'Мира',
                avatar: 'Mira.png',
                description: 'A smuggler.',
                data: { description: 'A smuggler.', extensions: {} },
            },
        ],
        extensionSettings: { connectionManager: { profiles: [{ id: 'p1', name: 'Fast' }] } },
        chatMetadata: {},
        saveChat: async () => {
            h.saved += 1;
        },
        updateMessageBlock: () => {},
        substituteParams: (text: string) => text,
        writeExtensionField: vi.fn(async () => {}),
    };
    const ui = createFakeUi() as ReturnType<typeof createFakeUi> & {
        strip?: MessageStripProvider;
        addMessageStripProvider?: (provider: MessageStripProvider) => Unsubscribe;
    };
    const tabs: PultTab[] = [];
    (ui as unknown as { tabs: PultTab[] }).tabs = tabs;
    ui.addTab = (tab) => {
        tabs.push(tab);
        return () => undefined;
    };
    ui.addMessageStripProvider = (provider) => {
        ui.strip = provider;
        return () => undefined;
    };
    const app = {
        host: {
            ctx: () => ctx,
            chatId: () => 'chat-1',
            isGroupChat: () => false,
            isChatCompletion: () => true,
            version: () => '1.19',
            events: { on: () => () => {}, emit: async () => {}, name: () => undefined, reassertOrder() {} },
        },
        turn: { onIntercept: () => () => {}, lastAssistantIndex: () => chat.length - 1, current: () => null },
        log,
        i18n: (() => {
            const i18n = createTestI18n('ru');
            i18n.register(agentsModule.i18n!);
            return i18n;
        })(),
        settings: {
            core: () => ({ mode: 'balanced', profiles: {} }),
            module: () => ({}),
            isModuleEnabled: (key: string) => key === 'quality' && options.quality === true,
            setModuleEnabled() {},
            save() {},
            onChange: () => () => {},
            notify() {},
        },
        files: {
            read: async (name: string) => (files.has(name) ? structuredClone(files.get(name)) : null),
            write: async (name: string, data: unknown) => void files.set(name, structuredClone(data)),
            remove: async (name: string) => void files.delete(name),
            fileName: (kind: string, key?: string) => `maestro-${kind}${key ? `-${key}` : ''}.json`,
        },
        chat: {
            get: async (kind: string, defaults: () => object) => structuredClone(docs.get(kind) ?? defaults()),
            put: async (kind: string, data: unknown) => {
                docs.set(kind, structuredClone(data));
                return true;
            },
            getFor: async (_chat: string, kind: string, defaults: () => object) =>
                structuredClone(docs.get(kind) ?? defaults()),
            pointer: () => undefined,
            setPointer: async () => {},
            migration() {},
            exportChat: async () => ({}),
            importChat: async () => {},
        },
        leader: { isLeader: () => true, onChange: () => () => {} },
        tasks: {
            register: (kind: string, runner: TaskRunner): Unsubscribe => {
                runners.set(kind, runner);
                return () => runners.delete(kind);
            },
            enqueue: async (task: TaskSpec) => {
                tasks.push(task);
                return `t${tasks.length}`;
            },
            list: () => [],
            kick() {},
        },
        llm: { request: llm, available: () => true },
        cost: {
            record() {},
            recordAnlas() {},
            summary: () => ({}),
            backgroundCapReached: () => false,
            onChange: () => () => {},
        },
        journal,
        autonomy: {},
        inbox: {},
        ephemeral: {
            setFlag: (name: string, value: string | number | boolean) => void flags.set(name, String(value)),
            setInjection: (key: string, spec: InjectionSpec) => void injections.set(key, spec),
            addProducer: (name: string, producer: (gen: GenerationInfo) => void | Promise<void>) => {
                producers.set(name, producer);
                return () => producers.delete(name);
            },
            clearAll() {
                injections.clear();
                flags.clear();
            },
        },
        bus,
        ui,
        adapters: {},
        modules: {
            list: () => [],
            enable: async () => {},
            disable: async () => {},
            api: <T>(key: string) => exposed.get(key) as T | undefined,
            expose: (key: string, value: unknown) => void exposed.set(key, value),
        },
    } as unknown as App;
    const disposers: (() => void | Promise<void>)[] = [];
    await agentsModule.init({
        app,
        settings: { version: 1 },
        log,
        own: (dispose) => void disposers.push(dispose as () => void),
    });
    await settle(40);
    Object.assign(h, {
        app,
        api: exposed.get('agents') as AgentsApi,
        chat,
        llm,
        answers,
        injections,
        flags,
        producers,
        tasks,
        runners,
        journal,
        files,
        docs,
        disposers,
        async produce(type = 'normal') {
            injections.clear();
            flags.clear();
            await producers.get('agents')?.({ type, dryRun: false, quiet: false });
        },
    });
    return h;
}

export const TRACKER = '```json\n{"infoBox": {"location": "Tavern"}, "characters": []}\n```\n';

export function agent(def: Partial<AgentDef> & { id: string; name: string }): Dict {
    return {
        v: 1,
        kind: 'custom',
        origin: 'user',
        instruction: 'Do it.',
        sources: [{ id: 'messages', budget: 2 }],
        model: {},
        capabilities: [],
        updatedAt: 1,
        ...def,
    };
}

/** A harness whose agents file holds these agents, each switched on everywhere. */
export async function withAgents(
    defs: (Partial<AgentDef> & { id: string; name: string })[],
    options: Omit<HarnessOptions, 'seed'> = {},
): Promise<Harness> {
    const overrides: Dict = {};
    for (const def of defs) overrides[def.id] = { on: true };
    const seed = new Map<string, unknown>([
        [
            'maestro-agents.json',
            { schema: 1, agents: defs.map(agent), sets: [], global: { set: 'as-1-27', overrides }, hintShown: true },
        ],
    ]);
    return harness({ ...options, seed });
}

export function strip(h: Harness, index: number) {
    return (h.app.ui as unknown as { strip: MessageStripProvider }).strip.items(index);
}

export function tabsOf(h: Harness): PultTab[] {
    return (h.app.ui as unknown as { tabs: PultTab[] }).tabs;
}
