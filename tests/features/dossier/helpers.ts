// Test app for M7 «Досье»: the canon test app (ST mock with in-memory World Info, real settings, i18n, bus, files and
// chat store, recording journal/autonomy/UI) plus fakes of every neighbour the dossier reads (DES with trackers and
// settings, DES-RU API, CK with RAG, BunnyMo books, Qvink memories, NAI passports and API), a recording Inbox, a fake
// LLM and cost meter, and optional fakes of the world model and the place registry.
import type {
    NaiPassport,
    NaiPassportScope,
    NaiPassportsSavedDetail,
    NaiPassportTarget,
    NaiSaveScope,
    NaiStudioApi,
    QvinkMemory,
} from '../../../src/adapters';
import { readPassport } from '../../../src/adapters/nai';
import type { DesRuApi } from '../../../src/adapters/desru';
import type { DesCharacter, DesTrackerSnapshot } from '../../../src/domain/des-tracker';
import { dossierModule } from '../../../src/features/dossier';
import { defaultDossierSettings } from '../../../src/features/dossier/settings';
import { DOSSIER_STRINGS } from '../../../src/features/dossier/strings';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import type { Entity, MergeCandidate, WorldModelApi } from '../../../src/features/world/api';
import type {
    App,
    CostMeter,
    InboxCard,
    Inbox,
    LlmClient,
    LlmRequest,
    LlmResult,
    Proposal,
    SlashCommandSpec,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { FakeTasks } from '../../helpers/rules-app';
import { createCanonTestApp, settle, startModule } from '../canon/helpers';
import type { CanonTestApp, Dict } from '../canon/helpers';

export { settle, startModule, wi } from '../canon/helpers';
export type { Dict } from '../canon/helpers';

export interface DossierNeighbours {
    desPresent: boolean;
    desKnown: string[];
    desAliases: Record<string, string[]>;
    desSettings: Dict;
    trackers: Map<number, DesTrackerSnapshot>;
    desruApi: DesRuApi | undefined;
    ckPresent: boolean;
    ckRepos: string[];
    ckSettings: Dict;
    bunnyActive: string[];
    bunnyBooks: { core: string[]; packs: string[]; archives: string[] };
    qvinkPresent: boolean;
    memories: Map<number, QvinkMemory>;
    naiPresent: boolean;
    passports: Map<number, NaiPassport[]>;
    naiSettings: Dict;
    naiApi: NaiStudioApi | undefined;
}

export class RecordingInbox implements Inbox {
    readonly added: Proposal[] = [];
    readonly appliers = new Map<
        string,
        { apply: (p: unknown) => Promise<void>; valid?: (p: unknown) => Promise<boolean> }
    >();
    registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
    ): Unsubscribe {
        const entry = stillValid ? { apply, valid: stillValid } : { apply };
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

export class FakeLlm implements LlmClient {
    readonly requests: LlmRequest[] = [];
    result: LlmResult = { ok: true, data: { findings: [] }, costUsd: 0.0012 };
    ready = true;
    async request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
        this.requests.push(request);
        return this.result as LlmResult<T>;
    }
    available(): boolean {
        return this.ready;
    }
}

export function fakeCost(): CostMeter & { capped: boolean } {
    const meter = {
        capped: false,
        record() {},
        recordAnlas() {},
        summary: () => ({ todayUsd: 0.05, todayBySource: {}, backgroundTodayUsd: 0.02, anlasToday: 0 }),
        backgroundCapReached: () => meter.capped,
        onChange: () => () => {},
    };
    return meter;
}

export function tracker(characters: Partial<DesCharacter>[]): DesTrackerSnapshot {
    return {
        characters: characters.map((item) => ({
            name: item.name ?? '?',
            details: item.details ?? {},
            stats: item.stats ?? [],
            offScene: item.offScene ?? false,
            ...(item.emoji ? { emoji: item.emoji } : {}),
            ...(item.color ? { color: item.color } : {}),
            ...(item.relationship ? { relationship: item.relationship } : {}),
        })),
        infoBox: null,
        quests: null,
    };
}

export function passport(fields: Partial<NaiPassport> = {}): NaiPassport {
    return {
        id: 'p1',
        kind: 'character',
        name: '',
        aliases: [],
        tags: '',
        slots: {},
        outfits: [],
        activeOutfit: '',
        states: [],
        negative: '',
        ...fields,
    };
}

export function desRuApi(forms: Record<string, string[]>, key?: (name: string) => string | null): DesRuApi {
    return {
        version: 1,
        nameForms: (name) => forms[name] ?? [name],
        nameFormsKey: key ?? (() => null),
        aliases: () => ({}),
        onNamesChanged: () => () => {},
        functions: () => [],
        setMaestroOwned: () => {},
        maestroOwned: () => [],
    };
}

/**
 * NAI Studio API v1 over the fake cards: chat overrides live in `chat_metadata.nai_studio.passports` like NAI Studio
 * 0.10 keeps them (`overrides[id] = {owner, …changed fields}`, `extra` = the chat's own passports).
 */
export class FakeNaiApi implements NaiStudioApi {
    readonly version = 1;
    readonly saved: { passport: NaiPassport; scope: NaiSaveScope; target?: NaiPassportTarget }[] = [];
    readonly listeners = new Map<string, Set<(detail: never) => void>>();
    constructor(
        private readonly n: DossierNeighbours,
        private readonly chatMetadata: () => Record<string, unknown>,
    ) {}
    private store(): { overrides: Record<string, Dict>; extra: Dict[] } {
        const metadata = this.chatMetadata();
        const nai = (metadata.nai_studio ??= {}) as Dict;
        const store = (nai.passports ??= { overrides: {}, extra: [] }) as Dict;
        store.overrides ??= {};
        store.extra ??= [];
        return store as { overrides: Record<string, Dict>; extra: Dict[] };
    }
    private base(id: string): NaiPassport | null {
        for (const list of this.n.passports.values()) {
            const found = list.find((item) => item.id === id);
            if (found) return structuredClone(found);
        }
        const extra = this.store().extra.find((item) => item.id === id);
        return extra ? readPassport(extra) : null;
    }
    passports(scope?: NaiPassportScope): NaiPassport[] {
        const own = this.store()
            .extra.map(readPassport)
            .filter((item): item is NaiPassport => item !== null);
        if (scope?.chat) return own;
        const ids = [...this.n.passports.values()].flat().map((item) => item.id);
        return [...ids.map((id) => this.getPassport(id)!), ...own];
    }
    getPassport(id: string): NaiPassport | null {
        const base = this.base(id);
        if (!base) return null;
        const override = this.store().overrides[id];
        if (!override) return base;
        const { slots, ...rest } = override;
        delete rest.owner;
        return {
            ...base,
            ...rest,
            slots: { ...base.slots, ...((slots as Record<string, string>) ?? {}) },
        } as NaiPassport;
    }
    async savePassport(passport: NaiPassport, scope: NaiSaveScope, target?: NaiPassportTarget): Promise<void> {
        this.saved.push(
            target
                ? { passport: structuredClone(passport), scope, target }
                : { passport: structuredClone(passport), scope },
        );
        if (scope !== 'chat') return;
        const owner = target?.avatar ?? (target?.persona ? 'persona:' : undefined);
        this.store().overrides[passport.id] = {
            ...(owner ? { owner } : {}),
            aliases: [...passport.aliases],
            slots: { ...passport.slots },
        };
        this.emit('passportsSaved', { ids: [passport.id], scope });
    }
    async setOutfit(): Promise<void> {}
    async setState(): Promise<void> {}
    async clearChatOverride(passportId: string): Promise<void> {
        delete this.store().overrides[passportId];
    }
    on(event: string, listener: (detail: never) => void): () => void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return () => set.delete(listener);
    }
    emit(event: string, detail: unknown): void {
        for (const listener of this.listeners.get(event) ?? []) (listener as (value: unknown) => void)(detail);
    }
    registerSceneProvider(): () => void {
        return () => {};
    }
}

