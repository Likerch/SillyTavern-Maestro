// Test stand of the Lore Studio (M23): the ST mock with a fake world-info.js that behaves like ST 1.19 where the
// studio depends on it (cache handed out by reference on first load and on save, immediate vs debounced saves,
// WORLDINFO_UPDATED, the classic panel's `#world_info` handler, settings handlers, character/persona bindings),
// in-memory files and journal, fake adapters and fake DES lorebook modules.
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { makeFileName } from '../../../src/core/files';
import { createI18n } from '../../../src/core/i18n';
import { ORIGINAL_DATA_KEY_MAP, isRecord, setByPath } from '../../../src/domain/lore-studio-entries';
import { DesLore } from '../../../src/features/loreStudio/des-lore';
import { StLore } from '../../../src/features/loreStudio/st-lore';
import { LoreStoreService } from '../../../src/features/loreStudio/store';
import { M23_STRINGS } from '../../../src/features/loreStudio/strings';
import type {
    App,
    FileStore,
    Journal,
    JournalAction,
    JournalRecord,
    ModuleManager,
    UndoHandler,
} from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger, settle } from '../../helpers/core-host';
import type { FakeUi, TestHost } from '../../helpers/core-host';
import { EVENT_TYPES, installStMock } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';
import { FakePopup, POPUP_RESULT, POPUP_TYPE } from '../../helpers/ui-env';

export { settle } from '../../helpers/core-host';

type Book = { entries: Record<string, Record<string, unknown>>; [key: string]: unknown };
type Namespace = Record<string, unknown>;

export class MemoryFiles implements FileStore {
    readonly map = new Map<string, string>();
    async read<T>(name: string): Promise<T | null> {
        const text = this.map.get(name);
        return text === undefined ? null : (JSON.parse(text) as T);
    }
    async write(name: string, data: unknown): Promise<void> {
        this.map.set(name, JSON.stringify(data));
    }
    async remove(name: string): Promise<void> {
        this.map.delete(name);
    }
    fileName(kind: string, key?: string): string {
        return makeFileName(kind, key);
    }
}

export class MemoryJournal implements Journal {
    records: JournalRecord[] = [];
    readonly handlers = new Map<string, UndoHandler>();
    async record(action: JournalAction): Promise<string> {
        const record: JournalRecord = {
            ...(JSON.parse(JSON.stringify(action)) as JournalAction),
            id: `r${this.records.length + 1}`,
            at: Date.now(),
            chatId: 'chat-1',
        };
        this.records.push(record);
        return record.id;
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
        return [...this.records].reverse();
    }
    registerUndo(target: string, handler: UndoHandler): void {
        this.handlers.set(target, handler);
    }
    last(): JournalRecord {
        return this.records[this.records.length - 1] as JournalRecord;
    }
}

export interface FakeWi extends Namespace {
    world_names: string[];
    selected_world_info: string[];
    world_info: { charLore: { name: string; extraBooks: string[] }[] };
    saves: { name: string; immediately: boolean; data: unknown }[];
    deleted: string[];
    listUpdates: number;
    allowOverwrite: boolean;
    onWorldInfoChange: Mock;
    updateWorldInfoSettings: Mock;
    setWIOriginalDataValue: Mock;
    deleteWIOriginalDataValue: Mock;
    charSetAuxWorlds: Mock;
    charUpdatePrimaryWorld: Mock;
    setWorldInfoButtonClass: Mock;
    importWorldInfo: Mock;
    updateWorldInfoList(): Promise<void>;
}

export interface FakeDesAdapter {
    presentValue: boolean;
    settingsValue: Record<string, unknown> | null;
    workshopOpen: boolean;
    invalidated: string[];
    present(): boolean;
    settings(): Record<string, unknown> | null;
    extensionName(): string;
    isWorkshopOpen(): boolean;
    invalidateLoreCache(name: string): void;
    knownCharacters(): string[];
}

