// Test app for M28: real i18n and bus; the Lore Studio form harness's in-memory LoreStore and bookRoles fakes; ST's
// World Info functions over an in-memory map (the path without the Lore Studio); recording fakes of the journal,
// tasks, LLM, UI, lore journal, world model and the NAI adapter (with or without NAI Studio 0.12.0 members).
import { vi } from 'vitest';
import { createBus } from '../../../src/core/bus';
import { createI18n } from '../../../src/core/i18n';
import type { LoreActivation, LoreJournalApi, TurnLoreRecord } from '../../../src/features/loreJournal/api';
import { lorePassportsModule } from '../../../src/features/lorePassports';
import { LORE_PASSPORTS_STRINGS } from '../../../src/features/lorePassports/strings';
import { LorePassportsService, defaultLorePassportsSettings } from '../../../src/features/lorePassports/service';
import type { LorePassportsSettings } from '../../../src/features/lorePassports/service';
import type { WiEntry } from '../../../src/features/loreStudio/store-api';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type { App, LlmRequest, LlmResult, PultTab, Unsubscribe } from '../../../src/shared/contracts';
import { memoryLogger } from '../../helpers/host-fakes';
import { FakeJournal, FakeTasks } from '../../helpers/rules-app';
import { FakeRoles, FakeStore, entry, role } from '../loreStudio/form/harness';

export { entry, role, FakeRoles, FakeStore };

export async function settle(rounds = 6): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export interface FakeNai {
    present(): boolean;
    api?(): unknown;
    registerPassportProvider?: ReturnType<typeof vi.fn>;
    generatePassport?: ReturnType<typeof vi.fn>;
    providers: { id: string; priority?: number; passports(context: unknown): unknown }[];
    unregistered: number;
    apiObject: unknown;
}

export function fakeNai(options: { provider?: boolean; generator?: boolean; api?: boolean } = {}): FakeNai {
    const nai: FakeNai = {
        present: () => true,
        providers: [],
        unregistered: 0,
        apiObject: options.api === false ? undefined : { version: 1 },
    };
    nai.api = () => nai.apiObject;
    if (options.provider !== false) {
        nai.registerPassportProvider = vi.fn((provider: FakeNai['providers'][number]) => {
            nai.providers.push(provider);
            return () => {
                nai.unregistered++;
                const index = nai.providers.indexOf(provider);
                if (index >= 0) nai.providers.splice(index, 1);
            };
        });
    }
    if (options.generator) {
        nai.generatePassport = vi.fn(async (input: { name: string; kind: string }) => ({
            id: 'nai-1',
            kind: input.kind,
            name: input.name,
            aliases: ['Анна'],
            tags: '',
            slots: { base: '1girl, Elf', hair: 'silver_hair', eyes: 'green eyes' },
            outfits: [],
            activeOutfit: '',
            states: [],
            negative: '',
        }));
    }
    return nai;
}

