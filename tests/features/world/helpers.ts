// Test app for M7 (world model) and M19 (relations): the ST mock with in-memory lorebooks, real settings, i18n, bus,
// files and chat store; recording fakes of the journal, autonomy, Inbox, UI, turn state and the neighbour adapters
// (DES roster, aliases and tracker from chat messages; a fake DESRU_API with case forms and onNamesChanged; NAI card
// passports; CK repos; BunnyMo's active books).
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import { RELATIONS_STRINGS } from '../../../src/features/relations/strings';
import { WORLD_STRINGS } from '../../../src/features/world/strings';
import type {
    App,
    AutonomyLevel,
    AutonomyStats,
    Decision,
    GenerationInfo,
    Inbox,
    InboxCard,
    JournalAction,
    JournalChange,
    JournalRecord,
    MaestroModule,
    Proposal,
    PultTab,
    TurnHooks,
    UndoHandler,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, TestHost } from '../../helpers/core-host';
import { FakeModules } from '../../helpers/rules-app';
import { EVENT_TYPES, installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

export type Dict = Record<string, unknown>;

/** Lets promise chains and zero-delay timers settle (real timers). */
export async function settle(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Lets promise chains settle under fake timers. */
export async function flushPromises(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}

export class RecordingJournal {
    readonly records: JournalRecord[] = [];
    readonly handlers = new Map<string, UndoHandler>();
    private next = 1;
    async record(action: JournalAction): Promise<string> {
        const id = `j${this.next++}`;
        this.records.push({ ...structuredClone(action), id, at: Date.now(), chatId: 'chat-1' });
        return id;
    }
    async undo(id: string): Promise<boolean> {
        const record = this.records.find((item) => item.id === id);
        if (!record || record.undone) return false;
        for (const change of [...record.changes].reverse()) {
            const handler = this.handlers.get(change.target);
            if (!handler || !(await handler(change))) return false;
        }
        record.undone = true;
        return true;
    }
    async undoForMessage(): Promise<number> {
        return 0;
    }
    list(): JournalRecord[] {
        return this.records;
    }
    registerUndo(target: string, handler: UndoHandler): void {
        this.handlers.set(target, handler);
    }
}

interface StoredCard extends InboxCard {
    proposal: Proposal;
}

/** An Inbox that keeps cards in memory, applies them through the registered applier and counts rejections. */
export class RecordingInbox implements Inbox {
    readonly cards: StoredCard[] = [];
    readonly appliers = new Map<string, { apply: (payload: unknown) => Promise<void>; args: unknown[] }>();
    readonly listeners = new Set<() => void>();
    private next = 1;
    constructor(private readonly stats: Map<string, AutonomyStats>) {}
    registerApplier(kind: string, apply: (payload: unknown) => Promise<void>, ...rest: unknown[]): Unsubscribe {
        this.appliers.set(kind, { apply, args: rest });
        return () => this.appliers.delete(kind);
    }
    async add(proposal: Proposal): Promise<string> {
        const id = `card${this.next++}`;
        this.cards.push({
            id,
            module: proposal.module,
            kind: proposal.kind,
            title: proposal.title,
            description: proposal.description,
            changes: structuredClone(proposal.changes),
            payload: structuredClone(proposal.payload),
            createdAt: Date.now(),
            proposal,
        });
        this.emit();
        return id;
    }
    list(): InboxCard[] {
        return this.cards.map((card) => {
            const copy: Partial<StoredCard> = { ...card };
            delete copy.proposal;
            return copy as InboxCard;
        });
    }
    async accept(id: string): Promise<boolean> {
        const index = this.cards.findIndex((card) => card.id === id);
        const card = this.cards[index];
        if (!card) return false;
        await this.appliers.get(card.kind)?.apply(card.payload);
        this.cards.splice(index, 1);
        this.emit();
        return true;
    }
    async reject(id: string): Promise<void> {
        const index = this.cards.findIndex((card) => card.id === id);
        const card = this.cards[index];
        if (!card) return;
        this.cards.splice(index, 1);
        this.emit();
        // As the real Inbox: the autonomy counts the rejection after the change was emitted.
        const stat = this.stats.get(card.kind) ?? {
            kind: card.kind,
            accepted: 0,
            edited: 0,
            rejected: 0,
            undone: 0,
            streak: 0,
        };
        stat.rejected++;
        this.stats.set(card.kind, stat);
    }
    async snooze(id: string): Promise<void> {
        const index = this.cards.findIndex((card) => card.id === id);
        if (index >= 0) this.cards.splice(index, 1);
        this.emit();
    }
    async invalidateMessage(): Promise<number> {
        return 0;
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    count(): number {
        return this.cards.length;
    }
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

export class RecordingAutonomy {
    readonly levels = new Map<string, AutonomyLevel>();
    readonly proposals: Proposal[] = [];
    constructor(
        private readonly inbox: RecordingInbox,
        readonly statsMap: Map<string, AutonomyStats>,
    ) {}
    level(kind: string, fallback: AutonomyLevel): AutonomyLevel {
        return this.levels.get(kind) ?? fallback;
    }
    async decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision> {
        this.proposals.push(proposal as Proposal);
        const level = this.level(proposal.kind, fallback);
        if (level === 'off') return 'skipped';
        if (level === 'inbox') {
            await this.inbox.add(proposal as Proposal);
            return 'queued';
        }
        await proposal.apply(proposal.payload);
        return 'applied';
    }
    record(): void {}
    stats(): AutonomyStats[] {
        return [...this.statsMap.values()];
    }
    neverAuto(): void {}
}

export class FakeTurn implements TurnHooks {
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

/** In-memory lorebooks behind ctx.loadWorldInfo (deep copies, like ST's cache). */
export class FakeBooks {
    readonly books = new Map<string, Dict>();
    loads = 0;
    constructor(private readonly mock: StMock) {
        Object.assign(mock.context as unknown as Dict, {
            getWorldInfoNames: () => [...this.books.keys()],
            loadWorldInfo: async (name: string) => {
                this.loads++;
                return this.books.has(name) ? structuredClone(this.books.get(name)) : null;
            },
        });
    }
    book(name: string, entries: Dict[]): void {
        this.books.set(name, { entries: Object.fromEntries(entries.map((entry) => [String(entry.uid), entry])) });
    }
    async updated(name: string): Promise<void> {
        await this.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_UPDATED!, name, this.books.get(name));
    }
}

export function wi(uid: number, fields: Dict = {}): Dict {
    return { uid, key: [], keysecondary: [], comment: '', content: `Entry ${uid}.`, disable: false, ...fields };
}

/** A fake of DES-RU's published API (DES-RU 0.8.0+). */
export class FakeDesRu {
    readonly version = 1;
    forms: Record<string, string[]> = {};
    aliasMap: Record<string, string[]> = {};
    readonly listeners = new Set<() => void>();
    calls = 0;
    nameForms(name: string): string[] {
        this.calls++;
        return this.forms[name] ?? [name];
    }
    nameFormsKey(): string | null {
        return null;
    }
    aliases(): Record<string, string[]> {
        return structuredClone(this.aliasMap);
    }
    onNamesChanged(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    functions(): string[] {
        return [];
    }
    setMaestroOwned(): void {}
    maestroOwned(): string[] {
        return [];
    }
    fire(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

/** A fake of NAI Studio's API v1 (only what the world model reads): passports by scope and the saved event. */
export class FakeNaiApi {
    readonly version = 1;
    byAvatar: Record<string, Dict[]> = {};
    persona: Dict[] = [];
    chat: Dict[] = [];
    readonly listeners = new Set<(detail: unknown) => void>();
    passports(scope: { avatar?: string; persona?: boolean; chat?: boolean } = {}): Dict[] {
        if (scope.avatar) return structuredClone(this.byAvatar[scope.avatar] ?? []);
        if (scope.persona) return structuredClone(this.persona);
        if (scope.chat) return structuredClone(this.chat);
        return [];
    }
    on(_event: string, listener: (detail: unknown) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    fire(): void {
        for (const listener of [...this.listeners]) listener({ ids: [], scope: 'card' });
    }
}

export interface Neighbours {
    desKnown: string[];
    desRemoved: string[];
    desAliases: Record<string, string[]>;
    desru: FakeDesRu | undefined;
    ckRepos: string[];
    active: string[];
    naiSettings: Dict | null;
    naiApi: FakeNaiApi | undefined;
    rosterReads: number;
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
    styles: Map<string, string>;
}

export interface WorldEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    books: FakeBooks;
    journal: RecordingJournal;
    inbox: RecordingInbox;
    autonomy: RecordingAutonomy;
    ui: TestUi;
    modules: FakeModules;
    turn: FakeTurn;
    leader: { value: boolean; listeners: Set<(leader: boolean) => void> };
    neighbours: Neighbours;
    chatStore: ReturnType<typeof createChatStore>;
}

export function createWorldEnv(): WorldEnv {
    const mock = installStMock();
    mock.chatId = 'Elizabeth - 2026-10-04@12h00m00s';
    const host = createTestHost(mock);
    const books = new FakeBooks(mock);
    const log = createTestLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('world', () => ({}), true);
    settings.registerModule('relations', () => ({}), true);
    const i18n = createI18n(() => 'en');
    i18n.register(CORE_STRINGS);
    i18n.register(WORLD_STRINGS);
    i18n.register(RELATIONS_STRINGS);
    const files = createFileStore(host, log);
    const chatStore = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new RecordingJournal();
    const stats = new Map<string, AutonomyStats>();
    const inbox = new RecordingInbox(stats);
    const autonomy = new RecordingAutonomy(inbox, stats);
    const modules = new FakeModules();
    const turn = new FakeTurn();
    const leader = { value: true, listeners: new Set<(leader: boolean) => void>() };
    const base = createFakeUi();
    const ui: TestUi = Object.assign(base, { tabs: [] as PultTab[], styles: new Map<string, string>() });
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
    const neighbours: Neighbours = {
        desKnown: [],
        desRemoved: [],
        desAliases: {},
        desru: undefined,
        ckRepos: [],
        active: [],
        naiSettings: null,
        naiApi: undefined,
        rosterReads: 0,
    };
    const passportsOf = (index: number): unknown[] => {
        const field = (mock.context.characters[index]?.data?.extensions as Dict | undefined)?.nai_studio as
            Dict | undefined;
        return Array.isArray(field?.passports) ? structuredClone(field.passports) : [];
    };
    const adapters = {
        des: adapter('des', {
            knownCharacters: () => {
                neighbours.rosterReads++;
                return [...neighbours.desKnown];
            },
            removedCharacters: () => [...neighbours.desRemoved],
            aliases: () => structuredClone(neighbours.desAliases),
            trackerFor: (index: number) => {
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
        }),
        desru: adapter('desru', { api: () => neighbours.desru }),
        ck: adapter('ck', { repoBooks: () => [...neighbours.ckRepos] }),
        bunnymo: adapter('bunnymo', { activeBooks: async () => [...neighbours.active] }),
        qvink: adapter('qvink'),
        nai: adapter('nai', {
            passportsOf,
            settings: () => neighbours.naiSettings,
            api: () => neighbours.naiApi,
            chatPassports: (scope?: Dict) => neighbours.naiApi?.passports(scope) ?? [],
            on: (event: string, listener: (detail: unknown) => void) =>
                neighbours.naiApi ? neighbours.naiApi.on(event, listener) : () => {},
        }),
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
        chat: chatStore,
        leader: {
            isLeader: () => leader.value,
            onChange: (listener: (value: boolean) => void) => {
                leader.listeners.add(listener);
                return () => leader.listeners.delete(listener);
            },
        },
        tasks: {} as App['tasks'],
        llm: {} as App['llm'],
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

    return { app, mock, host, books, journal, inbox, autonomy, ui, modules, turn, leader, neighbours, chatStore };
}

export async function startModule<S extends object>(
    env: WorldEnv,
    module: MaestroModule<S>,
): Promise<{ stop(): Promise<void> }> {
    const disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    await module.init({
        app: env.app,
        settings: env.app.settings.module<S>(module.key),
        log: env.app.log,
        own: (dispose) => disposers.push(dispose),
    });
    return {
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            env.modules.apis.delete(module.key);
        },
    };
}

/** An assistant message with a DES tracker record for its current swipe. */
export function trackerMessage(
    text: string,
    characters: Dict[],
    infoBox: Dict | null = { date: { value: '3 марта' }, time: { start: '14:00' } },
): STChatMessage {
    return message(text, {
        name: 'Elizabeth',
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: null,
                    infoBox: infoBox ? JSON.stringify(infoBox) : null,
                    characterThoughts: JSON.stringify(characters),
                },
            ],
        },
    });
}

export function userMessage(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'Алекс' });
}

/** A card in ctx.characters (index returned), selected as the current character. */
export function addCard(env: WorldEnv, name: string, extensions: Dict = {}): number {
    const characters = env.mock.context.characters as STCharacter[];
    characters.push({ name, avatar: `${name}.png`, data: { extensions } });
    const index = characters.length - 1;
    (env.mock.context as unknown as Dict).characterId = index;
    return index;
}

export async function emitSt(env: WorldEnv, key: string, ...args: unknown[]): Promise<void> {
    await env.mock.eventSource.emit(EVENT_TYPES[key]!, ...args);
}

export function changeOf(target: string, ref: Dict, before: unknown, after: unknown): JournalChange {
    return { target, ref, before, after };
}
