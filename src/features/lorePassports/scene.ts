// Passports of the scene (M28 п. 3, plan §16): NAI Studio takes the passports of the entries activated on the last
// turn (lore journal, M1) and of the entries whose entities are mentioned in the text (world model, M7), deduplicated
// — one passport per thing; a canon override with its own passport speaks for its base entry. Books are indexed
// lazily (after a reply, when NAI Studio asks, when the pult shows them) and re-read after WORLDINFO_UPDATED;
// nothing runs on the send path (P15). The provider is registered with NAI Studio only while its API offers
// `registerPassportProvider` (feature-detected: older NAI Studio versions get nothing) and goes with the module.
import { adaptersOf } from '../../adapters';
import type { NaiPassport } from '../../adapters';
import { readTypedMeta } from '../../domain/entry-types';
import {
    dedupeScene,
    entryDisplayName,
    isPassportEmpty,
    passportKindOf,
    passportOfEntry,
    readPassportRecord,
    toNaiShape,
} from '../../domain/lore-passport';
import type { PassportKind, PassportRecord } from '../../domain/lore-passport';
import { entryMetaKey, parseEntryMetaKey } from '../../domain/roles-meta';
import type { App, Logger } from '../../shared/contracts';
import type { LoreJournalApi, TurnLoreRecord } from '../loreJournal/api';
import type { WorldModelApi } from '../world/api';
import type { PassportPlace, ScenePassportsSent } from './api';
import { isDict } from './io';
import type { PassportIo } from './io';

export const PROVIDER_ID = 'maestro-lore';
export const PROVIDER_PRIORITY = 40;
/** How long NAI Studio's request may wait for books to be read. */
const PROVIDER_WAIT_MS = 2500;

export interface ScenePassportsSettings {
    /** Hand the scene's passports to NAI Studio. */
    provider: boolean;
    /** Messages from the end of the chat searched for mentions when NAI Studio gives no text. */
    lastMessages: number;
    /** At most this many passports per scene. */
    maxPerScene: number;
}

export interface IndexedEntry {
    world: string;
    uid: number;
    name: string;
    storage: 'entry' | 'sidecar';
    record: PassportRecord | null;
    /** NAI kind of the entry's type (typed entries), null when untyped or without a look. */
    typedKind: PassportKind | null;
    /** Content length (cost estimates). */
    chars: number;
}

export interface IndexedBook {
    world: string;
    place: PassportPlace;
    entries: Map<number, IndexedEntry>;
    /** Canon overrides of this book: base `${world}#${uid}` → uid of the override here. */
    overrides: Map<string, number>;
}

export interface SceneItem {
    world: string;
    uid: number;
    name: string;
    passport: Record<string, unknown>;
}

/** Context NAI Studio passes to a passport provider (NAI Studio 0.12.0+). */
export interface PassportProviderContext {
    messageIndex: number;
    text: string;
}

export interface GeneratePassportInput {
    name: string;
    kind: 'character' | 'location' | 'object' | 'world';
    description: string;
    language?: string;
}

export type GeneratePassport = (input: GeneratePassportInput) => Promise<NaiPassport | null>;

/** The optional members of the NAI adapter M28 uses (added with NAI Studio 0.12.0); duck-typed for older builds. */
export interface NaiPassportHooks {
    api?(): unknown;
    registerPassportProvider?(provider: {
        id: string;
        priority?: number;
        passports(context: PassportProviderContext): Promise<NaiPassport[]> | NaiPassport[];
    }): () => void;
    generatePassport?: GeneratePassport;
}

export function naiHooks(app: App): NaiPassportHooks | undefined {
    try {
        return adaptersOf(app).nai as unknown as NaiPassportHooks | undefined;
    } catch {
        return undefined;
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
        );
    });
}

