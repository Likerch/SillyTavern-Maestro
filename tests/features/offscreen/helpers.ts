// A test App for M16 «Закулисье»: the ST mock with the real turn pipeline, ephemeral injections, bus, files and chat
// store; fakes of settings, the task queue, the LLM client, leader, cost, journal, autonomy, a recording Inbox, the UI
// and the neighbour adapters (DES tracker from chat messages, DES roster, Qvink memories), plus in-memory fakes of the
// modules the offscreen world reads: the chat canon, the world model, places, relations, contradictions, the chronicle,
// the calendar and the dossier.
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
import type { CalendarApi, StoryPromise } from '../../../src/features/calendar/api';
import type { CanonApi, CanonDraft, CanonItem, CanonOrigin, CanonStatus } from '../../../src/features/canon/api';
import type { Chapter, ChronicleApi } from '../../../src/features/chronicle/api';
import type { Contradiction, ContradictionResult, ContradictionsApi } from '../../../src/features/contradictions/api';
import type { Dossier, DossierApi, DossierSection } from '../../../src/features/dossier/api';
import { OffscreenService, OFFSCREEN_STRINGS, readOffscreenSettings } from '../../../src/features/offscreen';
import type { OffscreenSettings, OffscreenTimings } from '../../../src/features/offscreen';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import type { Relation, RelationsApi } from '../../../src/features/relations/api';
import type { Entity, EntityKind, WorldModelApi } from '../../../src/features/world/api';
import type {
    App,
    Inbox,
    InboxCard,
    LlmRequest,
    LlmResult,
    Proposal,
    PultTab,
    SettingsService,
    TaskInfo,
    TaskRunner,
    TaskSpec,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, TestHost } from '../../helpers/core-host';
