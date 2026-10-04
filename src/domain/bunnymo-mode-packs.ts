// BunnyMo mode (M35 п. 6, 9; P13, Q25): the pack manager's pure parts — per-chat pack selection and its scan-time
// suppression, what a pack is (family, version, edition), the core version, and the diff of a pack book against a new
// pack file. Pack files are never written: the selection acts on ST's per-scan entry lists only.
import { entryTags, entriesWithUid, MBTI_CATEGORY } from './bunnymo-mode-tags';
import type { UidEntry } from './bunnymo-mode-tags';
import { LIST_NAMES } from './canon-inject';
import type { EntryListsLike } from './canon-inject';
import { packInfo } from './roles-detect';
import { bookVersion } from './rules-lore';
import { packContentSignature, packKeySignature } from './rules-packs';

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ per-chat selection (Q25) */

export type PackSelectionValue = { mode: 'all' } | { mode: 'only'; books: string[] };

/** A stored selection (chat metadata pointer) or 'all' when it is missing or damaged; books deduplicated and sorted. */
export function readPackSelection(value: unknown): PackSelectionValue {
    if (typeof value !== 'object' || value === null) return { mode: 'all' };
    const record = value as Dict;
    if (record.mode !== 'only' || !Array.isArray(record.books)) return { mode: 'all' };
    const books = [...new Set(record.books.filter((book): book is string => typeof book === 'string' && !!book))];
    return { mode: 'only', books: books.sort() };
}

export function samePackSelection(a: PackSelectionValue, b: PackSelectionValue): boolean {
    if (a.mode !== b.mode) return false;
    if (a.mode === 'all' || b.mode === 'all') return true;
    return a.books.length === b.books.length && a.books.every((book, index) => book === b.books[index]);
}

/** The book is left out of this chat by the selection (only meaningful for pack books). */
export function isOffBySelection(selection: PackSelectionValue, book: string): boolean {
    return selection.mode === 'only' && !selection.books.includes(book);
}

/**
 * Takes the entries of dropped books out of the four per-scan lists of WORLDINFO_ENTRIES_LOADED (the list arrays
 * are ST's per-scan arrays; entry objects and their nested arrays are not touched). Idempotent. Returns the number of
 * entries removed per book.
 */
export function suppressBooks(lists: EntryListsLike, drop: (world: string) => boolean): Map<string, number> {
    const removed = new Map<string, number>();
    const decided = new Map<string, boolean>();
    for (const name of LIST_NAMES) {
        const list = lists[name];
        for (let index = list.length - 1; index >= 0; index--) {
            const world = list[index]?.world;
            if (typeof world !== 'string') continue;
            let off = decided.get(world);
            if (off === undefined) {
                off = drop(world);
                decided.set(world, off);
            }
            if (!off) continue;
            list.splice(index, 1);
            removed.set(world, (removed.get(world) ?? 0) + 1);
        }
    }
    return removed;
}

/** World names of the four lists (each once, in list order). */
export function worldsOf(lists: EntryListsLike): string[] {
    const worlds = new Set<string>();
    for (const name of LIST_NAMES) {
        for (const entry of lists[name]) {
            if (typeof entry?.world === 'string') worlds.add(entry.world);
        }
    }
    return [...worlds];
}

/* ------------------------------------------------------------------ what a pack is */

/** Pack families by the category their entries pull (research §1.1 table). */
const FAMILY_BY_CATEGORY: Readonly<Record<string, string>> = {
    [MBTI_CATEGORY]: 'MBTI',
    SPECIES: 'Species',
    DOMAIN: 'Species',
    DIVINE: 'Species',
    BENDER: 'Species',
    DERE: 'Dere',
    TRAIT: 'Traits',
    GENRE: 'CarrotCast',
    LING: 'Linguistics',
    BSM: 'BSM-5',
    MENTAL: 'BSM-5',
    MED: 'BunnyRX',
    REC: 'BunnyRX',
    CONDITION: 'HopSpital',
    MOBILITY: 'HopSpital',
    SENSORY: 'HopSpital',
};
const COT_LENS_RE = /^\s*\S*\s*CoT\s+LENS/i;
const FILTER_RE = /\bfilter\s+(?:start|end)\b/i;

