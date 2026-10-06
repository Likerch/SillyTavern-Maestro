// Test app for M37 «Подготовить к игре»: the ST mock with the stand's card «Хроники Серебряной Гавани», its world book
// «Velmar Reaches» and the CK archive book of the stand, real settings, i18n (Russian), files, chat store, bus and user
// jobs, a recording journal with undo, and fakes of the modules preparation writes through (canon, places, mechanics,
// knowledge, calendar, director, wardrobe, backgrounds, book roles) and of NAI Studio's API. The LLM answers through
// the mock LLM of the bench (tools/mock-llm), so its 'maestro_prepare' handler is checked against the real reader.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import type { NaiPassport, NaiPassportGenInput, NaiPassportScope, NaiStudioApi } from '../../../src/adapters/nai';
import { createBus } from '../../../src/core/bus';
import { createChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { createUserJobs } from '../../../src/core/jobs';
import { Settings } from '../../../src/core/settings';
import { CORE_STRINGS } from '../../../src/core/strings';
import { normName } from '../../../src/domain/dossier-names';
import { MECHANIC_TEMPLATES } from '../../../src/domain/mechanics-templates';
import type { BookRole, BookRoleInfo, BookRolesApi } from '../../../src/features/bookRoles/api';
import type { CalendarApi, StoryPromise } from '../../../src/features/calendar/api';
import type { CanonApi, CanonDraft, CanonItem } from '../../../src/features/canon/api';
import type { DirectorApi, SceneType } from '../../../src/features/director/api';
import type { KnowledgeApi, KnowledgeFact } from '../../../src/features/knowledge/api';
import type { AttributeValue, MechanicDef, MechanicsApi } from '../../../src/features/mechanics/api';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import { PrepareService } from '../../../src/features/prepare/service';
import { defaultPrepareSettings, readPrepareSettings } from '../../../src/features/prepare/settings';
import type { PrepareSettings } from '../../../src/features/prepare/settings';
import { PREPARE_STRINGS } from '../../../src/features/prepare/strings';
import type { WardrobeApi } from '../../../src/features/wardrobe/api';
import type { App, LlmRequest, LlmResult } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi, TestHost } from '../../helpers/core-host';
import { FakeJournal, FakeModules } from '../../helpers/rules-app';
import { installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';
import { analyseRequest, buildReply } from '../../../tools/mock-llm/scenarios.mjs';

type Dict = Record<string, unknown>;

const FIXTURES = resolve(__dirname, '../../../tools/fixtures');
export const WORLD = 'Velmar Reaches';
export const ARCHIVE = 'Архив персонажей (стенд)';
export const AVATAR = 'silver-harbor.png';

function json<T>(path: string): T {
    return JSON.parse(readFileSync(resolve(FIXTURES, path), 'utf8')) as T;
}

export function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** Lets the job, the file mock and the chat store finish. */
export async function settle(ms = 30): Promise<void> {
    const end = Date.now() + ms;
    do {
        await new Promise((next) => setImmediate(next));
    } while (Date.now() < end);
}

/* ------------------------------------------------------------------ fakes of the modules */

export class FakeCanon implements CanonApi {
    readonly books = new Map<string, CanonItem[]>();
    private next = 0;
    constructor(private readonly chatId: () => string) {}
    private items(): CanonItem[] {
        const name = this.bookName();
        if (!this.books.has(name)) this.books.set(name, []);
        return this.books.get(name)!;
    }
    bookName(chatId?: string): string {
        return `Maestro · канон · ${chatId ?? this.chatId()}`;
    }
    async ensureBook(): Promise<string> {
        return this.bookName();
    }
    async list(filter: { kind?: string } = {}): Promise<CanonItem[]> {
        return clone(this.items().filter((item) => !filter.kind || item.meta.kind === filter.kind));
    }
    async put(draft: CanonDraft, options: { uid?: number } = {}): Promise<number> {
        const uid = options.uid ?? this.next++;
        const items = this.items();
        const index = items.findIndex((item) => item.uid === uid);
        const item: CanonItem = {
            uid,
            meta: { ...clone(draft.meta), createdAt: 1, updatedAt: 1 },
            entry: { ...clone(draft.entry), uid },
        };
        if (index >= 0) items[index] = item;
        else items.push(item);
        return uid;
    }
    async remove(uid: number): Promise<void> {
        const items = this.items();
        const index = items.findIndex((item) => item.uid === uid);
        if (index >= 0) items.splice(index, 1);
    }
    async setStatus(): Promise<void> {}
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
        return [term, `${term.replace(/а$/, '')}ы`];
    }
    onChange() {
        return () => {};
    }
    /** Seeds an existing addition. */
    seed(entry: Dict, meta: Dict): number {
        const uid = this.next++;
        this.items().push({
            uid,
            meta: { kind: 'addition', status: 'active', origin: 'user', createdAt: 1, updatedAt: 1, ...meta } as never,
            entry: { ...entry, uid },
        });
        return uid;
    }
}