import { FakeAutonomy, FakeJournal, FakeModules } from '../../helpers/rules-app';
import { EVENT_TYPES, installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export type Dict = Record<string, unknown>;

export const FAST: OffscreenTimings = { settleMs: 50, sceneMs: 20, saveMs: 10 };
export const CHAT_ID = 'Лиза - 2026-10-05@12h00m00s';

export interface Prompt {
    value: string;
    position: number;
    depth: number;
    role: number;
}

/* ------------------------------------------------------------------ module fakes */

export class FakeCanon implements CanonApi {
    items: CanonItem[] = [];
    readonly puts: CanonDraft[] = [];
    readonly removed: number[] = [];
    readonly statuses: [number, CanonStatus][] = [];
    private next = 100;
    bookName(): string {
        return 'Maestro · канон · test';
    }
    async ensureBook(): Promise<string> {
        return this.bookName();
    }
    async list(filter: { status?: CanonStatus; origin?: CanonOrigin } = {}): Promise<CanonItem[]> {
        return structuredClone(
            this.items.filter(
                (item) =>
                    (!filter.status || item.meta.status === filter.status) &&
                    (!filter.origin || item.meta.origin === filter.origin),
            ),
        );
    }
    async put(draft: CanonDraft): Promise<number> {
        this.puts.push(structuredClone(draft));
        const uid = this.next++;
        const at = Date.now() + uid;
        this.items.push({
            uid,
            entry: structuredClone(draft.entry),
            meta: { ...structuredClone(draft.meta), createdAt: at, updatedAt: at },
        });
        return uid;
    }
    async remove(uid: number): Promise<void> {
        this.removed.push(uid);
        this.items = this.items.filter((item) => item.uid !== uid);
    }
    async setStatus(uid: number, status: CanonStatus): Promise<void> {
        this.statuses.push([uid, status]);
        const item = this.items.find((candidate) => candidate.uid === uid);
        if (item) item.meta.status = status;
    }
    async promote(): Promise<boolean> {
        return false;
    }
    async baseDrift() {
        return [];
    }
    async exportPlain(): Promise<string> {
        return '';
    }
    budget() {
        return { limitChars: 0, usedChars: 0 };
    }
    async russianKeys(term: string): Promise<string[]> {
        return term === 'Mira' ? ['Мира', 'Миру', 'Миры'] : [term];
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export function entity(fields: Partial<Entity> & { name: string }): Entity {
    const kind: EntityKind = fields.kind ?? 'character';
    return {
        id: `${kind}:${fields.name.toLowerCase()}`,
        kind,
        aliases: [],
        forms: [],
        sources: [],
        ...fields,
    };
}

export class FakeWorld implements WorldModelApi {
    list: Entity[] = [];
    entities(kind?: EntityKind): Entity[] {
        return kind ? this.list.filter((item) => item.kind === kind) : this.list;
    }
    get(id: string): Entity | undefined {
        return this.list.find((item) => item.id === id);
    }
    resolve(name: string, kind?: EntityKind): Entity | undefined {
        const wanted = name.toLowerCase().trim();
        return this.list.find(
            (item) =>
                (!kind || item.kind === kind) &&
                [item.name, ...item.aliases, ...item.forms].some((n) => n.toLowerCase() === wanted),
        );
    }
    mentions(): Entity[] {
        return [];
    }
    facts() {
        return [];
    }
    async rebuild(): Promise<void> {}
    chatAliases(): Record<string, string> {
        return {};
    }
    async setChatAlias(): Promise<void> {}
    async merge(): Promise<void> {}
    async separate(): Promise<void> {}
    mergeCandidates() {
        return [];
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export function place(fields: Partial<Place> & { id: string; name: string }): Place {
    return { aliases: [], forms: [], parent: null, createdAt: 0, firstSeen: 0, lastSeen: 0, visits: [], ...fields };
}

export class FakePlaces implements Partial<PlacesApi> {
    places: Place[] = [];
    list(): Place[] {
        return this.places;
    }
    get(id: string): Place | undefined {
        return this.places.find((item) => item.id === id);
    }
    resolve(label: string): Place | undefined {
        const wanted = label.toLowerCase();
        return this.places.find(
            (item) =>
                item.name.toLowerCase() === wanted || item.aliases.some((alias) => alias.toLowerCase() === wanted),
        );
    }
    path(id: string): string[] {
        const out: string[] = [];
        for (let current = this.get(id); current; current = current.parent ? this.get(current.parent) : undefined) {
            out.unshift(current.name);
        }
        return out;
    }
}

export class FakeRelations implements RelationsApi {
    list: Relation[] = [];
    all(): Relation[] {
        return this.list;
    }
    of(name: string): Relation[] {
        const key = name.toLowerCase();
        return this.list.filter((item) => item.from.toLowerCase() === key || item.to.toLowerCase() === key);
    }
    between(from: string, to: string): Relation | undefined {
        return this.list.find(
            (item) => item.from.toLowerCase() === from.toLowerCase() && item.to.toLowerCase() === to.toLowerCase(),
        );
    }
    async rebuild(): Promise<void> {}
    onChange(): Unsubscribe {
        return () => {};
    }
}

export function relation(from: string, to: string, current: string): Relation {
    return { from, to, current, history: [] };
}

export class FakeContradictions implements ContradictionsApi {
    result: ContradictionResult = { clean: true, askedAi: false, contradictions: [], costUsd: 0 };
    fail = false;
    readonly checks: {
        input: Parameters<ContradictionsApi['check']>[0];
        options?: Parameters<ContradictionsApi['check']>[1];
    }[] = [];
    quick(): Contradiction[] {
        return [];
    }
    async check(
        input: Parameters<ContradictionsApi['check']>[0],
        options?: Parameters<ContradictionsApi['check']>[1],
    ): Promise<ContradictionResult> {
        this.checks.push(
            options ? { input: structuredClone(input), options: { ...options } } : { input: structuredClone(input) },
        );
        if (this.fail) throw new Error('check failed');
        return structuredClone(this.result);
    }
}

export class FakeChronicle implements ChronicleApi {
    list: Chapter[] = [];
    async chapters(): Promise<Chapter[]> {
        return this.list;
    }
    remembered() {
        return [];
    }
    async recapNow(): Promise<string> {
        return '';
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export class FakeCalendar implements Partial<CalendarApi> {
    list: StoryPromise[] = [];
    promises(): StoryPromise[] {
        return this.list;
    }
}

export class FakeDossier implements Partial<DossierApi> {
    pages = new Map<string, DossierSection[]>();
    async build(entityId: string): Promise<Dossier> {
        const sections = this.pages.get(entityId);
        if (!sections) throw new Error('no dossier');
        return { entityId, name: entityId, kind: 'character', builtAt: 0, sections, findings: [] };
    }
}

/* ------------------------------------------------------------------ inbox */

export class RecordingInbox implements Inbox {
    readonly added: Proposal[] = [];
    readonly appliers = new Map<
        string,
        {
            apply: (payload: unknown) => Promise<void>;
            valid?: (payload: unknown) => Promise<boolean>;
            reject?: (payload: unknown) => Promise<void>;
        }
    >();
    registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        valid?: (payload: unknown) => Promise<boolean>,
        reject?: (payload: unknown) => Promise<void>,
    ): Unsubscribe {
        const entry = { apply, valid, reject };
        this.appliers.set(kind, entry);
        return () => {
            if (this.appliers.get(kind) === entry) this.appliers.delete(kind);
        };
    }
    async add(proposal: Proposal): Promise<string> {
        this.added.push(proposal);
        return `card-${this.added.length}`;
    }
    list(): InboxCard[] {
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

/* ------------------------------------------------------------------ chat messages */

export interface TrackerParts {
    location?: string;
    /** Names present (DES characters). */
    present?: string[];
    quests?: { main: string | null; optional: string[] } | null;
    date?: string;
    time?: string;
}

let sent = 0;

export function trackerMessage(text: string, parts: TrackerParts = {}): STChatMessage {
    const info: Dict = { date: parts.date ?? '3 марта', time: { start: parts.time ?? '14:00' } };
    if (parts.location) info.location = parts.location;
    return message(text, {
        name: 'Лиза',
        swipe_id: 0,
        send_date: `date-${++sent}`,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: parts.quests ? JSON.stringify(parts.quests) : null,
                    infoBox: JSON.stringify(info),
                    characterThoughts: JSON.stringify((parts.present ?? ['Лиза']).map((name) => ({ name }))),
                },
            ],
        },
    });
}

export function userMessage(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'Алекс', send_date: `date-${++sent}` });
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

/* ------------------------------------------------------------------ the env */

export interface FakeTaskQueue {
    runners: Map<string, TaskRunner>;
    queued: TaskSpec[];
}

export interface OffscreenEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    modules: FakeModules;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string>; opened: string[] };
    pipeline: TurnPipeline;
    ephemeral: EphemeralRunner;
    core: { mode: 'economy' | 'balanced' | 'cinema' };
    slices: Record<string, Dict>;
    leader: { value: boolean };
    capped: { value: boolean };
    llm: { available: boolean; script: LlmResult[]; requests: LlmRequest[] };
    tasks: FakeTaskQueue;
    prompts: Map<string, Prompt>;
    des: { known: string[]; removed: string[] };
    qvink: { present: boolean; memories: Map<number, Dict> };
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: RecordingInbox;
    canon: FakeCanon;
    world: FakeWorld;
    places: FakePlaces;
    relations: FakeRelations;
    contradictions: FakeContradictions;
    chronicle: FakeChronicle;
    calendar: FakeCalendar;
    dossier: FakeDossier;
    settings(): OffscreenSettings;
    start(timings?: Partial<OffscreenTimings>): Promise<OffscreenService>;
    stop(): Promise<void>;
    service(): OffscreenService;
    tick(ms?: number): Promise<void>;
    /** An assistant reply with a DES tracker arrives (reply:ready). */
    reply(text: string, tracker?: TrackerParts): Promise<number>;
    /** The user answers: the reply before is committed; a normal generation runs (and ends unless told not to). */
    send(text: string, options?: { end?: boolean }): Promise<void>;
    /** Runs a generation of a type through the real interceptor; returns the injections it set (before the end). */
    generate(type: string, options?: { end?: boolean }): Promise<Map<string, Prompt>>;
    end(): Promise<void>;
    /** Reply + send `count` times, then lets the turn checks settle. */
    turns(count: number, tracker?: TrackerParts): Promise<void>;
    runTasks(): Promise<void>;
    /** The injection prompts set during the last generation (before they were cleared). */
    injected: Map<string, Prompt>[];
}

export function answer(...events: Dict[]): LlmResult {
    return { ok: true, data: { events }, costUsd: 0.001 };
}

export function event(fields: Dict = {}): Dict {
    return {
        character: 'Mira',
        text: 'Mira sold rare herbs to a ship captain and earned a small fortune.',
        location: '',
        rumour: 'They say the herbalist got rich overnight.',
        drastic: false,
        ...fields,
    };
}

export function createOffscreenEnv(): OffscreenEnv {
    const mock = installStMock();
    mock.chatId = CHAT_ID;
    const context = mock.context as unknown as Dict;
    context.name1 = 'Алекс';
    context.name2 = 'Лиза';
    const host = createTestHost(mock);
    const log = createTestLogger();
    const bus = createBus(log);
    const ephemeral = createEphemeral({ host, log });
    const pipeline = new TurnPipeline(host, bus, ephemeral, log);
    pipeline.install();
    const prompts = new Map<string, Prompt>();
    const injected: Map<string, Prompt>[] = [];
    context.setExtensionPrompt = (
        key: string,
        value: string,
        position: number,
        depth: number,
        _scan: boolean,
        role: number,
    ) => {
        if (value) prompts.set(key, { value, position, depth, role });
        else prompts.delete(key);
    };
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(OFFSCREEN_STRINGS);
    const files = createFileStore(host, log);
    const chatStore = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
    const base = createFakeUi();
    const ui = Object.assign(base, {
        tabs: [] as PultTab[],
        styles: new Map<string, string>(),
        opened: [] as string[],
    });
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
    ui.openPult = (id?: string) => void ui.opened.push(id ?? '');
    const core = { mode: 'balanced' as 'economy' | 'balanced' | 'cinema' };
    const slices: Record<string, Dict> = {};
    const leader = { value: true };
    const capped = { value: false };
    const tasks: FakeTaskQueue = { runners: new Map(), queued: [] };
    const des = { known: [] as string[], removed: [] as string[] };
    const qvink = { present: false, memories: new Map<number, Dict>() };
    const llm = { available: true, script: [] as LlmResult[], requests: [] as LlmRequest[] };
    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new RecordingInbox();
    const canon = new FakeCanon();
    const world = new FakeWorld();
    const places = new FakePlaces();
    const relations = new FakeRelations();
    const contradictions = new FakeContradictions();
    const chronicle = new FakeChronicle();
    const calendar = new FakeCalendar();
    const dossier = new FakeDossier();
    modules.expose('canon', canon);
    modules.expose('world', world);
    modules.expose('places', places);
    modules.expose('relations', relations);
    modules.expose('contradictions', contradictions);
    modules.expose('chronicle', chronicle);

    const adapters = {
        des: adapter('des', {
            trackerFor: (index: number) => {
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
            knownCharacters: () => [...des.known],
            removedCharacters: () => [...des.removed],
        }),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink', {
            present: () => qvink.present,
            memoryOf: (index: number) => qvink.memories.get(index) ?? null,
        }),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];

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
                const index = tasks.queued.findIndex(
                    (item) => item.kind === task.kind && item.dedupeKey && item.dedupeKey === task.dedupeKey,
                );
                if (index >= 0) tasks.queued.splice(index, 1);
                tasks.queued.push(structuredClone(task));
                return `task${tasks.queued.length}`;
            },
            list: (): TaskInfo[] =>
                tasks.queued.map((task, index) => ({
                    ...task,
                    chatId: task.chatId ?? mock.chatId,
                    id: `task${index}`,
                    state: 'pending' as const,
                    attempts: 0,
                    createdAt: 0,
                })),
            kick() {},
        },
        llm: {
            available: () => llm.available,
            async request<T>(request: LlmRequest): Promise<LlmResult<T>> {
                llm.requests.push(structuredClone(request));
                const next = llm.script.length > 1 ? llm.script.shift()! : llm.script[0];
                return structuredClone(next ?? { ok: false, error: 'no answer' }) as LlmResult<T>;
            },
        },
        cost: { backgroundCapReached: () => capped.value } as unknown as App['cost'],
        journal,
        autonomy,
        inbox,
        ephemeral,
        bus,
        ui,
        adapters,
        modules,
    } as unknown as App;

    let running: OffscreenService | null = null;
    let disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];

    const tick = async (ms = 10) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    const runGeneration = async (type: string, end: boolean): Promise<Map<string, Prompt>> => {
        await pipeline.intercept([...mock.chat], type);
        const snapshot = new Map(prompts);
        injected.push(snapshot);
        if (end) await env.end();
        return snapshot;
    };

    const env: OffscreenEnv = {
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
        capped,
        llm,
        tasks,
        prompts,
        des,
        qvink,
        journal,
        autonomy,
        inbox,
        canon,
        world,
        places,
        relations,
        contradictions,
        chronicle,
        calendar,
        dossier,
        injected,
        settings: () => readOffscreenSettings((slices.offscreen ??= {}) as Partial<OffscreenSettings>),
        async start(timings = {}) {
            const service = new OffscreenService(app, log, env.settings, { ...FAST, ...timings });
            disposers = [];
            service.install((dispose) => disposers.push(dispose));
            running = service;
            modules.expose('offscreen', service);
            await tick(20);
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
            await tick(FAST.sceneMs + 10);
            return index;
        },
        async send(text, options = {}) {
            mock.chat.push(userMessage(text));
            await mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, mock.chat.length - 1);
            await runGeneration('normal', options.end !== false);
        },
        generate(type, options = {}) {
            return runGeneration(type, options.end !== false);
        },
        async end() {
            await mock.eventSource.emit(EVENT_TYPES.GENERATION_ENDED!, mock.chat.length - 1);
            await tick(5);
        },
        async turns(count, tracker) {
            for (let i = 0; i < count; i++) {
                await env.reply(`Ответ ${i}`, tracker);
                await env.send(`Ход ${i}`);
            }
            await tick(FAST.settleMs + FAST.saveMs + 20);
        },
        async runTasks() {
            for (const task of tasks.queued.splice(0)) {
                const runner = tasks.runners.get(task.kind);
                if (runner) {
                    await runner(structuredClone(task.payload), {
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
    };
    return env;
}

/** Mira: an important character (lore entry, DES roster) who is not in the scene. */
export function seedMira(env: OffscreenEnv): Entity {
    const mira = entity({
        name: 'Mira',
        aliases: ['Мира'],
        forms: ['Миру', 'Миры'],
        sources: [{ kind: 'lore.entry', ref: 'World#1', label: 'Mira', world: 'World', uid: 1 }],
    });
    env.world.list.push(mira);
    env.des.known.push('Mira');
    return mira;
}

/** The scene's regulars: Liza (the card, present) and the persona. */
export function seedScene(env: OffscreenEnv): void {
    env.world.list.push(
        entity({
            name: 'Лиза',
            sources: [{ kind: 'card', ref: 'Лиза.png', label: 'Лиза', avatar: 'Лиза.png' }],
        }),
        entity({ name: 'Алекс', kind: 'persona', sources: [{ kind: 'persona', ref: 'user.png', label: 'Алекс' }] }),
    );
    env.des.known.push('Лиза');
}
