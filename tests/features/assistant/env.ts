// Test app for the assistant's core (M33): real settings, i18n and bus; an in-memory chat store (one cached object
// per chat and kind, like the real one), a scripted LLM, the recording journal and UI fakes, a few fake modules.
import { createBus } from '../../../src/core/bus';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import type { ToolSpec } from '../../../src/features/assistant/api';
import { createSettingsAccess, registerSettingUndo } from '../../../src/features/assistant/safety';
import { AssistantService } from '../../../src/features/assistant/service';
import type { AssistantDeps } from '../../../src/features/assistant/service';
import {
    ASSISTANT_KEY,
    defaultAssistantSettings,
    readAssistantSettings,
} from '../../../src/features/assistant/settings';
import type { AssistantSettings } from '../../../src/features/assistant/settings';
import { M33_STRINGS } from '../../../src/features/assistant/strings';
import type {
    App,
    ChatStore,
    LlmClient,
    LlmRequest,
    LlmResult,
    MaestroModule,
    ModuleManager,
} from '../../../src/shared/contracts';
import { UI_STRINGS } from '../../../src/ui/views/strings';
import { createFakeUi, createTestLogger } from '../../helpers/core-host';
import type { FakeUi } from '../../helpers/core-host';
import { FakeJournal } from '../../helpers/rules-app';

/* ------------------------------------------------------------------ chat store */

export class FakeChatStore implements ChatStore {
    /** Cached documents (the object get() returns), by `${chatId}|${kind}`. */
    readonly cache = new Map<string, object>();
    /** What put() saved, as JSON. */
    readonly saved = new Map<string, string>();
    puts = 0;
    /** The next N puts fail (as when another tab wrote first or the file write failed). */
    failPuts = 0;

    constructor(private readonly chatId: () => string | null) {}

    async get<T extends object>(kind: string, defaults: () => T): Promise<T> {
        const id = this.chatId();
        if (!id) return defaults();
        return this.getFor(id, kind, defaults);
    }

    async getFor<T extends object>(chatId: string, kind: string, defaults: () => T): Promise<T> {
        const key = `${chatId}|${kind}`;
        let doc = this.cache.get(key);
        if (!doc) {
            const saved = this.saved.get(key);
            doc = saved ? (JSON.parse(saved) as object) : defaults();
            this.cache.set(key, doc);
        }
        return doc as T;
    }

    async put<T extends object>(kind: string, data: T): Promise<boolean> {
        this.puts++;
        const id = this.chatId();
        if (!id) return false;
        if (this.failPuts > 0) {
            this.failPuts--;
            return false;
        }
        this.saved.set(`${id}|${kind}`, JSON.stringify(data));
        return true;
    }

    stored<T = Record<string, unknown>>(chatId: string, kind: string): T | undefined {
        const text = this.saved.get(`${chatId}|${kind}`);
        return text === undefined ? undefined : (JSON.parse(text) as T);
    }

    /** Forgets cached objects (a page reload). */
    dropCache(): void {
        this.cache.clear();
    }

    pointer<T>(): T | undefined {
        return undefined;
    }
    async setPointer(): Promise<void> {}
    migration(): void {}
    async exportChat(): Promise<Record<string, unknown>> {
        return {};
    }
    async importChat(): Promise<void> {}
}

/* ------------------------------------------------------------------ LLM */

export type LlmStep = LlmResult | ((request: LlmRequest) => LlmResult | Promise<LlmResult>);

export class FakeLlm implements LlmClient {
    /** Requests as they were sent (messages copied: the loop keeps appending to its array). */
    readonly requests: LlmRequest[] = [];
    readonly steps: LlmStep[] = [];
    usable = true;
    /** What is returned when the script runs out. */
    fallback: LlmResult = { ok: true, text: 'Done.' };

    script(...steps: LlmStep[]): this {
        this.steps.push(...steps);
        return this;
    }

    async request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
        this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
        const step = this.steps.shift() ?? this.fallback;
        const result = typeof step === 'function' ? await step(request) : step;
        return result as LlmResult<T>;
    }

    available(): boolean {
        return this.usable;
    }

    last(): LlmRequest {
        const request = this.requests[this.requests.length - 1];
        if (!request) throw new Error('no request');
        return request;
    }
}

export function answer(text: string, costUsd?: number): LlmResult {
    return costUsd === undefined ? { ok: true, text } : { ok: true, text, costUsd };
}

export function callOf(name: string, args: unknown = {}, id?: string): Record<string, unknown> {
    return {
        id: id ?? `prov_${name}`,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    };
}

export function calls(...items: Record<string, unknown>[]): LlmResult {
    return { ok: true, toolCalls: items, costUsd: 0.001 };
}

/* ------------------------------------------------------------------ tools */

export function readTool(name: string, run: ToolSpec['run'], extra: Partial<ToolSpec> = {}): ToolSpec {
    return {
        name,
        kind: 'read',
        description: `Reads ${name}.`,
        parameters: { type: 'object', properties: {} },
        run,
        ...extra,
    };
}

export interface WriteToolProbe {
    tool: ToolSpec;
    applied: Record<string, unknown>[];
    planned: Record<string, unknown>[];
}

/** A write tool that plans "x: before → after" and records what it applied. */
export function writeTool(name = 'set_thing', extra: Partial<ToolSpec> = {}): WriteToolProbe {
    const probe: WriteToolProbe = { applied: [], planned: [], tool: undefined as unknown as ToolSpec };
    probe.tool = {
        name,
        kind: 'write',
        description: `Changes ${name}.`,
        parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
        async plan(args) {
            probe.planned.push(args);
            return {
                summary: `Thing: 1 → ${String(args['value'])}`,
                target: 'Maestro · Test',
                before: 1,
                after: args['value'],
                async apply() {
                    probe.applied.push(args);
                    return { result: { uid: 7 } };
                },
            };
        },
        ...extra,
    };
    return probe;
}