export interface Stand {
    mock: StMock;
    host: TestHost;
    app: App;
    ui: FakeUi;
    journal: MemoryJournal;
    files: MemoryFiles;
    wi: FakeWi;
    /** Books on "disk" (what /api/worldinfo/edit wrote). */
    server: Map<string, Book>;
    /** ST's worldInfoCache (values by reference, like ST). */
    cache: Map<string, Book>;
    reloads: string[];
    script: Namespace;
    loads: Map<string, Namespace>;
    apis: Map<string, unknown>;
    des: FakeDesAdapter;
    bunny: { core: string[]; packs: string[]; archives: string[] };
    power: Record<string, unknown>;
    store: LoreStoreService;
    st: StLore;
    desLore: DesLore;
    callGenericPopup: Mock;
    executeSlash: Mock;
    events: { name: string; args: unknown[] }[];
    /** Builds the classic panel's `#world_info` and settings elements wired like ST's handlers. */
    installWiDom(): void;
    /** Puts DES on the page with fake lorebook modules; returns them. */
    installDes(): FakeDesModules;
    addBook(name: string, entries: Record<string, Record<string, unknown>>, extra?: Record<string, unknown>): void;
    book(name: string): Book;
    emit(key: string, ...args: unknown[]): Promise<void>;
}

export interface FakeDesModules {
    lorebook: Record<string, unknown>;
    campaigns: Namespace & Record<string, Mock>;
    persistence: Namespace & { saveSettings: Mock };
    autoLink: Namespace & { syncAutoLinkedLorebooks: Mock };
    api: Namespace;
}

export const SETTINGS_KEYS = [
    'world_info_depth',
    'world_info_min_activations',
    'world_info_min_activations_depth_max',
    'world_info_budget',
    'world_info_include_names',
    'world_info_recursive',
    'world_info_overflow_alert',
    'world_info_case_sensitive',
    'world_info_match_whole_words',
    'world_info_character_strategy',
    'world_info_budget_cap',
    'world_info_use_group_scoring',
    'world_info_max_recursion_steps',
];

