// A test App for M12: the lore test app plus fakes of the LLM client, autonomy, journal, ephemeral injections, a
// memory file store, the fetch gate, ST's swipe/stop/continue, NAI Studio's gate API, DES / DES-RU, metrics, medic.
import { makeFileName } from '../../../src/core/files';
import { QualityService, QUALITY_STRINGS, readQualitySettings } from '../../../src/features/quality';
import type { QualitySettings, QualityTimings } from '../../../src/features/quality';
import type { Defect } from '../../../src/features/quality/api';
import type {
    App,
    AutonomyLevel,
    Decision,
    FileStore,
    GenerationInfo,
    InjectionSpec,
    JournalAction,
    JournalChange,
    LlmRequest,
    LlmResult,
    MaestroEvents,
    Proposal,
    SettingsService,
    Ui,
    Unsubscribe,
    UndoHandler,
} from '../../../src/shared/contracts';
import { createLoreApp, settle } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { EVENT_TYPES, message } from '../../helpers/st-mock';
import { fakeChecks } from './fake-checks';

export { settle } from '../../helpers/lore-app';
export { message } from '../../helpers/st-mock';

EVENT_TYPES.STREAM_TOKEN_RECEIVED = 'stream_token_received';

export const FAST: QualityTimings = {
    judgeMs: 200,
    gateMs: 400,
    gateKickMs: 60,
    expectGraceMs: 150,
    finishWaitMs: 30,
    pollMs: 5,
    idleMs: 300,
    fixTtlMs: 2000,
    naiSyncMs: 40,
};

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type Hook = { match: RegExp; fn: (...args: unknown[]) => unknown };

export interface QualityStand {
    stand: LoreTestApp;
    app: App;
    chat: STChatMessage[];
    settings: QualitySettings;
    core: { mode: 'economy' | 'balanced' | 'cinema'; autonomy: Record<string, AutonomyLevel> };
    disabledModules: Set<string>;
    badges: { messageIndex: number; badge: Parameters<Ui['messageBadge']>[1]; removed: boolean }[];
    notices: { text: string; options?: Parameters<Ui['notice']>[1] }[];
    tabs: { id: string; render(container: HTMLElement): void | Unsubscribe }[];
    llm: {
        available: boolean;
        respond: (request: LlmRequest) => Promise<LlmResult> | LlmResult;
        requests: LlmRequest[];
    };
    leader: { value: boolean };
    autonomy: {
        never: Set<string>;
        records: [string, string][];
        decisions: Proposal<unknown>[];
    };
    journal: {
        records: (JournalAction & { id: string })[];
        handlers: Map<string, UndoHandler>;
        undo(id: string): Promise<boolean>;
    };
    injections: Map<string, InjectionSpec>;
    producers: Map<string, (gen: GenerationInfo) => void | Promise<void>>;
    files: Map<string, unknown>;
    st: {
        allowed: boolean;
        swipes: { message: unknown }[];
        swipeTo: unknown[][];
        stops: number;
        commands: string[];
        saves: number;
        updates: number[];
    };
    nai: { gate: ((index: number) => Promise<boolean>) | null; available: boolean; sets: number; offs: number };
    des: { present: boolean; together: boolean; settings: Record<string, unknown> | null };
    desru: { present: boolean; settings: Record<string, unknown> | null };
    metrics: { autoSwipes: number };
    medic: { api: boolean; result: boolean; calls: number[] };
    fetchHooks: { before: Hook[]; after: Hook[] };
    bus: { [K in keyof MaestroEvents]?: MaestroEvents[K][] };
    /** Starts a service with fast timings. */
    start(timings?: Partial<QualityTimings>): QualityService;
    stop(): Promise<void>;
    service(): QualityService;
    /** A main generation: generation:before + ephemeral producers. */
    generate(type?: string, extra?: Partial<GenerationInfo>): Promise<void>;
    end(stopped?: boolean): Promise<void>;
    /** Maestro's reply:ready for the message, then a few ticks. */
    reply(index: number, type?: string): Promise<void>;
    /** Waits until no check of the service is running. */
    idle(ms?: number): Promise<void>;
    defects(...defects: Defect[]): void;
}

