// M1 «Журнал лора», pure parts: stack tags of activated entries, the reasons a lorebook is active, the compact
// per-chat storage of turn records with running counters, and the chat summaries.
//
// Storage is compact on purpose: a big world book activates dozens of entries per turn and the journal keeps
// hundreds of turns, written after every reply. Activations are tuples, world names and entry titles are
// stored once (plan §2.1: the lore journal is kept "longer, by volume").
import type { ActivationRow, LoreRecordRow, LoreTagId } from './lore-scan';

/* ------------------------------------------------------------------ tags */

/** Canon books of M6: "Maestro · канон · <short id>" (src/features/canon/api.ts). */
export const CANON_BOOK_PREFIX = 'Maestro · канон';
/** Every lorebook Maestro creates starts with this. */
export const MAESTRO_BOOK_PREFIX = 'Maestro · ';

/** Tag order (also the bit order of the stored tag mask). */
export const LORE_TAG_ORDER: readonly LoreTagId[] = [
    'bunnymo.core',
    'bunnymo.pack',
    'ck.archive',
    'localizer',
    'des.book',
    'canon',
    'maestro.book',
    'constant',
];

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

export interface TagContext {
    bunnymoCore: ReadonlySet<string>;
    bunnymoPacks: ReadonlySet<string>;
    ckRepos: ReadonlySet<string>;
    desBooks: ReadonlySet<string>;
}

/** Canon items carry `extensions.maestro` with a `kind` (CanonMeta); overrides keep the base book's name. */
export function isCanonMeta(extensions: unknown): boolean {
    return isDict(extensions) && isDict(extensions.maestro) && typeof extensions.maestro.kind === 'string';
}

export function tagsFor(
    entry: { world: string; constant: boolean; extensions?: unknown },
    context: TagContext,
    hasLocalizerMarker: boolean,
): LoreTagId[] {
    const tags: LoreTagId[] = [];
    if (context.bunnymoCore.has(entry.world)) tags.push('bunnymo.core');
    else if (context.bunnymoPacks.has(entry.world)) tags.push('bunnymo.pack');
    if (context.ckRepos.has(entry.world)) tags.push('ck.archive');
    if (hasLocalizerMarker) tags.push('localizer');
    if (context.desBooks.has(entry.world)) tags.push('des.book');
    const canon = entry.world.startsWith(CANON_BOOK_PREFIX) || isCanonMeta(entry.extensions);
    if (canon) tags.push('canon');
    else if (entry.world.startsWith(MAESTRO_BOOK_PREFIX)) tags.push('maestro.book');
    if (entry.constant) tags.push('constant');
    return tags;
}

export function tagMask(tags: readonly LoreTagId[]): number {
    let mask = 0;
    LORE_TAG_ORDER.forEach((tag, bit) => {
        if (tags.includes(tag)) mask |= 1 << bit;
    });
    return mask;
}

export function tagsOfMask(mask: number): LoreTagId[] {
    return LORE_TAG_ORDER.filter((_, bit) => (mask & (1 << bit)) !== 0);
}

/* ------------------------------------------------------------------ why a book is active */

export type BookReasonId =
    | 'global'
    | 'character'
    | 'characterExtra'
    | 'chat'
    | 'persona'
    | 'desCampaign'
    | 'desAutoLink'
    | 'ckConnector'
    | 'workshop'
    | 'canon';

/** Books DES switched on (research/des.md §3). */
export interface DesLinks {
    /** The active campaign's books and the campaign ledger (`campaignActivated`). */
    campaign: string[];
    /** Books of every campaign (for the "DES book" tag). */
    campaignAll: string[];
    /** Auto-link by character name ledger (`autoLinked`). */
    autoLinked: string[];
    /** Workshop "Inject into Scene" books (`characterInjection[name].lorebook`), never switched off by DES. */
    workshop: string[];
}

