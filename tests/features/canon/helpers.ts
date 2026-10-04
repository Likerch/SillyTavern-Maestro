// Test app for M6 and M35 roles: the ST mock with an in-memory World Info (ST's cache semantics: loadWorldInfo returns
// a deep clone, saveWorldInfo keeps the object by reference and emits WORLDINFO_UPDATED), real settings, i18n, bus,
// files and chat store, and recording fakes of the journal, autonomy, inbox, UI, ephemeral, turn and adapters.
// Also a miniature of ST's scan (ENTRIES_LOADED, sort, clone, loops with SCAN_DONE) over explicit lists.
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import { BOOK_ROLES_STRINGS } from '../../../src/features/bookRoles/strings';
import { defaultCanonSettings } from '../../../src/features/canon/scan';
import { CANON_STRINGS } from '../../../src/features/canon/strings';
import type {
    App,
    Ephemeral,
    GenerationInfo,
    HealthCheck,
    InjectionSpec,
    MaestroModule,
    PultTab,
    TurnHooks,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeAutonomy, FakeInbox, FakeJournal, FakeModules, FakeTasks } from '../../helpers/rules-app';
import { EVENT_TYPES, installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export type Dict = Record<string, unknown>;

export async function settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A WI entry with ST's usual fields. */
export function wi(uid: number, fields: Dict = {}): Dict {
    return {
        uid,
        key: [`key${uid}`],
        keysecondary: [],
        comment: `Entry ${uid}`,
        content: `Content of entry ${uid}.`,
        order: 100,
        position: 0,
        disable: false,
        ...fields,
    };
}

/** In-memory lorebooks behind ctx.loadWorldInfo / saveWorldInfo and world-info.js. */
export class FakeWorld {
    readonly books = new Map<string, Dict>();
    readonly saves: { name: string; immediately: boolean }[] = [];
    readonly reloads: string[] = [];
    readonly deleted: string[] = [];
    readonly opened: string[] = [];
    selected: string[] = [];
    charLore: Dict[] = [];
    listUpdates = 0;

    constructor(private readonly mock: StMock) {}

    install(host: TestHost): void {
        Object.assign(this.mock.context as unknown as Dict, {
            getWorldInfoNames: () => [...this.books.keys()],
            loadWorldInfo: async (name: string) =>
                this.books.has(name) ? structuredClone(this.books.get(name)) : null,
            saveWorldInfo: async (name: string, data: Dict, immediately?: boolean) => {
                this.books.set(name, data);
                this.saves.push({ name, immediately: immediately === true });
                await this.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_UPDATED!, name, data);
            },
            reloadWorldInfoEditor: (name: string) => void this.reloads.push(name),
            updateWorldInfoList: async () => {
                this.listUpdates++;
            },
        });
        host.modules.worldInfo = async () => ({
            deleteWorldInfo: async (name: string) => {
                if (!this.books.has(name)) return false;
                this.books.delete(name);
                this.deleted.push(name);
                return true;
            },
            openWorldInfoEditor: (name: string) => void this.opened.push(name),
            world_info: { charLore: this.charLore },
            selected_world_info: this.selected,
        });
    }

    /** Adds a book (entries by uid). */
    book(name: string, entries: Dict[], extensions?: Dict): void {
        const data: Dict = { entries: Object.fromEntries(entries.map((entry) => [String(entry.uid), entry])) };
        if (extensions) data.extensions = extensions;
        this.books.set(name, data);
    }

    entries(name: string): Record<string, Dict> {
        const data = this.books.get(name);
        return (data?.entries ?? {}) as Record<string, Dict>;
    }

    entry(name: string, uid: number): Dict | undefined {
        return this.entries(name)[String(uid)];
    }

    /** Edits an entry the way another editor would (new object, saved, WORLDINFO_UPDATED). */
    async edit(name: string, uid: number, fields: Dict): Promise<void> {
        const data = structuredClone(this.books.get(name)) as Dict;
        const entries = data.entries as Record<string, Dict>;
        entries[String(uid)] = { ...entries[String(uid)], ...fields };
        await (
            this.mock.context as unknown as { saveWorldInfo(n: string, d: Dict, i: boolean): Promise<void> }
        ).saveWorldInfo(name, data, true);
    }
}

/** Records producers and injections; run() plays a generation's producer pass. */
export class FakeEphemeral implements Ephemeral {
    readonly producers = new Map<string, (gen: GenerationInfo) => void | Promise<void>>();
    readonly injections = new Map<string, InjectionSpec>();
    readonly flags = new Map<string, string | number | boolean>();