export function createQualityStand(): QualityStand {
    fakeChecks.reset();
    const stand = createLoreApp({ locale: 'en' });
    const app = stand.app;
    app.i18n.register(QUALITY_STRINGS);
    const ctx = stand.ctx;
    const settings = readQualitySettings({});
    const slices: Record<string, Record<string, unknown>> = { quality: settings as unknown as Record<string, unknown> };
    const core = {
        mode: 'balanced' as 'economy' | 'balanced' | 'cinema',
        autonomy: {} as Record<string, AutonomyLevel>,
    };
    const disabledModules = new Set<string>();
    let running: QualityService | null = null;
    let disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];

    const env: QualityStand = {
        stand,
        app,
        chat: stand.mock.chat,
        settings,
        core,
        disabledModules,
        badges: [],
        notices: [],
        tabs: [],
        llm: { available: true, respond: () => ({ ok: false, error: 'no answer' }), requests: [] },
        leader: { value: true },
        autonomy: { never: new Set(), records: [], decisions: [] },
        journal: {
            records: [],
            handlers: new Map(),
            async undo(id) {
                const record = env.journal.records.find((item) => item.id === id);
                if (!record) return false;
                for (const change of record.changes) {
                    const handler = env.journal.handlers.get(change.target);
                    if (!handler || !(await handler(change))) return false;
                }
                env.autonomy.records.push([record.kind, 'undone']);
                return true;
            },
        },
        injections: new Map(),
        producers: new Map(),
        files: new Map(),
        st: { allowed: true, swipes: [], swipeTo: [], stops: 0, commands: [], saves: 0, updates: [] },
        nai: { gate: null, available: true, sets: 0, offs: 0 },
        des: { present: false, together: true, settings: {} },
        desru: { present: false, settings: null },
        metrics: { autoSwipes: 0 },
        medic: { api: false, result: true, calls: [] },
        fetchHooks: { before: [], after: [] },
        bus: {},
        start(timings = {}) {
            const service = new QualityService(
                app,
                app.log,
                () => readQualitySettings(slices.quality as Partial<QualitySettings>),
                { ...FAST, ...timings },
            );
            disposers = [];
            service.install((dispose) => disposers.push(dispose));
            running = service;
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
        async generate(type = 'normal', extra = {}) {
            const info: GenerationInfo = { type, dryRun: false, quiet: type === 'quiet', ...extra };
            stand.generation = info.quiet ? stand.generation : info;
            env.injections.clear();
            for (const producer of env.producers.values()) await producer(info);
            await app.bus.emit('generation:before', info);
        },
        async end(stopped = false) {
            stand.generation = null;
            await app.bus.emit('generation:ended', { type: 'normal', stopped });
        },
        async reply(index, type = 'normal') {
            await app.bus.emit('reply:ready', { messageIndex: index, type });
            await env.idle();
        },
        async idle(ms = 2000) {
            const until = Date.now() + ms;
            await settle(5);
            const service = running as unknown as { inflight: Map<string, Promise<unknown>> } | null;
            while (service && service.inflight.size > 0 && Date.now() < until) {
                await Promise.allSettled([...service.inflight.values()]);
                await settle(5);
            }
            await settle(20);
        },
        defects(...defects) {
            fakeChecks.impl = () => defects.map((defect) => ({ ...defect }));
        },
    };

    // ---- bus recording
    for (const event of ['reply:ok'] as const) {
        app.bus.on(event, (payload) => {
            (env.bus[event] ??= []).push(payload);
        });
    }

    // ---- settings
    app.settings = {
        core: () => core,
        module: <T extends object>(key: string) => (slices[key] ??= {}) as T,
        isModuleEnabled: (key: string) => !disabledModules.has(key),
        setModuleEnabled() {},
        save() {},
        onChange: () => () => {},
        notify() {},
    } as unknown as SettingsService;

    // ---- ui
    app.ui = {
        ...app.ui,
        addTab(tab) {
            env.tabs.push(tab);
            return () => {
                const index = env.tabs.indexOf(tab);
                if (index >= 0) env.tabs.splice(index, 1);
            };
        },
        notice(text, options) {
            env.notices.push({ text, options });
        },
        messageBadge(messageIndex, badge) {
            const entry = { messageIndex, badge, removed: false };
            env.badges.push(entry);
            return () => {
                entry.removed = true;
            };
        },
        closePult() {},
    };

    // ---- llm, cost, leader
    app.llm = {
        available: () => env.llm.available,
        async request<T>(request: LlmRequest): Promise<LlmResult<T>> {
            env.llm.requests.push(request);
            return (await env.llm.respond(request)) as LlmResult<T>;
        },
    };
    app.cost = { backgroundCapReached: () => false } as unknown as App['cost'];
    app.leader = { isLeader: () => env.leader.value, onChange: () => () => {} };

    // ---- journal and autonomy
    let nextId = 1;
    app.journal = {
        async record(action) {
            const id = `j${nextId++}`;
            env.journal.records.push({ ...structuredClone(action), id });
            return id;
        },
        undo: (id) => env.journal.undo(id),
        undoForMessage: async () => 0,
        list: () => [],
        registerUndo(target, handler) {
            env.journal.handlers.set(target, handler);
        },
    };
    const level = (kind: string, fallback: AutonomyLevel): AutonomyLevel => {
        const value = core.autonomy[kind] ?? fallback;
        if (value === 'auto' && env.autonomy.never.has(kind)) return fallback === 'auto' ? 'ask' : fallback;
        return value;
    };
    app.autonomy = {
        level,
        async decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision> {
            env.autonomy.decisions.push(proposal as Proposal<unknown>);
            if (level(proposal.kind, fallback) !== 'auto') return 'notified';
            try {
                if (proposal.stillValid && !(await proposal.stillValid())) return 'skipped';
                await proposal.apply(proposal.payload);
            } catch {
                return 'skipped';
            }
            await app.journal.record({
                module: proposal.module,
                kind: proposal.kind,
                summary: proposal.title,
                changes: proposal.changes as JournalChange[],
                sourceMessage: proposal.sourceMessage,
            });
            return 'applied';
        },
        record(kind, outcome) {
            env.autonomy.records.push([kind, outcome]);
        },
        stats: () => [],
        neverAuto(kind) {
            env.autonomy.never.add(kind);
        },
        isNeverAuto: (kind) => env.autonomy.never.has(kind),
        setLevel(kind, value) {
            if (value === 'auto' && env.autonomy.never.has(kind)) return false;
            core.autonomy[kind] = value;
            return true;
        },
    };

    // ---- ephemeral
    app.ephemeral = {
        setFlag() {},
        setInjection(key, spec) {
            env.injections.set(key, { ...spec });
        },
        addProducer(name, producer) {
            env.producers.set(name, producer);
            return () => {
                if (env.producers.get(name) === producer) env.producers.delete(name);
            };
        },
        clearAll() {
            env.injections.clear();
        },
    };

    // ---- files
    const files: FileStore = {
        async read<T>(name: string) {
            return (env.files.has(name) ? structuredClone(env.files.get(name)) : null) as T | null;
        },
        async write(name, data) {
            env.files.set(name, structuredClone(data));
        },
        async remove(name) {
            env.files.delete(name);
        },
        fileName: (kind, key) => makeFileName(kind, key),
    };
    app.files = files;

    // ---- fetch gate
    app.host.fetchGate = {
        beforeRequest(match, fn) {
            const hook = { match, fn: fn as Hook['fn'] };
            env.fetchHooks.before.push(hook);
            return () => {
                env.fetchHooks.before.splice(env.fetchHooks.before.indexOf(hook), 1);
            };
        },
        afterResponse(match, fn) {
            const hook = { match, fn: fn as Hook['fn'] };
            env.fetchHooks.after.push(hook);
            return () => {
                env.fetchHooks.after.splice(env.fetchHooks.after.indexOf(hook), 1);
            };
        },
    };

    // ---- SillyTavern context extras
    ctx.swipe = {
        right(_event: unknown, options: { message?: unknown } = {}) {
            env.st.swipes.push({ message: options.message });
            return Promise.resolve();
        },
        to(...args: unknown[]) {
            env.st.swipeTo.push(args);
            const options = args[2] as { message?: STChatMessage; forceSwipeId?: number };
            if (options.message && typeof options.forceSwipeId === 'number') {
                options.message.swipe_id = options.forceSwipeId;
                const swipes = options.message.swipes as string[] | undefined;
                if (swipes) options.message.mes = swipes[options.forceSwipeId] ?? options.message.mes;
            }
            return Promise.resolve();
        },
        isAllowed: () => env.st.allowed,
    };
    ctx.stopGeneration = () => {
        env.st.stops++;
        return true;
    };
    ctx.updateMessageBlock = (index: number) => {
        env.st.updates.push(index);
    };
    ctx.saveChat = async () => {
        env.st.saves++;
    };
    ctx.executeSlashCommandsWithOptions = async (text: string) => {
        env.st.commands.push(text);
        return '';
    };

    // ---- adapters and other modules
    app.adapters = {
        ...app.adapters,
        des: {
            present: () => env.des.present,
            enabled: () => true,
            generationMode: () => (env.des.together ? 'together' : 'separate'),
            settings: () => env.des.settings,
        },
        desru: {
            present: () => env.desru.present,
            moduleEnabled: () => true,
            settings: () => env.desru.settings,
        },
        nai: {
            present: () => true,
            api: () => (env.nai.available ? { registerQualityGate: () => () => {} } : undefined),
            setQualityGate(gate: (index: number) => Promise<boolean>) {
                env.nai.sets++;
                env.nai.gate = gate;
                return () => {
                    env.nai.offs++;
                    if (env.nai.gate === gate) env.nai.gate = null;
                };
            },
        },
    } as unknown as App['adapters'];
    app.modules.expose('metrics', {
        noteAutoSwipe() {
            env.metrics.autoSwipes++;
        },
    });
    const medicApi = {
        async repairTracker(index: number) {
            env.medic.calls.push(index);
            return env.medic.result;
        },
    };
    const realApi = app.modules.api.bind(app.modules);
    app.modules.api = <T>(key: string): T | undefined => {
        if (key === 'medic') return (env.medic.api ? medicApi : undefined) as T | undefined;
        return realApi<T>(key);
    };

    return env;
}

/** A user message and a reply: [greeting, user, reply]. */
export function basicChat(env: QualityStand, reply = 'Anna smiled and opened the door.'): void {
    env.chat.splice(
        0,
        env.chat.length,
        message('Hello, traveller. The road is long and the night is cold.', { name: 'Anna' }),
        message('I step inside and look around the room.', { is_user: true, name: 'User' }),
        message(reply, { name: 'Anna', swipe_id: 0, swipes: [reply] }),
    );
}

export const defect = (kind: Defect['kind'], extra: Partial<Defect> = {}): Defect => ({
    kind,
    confidence: 0.9,
    quote: `${kind} quote`,
    by: `rule.${kind}`,
    ...extra,
});
