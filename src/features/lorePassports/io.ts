// Where a lore passport lives and how it is written (M28 п. 1, P2, P13, plan §10 lorebook writes):
// - Maestro and canon books: inside the entry (`extensions.maestro.passport`), through the Lore Studio's LoreStore
//   when it runs (one save queue, history, journal with undo, ST editor reload, DES cache reset), else straight
//   through `saveWorldInfo(name, data, true)` + `reloadWorldInfoEditor` + DES Lore Library cache reset;
// - base books: in the bookRoles sidecar record of the entry (other keys of the record, e.g. the type, are kept);
// - BunnyMo core and packs: never (P13).
import { adaptersOf } from '../../adapters';
import { withPassport, withSidecarPassport } from '../../domain/lore-passport';
import type { PassportRecord } from '../../domain/lore-passport';
import type { App, Logger } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { CanonApi } from '../canon/api';
import type { LoreStore, WiEntry } from '../loreStudio/store-api';
import type { PassportPlace } from './api';

export type Dict = Record<string, unknown>;

export interface BookData {
    entries: Record<string, Dict>;
    [key: string]: unknown;
}

export function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** An error whose message is already translated; `code` for callers that branch on it. */
export class PassportError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
    }
}

/** Canon items carry a CanonMeta in `extensions.maestro` (kind + status): such an entry belongs to a canon book. */
export function hasCanonMeta(entry: unknown): boolean {
    if (!isDict(entry) || !isDict(entry.extensions) || !isDict(entry.extensions.maestro)) return false;
    const meta = entry.extensions.maestro;
    return typeof meta.kind === 'string' && typeof meta.status === 'string';
}

/** How an entry write went: through the LoreStore (it journals itself) or straight into the book. */
export type WriteWay = 'store' | 'direct';

export class PassportIo {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private api<T>(key: string): T | undefined {
        try {
            return this.app.modules.api<T>(key);
        } catch {
            return undefined;
        }
    }

    /** The Lore Studio's data layer when it runs and looks like one. */
    store(): LoreStore | undefined {
        const store = this.api<LoreStore>('loreStore');
        return typeof store?.load === 'function' && typeof store.updateEntry === 'function' ? store : undefined;
    }

    roles(): BookRolesApi | undefined {
        const roles = this.api<BookRolesApi>('bookRoles');
        return typeof roles?.setEntryMeta === 'function' ? roles : undefined;
    }

    canon(): CanonApi | undefined {
        return this.api<CanonApi>('canon');
    }

    /** The canon book of the open chat (null without a chat or the canon module). */
    canonBook(): string | null {
        const canon = this.canon();
        if (!canon || !this.app.host.chatId()) return null;
        try {
            return canon.bookName();
        } catch {
            return null;
        }
    }

    t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- reading */

    /** A deep copy of a book (never ST's cache object); null when it does not exist. */
    async loadBook(world: string): Promise<BookData | null> {
        const store = this.store();
        let raw: unknown;
        if (store) {
            raw = await store.load(world);
        } else {
            const ctx = this.app.host.ctx();
            if (typeof ctx.loadWorldInfo !== 'function') return null;
            raw = await ctx.loadWorldInfo(world);
            if (isDict(raw)) raw = jsonCopy(raw);
        }
        if (!isDict(raw)) return null;
        if (!isDict(raw.entries)) raw.entries = {};
        return raw as BookData;
    }

    async loadEntry(world: string, uid: number): Promise<Dict | null> {
        const entry = (await this.loadBook(world))?.entries[String(uid)];
        return isDict(entry) ? entry : null;
    }

    /** Where the passports of a book's entries live (an entry carrying canon meta is always a canon entry). */
    place(world: string, entry?: unknown): PassportPlace {
        const roles = this.roles();
        let role: string | undefined;
        try {
            role = roles?.roleOf(world)?.role;
        } catch {
            role = undefined;
        }
        if (role === 'bunnymo.core' || role === 'bunnymo.pack' || this.isBunnyMoBook(world)) return 'bunnymo';
        if (role === 'canon' || role === 'maestro' || world === this.canonBook() || hasCanonMeta(entry)) return 'entry';
        return roles ? 'sidecar' : 'noRegistry';
    }

    /** BunnyMo books the adapter sees (also without the roles module). */
    private isBunnyMoBook(world: string): boolean {
        try {
            const books = adaptersOf(this.app).bunnymo?.books?.();
            return !!books && (books.core.includes(world) || books.packs.includes(world));
        } catch {
            return false;
        }
    }

    /** The sidecar record of a base entry (only while it still belongs to the entry's text). */
    async readSidecar(world: string, uid: number): Promise<Dict | undefined> {
        const roles = this.roles();
        if (!roles) return undefined;
        const meta = roles.loadEntryMeta
            ? await roles.loadEntryMeta<Dict>(world, uid)
            : roles.entryMeta<Dict>(world, uid);
        return isDict(meta) ? meta : undefined;
    }

    /* ---------------------------------------------------------------- writing */

    /** Sets (null: removes) the passport inside the entry; returns how it was written. */
    async writeEntry(world: string, uid: number, record: PassportRecord | null, summary: string): Promise<WriteWay> {
        const store = this.store();
        if (store) {
            const entry = await this.loadEntry(world, uid);
            if (!entry) throw new PassportError(this.t('m28.error.missing', { book: world, uid }), 'missing');
            const extensions = withPassport(entry.extensions, record);
            await store.updateEntry(world, uid, { extensions } as Partial<WiEntry>, { module: 'M28', summary });
            return 'store';
        }
        const ctx = this.app.host.ctx();
        if (typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') {
            throw new PassportError(this.t('m28.error.noWriter'), 'noWriter');
        }
        const data = await this.loadBook(world);
        const entry = data?.entries[String(uid)];
        if (!data || !isDict(entry)) {
            throw new PassportError(this.t('m28.error.missing', { book: world, uid }), 'missing');
        }
        const extensions = withPassport(entry.extensions, record);
        if (extensions === undefined) delete entry.extensions;
        else entry.extensions = extensions;
        await ctx.saveWorldInfo(world, data, true);
        try {
            this.app.host.ctx().reloadWorldInfoEditor?.(world);
        } catch (error) {
            this.log.debug('lorebook editor reload failed', error);
        }
        try {
            adaptersOf(this.app).des.invalidateLoreCache(world);
        } catch (error) {
            this.log.debug('DES Lore Library cache reset failed', error);
        }
        return 'direct';
    }

    /** Sets (null: removes) the passport in the entry's sidecar record, keeping its other keys. */
    async writeSidecar(world: string, uid: number, record: PassportRecord | null): Promise<void> {
        const roles = this.roles();
        if (!roles) throw new PassportError(this.t('m28.error.noRegistry'), 'noRegistry');
        const current = await this.readSidecar(world, uid);
        await roles.setEntryMeta(world, uid, withSidecarPassport(current, record));
    }
}
