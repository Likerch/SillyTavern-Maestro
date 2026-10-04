// Test app for M8 «Ревизия»: the canon test app (ST mock with in-memory World Info, real settings, i18n, bus, files and
// chat store, recording journal/autonomy/UI, fake tasks) plus in-memory fakes of what the revision talks to: the
// chat canon, the world model, signals, contradictions, BunnyMo mode, places, NAI Studio's API, Qvink memories, CK,
// a recording Inbox and a scripted LLM.
import { vi } from 'vitest';
import type { NaiPassport, NaiPassportTarget, NaiSaveScope, NaiStudioApi } from '../../../src/adapters/nai';
import type { QvinkMemory } from '../../../src/adapters/qvink';
import { checkTags, tagVocabulary } from '../../../src/domain/bunnymo-mode-tags';
import type { BunnyMoModeApi, TagDictionary, TagInfo } from '../../../src/features/bunnymoMode/api';
import type { CanonApi, CanonDraft, CanonItem } from '../../../src/features/canon/api';
import type { Contradiction, ContradictionResult, ContradictionsApi } from '../../../src/features/contradictions/api';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import { RevisionRoutes } from '../../../src/features/revision/routes';
import { RevisionService } from '../../../src/features/revision/service';
import { defaultRevisionSettings, readRevisionSettings } from '../../../src/features/revision/settings';
import type { RevisionSettings } from '../../../src/features/revision/settings';
import { RevisionSources } from '../../../src/features/revision/sources';
import { REVISION_STRINGS } from '../../../src/features/revision/strings';
import type { Signal as BusSignal } from '../../../src/shared/contracts';
import type { SignalBatch, SignalsApi } from '../../../src/features/signals/api';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type {
    Inbox,
    InboxCard,
    LlmClient,
    LlmRequest,
    LlmResult,
    Proposal,
    SlashCommandSpec,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createCanonTestApp } from '../canon/helpers';
import type { CanonTestApp, Dict } from '../canon/helpers';

export { settle, startModule, wi } from '../canon/helpers';
export type { Dict } from '../canon/helpers';

export const CANON_BOOK = 'Maestro · канон · test';

/* ------------------------------------------------------------------ inbox, llm */

export class RecordingInbox implements Inbox {
    readonly added: Proposal[] = [];
    readonly appliers = new Map<
        string,
        { apply: (payload: unknown) => Promise<void>; valid?: (payload: unknown) => Promise<boolean> }
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

/** Answers from a script, one per request (the last one repeats). */
export class ScriptedLlm implements LlmClient {
    readonly requests: LlmRequest[] = [];
    script: LlmResult[] = [{ ok: true, data: { changes: [] }, costUsd: 0.001 }];
    ready = true;
    async request<T = unknown>(request: LlmRequest): Promise<LlmResult<T>> {
        this.requests.push(request);
        const next = this.script.length > 1 ? this.script.shift()! : this.script[0]!;
        return structuredClone(next) as LlmResult<T>;
    }
    available(): boolean {
        return this.ready;
    }
}

export function change(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        class: 'known',
        entity: 'Anna',
        target: 'canon.fact',
        field: '',
        value: 'Anna now lives in Paris.',
        before: '',
        evidence: 'Я теперь живу в Париже.',
        sourceMessage: 3,
        confidence: 0.9,
        ...fields,
    };
}

export function answer(...changes: Record<string, unknown>[]): LlmResult {
    return { ok: true, data: { changes }, costUsd: 0.002 };
}

/* ------------------------------------------------------------------ module fakes */

