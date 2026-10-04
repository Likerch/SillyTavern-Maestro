// Test harness of the Lore Studio entry form: an in-memory LoreStore (patch semantics: `undefined` deletes a field,
// history of previous versions), a small App with real i18n and fakes of the neighbouring module APIs.
import { vi } from 'vitest';
import { createI18n } from '../../../../src/core/i18n';
import type { App, Unsubscribe } from '../../../../src/shared/contracts';
import type { BookRoleInfo, BookRolesApi } from '../../../../src/features/bookRoles/api';
import type { CanonApi, CanonItem } from '../../../../src/features/canon/api';
import type { EntryFormContext } from '../../../../src/features/loreStudio/form-api';
import type {
    EntryVersion,
    LoreStore,
    SaveReason,
    WiBindings,
    WiBookData,
    WiEntry,
    WiGlobalSettings,
} from '../../../../src/features/loreStudio/store-api';
import { mountEntryForm } from '../../../../src/features/loreStudio/form';
import type { EntryForm } from '../../../../src/features/loreStudio/form';

export async function settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export function entry(uid: number, fields: Record<string, unknown> = {}): WiEntry {
    return {
        uid,
        key: ['Anna'],
        keysecondary: [],
        comment: 'Anna',
        content: 'Anna lives in the Silver Tower.',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: null,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        triggers: [],
        ...fields,
    } as WiEntry;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FakeStore implements LoreStore {
    readonly data = new Map<string, WiBookData>();
    readonly versions = new Map<string, EntryVersion[]>();
    readonly listeners = new Set<(book: string | null) => void>();
    globals: WiGlobalSettings = {};
    updates: { book: string; uid: number; patch: Record<string, unknown>; reason: SaveReason }[] = [];

    put(book: string, entries: WiEntry[], extra: Partial<WiBookData> = {}): void {
        this.data.set(book, { entries: Object.fromEntries(entries.map((item) => [String(item.uid), item])), ...extra });
    }

    entry(book: string, uid: number): WiEntry | undefined {
        return this.data.get(book)?.entries[String(uid)];
    }

    emit(book: string | null): void {
        for (const listener of [...this.listeners]) listener(book);
    }

    books(): string[] {
        return [...this.data.keys()];
    }
    async load(name: string): Promise<WiBookData | null> {
        const data = this.data.get(name);
        return data ? clone(data) : null;
    }
    async updateEntry(book: string, uid: number, patch: Partial<WiEntry>, reason: SaveReason): Promise<void> {
        const current = this.entry(book, uid);
        if (!current) throw new Error('no such entry');
        this.updates.push({ book, uid, patch: { ...patch }, reason });
        const key = `${book}\u0000${uid}`;
        this.versions.set(key, [
            { at: Date.now(), by: 'user', summary: reason.summary, entry: clone(current) },
            ...(this.versions.get(key) ?? []),
        ]);
        const next: Record<string, unknown> = { ...current };
        for (const [field, value] of Object.entries(patch)) {
            if (value === undefined) delete next[field];
            else next[field] = clone(value);
        }
        this.data.get(book)!.entries[String(uid)] = next as WiEntry;
        this.emit(book);
    }
    async history(book: string, uid: number): Promise<EntryVersion[]> {
        return clone(this.versions.get(`${book}\u0000${uid}`) ?? []);
    }
    async globalSettings(): Promise<WiGlobalSettings> {
        return { ...this.globals };
    }
    onChange(listener: (book: string | null) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async save(): Promise<void> {}
    async createBook(name: string): Promise<string> {
        return name;
    }
    async renameBook(): Promise<void> {}
    async duplicateBook(): Promise<void> {}
    async deleteBook(): Promise<void> {}
    async importBook(): Promise<string> {
        return '';
    }
    async exportBook(): Promise<void> {}
    async createEntry(): Promise<number> {
        return 0;
    }
    async deleteEntry(): Promise<void> {}
    async duplicateEntry(): Promise<number> {
        return 0;
    }
    async moveEntry(): Promise<number> {
        return 0;
    }
    async bindings(): Promise<WiBindings> {
        return { global: [], character: { primary: null, extra: [] }, chat: null, persona: null };
    }
    async setGlobal(): Promise<void> {}
    async setCharacterPrimary(): Promise<void> {}
    async setCharacterExtra(): Promise<void> {}
    async setChatBook(): Promise<void> {}
    async setPersonaBook(): Promise<void> {}
    async setGlobalSettings(): Promise<void> {}
}

export function role(book: string, value: BookRoleInfo['role'], overrides: Partial<BookRoleInfo> = {}): BookRoleInfo {
    const bunny = value === 'bunnymo.core' || value === 'bunnymo.pack';
    return { book, role: value, source: 'auto', fingerprint: 'f', readOnly: bunny, localizable: !bunny, ...overrides };
}

export class FakeRoles implements BookRolesApi {
    readonly roles = new Map<string, BookRoleInfo>();
    readonly meta = new Map<string, Record<string, unknown>>();
    setEntryMeta = vi.fn(async (book: string, uid: number, meta: Record<string, unknown> | undefined) => {
        if (meta === undefined) this.meta.delete(`${book}\u0000${uid}`);
        else this.meta.set(`${book}\u0000${uid}`, clone(meta));
    });
    roleOf(book: string): BookRoleInfo | undefined {
        return this.roles.get(book);
    }
    all(): BookRoleInfo[] {
        return [...this.roles.values()];
    }
    async setRole(): Promise<void> {}
    async refresh(): Promise<void> {}
    /** Like the real module: the sync read knows nothing until the book's content hashes are loaded. */
    hashesKnown = true;
    entryMeta<T = Record<string, unknown>>(book: string, uid: number): T | undefined {
        if (!this.hashesKnown) return undefined;
        return this.read<T>(book, uid);
    }
    loadEntryMeta = vi.fn(async (book: string, uid: number) => {
        this.hashesKnown = true;
        return this.read<Record<string, unknown>>(book, uid);
    }) as unknown as BookRolesApi['loadEntryMeta'] & ReturnType<typeof vi.fn>;
    private read<T>(book: string, uid: number): T | undefined {
        const value = this.meta.get(`${book}\u0000${uid}`);
        return value ? (clone(value) as T) : undefined;
    }
    onChange(): Unsubscribe {
        return () => {};
    }
}

export class FakeCanon implements CanonApi {
    items: CanonItem[] = [];
    readonly listeners = new Set<() => void>();
    nextUid = 7;
    constructor(
        private readonly store: FakeStore,
        readonly book = 'Maestro · канон · chat1',
    ) {}
    put = vi.fn(async (draft: { entry: Record<string, unknown>; meta: Record<string, unknown> }) => {
        const uid = this.nextUid++;
        const meta = { ...draft.meta, createdAt: 1, updatedAt: 1 } as CanonItem['meta'];
        const stored = { ...draft.entry, uid, extensions: { maestro: meta } } as unknown as WiEntry;
        const data = this.store.data.get(this.book) ?? { entries: {} };
        data.entries[String(uid)] = stored;
        this.store.data.set(this.book, data);
        this.items.push({ uid, meta, entry: draft.entry });
        return uid;
    });
    remove = vi.fn(async (uid: number) => {
        this.items = this.items.filter((item) => item.uid !== uid);
    });
    promote = vi.fn(async () => true);
    russianKeys = vi.fn(async (term: string) => (term === 'Anna' ? ['Анна', 'Анну', 'Anna'] : [term]));
    ensureBook = vi.fn(async () => this.book);
    bookName(): string {
        return this.book;
    }
    async list(): Promise<CanonItem[]> {
        return clone(this.items);
    }
    async setStatus(): Promise<void> {}
    async baseDrift() {
        return [];
    }
    async exportPlain(): Promise<string> {
        return '';
    }
    budget() {
        return { limitChars: 0, usedChars: 0 };
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export interface Stand {
    app: App;
    store: FakeStore;
    apis: Map<string, unknown>;
    confirm: ReturnType<typeof vi.fn>;
    openPult: ReturnType<typeof vi.fn>;
    styles: Map<string, string>;
    tokenCount: ReturnType<typeof vi.fn>;
    localizer: { api?: () => unknown; addedKeysOf: (entry: unknown) => Set<string> };
    chatId: string | null;
    characters: { name: string; avatar: string }[];
    tags: { id: string; name: string }[];
}

export function createStand(): Stand {
    const i18n = createI18n(() => 'en');
    const store = new FakeStore();
    const apis = new Map<string, unknown>();
    const styles = new Map<string, string>();
    const confirm = vi.fn(async () => true);
    const openPult = vi.fn();
    const tokenCount = vi.fn(async (text: string) => Math.ceil(text.length / 4));
    const stand = {
        store,
        apis,
        confirm,
        openPult,
        styles,
        tokenCount,
        chatId: 'chat1' as string | null,
        characters: [
            { name: 'Anna', avatar: 'Anna.png' },
            { name: 'Bob the Brave', avatar: 'bob.webp' },
        ],
        tags: [{ id: 't1', name: 'Elves' }],
        localizer: {
            addedKeysOf: (item: unknown) => {
                const keys = new Set<string>();
                const marker = (
                    item as {
                        extensions?: {
                            lorebook_localizer?: { languages?: Record<string, { added?: { key?: string[] } }> };
                        };
                    }
                ).extensions?.lorebook_localizer;
                for (const state of Object.values(marker?.languages ?? {}))
                    for (const key of state.added?.key ?? []) keys.add(key);
                return keys;
            },
        } as { api?: () => unknown; addedKeysOf: (entry: unknown) => Set<string> },
    } as Stand;
    const silent = { debug() {}, info() {}, warn() {}, error() {}, scope: () => silent };
    stand.app = {
        i18n,
        log: silent,
        host: {
            ctx: () => ({
                characters: stand.characters,
                tags: stand.tags,
                getTokenCountAsync: tokenCount,
                substituteParams: (text: string) => text.replace(/\{\{char\}\}/g, 'Anna'),
            }),
            chatId: () => stand.chatId,
        },
        ui: {
            style: (id: string, css: string) => {
                styles.set(id, css);
                return () => styles.delete(id);
            },
            confirm,
            openPult,
            notice: vi.fn(),
        },
        modules: {
            api: <T>(key: string) => apis.get(key) as T | undefined,
            list: () => [],
        },
        adapters: { localizer: stand.localizer },
    } as unknown as App;
    return stand;
}

export interface Mounted {
    container: HTMLElement;
    ctx: EntryFormContext;
    dispose(): void;
    form(): EntryForm | null;
    onSaved: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
}

export async function mount(
    stand: Stand,
    book: string,
    uid: number,
    overrides: Partial<EntryFormContext> = {},
): Promise<Mounted> {
    const container = document.createElement('div');
    document.body.append(container);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const ctx: EntryFormContext = {
        app: stand.app,
        store: stand.store,
        book,
        uid,
        readOnly: false,
        onSaved,
        onClose,
        ...overrides,
    };
    const mounted = mountEntryForm(container, ctx);
    await settle();
    return {
        container,
        ctx,
        onSaved,
        onClose,
        form: mounted.form,
        dispose: () => {
            mounted.dispose();
            container.remove();
        },
    };
}

/* ------------------------------------------------------------------ DOM helpers */

export function field<T extends HTMLElement = HTMLInputElement>(root: ParentNode, name: string): T {
    const node = root.querySelector<T>(`[name="${name}"]`);
    if (!node) throw new Error(`no field ${name}`);
    return node;
}

export function type(node: HTMLInputElement | HTMLTextAreaElement, value: string, commit = false): void {
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    if (commit) node.dispatchEvent(new Event('change', { bubbles: true }));
}

export function choose(node: HTMLSelectElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

export function check(node: HTMLInputElement, checked: boolean): void {
    node.checked = checked;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

export function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

export function hasButton(root: ParentNode, text: string): boolean {
    return [...root.querySelectorAll('button')].some((node) => node.textContent?.trim() === text);
}

export async function click(root: ParentNode, text: string): Promise<void> {
    buttonByText(root, text).click();
    await settle();
}

export function section(root: ParentNode, id: string): HTMLDetailsElement {
    const node = root.querySelector<HTMLDetailsElement>(`[data-section="${id}"]`);
    if (!node) throw new Error(`no section ${id}`);
    return node;
}
