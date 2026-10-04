// Pure parts of M22's lore rules (plan M22, M20 п. 2; audit T3, T4): duplicate detection across books, the
// "newest book" heuristic, book caps per scan loop and the before/after diff of activations. No ST here: the rules
// engine feeds plain objects in and applies the result to ST's scan copies.

type Dict = Record<string, unknown>;

/** The fields of a WI entry copy these helpers read. */
export interface LoreEntryLike {
    uid: number;
    world: string;
    key?: unknown;
    keysecondary?: unknown;
    content?: unknown;
    disable?: unknown;
}

/* ------------------------------------------------------------------ tokens */

/** Characters per token for the quick estimate (between English ~4 and Cyrillic ~3). */
export const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(chars: number): number {
    return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;
}

/* ------------------------------------------------------------------ duplicates */

/** Keys as a canonical string: trimmed, lower case, unique, sorted; non-strings and empty keys are dropped. */
export function normalizeKeyList(value: unknown): string {
    if (!Array.isArray(value)) return '';
    const keys = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const key = item.trim().toLowerCase();
        if (key) keys.add(key);
    }
    return [...keys].sort().join('\u0001');
}

/** Identity of an entry for "byte-identical duplicate": normalised keys plus the exact content; null when empty. */
export function duplicateSignature(entry: LoreEntryLike): string | null {
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!content.trim()) return null;
    return `${normalizeKeyList(entry.key)}\u0002${normalizeKeyList(entry.keysecondary)}\u0002${content}`;
}

const OLD_NAME_RE =
    /(?:^|[^\p{L}])(?:old|legacy|retired|deprecated|outdated|backup|copy|копия|стар\p{L}*)(?:[^\p{L}]|$)/iu;
const VERSION_RE = /(?:^|[^\p{L}])v(?:er(?:sion)?)?\.?\s*(\d+(?:\.\d+)*)/giu;
const DOTTED_RE = /(?:^|[^\d.])(\d+(?:\.\d+)+)(?![\d.])/g;

/** Version numbers in a book name: `MBTI V2` → [2], `BUNNYMO V3.0` → [3, 0], `Pack 1.2.1` → [1, 2, 1]; none → []. */
export function bookVersion(name: string): number[] {
    let last: string | undefined;
    for (const match of name.matchAll(VERSION_RE)) last = match[1];
    if (last === undefined) {
        for (const match of name.matchAll(DOTTED_RE)) last = match[1];
    }
    return last === undefined ? [] : last.split('.').map((part) => Number(part));
}

/** The name says the book is an old copy (`Old Versions`, `legacy`, `backup`, `копия`, `старый`…). */
export function isOldBookName(name: string): boolean {
    return OLD_NAME_RE.test(name);
}

function compareVersions(a: number[], b: number[]): number {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const diff = (a[i] ?? -1) - (b[i] ?? -1);
        if (diff !== 0) return diff;
    }
    return 0;
}

/**
 * Positive when book `a` is "newer" than `b`: not marked old, then a higher version in the name, then more entries
 * in this scan (a merged edition over its split parts), then the name in code-point order. Always deterministic.
 */
export function compareBookRecency(a: string, b: string, sizes: ReadonlyMap<string, number> = new Map()): number {
    const oldA = isOldBookName(a);
    const oldB = isOldBookName(b);
    if (oldA !== oldB) return oldA ? -1 : 1;
    const version = compareVersions(bookVersion(a), bookVersion(b));
    if (version !== 0) return version;
    const size = (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0);
    if (size !== 0) return size;
    if (a === b) return 0;
    return a < b ? 1 : -1;
}

export interface DuplicateGroup<E extends LoreEntryLike> {
    /** Book whose copies stay. */
    world: string;
    keep: E[];
    /** Copies in other books, to be switched off on the scan copies. */
    drop: E[];
}

/**
 * Byte-identical entries present in two or more books (same normalised keys and content). Disabled entries do not
 * take part; copies inside one book are left alone. Groups come in first-seen order.
 */
export function findCrossBookDuplicates<E extends LoreEntryLike>(
    entries: Iterable<E>,
    sizes?: ReadonlyMap<string, number>,
): DuplicateGroup<E>[] {
    const counts = new Map<string, number>();
    const bySignature = new Map<string, E[]>();
    for (const entry of entries) {
        counts.set(entry.world, (counts.get(entry.world) ?? 0) + 1);
        if (entry.disable === true) continue;
        const signature = duplicateSignature(entry);
        if (signature === null) continue;
        const list = bySignature.get(signature);
        if (list) list.push(entry);
        else bySignature.set(signature, [entry]);
    }
    const bookSizes = sizes ?? counts;
    const groups: DuplicateGroup<E>[] = [];
    for (const list of bySignature.values()) {
        const worlds = [...new Set(list.map((entry) => entry.world))];
        if (worlds.length < 2) continue;
        const newest = worlds.reduce((best, world) => (compareBookRecency(world, best, bookSizes) > 0 ? world : best));
        groups.push({
            world: newest,
            keep: list.filter((entry) => entry.world === newest),
            drop: list.filter((entry) => entry.world !== newest),
        });
    }
    return groups;
}

