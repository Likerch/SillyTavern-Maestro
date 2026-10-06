// Test app for M27 (wardrobe): the ST mock with assistant messages carrying a DES tracker (characters with details,
// the scene), a real bus, files and chat store, a switchable leader, a fake NAI Studio API (card, persona and chat
// passports with chat-level views, recorded calls), a fake world model with passport sources, a fake place registry
// (current place, enter events), a fake revision (deferred cards), a recording journal and an autonomy fake with
// levels. Fake timers drive the settle and intake delays.
import { vi } from 'vitest';
import { readPassport } from '../../../src/adapters/nai';
import type {
    NaiPassport,
    NaiPassportScope,
    NaiPassportTarget,
    NaiSaveScope,
    NaiStudioApi,
    NaiStudioEvent,
    NaiStudioEvents,
} from '../../../src/adapters/nai';
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { desSwipeRecord, parseDesTracker } from '../../../src/domain/des-tracker';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import type { DeferredCard, RevisionApi, RevisionRun } from '../../../src/features/revision/api';
import { wardrobeModule } from '../../../src/features/wardrobe';
import type { WardrobeService } from '../../../src/features/wardrobe';
import { WARDROBE_STRINGS } from '../../../src/features/wardrobe/strings';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type {
    App,
    AutonomyLevel,
    Decision,
    GenerationInfo,
    HealthCheck,
    InjectionSpec,
    LlmRequest,
    LlmResult,
    Proposal,
    PultTab,
    SettingsService,
    Signal,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger, switchChat } from '../../helpers/core-host';
import type { FakeUi, LogLineRecord, TestHost } from '../../helpers/core-host';
import { FakeInbox, FakeJournal, FakeModules, FakeTasks, FakeTurn } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

/** Module defaults: settle 500 ms after a send, intake 300 ms after a revision change. */
export const SETTLE = 550;
export const INTAKE = 350;

const PRESETS: Record<string, string> = {
    wet: 'wet, wet hair, wet clothes',
    messy: 'messy hair, disheveled',
    tears: 'tears, crying',
    blush: 'blush, embarrassed',
    injured: 'injury, bandages, bruise',
    sleepy: 'sleepy, half-closed eyes',
    angry: 'angry, frown',
    happy: 'smile, happy',
};

/** A NAI passport as NAI Studio normalises it (character presets on). */
export function passport(id: string, name: string, extra: Partial<NaiPassport> = {}): NaiPassport {
    const kind = extra.kind ?? 'character';
    return {
        id,
        kind,
        name,
        aliases: [],
        tags: '',
        slots: { base: '1girl', hair: '', eyes: '', body: '', skin: '', clothing: '', accessories: '', style: '' },
        outfits: [],
        activeOutfit: '',
        states:
            kind === 'character'
                ? Object.entries(PRESETS).map(([state, tags]) => ({ id: state, tags, enabled: false }))
                : [],
        negative: '',
        ...extra,
    };
}

export interface NaiCall {
    method: 'savePassport' | 'setOutfit' | 'setState' | 'clearChatOverride';
    args: unknown[];
}

/** NAI Studio's API v1 over in-memory passports: chat writes keep a chat view per passport id over the base. */
export class FakeNai implements NaiStudioApi {
    readonly version = 1;
    readonly cards = new Map<string, NaiPassport[]>();
    persona: NaiPassport[] = [];
    chatOwn: NaiPassport[] = [];
    readonly views = new Map<string, NaiPassport>();
    /** Passports of the chat itself made through savePassport (clearChatOverride drops them). */
    readonly created = new Set<string>();
    readonly calls: NaiCall[] = [];
    private readonly listeners = new Map<string, Set<(detail: unknown) => void>>();

    private base(id: string): NaiPassport | undefined {
        for (const list of [...this.cards.values(), this.persona, this.chatOwn]) {
            const found = list.find((item) => item.id === id);
            if (found) return found;
        }
        return undefined;
    }

    view(id: string): NaiPassport | undefined {
        return this.views.get(id) ?? this.base(id);
    }

    passports(scope?: NaiPassportScope): NaiPassport[] {
        const all = !scope || (scope.avatar === undefined && !scope.persona && !scope.chat);
        const out: NaiPassport[] = [];
        if (all) for (const list of this.cards.values()) out.push(...list);
        else if (scope.avatar !== undefined) out.push(...(this.cards.get(scope.avatar) ?? []));
        if (all || scope?.persona) out.push(...this.persona);
        if (all || scope?.chat) out.push(...this.chatOwn);
        return structuredClone(out.map((item) => this.view(item.id)!));
    }

