// Documents of the «Области действия» (plan-2, «везде / персонаж / чат»): what Maestro keeps for one card or for one
// chat — the preset layers of a character or a chat (M34), neighbour prompt copies (M36). A feature gives its own
// `kind`; the character document is a Maestro file per card avatar, `maestro-<kind>-char-<hash(avatar)>.json`
// = {schema:1, owner, data, updatedAt}; the chat document is a per-chat document of the chat store (kind `<kind>`).
// «Везде» (global) stays with the feature itself.
//
// Memory is what callers read synchronously (prompt assembly, preset events): the disk state plus the changes not
// written yet. A change is kept as a function and replayed on a fresh read of the document when it is written, so two
// tabs merge their changes instead of the later one overwriting the earlier (the same pattern as the layer files).
// Group chats have neither scope (Maestro leaves them alone).
import { jsonCopy } from '../domain/settings-diff';
import type { ChatStore, FileStore, Host, Logger } from '../shared/contracts';
import { readFresh } from './files';

export type ScopeKind = 'character' | 'chat';

/** The card and the chat the scopes point at now (nulls: no character / no chat / a group chat). */
export interface ScopeContext {
    /** Avatar file of the card (`Alice.png`): the key of the character scope. */
    avatar: string | null;
    /** The card's name (for the UI). */
    characterName: string | null;
    chatId: string | null;
}

export const EMPTY_SCOPE_CONTEXT: ScopeContext = Object.freeze({ avatar: null, characterName: null, chatId: null });

/** The scopes of the chat open now; a group chat (or no chat) has none. */
export function currentScopeContext(host: Host): ScopeContext {
    try {
        if (host.isGroupChat()) return { ...EMPTY_SCOPE_CONTEXT };
        const ctx = host.ctx();
        const chatId = host.chatId();
        const id = ctx.characterId;
        const card = id === undefined || id === '' ? undefined : ctx.characters[Number(id)];
        const avatar = typeof card?.avatar === 'string' && card.avatar ? card.avatar : null;
        const name = typeof card?.name === 'string' && card.name ? card.name : null;
        return { avatar, characterName: avatar ? name : null, chatId: chatId || null };
    } catch {
        return { ...EMPTY_SCOPE_CONTEXT };
    }
}

export function sameScopeContext(a: ScopeContext | null, b: ScopeContext | null): boolean {
    return (a?.avatar ?? null) === (b?.avatar ?? null) && (a?.chatId ?? null) === (b?.chatId ?? null);
}

/** The owner of a scope in a context (the avatar or the chat id), null when the context has no such scope. */
export function scopeOwner(context: ScopeContext | null, scope: ScopeKind): string | null {
    if (!context) return null;
    return scope === 'character' ? context.avatar : context.chatId;
}

export interface ScopedDocsOptions<T extends object> {
    /** Feature's document kind (file name part and chat document kind), e.g. 'preset-scope'. */
    kind: string;
    defaults: () => T;
    /** Turns stored data into a valid document (unknown or broken parts dropped). */
    sanitize: (raw: unknown) => T;
    /** Called when a write failed (the change stays in memory and is retried with the next change). */
    onError?: (scope: ScopeKind, owner: string, error: unknown) => void;
}

interface CharacterFile {
    schema: 1;
    owner: string;
    data: unknown;
    updatedAt: number;
}

type Change<T> = (doc: T) => void;

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How many times a chat document write is retried after another tab wrote a newer version. */
const CHAT_RETRIES = 3;

export class ScopedDocs<T extends object> {
    private readonly memory = new Map<string, T>();
    private readonly pending = new Map<string, Change<T>[]>();
    private readonly loads = new Map<string, Promise<void>>();
    private readonly chains = new Map<string, Promise<unknown>>();

    constructor(
        private readonly deps: { files: FileStore; chat: ChatStore; log: Logger },
        private readonly options: ScopedDocsOptions<T>,
    ) {}

    private key(scope: ScopeKind, owner: string): string {
        return `${scope}\u0000${owner}`;
    }

    fileName(owner: string): string {
        return this.deps.files.fileName(`${this.options.kind}-char`, owner);
    }

    /** Loads the documents of a context (both scopes) that are not in memory yet. */
    async load(context: ScopeContext | null): Promise<void> {
        const jobs: Promise<void>[] = [];
        if (context?.avatar) jobs.push(this.loadOne('character', context.avatar));
        if (context?.chatId) jobs.push(this.loadOne('chat', context.chatId));
        await Promise.all(jobs);
    }

