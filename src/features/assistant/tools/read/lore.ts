// Read tools over lorebooks and the chat canon (M33): search entries of the active books, read one entry with all its
// activation fields, list the canon. Everything here is book text: untrusted.
import { normalizeText, scoreTopic, snippetOf, stems } from '../../../../domain/assistant-docs';
import type { DocTopic } from '../../../../domain/assistant-docs';
import type { App } from '../../../../shared/contracts';
import type { BookRolesApi } from '../../../bookRoles/api';
import type { CanonApi, CanonItem, CanonKind, CanonStatus } from '../../../canon/api';
import type { LorePassportsApi } from '../../../lorePassports/api';
import type { ToolSpec } from '../../api';
import {
    activeBooks,
    allBooks,
    apiOf,
    argsOf,
    canReadLore,
    capList,
    compact,
    cut,
    enumArg,
    intArg,
    isDict,
    keysOf,
    loadBook,
    needsApi,
    notice,
    objectSchema,
    optIntArg,
    prop,
    readTool,
    safely,
    say,
    strArg,
    withTimeout,
} from './common';
import type { Dict } from './common';

const MAX_BOOKS = 30;

/** WI position names (world_info_position). */
const POSITIONS = [
    'before char',
    'after char',
    "author's note top",
    "author's note bottom",
    'at depth',
    'examples top',
    'examples bottom',
    'outlet',
];
const ROLES = ['system', 'user', 'assistant'];
const LOGIC = ['AND ANY', 'NOT ALL', 'NOT ANY', 'AND ALL'];

function entryTopic(book: string, uid: string, entry: Dict): DocTopic {
    return {
        id: `${book}#${uid}`,
        kind: 'readme',
        title: { en: typeof entry.comment === 'string' ? entry.comment : '' },
        keywords: [...keysOf(entry.key), ...keysOf(entry.keysecondary)],
        body: { en: typeof entry.content === 'string' ? entry.content : '' },
    };
}

const loreSearch = (app: App): ToolSpec =>
    readTool({
        name: 'lore_search',
        description:
            'Search lorebook entries (by default the books active in this chat; or one book) by words in their keys, title and text — Russian and English, case forms tolerated. Returns book, uid, title, keys, flags and a snippet; read the full entry with lore_entry.',
        parameters: objectSchema(
            {
                query: prop.string('Words to look for (a name, a term, a phrase).'),
                book: prop.string('Search only this lorebook (exact name).'),
                limit: prop.integer('Hits (1-20, default 10).', { minimum: 1, maximum: 20 }),
            },
            ['query'],
        ),
        available: canReadLore,
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const query = strArg(args, 'query', 200);
            if (!query) return notice(ctx, 'Give a query.', 'Нужен запрос.');
            const limit = intArg(args, 'limit', 10, 1, 20);
            const only = strArg(args, 'book', 200);
            let books = only ? [only] : await activeBooks(app);
            if (!books.length) books = allBooks(app);
            const terms = [...new Set(stems(query))];
            const phrase = normalizeText(query).replace(/\s+/g, ' ').trim();
            const hits: Dict[] = [];
            let scanned = 0;
            for (const book of books.slice(0, MAX_BOOKS)) {
                const data = await loadBook(app, book);
                if (!data) continue;
                scanned += 1;
                for (const [uid, entry] of Object.entries(data.entries)) {
                    if (!isDict(entry)) continue;
                    const topic = entryTopic(book, uid, entry);
                    const score = terms.length ? scoreTopic(topic, terms, phrase) : 0;
                    if (score <= 0) continue;
                    hits.push(
                        compact({
                            book,
                            uid: Number(uid),
                            title: cut(entry.comment, 80),
                            keys: keysOf(entry.key).slice(0, 6),
                            disabled: entry.disable === true || undefined,
                            constant: entry.constant === true || undefined,
                            score,
                            snippet: snippetOf(topic.body.en ?? '', terms, 200),
                        }),
                    );
                }
            }
            hits.sort((a, b) => (b.score as number) - (a.score as number));
            const list = capList(hits, limit);
            return {
                data: { query, books: scanned, hits: list.items, total: list.total },
                untrusted: true,
                summary: say(
                    ctx,
                    `Lore search «${cut(query, 40)}»: ${list.total} hits`,
                    `Поиск по лору «${cut(query, 40)}»: найдено ${list.total}`,
                ),
            };
        },
    });