/** The pack family («MBTI», «Species», «BSM-5 CoT Lenses»…) by its entries; null when nothing tells. */
export function packFamily(entries: readonly UidEntry[]): string | null {
    const votes = new Map<string, number>();
    let lenses = 0;
    let filters = 0;
    let keyed = 0;
    for (const { entry } of entries) {
        const comment = typeof entry.comment === 'string' ? entry.comment : '';
        if (FILTER_RE.test(comment)) filters++;
        const tags = entryTags(entry);
        if (!tags.length) continue;
        keyed++;
        if (COT_LENS_RE.test(comment)) lenses++;
        const families = new Set(tags.map((tag) => FAMILY_BY_CATEGORY[tag.category]).filter(Boolean) as string[]);
        for (const family of families) votes.set(family, (votes.get(family) ?? 0) + 1);
    }
    let best: string | null = null;
    let top = 0;
    for (const [family, count] of votes) {
        if (count > top) {
            best = family;
            top = count;
        }
    }
    if (best === 'BSM-5' && lenses * 2 > keyed) return 'BSM-5 CoT Lenses';
    if (!best && filters >= 2) return 'Tell Tail Lenses';
    return best;
}

/** Book name without the decorations packs ship with (`--BunnMBTI-Pack V2` → name `BunnMBTI-Pack`, version `2`). */
export function packTitle(book: string): { name: string; version?: string } {
    const info = packInfo(book.replace(/\.(?:json|bny)$/i, ''));
    const name = info.name.replace(/^[\s\-–—_.]+/, '').trim() || book;
    return info.version ? { name, version: info.version } : { name };
}

/** Normalised keys + text of an entry (null for entries without keys): equal signatures are the same entry. */
export function entrySignature(entry: Dict): string | null {
    const keys = packKeySignature({ key: entry.key });
    return keys === null ? null : `${keys}\u0001${packContentSignature(entry.content)}`;
}

/** Signatures of the enabled keyed entries of a book. */
export function bookSignatures(entries: readonly UidEntry[]): Set<string> {
    const signatures = new Set<string>();
    for (const { entry } of entries) {
        if (entry.disable === true) continue;
        const signature = entrySignature(entry);
        if (signature !== null) signatures.add(signature);
    }
    return signatures;
}

const SPLIT_NAME_RE = /^\s*-{3}\s*[A-Za-z0-9]\b|separat|seperat/i;
/** Share of a book's entries found in a larger pack that makes it a part of that pack (a split edition). */
const SPLIT_SHARE = 0.8;

/**
 * 'split' — a pack per file (the «Seperated» editions, `---A …` files, or a book whose entries are mostly a copy of a
 * larger loaded pack); 'shared' — one file holding several packs or sections.
 */
export function packEdition(
    book: string,
    own: ReadonlySet<string>,
    others: readonly { book: string; signatures: ReadonlySet<string> }[],
): 'shared' | 'split' {
    if (SPLIT_NAME_RE.test(book)) return 'split';
    if (!own.size) return 'shared';
    for (const other of others) {
        if (other.book === book || other.signatures.size <= own.size) continue;
        let found = 0;
        for (const signature of own) if (other.signatures.has(signature)) found++;
        if (found / own.size >= SPLIT_SHARE) return 'split';
    }
    return 'shared';
}

/* ------------------------------------------------------------------ core version */

/** The BunnyMo version Maestro is checked against (research §1, commit 7a61c9f). */
export const EXPECTED_CORE_VERSION = '3.0';

export interface CoreVersion {
    /** From the book name (`… V3.0`), if it carries one. */
    named: string | null;
    /** From the content: titles and keys that first appeared in a version (V3.0 HawThorne links, V2.9 sheets…). */
    detected: string;
}

const CORE_MARKERS: readonly { version: string; test(entry: Dict, comment: string, keys: string[]): boolean }[] = [
    { version: '3.0', test: (_entry, comment) => /HawThorne Link|Medicine Check/i.test(comment) },
    { version: '2.9', test: (_entry, _comment, keys) => keys.includes('!physheet') || keys.includes('!updatesheet') },
    { version: '2.7', test: (_entry, comment) => /AUTO-FILTRATION:\s*LINGUISTICS/i.test(comment) },
    { version: '2.1', test: (_entry, comment) => /ANTI[\s-]*CLANKER/i.test(comment) },
];