export function desLinkedBooks(settings: unknown): DesLinks {
    const links: DesLinks = { campaign: [], campaignAll: [], autoLinked: [], workshop: [] };
    if (!isDict(settings)) return links;
    const lorebook = isDict(settings.lorebook) ? settings.lorebook : {};
    const campaigns = isDict(lorebook.campaigns) ? lorebook.campaigns : {};
    const all = new Set<string>();
    for (const campaign of Object.values(campaigns)) {
        if (isDict(campaign)) for (const book of strings(campaign.books)) all.add(book);
    }
    const active = typeof lorebook.activeCampaignId === 'string' ? campaigns[lorebook.activeCampaignId] : undefined;
    const campaign = new Set<string>(strings(lorebook.campaignActivated));
    if (isDict(active)) for (const book of strings(active.books)) campaign.add(book);
    links.campaign = [...campaign];
    links.campaignAll = [...all];
    links.autoLinked = strings(lorebook.autoLinked);
    const injections = isDict(settings.characterInjection) ? settings.characterInjection : {};
    const workshop = new Set<string>();
    for (const injection of Object.values(injections)) {
        if (isDict(injection) && typeof injection.lorebook === 'string' && injection.lorebook) {
            workshop.add(injection.lorebook);
        }
    }
    links.workshop = [...workshop];
    return links;
}

export interface BookSources {
    /** `selected_world_info`. */
    global: string[];
    /** `characters[chid].data.extensions.world` (every member in a group chat). */
    characterPrimary: string[];
    /** `world_info.charLore[].extraBooks` of the current character(s). */
    characterExtra: string[];
    /** `chat_metadata.world_info`. */
    chat?: string;
    /** `power_user.persona_description_lorebook`. */
    persona?: string;
    /** `chat_metadata.carrot_chat_books` (CarrotKernel lorebook connector). */
    ckChatBooks: string[];
    des: DesLinks;
}

export interface BookReasonRow {
    book: string;
    reasons: BookReasonId[];
}

/** Every active book with the reasons it is active, in ST's scan priority: chat, persona, character, global. */
export function bookReasons(sources: BookSources): BookReasonRow[] {
    const rows = new Map<string, BookReasonId[]>();
    const add = (book: string | undefined, reason: BookReasonId): void => {
        if (!book) return;
        const list = rows.get(book) ?? [];
        if (!list.includes(reason)) list.push(reason);
        rows.set(book, list);
    };
    if (sources.chat) {
        add(sources.chat, 'chat');
        if (sources.ckChatBooks.includes(sources.chat)) add(sources.chat, 'ckConnector');
    }
    add(sources.persona, 'persona');
    for (const book of sources.characterPrimary) add(book, 'character');
    for (const book of sources.characterExtra) add(book, 'characterExtra');
    for (const book of sources.global) {
        add(book, 'global');
        if (sources.des.campaign.includes(book)) add(book, 'desCampaign');
        if (sources.des.autoLinked.includes(book)) add(book, 'desAutoLink');
        if (sources.des.workshop.includes(book)) add(book, 'workshop');
    }
    for (const book of rows.keys()) if (book.startsWith(CANON_BOOK_PREFIX)) add(book, 'canon');
    return [...rows].map(([book, reasons]) => ({ book, reasons }));
}

/* ------------------------------------------------------------------ compact storage */

/**
 * [world index, uid, chars, tokens, position, depth, role, order, loop, recursion level, via world index,
 *  via uid, cut code, tag mask, key]. Cut codes: 0 none, 1 budget, 2 Maestro, 3 removed by another extension.
 *  `key` null = not attributed yet, '' = attributed but no key matched (constant, forced, sticky…).
 */
export type StoredActivation = [
    number,
    number,
    number,
    number,
    number,
    number | null,
    number | null,
    number,
    number,
    number,
    number | null,
    number | null,
    number,
    number,
    string | null,
];

export interface StoredRecord {
    /** messageIndex */
    i: number;
    at: number;
    /** generation type */
    t: string;
    a: StoredActivation[];
    /** total chars / tokens */
    c: number;
    k: number;
    o: 0 | 1;
    b?: number;
    cc?: number;
}

/** Running counters over every recorded turn (also turns already dropped from `records`). */
export interface JournalStats {
    turns: number;
    chars: number;
    canon: number;
    /** "<world index>:<uid>" → [activations, total chars, last message index]. */
    entries: Record<string, [number, number, number]>;
}