const loreEntry = (app: App): ToolSpec =>
    readTool({
        name: 'lore_entry',
        description:
            'Read one lorebook entry: title, primary and secondary keys with their logic, constant/disabled, position, depth, role, order, probability, inclusion group, sticky/cooldown/delay, scan depth, case/whole-word settings, character filter, the text (capped), the book role and Maestro metadata (type, canon, passport).',
        parameters: objectSchema(
            {
                book: prop.string('Lorebook name (exact).'),
                uid: prop.integer('Entry uid inside the book.', { minimum: 0 }),
            },
            ['book', 'uid'],
        ),
        available: canReadLore,
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const book = strArg(args, 'book', 200);
            const uid = optIntArg(args, 'uid');
            if (!book || uid === undefined) return notice(ctx, 'Give book and uid.', 'Нужны книга и uid.');
            const data = await loadBook(app, book);
            const entry = data?.entries[String(uid)];
            if (!entry) {
                return notice(ctx, `No entry ${uid} in «${book}».`, `В «${book}» нет записи ${uid}.`);
            }
            const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
            const filter = isDict(entry.characterFilter) ? entry.characterFilter : null;
            const filterNames = filter ? [...keysOf(filter.names), ...keysOf(filter.tags)] : [];
            const maestro =
                isDict(entry.extensions) && isDict(entry.extensions.maestro) ? entry.extensions.maestro : null;
            const role = safely(() => apiOf<BookRolesApi>(app, 'bookRoles')?.roleOf(book), undefined);
            const passports = apiOf<LorePassportsApi>(app, 'lorePassports');
            const passport = passports ? await withTimeout(passports.get(book, uid), 2000, null) : null;
            const position = num(entry.position);
            const content = typeof entry.content === 'string' ? entry.content : '';
            return {
                data: compact({
                    book,
                    uid,
                    bookRole: role ? compact({ role: role.role, readOnly: role.readOnly || undefined }) : undefined,
                    title: cut(entry.comment, 120),
                    keys: keysOf(entry.key).slice(0, 30),
                    secondaryKeys: keysOf(entry.keysecondary).length
                        ? keysOf(entry.keysecondary).slice(0, 30)
                        : undefined,
                    logic: keysOf(entry.keysecondary).length ? LOGIC[num(entry.selectiveLogic) ?? 0] : undefined,
                    constant: entry.constant === true || undefined,
                    disabled: entry.disable === true || undefined,
                    position: position === undefined ? undefined : (POSITIONS[position] ?? position),
                    depth: position === 4 ? num(entry.depth) : undefined,
                    role: position === 4 && num(entry.role) !== undefined ? ROLES[num(entry.role) ?? 0] : undefined,
                    order: num(entry.order),
                    probability: entry.useProbability !== false ? num(entry.probability) : undefined,
                    group: typeof entry.group === 'string' && entry.group ? entry.group : undefined,
                    sticky: num(entry.sticky) || undefined,
                    cooldown: num(entry.cooldown) || undefined,
                    delay: num(entry.delay) || undefined,
                    scanDepth: num(entry.scanDepth),
                    caseSensitive: typeof entry.caseSensitive === 'boolean' ? entry.caseSensitive : undefined,
                    wholeWords: typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : undefined,
                    excludeRecursion: entry.excludeRecursion === true || undefined,
                    preventRecursion: entry.preventRecursion === true || undefined,
                    recursionOnly: entry.delayUntilRecursion ? true : undefined,
                    characterFilter: filterNames.length
                        ? { exclude: filter?.isExclude === true, names: filterNames.slice(0, 10) }
                        : undefined,
                    maestro: maestro
                        ? compact({
                              type: typeof maestro.type === 'string' ? maestro.type : undefined,
                              canon:
                                  typeof maestro.kind === 'string'
                                      ? `${maestro.kind}/${String(maestro.status)}`
                                      : undefined,
                          })
                        : undefined,
                    passport: passport
                        ? compact({
                              storage: passport.storage,
                              kind: typeof passport.passport.kind === 'string' ? passport.passport.kind : undefined,
                              name: typeof passport.passport.name === 'string' ? passport.passport.name : undefined,
                          })
                        : undefined,
                    chars: content.length,
                    content: cut(content, 3000),
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Entry «${cut(entry.comment, 40) || uid}»`,
                    `Запись «${cut(entry.comment, 40) || uid}»`,
                ),
            };
        },
    });

const CANON_KINDS: readonly CanonKind[] = ['override', 'addition', 'suppress', 'pin'];
const CANON_STATUSES: readonly CanonStatus[] = ['active', 'provisional', 'archived'];

function canonView(item: CanonItem): Dict {
    const entry = item.entry;
    return compact({
        uid: item.uid,
        kind: item.meta.kind,
        status: item.meta.status,
        origin: item.meta.origin,
        type: item.meta.type,
        title: cut(entry.comment, 80),
        keys: keysOf(entry.key).slice(0, 6),
        content: cut(entry.content, 240),
        base: item.meta.base ? `${item.meta.base.world}#${item.meta.base.uid}` : undefined,
        survivedTurns: item.meta.survivedTurns,
        message: item.meta.sourceMessage,
    });
}

const canonList = (app: App): ToolSpec =>
    readTool({
        name: 'canon_list',
        description:
            "The chat canon (Maestro's lorebook of this chat): overrides of base entries, additions, suppressions and pins, with status (active, provisional — invented by the model and not yet confirmed, archived), origin and text; plus the canon budget and what the last scan did with it. Filter by kind, status or words.",
        parameters: objectSchema({
            kind: prop.enum('Only this kind.', CANON_KINDS),
            status: prop.enum('Only this status.', CANON_STATUSES),
            query: prop.string('Only items whose title, keys or text contain these words.'),
            limit: prop.integer('Items (1-40, default 20).', { minimum: 1, maximum: 40 }),
        }),
        available: needsApi('canon'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const canon = apiOf<CanonApi>(app, 'canon');
            if (!canon) return notice(ctx, 'The chat canon is off.', 'Канон чата выключен.');
            const filter: { kind?: CanonKind; status?: CanonStatus } = {};
            const kind = enumArg(args, 'kind', CANON_KINDS);
            const status = enumArg(args, 'status', CANON_STATUSES);
            if (kind) filter.kind = kind;
            if (status) filter.status = status;
            let items = await withTimeout(canon.list(filter), 4000, [] as CanonItem[]);
            const query = strArg(args, 'query', 120);
            if (query) {
                const terms = [...new Set(stems(query))];
                items = items.filter(
                    (item) => scoreTopic(entryTopic('canon', String(item.uid), item.entry), terms) > 0,
                );
            }
            const list = capList(items.map(canonView), intArg(args, 'limit', 20, 1, 40));
            const scan = safely(() => canon.lastScan?.() ?? null, null);
            return {
                data: compact({
                    book: safely(() => canon.bookName(), undefined),
                    budget: safely(() => canon.budget(), undefined),
                    lastScan: scan ?? undefined,
                    items: list.items,
                    total: list.total,
                }),
                untrusted: true,
                summary: say(ctx, `Canon: ${list.total} items`, `Канон: пунктов — ${list.total}`),
            };
        },
    });

export function loreTools(app: App): ToolSpec[] {
    return [loreSearch(app), loreEntry(app), canonList(app)];
}