export class FakeCanon implements CanonApi {
    items: CanonItem[] = [];
    readonly puts: { draft: CanonDraft; uid?: number }[] = [];
    readonly removed: number[] = [];
    private next = 100;
    bookName(): string {
        return CANON_BOOK;
    }
    async ensureBook(): Promise<string> {
        return CANON_BOOK;
    }
    async list(): Promise<CanonItem[]> {
        return structuredClone(this.items);
    }
    async put(draft: CanonDraft, options?: { uid?: number }): Promise<number> {
        this.puts.push(
            options?.uid !== undefined
                ? { draft: structuredClone(draft), uid: options.uid }
                : { draft: structuredClone(draft) },
        );
        const now = Date.now();
        const existing =
            options?.uid !== undefined
                ? this.items.find((item) => item.uid === options.uid)
                : draft.meta.kind === 'override'
                  ? this.items.find(
                        (item) =>
                            item.meta.kind === 'override' &&
                            item.meta.base?.world === draft.meta.base?.world &&
                            item.meta.base?.uid === draft.meta.base?.uid,
                    )
                  : undefined;
        if (existing) {
            existing.entry = structuredClone(draft.entry);
            existing.meta = { ...structuredClone(draft.meta), createdAt: existing.meta.createdAt, updatedAt: now };
            return existing.uid;
        }
        const uid = this.next++;
        this.items.push({
            uid,
            entry: structuredClone(draft.entry),
            meta: { ...structuredClone(draft.meta), createdAt: now, updatedAt: now },
        });
        return uid;
    }
    async remove(uid: number): Promise<void> {
        this.removed.push(uid);
        this.items = this.items.filter((item) => item.uid !== uid);
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
        return /\p{Script=Cyrillic}/u.test(term) ? [term, `${term}у`] : [term];
    }
    onChange(): Unsubscribe {
        return () => {};
    }
    overrideOf(world: string, uid: number): CanonItem | undefined {
        return this.items.find(
            (item) => item.meta.kind === 'override' && item.meta.base?.world === world && item.meta.base.uid === uid,
        );
    }
}

export function entity(fields: Partial<Entity> & { name: string }): Entity {
    return {
        id: `character:${fields.name.toLowerCase()}`,
        kind: 'character',
        aliases: [],
        forms: [],
        sources: [],
        ...fields,
    };
}