export class FakePlaces implements PlacesApi {
    places: Place[] = [];
    private next = 1;
    list(): Place[] {
        return clone(this.places);
    }
    get(id: string): Place | undefined {
        const place = this.places.find((item) => item.id === id);
        return place ? clone(place) : undefined;
    }
    current(): Place | null {
        return null;
    }
    resolve(label: string): Place | undefined {
        const wanted = normName(label);
        const place = this.places.find((item) =>
            [item.name, ...item.aliases, ...item.forms].some((name) => normName(name) === wanted),
        );
        return place ? clone(place) : undefined;
    }
    candidates() {
        return [];
    }
    async create(name: string, parent: string | null = null): Promise<Place> {
        const place: Place = {
            id: `p${this.next++}`,
            name,
            aliases: [],
            forms: [],
            parent,
            createdAt: 1,
            firstSeen: -1,
            lastSeen: -1,
            visits: [],
        };
        this.places.push(place);
        return clone(place);
    }
    async update(id: string, patch: Partial<Place>): Promise<void> {
        const place = this.places.find((item) => item.id === id);
        if (place) Object.assign(place, clone(patch));
    }
    async merge(): Promise<void> {}
    async remove(id: string): Promise<void> {
        this.places = this.places.filter((item) => item.id !== id);
    }
    async ensureEntry(): Promise<{ world: string; uid: number }> {
        return { world: '', uid: 0 };
    }
    onChange() {
        return () => {};
    }
    onEnter() {
        return () => {};
    }
}

export class FakeMechanics implements MechanicsApi {
    defs: MechanicDef[] = [];
    readonly values = new Map<string, AttributeValue>();
    list(): MechanicDef[] {
        return clone(this.defs);
    }
    active(): MechanicDef[] {
        return clone(this.defs);
    }
    get(id: string): MechanicDef | null {
        const def = this.defs.find((item) => item.id === id);
        return def ? clone(def) : null;
    }
    async save(def: MechanicDef): Promise<MechanicDef> {
        this.defs = [...this.defs.filter((item) => item.id !== def.id), clone(def)];
        return clone(def);
    }
    async remove(id: string): Promise<void> {
        this.defs = this.defs.filter((item) => item.id !== id);
        for (const key of [...this.values.keys()]) if (key.startsWith(`${id}|`)) this.values.delete(key);
    }
    templates() {
        return [...MECHANIC_TEMPLATES];
    }
    fromTemplate(): MechanicDef | null {
        return null;
    }
    async setEnabledInChat(): Promise<void> {}
    state() {
        return [];
    }
    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null {
        return this.values.get(`${mechanicId}|${holder}|${attribute}`) ?? null;
    }
    async set(mechanicId: string, holder: string, attribute: string, value: AttributeValue): Promise<void> {
        this.values.set(`${mechanicId}|${holder}|${attribute}`, value);
    }
    history() {
        return [];
    }
    async roll(): Promise<never> {
        throw new Error('no');
    }
    checks() {
        return [];
    }
    events() {
        return [];
    }
    onChange() {
        return () => {};
    }
}