    /** Reads one document (again, with `force`) into memory; changes made meanwhile stay on top. */
    loadOne(scope: ScopeKind, owner: string, force = false): Promise<void> {
        const key = this.key(scope, owner);
        if (!force && this.memory.has(key)) return Promise.resolve();
        const running = this.loads.get(key);
        if (running && !force) return running;
        const job = (async () => {
            try {
                const data = await this.read(scope, owner);
                for (const change of this.pending.get(key) ?? []) change(data);
                this.memory.set(key, data);
            } catch (error) {
                this.deps.log.warn(`${this.options.kind}: the ${scope} document could not be read`, error);
                if (!this.memory.has(key)) this.memory.set(key, this.options.defaults());
            }
        })();
        this.loads.set(key, job);
        void job.finally(() => {
            if (this.loads.get(key) === job) this.loads.delete(key);
        });
        return job;
    }

    /** True when the document is in memory (loaded or changed in this session). */
    has(scope: ScopeKind, owner: string): boolean {
        return this.memory.has(this.key(scope, owner));
    }

    /** The document in memory (undefined when it was never loaded). Do not change it: use mutate(). */
    get(scope: ScopeKind, owner: string): T | undefined {
        return this.memory.get(this.key(scope, owner));
    }

    /** Changes a document now (memory) and writes it (fresh read, the change replayed on it). */
    async mutate(scope: ScopeKind, owner: string, change: Change<T>): Promise<void> {
        const key = this.key(scope, owner);
        if (!this.memory.has(key)) await this.loadOne(scope, owner);
        const next = jsonCopy(this.memory.get(key) ?? this.options.defaults()) as T;
        change(next);
        this.memory.set(key, next);
        const list = this.pending.get(key) ?? [];
        list.push(change);
        this.pending.set(key, list);
        await this.serial(key, () => this.write(scope, owner));
    }

    /** Waits for the writes in flight. */
    async flush(): Promise<void> {
        await Promise.all([...this.chains.values()].map((chain) => chain.catch(() => undefined)));
    }

    /** Forgets what is in memory (another feature instance, tests). */
    clear(): void {
        this.memory.clear();
    }

    private serial(key: string, job: () => Promise<void>): Promise<void> {
        const previous = this.chains.get(key) ?? Promise.resolve();
        const next = previous.then(job, job);
        const settled = next.catch(() => undefined);
        this.chains.set(key, settled);
        void settled.then(() => {
            if (this.chains.get(key) === settled) this.chains.delete(key);
        });
        return next;
    }

    private async read(scope: ScopeKind, owner: string): Promise<T> {
        if (scope === 'chat') {
            const doc = await this.deps.chat.getFor<object>(owner, this.options.kind, this.options.defaults);
            return this.options.sanitize(jsonCopy(doc));
        }
        const raw = await readFresh<CharacterFile>(this.deps.files, this.fileName(owner));
        if (!isDict(raw) || raw.owner !== owner) return this.options.defaults();
        return this.options.sanitize(raw.data);
    }

    /** Writes every queued change of one document. */
    private async write(scope: ScopeKind, owner: string): Promise<void> {
        const key = this.key(scope, owner);
        const changes = this.pending.get(key) ?? [];
        if (!changes.length) return;
        this.pending.delete(key);
        try {
            const written =
                scope === 'chat' ? await this.writeChat(owner, changes) : await this.writeFile(owner, changes);
            // Memory = what is on disk now + the changes made while this write was running.
            const memory = jsonCopy(written) as T;
            for (const change of this.pending.get(key) ?? []) change(memory);
            this.memory.set(key, memory);
        } catch (error) {
            this.pending.set(key, [...changes, ...(this.pending.get(key) ?? [])]);
            this.deps.log.error(`${this.options.kind}: the ${scope} document could not be saved`, error);
            this.options.onError?.(scope, owner, error);
        }
    }

    private async writeFile(owner: string, changes: Change<T>[]): Promise<T> {
        const name = this.fileName(owner);
        const raw = await readFresh<CharacterFile>(this.deps.files, name);
        const data = isDict(raw) && raw.owner === owner ? this.options.sanitize(raw.data) : this.options.defaults();
        for (const change of changes) change(data);
        await this.deps.files.write(name, { schema: 1, owner, data, updatedAt: Date.now() } satisfies CharacterFile);
        return data;
    }

    /** The chat store writes over the version this tab saw: a newer one from another tab is re-read and replayed. */
    private async writeChat(owner: string, changes: Change<T>[]): Promise<T> {
        for (let attempt = 0; attempt < CHAT_RETRIES; attempt++) {
            const doc = await this.deps.chat.getFor<object>(owner, this.options.kind, this.options.defaults);
            const data = this.options.sanitize(jsonCopy(doc));
            for (const change of changes) change(data);
            // put() resolves the chat from the object getFor returned: write into it, keep its identity.
            const target = doc as Record<string, unknown>;
            for (const field of Object.keys(target)) delete target[field];
            Object.assign(target, jsonCopy(data));
            if (await this.deps.chat.put(this.options.kind, target)) return data;
        }
        throw new Error(`${this.options.kind}: the chat document kept changing in another tab`);
    }
}