    getPassport(id: string): NaiPassport | null {
        const found = this.view(id);
        return found ? structuredClone(found) : null;
    }

    async savePassport(value: NaiPassport, scope: NaiSaveScope, target?: NaiPassportTarget): Promise<void> {
        this.calls.push({ method: 'savePassport', args: [structuredClone(value), scope, target] });
        if (scope !== 'chat') throw new Error('NAI Studio API: the card must not be written in these tests');
        // A passport with no card or persona behind it becomes a passport of the chat itself.
        if (!target && !this.base(value.id)) {
            this.chatOwn.push(structuredClone(value));
            this.created.add(value.id);
        }
        this.views.set(value.id, structuredClone(value));
        this.emit('passportsSaved', { ids: [value.id], scope });
    }

    async setOutfit(id: string, outfit: string, scope: NaiSaveScope = 'chat'): Promise<void> {
        this.calls.push({ method: 'setOutfit', args: [id, outfit, scope] });
        const current = this.view(id);
        if (!current) throw new Error(`NAI Studio API: no passport "${id}" in this chat`);
        const edited = structuredClone(current);
        const match = edited.outfits.find((item) => item.name.toLowerCase() === outfit.trim().toLowerCase());
        if (outfit.trim() && !match) throw new Error(`NAI Studio API: passport "${id}" has no outfit "${outfit}"`);
        edited.activeOutfit = match?.name ?? '';
        this.views.set(id, edited);
        this.emit('passportsSaved', { ids: [id], scope });
    }

    async setState(id: string, stateId: string, enabled: boolean, scope: NaiSaveScope = 'chat'): Promise<void> {
        this.calls.push({ method: 'setState', args: [id, stateId, enabled, scope] });
        const current = this.view(id);
        if (!current) throw new Error(`NAI Studio API: no passport "${id}" in this chat`);
        const edited = structuredClone(current);
        const existing = edited.states.find((state) => state.id.toLowerCase() === stateId.toLowerCase());
        if (existing) existing.enabled = enabled;
        else if (enabled) edited.states.push({ id: stateId, tags: stateId, enabled: true });
        else return;
        this.views.set(id, edited);
        this.emit('passportsSaved', { ids: [id], scope });
    }

    async clearChatOverride(id: string): Promise<void> {
        this.calls.push({ method: 'clearChatOverride', args: [id] });
        this.views.delete(id);
        if (this.created.has(id)) this.chatOwn = this.chatOwn.filter((item) => item.id !== id);
    }

    on<K extends NaiStudioEvent>(event: K, listener: (detail: NaiStudioEvents[K]) => void): () => void {
        const set = this.listeners.get(event) ?? new Set();
        this.listeners.set(event, set);
        set.add(listener as (detail: unknown) => void);
        return () => set.delete(listener as (detail: unknown) => void);
    }

    listenerCount(): number {
        return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
    }

    registerSceneProvider(): () => void {
        return () => {};
    }

    private emit(event: string, detail: unknown): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) listener(detail);
    }

    /** Calls of one method, oldest first. */
    of(method: NaiCall['method']): unknown[][] {
        return this.calls.filter((call) => call.method === method).map((call) => call.args);
    }
}

/** Autonomy with levels per kind; 'auto' applies and journals (with the source message), like the core. */
export class LevelAutonomy {
    readonly levels = new Map<string, AutonomyLevel>();
    readonly proposals: Proposal[] = [];

    constructor(private readonly journal: FakeJournal) {}

    level(kind: string, fallback: AutonomyLevel): AutonomyLevel {
        return this.levels.get(kind) ?? fallback;
    }

    async decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision> {
        this.proposals.push(proposal as Proposal);
        const level = this.level(proposal.kind, fallback);
        if (level === 'off') return 'skipped';
        if (level === 'inbox') return 'queued';
        if (level === 'notify') return 'notified';
        if (proposal.stillValid && !(await proposal.stillValid())) return 'skipped';
        try {
            await proposal.apply(proposal.payload);
        } catch {
            return 'skipped';
        }
        await this.journal.record({
            module: proposal.module,
            kind: proposal.kind,
            summary: proposal.title,
            changes: proposal.changes,
            ...(proposal.sourceMessage !== undefined ? { sourceMessage: proposal.sourceMessage } : {}),
        });
        return 'applied';
    }

