// Fakes for the assistant's tools (M33, stage 13), shared by the read tools (part B) and the write tools (part C):
// a small App whose module APIs, module list, chat, capabilities, journal, inbox, health checks and neighbours are
// set by hand, an allowlisted SettingsAccess over plain objects, and a ToolContext builder. Everything is mutable
// so a test can change the state between calls (fake.apis.set('director', …), fake.chat.push(…)).
import type { SettingsAccess, ToolContext, ToolSpec, WritePlan } from '../../../src/features/assistant/api';
import type {
    App,
    CapabilityReport,
    CostEntry,
    CostSummary,
    HealthCheck,
    InboxCard,
    JournalAction,
    JournalRecord,
    Logger,
    MaestroModule,
    NeighbourAdapter,
} from '../../../src/shared/contracts';

/** A loose view of a tool's JSON output in assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool outputs are plain JSON checked field by field
export type Loose = Record<string, any>;

/* ------------------------------------------------------------------ logger */

export interface QuietLogger extends Logger {
    lines: { level: string; args: unknown[] }[];
}

export function quietLogger(): QuietLogger {
    const lines: { level: string; args: unknown[] }[] = [];
    const logger: QuietLogger = {
        lines,
        debug: (...args) => lines.push({ level: 'debug', args }),
        info: (...args) => lines.push({ level: 'info', args }),
        warn: (...args) => lines.push({ level: 'warn', args }),
        error: (...args) => lines.push({ level: 'error', args }),
        scope: () => logger,
    };
    return logger;
}

/* ------------------------------------------------------------------ app */

export interface FakeModuleRow {
    key: string;
    id: string;
    stage: number;
    titleKey?: string;
    enabled?: boolean;
    running?: boolean;
    missing?: string[];
}

export type FakeAdapter = Partial<NeighbourAdapter> & Record<string, unknown>;

export interface FakeAppOptions {
    /** Module APIs by key (app.modules.api). */
    apis?: Record<string, unknown>;
    /** Rows of app.modules.list(). */
    modules?: FakeModuleRow[];
    /** Capability ids that are present; `report` overrides the generated report. */
    caps?: string[];
    capsReport?: CapabilityReport[];
    /** Live chat (ctx().chat). */
    chat?: STChatMessage[];
    /** Extra context fields (name1, name2, extensionSettings, characters, …). */
    ctx?: Record<string, unknown>;
    journal?: JournalRecord[];
    inbox?: InboxCard[];
    healthChecks?: HealthCheck[];
    /** Neighbour adapters by id (present/version/capabilities and any extra method, e.g. bunnymo.activeBooks). */
    adapters?: Partial<Record<NeighbourAdapter['id'], FakeAdapter>>;
    /** i18n strings (en and ru); t() falls back to the key. */
    strings?: { en?: Record<string, string>; ru?: Record<string, string> };
    locale?: 'en' | 'ru';
    stVersion?: string;
    chatId?: string | null;
    groupChat?: boolean;
    chatCompletion?: boolean;
    /** ST modules loaded at runtime (app.host.modules.*). */
    hostModules?: Partial<Record<'worldInfo' | 'regexEngine' | 'script' | 'openai' | 'presetManager', unknown>>;
    costSummary?: CostSummary;
    costRecent?: CostEntry[];
    coreSettings?: Record<string, unknown>;
}

export interface FakeApp {
    app: App;
    log: QuietLogger;
    apis: Map<string, unknown>;
    modules: FakeModuleRow[];
    caps: Set<string>;
    chat: STChatMessage[];
    /** The host context object (app.host.ctx() returns it; named so a fake may add its own ctx()). */
    hostCtx: Record<string, unknown>;
    journal: JournalRecord[];
    /** Actions recorded through app.journal.record(). */
    recorded: JournalAction[];
    inbox: InboxCard[];
    healthChecks: HealthCheck[];
    strings: { en: Record<string, string>; ru: Record<string, string> };
    locale: { value: 'en' | 'ru' };
}

