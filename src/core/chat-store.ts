// Per-chat documents (plan §2.1, §4.8, §4.10): one file per chat and kind,
// `maestro-chat-<hash(chatId)>-<kind>.json`, holding an envelope with a schema number (migrations) and a
// write version (compare-and-swap between tabs). Chat metadata only keeps small pointers and the index of
// kinds written for that chat (`chatMetadata.maestro`).
import { stableHash } from '../domain/hash';
import type { ChatStore, FileStore, Host, Logger, Unsubscribe } from '../shared/contracts';
import { currentTabId, readFresh } from './files';

export interface ChatEnvelope<T = unknown> {
    /** Schema of `data` (migrations move it forward). */
    schema: number;
    /** Incremented on every write; a tab writes only over the version it last saw. */
    version: number;
    updatedAt: number;
    /** Tab that wrote this version. */
    tabId: string;
    data: T;
}

export interface ChatBundle {
    format: 'maestro-chat';
    formatVersion: 1;
    chatId: string;
    exportedAt: number;
    pointers?: Record<string, unknown>;
    docs: Record<string, ChatEnvelope>;
}

/** What Maestro keeps in chatMetadata.maestro. */
export interface ChatPointers {
    schema: 1;
    /** Document kinds written for this chat (export/import). */
    kinds: string[];
    pointers: Record<string, unknown>;
}

export interface ChatStoreOptions {
    /** Debounce of ctx().saveMetadata() after pointer changes. */
    metadataSaveDelayMs?: number;
}

export type MaestroChatStore = ChatStore & {
    dispose(): void;
    /** Forgets cached documents (also done on CHAT_CHANGED). */
    clearCache(): void;
};

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

interface Entry {
    env: ChatEnvelope<object>;
    /** Version this tab last read or wrote. */
    known: number;
}

const META_KEY = 'maestro';
const KINDS_FILE_KIND = 'chat-kinds';
const DEFAULT_SAVE_DELAY_MS = 500;

export function chatDocName(files: FileStore, chatId: string, kind: string): string {
    return files.fileName(`chat-${stableHash(chatId)}-${kind}`);
}