    record(): void {}
    stats() {
        return [];
    }
    readonly never = new Set<string>();
    neverAuto(kind: string): void {
        this.never.add(kind);
    }
}

/** Ephemeral prompt changes of one generation (producers run by generate()). */
export class FakeEphemeral {
    readonly producers = new Map<string, (gen: GenerationInfo) => void | Promise<void>>();
    readonly injections = new Map<string, InjectionSpec>();
    setFlag(): void {}
    setInjection(key: string, spec: InjectionSpec): void {
        this.injections.set(key, spec);
    }
    addProducer(name: string, producer: (gen: GenerationInfo) => void | Promise<void>): Unsubscribe {
        this.producers.set(name, producer);
        return () => this.producers.delete(name);
    }
    clearAll(): void {
        this.injections.clear();
    }
    /** Runs every producer for one generation; the injections it set. */
    async generate(gen: Partial<GenerationInfo> = {}): Promise<Map<string, InjectionSpec>> {
        this.injections.clear();
        const info: GenerationInfo = { type: 'normal', dryRun: false, quiet: false, ...gen };
        for (const producer of this.producers.values()) await producer(info);
        return new Map(this.injections);
    }
}

/** The background model: answers by a function of the request; records the requests. */
export class FakeLlm {
    readonly requests: LlmRequest[] = [];
    availableValue = true;
    answer: (request: LlmRequest) => LlmResult = () => ({ ok: true, data: { wearing: null } });
    available(): boolean {
        return this.availableValue;
    }
    async request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
        this.requests.push(request);
        return this.answer(request) as LlmResult<T>;
    }
}

export class FakeRevision implements RevisionApi {
    cards: DeferredCard[] = [];
    dismissed: string[] = [];
    readonly runListeners = new Set<(run: RevisionRun) => void>();
    readonly changeListeners = new Set<() => void>();
    private next = 0;

    async run(): Promise<void> {}
    runs(): RevisionRun[] {
        return [];
    }
    deferred(): DeferredCard[] {
        return this.cards.map((card) => ({ ...card }));
    }
    onRun(listener: (run: RevisionRun) => void): Unsubscribe {
        this.runListeners.add(listener);
        return () => this.runListeners.delete(listener);
    }
    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }
    async dismissDeferred(id: string): Promise<void> {
        this.dismissed.push(id);
        this.cards = this.cards.filter((card) => card.id !== id);
    }
    card(
        value: string,
        sourceMessage: number,
        entityName = 'Anna',
        target: DeferredCard['target'] = 'deferred.outfit',
    ) {
        const card: DeferredCard = {
            id: `def-${++this.next}`,
            target,
            entityName,
            value,
            evidence: '«…»',
            sourceMessage,
            at: this.next,
        };
        this.cards.push(card);
        return card;
    }
    finish(): void {
        const run: RevisionRun = {
            id: 'rev-1',
            at: 1,
            reason: 'manual',
            fromMessage: 0,
            toMessage: 0,
            changes: [],
            rejected: [],
            costUsd: 0,
        };
        for (const listener of [...this.runListeners]) listener(run);
    }
}

/** World model: people with their NAI passport sources; resolve by name or alias (case-insensitive). */
export function fakeWorld(
    people: { name: string; aliases?: string[]; passportId?: string; avatar?: string; persona?: boolean }[],
): WorldModelApi {
    const entities: Entity[] = people.map((person) => ({
        id: `${person.persona ? 'persona' : 'character'}:${person.name.toLowerCase()}`,
        kind: person.persona ? 'persona' : 'character',
        name: person.name,
        aliases: person.aliases ?? [],
        forms: [],
        sources: person.passportId
            ? [
                  {
                      kind: 'nai.passport',
                      ref: `${person.persona ? 'persona' : (person.avatar ?? 'chat')}#${person.passportId}`,
                      label: person.name,
                      passportId: person.passportId,
                      ...(person.avatar ? { avatar: person.avatar } : {}),
                  },
              ]
            : [],
    }));
    const names = (entity: Entity) => [entity.name, ...entity.aliases].map((name) => name.toLowerCase());
    return {
        entities: () => entities,
        get: (id) => entities.find((entity) => entity.id === id),
        resolve: (name, kind) =>
            entities.find(
                (entity) => (!kind || entity.kind === kind) && names(entity).includes(name.trim().toLowerCase()),
            ),
        mentions: () => [],
        facts: () => [],
        rebuild: async () => {},
        chatAliases: () => ({}),
        setChatAlias: async () => {},
        merge: async () => {},
        separate: async () => {},
        mergeCandidates: () => [],
        onChange: () => () => {},
    };
}