function fill(text: string, params?: Record<string, string | number>): string {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function adapter(id: NeighbourAdapter['id'], patch: FakeAdapter = {}): NeighbourAdapter & Record<string, unknown> {
    return {
        id,
        present: () => false,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...patch,
    } as NeighbourAdapter & Record<string, unknown>;
}

const ADAPTER_IDS: readonly NeighbourAdapter['id'][] = [
    'des',
    'desru',
    'ck',
    'bunnymo',
    'qvink',
    'nai',
    'localizer',
    'preset',
];

export function fakeApp(options: FakeAppOptions = {}): FakeApp {
    const log = quietLogger();
    const apis = new Map<string, unknown>(Object.entries(options.apis ?? {}));
    const modules = [...(options.modules ?? [])];
    const caps = new Set(options.caps ?? []);
    const chat = options.chat ?? [];
    const journal = options.journal ?? [];
    const recorded: JournalAction[] = [];
    const inbox = options.inbox ?? [];
    const healthChecks = options.healthChecks ?? [];
    const strings = { en: { ...(options.strings?.en ?? {}) }, ru: { ...(options.strings?.ru ?? {}) } };
    const locale = { value: options.locale ?? ('en' as 'en' | 'ru') };
    const ctx: Record<string, unknown> = {
        chat,
        characters: [],
        characterId: undefined,
        groupId: null,
        name1: 'User',
        name2: 'Char',
        extensionSettings: {},
        chatMetadata: {},
        powerUserSettings: {},
        groups: [],
        ...(options.ctx ?? {}),
    };
    // The chat array is shared: tests push into fake.chat and the tools see it.
    ctx.chat = chat;
    const hostModules = options.hostModules ?? {};
    const loadHost = async (name: keyof NonNullable<FakeAppOptions['hostModules']>) => {
        const value = hostModules[name];
        if (value === undefined) throw new Error(`module ${name} is not available`);
        return value as Record<string, unknown>;
    };
    const adapters = Object.fromEntries(
        ADAPTER_IDS.map((id) => [id, adapter(id, options.adapters?.[id])]),
    ) as unknown as App['adapters'];

    const app = {
        log,
        host: {
            ctx: () => ctx as unknown as STContext,
            version: () => options.stVersion ?? '1.19.0',
            chatId: () => (options.chatId === undefined ? 'chat-1' : options.chatId),
            isGroupChat: () => options.groupChat ?? false,
            isChatCompletion: () => options.chatCompletion ?? true,
            caps: {
                has: (id: string) => caps.has(id),
                report: () => options.capsReport ?? [...caps].map((id): CapabilityReport => ({ id, ok: true })),
                register: () => {},
                refresh: async () => {},
            },
            modules: {
                worldInfo: () => loadHost('worldInfo'),
                regexEngine: () => loadHost('regexEngine'),
                script: () => loadHost('script'),
                openai: () => loadHost('openai'),
                presetManager: () => loadHost('presetManager'),
                chats: async () => ({}),
                utils: async () => ({}),
                load: async () => ({}),
            },
            events: {
                on: () => () => {},
                reassertOrder: () => {},
                emit: async () => {},
                name: (key: string) => key,
            },
            fetchGate: { beforeRequest: () => () => {}, afterResponse: () => () => {} },
        },
        i18n: {
            t: (key: string, params?: Record<string, string | number>) =>
                fill(strings[locale.value][key] ?? strings.en[key] ?? key, params),
            register: (parts: { en: Record<string, string>; ru: Record<string, string> }) => {
                Object.assign(strings.en, parts.en);
                Object.assign(strings.ru, parts.ru);
            },
            locale: () => locale.value,
        },
        modules: {
            list: () =>
                modules.map((row) => ({
                    module: {
                        id: row.id,
                        key: row.key,
                        stage: row.stage,
                        titleKey: row.titleKey ?? `${row.id.toLowerCase()}.title`,
                        enabledByDefault: true,
                        defaults: () => ({}),
                        init: () => {},
                    } as MaestroModule,
                    enabled: row.enabled ?? true,
                    running: row.running ?? row.enabled ?? true,
                    missing: row.missing ?? [],
                })),
            enable: async (key: string) => {
                const row = modules.find((item) => item.key === key);
                if (row) row.enabled = row.running = true;
            },
            disable: async (key: string) => {
                const row = modules.find((item) => item.key === key);
                if (row) row.enabled = row.running = false;
            },
            api: <T>(key: string) => apis.get(key) as T | undefined,
            expose: (key: string, api: unknown) => {
                if (api === undefined) apis.delete(key);
                else apis.set(key, api);
            },
        },
        journal: {
            record: async (action: JournalAction) => {
                recorded.push(action);
                const record: JournalRecord = {
                    ...action,
                    id: `j${journal.length + 1}`,
                    at: Date.now(),
                    chatId: 'chat-1',
                };
                journal.push(record);
                return record.id;
            },
            undo: async () => true,
            undoForMessage: async () => 0,
            list: (filter?: { module?: string; limit?: number }) => {
                const rows = journal.filter((record) => !filter?.module || record.module === filter.module);
                return filter?.limit ? rows.slice(-filter.limit) : rows;
            },
            registerUndo: () => {},
        },
        inbox: {
            list: () => inbox,
            count: () => inbox.length,
            load: async () => {},
            registerApplier: () => () => {},
            add: async () => 'card',
            accept: async () => true,
            reject: async () => {},
            snooze: async () => {},
            invalidateMessage: async () => 0,
            onChange: () => () => {},
        },
        ui: {
            healthChecks: () => healthChecks,
            addTab: () => () => {},
            addHealthCheck: (check: HealthCheck) => {
                healthChecks.push(check);
                return () => {};
            },
            addWizardStep: () => () => {},
            addSlashCommand: () => () => {},
            openPult: () => {},
            refresh: () => {},
            notice: () => {},
            confirm: async () => true,
            messageBadge: () => () => {},
            style: () => () => {},
        },
        cost: {
            summary: () =>
                options.costSummary ?? { todayUsd: 0, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0 },
            recent: () => options.costRecent ?? [],
            record: () => {},
            recordAnlas: () => {},
            backgroundCapReached: () => false,
            onChange: () => () => {},
        },
        settings: {
            core: () => ({ mode: 'balanced', ...(options.coreSettings ?? {}) }),
            module: () => ({}),
            isModuleEnabled: (key: string) => modules.find((row) => row.key === key)?.enabled ?? false,
            setModuleEnabled: () => {},
            save: () => {},
            onChange: () => () => {},
            notify: () => {},
        },
        adapters,
        turn: { lastAssistantIndex: () => chat.length - 1, current: () => null, onIntercept: () => () => {} },
    } as unknown as App;

    return {
        app,
        log,
        apis,
        modules,
        caps,
        chat,
        hostCtx: ctx,
        journal,
        recorded,
        inbox,
        healthChecks,
        strings,
        locale,
    };
}

/* ------------------------------------------------------------------ settings access */

export interface FakeSettingsAccess extends SettingsAccess {
    /** The plain settings objects by module key (mutable). */
    data: Record<string, Record<string, unknown>>;
    /** Plans made (module, path, value). */
    planned: { moduleKey: string; path: string; value: unknown }[];
}

function getPath(object: Record<string, unknown>, path: string): unknown {
    let value: unknown = object;
    for (const part of path.split('.')) {
        if (typeof value !== 'object' || value === null) return undefined;
        value = (value as Record<string, unknown>)[part];
    }
    return value;
}

function setPath(object: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let node: Record<string, unknown> = object;
    for (const part of parts.slice(0, -1)) {
        const next = node[part];
        if (typeof next !== 'object' || next === null) node[part] = {};
        node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
}

/**
 * An allowlisted SettingsAccess over plain objects: `allowed` lists the writable dot paths per module ('*' = all);
 * `hidden` lists top-level keys read() removes (secrets).
 */
export function fakeSettings(
    data: Record<string, Record<string, unknown>>,
    options: { allowed?: Record<string, string[]>; hidden?: string[] } = {},
): FakeSettingsAccess {
    const hidden = new Set(options.hidden ?? ['profileId', 'apiKey', 'url']);
    const planned: FakeSettingsAccess['planned'] = [];
    const access: FakeSettingsAccess = {
        data,
        planned,
        modules: () => Object.keys(data),
        read: (moduleKey) => {
            const settings = data[moduleKey];
            if (!settings) return null;
            return Object.fromEntries(Object.entries(structuredClone(settings)).filter(([key]) => !hidden.has(key)));
        },
        allowed: (moduleKey, path) => {
            const list = options.allowed?.[moduleKey];
            if (!data[moduleKey] || !list) return false;
            return list.includes('*') || list.includes(path);
        },
        plan: (moduleKey, path, value): WritePlan => {
            if (!access.allowed(moduleKey, path)) throw new Error(`Not allowed: ${moduleKey}.${path}`);
            const settings = data[moduleKey]!;
            const before = getPath(settings, path);
            planned.push({ moduleKey, path, value });
            return {
                summary: `${moduleKey}.${path}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`,
                target: `Maestro · ${moduleKey}`,
                before,
                after: value,
                apply: async () => {
                    setPath(settings, path, value);
                    return {};
                },
            };
        },
    };
    return access;
}

/* ------------------------------------------------------------------ tool context */

export function toolContext(
    fake: FakeApp,
    options: { locale?: 'en' | 'ru'; settings?: SettingsAccess; signal?: AbortSignal } = {},
): ToolContext {
    const context: ToolContext = {
        app: fake.app,
        log: fake.log,
        locale: options.locale ?? fake.locale.value,
        settings: options.settings ?? fakeSettings({}),
    };
    if (options.signal) context.signal = options.signal;
    return context;
}

/** The tool by name (throws when missing, so a typo fails loudly). */
export function toolNamed(tools: readonly ToolSpec[], name: string): ToolSpec {
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error(`no tool ${name}; have ${tools.map((item) => item.name).join(', ')}`);
    return tool;
}

/** Runs a read tool (throws when it has no run()). */
export async function runTool(
    tools: readonly ToolSpec[],
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<{ data: unknown; untrusted?: boolean; summary?: string }> {
    const tool = toolNamed(tools, name);
    if (!tool.run) throw new Error(`${name} is not a read tool`);
    return tool.run(args, context);
}

/** A chat message (assistant by default). */
export function msg(text: string, patch: Partial<STChatMessage> = {}): STChatMessage {
    return { name: 'Char', is_user: false, is_system: false, send_date: '', mes: text, extra: {}, ...patch };
}

export function userMsg(text: string): STChatMessage {
    return msg(text, { name: 'User', is_user: true });
}

/** Size of the JSON a tool returns (compactness checks). */
export function jsonSize(value: unknown): number {
    return JSON.stringify(value).length;
}

/**
 * Checks a tool's JSON schema the way the core expects it: an object schema with typed, described properties, no
 * extra properties, and `required` naming existing properties. Returns the problems (empty = valid).
 */
export function schemaProblems(tool: ToolSpec): string[] {
    const problems: string[] = [];
    const schema = tool.parameters as {
        type?: unknown;
        properties?: Record<string, Record<string, unknown>>;
        required?: unknown;
        additionalProperties?: unknown;
    };
    if (schema.type !== 'object') problems.push('type is not object');
    if (typeof schema.properties !== 'object' || schema.properties === null) problems.push('no properties');
    if (schema.additionalProperties !== false) problems.push('additionalProperties is not false');
    const properties = schema.properties ?? {};
    const kinds = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
    for (const [name, property] of Object.entries(properties)) {
        const types = Array.isArray(property.type) ? property.type : [property.type];
        if (!types.every((type) => typeof type === 'string' && (kinds.has(type) || type === 'null')))
            problems.push(`${name}: bad type`);
        if (typeof property.description !== 'string' || !property.description) problems.push(`${name}: no description`);
        if (property.type === 'array' && typeof property.items !== 'object') problems.push(`${name}: no items`);
        if (property.enum !== undefined && !Array.isArray(property.enum)) problems.push(`${name}: bad enum`);
    }
    if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)) problems.push('required is not an array');
        else for (const name of schema.required) if (!(name in properties)) problems.push(`required ${String(name)}`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) problems.push('name is not snake_case');
    if (!tool.description || /[А-Яа-яЁё]/.test(tool.description)) problems.push('description must be English');
    return problems;
}