export class FakeKnowledge implements KnowledgeApi {
    facts_: KnowledgeFact[] = [];
    private next = 1;
    constructor(private readonly journal: FakeJournal) {
        journal.registerUndo('knowledge.secret', async (change) => {
            this.facts_ = this.facts_.filter((fact) => fact.id !== (change.ref as Dict).factId);
            return true;
        });
    }
    facts(): KnowledgeFact[] {
        return clone(this.facts_);
    }
    unknownFor() {
        return [];
    }
    async markKnown(): Promise<void> {}
    async addSecret(fact: Omit<KnowledgeFact, 'id' | 'at' | 'secret'>): Promise<string> {
        const id = `f${this.next++}`;
        const stored: KnowledgeFact = { ...clone(fact), id, at: 1, secret: true };
        this.facts_.push(stored);
        await this.journal.record({
            module: 'M18',
            kind: 'knowledge.secret',
            summary: 'secret',
            changes: [{ target: 'knowledge.secret', ref: { factId: id }, before: null, after: stored }],
        });
        return id;
    }
    onChange() {
        return () => {};
    }
}

export class FakeCalendar implements CalendarApi {
    list: StoryPromise[] = [];
    now() {
        return null;
    }
    promises(): StoryPromise[] {
        return clone(this.list);
    }
    async add(promise: Omit<StoryPromise, 'id' | 'createdAt' | 'status'>): Promise<string> {
        const id = `pr${this.list.length + 1}`;
        this.list.push({ ...clone(promise), id, createdAt: 1, status: 'open' });
        return id;
    }
    async setStatus(id: string, status: StoryPromise['status']): Promise<void> {
        const promise = this.list.find((item) => item.id === id);
        if (promise) promise.status = status;
    }
    due() {
        return [];
    }
    onChange() {
        return () => {};
    }
}

export class FakeDirector implements DirectorApi {
    overrideType: SceneType | null = null;
    readonly calls: (SceneType | null)[] = [];
    scene() {
        return null;
    }
    async setScene(type: SceneType | null): Promise<void> {
        this.calls.push(type);
        this.overrideType = type;
    }
    override(): SceneType | null {
        return this.overrideType;
    }
    stall() {
        return { turns: 0, reasons: [] };
    }
    notes() {
        return [];
    }
    async nudge() {
        return null;
    }
    flags() {
        return {};
    }
    onChange() {
        return () => {};
    }
}

export class FakeWardrobe implements WardrobeApi {
    readonly intakes: Dict[] = [];
    constructor(private readonly journal: FakeJournal) {
        journal.registerUndo('wardrobe.outfit', async () => true);
    }
    outfits() {
        return [];
    }
    changes() {
        return [];
    }
    async wear(): Promise<void> {}
    onChange() {
        return () => {};
    }
    async intakeOutfit(statement: { entityName: string; value: string }): Promise<string | null> {
        this.intakes.push(clone(statement));
        await this.journal.record({
            module: 'M27',
            kind: 'wardrobe.outfit',
            summary: 'outfit',
            changes: [
                {
                    target: 'wardrobe.outfit',
                    ref: { name: statement.entityName },
                    before: null,
                    after: statement.value,
                },
            ],
        });
        return 'start';
    }
}

export class FakeRoles implements BookRolesApi {
    readonly roles = new Map<string, BookRole>();
    readonly set: [string, BookRole][] = [];
    roleOf(book: string): BookRoleInfo | undefined {
        const role = this.roles.get(book);
        return role
            ? { book, role, source: 'user', fingerprint: '', readOnly: role.startsWith('bunnymo'), localizable: true }
            : undefined;
    }
    all(): BookRoleInfo[] {
        return [...this.roles.keys()].map((book) => this.roleOf(book)!);
    }
    async setRole(book: string, role: BookRole): Promise<void> {
        this.set.push([book, role]);
        this.roles.set(book, role);
    }
    async refresh(): Promise<void> {}
    entryMeta() {
        return undefined;
    }
    async setEntryMeta(): Promise<void> {}
    onChange() {
        return () => {};
    }
}