export class FakeWorldModel implements WorldModelApi {
    list: Entity[] = [];
    aliases: Record<string, string> = {};
    readonly aliasCalls: [string, string | null][] = [];
    entities(): Entity[] {
        return this.list;
    }
    get(id: string): Entity | undefined {
        return this.list.find((item) => item.id === id);
    }
    resolve(name: string): Entity | undefined {
        const wanted = name.toLowerCase();
        return this.list.find((item) =>
            [item.name, ...item.aliases, ...item.forms].some((n) => n.toLowerCase() === wanted),
        );
    }
    mentions(text: string): Entity[] {
        const lower = text.toLowerCase();
        return this.list.filter((item) => [item.name, ...item.forms].some((n) => lower.includes(n.toLowerCase())));
    }
    facts() {
        return [];
    }
    async rebuild(): Promise<void> {}
    chatAliases(): Record<string, string> {
        return { ...this.aliases };
    }
    async setChatAlias(alias: string, entityId: string | null): Promise<void> {
        this.aliasCalls.push([alias, entityId]);
        if (entityId) this.aliases[alias] = entityId;
        else delete this.aliases[alias];
    }
    async merge(): Promise<void> {}
    async separate(): Promise<void> {}
    mergeCandidates() {
        return [];
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export class FakeSignals implements SignalsApi {
    pendingList: BusSignal[] = [];
    since = 0;
    consumed: number[] = [];
    readonly listeners = new Set<(batch: SignalBatch) => void>();
    pending(): BusSignal[] {
        return [...this.pendingList];
    }
    async consume(upTo: number): Promise<void> {
        this.consumed.push(upTo);
        this.pendingList = this.pendingList.filter((signal) => (signal.messageIndex ?? -1) > upTo);
        this.since = 0;
    }
    last(): SignalBatch | null {
        return null;
    }
    messagesSinceRevision(): number {
        return this.since;
    }
    onBatch(listener: (batch: SignalBatch) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(batch: SignalBatch): void {
        for (const listener of [...this.listeners]) listener(batch);
    }
}

export function signal(kind: string, messageIndex: number, entityName?: string): BusSignal {
    const item: BusSignal = { kind, chatId: 'Alice - 2026-10-04@12h00m00s', messageIndex, at: Date.now() };
    if (entityName) item.entity = entityName;
    return item;
}

export class FakeContradictions implements ContradictionsApi {
    result: ContradictionResult = { clean: true, askedAi: false, contradictions: [], costUsd: 0 };
    quickResult: Contradiction[] = [];
    readonly inputs: Parameters<ContradictionsApi['check']>[0][] = [];
    readonly quickInputs: Parameters<ContradictionsApi['quick']>[0][] = [];
    quick(input: Parameters<ContradictionsApi['quick']>[0]): Contradiction[] {
        this.quickInputs.push(structuredClone(input));
        return structuredClone(this.quickResult);
    }
    async check(input: Parameters<ContradictionsApi['check']>[0]): Promise<ContradictionResult> {
        this.inputs.push(structuredClone(input));
        return structuredClone(this.result);
    }
}

function tagInfo(tag: string, category: string, value: string | null): TagInfo {
    return {
        tag,
        category,
        value,
        entries: [{ book: 'Pack', uid: 1, kind: 'pull', comment: tag, chars: 10 }],
        usedBy: [],
        conflict: false,
        orphan: false,
        duplicate: false,
    };
}

/** BunnyMo mode with a small dictionary; validateTags runs the real checks against it. */
export function fakeBunnyMo(
    tags: [string, string, string | null][] = DEFAULT_TAGS,
): BunnyMoModeApi & { validated: string[][] } {
    const dictionary: TagDictionary = {
        builtAt: 0,
        categories: [],
        tags: tags.map(([tag, category, value]) => tagInfo(tag, category, value)),
    };
    const validated: string[][] = [];
    return {
        validated,
        dictionary: async () => dictionary,
        packs: async () => [],
        selection: () => ({ mode: 'all' }),
        setSelection: async () => {},
        diffWithFile: async () => ({ added: [], removed: [], changed: [] }),
        integrity: async () => [],
        readSheet: async () => null,
        validateTags: async (list) => {
            validated.push([...list]);
            return checkTags(list, tagVocabulary(dictionary as Parameters<typeof tagVocabulary>[0]));
        },
        saveSheet: async () => {},
        open: () => {},
        onChange: () => () => {},
    };
}

export const DEFAULT_TAGS: [string, string, string | null][] = [
    ['<TRAIT:BRAVE>', 'TRAIT', 'BRAVE'],
    ['<TRAIT:SHY>', 'TRAIT', 'SHY'],
    ['<DERE:DANDERE>', 'DERE', 'DANDERE'],
    ['<DERE:TSUNDERE>', 'DERE', 'TSUNDERE'],
    ['<INTJ-H>', 'MBTI', 'INTJ-H'],
    ['<INTJ-U>', 'MBTI', 'INTJ-U'],
];

export class FakePlaces implements Partial<PlacesApi> {
    places: Place[] = [];
    readonly updates: [string, Partial<Place>][] = [];
    list(): Place[] {
        return this.places;
    }
    get(id: string): Place | undefined {
        return this.places.find((place) => place.id === id);
    }
    resolve(label: string): Place | undefined {
        return this.places.find(
            (place) => place.name.toLowerCase() === label.toLowerCase() || place.aliases.includes(label),
        );
    }
    async update(id: string, patch: Partial<Place>): Promise<void> {
        this.updates.push([id, structuredClone(patch)]);
        const place = this.get(id);
        if (place) Object.assign(place, structuredClone(patch));
    }
}

export function place(fields: Partial<Place> & { id: string; name: string }): Place {
    return {
        aliases: [],
        forms: [],
        parent: null,
        createdAt: 0,
        firstSeen: 0,
        lastSeen: 0,
        visits: [],
        ...fields,
    };
}

export function passport(fields: Partial<NaiPassport> = {}): NaiPassport {
    return {
        id: 'p1',
        kind: 'character',
        name: '',
        aliases: [],
        tags: '',
        slots: { hair: 'long black hair', eyes: 'green eyes' },
        outfits: [],
        activeOutfit: '',
        states: [],
        negative: '',
        ...fields,
    };
}

export class FakeNai implements NaiStudioApi {
    readonly version = 1;
    readonly passportsById = new Map<string, NaiPassport>();
    readonly saved: { passport: NaiPassport; scope: NaiSaveScope; target?: NaiPassportTarget }[] = [];
    passports(): NaiPassport[] {
        return [...this.passportsById.values()].map((item) => structuredClone(item));
    }
    getPassport(id: string): NaiPassport | null {
        const found = this.passportsById.get(id);
        return found ? structuredClone(found) : null;
    }
    async savePassport(item: NaiPassport, scope: NaiSaveScope, target?: NaiPassportTarget): Promise<void> {
        this.saved.push(
            target ? { passport: structuredClone(item), scope, target } : { passport: structuredClone(item), scope },
        );
        this.passportsById.set(item.id, structuredClone(item));
    }
    async setOutfit(): Promise<void> {}
    async setState(): Promise<void> {}
    async clearChatOverride(): Promise<void> {}
    on(): () => void {
        return () => {};
    }
    registerSceneProvider(): () => void {
        return () => {};
    }
}

/* ------------------------------------------------------------------ the app */

export interface RevisionTestApp extends CanonTestApp {
    llm: ScriptedLlm;
    inboxRec: RecordingInbox;
    canon: FakeCanon;
    worldModel: FakeWorldModel;
    signals: FakeSignals;
    contradictions: FakeContradictions;
    bunnymo: ReturnType<typeof fakeBunnyMo>;
    places: FakePlaces;
    nai: FakeNai;
    memories: Map<number, QvinkMemory>;
    ckScans: string[][];
    capped: { value: boolean };
    slash: SlashCommandSpec[];
    busSignals: BusSignal[];
    chat: STChatMessage[];
}

export function message(name: string, mes: string, isUser = false, extra: Dict = {}): STChatMessage {
    return { name, is_user: isUser, is_system: false, send_date: '', mes, ...extra } as STChatMessage;
}

/** A chat where messages 0..4 are committed (4 is the user's last) and 5 is the reply in progress. */
export function defaultChat(): STChatMessage[] {
    return [
        message('Anna', 'Привет. Я Анна из Рима.'),
        message('User', 'Привет, Аня!', true),
        message('Anna', '```json\n{"characters": [{"name": "Anna"}]}\n```\nОна улыбается.'),
        message('Anna', 'Я теперь живу в Париже. <b>Навсегда.</b> [nai:img:abc]'),
        message('User', 'Здорово. Ты постриглась?', true),
        message('Anna', 'Черновик ответа, ещё не зафиксирован.'),
    ];
}

export function createRevisionTestApp(): RevisionTestApp {
    const env = createCanonTestApp();
    env.settings.registerModule('revision', defaultRevisionSettings, true);
    env.app.i18n.register(REVISION_STRINGS);
    const llm = new ScriptedLlm();
    const inboxRec = new RecordingInbox();
    const canon = new FakeCanon();
    const worldModel = new FakeWorldModel();
    const signals = new FakeSignals();
    const contradictions = new FakeContradictions();
    const bunnymo = fakeBunnyMo();
    const places = new FakePlaces();
    const nai = new FakeNai();
    const memories = new Map<number, QvinkMemory>();
    const ckScans: string[][] = [];
    const capped = { value: false };
    const slash: SlashCommandSpec[] = [];
    const busSignals: BusSignal[] = [];
    Object.assign(env.app, {
        llm,
        inbox: inboxRec,
        cost: {
            record() {},
            recordAnlas() {},
            summary: () => ({ todayUsd: 0, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0 }),
            backgroundCapReached: () => capped.value,
            onChange: () => () => {},
        },
    });
    Object.assign(env.app.adapters.qvink as unknown as Dict, {
        present: () => true,
        memoryOf: (index: number) => memories.get(index) ?? null,
    });
    Object.assign(env.app.adapters.nai as unknown as Dict, { api: () => nai });
    Object.assign(env.app.adapters.ck as unknown as Dict, {
        repoBooks: () => ['Repo'],
        kernel: () => ({ scanSelectedLorebooks: (names: string[]) => void ckScans.push(names) }),
    });
    env.ui.addSlashCommand = (spec) => {
        slash.push(spec);
        return () => {};
    };
    env.app.bus.on('signal', (item) => void busSignals.push(item));
    const apis = env.modules.apis;
    apis.set('canon', canon);
    apis.set('world', worldModel);
    apis.set('signals', signals);
    apis.set('contradictions', contradictions);
    apis.set('bunnymoMode', bunnymo);
    apis.set('places', places);
    const chat = defaultChat();
    env.mock.chat = chat;
    return Object.assign(env, {
        llm,
        inboxRec,
        canon,
        worldModel,
        signals,
        contradictions,
        bunnymo,
        places,
        nai,
        memories,
        ckScans,
        capped,
        slash,
        busSignals,
        chat,
    });
}

export function memory(text: string): QvinkMemory {
    return { memory: text, remember: false, exclude: false, include: 'short', lagging: false, edited: false };
}

export interface RevisionParts {
    sources: RevisionSources;
    routes: RevisionRoutes;
    service: RevisionService;
    settings: () => RevisionSettings;
    dispose(): void;
}

/** The module's parts wired like index.ts, with no settle delay. */
export function createRevision(env: RevisionTestApp): RevisionParts {
    const settings = () => readRevisionSettings(env.settings.module<Partial<RevisionSettings>>('revision'));
    const sources = new RevisionSources(env.app, env.log);
    const routes = new RevisionRoutes(env.app, sources, env.log, { checkTimeoutMs: 30 });
    const offs = [...routes.install()];
    const service = new RevisionService(env.app, sources, routes, settings, env.log, { settleMs: 0 });
    offs.push(...service.install());
    env.modules.apis.set('revision', service.api());
    return {
        sources,
        routes,
        service,
        settings,
        dispose: () => {
            for (const off of offs.reverse()) off();
        },
    };
}

/** Anna: a character with a lore entry, a CK archive and a NAI passport. */
export const ARCHIVE_CONTENT =
    '<BunnymoTags><Name:Anna>, <GENDER:FEMALE>, <Dere:TSUNDERE>, <TRAIT:SHY>, <INTJ-U></BunnymoTags>\n<Linguistics>Speaks softly.</Linguistics>';

export function seedAnna(env: RevisionTestApp): Entity {
    env.world.book('World', [
        {
            uid: 1,
            key: ['Anna', 'Анна'],
            keysecondary: [],
            comment: 'Anna',
            content: 'Anna is a painter. Anna lives in Rome.',
            disable: false,
        },
    ]);
    env.world.book('Repo', [
        { uid: 7, key: ['Anna'], keysecondary: [], comment: 'Anna Archive', content: ARCHIVE_CONTENT },
    ]);
    env.nai.passportsById.set('p1', passport());
    const anna = entity({
        name: 'Anna',
        aliases: ['Аня'],
        forms: ['Анна', 'Анны'],
        sources: [
            { kind: 'lore.entry', ref: 'World#1', label: 'Anna', world: 'World', uid: 1 },
            { kind: 'ck.archive', ref: 'Repo#7', label: 'Anna Archive', world: 'Repo', uid: 7 },
            { kind: 'nai.passport', ref: 'Alice.png#p1', label: 'Anna', passportId: 'p1', avatar: 'Alice.png' },
        ],
        present: true,
    });
    env.worldModel.list.push(anna);
    return anna;
}

export const flushTimers = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

export { vi };