export interface StoredJournal {
    v: 1;
    worlds: string[];
    /** "<world index>:<uid>" → entry title (last seen). */
    titles: Record<string, string>;
    /** Oldest first. */
    records: StoredRecord[];
    stats: JournalStats;
}

export function emptyJournal(): StoredJournal {
    return { v: 1, worlds: [], titles: {}, records: [], stats: { turns: 0, chars: 0, canon: 0, entries: {} } };
}

/**
 * Repairs a loaded document in place (the chat store tracks the object identity, so it must not be replaced)
 * and returns it typed.
 */
export function ensureJournal(doc: object): StoredJournal {
    const raw = doc as Dict;
    raw.v = 1;
    if (!Array.isArray(raw.worlds)) raw.worlds = [];
    if (!isDict(raw.titles)) raw.titles = {};
    if (!Array.isArray(raw.records)) raw.records = [];
    const stats = isDict(raw.stats) ? raw.stats : {};
    raw.stats = {
        turns: typeof stats.turns === 'number' ? stats.turns : 0,
        chars: typeof stats.chars === 'number' ? stats.chars : 0,
        canon: typeof stats.canon === 'number' ? stats.canon : 0,
        entries: isDict(stats.entries) ? stats.entries : {},
    };
    raw.records = (raw.records as unknown[]).filter(
        (record): record is StoredRecord => isDict(record) && typeof record.i === 'number' && Array.isArray(record.a),
    );
    return raw as unknown as StoredJournal;
}

function worldIndex(doc: StoredJournal, name: string): number {
    let index = doc.worlds.indexOf(name);
    if (index < 0) {
        doc.worlds.push(name);
        index = doc.worlds.length - 1;
    }
    return index;
}

const CUT_CODES = { none: 0, budget: 1, maestro: 2, other: 3 } as const;

function cutCode(row: ActivationRow): number {
    if (!row.cut) return CUT_CODES.none;
    if (row.cutBy === 'budget') return CUT_CODES.budget;
    if (row.cutBy === 'maestro') return CUT_CODES.maestro;
    return CUT_CODES.other;
}

export function encodeRecord(doc: StoredJournal, record: LoreRecordRow): StoredRecord {
    const a = record.activations.map((row): StoredActivation => {
        const w = worldIndex(doc, row.world);
        if (row.comment) doc.titles[`${w}:${row.uid}`] = row.comment;
        return [
            w,
            row.uid,
            row.chars,
            row.tokens,
            row.position,
            row.depth ?? null,
            row.role ?? null,
            row.order,
            row.loop,
            row.recursionLevel,
            row.via ? worldIndex(doc, row.via.world) : null,
            row.via ? row.via.uid : null,
            cutCode(row),
            tagMask(row.tags),
            row.key ?? null,
        ];
    });
    const stored: StoredRecord = {
        i: record.messageIndex,
        at: record.at,
        t: record.generationType,
        a,
        c: record.totalChars,
        k: record.totalTokens,
        o: record.overflow ? 1 : 0,
    };
    if (record.budgetTokens !== undefined) stored.b = record.budgetTokens;
    if (record.canonChars !== undefined) stored.cc = record.canonChars;
    return stored;
}

export function decodeRecord(doc: StoredJournal, stored: StoredRecord): LoreRecordRow {
    const activations = stored.a.map((tuple): ActivationRow => {
        const [w, uid, chars, tokens, position, depth, role, order, loop, level, viaW, viaUid, cut, mask, key] = tuple;
        const world = doc.worlds[w] ?? '';
        const row: ActivationRow = {
            world,
            uid,
            comment: doc.titles[`${w}:${uid}`] ?? '',
            chars,
            tokens,
            position,
            order,
            loop,
            recursionLevel: level,
            tags: tagsOfMask(mask),
        };
        if (depth !== null) row.depth = depth;
        if (role !== null) row.role = role;
        if (viaW !== null && viaUid !== null) row.via = { world: doc.worlds[viaW] ?? '', uid: viaUid };
        if (key !== null) row.key = key;
        if (cut !== CUT_CODES.none) {
            row.cut = true;
            if (cut === CUT_CODES.budget) row.cutBy = 'budget';
            else if (cut === CUT_CODES.maestro) row.cutBy = 'maestro';
        }
        return row;
    });
    const record: LoreRecordRow = {
        messageIndex: stored.i,
        at: stored.at,
        generationType: stored.t,
        activations,
        totalChars: stored.c,
        totalTokens: stored.k,
        overflow: stored.o === 1,
    };
    if (stored.b !== undefined) record.budgetTokens = stored.b;
    if (stored.cc !== undefined) record.canonChars = stored.cc;
    return record;
}

