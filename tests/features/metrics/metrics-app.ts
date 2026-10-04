// A test App for M21m: the lore test app plus a fetch gate, a turn pipeline registry, a cost meter with today's
// entries, a journal, autonomy statistics, a memory file store and fake APIs of other modules, all driven by hand.
import type { LogLine } from '../../../src/core/logger';
import { makeFileName } from '../../../src/core/files';
import { M21M_STRINGS, MetricsService, defaultMetricsSettings } from '../../../src/features/metrics';
import type { MetricsDeps, MetricsSettings } from '../../../src/features/metrics';
import type {
    App,
    AutonomyStats,
    CostEntry,
    FileStore,
    GenerationInfo,
    JournalRecord,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createLoreApp } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';

type Hook = { match: RegExp; fn: (...args: unknown[]) => unknown };
type InterceptHandler = (chat: STChatMessage[], info: GenerationInfo) => void | Promise<void>;

export const GENERATE_URL = '/api/backends/chat-completions/generate';
export const SETTINGS_SAVE_URL = '/api/settings/save';

export interface MetricsStand {
    stand: LoreTestApp;
    app: App;
    /** Monotonic clock (ms) and wall clock (ms) the service reads. */
    clock: { value: number };
    wall: { value: number };
    device: { value: 'desktop' | 'phone' };
    before: Hook[];
    after: Hook[];
    intercepts: Set<InterceptHandler>;
    deferred: (() => void)[];
    costRecent: (CostEntry & { anlas?: number })[];
    costListeners: Set<() => void>;
    bySource: Record<string, number>;
    logLines: LogLine[];
    files: Map<string, unknown>;
    journal: JournalRecord[];
    autonomy: AutonomyStats[];
    books: Map<string, string>;
    apis: Map<string, unknown>;
    settings: MetricsSettings;
    runDeferred(): void;
    /** Calls the before-request hooks matching the URL (the generate request leaving). */
    request(url?: string): Promise<void>;
    respond(url: string): void;
    costChanged(): void;
    expose(key: string, api: unknown): void;
    makeService(deps?: MetricsDeps): { service: MetricsService; stop(): void };
    /** One generation: GENERATION_STARTED, generation:before, the interceptor, the request. */
    generate(options?: GenerateOptions): Promise<void>;
}

export interface GenerateOptions {
    type?: string;
    quiet?: boolean;
    dryRun?: boolean;
    chat?: STChatMessage[];
    startToBefore?: number;
    beforeToIntercept?: number;
    interceptToRequest?: number;
    /** Runs while the generation is in flight, before the request leaves (module timings). */
    during?: () => void;
    skipRequest?: boolean;
}

