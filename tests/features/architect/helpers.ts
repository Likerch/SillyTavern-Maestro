// Test app for M20 «Архитектор промпта»: the M22 test app (ST mock, real settings, i18n, bus, recording journal and
// autonomy) with the real rules engine started, an in-memory chat store, a recording fetch gate and small fakes of
// the world model, places, canon, book roles and the lore journal. The architect service is started the way its
// module does it, with a handle kept for the tests.
import { ARCHITECT_STRINGS } from '../../../src/features/architect/strings';
import { defaultArchitectSettings } from '../../../src/features/architect/settings';
import { ArchitectService } from '../../../src/features/architect/service';
import type { ArchitectApi } from '../../../src/features/architect/api';
import type { BookRole, BookRoleInfo, BookRolesApi } from '../../../src/features/bookRoles/api';
import type { CanonApi, CanonItem } from '../../../src/features/canon/api';
import type { LoreJournalApi, TurnLoreRecord } from '../../../src/features/loreJournal/api';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import type { Entity, EntityKind, EntitySource, WorldModelApi } from '../../../src/features/world/api';
import type { FetchGate, Unsubscribe } from '../../../src/shared/contracts';
import { MemoryChatStore } from '../../helpers/lore-app';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import type { StartedRules } from '../../helpers/rules-module';
import { EVENT_TYPES, message } from '../../helpers/st-mock';
import { runScan } from '../../helpers/rules-wi';
import type { ScanResult, WiBook } from '../../helpers/rules-wi';

export const CANON_BOOK = 'Maestro · канон · c1';

function norm(text: string): string {
    return text.toLowerCase().replace(/ё/g, 'е').trim();
}

/* ------------------------------------------------------------------ world model */

export interface EntitySpec {
    id: string;
    kind: EntityKind;
    name: string;
    aliases?: string[];
    present?: boolean;
    /** In the DES roster (a 'des.character' source). */
    roster?: boolean;
    /** Lore entries attached to the entity (`world#uid`). */
    entries?: string[];
}

export class FakeWorld implements WorldModelApi {
    private list: Entity[];
    private readonly listeners = new Set<() => void>();
    calls = { entities: 0, resolve: 0, mentions: 0 };

    constructor(specs: EntitySpec[]) {
        this.list = specs.map((spec) => this.entity(spec));
    }

    private entity(spec: EntitySpec): Entity {
        const sources: EntitySource[] = [];
        if (spec.roster) sources.push({ kind: 'des.character', ref: spec.name, label: spec.name });
        for (const ref of spec.entries ?? []) {
            const [world, uid] = ref.split('#');
            sources.push({ kind: 'lore.entry', ref, label: ref, world, uid: Number(uid) });
        }
        const entity: Entity = {
            id: spec.id,
            kind: spec.kind,
            name: spec.name,
            aliases: spec.aliases ?? [],
            forms: [],
            sources,
        };
        if (spec.present !== undefined) entity.present = spec.present;
        return entity;
    }

    set(specs: EntitySpec[]): void {
        this.list = specs.map((spec) => this.entity(spec));
        for (const listener of [...this.listeners]) listener();
    }