/* ------------------------------------------------------------------ book caps */

export interface CapLimits {
    maxTokens?: number;
    maxRecursionLevel?: number;
}

export interface CapActivation {
    /** `world.uid`, the key of ST's `activated.entries` map. */
    key: string;
    world: string;
    order: number;
    /** Position in ST's sorted entries (priority within equal `order`). */
    priority: number;
    tokens: number;
    /** Activated in the current scan loop. */
    isNew: boolean;
}

export interface CapCut {
    key: string;
    world: string;
    reason: 'tokens' | 'recursion';
}

/** A usable limit: a finite number ≥ 0. */
export function isLimit(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Which activations a book cap removes after one scan loop (audit T4):
 * 1. entries of a book with `maxRecursionLevel` that were activated in this loop deeper than the limit;
 * 2. per book with `maxTokens > 0`: the remaining activations sorted by `order` (higher first, then ST's priority)
 *    are kept while they fit; the first one that does not fit and everything after it are cut (like ST's budget).
 */
export function planBookCaps(
    activations: readonly CapActivation[],
    caps: Readonly<Record<string, CapLimits>>,
    recursionLevel: number,
): CapCut[] {
    const cuts: CapCut[] = [];
    const cutKeys = new Set<string>();
    for (const activation of activations) {
        const limit = caps[activation.world]?.maxRecursionLevel;
        if (activation.isNew && isLimit(limit) && recursionLevel > limit) {
            cuts.push({ key: activation.key, world: activation.world, reason: 'recursion' });
            cutKeys.add(activation.key);
        }
    }
    const byBook = new Map<string, CapActivation[]>();
    for (const activation of activations) {
        if (cutKeys.has(activation.key)) continue;
        const maxTokens = caps[activation.world]?.maxTokens;
        if (!isLimit(maxTokens) || maxTokens <= 0) continue;
        const list = byBook.get(activation.world);
        if (list) list.push(activation);
        else byBook.set(activation.world, [activation]);
    }
    for (const [world, list] of byBook) {
        const maxTokens = caps[world]?.maxTokens ?? 0;
        const sorted = [...list].sort((a, b) => b.order - a.order || a.priority - b.priority);
        let used = 0;
        let full = false;
        for (const activation of sorted) {
            if (!full && used + activation.tokens <= maxTokens) {
                used += activation.tokens;
                continue;
            }
            full = true;
            cuts.push({ key: activation.key, world, reason: 'tokens' });
        }
    }
    return cuts;
}

/* ------------------------------------------------------------------ before / after */

export interface ActivationLike {
    world: string;
    uid: number;
    comment?: string;
    chars: number;
    cut?: boolean;
}

export interface ActivationRow {
    world: string;
    uid: number;
    comment: string;
    chars: number;
}

export interface ActivationDiff {
    removed: ActivationRow[];
    added: ActivationRow[];
    charsDelta: number;
}

function activeMap(list: readonly ActivationLike[]): Map<string, ActivationLike> {
    const map = new Map<string, ActivationLike>();
    for (const activation of list) {
        if (activation.cut) continue;
        map.set(`${activation.world}\u0000${activation.uid}`, activation);
    }
    return map;
}

function row(activation: ActivationLike): ActivationRow {
    return {
        world: activation.world,
        uid: activation.uid,
        comment: activation.comment ?? '',
        chars: Number.isFinite(activation.chars) ? activation.chars : 0,
    };
}

function byBookAndUid(a: ActivationRow, b: ActivationRow): number {
    if (a.world !== b.world) return a.world < b.world ? -1 : 1;
    return a.uid - b.uid;
}

/** Entries active only before / only after (cut activations count as inactive) and the change in characters. */
export function diffActivations(before: readonly ActivationLike[], after: readonly ActivationLike[]): ActivationDiff {
    const was = activeMap(before);
    const now = activeMap(after);
    const removed = [...was].filter(([key]) => !now.has(key)).map(([, activation]) => row(activation));
    const added = [...now].filter(([key]) => !was.has(key)).map(([, activation]) => row(activation));
    const sum = (map: Map<string, ActivationLike>) =>
        [...map.values()].reduce((total, item) => total + row(item).chars, 0);
    return {
        removed: removed.sort(byBookAndUid),
        added: added.sort(byBookAndUid),
        charsDelta: sum(now) - sum(was),
    };
}

/** Plain-object check shared by the rules (scan payloads are untyped). */
export function isPlainObject(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