/** Version of a core book: the name's and the one its content shows (the oldest known when no marker matches). */
export function coreVersionOf(book: string, entries: readonly UidEntry[]): CoreVersion {
    const named = bookVersion(book);
    let detected = '2.0';
    for (const marker of CORE_MARKERS) {
        const hit = entries.some(({ entry }) => {
            const comment = typeof entry.comment === 'string' ? entry.comment : '';
            const keys = Array.isArray(entry.key)
                ? entry.key
                      .filter((key): key is string => typeof key === 'string')
                      .map((key) => key.trim().toLowerCase())
                : [];
            return marker.test(entry, comment, keys);
        });
        if (hit) {
            detected = marker.version;
            break;
        }
    }
    return { named: named.length ? named.join('.') : null, detected };
}

/** Compares dotted versions numerically ('2.10' > '2.9'). */
export function compareVersions(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

/* ------------------------------------------------------------------ diff with a new pack file */

export interface PackDiffResult {
    added: { key: string; comment: string }[];
    removed: { key: string; comment: string }[];
    changed: { key: string; comment: string; before: string; after: string }[];
}

/**
 * Entries of a lorebook file: ST's world format (`{entries: {uid: entry}}`, or an array of entries). Null when the text
 * is not JSON or holds no entries object.
 */
export function parseWorldFile(text: string): UidEntry[] | null {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof data !== 'object' || data === null) return null;
    const entries = (data as Dict).entries;
    if (Array.isArray(entries)) {
        return entries
            .filter((entry): entry is Dict => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
            .map((entry, index) => ({ uid: Number.isFinite(Number(entry.uid)) ? Number(entry.uid) : index, entry }));
    }
    if (typeof entries !== 'object' || entries === null) return null;
    return entriesWithUid(data);
}

function keysOf(entry: Dict): string[] {
    return Array.isArray(entry.key)
        ? entry.key.filter((key): key is string => typeof key === 'string').map((key) => key.trim())
        : [];
}

function commentOf(entry: Dict): string {
    return typeof entry.comment === 'string' ? entry.comment.trim() : '';
}

function keyIdentity(entry: Dict): string {
    return packKeySignature({ key: entry.key }) ?? '';
}

function describe(entry: Dict, withKeys: boolean): string {
    const content = typeof entry.content === 'string' ? entry.content : '';
    return withKeys ? `${keysOf(entry).join(', ')}\n\n${content}` : content;
}

/**
 * Diff of a pack book against a new pack file, entry by entry: matched by keys and title, then by keys alone, then by
 * title alone (each match used once). Matched entries whose text or keys differ are «changed».
 */
export function diffPackEntries(before: readonly UidEntry[], after: readonly UidEntry[]): PackDiffResult {
    const left = before.map(({ entry }) => entry);
    const right = after.map(({ entry }) => entry);
    const used = new Set<Dict>();
    const pairs: [Dict, Dict][] = [];
    const unmatched: Dict[] = [];
    const passes: ((entry: Dict) => string)[] = [
        (entry) => `${keyIdentity(entry)}\u0001${commentOf(entry)}`,
        (entry) => keyIdentity(entry),
        (entry) => commentOf(entry),
    ];
    let pending = left;
    for (const identity of passes) {
        const index = new Map<string, Dict[]>();
        for (const entry of right) {
            if (used.has(entry)) continue;
            const id = identity(entry);
            if (!id || id === '\u0001') continue;
            const list = index.get(id);
            if (list) list.push(entry);
            else index.set(id, [entry]);
        }
        const rest: Dict[] = [];
        for (const entry of pending) {
            const id = identity(entry);
            const match = id && id !== '\u0001' ? index.get(id)?.shift() : undefined;
            if (match) {
                used.add(match);
                pairs.push([entry, match]);
            } else {
                rest.push(entry);
            }
        }
        pending = rest;
    }
    unmatched.push(...pending);
    const label = (entry: Dict) => ({ key: keysOf(entry)[0] ?? '', comment: commentOf(entry) });
    const changed: PackDiffResult['changed'] = [];
    for (const [old, next] of pairs) {
        const keysDiffer = keyIdentity(old) !== keyIdentity(next);
        if (!keysDiffer && packContentSignature(old.content) === packContentSignature(next.content)) continue;
        changed.push({ ...label(next), before: describe(old, keysDiffer), after: describe(next, keysDiffer) });
    }
    return {
        added: right.filter((entry) => !used.has(entry)).map(label),
        removed: unmatched.map(label),
        changed,
    };
}