export function createMetricsStand(): MetricsStand {
    const stand = createLoreApp();
    const app = stand.app;
    app.i18n.register(M21M_STRINGS);
    const files = new Map<string, unknown>();
    const env: MetricsStand = {
        stand,
        app,
        clock: { value: 1000 },
        wall: { value: 1_700_000_000_000 },
        device: { value: 'desktop' },
        before: [],
        after: [],
        intercepts: new Set(),
        deferred: [],
        costRecent: [],
        costListeners: new Set(),
        bySource: {},
        logLines: [],
        files,
        journal: [],
        autonomy: [],
        books: new Map(),
        apis: new Map(),
        settings: defaultMetricsSettings(),
        runDeferred() {
            for (const run of env.deferred.splice(0)) run();
        },
        async request(url = GENERATE_URL) {
            for (const hook of [...env.before]) if (hook.match.test(url)) await hook.fn(url, { body: '{}' });
        },
        respond(url) {
            for (const hook of [...env.after]) if (hook.match.test(url)) hook.fn(url, new Response('{}'), {});
        },
        costChanged() {
            for (const listener of [...env.costListeners]) listener();
        },
        expose(key, api) {
            app.modules.expose(key, api);
        },
        makeService(deps = {}) {
            const service = new MetricsService(app, env.settings, app.log, {
                clock: () => env.clock.value,
                now: () => env.wall.value,
                device: () => env.device.value,
                readBook: async (name) => env.books.get(name) ?? null,
                logLines: () => env.logLines,
                tabId: 'tab-A',
                saveDelayMs: 60_000,
                packDelayMs: -1,
                defer: (run) => env.deferred.push(run),
                ...deps,
            });
            const disposers: Unsubscribe[] = [];
            service.install((dispose) => disposers.push(dispose));
            return {
                service,
                stop() {
                    for (const dispose of disposers.splice(0).reverse()) dispose();
                },
            };
        },
        async generate(options = {}) {
            const type = options.type ?? 'normal';
            const info: GenerationInfo = { type, dryRun: options.dryRun === true, quiet: options.quiet === true };
            await stand.emit('GENERATION_STARTED', type, {}, options.dryRun === true);
            env.clock.value += options.startToBefore ?? 5;
            await app.bus.emit('generation:before', info);
            env.clock.value += options.beforeToIntercept ?? 2;
            for (const handler of [...env.intercepts]) await handler(options.chat ?? [], info);
            options.during?.();
            env.clock.value += options.interceptToRequest ?? 30;
            env.wall.value += 1000;
            if (!options.skipRequest) await env.request();
            env.runDeferred();
        },
    };

    app.host.fetchGate = {
        beforeRequest(match, fn) {
            const hook = { match, fn: fn as Hook['fn'] };
            env.before.push(hook);
            return () => void env.before.splice(env.before.indexOf(hook), 1);
        },
        afterResponse(match, fn) {
            const hook = { match, fn: fn as Hook['fn'] };
            env.after.push(hook);
            return () => void env.after.splice(env.after.indexOf(hook), 1);
        },
    };
    app.turn = {
        onIntercept(handler) {
            env.intercepts.add(handler);
            return () => env.intercepts.delete(handler);
        },
        lastAssistantIndex: () => -1,
        current: () => null,
    };
    app.cost = {
        record() {},
        recordAnlas() {},
        summary: () => ({
            todayUsd: Object.values(env.bySource).reduce((sum, usd) => sum + usd, 0),
            todayBySource: { ...env.bySource },
            backgroundTodayUsd: env.bySource.maestro ?? 0,
            anlasToday: 0,
        }),
        backgroundCapReached: () => false,
        onChange(listener) {
            env.costListeners.add(listener);
            return () => env.costListeners.delete(listener);
        },
        today: () => ({ recent: env.costRecent }),
    } as App['cost'];
    app.journal = { list: () => env.journal } as unknown as App['journal'];
    app.autonomy = { stats: () => env.autonomy } as unknown as App['autonomy'];
    const fileStore: FileStore = {
        read: async <T>(name: string) => (files.has(name) ? (structuredClone(files.get(name)) as T) : null),
        write: async (name, data) => {
            files.set(name, structuredClone(data));
        },
        remove: async (name) => {
            files.delete(name);
        },
        fileName: (kind, key) => makeFileName(kind, key),
    };
    app.files = fileStore;
    (app.adapters as unknown as Record<string, unknown>).qvink = {
        present: () => false,
        chatEnabled: () => false,
        removesMessages: () => false,
        settings: () => ({}),
    };
    return env;
}

/** A prompt entry Qvink dropped (`IGNORE_SYMBOL`), with or without its memory. */
export function droppedEntry(text: string, memory?: string): STChatMessage {
    const extra: Record<string | symbol, unknown> = { [Symbol.for('ignore')]: true };
    if (memory !== undefined) extra.qvink_memory = { memory };
    return { name: 'Char', is_user: false, is_system: false, send_date: '', mes: text, extra } as STChatMessage;
}

export function qvinkOn(env: MetricsStand, settings: Record<string, unknown> = {}): void {
    (env.app.adapters as unknown as Record<string, unknown>).qvink = {
        present: () => true,
        chatEnabled: () => true,
        removesMessages: () => true,
        settings: () => settings,
    };
}