/** NAI Studio API v1 over plain lists: card passports by avatar, the chat's own passports. */
export class FakeNai {
    card: NaiPassport[] = [];
    chat: NaiPassport[] = [];
    readonly saves: { id: string; scope: string; avatar?: string }[] = [];
    readonly generated: NaiPassportGenInput[] = [];
    generator = true;
    api(): NaiStudioApi {
        const passports = (scope?: NaiPassportScope) =>
            clone(scope?.avatar ? this.card : scope?.chat ? this.chat : [...this.card, ...this.chat]);
        const api = {
            version: 1,
            passports,
            getPassport: (id: string) => passports().find((item) => item.id === id) ?? null,
            savePassport: async (passport: NaiPassport, scope: 'card' | 'chat', target?: { avatar?: string }) => {
                this.saves.push({ id: passport.id, scope, ...(target?.avatar ? { avatar: target.avatar } : {}) });
                (scope === 'card' ? this.card : this.chat).push(clone(passport));
            },
            setOutfit: async () => {},
            setState: async () => {},
            clearChatOverride: async (id: string) => {
                this.chat = this.chat.filter((item) => item.id !== id);
            },
            on: () => () => {},
            registerSceneProvider: () => () => {},
            ...(this.generator
                ? {
                      generatePassport: async (input: NaiPassportGenInput): Promise<NaiPassport> => {
                          this.generated.push(clone(input));
                          return {
                              id: `gen-${this.generated.length}`,
                              kind: 'character',
                              name: input.name,
                              aliases: [],
                              tags: '',
                              slots: { base: '1girl' },
                              outfits: [],
                              activeOutfit: '',
                              states: [],
                              negative: '',
                          } as unknown as NaiPassport;
                      },
                  }
                : {}),
        };
        return api as unknown as NaiStudioApi;
    }
}

/* ------------------------------------------------------------------ the app */

export interface PrepareEnv {
    app: App;
    mock: StMock;
    host: TestHost;
    ui: FakeUi;
    journal: FakeJournal;
    modules: FakeModules;
    settings: Settings;
    books: Map<string, Dict>;
    canon: FakeCanon;
    places: FakePlaces;
    mechanics: FakeMechanics;
    knowledge: FakeKnowledge;
    calendar: FakeCalendar;
    director: FakeDirector;
    wardrobe: FakeWardrobe;
    roles: FakeRoles;
    nai: FakeNai;
    llm: { requests: LlmRequest[]; gate: Promise<void> | null; fail: boolean };
    prepareSettings(): PrepareSettings;
}

/** The stand's character card (a deep copy). */
export function standCharacter(): Dict {
    const card = json<Dict>('characters/silver-harbor.json');
    return { ...card, avatar: AVATAR };
}

export function greetingMessage(card: Dict): STChatMessage {
    return {
        name: String(card.name),
        is_user: false,
        is_system: false,
        send_date: '',
        mes: String((card.data as Dict).first_mes).replace(/\{\{user\}\}/g, 'Кай'),
        extra: {},
    } as STChatMessage;
}

