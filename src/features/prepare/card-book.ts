// The card's own Maestro book of M37 «Подготовить к игре» (plan-2 §7 п. 6, В12): what the user saved «для персонажа»
// — canon texts of characters, the world, places with their nesting, factions, items, traditions, the calendar,
// secrets and promises — as typed entries of a book with the role 'maestro' that belongs to one card (book-level
// `extensions.maestro = { role, kind: 'prepare', avatar }`). Its entries are disabled: ST never scans the book; a new
// chat of the card imports them («применить сохранённую подготовку»). The user can read and edit them in the Lore
// Studio. Host rules: a fresh copy is loaded, changed and saved at once (saveWorldInfo(name, data, true)), ST's editor
// reloaded and DES's Lore Library cache reset (dossier/book-io); BunnyMo books are never written (P13).
import { uniqueBookName } from '../../domain/canon-book';
import type { CanonEntryDraft } from '../../domain/prepare-apply';
import type { AnyPrepareItem } from '../../domain/prepare-plan';
import { TYPED_FIELDS_KEY } from '../../domain/entry-types';
import { freeUid, templateEntry } from '../../domain/lore-studio-entries';
import type { App, Logger } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import { bookIo } from '../dossier/book-io';
import { apiOf, isDict, safely } from './collect';
import { CARD_BOOK_PREFIX } from './settings';

type Dict = Record<string, unknown>;

/** What a card-book entry holds for the import into a new chat. */
export interface CardBookItem {
    uid: number;
    itemId: string;
    /** The item as saved (its data, the Russian line). */
    item: AnyPrepareItem | null;
    title: string;
    keys: string[];
    content: string;
    type: string;
    fields: Record<string, string>;
}

export interface CardBookWrite {
    book: string;
    uid: number;
    created: boolean;
    before: Dict | null;
    after: Dict;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** The `prepare` record of an entry. */
function prepareMeta(entry: unknown): Dict | null {
    if (!isDict(entry) || !isDict(entry.extensions) || !isDict(entry.extensions.maestro)) return null;
    const meta = entry.extensions.maestro.prepare;
    return isDict(meta) ? meta : null;
}

export class CardBook {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private io() {
        const io = bookIo(this.app, this.log);
        if (!io) throw new Error(this.app.i18n.t('m37.error.noWorldInfo'));
        return io;
    }

    private worldNames(): string[] {
        return safely(() => this.app.host.ctx().getWorldInfoNames?.() ?? [], [] as string[]);
    }

    /** The book of a card: the saved one when it still exists, else a free «Maestro · подготовка · <name>». */
    nameFor(cardName: string, saved?: string | null): string {
        const names = this.worldNames();
        if (saved && names.includes(saved)) return saved;
        return uniqueBookName(`${CARD_BOOK_PREFIX}${cardName}`, names);
    }

    /** P13 and the user's roles: only an absent book or one of role 'maestro'/unknown is written. */
    private writable(book: string): boolean {
        const role = safely(() => apiOf<BookRolesApi>(this.app, 'bookRoles')?.roleOf(book)?.role, undefined);
        return !role || role === 'maestro' || role === 'unknown';
    }

    /** Writes (adds or updates) the entry of an item; the book is created on first use. */
    async put(
        book: string,
        avatar: string,
        item: AnyPrepareItem,
        draft: CanonEntryDraft | null,
    ): Promise<CardBookWrite> {
        if (!this.writable(book)) throw new Error(this.app.i18n.t('m37.error.protectedBook', { book }));
        const io = this.io();
        let data = await io.load(book);
        let created = false;
        if (!data) {
            await io.create(book, {
                entries: {},
                extensions: { maestro: { role: 'maestro', kind: 'prepare', avatar } },
            } as never);
            created = true;
            const roles = apiOf<BookRolesApi>(this.app, 'bookRoles');
            if (roles) {
                try {
                    await roles.setRole(book, 'maestro');
                } catch (error) {
                    this.log.debug('prepare: the card book role was not set', error);
                }
            }
            data = (await io.load(book)) ?? { entries: {} };
        }
        const entries = data.entries;
        const found = Object.entries(entries).find(([, entry]) => str(prepareMeta(entry)?.itemId) === item.id);
        const uid = found ? Number(found[0]) : freeUid(entries);
        const before = found && isDict(found[1]) ? (JSON.parse(JSON.stringify(found[1])) as Dict) : null;
        const title = draft?.title ?? item.id;
        const after: Dict = templateEntry(uid, {
            ...(before ?? {}),
            key: draft?.keys ?? [],
            keysecondary: [],
            comment: title,
            content: draft?.content ?? '',
            disable: true,
            constant: false,
        });
        after.extensions = {
            ...(before && isDict(before.extensions) ? before.extensions : {}),
            maestro: {
                ...(draft ? { type: draft.type, [TYPED_FIELDS_KEY]: { ...draft.fields } } : {}),
                prepare: { itemId: item.id, kind: item.kind, item: JSON.parse(JSON.stringify(item)) as Dict },
            },
        };
        entries[String(uid)] = after as never;
        await io.save(book, data);
        return { book, uid, created, before, after };
    }

    /** Removes an entry written by `put` when it still holds that content (the user's edits are kept). */
    async remove(book: string, uid: number, content: string | null, before: Dict | null): Promise<boolean> {
        const io = this.io();
        const data = await io.load(book);
        const entry = data?.entries[String(uid)];
        if (!data || !isDict(entry)) return true;
        if (content !== null && str(entry.content) !== content) return false;
        if (before) data.entries[String(uid)] = JSON.parse(JSON.stringify(before)) as never;
        else delete data.entries[String(uid)];
        await io.save(book, data);
        return true;
    }

    /** The saved items of a card book (for the import into a new chat). */
    async items(book: string): Promise<CardBookItem[]> {
        let data: { entries: Record<string, unknown> } | null = null;
        try {
            data = await this.io().load(book);
        } catch (error) {
            this.log.debug(`prepare: card book ${book} did not load`, error);
        }
        if (!data) return [];
        const out: CardBookItem[] = [];
        for (const [key, entry] of Object.entries(data.entries)) {
            const meta = prepareMeta(entry);
            if (!meta || !isDict(entry)) continue;
            const maestro =
                isDict(entry.extensions) && isDict(entry.extensions.maestro) ? entry.extensions.maestro : {};
            const typed = isDict(maestro[TYPED_FIELDS_KEY]) ? (maestro[TYPED_FIELDS_KEY] as Dict) : {};
            out.push({
                uid: Number(key),
                itemId: str(meta.itemId),
                item: isDict(meta.item) ? (meta.item as unknown as AnyPrepareItem) : null,
                title: str(entry.comment),
                keys: Array.isArray(entry.key)
                    ? entry.key.filter((value): value is string => typeof value === 'string')
                    : [],
                content: str(entry.content),
                type: str(maestro.type),
                fields: Object.fromEntries(
                    Object.entries(typed).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
                ),
            });
        }
        return out.sort((a, b) => a.uid - b.uid);
    }
}