/** Place registry: a list, the current place and enter events. */
export class FakePlaces implements Pick<PlacesApi, 'list' | 'get' | 'current' | 'resolve' | 'onEnter' | 'onChange'> {
    places: Place[] = [];
    currentId: string | null = null;
    readonly enterListeners = new Set<(place: Place | null, previous: Place | null) => void>();

    add(id: string, name: string, extra: Partial<Place> = {}): Place {
        const place: Place = {
            id,
            name,
            aliases: [],
            forms: [],
            parent: null,
            createdAt: 0,
            firstSeen: 0,
            lastSeen: 0,
            visits: [],
            ...extra,
        };
        this.places.push(place);
        return place;
    }
    list(): Place[] {
        return this.places;
    }
    get(id: string): Place | undefined {
        return this.places.find((place) => place.id === id);
    }
    current(): Place | null {
        return this.currentId ? (this.get(this.currentId) ?? null) : null;
    }
    resolve(label: string): Place | undefined {
        const key = label.trim().toLowerCase();
        return this.places.find((place) => [place.name, ...place.aliases].some((name) => name.toLowerCase() === key));
    }
    onEnter(listener: (place: Place | null, previous: Place | null) => void): Unsubscribe {
        this.enterListeners.add(listener);
        return () => this.enterListeners.delete(listener);
    }
    onChange(): Unsubscribe {
        return () => {};
    }
    /** Moves to another place and tells the listeners. */
    enter(id: string | null): void {
        const previous = this.current();
        this.currentId = id;
        for (const listener of [...this.enterListeners]) listener(this.current(), previous);
    }
}

export interface CharacterSpec {
    name: string;
    details?: Record<string, string>;
    offScene?: boolean;
}

export interface TurnSpec {
    characters?: CharacterSpec[];
    location?: string;
    time?: string;
    weather?: string;
    date?: string;
    events?: string[];
    text?: string;
}

let sent = 0;

/** An assistant message with a DES tracker (characters and the scene) for swipe 0. */
export function reply(spec: TurnSpec = {}): STChatMessage {
    const characters = (spec.characters ?? []).map((character) => ({
        name: character.name,
        details: character.details ?? {},
        ...(character.offScene ? { present: false } : {}),
    }));
    const infoBox: Record<string, unknown> = {};
    if (spec.location) infoBox.location = { value: spec.location };
    if (spec.time) infoBox.time = { start: spec.time };
    if (spec.weather) infoBox.weather = { forecast: spec.weather };
    if (spec.date) infoBox.date = { value: spec.date };
    if (spec.events) infoBox.recentEvents = spec.events;
    return message(spec.text ?? 'История продолжается.', {
        send_date: `d${++sent}`,
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: null,
                    infoBox: Object.keys(infoBox).length ? JSON.stringify(infoBox) : null,
                    characterThoughts: JSON.stringify(characters),
                },
            ],
        },
    });
}

export function userMessage(text = 'Дальше'): STChatMessage {
    return message(text, { is_user: true, name: 'Алекс', send_date: `d${++sent}` });
}

export interface WardrobeEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    modules: FakeModules;
    ui: FakeUi & { tabs: PultTab[]; styles: Map<string, string>; checks: HealthCheck[] };
    leader: { value: boolean };
    slices: Record<string, Record<string, unknown>>;
    nai: FakeNai;
    naiPresent: { value: boolean };
    journal: FakeJournal;
    autonomy: LevelAutonomy;
    inbox: FakeInbox;
    revision: FakeRevision;
    places: FakePlaces;
    ephemeral: FakeEphemeral;
    llm: FakeLlm;
    tasks: FakeTasks;
    /** NAI Studio 0.14 portrait redraws asked for (DES names). */
    portraits: string[];
    /** DES as the adapter sees it: its per-character fields, the Workshop, saves. */
    des: FakeDes;
    desru: { present: boolean; settings: { modules: Record<string, Record<string, unknown>> } };
    core: { mode: string };
    logLines: LogLineRecord[];
    start(): Promise<WardrobeService>;
    stop(): Promise<void>;
    service(): WardrobeService;
    tick(ms?: number): Promise<void>;
    /** One turn: the reply is in the chat, the user answers, the reply is committed. Returns its index. */
    turn(spec?: TurnSpec): Promise<number>;
    /** The signals service's 'appearance.changed' for an outfit (already past the two-turn rule). */
    outfitSignal(
        name: string,
        to: string,
        options?: { from?: string; messageIndex?: number; entity?: string },
    ): Promise<void>;
    switchTo(chatId: string | undefined, chat?: STChatMessage[]): Promise<void>;
}