    setFlag(name: string, value: string | number | boolean): void {
        this.flags.set(name, value);
    }
    setInjection(key: string, spec: InjectionSpec): void {
        this.injections.set(key, spec);
    }
    addProducer(name: string, producer: (gen: GenerationInfo) => void | Promise<void>): Unsubscribe {
        this.producers.set(name, producer);
        return () => {
            if (this.producers.get(name) === producer) this.producers.delete(name);
        };
    }
    clearAll(): void {
        this.injections.clear();
        this.flags.clear();
    }
    async run(info: Partial<GenerationInfo> = {}): Promise<void> {
        this.clearAll();
        for (const producer of [...this.producers.values()]) {
            await producer({ type: 'normal', dryRun: false, quiet: false, ...info });
        }
    }
}

export class FakeTurnState implements TurnHooks {
    generation: GenerationInfo | null = null;
    onIntercept(): Unsubscribe {
        return () => {};
    }
    lastAssistantIndex(): number {
        return -1;
    }
    current(): GenerationInfo | null {
        return this.generation;
    }
}

export interface Neighbours {
    desKnown: string[];
    desAliases: Record<string, string[]>;
    desInvalidated: string[];
    ckRepos: string[];
    active: string[];
    desruApi: unknown;
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

export interface TestUi extends FakeUi {
    tabs: PultTab[];
    checks: HealthCheck[];
    styles: Map<string, string>;
}

export interface CanonTestApp {
    app: App;
    mock: StMock;
    host: TestHost;
    world: FakeWorld;
    journal: FakeJournal;
    autonomy: FakeAutonomy;
    inbox: FakeInbox;
    ui: TestUi;
    modules: FakeModules;
    ephemeral: FakeEphemeral;
    turn: FakeTurnState;
    settings: Settings;
    neighbours: Neighbours;
    leader: { value: boolean };
    logLines: LogLineRecord[];
    log: ReturnType<typeof createTestLogger>;
}

export function createCanonTestApp(): CanonTestApp {
    const mock = installStMock();
    mock.chatId = 'Alice - 2026-10-04@12h00m00s';
    const host = createTestHost(mock);
    const world = new FakeWorld(mock);
    world.install(host);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('canon', defaultCanonSettings, true);
    settings.registerModule('bookRoles', () => ({}), true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(CANON_STRINGS);
    i18n.register(BOOK_ROLES_STRINGS);

    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new FakeJournal();
    const autonomy = new FakeAutonomy(journal);
    const inbox = new FakeInbox();
    const modules = new FakeModules();
    const ephemeral = new FakeEphemeral();
    const turn = new FakeTurnState();
    const leader = { value: true };
    const base = createFakeUi();
    const ui: TestUi = Object.assign(base, {
        tabs: [] as PultTab[],
        checks: [] as HealthCheck[],
        styles: new Map<string, string>(),
    });
    ui.addTab = (tab) => {
        ui.tabs.push(tab);
        return () => {
            ui.tabs = ui.tabs.filter((item) => item !== tab);
        };
    };
    ui.addHealthCheck = (check) => {
        ui.checks.push(check);
        return () => {
            ui.checks = ui.checks.filter((item) => item !== check);
        };
    };
    ui.style = (id, css) => {
        ui.styles.set(id, css);
        return () => ui.styles.delete(id);
    };

    const neighbours: Neighbours = {
        desKnown: [],
        desAliases: {},
        desInvalidated: [],
        ckRepos: [],
        active: [],
        desruApi: undefined,
    };
    const adapters = {
        des: adapter('des', {
            knownCharacters: () => neighbours.desKnown,
            aliases: () => neighbours.desAliases,
            invalidateLoreCache: (name: string) => void neighbours.desInvalidated.push(name),
        }),
        desru: adapter('desru', { api: () => neighbours.desruApi }),
        ck: adapter('ck', { repoBooks: () => neighbours.ckRepos }),
        bunnymo: adapter('bunnymo', { activeBooks: async () => [...neighbours.active] }),
        qvink: adapter('qvink'),
        nai: adapter('nai'),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];

    const app = {
        host,
        turn,
        log,
        i18n,
        settings,
        files,
        chat,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks: new FakeTasks(),
        llm: {} as App['llm'],
        cost: {} as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral,
        bus: createBus(log),
        ui,
        adapters,
        modules,
    } as App;

    return {
        app,
        mock,
        host,
        world,
        journal,
        autonomy,
        inbox,
        ui,
        modules,
        ephemeral,
        turn,
        settings,
        neighbours,
        leader,
        logLines,
        log,
    };
}

/** Starts a module the way the module manager does; stop() runs the owned disposers in reverse. */
export async function startModule<S extends object>(
    env: CanonTestApp,
    module: MaestroModule<S>,
): Promise<{ stop(): Promise<void> }> {
    const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    await module.init({
        app: env.app,
        settings: env.settings.module<S>(module.key),
        log: env.log,
        own: (dispose) => disposers.push(dispose),
    });
    return {
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            env.modules.apis.delete(module.key);
        },
    };
}

/** Number of listeners on an ST event of the mock. */
export function listenerCount(env: CanonTestApp, key: string): number {
    return env.mock.eventSource.events.get(EVENT_TYPES[key]!)?.length ?? 0;
}

export interface Lists {
    globalLore: Dict[];
    characterLore: Dict[];
    chatLore: Dict[];
    personaLore: Dict[];
}

/** ST's copies of the books (`({uid, ...rest}) => ({uid, world, ...rest})`) from deep clones of the cache. */
export function listsFrom(world: FakeWorld, placement: Partial<Record<keyof Lists, string[]>>, freeze = true): Lists {
    const lists: Lists = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    for (const [list, books] of Object.entries(placement) as [keyof Lists, string[]][]) {
        for (const name of books) {
            const data = structuredClone(world.books.get(name)) as Dict | undefined;
            for (const entry of Object.values((data?.entries ?? {}) as Record<string, Dict>)) {
                const { uid, ...rest } = entry;
                // Nested arrays alias ST's cache: frozen here, so an in-place mutation throws.
                if (freeze) for (const value of Object.values(rest)) if (Array.isArray(value)) Object.freeze(value);
                lists[list].push({ uid, world: name, ...rest });
            }
        }
    }
    return lists;
}

export interface ScanResult {
    activated: Map<string, Dict>;
    sorted: Dict[];
    loops: number;
}

/**
 * A miniature of ST's checkWorldInfo over explicit lists: ENTRIES_LOADED, chat lore first then the rest by order,
 * structuredClone, loops activating constants and entries whose key is in the chat text (or the recursion text),
 * SCAN_DONE after every loop with `state.next` read back.
 */
export async function runScan(env: CanonTestApp, lists: Lists, chatText: string, maxLoops = 5): Promise<ScanResult> {
    await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
    const byOrder = (a: Dict, b: Dict) => Number(b.order ?? 100) - Number(a.order ?? 100);
    const merged = [
        ...[...lists.chatLore].sort(byOrder),
        ...[...lists.personaLore].sort(byOrder),
        ...[...lists.globalLore, ...lists.characterLore].sort(byOrder),
    ];
    const sorted = structuredClone(merged) as Dict[];
    const activated = new Map<string, Dict>();
    let recursion = '';
    let state = 1;
    let loop = 0;
    while (state && loop < maxLoops) {
        loop++;
        const fresh: Dict[] = [];
        for (const entry of sorted) {
            const id = `${String(entry.world)}.${String(entry.uid)}`;
            if (activated.has(id) || entry.disable === true) continue;
            const haystack = (state === 1 ? chatText : `${chatText}\n${recursion}`).toLowerCase();
            const keys = Array.isArray(entry.key)
                ? entry.key.filter((key): key is string => typeof key === 'string')
                : [];
            if (entry.constant === true || keys.some((key) => key && haystack.includes(key.toLowerCase()))) {
                fresh.push(entry);
            }
        }
        for (const entry of fresh) activated.set(`${String(entry.world)}.${String(entry.uid)}`, entry);
        const added = fresh.map((entry) => String(entry.content ?? '')).join('\n');
        const next = fresh.length ? 2 : 0;
        if (added) recursion = `${added}\n${recursion}`;
        const args = {
            state: { current: state, next, loopCount: loop },
            new: { all: fresh, successful: fresh },
            activated: { entries: activated, text: recursion },
            sortedEntries: sorted,
            recursionDelay: { availableLevels: [], currentLevel: 0 },
            budget: { current: 1_000_000, overflowed: false },
            timedEffects: {},
        };
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_SCAN_DONE!, args);
        state = args.state.next;
    }
    return { activated, sorted, loops: loop };
}