/* ------------------------------------------------------------------ app */

export const TEST_MODULES: Record<string, Record<string, unknown>> = {
    director: {
        pacing: { every: 4, mode: 'auto' },
        enabled: true,
        tags: ['a', 'b'],
        apiKey: 'sk-should-never-show',
        proxyUrl: 'http://localhost',
        profileId: 'p1',
        model: 'deepseek',
        connection: { host: 'x', retries: 2 },
        rules: [{ id: 1 }],
        note: 'hello',
        maybe: null,
    },
    quality: { threshold: 0.5, judge: { endpoint: 'x' } },
    vault: { token: 'abc', password: 'x' },
};

export interface AssistantTestEnv {
    app: App;
    llm: FakeLlm;
    journal: FakeJournal;
    ui: FakeUi & { sections: { id: string; render(container: HTMLElement): void | (() => void) }[] };
    chat: FakeChatStore;
    settings: Settings;
    state: { chatId: string | null; locale: 'en' | 'ru'; profiles: { id: string; name: string }[] | null };
    saves: { count: number };
    notified: string[];
    log: ReturnType<typeof createTestLogger>;
    modules: { list: ReturnType<ModuleManager['list']>; apis: Map<string, unknown> };
    assistantSettings(): AssistantSettings;
    switchChat(chatId: string | null): Promise<void>;
    service(overrides?: Partial<AssistantDeps>): AssistantService;
}

export function createAssistantEnv(
    options: { chatId?: string | null; locale?: 'en' | 'ru'; modules?: Record<string, Record<string, unknown>> } = {},
): AssistantTestEnv {
    const log = createTestLogger();
    const state: AssistantTestEnv['state'] = {
        chatId: options.chatId === undefined ? 'chat-1' : options.chatId,
        locale: options.locale ?? 'en',
        profiles: [
            { id: 'p1', name: 'DeepSeek' },
            { id: 'p2', name: 'Claude' },
        ],
    };
    const saves = { count: 0 };
    const store: Record<string, unknown> = {};
    const settings = new Settings(
        () => store,
        () => {
            saves.count++;
        },
        log,
    );
    const notified: string[] = [];
    settings.onChange((path) => notified.push(path));

    const defs = { ...(options.modules ?? TEST_MODULES), [ASSISTANT_KEY]: { ...defaultAssistantSettings() } };
    const list: ReturnType<ModuleManager['list']> = Object.entries(defs).map(([key, defaults]) => ({
        module: {
            id: key === ASSISTANT_KEY ? 'M33' : key.toUpperCase(),
            key,
            stage: 1,
            titleKey: `test.title.${key}`,
            enabledByDefault: true,
            defaults: () => structuredClone(defaults),
            init() {},
        } as MaestroModule,
        enabled: true,
        running: true,
        missing: [],
    }));
    for (const entry of list) settings.registerModule(entry.module.key, entry.module.defaults, true);
    const apis = new Map<string, unknown>();

    const i18n = createI18n(() => state.locale);
    i18n.register(M33_STRINGS);
    i18n.register(UI_STRINGS);
    i18n.register({
        en: { 'test.title.director': 'Director', 'test.title.quality': 'Quality' },
        ru: { 'test.title.director': 'Режиссёр', 'test.title.quality': 'Качество' },
    });

    const chat = new FakeChatStore(() => state.chatId);
    const bus = createBus(log);
    const journal = new FakeJournal();
    const sections: AssistantTestEnv['ui']['sections'] = [];
    const ui = Object.assign(createFakeUi(), { sections }) as AssistantTestEnv['ui'];
    ui.addSettingsSection = (section) => {
        sections.push(section);
        return () => {
            const index = sections.indexOf(section);
            if (index >= 0) sections.splice(index, 1);
        };
    };
    const opened: string[] = [];
    ui.openPult = (tabId?: string) => void opened.push(tabId ?? '');
    const llm = new FakeLlm();
    const host = {
        ctx: () => ({
            ConnectionManagerRequestService: state.profiles
                ? { getSupportedProfiles: () => state.profiles ?? [] }
                : undefined,
        }),
        chatId: () => state.chatId,
        version: () => '1.19.0',
        isGroupChat: () => false,
        isChatCompletion: () => true,
    };
    const modules = {
        list: () => list,
        api: <T>(key: string) => apis.get(key) as T | undefined,
        expose: (key: string, api: unknown) => void apis.set(key, api),
        enable: async () => {},
        disable: async () => {},
    };
    const app = {
        host,
        log,
        i18n,
        settings,
        chat,
        bus,
        journal,
        ui,
        llm,
        modules,
    } as unknown as App;

    const assistantSettings = () => readAssistantSettings(settings.module<AssistantSettings>(ASSISTANT_KEY));

    return {
        app,
        llm,
        journal,
        ui,
        chat,
        settings,
        state,
        saves,
        notified,
        log,
        modules: { list, apis },
        assistantSettings,
        async switchChat(chatId) {
            state.chatId = chatId;
            await bus.emit('chat:changed', { chatId });
        },
        service(overrides = {}) {
            registerSettingUndo(app);
            return new AssistantService({
                app,
                log,
                settings: assistantSettings,
                access: createSettingsAccess(app),
                ...overrides,
            });
        },
    };
}

/** Lets the loop's promise chains (store writes, fake LLM) run. */
export async function flush(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Resolves once `check` is true (polling the event loop), or throws after many rounds. */
export async function until(check: () => boolean, rounds = 500): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        if (check()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('condition not reached');
}