export function isEnvelope(value: unknown): value is ChatEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const env = value as Partial<ChatEnvelope>;
    return typeof env.version === 'number' && typeof env.schema === 'number' && 'data' in env;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createChatStore(
    host: Host,
    files: FileStore,
    log: Logger,
    options: ChatStoreOptions = {},
): MaestroChatStore {
    const saveDelay = options.metadataSaveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
    const tabId = currentTabId();
    const cache = new Map<string, Entry>();
    const loading = new Map<string, Promise<Entry>>();
    const chains = new Map<string, Promise<unknown>>();
    const migrations = new Map<string, Map<number, Migration>>();
    const defaultsByKind = new Map<string, () => object>();
    const knownKinds = new Set<string>();
    // Data object -> chat it belongs to. put() writes a document back to the chat it was read from, even if
    // the user switched chats between get() and put() (otherwise chat A's journal could land in chat B).
    const owners = new WeakMap<object, string>();
    // Version this tab last read or wrote, per chat and kind. Survives cache clears: a write that finishes
    // after a chat switch must still compare against what this tab saw.
    const knownVersions = new Map<string, number>();
    let generation = 0;

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let saveChatId: string | null = null;
    let saveWaiters: (() => void)[] = [];

    let globalKinds: Promise<Set<string>> | null = null;

    const keyOf = (chatId: string, kind: string) => `${chatId}\u0000${kind}`;

    const currentSchema = (kind: string): number => {
        const steps = migrations.get(kind);
        if (!steps || steps.size === 0) return 1;
        return Math.max(1, Math.max(...steps.keys()) + 1);
    };

    const migrate = (kind: string, env: ChatEnvelope): ChatEnvelope => {
        const target = currentSchema(kind);
        let schema = env.schema;
        let data = env.data;
        while (schema < target) {
            const step = migrations.get(kind)?.get(schema);
            if (!step) {
                log.warn(`no migration for ${kind} from schema ${schema}`);
                break;
            }
            try {
                data = step(isPlainObject(data) ? data : { value: data });
            } catch (error) {
                throw new Error(`migration of ${kind} from schema ${schema} failed: ${String(error)}`, {
                    cause: error,
                });
            }
            schema++;
        }
        return { ...env, schema, data };
    };

    const withDefaults = (data: unknown, defaults: (() => object) | undefined): object => {
        if (!defaults) return isPlainObject(data) || Array.isArray(data) ? data : {};
        const base = defaults();
        if (isPlainObject(base) && isPlainObject(data)) return { ...base, ...data };
        if (data && typeof data === 'object') return data;
        return base;
    };

    const toEntry = (kind: string, raw: unknown, defaults: (() => object) | undefined): Entry => {
        if (raw !== null && !isEnvelope(raw)) log.warn(`chat document ${kind} has no envelope; starting from defaults`);
        if (!isEnvelope(raw)) {
            const data = withDefaults(undefined, defaults);
            return { env: { schema: currentSchema(kind), version: 0, updatedAt: 0, tabId, data }, known: 0 };
        }
        const env = migrate(kind, raw);
        return { env: { ...env, data: withDefaults(env.data, defaults) }, known: raw.version };
    };

    const serial = <R>(key: string, job: () => Promise<R>): Promise<R> => {
        const previous = chains.get(key) ?? Promise.resolve();
        const next = previous.then(job, job);
        const settled = next.catch(() => undefined);
        chains.set(key, settled);
        void settled.then(() => {
            if (chains.get(key) === settled) chains.delete(key);
        });
        return next;
    };

    /** Loads go through the same per-document chain as writes, so a read never overtakes this tab's write. */
    const load = (chatId: string, kind: string, defaults: () => object): Promise<Entry> => {
        knownKinds.add(kind);
        defaultsByKind.set(kind, defaults);
        const key = keyOf(chatId, kind);
        const cached = cache.get(key);
        if (cached) return Promise.resolve(cached);
        const pending = loading.get(key);
        if (pending) return pending;
        const startedIn = generation;
        const job = serial(key, async () => {
            const again = cache.get(key);
            if (again) return again;
            const raw = await readFresh<unknown>(files, chatDocName(files, chatId, kind));
            const entry = toEntry(kind, raw, defaults);
            owners.set(entry.env.data, chatId);
            knownVersions.set(key, entry.known);
            if (startedIn === generation) cache.set(key, entry);
            return entry;
        });
        loading.set(key, job);
        void job
            .finally(() => {
                if (loading.get(key) === job) loading.delete(key);
            })
            .catch(() => undefined);
        return job;
    };

    /* ------------------------------------------------------------ pointers in chat metadata */

    const readRoot = (): ChatPointers | null => {
        const meta = host.ctx().chatMetadata;
        const root = meta?.[META_KEY];
        if (!isPlainObject(root)) return null;
        return root as unknown as ChatPointers;
    };

    /** Always re-reads ctx().chatMetadata: ST reassigns it on chat load. */
    const ensureRoot = (): ChatPointers => {
        const meta = host.ctx().chatMetadata;
        const existing = meta[META_KEY];
        const root: ChatPointers = isPlainObject(existing)
            ? (existing as unknown as ChatPointers)
            : { schema: 1, kinds: [], pointers: {} };
        if (!Array.isArray(root.kinds)) root.kinds = [];
        if (!isPlainObject(root.pointers)) root.pointers = {};
        if (root.schema !== 1) root.schema = 1;
        meta[META_KEY] = root;
        return root;
    };

    const flushMetadata = async (): Promise<void> => {
        saveTimer = null;
        const waiters = saveWaiters;
        saveWaiters = [];
        const target = saveChatId;
        saveChatId = null;
        try {
            if (target !== null && target === host.chatId()) {
                await host.ctx().saveMetadata();
            } else {
                log.debug('chat changed before the metadata save; pointer change dropped');
            }
        } catch (error) {
            log.warn('saveMetadata failed', error);
        } finally {
            for (const resolve of waiters) resolve();
        }
    };

    const scheduleMetadataSave = (): Promise<void> => {
        saveChatId = host.chatId();
        return new Promise<void>((resolve) => {
            saveWaiters.push(resolve);
            if (saveTimer !== null) clearTimeout(saveTimer);
            saveTimer = setTimeout(() => void flushMetadata(), saveDelay);
        });
    };

    const indexKind = (chatId: string, kind: string): void => {
        if (chatId === host.chatId()) {
            const root = ensureRoot();
            if (!root.kinds.includes(kind)) {
                root.kinds.push(kind);
                void scheduleMetadataSave();
            }
        }
        void rememberGlobalKind(kind);
    };

    /** Kinds ever written in any chat: lets exportChat find documents of chats that are not open. */
    const loadGlobalKinds = (): Promise<Set<string>> => {
        globalKinds ??= readFresh<unknown>(files, files.fileName(KINDS_FILE_KIND))
            .then((raw) => {
                const list = isPlainObject(raw) && Array.isArray(raw.kinds) ? raw.kinds : [];
                return new Set(list.filter((kind): kind is string => typeof kind === 'string'));
            })
            .catch((error: unknown) => {
                log.warn('could not read the kinds index', error);
                globalKinds = null;
                return new Set<string>();
            });
        return globalKinds;
    };

    const rememberGlobalKind = async (kind: string): Promise<void> => {
        const kinds = await loadGlobalKinds();
        if (kinds.has(kind)) return;
        kinds.add(kind);
        const name = files.fileName(KINDS_FILE_KIND);
        try {
            // Rare (a kind is new once per install): merge with kinds other tabs added since the first read.
            const raw = await readFresh<unknown>(files, name);
            if (isPlainObject(raw) && Array.isArray(raw.kinds)) {
                for (const other of raw.kinds) if (typeof other === 'string') kinds.add(other);
            }
            await files.write(name, { kinds: [...kinds].sort() });
        } catch (error) {
            kinds.delete(kind);
            log.warn('could not update the kinds index', error);
        }
    };

    /* ------------------------------------------------------------ writes */

    const putFor = (chatId: string, kind: string, data: object): Promise<boolean> => {
        knownKinds.add(kind);
        const key = keyOf(chatId, kind);
        return serial(key, async () => {
            const name = chatDocName(files, chatId, kind);
            const target = currentSchema(kind);
            const startedIn = generation;
            let raw: unknown;
            try {
                raw = await readFresh<unknown>(files, name);
            } catch (error) {
                log.warn(`could not re-read ${kind} before writing`, error);
                return false;
            }
            const remote = isEnvelope(raw) ? raw : null;
            const remoteVersion = remote?.version ?? 0;
            const known = knownVersions.get(key) ?? 0;
            if (remote && (remoteVersion > known || remote.schema > target)) {
                log.info(`${kind}: another tab wrote version ${remoteVersion} (this tab saw ${known}); reloading`);
                knownVersions.set(key, remoteVersion);
                if (startedIn === generation) {
                    try {
                        const fresh = toEntry(kind, remote, defaultsByKind.get(kind));
                        owners.set(fresh.env.data, chatId);
                        cache.set(key, fresh);
                    } catch (error) {
                        cache.delete(key);
                        log.error(`could not refresh ${kind}`, error);
                    }
                }
                return false;
            }
            const env: ChatEnvelope<object> = {
                schema: target,
                version: Math.max(known, remoteVersion) + 1,
                updatedAt: Date.now(),
                tabId,
                data,
            };
            try {
                await files.write(name, env);
            } catch (error) {
                log.error(`could not write ${kind}`, error);
                return false;
            }
            owners.set(data, chatId);
            knownVersions.set(key, env.version);
            if (startedIn === generation) cache.set(key, { env, known: env.version });
            indexKind(chatId, kind);
            return true;
        });
    };

    /* ------------------------------------------------------------ lifecycle */

    const clearCache = () => {
        generation++;
        cache.clear();
    };

    const chatChanged = host.events.name('CHAT_CHANGED');
    const offChatChanged: Unsubscribe = chatChanged ? host.events.on(chatChanged, () => clearCache()) : () => {};
    if (!chatChanged) log.warn('CHAT_CHANGED is missing; chat documents are not reloaded on chat switch');

    return {
        async get<T extends object>(kind: string, defaults: () => T): Promise<T> {
            const chatId = host.chatId();
            if (!chatId) return defaults();
            const entry = await load(chatId, kind, defaults);
            return entry.env.data as T;
        },

        async put<T extends object>(kind: string, data: T): Promise<boolean> {
            const chatId = owners.get(data) ?? host.chatId();
            if (!chatId) {
                log.debug(`no chat: ${kind} not saved`);
                return false;
            }
            return putFor(chatId, kind, data);
        },

        async getFor<T extends object>(chatId: string, kind: string, defaults: () => T): Promise<T> {
            const entry = await load(chatId, kind, defaults);
            return entry.env.data as T;
        },

        pointer<T>(name: string): T | undefined {
            const root = readRoot();
            if (!root || !isPlainObject(root.pointers)) return undefined;
            return root.pointers[name] as T | undefined;
        },

        async setPointer(name: string, value: unknown): Promise<void> {
            if (!host.chatId()) return;
            const root = ensureRoot();
            if (value === undefined) delete root.pointers[name];
            else root.pointers[name] = value;
            await scheduleMetadataSave();
        },

        migration(kind: string, fromVersion: number, migrateDoc: Migration): void {
            knownKinds.add(kind);
            let steps = migrations.get(kind);
            if (!steps) {
                steps = new Map();
                migrations.set(kind, steps);
            }
            if (steps.has(fromVersion))
                log.warn(`migration ${kind}@${fromVersion} registered twice; the last one wins`);
            steps.set(fromVersion, migrateDoc);
        },

        async exportChat(chatId: string): Promise<Record<string, unknown>> {
            const kinds = new Set<string>(knownKinds);
            for (const kind of await loadGlobalKinds()) kinds.add(kind);
            const current = chatId === host.chatId();
            const root = current ? readRoot() : null;
            if (root && Array.isArray(root.kinds)) for (const kind of root.kinds) kinds.add(kind);
            const docs: Record<string, ChatEnvelope> = {};
            for (const kind of [...kinds].sort()) {
                const raw = await readFresh<unknown>(files, chatDocName(files, chatId, kind));
                if (isEnvelope(raw)) docs[kind] = raw;
            }
            const bundle: ChatBundle = {
                format: 'maestro-chat',
                formatVersion: 1,
                chatId,
                exportedAt: Date.now(),
                docs,
            };
            if (root && isPlainObject(root.pointers)) bundle.pointers = structuredClone(root.pointers);
            return bundle as unknown as Record<string, unknown>;
        },

        async importChat(chatId: string, bundle: Record<string, unknown>): Promise<void> {
            if (bundle.format !== 'maestro-chat' || !isPlainObject(bundle.docs)) {
                throw new Error('not a Maestro chat bundle');
            }
            const imported: string[] = [];
            for (const [kind, env] of Object.entries(bundle.docs)) {
                if (!isEnvelope(env)) {
                    log.warn(`import: ${kind} has no envelope; skipped`);
                    continue;
                }
                const key = keyOf(chatId, kind);
                await serial(key, async () => {
                    const name = chatDocName(files, chatId, kind);
                    const remote = await readFresh<unknown>(files, name);
                    const remoteVersion = isEnvelope(remote) ? remote.version : 0;
                    const version = Math.max(remoteVersion, knownVersions.get(key) ?? 0) + 1;
                    await files.write(name, { ...env, version, updatedAt: Date.now(), tabId });
                    knownVersions.set(key, version);
                    cache.delete(key);
                });
                knownKinds.add(kind);
                imported.push(kind);
                void rememberGlobalKind(kind);
            }
            if (chatId === host.chatId()) {
                const root = ensureRoot();
                for (const kind of imported) if (!root.kinds.includes(kind)) root.kinds.push(kind);
                if (isPlainObject(bundle.pointers)) Object.assign(root.pointers, structuredClone(bundle.pointers));
                await scheduleMetadataSave();
            }
        },

        clearCache,

        dispose(): void {
            offChatChanged();
            if (saveTimer !== null) {
                clearTimeout(saveTimer);
                void flushMetadata();
            }
            clearCache();
        },
    };
}
