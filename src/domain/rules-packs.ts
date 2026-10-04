// BunnyMo pack versions and the <NSFW> wrapper collision (plan M22, P13, Q33; research/bunnymo-carrotkernel.md
// §1.2, §1.5–1.6). Pure helpers shared by the M22 rules and the M5 doctor.
// - Version conflict: the same normalised keys with different text in two or more BunnyMo books (MBTI v1 and V2
//   «Analysts», CarrotCast V1.0 and Limited, Linguistics full and LiteR). One tag fires both texts; which book stays
//   is asked once per group of books. BSM-5 + CoT Lenses share keys by design (comment prefix `CoT LENS`).
// - CarrotCast Limited's «Erotic» entry has the bare key `<NSFW>`, so every archive using the `<NSFW>…</NSFW>`
//   wrapper fires it through recursion.
import { compareBookRecency } from './rules-lore';

/** The fields of a WI entry copy these helpers read. */
export interface PackEntryLike {
    world: string;
    uid: number;
    key?: unknown;
    content?: unknown;
    comment?: unknown;
    constant?: unknown;
    disable?: unknown;
}

/** CoT Lenses pair with BSM-5 on purpose; real titles start with an emoji («💊 CoT LENS — DEPRESSION»). */
const INTENDED_PAIR_RE = /^\s*[^\sA-Za-z0-9]*\s*CoT\s+LENS/i;
const REGEX_LIKE_RE = /^\/[\s\S]+\/[a-z]*$/i;
const CARROTCAST_RE = /carrot\s*-?\s*cast/i;
const BUNNYFLIX_RE = /bunnyflix/i;
/** CarrotCast entries name their streaming service near the top; the whole text is never scanned (P15). */
const MARKER_SPAN = 600;

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Pack key normalisation (research §1.6): trim, upper case, no spaces after `:`; regex keys stay verbatim. */
export function normalizePackKeyOf(key: string): string {
    const trimmed = key.trim();
    if (REGEX_LIKE_RE.test(trimmed)) return trimmed;
    return trimmed.toUpperCase().replace(/:\s+/g, ':');
}

/** Normalised primary keys as one string; null for constants and entries without keys (they never conflict). */
export function packKeySignature(entry: Pick<PackEntryLike, 'key' | 'constant'>): string | null {
    if (entry.constant === true || !Array.isArray(entry.key)) return null;
    const keys = new Set<string>();
    for (const key of entry.key) {
        if (typeof key !== 'string') continue;
        const normalised = normalizePackKeyOf(key);
        if (normalised) keys.add(normalised);
    }
    return keys.size ? JSON.stringify([...keys].sort()) : null;
}

/** Content compared up to whitespace (packs are re-saved by different editors). */
export function packContentSignature(content: unknown): string {
    return text(content).replace(/\s+/g, ' ').trim();
}

/** Stable id of a conflict group: its books in code-point order. */
export function packGroupId(books: readonly string[]): string {
    return JSON.stringify([...new Set(books)].sort());
}

export interface VersionConflict<E extends PackEntryLike> {
    id: string;
    /** Books of the group, in first-seen order. */
    books: string[];
    /** The book that looks newest (rules-lore compareBookRecency): the default answer. */
    newest: string;
    /** Every enabled entry of the conflicting key sets, in every book of the group. */
    entries: E[];
    /** Conflicting key sets. */
    count: number;
    /** First keys of the conflicting key sets (for messages). */
    sample: string[];
}

/**
 * Groups of books with version conflicts. Only enabled, keyed, non-constant entries with text take part; a key set
 * conflicts when it is present in two or more pack books with at least two different texts. Key sets with the same
 * books form one group (one question). Key sets of the intended BSM-5 + CoT Lenses pairing are skipped.
 */
export function findVersionConflicts<E extends PackEntryLike>(
    entries: Iterable<E>,
    isPack: (world: string) => boolean,
): VersionConflict<E>[] {
    const sizes = new Map<string, number>();
    const order = new Map<string, number>();
    const bySignature = new Map<string, E[]>();
    for (const entry of entries) {
        sizes.set(entry.world, (sizes.get(entry.world) ?? 0) + 1);
        if (!order.has(entry.world)) order.set(entry.world, order.size);
        if (entry.disable === true || !packContentSignature(entry.content) || !isPack(entry.world)) continue;
        const signature = packKeySignature(entry);
        if (signature === null) continue;
        const list = bySignature.get(signature);
        if (list) list.push(entry);
        else bySignature.set(signature, [entry]);
    }
    const groups = new Map<string, VersionConflict<E>>();
    for (const list of bySignature.values()) {
        const books = [...new Set(list.map((entry) => entry.world))];
        if (books.length < 2) continue;
        if (list.some((entry) => INTENDED_PAIR_RE.test(text(entry.comment)))) continue;
        if (new Set(list.map((entry) => packContentSignature(entry.content))).size < 2) continue;
        books.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
        const id = packGroupId(books);
        let group = groups.get(id);
        if (!group) {
            const newest = books.reduce((best, book) => (compareBookRecency(book, best, sizes) > 0 ? book : best));
            group = { id, books, newest, entries: [], count: 0, sample: [] };
            groups.set(id, group);
        }
        group.entries.push(...list);
        group.count += 1;
        const first = Array.isArray(list[0]?.key) ? list[0].key.find((key) => typeof key === 'string') : undefined;
        if (typeof first === 'string' && group.sample.length < 3) group.sample.push(first.trim());
    }
    return [...groups.values()];
}

/** Entries of the group that leave the prompt when `winner` stays. */
export function losersOf<E extends PackEntryLike>(group: VersionConflict<E>, winner: string): E[] {
    return group.books.includes(winner) ? group.entries.filter((entry) => entry.world !== winner) : [];
}

/** The key list holds the bare tag `<NSFW>` (ST matches keys case-insensitively by default). */
export function hasNsfwKey(keys: unknown): boolean {
    return Array.isArray(keys) && keys.some((key) => typeof key === 'string' && key.trim().toUpperCase() === '<NSFW>');
}

/** An entry of a CarrotCast pack: by its book name or the BunnyFlix header near the top of the text. */
export function isCarrotCastEntry(entry: { world?: unknown; book?: unknown; content?: unknown }): boolean {
    const book = text(entry.world) || text(entry.book);
    if (CARROTCAST_RE.test(book)) return true;
    return BUNNYFLIX_RE.test(text(entry.content).slice(0, MARKER_SPAN));
}