export function createPrepareEnv(): PrepareEnv {
    const mock = installStMock();
    mock.chatId = 'chat-1';
    const card = standCharacter();
    const books = new Map<string, Dict>([
        [WORLD, json<Dict>(`worlds/${WORLD}.json`)],
        [ARCHIVE, json<Dict>(`worlds/${ARCHIVE}.json`)],
    ]);
    // A namesake from another story: its archive must not be read.
    const archive = books.get(ARCHIVE)!.entries as Dict;
    archive['99'] = {
        uid: 99,
        comment: 'Офелия Character Archive',
        key: ['Офелия'],
        content: '<BunnymoTags><Name:Офелия></BunnymoTags>',
    };
    Object.assign(mock.context, {
        characters: [card],
        characterId: 0,
        name1: 'Кай',
        powerUserSettings: { persona_description: 'Странствующий наёмник с северных перевалов.' },
        getWorldInfoNames: () => [...books.keys()],
        loadWorldInfo: async (name: string) => (books.has(name) ? clone(books.get(name)) : null),
        saveWorldInfo: async (name: string, data: unknown) => {
            books.set(name, clone(data as Dict));
        },
        updateWorldInfoList: async () => {},
        reloadWorldInfoEditor: () => {},
    });
    mock.chat.push(greetingMessage(card));
    const host = createTestHost(mock);
    const log = createTestLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        log,
    );
    settings.registerModule('prepare', defaultPrepareSettings, true);
    const i18n = createI18n(() => 'ru');
    i18n.register(CORE_STRINGS);
    i18n.register(PREPARE_STRINGS);
    const files = createFileStore(host, log);
    const chat = createChatStore(host, files, log, { metadataSaveDelayMs: 0 });
    const journal = new FakeJournal();
    const modules = new FakeModules();
    const ui = createFakeUi();
    const canon = new FakeCanon(() => mock.chatId ?? 'none');
    const places = new FakePlaces();
    const mechanics = new FakeMechanics();
    const knowledge = new FakeKnowledge(journal);
    const calendar = new FakeCalendar();
    const director = new FakeDirector();
    const wardrobe = new FakeWardrobe(journal);
    const roles = new FakeRoles();
    roles.roles.set(ARCHIVE, 'ck.archive');
    const nai = new FakeNai();
    for (const [key, api] of Object.entries({
        canon,
        places,
        mechanics,
        knowledge,
        calendar,
        director,
        wardrobe,
        bookRoles: roles,
        backgrounds: {
            candidates: async () => [
                { placeId: 'x', file: 'tavern-rain.jpg', variant: [], source: 'library', score: 1 },
            ],
        },
    })) {
        modules.expose(key, api);
    }
    const adapter = (id: string, extra: Dict = {}) => ({
        id,
        present: () => true,
        version: () => undefined,
        capabilities: () => [],
        ready: async () => {},
        ...extra,
    });
    const adapters = {
        des: adapter('des', { present: () => false, settings: () => ({ npcAvatars: { Вера: 'vera.png' } }) }),
        desru: adapter('desru'),
        ck: adapter('ck'),
        bunnymo: adapter('bunnymo', { books: () => ({ core: [], packs: [], archives: [ARCHIVE] }) }),
        qvink: adapter('qvink'),
        nai: adapter('nai', {
            api: () => nai.api(),
            chatPassports: () => nai.api().passports(),
            generatePassport: async (input: NaiPassportGenInput) => nai.api().generatePassport?.(input) ?? null,
            settings: () => ({}),
        }),
        localizer: adapter('localizer'),
        preset: adapter('preset'),
    } as unknown as App['adapters'];
    const llmState: PrepareEnv['llm'] = { requests: [], gate: null, fail: false };
    const llm = {
        available: () => true,
        request: vi.fn(async <T>(request: LlmRequest): Promise<LlmResult<T>> => {
            llmState.requests.push(request);
            if (llmState.gate) await llmState.gate;
            if (llmState.fail) return { ok: false, error: 'boom' };
            const body = {
                messages: request.messages,
                response_format: { type: 'json_schema', json_schema: request.schema },
            };
            const reply = buildReply(analyseRequest(body)) as { content: string };
            return { ok: true, data: JSON.parse(reply.content) as T, costUsd: 0.001 };
        }),
    };
    const app = {
        host,
        turn: { current: () => null } as unknown as App['turn'],
        log,
        i18n,
        settings,
        files,
        chat,
        leader: { isLeader: () => true, onChange: () => () => {} },
        tasks: {} as App['tasks'],
        jobs: createUserJobs({ log }),
        llm: llm as unknown as App['llm'],
        cost: {} as App['cost'],
        journal,
        autonomy: {} as App['autonomy'],
        inbox: {} as App['inbox'],
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
        ui,
        journal,
        modules,
        settings,
        books,
        canon,
        places,
        mechanics,
        knowledge,
        calendar,
        director,
        wardrobe,
        roles,
        nai,
        llm: llmState,
        prepareSettings: () => readPrepareSettings(settings.module<Partial<PrepareSettings>>('prepare')),
    };
}

export interface Started {
    service: PrepareService;
    stop(): void;
}

export function startPrepare(env: PrepareEnv): Started {
    const service = new PrepareService(env.app, env.app.log, env.prepareSettings);
    const offs = service.install();
    env.modules.expose('prepare', service.api());
    return {
        service,
        stop() {
            for (const off of offs.splice(0).reverse()) off();
        },
    };
}

/** Runs the analysis to its end. */
export async function analyse(
    service: PrepareService,
    options: { reuse?: boolean; force?: boolean } = {},
): Promise<void> {
    const key = await service.start(options);
    if (!key) throw new Error('not started');
    await service.whenDone();
    await settle(5);
}
