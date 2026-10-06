// Write tools over lorebooks (M33 «записи лора», «паспорта»): entries through the Lore Studio's store (M23,
// app.modules.api('loreStore') — queued saves, ST's editor and DES's cache refreshed, journaled with undo), passports
// through the passports module (M28, journaled there). BunnyMo books are never written (P13): their role (M35), the
// BunnyMo adapter and the book's content are all checked. Typed entries (domain/entry-types.ts) keep their type where
// the Lore Studio keeps it: in the entry for Maestro and canon books, in the book roles registry for base books (P2).
import {
    ArgError,
    clip,
    isDict,
    optObject,
    optString,
    pickName,
    reqInt,
    reqObject,
    reqString,
    sameJson,
} from '../../../../domain/assistant-write-args';
import type { Dict } from '../../../../domain/assistant-write-args';
import {
    changedFields,
    changedNames,
    composedContent,
    defaultTitle,
    entryPatch,
    entryTypedMeta,
    entryView,
    readEntryChanges,
    typeCatalogue,
    typedMetaOf,
    WI_POSITION_NAMES,
} from '../../../../domain/assistant-write-lore';
import { isBunnyMoBook } from '../../../../domain/doctor-fixes';
import type { BookData } from '../../../../domain/doctor-fixes';
import { readTypedMeta, sameTypedMeta, TYPED_FIELDS_KEY, withTypedMeta } from '../../../../domain/entry-types';
import type { TypedEntryMeta } from '../../../../domain/entry-types';
import { fixPassport, normalizePassport, validatePassport } from '../../../../domain/lore-passport';
import type { PassportIssue } from '../../../../domain/lore-passport';
import { entryTitle } from '../../../../domain/lore-studio-entries';
import { adaptersOf } from '../../../../adapters';
import type { App } from '../../../../shared/contracts';
import type { BookRolesApi } from '../../../bookRoles/api';
import type { CanonApi } from '../../../canon/api';
import type { LorePassportsApi } from '../../../lorePassports/api';
import type { LoreStore, WiBookData, WiEntry } from '../../../loreStudio/store-api';
import type { ToolSpec } from '../../api';
import { argsOf, ASSISTANT_MODULE, failure, planWith } from './common';
import type { Say } from './strings';

const MAX_UID = 1_000_000_000;

function loreStoreOf(app: App): LoreStore | undefined {
    return app.modules.api<LoreStore>('loreStore');
}

function rolesOf(app: App): BookRolesApi | undefined {
    return app.modules.api<BookRolesApi>('bookRoles');
}

/** BunnyMo core or pack (P13): by its role, the BunnyMo adapter, or the book's content. */
function isBunnyMo(app: App, book: string, data: WiBookData | null): boolean {
    try {
        const role = rolesOf(app)?.roleOf(book)?.role;
        if (role === 'bunnymo.core' || role === 'bunnymo.pack') return true;
    } catch (error) {
        app.log.debug('assistant: role check failed', error);
    }
    try {
        const books = adaptersOf(app).bunnymo.books();
        if (books.core.includes(book) || books.packs.includes(book)) return true;
    } catch {
        // the adapter is absent in this build or not ready
    }
    return !!data && isDict(data.entries) && isBunnyMoBook(book, data as unknown as BookData);
}

/** A book the Lore Studio shows and may write, with its data; throws a user-language Error otherwise. */
async function writableBook(
    app: App,
    store: LoreStore,
    wanted: string,
    say: Say,
): Promise<{ book: string; data: WiBookData }> {
    const pick = pickName(store.books(), wanted);
    if (pick.ambiguous) throw failure(say, 'loreAmbiguous', { book: wanted });
    if (!pick.name) throw failure(say, 'loreNoBook', { book: wanted });
    const book = pick.name;
    const data = await store.load(book);
    if (!data) throw failure(say, 'loreNoBook', { book });
    if (isBunnyMo(app, book, data)) throw failure(say, 'loreBunnyMo', { book });
    if (rolesOf(app)?.roleOf(book)?.readOnly) throw failure(say, 'loreReadOnly', { book });
    return { book, data };
}

type TypedStorage = 'entry' | 'sidecar' | 'none';