/** DES's tracker config through the adapter's methods (characterFields, addCharacterField, removeCharacterField). */
export class FakeDes {
    present = true;
    workshop = false;
    fields: { id: string; name: string; enabled: boolean; description: string; persistInHistory?: boolean }[] = [
        { id: 'appearance', name: 'Appearance', enabled: true, description: 'Visible physical appearance' },
        { id: 'demeanor', name: 'Demeanor', enabled: true, description: 'Observable demeanor' },
    ];
    saves = 0;
    characterFields() {
        return this.present ? this.fields.map((field) => ({ ...field })) : null;
    }
    addCharacterField(field: { id: string; name: string; description: string }) {
        if (!this.present) return null;
        const existing = this.fields.find((item) => item.id === field.id);
        this.saves++;
        if (existing) {
            const before = { ...existing };
            existing.enabled = true;
            return { before };
        }
        this.fields.push({ ...field, enabled: true, persistInHistory: false });
        return { before: null };
    }
    removeCharacterField(id: string, before: Record<string, unknown> | null = null) {
        if (!this.present) return false;
        const index = this.fields.findIndex((item) => item.id === id);
        if (index >= 0) {
            if (before) this.fields[index] = before as never;
            else this.fields.splice(index, 1);
        }
        this.saves++;
        return true;
    }
    isWorkshopOpen() {
        return this.workshop;
    }
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

/**
 * The chat of the tests: card «Anna» (Anna.png) with passport p-anna, the persona «Алекс» with p-alex, a chat-only
 * NPC «Boris» (p-boris), a location passport «Таверна» (loc-tavern) in the card.
 */
export function createWardrobeEnv(locale: 'en' | 'ru' = 'en'): WardrobeEnv {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    mock.context.name1 = 'Алекс';
    mock.context.name2 = 'Anna';
    (mock.context as unknown as { characters: STCharacter[] }).characters = [{ name: 'Anna', avatar: 'Anna.png' }];
    (mock.context as unknown as { characterId: number }).characterId = 0;
    const host = createTestHost(mock);
    const logLines: LogLineRecord[] = [];
    const log = createTestLogger(logLines);
    const i18n = createI18n(() => locale);
    i18n.register(CORE_STRINGS);
    i18n.register(WARDROBE_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const modules = new FakeModules();
    const revision = new FakeRevision();
    modules.expose('revision', revision);
    const places = new FakePlaces();
    modules.expose('places', places);
    modules.expose(
        'world',
        fakeWorld([
            { name: 'Anna', aliases: ['Анна'], passportId: 'p-anna', avatar: 'Anna.png' },
            { name: 'Алекс', persona: true, passportId: 'p-alex' },
        ]),
    );
    const nai = new FakeNai();
    nai.cards.set('Anna.png', [
        passport('p-anna', '', {
            slots: {
                base: '1girl, elf',
                hair: 'long silver hair',
                eyes: 'green eyes',
                body: '',
                skin: '',
                clothing: 'blue jeans, grey hoodie, sneakers',
                accessories: '',
                style: '',
            },
            outfits: [{ name: 'ballgown', tags: 'white ball gown, long gloves, tiara' }],
        }),
        passport('loc-tavern', 'Таверна', { kind: 'location', aliases: ['Tavern'], tags: 'tavern, wooden interior' }),
    ]);
    nai.persona = [passport('p-alex', '')];
    nai.chatOwn = [passport('p-boris', 'Boris', { aliases: ['Борис'] })];
    const naiPresent = { value: true };
    const leader = { value: true };
    const base = createFakeUi();
    const ui = Object.assign(base, {
        tabs: [] as PultTab[],
        styles: new Map<string, string>(),
        checks: [] as HealthCheck[],
    });
    ui.addHealthCheck = (check) => {
        ui.checks.push(check);
        return () => {
            ui.checks = ui.checks.filter((item) => item !== check);
        };
    };
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
    const slices: Record<string, Record<string, unknown>> = {};
    const portraits: string[] = [];
    const des = new FakeDes();
    const desru = {
        present: false,
        settings: { modules: { fixes: { enabled: true, fieldKeys: true } } as Record<string, Record<string, unknown>> },
    };
    const adapters = {
        des: adapter('des', {
            present: () => des.present,
            trackerFor: (index: number) => {
                const record = desSwipeRecord(mock.chat[index]);
                return record ? parseDesTracker(record) : null;
            },
            characterFields: () => des.characterFields(),
            addCharacterField: (field: { id: string; name: string; description: string }) =>
                des.addCharacterField(field),
            removeCharacterField: (id: string, before: Record<string, unknown> | null) =>
                des.removeCharacterField(id, before),
            isWorkshopOpen: () => des.isWorkshopOpen(),
        }),
        desru: adapter('desru', {
            present: () => desru.present,
            moduleEnabled: (module: string) => desru.settings.modules[module]?.enabled !== false,
            settings: () => desru.settings,
        }),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo'),
        qvink: adapter('qvink'),
        nai: adapter('nai', {
            api: () => (naiPresent.value ? nai : undefined),
            requestDesPortrait: async (name: string) => {
                portraits.push(name);
                return true;
            },
            chatPassports: (scope?: NaiPassportScope) =>
                naiPresent.value
                    ? nai
                          .passports(scope)
                          .map(readPassport)
                          .filter((item): item is NaiPassport => item !== null)
                    : [],
        }),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const bus = createBus(log);
    const journal = new FakeJournal();
    const autonomy = new LevelAutonomy(journal);
    const inbox = new FakeInbox();
    const ephemeral = new FakeEphemeral();
    const llm = new FakeLlm();
    const tasks = new FakeTasks();
    const core = { mode: 'balanced' };
    const app = {
        host,
        turn: new FakeTurn(),
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
        chat,
        leader: { isLeader: () => leader.value, onChange: () => () => {} },
        tasks,
        llm: llm as unknown as App['llm'],
        cost: { backgroundCapReached: () => false } as unknown as App['cost'],
        journal,
        autonomy: autonomy as unknown as App['autonomy'],
        inbox,
        ephemeral: ephemeral as unknown as App['ephemeral'],
        bus,
        ui,
        adapters,
        modules,
    } as App;

    let disposers: (Unsubscribe | (() => void | Promise<void>))[] = [];
    const tick = async (ms = 10) => {
        await vi.advanceTimersByTimeAsync(ms);
    };

    const env: WardrobeEnv = {
        app,
        mock,
        host,
        modules,
        ui,
        leader,
        slices,
        nai,
        naiPresent,
        journal,
        autonomy,
        inbox,
        revision,
        places,
        ephemeral,
        llm,
        tasks,
        portraits,
        des,
        desru,
        core,
        logLines,
        async start() {
            disposers = [];
            await wardrobeModule.init({
                app,
                settings: (slices.wardrobe ??= {}) as never,
                log,
                own: (dispose) => disposers.push(dispose),
            });
            await tick(50);
            return env.service();
        },
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            modules.apis.delete('wardrobe');
        },
        service() {
            const service = modules.api<WardrobeService>('wardrobe');
            if (!service) throw new Error('not started');
            return service;
        },
        tick,
        async turn(spec = {}) {
            mock.chat.push(reply(spec));
            const index = mock.chat.length - 1;
            mock.chat.push(userMessage());
            await bus.emit('turn:committed', { messageIndex: index });
            await tick(SETTLE);
            return index;
        },
        async outfitSignal(name, to, options = {}) {
            const signal: Signal = {
                kind: 'appearance.changed',
                chatId: mock.chatId ?? null,
                messageIndex: options.messageIndex ?? Math.max(0, mock.chat.length - 2),
                data: {
                    name,
                    changes: [
                        {
                            field: 'outfit',
                            aspect: 'outfit',
                            from: options.from ?? 'что-то другое',
                            to,
                            added: [],
                            removed: [],
                        },
                    ],
                },
                at: Date.now(),
            };
            if (options.entity) signal.entity = options.entity;
            await bus.emit('signal', signal);
            await tick(50);
        },
        async switchTo(chatId, messages = []) {
            mock.chat = messages;
            await switchChat(mock, chatId);
            await bus.emit('chat:changed', { chatId: chatId ?? null });
            await tick(50);
        },
    };
    return env;
}