    entities(kind?: EntityKind): Entity[] {
        this.calls.entities++;
        return this.list.filter((entity) => !kind || entity.kind === kind).map((entity) => structuredClone(entity));
    }
    get(id: string): Entity | undefined {
        return this.list.find((entity) => entity.id === id);
    }
    resolve(name: string, kind?: EntityKind): Entity | undefined {
        this.calls.resolve++;
        const key = norm(name);
        return this.list.find(
            (entity) =>
                (!kind || entity.kind === kind) && [entity.name, ...entity.aliases].some((item) => norm(item) === key),
        );
    }
    mentions(text: string): Entity[] {
        this.calls.mentions++;
        const lower = norm(text);
        return this.list.filter((entity) =>
            [entity.name, ...entity.aliases].some((item) => lower.includes(norm(item))),
        );
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
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

/* ------------------------------------------------------------------ places */

export class FakePlaces implements Partial<PlacesApi> {
    private readonly listeners = new Set<() => void>();
    currentId: string | null = null;

    constructor(public places: Place[]) {}

    list(): Place[] {
        return this.places.map((place) => ({ ...place }));
    }
    get(id: string): Place | undefined {
        return this.places.find((place) => place.id === id);
    }
    current(): Place | null {
        return this.places.find((place) => place.id === this.currentId) ?? null;
    }
    enter(id: string | null): void {
        this.currentId = id;
        for (const listener of [...this.listeners]) listener();
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onEnter(): Unsubscribe {
        return () => {};
    }
}

export function place(id: string, name: string, parent: string | null, entry?: { world: string; uid: number }): Place {
    return {
        id,
        name,
        aliases: [],
        forms: [],
        parent,
        createdAt: 0,
        firstSeen: 0,
        lastSeen: 0,
        visits: [],
        ...(entry ? { entry } : {}),
    };
}

/* ------------------------------------------------------------------ canon, roles, lore journal */

export class FakeCanon implements Partial<CanonApi> {
    pins: { world: string; uid: number }[] = [];
    bookName(): string {
        return CANON_BOOK;
    }
    async list(): Promise<CanonItem[]> {
        return this.pins.map((base, index) => ({
            uid: index + 1,
            entry: {},
            meta: {
                kind: 'pin',
                status: 'active',
                origin: 'user',
                base: { ...base, contentHash: '' },
                createdAt: 0,
                updatedAt: 0,
            },
        }));
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export class FakeRoles implements Partial<BookRolesApi> {
    roles: Record<string, BookRole> = {};
    meta: Record<string, Record<string, unknown>> = {};
    roleOf(book: string): BookRoleInfo | undefined {
        const role = this.roles[book];
        return role ? { book, role, source: 'user', fingerprint: '', readOnly: false, localizable: true } : undefined;
    }
    entryMeta<T = Record<string, unknown>>(book: string, uid: number): T | undefined {
        return this.meta[`${book}#${uid}`] as T | undefined;
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export class RecordingLoreJournal implements Partial<LoreJournalApi> {
    cuts: string[] = [];
    simulatingNow = false;
    markCut(world: string, uid: number): void {
        this.cuts.push(`${world}.${uid}`);
    }
    simulating(): boolean {
        return this.simulatingNow;
    }
    suspendedRules(): string[] {
        return [];
    }
    turns(): TurnLoreRecord[] {
        return [];
    }
    last(): TurnLoreRecord | undefined {
        return undefined;
    }
}

/* ------------------------------------------------------------------ fetch gate */

type BeforeHook = Parameters<FetchGate['beforeRequest']>[1];
type AfterHook = Parameters<FetchGate['afterResponse']>[1];

export class RecordingGate implements FetchGate {
    before: { match: RegExp; hook: BeforeHook }[] = [];
    after: { match: RegExp; hook: AfterHook }[] = [];
    beforeRequest(match: RegExp, hook: BeforeHook): Unsubscribe {
        const item = { match, hook };
        this.before.push(item);
        return () => {
            this.before = this.before.filter((other) => other !== item);
        };
    }
    afterResponse(match: RegExp, hook: AfterHook): Unsubscribe {
        const item = { match, hook };
        this.after.push(item);
        return () => {
            this.after = this.after.filter((other) => other !== item);
        };
    }
    /** Runs the hooks of one request/response pair the way the real gate does. */
    async send(url: string, init: RequestInit, response: Response): Promise<void> {
        for (const { match, hook } of this.before) if (match.test(url)) await hook(url, init);
        for (const { match, hook } of this.after) if (match.test(url)) hook(url, response.clone(), init);
    }
}

/* ------------------------------------------------------------------ the app */

export interface ArchitectTestApp {
    env: RulesTestApp;
    rules: StartedRules;
    service: ArchitectService;
    api: ArchitectApi;
    world: FakeWorld;
    places: FakePlaces;
    canon: FakeCanon;
    roles: FakeRoles;
    lore: RecordingLoreJournal;
    gate: RecordingGate;
    store: MemoryChatStore;
    stop(): Promise<void>;
}

export async function startArchitect(
    options: { world?: EntitySpec[]; places?: Place[] } = {},
): Promise<ArchitectTestApp> {
    const env = createRulesTestApp({ firstRunDone: true });
    env.settings.registerModule('architect', defaultArchitectSettings, true);
    env.app.i18n.register(ARCHITECT_STRINGS);
    const store = new MemoryChatStore(() => env.mock.chatId ?? null);
    (env.app as { chat: unknown }).chat = store;
    const gate = new RecordingGate();
    env.host.fetchGate = gate;
    const world = new FakeWorld(options.world ?? []);
    const places = new FakePlaces(options.places ?? []);
    const canon = new FakeCanon();
    const roles = new FakeRoles();
    const lore = new RecordingLoreJournal();
    env.modules.expose('world', world);
    env.modules.expose('places', places);
    env.modules.expose('canon', canon);
    env.modules.expose('bookRoles', roles);
    env.modules.expose('loreJournal', lore);
    (env.mock.context as unknown as Record<string, unknown>).extensionPrompts = {};
    const rules = await startRules(env);
    const disposers: (() => void | Promise<void>)[] = [];
    const service = new ArchitectService(env.app, env.log);
    service.install((dispose) => disposers.push(dispose));
    env.modules.expose('architect', service.api());
    const api = env.modules.api<ArchitectApi>('architect') as ArchitectApi;
    const result: ArchitectTestApp = {
        env,
        rules,
        service,
        api,
        world,
        places,
        canon,
        roles,
        lore,
        gate,
        store,
        async stop() {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
            await result.rules.stop();
        },
    };
    return result;
}

/** Settings slice of the architect (live object). */
export function architectSettings(app: ArchitectTestApp) {
    return app.service.settings();
}

/** A committed assistant reply with a DES tracker listing these characters (`!name` = off-scene). */
export function trackerReply(text: string, characters: string[]): STChatMessage {
    const list = characters.map((name) => (name.startsWith('!') ? { name: name.slice(1), present: false } : { name }));
    return message(text, {
        extra: {
            dooms_tracker_swipes: [{ characterThoughts: JSON.stringify(list), quests: null, infoBox: null }],
        },
    });
}

export function userMessage(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'User' });
}

export function setPrompts(
    app: ArchitectTestApp,
    prompts: Record<string, { value: string; position?: number; depth?: number; role?: number }>,
): void {
    const full: Record<string, { value: string; position: number; depth: number; scan: boolean; role: number }> = {};
    for (const [key, prompt] of Object.entries(prompts)) {
        full[key] = {
            value: prompt.value,
            position: prompt.position ?? 1,
            depth: prompt.depth ?? 0,
            scan: false,
            role: prompt.role ?? 0,
        };
    }
    (app.env.mock.context as unknown as Record<string, unknown>).extensionPrompts = full;
}

export async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

export interface TurnInput {
    books: WiBook[];
    chatText: string;
    messages: { role: string; content: unknown }[];
}

/**
 * One generation the way ST runs it: generation:before (Maestro's interceptor), the WI scan with its events, the
 * final activations, PROMPT_READY with the given messages; then the timer that builds the report.
 */
export async function runTurn(
    app: ArchitectTestApp,
    input: TurnInput,
): Promise<{ scan: ScanResult; messages: { role: string; content: unknown }[] }> {
    const { env } = app;
    await env.app.bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
    const scan = await runScan(env.mock, input.books, input.chatText);
    await env.mock.eventSource.emit(EVENT_TYPES.WORLD_INFO_ACTIVATED!, [...scan.activated.values()]);
    const messages = input.messages;
    await env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, { chat: messages, dryRun: false });
    await tick();
    return { scan, messages };
}