/** Where a typed entry of this book keeps its type (the Lore Studio's rule). */
function typedStorage(app: App, book: string): TypedStorage {
    const roles = rolesOf(app);
    const role = roles?.roleOf(book)?.role;
    if (role === 'maestro' || role === 'canon') return 'entry';
    try {
        const canon = app.modules.api<CanonApi>('canon');
        if (canon && app.host.chatId() && canon.bookName() === book) return 'entry';
    } catch {
        // no chat
    }
    return roles ? 'sidecar' : 'none';
}

async function loadSidecar(roles: BookRolesApi, book: string, uid: number): Promise<Dict | undefined> {
    try {
        const meta = roles.loadEntryMeta
            ? await roles.loadEntryMeta<Dict>(book, uid)
            : roles.entryMeta<Dict>(book, uid);
        return isDict(meta) ? meta : undefined;
    } catch {
        return undefined;
    }
}

const ENTRY_FIELDS_SCHEMA = {
    title: { type: 'string', description: 'The entry title (memo).' },
    content: { type: 'string', description: 'The entry text (English for canon books).' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords.' },
    secondaryKeys: { type: 'array', items: { type: 'string' }, description: 'Optional filter keywords.' },
    constant: { type: 'boolean', description: 'Always in the prompt, no keys needed.' },
    enabled: { type: 'boolean', description: 'false switches the entry off.' },
    position: { type: 'string', enum: [...WI_POSITION_NAMES], description: 'Where the entry goes in the prompt.' },
    depth: { type: 'integer', minimum: 0, description: 'Depth for at_depth.' },
    order: { type: 'integer', minimum: 0, description: 'Insertion order (higher goes later).' },
    type: { type: 'string', description: 'Entry type: the content is composed from `fields`.' },
    fields: { type: 'object', description: 'Field values of the type (by field id).' },
} as const;

/** Reads `type`/`fields` of the arguments into a typed meta (null when neither is given). */
function readTyped(args: Dict, current: TypedEntryMeta | null): TypedEntryMeta | null {
    const type = optString(args, 'type', { max: 40 });
    const fields = optObject(args, 'fields');
    if (type === undefined && fields === undefined) return null;
    const kind = type ?? current?.type;
    if (!kind) throw new ArgError('loreTypeNeeded');
    return typedMetaOf(kind, fields, current);
}

/* ------------------------------------------------------------------ lore_entry_create */

export function loreEntryCreateTool(): ToolSpec {
    return {
        name: 'lore_entry_create',
        kind: 'write',
        description:
            'Creates a lorebook entry in a book the Lore Studio shows (never in BunnyMo books). Give `content`, or ' +
            '`type` with `fields` and the content is composed from them. Types and their fields: ' +
            `${typeCatalogue()}. Keys are required unless constant is true. depth alone means «in the chat at that ` +
            'depth».',
        parameters: {
            type: 'object',
            properties: { book: { type: 'string', description: 'Book name.' }, ...ENTRY_FIELDS_SCHEMA },
            required: ['book'],
            additionalProperties: false,
        },
        available: (app) => loreStoreOf(app) !== undefined,
        plan: (raw, ctx) =>
            planWith(ctx, async (say) => {
                const app = ctx.app;
                const store = loreStoreOf(app);
                if (!store) throw failure(say, 'loreUnavailable');
                const args = argsOf(raw);
                const wanted = reqString(args, 'book', { max: 200 });
                const changes = readEntryChanges(args);
                const meta = readTyped(args, null);
                const { book } = await writableBook(app, store, wanted, say);
                if (meta && changes.content === undefined) changes.content = composedContent(meta);
                if (!changes.content?.trim()) throw failure(say, 'loreNoContent');
                if (!changes.keys?.length && changes.constant !== true) throw failure(say, 'loreNoKeys');
                changes.title = defaultTitle(changes, meta) || say('m33w.lore.untitled');
                const storage = meta ? typedStorage(app, book) : 'none';
                const patch = entryPatch(changes);
                if (meta && storage === 'entry') patch.extensions = withTypedMeta(undefined, meta);
                const title = changes.title;
                const after: Dict = entryView(patch);
                if (meta) after.type = meta.type;
                if (meta && storage === 'none') after.notes = [say('m33w.lore.typedNone')];
                return {
                    summary: say('m33w.lore.summary.create', { title, book }),
                    target: say('m33w.target.loreNew', { book }),
                    before: null,
                    after,
                    async apply() {
                        const live = loreStoreOf(app);
                        if (!live) throw failure(say, 'loreUnavailable');
                        // The store journals the new entry (undo removes it).
                        const uid = await live.createEntry(book, patch as Partial<WiEntry>, {
                            module: ASSISTANT_MODULE,
                            summary: say('m33w.lore.journal.create', { title }),
                        });
                        const roles = rolesOf(app);
                        if (meta && storage === 'sidecar' && roles) {
                            await roles.setEntryMeta(book, uid, {
                                type: meta.type,
                                [TYPED_FIELDS_KEY]: { ...meta.fields },
                            });
                        }
                        return { result: { book, uid } };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ lore_entry_update */

export function loreEntryUpdateTool(): ToolSpec {
    return {
        name: 'lore_entry_update',
        kind: 'write',
        description:
            'Changes fields of an existing lorebook entry (book + uid, see lore_search / lore_entry) in a book the ' +
            'Lore Studio shows (never in ' +
            'BunnyMo books). `changes` holds only what changes; keys lists replace the old ones. For a typed entry ' +
            'give `fields` (merged with the current values) and the content is composed again unless `content` ' +
            'is given.',
        parameters: {
            type: 'object',
            properties: {
                book: { type: 'string', description: 'Book name.' },
                uid: { type: 'integer', minimum: 0, description: 'Entry uid.' },
                changes: {
                    type: 'object',
                    description: 'Only the fields that change.',
                    properties: { ...ENTRY_FIELDS_SCHEMA },
                    additionalProperties: false,
                },
            },
            required: ['book', 'uid', 'changes'],
            additionalProperties: false,
        },
        available: (app) => loreStoreOf(app) !== undefined,
        plan: (raw, ctx) =>
            planWith(ctx, async (say) => {
                const app = ctx.app;
                const store = loreStoreOf(app);
                if (!store) throw failure(say, 'loreUnavailable');
                const args = argsOf(raw);
                const wanted = reqString(args, 'book', { max: 200 });
                const uid = reqInt(args, 'uid', 0, MAX_UID);
                const input = reqObject(args, 'changes');
                const changes = readEntryChanges(input);
                const { book, data } = await writableBook(app, store, wanted, say);
                const entry = data.entries[String(uid)] as Dict | undefined;
                if (!isDict(entry)) throw failure(say, 'loreNoEntry', { book, uid });
                const roles = rolesOf(app);
                const storage: TypedStorage = entryTypedMeta(entry) ? 'entry' : typedStorage(app, book);
                const sidecar = storage === 'sidecar' && roles ? await loadSidecar(roles, book, uid) : undefined;
                const current = storage === 'entry' ? entryTypedMeta(entry) : readTypedMeta(sidecar);
                const meta = readTyped(input, current);
                if (meta && changes.content === undefined) changes.content = composedContent(meta);
                if (changes.content !== undefined && !changes.content.trim()) throw failure(say, 'loreNoContent');
                const patch = entryPatch(changes);
                if (meta && storage === 'entry') patch.extensions = withTypedMeta(entry.extensions, meta);
                const diff = changedFields(entry, patch);
                const metaChanged = meta !== null && !sameTypedMeta(meta, current);
                const changedKeys = Object.keys(diff.after);
                if (!changedKeys.length && !metaChanged) throw failure(say, 'loreNothing');
                const before = entryView(diff.before);
                const after = entryView(diff.after);
                if (metaChanged && meta) {
                    before.type = current?.type ?? null;
                    before.fields = current?.fields ?? null;
                    after.type = meta.type;
                    after.fields = meta.fields;
                }
                const title = clip(entryTitle(entry as WiEntry) || `#${uid}`, 80);
                const names = [...changedNames(diff.after), ...(metaChanged ? ['type'] : [])];
                const realPatch: Dict = {};
                for (const key of changedKeys) realPatch[key] = patch[key];
                return {
                    summary: say('m33w.lore.summary.update', { title, book, fields: [...new Set(names)].join(', ') }),
                    target: say('m33w.target.loreEntry', { book, uid }),
                    before,
                    after,
                    async apply() {
                        const live = loreStoreOf(app);
                        if (!live) throw failure(say, 'loreUnavailable');
                        if (Object.keys(realPatch).length) {
                            await live.updateEntry(book, uid, realPatch as Partial<WiEntry>, {
                                module: ASSISTANT_MODULE,
                                summary: say('m33w.lore.journal.update', { title }),
                            });
                        }
                        const liveRoles = rolesOf(app);
                        if (storage === 'sidecar' && liveRoles) {
                            // The registry record is bound to the content hash: new text re-binds it (as the form).
                            const keeps = current !== null || sidecar?.passport !== undefined;
                            if (metaChanged || (keeps && 'content' in realPatch)) {
                                const record: Dict = { ...(sidecar ?? {}) };
                                if (meta) {
                                    record.type = meta.type;
                                    record[TYPED_FIELDS_KEY] = { ...meta.fields };
                                }
                                await liveRoles.setEntryMeta(
                                    book,
                                    uid,
                                    Object.keys(record).length ? record : undefined,
                                );
                            }
                        }
                        return { result: { book, uid } };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ passport_set */

function issueText(say: Say, issue: PassportIssue): string {
    return say(`m33w.passport.issue.${issue.code}`, { field: issue.field || 'passport', tag: issue.tag ?? '' });
}

export function passportSetTool(): ToolSpec {
    return {
        name: 'passport_set',
        kind: 'write',
        description:
            "Sets the visual passport (NAI Studio's format) of a lorebook entry: kind (character, location, object, " +
            'world, scenario), name, aliases, tags, slots {base, hair, eyes, body, skin, clothing, accessories, ' +
            'style}, outfits [{name, tags}], states [{id, tags, enabled}], nsfw {enabled, tags}, negative. Tags are ' +
            'English, lower case, comma-separated (they are tidied before the card). Never for BunnyMo books.',
        parameters: {
            type: 'object',
            properties: {
                book: { type: 'string', description: 'Book name.' },
                uid: { type: 'integer', minimum: 0, description: 'Entry uid.' },
                passport: { type: 'object', description: 'The passport (NAI Studio fields).' },
            },
            required: ['book', 'uid', 'passport'],
            additionalProperties: false,
        },
        available: (app) => app.modules.api<LorePassportsApi>('lorePassports') !== undefined,
        plan: (raw, ctx) =>
            planWith(ctx, async (say) => {
                const app = ctx.app;
                const api = app.modules.api<LorePassportsApi>('lorePassports');
                if (!api) throw failure(say, 'passportUnavailable');
                const args = argsOf(raw);
                let book = reqString(args, 'book', { max: 200 });
                const uid = reqInt(args, 'uid', 0, MAX_UID);
                const passport = reqObject(args, 'passport');
                let entryName = `#${uid}`;
                const store = loreStoreOf(app);
                if (store) {
                    const found = await writableBook(app, store, book, say);
                    book = found.book;
                    const entry = found.data.entries[String(uid)];
                    if (!isDict(entry)) throw failure(say, 'loreNoEntry', { book, uid });
                    entryName = clip(entryTitle(entry) || entryName, 80);
                } else if (isBunnyMo(app, book, null)) {
                    throw failure(say, 'loreBunnyMo', { book });
                }
                const place = await api.storageOf?.(book);
                if (place === 'bunnymo') throw failure(say, 'loreBunnyMo', { book });
                if (place === 'noRegistry') throw failure(say, 'passportNoRegistry');
                const normal = normalizePassport(passport);
                if (!normal) throw failure(say, 'passportInvalid');
                const fixed = fixPassport(normal);
                const issues = validatePassport(fixed);
                const errors = issues.filter((issue) => issue.level === 'error');
                if (errors.length) {
                    const texts = errors.slice(0, 5).map((issue) => issueText(say, issue));
                    throw failure(say, 'passportIssues', { issues: texts.join('; ') });
                }
                const notes: string[] = [];
                if (!sameJson(fixed, normal)) notes.push(say('m33w.passport.fixed'));
                if (issues.some((issue) => issue.code === 'empty')) notes.push(say('m33w.passport.empty'));
                const previous = await api.get(book, uid);
                const after: Dict = { ...fixed };
                if (notes.length) after.notes = notes;
                return {
                    summary: say('m33w.passport.summary', { entry: entryName, book }),
                    target: say('m33w.target.passport', { book, uid }),
                    before: previous?.passport ?? null,
                    after,
                    async apply() {
                        const live = app.modules.api<LorePassportsApi>('lorePassports');
                        if (!live) throw failure(say, 'passportUnavailable');
                        // The passports module journals the change with undo.
                        await live.set(book, uid, fixed, 'model');
                        return { result: { book, uid } };
                    },
                };
            }),
    };
}