export class FakeLoreJournal implements Partial<LoreJournalApi> {
    records: TurnLoreRecord[] = [];
    turns(): TurnLoreRecord[] {
        return this.records;
    }
    last(): TurnLoreRecord | undefined {
        return this.records[this.records.length - 1];
    }
    push(messageIndex: number, activations: Partial<LoreActivation>[]): void {
        this.records.push({
            messageIndex,
            at: 1,
            generationType: 'normal',
            activations: activations.map((item) => ({
                world: 'World',
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
            totalChars: 10,
            totalTokens: 3,
            overflow: false,
        });
    }
}

export class FakeWorld implements Partial<WorldModelApi> {
    list: Entity[] = [];
    /** `book#uid` of a namesake's entries (plan-2 §9): kept out of this chat. */
    foreign: string[] = [];
    foreignRefs(): string[] {
        return [...this.foreign];
    }
    mentions(text: string): Entity[] {
        const lower = text.toLowerCase();
        return this.list.filter((entity) =>
            [entity.name, ...entity.aliases, ...entity.forms].some((name) => lower.includes(name.toLowerCase())),
        );
    }
    entities(): Entity[] {
        return this.list;
    }
    add(entity: Partial<Entity> & { name: string }): void {
        this.list.push({
            id: `character:${entity.name}`,
            kind: 'character',
            aliases: [],
            forms: [],
            sources: [],
            ...entity,
        });
    }
}

export interface Env {
    app: App;
    store: FakeStore;
    roles: FakeRoles;
    /** World Info for the path without the Lore Studio (ctx.loadWorldInfo / saveWorldInfo). */
    books: Map<string, { entries: Record<string, Record<string, unknown>> }>;
    saves: string[];
    journal: FakeJournal;
    tasks: FakeTasks;
    llm: { available: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
    confirm: ReturnType<typeof vi.fn>;
    notice: ReturnType<typeof vi.fn>;
    tabs: PultTab[];
    apis: Map<string, unknown>;
    nai: FakeNai;
    des: { invalidateLoreCache: ReturnType<typeof vi.fn> };
    bunnymo: { core: string[]; packs: string[]; archives: string[] };
    loreJournal: FakeLoreJournal;
    world: FakeWorld;
    settings: LorePassportsSettings;
    state: { chatId: string | null; leader: boolean; group: boolean; cap: boolean };
    chat: { mes: string; is_user: boolean; is_system: boolean; name: string; send_date: string }[];
    handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
    log: ReturnType<typeof memoryLogger>;
    service(): LorePassportsService;
    emitEvent(name: string, ...args: unknown[]): Promise<void>;
    start(): Promise<{ stop(): Promise<void> }>;
}

export interface EnvOptions {
    nai?: FakeNai;
    /** Register the LoreStore as 'loreStore' (default true). */
    store?: boolean;
    /** Register the roles fake as 'bookRoles' (default true). */
    roles?: boolean;
}

export function createEnv(options: EnvOptions = {}): Env {
    const i18n = createI18n(() => 'en');
    i18n.register(LORE_PASSPORTS_STRINGS);
    const log = memoryLogger();
    const store = new FakeStore();
    const roles = new FakeRoles();
    const apis = new Map<string, unknown>();
    const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
    const books = new Map<string, { entries: Record<string, Record<string, unknown>> }>();
    const saves: string[] = [];
    const journal = new FakeJournal();
    const tasks = new FakeTasks();
    const llm = {
        available: vi.fn(() => true),
        request: vi.fn(async (...args: [LlmRequest]): Promise<LlmResult> => ({
            ok: false,
            error: `not set: ${args.length}`,
        })),
    };
    const confirm = vi.fn(async () => true);
    const notice = vi.fn();
    const tabs: PultTab[] = [];
    const nai = options.nai ?? fakeNai({ provider: false });
    const des = { invalidateLoreCache: vi.fn() };
    const bunnymo = { core: [] as string[], packs: [] as string[], archives: [] as string[] };
    const loreJournal = new FakeLoreJournal();
    const world = new FakeWorld();
    const settings = defaultLorePassportsSettings();
    const state = { chatId: 'chat1' as string | null, leader: true, group: false, cap: false };
    const chat: Env['chat'] = [];
    if (options.store !== false) apis.set('loreStore', store);
    if (options.roles !== false) apis.set('bookRoles', roles);
    apis.set('loreJournal', loreJournal);
    apis.set('world', world);
    const ctx = {
        get chat() {
            return chat;
        },
        loadWorldInfo: async (name: string) => books.get(name) ?? null,
        saveWorldInfo: async (name: string, data: { entries: Record<string, Record<string, unknown>> }) => {
            saves.push(name);
            books.set(name, structuredClone(data));
        },
        reloadWorldInfoEditor: vi.fn(),
    };
    const bus = createBus(log);
    const app = {
        i18n,
        log,
        bus,
        journal,
        tasks,
        llm,
        cost: { backgroundCapReached: () => state.cap },
        leader: { isLeader: () => state.leader },
        host: {
            ctx: () => ctx,
            chatId: () => state.chatId,
            isGroupChat: () => state.group,
            events: {
                name: (key: string) => key,
                on: (name: string, handler: (...args: unknown[]) => unknown) => {
                    const list = handlers.get(name) ?? [];
                    list.push(handler);
                    handlers.set(name, list);
                    return () => {
                        const current = handlers.get(name) ?? [];
                        handlers.set(
                            name,
                            current.filter((item) => item !== handler),
                        );
                    };
                },
            },
        },
        ui: {
            confirm,
            notice,
            addTab(tab: PultTab): Unsubscribe {
                tabs.push(tab);
                return () => {
                    const index = tabs.indexOf(tab);
                    if (index >= 0) tabs.splice(index, 1);
                };
            },
            style: () => () => {},
            closePult: vi.fn(),
            openPult: vi.fn(),
        },
        settings: {
            module: () => settings,
            notify: vi.fn(),
            save: vi.fn(),
        },
        modules: {
            api: <T>(key: string) => apis.get(key) as T | undefined,
            expose: (key: string, api: unknown) => {
                if (api === undefined) apis.delete(key);
                else apis.set(key, api);
            },
        },
        adapters: { nai, des, bunnymo: { books: () => bunnymo } },
    } as unknown as App;
    let service: LorePassportsService | null = null;
    const env: Env = {
        app,
        store,
        roles,
        books,
        saves,
        journal,
        tasks,
        llm,
        confirm,
        notice,
        tabs,
        apis,
        nai,
        des,
        bunnymo,
        loreJournal,
        world,
        settings,
        state,
        chat,
        handlers,
        log,
        service() {
            if (!service) {
                service = new LorePassportsService(app, log, () => settings);
                service.install();
            }
            return service;
        },
        async emitEvent(name, ...args) {
            for (const handler of [...(handlers.get(name) ?? [])]) await handler(...args);
        },
        async start() {
            const owned: (() => void | Promise<void>)[] = [];
            await lorePassportsModule.init({ app, settings, log, own: (dispose) => owned.push(dispose) });
            return {
                async stop() {
                    for (const dispose of owned.reverse()) await dispose();
                },
            };
        },
    };
    return env;
}

/** A Maestro book (role 'maestro'), a base world book and a BunnyMo pack, in the LoreStore and in World Info. */
export function seedBooks(env: Env): void {
    env.roles.roles.set('Places', role('Places', 'maestro'));
    env.roles.roles.set('World', role('World', 'world'));
    env.roles.roles.set('Bunny', role('Bunny', 'bunnymo.pack'));
    const places: WiEntry[] = [
        entry(0, {
            comment: 'Silver Tower',
            key: ['Silver Tower'],
            content: 'Place: Silver Tower\nDescription: A tall white tower with silver spires.',
            extensions: { maestro: { type: 'place', typeFields: { name: 'Silver Tower' } } },
        }),
        entry(1, {
            comment: 'House rules',
            key: ['rules'],
            content: 'Rule: no magic indoors.',
            extensions: { maestro: { type: 'rule', typeFields: { name: 'House rules' } } },
        }),
    ];
    const world: WiEntry[] = [
        entry(0, { comment: 'Anna', key: ['Anna', 'Анна'], content: 'Anna is an elf with silver hair.' }),
        entry(1, { comment: 'Old sword', key: ['sword'], content: 'A rusty old sword.' }),
    ];
    const bunny: WiEntry[] = [entry(0, { comment: 'Trait', key: ['trait'], content: 'Trait text.' })];
    env.store.put('Places', places);
    env.store.put('World', world);
    env.store.put('Bunny', bunny);
    for (const name of ['Places', 'World', 'Bunny']) {
        env.books.set(name, structuredClone(env.store.data.get(name)!) as never);
    }
}

export const ANNA_PASSPORT = {
    kind: 'character',
    name: 'Anna',
    aliases: ['Анна'],
    slots: { base: '1girl, elf', hair: 'silver hair', eyes: 'green eyes' },
};

export const TOWER_PASSPORT = { kind: 'location', name: 'Silver Tower', tags: 'tower, white walls, silver spires' };