export function decodeRecords(doc: StoredJournal): LoreRecordRow[] {
    return doc.records.map((stored) => decodeRecord(doc, stored));
}

function applyStats(doc: StoredJournal, stored: StoredRecord, sign: 1 | -1): void {
    const stats = doc.stats;
    stats.turns = Math.max(0, stats.turns + sign);
    stats.chars = Math.max(0, stats.chars + sign * stored.c);
    stats.canon = Math.max(0, stats.canon + sign * (stored.cc ?? 0));
    for (const tuple of stored.a) {
        if (tuple[12] !== CUT_CODES.none) continue;
        const key = `${tuple[0]}:${tuple[1]}`;
        const current = stats.entries[key] ?? [0, 0, stored.i];
        const activations = current[0] + sign;
        if (activations <= 0) {
            delete stats.entries[key];
            continue;
        }
        stats.entries[key] = [
            activations,
            Math.max(0, current[1] + sign * tuple[2]),
            sign > 0 ? Math.max(current[2], stored.i) : current[2],
        ];
    }
}

/**
 * Adds a turn: a record for the same message (swipe, regenerate, continue) replaces the earlier one and its
 * counters; the oldest records beyond `keep` are dropped from the list but stay in the running counters.
 */
export function addRecord(doc: StoredJournal, record: LoreRecordRow, keep: number): StoredRecord {
    const stored = encodeRecord(doc, record);
    const previous = doc.records.findIndex((item) => item.i === record.messageIndex);
    if (previous >= 0) {
        const [old] = doc.records.splice(previous, 1);
        if (old) applyStats(doc, old, -1);
    }
    doc.records.push(stored);
    applyStats(doc, stored, 1);
    const limit = Math.max(1, Math.floor(keep));
    if (doc.records.length > limit) doc.records.splice(0, doc.records.length - limit);
    return stored;
}

/** Drops records of messages that no longer exist (index ≥ `fromIndex`), with their counters. */
export function removeRecordsFrom(doc: StoredJournal, fromIndex: number): number {
    let removed = 0;
    doc.records = doc.records.filter((stored) => {
        if (stored.i < fromIndex) return true;
        applyStats(doc, stored, -1);
        removed++;
        return false;
    });
    return removed;
}

/** Stores lazily attributed keys into the stored record of the same turn. Returns false when it is gone. */
export function setRecordKeys(doc: StoredJournal, record: LoreRecordRow): boolean {
    const stored = doc.records.find((item) => item.i === record.messageIndex && item.at === record.at);
    if (!stored) return false;
    for (const row of record.activations) {
        if (row.key === undefined) continue;
        const w = doc.worlds.indexOf(row.world);
        const tuple = stored.a.find((item) => item[0] === w && item[1] === row.uid);
        if (tuple) tuple[14] = row.key;
    }
    return true;
}

/* ------------------------------------------------------------------ catalog and summary */

/** An entry of the books scanned last (from WORLDINFO_ENTRIES_LOADED). */
export interface CatalogEntry {
    world: string;
    uid: number;
    comment: string;
    chars: number;
    constant: boolean;
    disabled: boolean;
}