export function createStand(): Stand {
    const mock = installStMock();
    const host = createTestHost(mock);
    const log = createTestLogger();
    const i18n = createI18n(() => 'en');
    i18n.register(M23_STRINGS);
    const ui = createFakeUi();
    const journal = new MemoryJournal();
    const files = new MemoryFiles();
    const server = new Map<string, Book>();
    const cache = new Map<string, Book>();
    const reloads: string[] = [];
    const events: { name: string; args: unknown[] }[] = [];
    const apis = new Map<string, unknown>();
    const loads = new Map<string, Namespace>();
    const ctx = mock.context as unknown as Record<string, unknown>;
    const emit = (key: string, ...args: unknown[]) => mock.eventSource.emit(EVENT_TYPES[key] ?? key, ...args);
    const power: Record<string, unknown> = {
        persona_description_lorebook: '',
        personas: { 'me.png': 'Me' },
        persona_descriptions: { 'me.png': { description: '', lorebook: '' }, 'other.png': { lorebook: '' } },
    };
    const characters = [
        { name: 'Anna', avatar: 'anna.png', data: { extensions: { world: '' } } },
        { name: 'Bob', avatar: 'bob.png', data: { extensions: { world: '' } } },
    ];

    const wi = {
        world_names: [] as string[],
        selected_world_info: [] as string[],
        world_info: { charLore: [] as { name: string; extraBooks: string[] }[] },
        saves: [] as { name: string; immediately: boolean; data: unknown }[],
        deleted: [] as string[],
        listUpdates: 0,
        allowOverwrite: true,
        originalWIDataKeyMap: { ...ORIGINAL_DATA_KEY_MAP },
        world_info_depth: 2,
        world_info_min_activations: 0,
        world_info_min_activations_depth_max: 0,
        world_info_budget: 25,
        world_info_include_names: true,
        world_info_recursive: false,
        world_info_overflow_alert: false,
        world_info_case_sensitive: false,
        world_info_match_whole_words: false,
        world_info_character_strategy: 1,
        world_info_budget_cap: 0,
        world_info_use_group_scoring: false,
        world_info_max_recursion_steps: 0,
    } as unknown as FakeWi;
    wi.worldInfoCache = {
        has: (name: string) => cache.has(name),
        get: (name: string) => structuredClone(cache.get(name)),
        set: (name: string, data: Book) => cache.set(name, data),
        delete: (name: string) => cache.delete(name),
    };
    wi.loadWorldInfo = async (name: string) => {
        if (cache.has(name)) return structuredClone(cache.get(name));
        // ST's first fetch puts the parsed object in the cache and returns that very object (WI:2052-2056).
        const data = structuredClone(server.get(name) ?? { entries: {} });
        cache.set(name, data);
        return data;
    };
    wi.saveWorldInfo = async (name: string, data: Book, immediately = false) => {
        cache.set(name, data);
        wi.saves.push({ name, immediately: !!immediately, data });
        if (!immediately) return;
        server.set(name, JSON.parse(JSON.stringify(data)) as Book);
        await emit('WORLDINFO_UPDATED', name, data);
    };
    wi.updateWorldInfoList = async () => {
        wi.listUpdates++;
        wi.world_names = [...server.keys()].sort((a, b) => a.localeCompare(b));
        const select = document.getElementById('world_info');
        if (select instanceof HTMLSelectElement) {
            for (const option of [...select.options]) if (option.value !== '') option.remove();
            wi.world_names.forEach((name, index) => {
                const option = document.createElement('option');
                option.text = name;
                option.value = String(index);
                option.selected = wi.selected_world_info.includes(name);
                select.append(option);
            });
        }
    };
    wi.deleteWorldInfo = async (name: string) => {
        if (!wi.world_names.includes(name)) return false;
        server.delete(name);
        cache.delete(name);
        const index = wi.selected_world_info.indexOf(name);
        if (index >= 0) wi.selected_world_info.splice(index, 1);
        await (wi.updateWorldInfoList as () => Promise<void>)();
        if (power.persona_description_lorebook === name) power.persona_description_lorebook = '';
        wi.deleted.push(name);
        return true;
    };
    wi.importWorldInfo = vi.fn(async (file: File) => {
        const text = await file.text();
        const json = JSON.parse(text) as Record<string, unknown>;
        const name = file.name.slice(0, file.name.lastIndexOf('.'));
        if (wi.world_names.includes(name) && !wi.allowOverwrite) return false;
        server.set(name, (isRecord(json.entries) ? json : { entries: {} }) as Book);
        await (wi.updateWorldInfoList as () => Promise<void>)();
        return undefined;
    });
    wi.onWorldInfoChange = vi.fn((args: unknown) => {
        if (args !== '__notSlashCommand__') return '';
        const select = document.getElementById('world_info') as HTMLSelectElement;
        // jQuery's .val() walks the options (happy-dom's selectedOptions does not follow deselection).
        wi.selected_world_info = [...select.options]
            .filter((option) => option.selected)
            .map((option) => wi.world_names[Number(option.value)])
            .filter((name): name is string => !!name);
        void emit('WORLDINFO_SETTINGS_UPDATED');
        return '';
    });
    wi.updateWorldInfoSettings = vi.fn((settings: Record<string, unknown>, active?: string[]) => {
        for (const [key, value] of Object.entries(settings)) if (SETTINGS_KEYS.includes(key)) wi[key] = value;
        if (Array.isArray(active)) wi.selected_world_info = active;
    });
    wi.getWorldInfoSettings = () =>
        Object.fromEntries([['world_info', wi.world_info], ...SETTINGS_KEYS.map((key) => [key, wi[key]])]);
    wi.setWIOriginalDataValue = vi.fn((data: Book, uid: number, key: string, value: unknown) => {
        const original = data.originalData as { entries?: Record<string, unknown>[] } | undefined;
        const target = original?.entries?.find((item) => item.uid === uid);
        if (target) setByPath(target, key, value);
    });
    wi.deleteWIOriginalDataValue = vi.fn((data: Book, uid: number) => {
        const original = data.originalData as { entries?: Record<string, unknown>[] } | undefined;
        const index = original?.entries?.findIndex((item) => String(item.uid) === String(uid)) ?? -1;
        if (index >= 0) original?.entries?.splice(index, 1);
    });
    wi.charSetAuxWorlds = vi.fn((fileName: string, books: string[]) => {
        const list = wi.world_info.charLore;
        const index = list.findIndex((item) => item.name === fileName);
        if (!books.length) {
            if (index >= 0) list.splice(index, 1);
        } else if (index < 0) list.push({ name: fileName, extraBooks: [...books] });
        else list[index] = { name: fileName, extraBooks: [...books] };
    });
    wi.charUpdatePrimaryWorld = vi.fn(async (name: string) => {
        const character = characters[Number(ctx.characterId)];
        if (character) character.data.extensions.world = name;
    });
    wi.setWorldInfoButtonClass = vi.fn();

    const script: Namespace = { doNavbarIconClick: vi.fn() };
    loads.set('/scripts/personas.js', {
        user_avatar: 'me.png',
        getOrCreatePersonaDescriptor: () => (power.persona_descriptions as Record<string, unknown>)['me.png'],
    });

    host.modules = {
        worldInfo: async () => wi,
        script: async () => script,
        openai: async () => ({}),
        presetManager: async () => ({}),
        chats: async () => ({}),
        regexEngine: async () => ({}),
        utils: async () => ({}),
        load: async (path: string) => {
            const namespace = loads.get(path);
            if (!namespace) throw new Error(`no module ${path}`);
            return namespace;
        },
    };

    const callGenericPopup = vi.fn(async (): Promise<unknown> => POPUP_RESULT.AFFIRMATIVE);
    const executeSlash = vi.fn(async (): Promise<unknown> => ({}));
    Object.assign(ctx, {
        characters,
        characterId: 0,
        powerUserSettings: power,
        getWorldInfoNames: () => [...wi.world_names],
        loadWorldInfo: (name: string) => (wi.loadWorldInfo as (name: string) => Promise<unknown>)(name),
        saveWorldInfo: (name: string, data: Book, immediately?: boolean) =>
            (wi.saveWorldInfo as (n: string, d: Book, i?: boolean) => Promise<void>)(name, data, immediately),
        reloadWorldInfoEditor: (name: string) => reloads.push(name),
        updateWorldInfoList: () => (wi.updateWorldInfoList as () => Promise<void>)(),
        writeExtensionField: vi.fn(async (id: number, key: string, value: unknown) => {
            const character = characters[id];
            if (character) (character.data.extensions as Record<string, unknown>)[key] = value;
        }),
        saveMetadata: vi.fn(async () => {}),
        Popup: FakePopup,
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup,
        executeSlashCommandsWithOptions: executeSlash,
    });
    FakePopup.instances = [];

    const des: FakeDesAdapter = {
        presentValue: false,
        settingsValue: null,
        workshopOpen: false,
        invalidated: [],
        present: () => des.presentValue,
        settings: () => des.settingsValue,
        extensionName: () => 'third-party/DES',
        isWorkshopOpen: () => des.workshopOpen,
        invalidateLoreCache: (name) => des.invalidated.push(name),
        knownCharacters: () => [],
    };
    const bunny = { core: [] as string[], packs: [] as string[], archives: [] as string[] };

    const modules: ModuleManager = {
        list: () => [],
        enable: async () => {},
        disable: async () => {},
        api: <T>(key: string) => apis.get(key) as T | undefined,
        expose: (key, api) => {
            apis.set(key, api);
        },
    };

    const app = {
        host,
        turn: { onIntercept: () => () => {}, lastAssistantIndex: () => -1, current: () => null },
        log,
        i18n,
        settings: {
            core: () => ({}),
            module: () => ({}),
            isModuleEnabled: () => true,
            setModuleEnabled() {},
            save() {},
            onChange: () => () => {},
            notify() {},
        },
        files,
        chat: {},
        leader: { isLeader: () => true, onChange: () => () => {} },
        tasks: {},
        llm: {},
        cost: {},
        journal,
        autonomy: {},
        inbox: {},
        ephemeral: {},
        bus: { on: () => () => {}, emit: async () => {} },
        ui,
        adapters: { des, bunnymo: { books: () => bunny }, ck: { repoBooks: () => [] } },
        modules,
    } as unknown as App;

    for (const key of Object.keys(EVENT_TYPES)) {
        const name = EVENT_TYPES[key] as string;
        mock.eventSource.on(name, (...args: unknown[]) => {
            events.push({ name: key, args });
        });
    }

    const st = new StLore(app, log);
    const desLore = new DesLore(app, log);
    const store = new LoreStoreService({ app, log, st, des: desLore });

    const stand: Stand = {
        mock,
        host,
        app,
        ui,
        journal,
        files,
        wi,
        server,
        cache,
        reloads,
        script,
        loads,
        apis,
        des,
        bunny,
        power,
        store,
        st,
        desLore,
        callGenericPopup,
        executeSlash,
        events,
        installWiDom() {
            const select = document.createElement('select');
            select.id = 'world_info';
            select.multiple = true;
            select.addEventListener('change', () =>
                (wi.onWorldInfoChange as (a: unknown) => unknown)('__notSlashCommand__'),
            );
            document.body.append(select);
            for (const key of SETTINGS_KEYS) {
                const control =
                    key === 'world_info_character_strategy'
                        ? document.createElement('select')
                        : document.createElement('input');
                control.id = key;
                if (control instanceof HTMLSelectElement) {
                    for (const value of ['0', '1', '2']) {
                        const option = document.createElement('option');
                        option.text = value;
                        option.value = value;
                        control.append(option);
                    }
                } else if (typeof wi[key] === 'boolean') control.type = 'checkbox';
                else control.type = 'number';
                const event =
                    key === 'world_info_use_group_scoring' ||
                    key === 'world_info_overflow_alert' ||
                    key === 'world_info_character_strategy'
                        ? 'change'
                        : 'input';
                control.addEventListener(event, () => {
                    wi[key] =
                        control instanceof HTMLInputElement && control.type === 'checkbox'
                            ? control.checked
                            : Number(control.value);
                    if (key !== 'world_info_use_group_scoring' && key !== 'world_info_overflow_alert')
                        void emit('WORLDINFO_SETTINGS_UPDATED');
                });
                document.body.append(control);
            }
        },
        installDes() {
            const lorebook: Record<string, unknown> = {
                enabled: false,
                campaigns: {},
                campaignOrder: [],
                collapsedCampaigns: [],
                activeCampaignId: null,
                globalBooks: [],
                campaignActivated: [],
                autoLinked: [],
            };
            des.presentValue = true;
            des.settingsValue = { lorebook, characterInjection: { Florence: { lorebook: 'World' } } };
            let counter = 0;
            const campaignsOf = () =>
                lorebook.campaigns as Record<
                    string,
                    { id: string; name: string; books: string[]; icon?: string; color?: string }
                >;
            const campaigns = {
                createCampaign: vi.fn((name: string) => {
                    const id = `c${++counter}`;
                    campaignsOf()[id] = { id, name, books: [], icon: 'fa-folder', color: '' };
                    (lorebook.campaignOrder as string[]).push(id);
                    return id;
                }),
                renameCampaign: vi.fn((id: string, name: string) => {
                    const campaign = campaignsOf()[id];
                    if (campaign) campaign.name = name;
                }),
                deleteCampaign: vi.fn(async (id: string) => {
                    delete campaignsOf()[id];
                    lorebook.campaignOrder = (lorebook.campaignOrder as string[]).filter((item) => item !== id);
                    return true;
                }),
                updateCampaignIcon: vi.fn(),
                updateCampaignColor: vi.fn(),
                reorderCampaigns: vi.fn((ids: string[]) => {
                    lorebook.campaignOrder = ids;
                }),
                toggleCampaignCollapsed: vi.fn(),
                setActiveCampaign: vi.fn(async (id: string | null) => {
                    lorebook.activeCampaignId = id;
                    return true;
                }),
                getActiveCampaignId: vi.fn(() => lorebook.activeCampaignId),
                getCampaignForBook: vi.fn((book: string) => {
                    const found = Object.values(campaignsOf()).find((campaign) => campaign.books.includes(book));
                    return found ? { id: found.id, campaign: found } : null;
                }),
                moveBookBetweenCampaigns: vi.fn((from: string | null, to: string, book: string) => {
                    if (from) campaignsOf()[from]!.books = campaignsOf()[from]!.books.filter((item) => item !== book);
                    campaignsOf()[to]?.books.push(book);
                }),
                removeBookFromCampaign: vi.fn((id: string, book: string) => {
                    const campaign = campaignsOf()[id];
                    if (campaign) campaign.books = campaign.books.filter((item) => item !== book);
                }),
                toggleGlobalBook: vi.fn((book: string) => {
                    const list = lorebook.globalBooks as string[];
                    const index = list.indexOf(book);
                    if (index < 0) list.push(book);
                    else list.splice(index, 1);
                    return index < 0;
                }),
                queueBookTask: vi.fn((task: () => Promise<unknown>) => task()),
                queueReconcile: vi.fn(async () => ({ turnedOn: 0, turnedOff: 0 })),
                isSwitching: vi.fn(() => false),
                onWorldRenamed: vi.fn(),
                onWorldDeleted: vi.fn(),
            };
            const persistence = { saveSettings: vi.fn() };
            const autoLink = { syncAutoLinkedLorebooks: vi.fn(async () => ({ activated: [], deactivated: [] })) };
            const api = { invalidateWICache: vi.fn() };
            const base = '/scripts/extensions/third-party/DES/';
            loads.set(`${base}src/systems/lorebook/campaignManager.js`, campaigns);
            loads.set(`${base}src/systems/lorebook/lorebookAPI.js`, api);
            loads.set(`${base}src/systems/lorebook/autoLink.js`, autoLink);
            loads.set(`${base}src/core/persistence.js`, persistence);
            // happy-dom refuses to load module files; report the refusal as a success instead of an error event.
            const happy = (globalThis as { happyDOM?: { settings?: Record<string, unknown> } }).happyDOM;
            if (happy?.settings) happy.settings.handleDisabledFileLoadingAsSuccess = true;
            const scriptElement = document.createElement('script');
            scriptElement.setAttribute('type', 'module');
            scriptElement.setAttribute('src', `${base}index.js`);
            document.head.append(scriptElement);
            const toggle = document.createElement('div');
            toggle.id = 'rpg-extension-enabled';
            document.body.append(toggle);
            return { lorebook, campaigns, persistence, autoLink, api } as unknown as FakeDesModules;
        },
        addBook(name, entries, extra = {}) {
            const normalized: Record<string, Record<string, unknown>> = {};
            for (const [uid, entry] of Object.entries(entries)) normalized[uid] = { uid: Number(uid), ...entry };
            server.set(name, { entries: normalized, ...extra });
            wi.world_names = [...server.keys()].sort((a, b) => a.localeCompare(b));
        },
        book(name) {
            return server.get(name) as Book;
        },
        emit,
    };
    return stand;
}

/** Waits for the store's microtask-coalesced change events and queued work. */
export async function flush(stand: Stand): Promise<void> {
    await settle(10);
    await stand.store.idle();
    await settle(10);
}

export function entry(uid: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
    return { uid, key: [], keysecondary: [], comment: '', content: '', ...fields };
}

export function resetDom(): void {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
}