/** A world model over a fixed list of entities. */
export class FakeWorldModel implements WorldModelApi {
    readonly chatAliasMap: Record<string, string> = {};
    readonly listeners = new Set<() => void>();
    constructor(public list: Entity[]) {}
    entities(kind?: Entity['kind']): Entity[] {
        return kind ? this.list.filter((entity) => entity.kind === kind) : this.list;
    }
    get(id: string): Entity | undefined {
        return this.list.find((entity) => entity.id === id);
    }
    resolve(name: string): Entity | undefined {
        const wanted = name.trim().toLowerCase();
        return this.list.find((entity) =>
            [entity.name, ...entity.aliases, ...entity.forms].some((item) => item.toLowerCase() === wanted),
        );
    }
    mentions(text: string): Entity[] {
        return this.list.filter((entity) => entity.forms.some((form) => text.includes(form)));
    }
    facts() {
        return [];
    }
    async rebuild(): Promise<void> {}
    chatAliases(): Record<string, string> {
        return { ...this.chatAliasMap };
    }
    async setChatAlias(alias: string, entityId: string | null): Promise<void> {
        if (entityId) this.chatAliasMap[alias] = entityId;
        else delete this.chatAliasMap[alias];
    }
    async merge(): Promise<void> {}
    async separate(): Promise<void> {}
    mergeCandidates(): MergeCandidate[] {
        return [];
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/** A place registry over a fixed list. */
export class FakePlaces implements PlacesApi {
    readonly ensured: string[] = [];
    constructor(public places: Place[]) {}
    list(): Place[] {
        return this.places;
    }
    get(id: string): Place | undefined {
        return this.places.find((place) => place.id === id);
    }
    current(): Place | null {
        return null;
    }
    resolve(label: string): Place | undefined {
        return this.places.find((place) => place.name === label);
    }
    candidates() {
        return [];
    }
    async create(): Promise<Place> {
        throw new Error('not in tests');
    }
    async update(id: string, patch: Partial<Omit<Place, 'id' | 'visits'>>): Promise<void> {
        const place = this.get(id);
        if (place) Object.assign(place, patch);
    }
    async merge(): Promise<void> {}
    async remove(): Promise<void> {}
    async ensureEntry(id: string): Promise<{ world: string; uid: number }> {
        this.ensured.push(id);
        const place = this.get(id);
        if (place) place.entry = { world: 'Canon', uid: 77 };
        return { world: 'Canon', uid: 77 };
    }
    onChange(): Unsubscribe {
        return () => {};
    }
    onEnter(): Unsubscribe {
        return () => {};
    }
}

export function place(fields: Partial<Place> & { id: string; name: string }): Place {
    return {
        aliases: [],
        forms: [],
        parent: null,
        createdAt: 0,
        firstSeen: 1,
        lastSeen: 3,
        visits: [],
        ...fields,
    };
}

export interface DossierEnv extends CanonTestApp {
    n: DossierNeighbours;
    inbox2: RecordingInbox;
    llm: FakeLlm;
    cost: ReturnType<typeof fakeCost>;
    tasks: FakeTasks;
    slash: SlashCommandSpec[];
    opened: (string | undefined)[];
    closed: number;
    slashRuns: string[];
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

export function createDossierEnv(): DossierEnv {
    const env = createCanonTestApp();
    env.settings.registerModule('dossier', defaultDossierSettings, true);
    env.app.i18n.register(DOSSIER_STRINGS);
    const n: DossierNeighbours = {
        desPresent: true,
        desKnown: [],
        desAliases: {},
        desSettings: {},
        trackers: new Map(),
        desruApi: undefined,
        ckPresent: false,
        ckRepos: [],
        ckSettings: {},
        bunnyActive: [],
        bunnyBooks: { core: [], packs: [], archives: [] },
        qvinkPresent: false,
        memories: new Map(),
        naiPresent: false,
        passports: new Map(),
        naiSettings: {},
        naiApi: undefined,
    };
    const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null;
    env.app.adapters = {
        des: adapter('des', {
            present: () => n.desPresent,
            knownCharacters: () => [...n.desKnown],
            aliases: () => structuredClone(n.desAliases),
            trackerFor: (index: number) => n.trackers.get(index) ?? null,
            settings: () => n.desSettings,
            invalidateLoreCache: () => {},
        }),
        desru: adapter('desru', { api: () => n.desruApi }),
        ck: adapter('ck', {
            present: () => n.ckPresent,
            repoBooks: () => [...n.ckRepos],
            ragEnabled: () => isDict(n.ckSettings.rag) && (n.ckSettings.rag as Dict).enabled === true,
            settings: () => n.ckSettings,
        }),
        bunnymo: adapter('bunnymo', {
            activeBooks: async () => [...n.bunnyActive],
            books: () => structuredClone(n.bunnyBooks),
        }),
        qvink: adapter('qvink', {
            present: () => n.qvinkPresent,
            memoryOf: (index: number) => n.memories.get(index) ?? null,
        }),
        nai: adapter('nai', {
            present: () => n.naiPresent,
            passportsOf: (index: number) => structuredClone(n.passports.get(index) ?? []),
            settings: () => n.naiSettings,
            api: () => n.naiApi,
            chatPassports: (scope?: NaiPassportScope) => n.naiApi?.passports(scope) ?? [],
            on: (event: 'passportsSaved', listener: (detail: NaiPassportsSavedDetail) => void) =>
                n.naiApi ? n.naiApi.on(event, listener) : () => {},
        }),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const inbox2 = new RecordingInbox();
    const llm = new FakeLlm();
    const cost = fakeCost();
    const tasks = new FakeTasks();
    env.app.inbox = inbox2;
    env.app.llm = llm;
    env.app.cost = cost;
    env.app.tasks = tasks;
    const extra = {
        slash: [] as SlashCommandSpec[],
        opened: [] as (string | undefined)[],
        closed: 0,
        slashRuns: [] as string[],
    };
    env.ui.addSlashCommand = (command) => {
        extra.slash.push(command);
        return () => {
            extra.slash = extra.slash.filter((item) => item !== command);
        };
    };
    env.ui.openPult = (tab) => void extra.opened.push(tab);
    env.ui.closePult = () => void extra.closed++;
    Object.assign(env.mock.context as unknown as Dict, {
        executeSlashCommandsWithOptions: async (text: string) => {
            extra.slashRuns.push(text);
            return {};
        },
    });
    const result = Object.assign(env, { n, inbox2, llm, cost, tasks }) as DossierEnv;
    return Object.defineProperties(result, {
        slash: { get: () => extra.slash },
        opened: { get: () => extra.opened },
        closed: { get: () => extra.closed },
        slashRuns: { get: () => extra.slashRuns },
    });
}

export async function startDossier(env: DossierEnv) {
    const started = await startModule(env, dossierModule);
    await settle();
    return started;
}

/** The ST mock's characters list (writable in tests). */
export function setCharacters(env: DossierEnv, characters: STCharacter[], characterId = 0): void {
    Object.assign(env.mock.context as unknown as Dict, { characters, characterId });
}