/** Entries of the ENTRIES_LOADED lists, de-duplicated by world and uid. */
export function catalogFromLists(lists: unknown): CatalogEntry[] {
    if (!isDict(lists)) return [];
    const seen = new Set<string>();
    const entries: CatalogEntry[] = [];
    for (const name of ['chatLore', 'personaLore', 'characterLore', 'globalLore']) {
        const list = lists[name];
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
            if (!isDict(raw) || typeof raw.world !== 'string') continue;
            const uid = Number(raw.uid);
            if (!Number.isFinite(uid)) continue;
            const id = `${raw.world}\u0000${uid}`;
            if (seen.has(id)) continue;
            seen.add(id);
            entries.push({
                world: raw.world,
                uid,
                comment: typeof raw.comment === 'string' ? raw.comment : '',
                chars: typeof raw.content === 'string' ? raw.content.length : 0,
                constant: raw.constant === true,
                disabled: raw.disable === true,
            });
        }
    }
    return entries;
}

/** Structurally the M1 API's LoreSummaryRow / LoreSummary. */
export interface SummaryRow {
    world: string;
    uid?: number;
    comment?: string;
    activations: number;
    avgChars: number;
    lastSeenTurn?: number;
}

export interface JournalSummary {
    turns: number;
    heaviestBooks: SummaryRow[];
    heaviestEntries: SummaryRow[];
    alwaysActive: SummaryRow[];
    neverActive: SummaryRow[];
    avgTotalChars: number;
    avgCanonChars: number;
}

export interface SummaryLimits {
    books?: number;
    entries?: number;
}

/**
 * Chat summary from the running counters. Book weight is chars per turn on average; entry weight is the total
 * contribution (activations × average size). "Always active" needs at least two turns; "never active" lists
 * enabled entries of the books scanned last that no recorded turn activated.
 */
export function summarize(
    doc: StoredJournal,
    catalog: readonly CatalogEntry[],
    limits: SummaryLimits = {},
): JournalSummary {
    const turns = doc.stats.turns;
    const rows: (SummaryRow & { total: number })[] = [];
    const books = new Map<string, { activations: number; total: number }>();
    for (const [key, [activations, chars, lastSeen]] of Object.entries(doc.stats.entries)) {
        const separator = key.indexOf(':');
        const w = Number(key.slice(0, separator));
        const uid = Number(key.slice(separator + 1));
        const world = doc.worlds[w];
        if (world === undefined || !Number.isFinite(uid) || activations <= 0) continue;
        rows.push({
            world,
            uid,
            comment: doc.titles[key] ?? '',
            activations,
            avgChars: Math.round(chars / activations),
            lastSeenTurn: lastSeen,
            total: chars,
        });
        const book = books.get(world) ?? { activations: 0, total: 0 };
        book.activations += activations;
        book.total += chars;
        books.set(world, book);
    }
    const strip = ({ total: _total, ...row }: SummaryRow & { total: number }): SummaryRow => row;
    const heaviestEntries = [...rows]
        .sort((a, b) => b.total - a.total)
        .slice(0, limits.entries ?? 15)
        .map(strip);
    const heaviestBooks = [...books]
        .map(([world, book]) => ({
            world,
            activations: book.activations,
            avgChars: turns ? Math.round(book.total / turns) : 0,
        }))
        .sort((a, b) => b.avgChars - a.avgChars)
        .slice(0, limits.books ?? 10);
    const alwaysActive =
        turns >= 2
            ? rows
                  .filter((row) => row.activations >= turns)
                  .sort((a, b) => b.avgChars - a.avgChars)
                  .map(strip)
            : [];
    const active = new Set(rows.map((row) => `${row.world}\u0000${row.uid}`));
    const neverActive = turns
        ? catalog
              .filter((entry) => !entry.disabled && !active.has(`${entry.world}\u0000${entry.uid}`))
              .sort((a, b) => b.chars - a.chars)
              .map((entry) => ({
                  world: entry.world,
                  uid: entry.uid,
                  comment: entry.comment,
                  activations: 0,
                  avgChars: entry.chars,
              }))
        : [];
    return {
        turns,
        heaviestBooks,
        heaviestEntries,
        alwaysActive,
        neverActive,
        avgTotalChars: turns ? Math.round(doc.stats.chars / turns) : 0,
        avgCanonChars: turns ? Math.round(doc.stats.canon / turns) : 0,
    };
}