export class ScenePassports {
    private readonly books = new Map<string, IndexedBook>();
    private readonly loading = new Map<string, Promise<void>>();
    /** Bumped on every invalidation: a read that started before it does not overwrite fresher knowledge. */
    private readonly generations = new Map<string, number>();
    private sent: ScenePassportsSent | null = null;
    private registered: { api: unknown; off: () => void } | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly io: PassportIo,
        private readonly settings: () => ScenePassportsSettings,
        /** Called when the index or the last answer changed (pult). */
        private readonly onIndex: () => void,
    ) {}

    private api<T>(key: string): T | undefined {
        try {
            return this.app.modules.api<T>(key);
        } catch {
            return undefined;
        }
    }

    /* ---------------------------------------------------------------- index */

    book(world: string): IndexedBook | undefined {
        return this.books.get(world);
    }

    /** Forgets a book (null: every book) so the next request reads it again. */
    invalidate(world: string | null): void {
        const names = world === null ? [...this.books.keys(), ...this.loading.keys()] : [world];
        for (const name of names) {
            this.books.delete(name);
            this.generations.set(name, (this.generations.get(name) ?? 0) + 1);
        }
    }

    /** Forgets the books whose passports live in the sidecar (the registry changed). */
    invalidateSidecars(): void {
        for (const [name, book] of [...this.books]) if (book.place === 'sidecar') this.invalidate(name);
    }

    /** Our own write: the index follows at once when the book is known. */
    update(world: string, uid: number, record: PassportRecord | null): void {
        const entry = this.books.get(world)?.entries.get(uid);
        if (entry) entry.record = record;
    }

    /** Reads the books not indexed yet (each once at a time). */
    async ensure(worlds: Iterable<string>): Promise<void> {
        const jobs: Promise<void>[] = [];
        for (const world of new Set(worlds)) {
            if (!world || this.books.has(world)) continue;
            let job = this.loading.get(world);
            if (!job) {
                job = this.indexBook(world).finally(() => this.loading.delete(world));
                this.loading.set(world, job);
            }
            jobs.push(job);
        }
        if (!jobs.length) return;
        await Promise.all(jobs);
        if (!this.disposed) this.onIndex();
    }

    private async indexBook(world: string): Promise<void> {
        const generation = this.generations.get(world) ?? 0;
        let book: IndexedBook;
        try {
            book = await this.readBook(world);
        } catch (error) {
            this.log.debug(`passports of "${world}" were not read`, error);
            book = { world, place: 'noRegistry', entries: new Map(), overrides: new Map() };
        }
        if (this.disposed || (this.generations.get(world) ?? 0) !== generation) return;
        this.books.set(world, book);
    }

    private async readBook(world: string): Promise<IndexedBook> {
        const book: IndexedBook = { world, place: this.io.place(world), entries: new Map(), overrides: new Map() };
        if (book.place === 'bunnymo') return book;
        const data = await this.io.loadBook(world);
        if (!data) return book;
        for (const [key, raw] of Object.entries(data.entries)) {
            if (!isDict(raw)) continue;
            const uid = typeof raw.uid === 'number' && Number.isInteger(raw.uid) ? raw.uid : Number(key);
            if (!Number.isInteger(uid)) continue;
            const place = book.place === 'entry' ? 'entry' : this.io.place(world, raw);
            if (place !== 'entry' && place !== 'sidecar') continue;
            const extensions = isDict(raw.extensions) ? raw.extensions : {};
            const maestro = isDict(extensions.maestro) ? extensions.maestro : undefined;
            let record: PassportRecord | null;
            let typedSource: unknown;
            if (place === 'entry') {
                record = passportOfEntry(raw);
                typedSource = maestro;
                const base = maestro?.base;
                if (maestro?.kind === 'override' && isDict(base) && typeof base.world === 'string') {
                    if (typeof base.uid === 'number') book.overrides.set(entryMetaKey(base.world, base.uid), uid);
                }
            } else {
                const meta = await this.io.readSidecar(world, uid);
                record = readPassportRecord(meta?.passport);
                typedSource = meta;
            }
            const typed = readTypedMeta(typedSource);
            const content = typeof raw.content === 'string' ? raw.content : '';
            book.entries.set(uid, {
                world,
                uid,
                name: entryDisplayName(raw, typed?.fields.name),
                storage: place,
                record,
                typedKind: passportKindOf(typed?.type),
                chars: content.length,
            });
        }
        return book;
    }

    /* ---------------------------------------------------------------- the scene */

    private turnFor(messageIndex?: number): TurnLoreRecord | undefined {
        const journal = this.api<LoreJournalApi>('loreJournal');
        if (!journal) return undefined;
        try {
            if (messageIndex !== undefined && messageIndex >= 0) {
                const exact = journal.turns().find((record) => record.messageIndex === messageIndex);
                if (exact) return exact;
            }
            return journal.last();
        } catch (error) {
            this.log.debug('lore journal unavailable', error);
            return undefined;
        }
    }

    private lastMessagesText(): string {
        const count = Math.max(1, Math.floor(this.settings().lastMessages || 1));
        try {
            const chat = this.app.host.ctx().chat ?? [];
            return chat
                .filter((message) => message && !message.is_system && typeof message.mes === 'string')
                .slice(-count)
                .map((message) => message.mes)
                .join('\n');
        } catch {
            return '';
        }
    }

    /** `${world}#${uid}` of the activated entries (not cut), then of the entries of mentioned entities. */
    keys(text?: string, messageIndex?: number): string[] {
        const keys: string[] = [];
        const add = (world: unknown, uid: unknown) => {
            if (typeof world !== 'string' || !world || typeof uid !== 'number' || !Number.isInteger(uid)) return;
            const key = entryMetaKey(world, uid);
            if (!keys.includes(key)) keys.push(key);
        };
        for (const activation of this.turnFor(messageIndex)?.activations ?? []) {
            if (!activation.cut) add(activation.world, activation.uid);
        }
        const world = this.api<WorldModelApi>('world');
        const source = text && text.trim() ? text : this.lastMessagesText();
        if (world && source.trim()) {
            try {
                for (const entity of world.mentions(source)) {
                    for (const item of entity.sources) {
                        if (item.kind === 'lore.entry' || item.kind === 'canon.entry') add(item.world, item.uid);
                    }
                }
            } catch (error) {
                this.log.debug('world model mentions failed', error);
            }
        }
        return keys;
    }

    /** Books the keys point at, and the chat canon (its overrides may carry passports of their bases). */
    booksOf(keys: readonly string[]): string[] {
        const books = keys.map((key) => parseEntryMetaKey(key)?.book).filter((book): book is string => !!book);
        const canon = this.io.canonBook();
        if (canon) books.push(canon);
        return [...new Set(books)];
    }

    /** Indexed entries with a passport for the keys, overrides first, deduplicated, at most maxPerScene. */
    resolve(keys: readonly string[]): IndexedEntry[] {
        const canonBook = this.io.canonBook();
        const canon = canonBook ? this.books.get(canonBook) : undefined;
        const found: IndexedEntry[] = [];
        for (const key of keys) {
            const parsed = parseEntryMetaKey(key);
            if (!parsed) continue;
            let item = this.books.get(parsed.book)?.entries.get(parsed.uid);
            const override = canon?.overrides.get(key);
            const replaced = override !== undefined ? canon?.entries.get(override) : undefined;
            if (replaced?.record) item = replaced;
            if (item?.record && !isPassportEmpty(item.record.passport)) found.push(item);
        }
        const picks = found.map((item) => ({
            item,
            key: entryMetaKey(item.world, item.uid),
            name:
                typeof item.record?.passport.name === 'string' && item.record.passport.name
                    ? item.record.passport.name
                    : item.name,
            kind: String(item.record?.passport.kind ?? ''),
            aliases: Array.isArray(item.record?.passport.aliases) ? (item.record.passport.aliases as string[]) : [],
        }));
        const limit = Math.max(1, Math.floor(this.settings().maxPerScene || 1));
        return dedupeScene(picks, limit).map((pick) => pick.item);
    }

    /** What NAI Studio receives now (sync: books not read yet are read in the background and join next time). */
    forScene(): SceneItem[] {
        const keys = this.keys();
        void this.ensure(this.booksOf(keys)).catch((error: unknown) => this.log.debug('scene books', error));
        return this.resolve(keys).map((item) => ({
            world: item.world,
            uid: item.uid,
            name: item.name,
            passport: { ...(item.record?.passport ?? {}) },
        }));
    }

    /** NAI Studio's request for the picture of one message. */
    async provide(context: PassportProviderContext | undefined): Promise<NaiPassport[]> {
        if (this.disposed || !this.settings().provider) return [];
        const messageIndex = typeof context?.messageIndex === 'number' ? context.messageIndex : -1;
        const keys = this.keys(typeof context?.text === 'string' ? context.text : undefined, messageIndex);
        await withTimeout(this.ensure(this.booksOf(keys)), PROVIDER_WAIT_MS);
        const items = this.resolve(keys);
        const passports = items.map(
            (item) => toNaiShape(item.world, item.uid, item.name, item.record?.passport ?? {}) as NaiPassport,
        );
        this.sent = {
            at: Date.now(),
            messageIndex,
            passports: passports.map((passport, index) => ({
                world: items[index]!.world,
                uid: items[index]!.uid,
                name: passport.name,
                kind: passport.kind,
            })),
        };
        this.onIndex();
        return passports;
    }

    lastSent(): ScenePassportsSent | null {
        return this.sent;
    }

    resetSent(): void {
        this.sent = null;
    }

    /* ---------------------------------------------------------------- NAI Studio provider */

    /**
     * Registers (or re-registers, or drops) the provider to match what is on now: NAI Studio's API with
     * `registerPassportProvider` and the provider setting. Cheap: called on chat changes and after replies.
     */
    syncProvider(): void {
        if (this.disposed) return;
        const nai = naiHooks(this.app);
        const wanted = typeof nai?.registerPassportProvider === 'function' && this.settings().provider;
        let api: unknown;
        try {
            api = typeof nai?.api === 'function' ? nai.api() : undefined;
        } catch {
            api = undefined;
        }
        if (this.registered && (!wanted || this.registered.api !== api)) this.dropProvider();
        if (!wanted || this.registered || !nai?.registerPassportProvider) return;
        // NAI Studio's API is not published (yet, or it is off): it holds no registrations; try again later.
        if (typeof nai.api === 'function' && !api) return;
        try {
            const off = nai.registerPassportProvider({
                id: PROVIDER_ID,
                priority: PROVIDER_PRIORITY,
                passports: (context) => this.provide(context),
            });
            this.registered = { api, off: typeof off === 'function' ? off : () => {} };
            this.log.debug('NAI Studio passport provider registered');
        } catch (error) {
            this.log.warn('NAI Studio passport provider was not registered', error);
        }
    }

    providerRegistered(): boolean {
        return this.registered !== null;
    }

    /** NAI Studio offers passport providers (0.12.0+). */
    providerSupported(): boolean {
        return typeof naiHooks(this.app)?.registerPassportProvider === 'function';
    }

    private dropProvider(): void {
        const registered = this.registered;
        this.registered = null;
        if (!registered) return;
        try {
            registered.off();
        } catch (error) {
            this.log.debug('passport provider unregistration failed', error);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.dropProvider();
        this.books.clear();
        this.loading.clear();
    }
}
