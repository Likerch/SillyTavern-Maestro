// Test app for M26: the ST mock with chat messages, real settings, i18n, bus, files and chat store, recording fakes of
// the journal, autonomy, inbox, UI, tasks, LLM and adapters, and fakes of the chat canon (M6), the world model (M7),
// the lore journal (M1) and the contradiction service (stage 4).
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import type { MaestroChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import { russianKeysFrom } from '../../../src/domain/canon-keys';
import { nameKey } from '../../../src/domain/living-detect';
import type { CanonApi, CanonDraft, CanonItem, CanonStatus } from '../../../src/features/canon/api';
import type {
    Contradiction,
    ContradictionInput,
    ContradictionResult,
    ContradictionsApi,
} from '../../../src/features/contradictions/api';
import { defaultLivingSettings, LIVING_STRINGS } from '../../../src/features/livingCanon';
import type { LivingCanonService } from '../../../src/features/livingCanon';
import type { LoreActivation, LoreContent, TurnLoreRecord } from '../../../src/features/loreJournal/api';
import type { Entity, Fact } from '../../../src/features/world/api';
import type {
    App,
    LlmRequest,
    LlmResult,
    MaestroModule,
    Proposal,
    PultTab,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeAutonomy, FakeInbox, FakeJournal, FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

/** Lets zero-delay jobs and the mocked file I/O finish (setImmediate spins: timers cost ~15 ms on Windows). */
export async function settle(ms = 10): Promise<void> {
    const end = Date.now() + ms;
    do {
        await new Promise((resolve) => setImmediate(resolve));
    } while (Date.now() < end);
}

let dates = 0;

export function reply(text: string): STChatMessage {
    return message(text, { send_date: `d${++dates}`, swipe_id: 0 });
}

export function userMessage(text = 'Дальше.'): STChatMessage {
    return message(text, { is_user: true, send_date: `d${++dates}` });
}

/* ------------------------------------------------------------------ fakes of other modules */

export class FakeCanon implements CanonApi {
    items: CanonItem[] = [];
    book = 'Maestro · канон · 00000001';
    readonly calls: string[] = [];
    private readonly listeners = new Set<() => void>();

    bookName(): string {
        return this.book;
    }
    async ensureBook(): Promise<string> {
        return this.book;
    }
    async list(filter: { kind?: string; status?: string; origin?: string } = {}): Promise<CanonItem[]> {
        return structuredClone(
            this.items.filter(
                (item) =>
                    (!filter.kind || item.meta.kind === filter.kind) &&
                    (!filter.status || item.meta.status === filter.status) &&
                    (!filter.origin || item.meta.origin === filter.origin),
            ),
        );
    }
    async put(draft: CanonDraft, options: { uid?: number } = {}): Promise<number> {
        let uid = options.uid;
        if (uid === undefined) {
            uid = 0;
            while (this.items.some((item) => item.uid === uid)) uid++;
        }
        const previous = this.items.find((item) => item.uid === uid);
        const item: CanonItem = {
            uid,
            meta: { ...structuredClone(draft.meta), createdAt: previous?.meta.createdAt ?? 1, updatedAt: Date.now() },
            entry: { ...structuredClone(draft.entry), uid },
        };
        delete item.entry.extensions;
        this.items = [...this.items.filter((other) => other.uid !== uid), item].sort((a, b) => a.uid - b.uid);
        this.calls.push(`put:${uid}`);
        this.emit();
        return uid;
    }
    async remove(uid: number): Promise<void> {
        this.items = this.items.filter((item) => item.uid !== uid);
        this.calls.push(`remove:${uid}`);
        this.emit();
    }
    async setStatus(uid: number, status: CanonStatus): Promise<void> {
        const item = this.items.find((other) => other.uid === uid);
        if (item) item.meta.status = status;
        this.calls.push(`status:${uid}:${status}`);
        this.emit();
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
    /** The canon's own fallback: the term and a left-boundary regex key (no DES-RU). */
    async russianKeys(term: string): Promise<string[]> {
        return russianKeysFrom(term, undefined, undefined);
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** A user edit in the Lore Studio. */
    edit(uid: number, patch: Record<string, unknown>): void {
        const item = this.items.find((other) => other.uid === uid);
        if (item) item.entry = { ...item.entry, ...patch };
        this.emit();
    }
    item(uid: number | undefined): CanonItem | undefined {
        return this.items.find((other) => other.uid === uid);
    }
    living(): CanonItem[] {
        return this.items.filter((item) => item.meta.origin === 'living');
    }
    private emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

export function canonItem(uid: number, name: string, content: string, origin = 'user'): CanonItem {
    return {
        uid,
        meta: {
            kind: 'addition',
            status: 'active',
            origin: origin as CanonItem['meta']['origin'],
            createdAt: 1,
            updatedAt: 1,
        },
        entry: { uid, comment: name, key: [name], content },
    };
}

export class FakeContradictions implements ContradictionsApi {
    readonly quickInputs: ContradictionInput[] = [];
    readonly checkInputs: ContradictionInput[] = [];
    readonly checkOptions: unknown[] = [];
    /** Rules: contradictions for an input (none by default). */
    rule: (input: ContradictionInput) => Contradiction[] = () => [];
    /** The model's verdict when check() runs (default: the rules). */
    verdict: ((input: ContradictionInput) => ContradictionResult) | null = null;

    quick(input: ContradictionInput): Contradiction[] {
        this.quickInputs.push(input);
        return this.rule(input);
    }
    async check(input: ContradictionInput, options?: unknown): Promise<ContradictionResult> {
        this.checkInputs.push(input);
        this.checkOptions.push(options);
        if (this.verdict) return this.verdict(input);
        const contradictions = this.rule(input);
        return { clean: !contradictions.length, askedAi: true, contradictions, costUsd: 0 };
    }
}

export function contradiction(label: string, statement = 'a', conflicting = 'b'): Contradiction {
    return { label, statement, conflicting, kind: 'negation', confidence: 0.9 };
}

export class FakeWorld {
    list: Entity[] = [];
    entities(): Entity[] {
        return this.list;
    }
    get(id: string): Entity | undefined {
        return this.list.find((entity) => entity.id === id);
    }
    resolve(name: string): Entity | undefined {
        return this.list.find((entity) =>
            [entity.name, ...entity.aliases].some((item) => nameKey(item) === nameKey(name)),
        );
    }
    mentions(text: string): Entity[] {
        return this.list.filter((entity) => text.includes(entity.name));
    }
    facts(): Fact[] {
        return [];
    }
    add(name: string, kind: Entity['kind'] = 'character'): void {
        this.list.push({
            id: `${kind}:${name.toLowerCase()}`,
            kind,
            name,
            aliases: [],
            forms: [],
            sources: [{ kind: 'des.character', ref: name, label: name }],
        });
    }
}

export class FakeLore {
    records: TurnLoreRecord[] = [];
    contents: LoreContent[] = [];
    turns(): TurnLoreRecord[] {
        return this.records;
    }
    lastContents(): LoreContent[] {
        return this.contents;
    }
    /** The lore of the turn that produced `messageIndex`. */
    record(messageIndex: number, activations: Partial<LoreActivation>[]): void {
        this.records.push({
            messageIndex,
            at: Date.now(),
            generationType: 'normal',
            activations: activations.map((item) => ({
                world: 'Book',
                uid: 0,
                comment: '',
                chars: 10,
                tokens: 3,
                position: 0,
                order: 100,
                loop: 1,
                recursionLevel: 0,
                tags: [],
                ...item,
            })),
            totalChars: 0,
            totalTokens: 0,
            overflow: false,
        });
    }
}

export class FakeLlm {
    available = true;
    result: LlmResult = { ok: true, data: { provisional: [], facts: [] } };
    readonly requests: LlmRequest[] = [];
    api(): App['llm'] {
        return {
            available: () => this.available,
            request: async <T>(request: LlmRequest): Promise<LlmResult<T>> => {
                this.requests.push(request);
                return this.result as LlmResult<T>;
            },
        };
    }
}

/** FakeInbox that keeps every handler. */
export class RecordingInbox extends FakeInbox {
    readonly rejecters = new Map<string, (payload: unknown) => Promise<void>>();
    readonly validators = new Map<string, (payload: unknown) => Promise<boolean>>();
    override registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
        onReject?: (payload: unknown) => Promise<void>,
    ): Unsubscribe {
        if (onReject) this.rejecters.set(kind, onReject);
        if (stillValid) this.validators.set(kind, stillValid);
        return super.registerApplier(kind, apply);
    }
}

/* ------------------------------------------------------------------ the app */

export interface TestUi extends FakeUi {
    tabs: PultTab[];
    styles: Map<string, string>;
    opened: (string | undefined)[];
}

export interface LivingTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    chat: MaestroChatStore;
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: RecordingInbox;
    ui: TestUi;
    modules: FakeModules;
    tasks: FakeTasks;
    llm: FakeLlm;
    canon: FakeCanon;
    world: FakeWorld;
    lore: FakeLore;
    contradictions: FakeContradictions;
    neighbours: { desruApi: unknown };
    leader: { value: boolean; listeners: Set<(leader: boolean) => void> };
    logLines: LogLineRecord[];
    settings: Settings;
}

function adapter(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    };
}

export function createLivingTestApp(): LivingTestApp {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('livingCanon', defaultLivingSettings, true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(LIVING_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new RecordingInbox();
    const modules = new FakeModules();
    const tasks = new FakeTasks();
    const llm = new FakeLlm();
    const canon = new FakeCanon();
    const world = new FakeWorld();
    const lore = new FakeLore();
    const contradictions = new FakeContradictions();
    modules.expose('canon', canon);
    modules.expose('world', world);
    modules.expose('loreJournal', lore);
    modules.expose('contradictions', contradictions);
    const leader = { value: true, listeners: new Set<(leader: boolean) => void>() };
    const base = createFakeUi();
    const ui: TestUi = Object.assign(base, {
        tabs: [] as PultTab[],
        styles: new Map<string, string>(),
        opened: [] as (string | undefined)[],
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
    ui.openPult = (tab) => {
        ui.opened.push(tab);
    };
    ui.closePult = () => {};
    const neighbours = { desruApi: undefined as unknown };
    const adapters = {
        des: adapter('des', { aliases: () => ({}) }),
        desru: adapter('desru', { api: () => neighbours.desruApi }),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink'),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const app = {
        host,
        turn: new FakeTurn(),
        log,
        i18n,
        settings,
        files,
        chat,
        leader: {
            isLeader: () => leader.value,
            onChange: (listener: (value: boolean) => void) => {
                leader.listeners.add(listener);
                return () => leader.listeners.delete(listener);
            },
        },
        tasks,
        llm: llm.api(),
        cost: {} as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
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
        autonomy,
        inbox,
        ui,
        modules,
        tasks,
        llm,
        canon,
        world,
        lore,
        contradictions,
        neighbours,
        leader,
        logLines,
        settings,
    };
}

export interface Started {
    living: LivingCanonService;
    stop(): Promise<void>;
}

/** Starts a module the way the module manager does; stop() runs the owned disposers in reverse. */
export async function startModule<S extends object>(env: LivingTestApp, module: MaestroModule<S>): Promise<Started> {
    const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    await module.init({
        app: env.app,
        settings: env.settings.module<S>(module.key),
        log: env.app.log,
        own: (dispose) => disposers.push(dispose),
    });
    const living = env.modules.api<LivingCanonService>(module.key) as LivingCanonService;
    await settle();
    await living.idle();
    return {
        living,
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            env.modules.apis.delete(module.key);
        },
    };
}

/** Waits until the service has nothing queued. */
export async function flush(living: LivingCanonService): Promise<void> {
    for (let i = 0; i < 3; i++) {
        await settle();
        await living.idle();
    }
}

/** A reply arrives (reply:ready). Returns its index. */
export async function replyArrives(env: LivingTestApp, living: LivingCanonService, text: string): Promise<number> {
    env.mock.chat.push(reply(text));
    const index = env.mock.chat.length - 1;
    await env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
    await flush(living);
    return index;
}

/** The user answers: the last reply is committed (P14). */
export async function commit(env: LivingTestApp, living: LivingCanonService, text = 'Дальше.'): Promise<void> {
    const index = [...env.mock.chat.keys()].reverse().find((i) => !env.mock.chat[i]?.is_user) ?? -1;
    env.mock.chat.push(userMessage(text));
    await env.app.bus.emit('turn:committed', { messageIndex: index });
    await flush(living);
}

/** A whole turn: reply, then the user's answer. Returns the reply's index. */
export async function turn(
    env: LivingTestApp,
    living: LivingCanonService,
    text: string,
    answer?: string,
): Promise<number> {
    const index = await replyArrives(env, living, text);
    await commit(env, living, answer);
    return index;
}

export function proposalsOf(env: LivingTestApp, kind: string): Proposal[] {
    return env.autonomy.proposals.filter((proposal) => proposal.kind === kind);
}
