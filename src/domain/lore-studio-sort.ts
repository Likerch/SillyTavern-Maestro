// Entry list logic of the Lore Studio (M23): ST's 14 sort options with its secondary/tertiary keys, «Apply current
// sorting as Order», pages, manual order (displayIndex) and a plain fallback search with Fuse's extended operators
// (research/parity-lore.md L-112…L-126). Pure.
import { contentLength, displayIndexOf, stringList } from './lore-studio-entries';
import type { LoreEntry } from './lore-studio-entries';

export type SortRule = 'search' | 'priority' | 'custom' | 'field' | 'length';

export interface SortOption {
    /** Value of ST's `#world_info_sort_order` option. */
    id: number;
    rule: SortRule;
    field?: string;
    order?: 'asc' | 'desc';
    /** i18n key of the label. */
    labelKey: string;
}

/** ST 1.19 `#world_info_sort_order` (index.html 4852-4868), in its display order. */
export const SORT_OPTIONS: readonly SortOption[] = [
    { id: 14, rule: 'search', labelKey: 'm23.sort.search' },
    { id: 0, rule: 'priority', labelKey: 'm23.sort.priority' },
    { id: 13, rule: 'custom', labelKey: 'm23.sort.custom' },
    { id: 1, rule: 'field', field: 'comment', order: 'asc', labelKey: 'm23.sort.titleAsc' },
    { id: 2, rule: 'field', field: 'comment', order: 'desc', labelKey: 'm23.sort.titleDesc' },
    { id: 3, rule: 'length', field: 'content', order: 'asc', labelKey: 'm23.sort.tokensAsc' },
    { id: 4, rule: 'length', field: 'content', order: 'desc', labelKey: 'm23.sort.tokensDesc' },
    { id: 5, rule: 'field', field: 'depth', order: 'asc', labelKey: 'm23.sort.depthAsc' },
    { id: 6, rule: 'field', field: 'depth', order: 'desc', labelKey: 'm23.sort.depthDesc' },
    { id: 7, rule: 'field', field: 'order', order: 'asc', labelKey: 'm23.sort.orderAsc' },
    { id: 8, rule: 'field', field: 'order', order: 'desc', labelKey: 'm23.sort.orderDesc' },
    { id: 9, rule: 'field', field: 'uid', order: 'asc', labelKey: 'm23.sort.uidAsc' },
    { id: 10, rule: 'field', field: 'uid', order: 'desc', labelKey: 'm23.sort.uidDesc' },
    { id: 11, rule: 'field', field: 'probability', order: 'asc', labelKey: 'm23.sort.probabilityAsc' },
    { id: 12, rule: 'field', field: 'probability', order: 'desc', labelKey: 'm23.sort.probabilityDesc' },
];

export const SEARCH_SORT_ID = 14;
export const DEFAULT_SORT_ID = 0;
export const CUSTOM_SORT_ID = 13;

export function sortOption(id: number): SortOption {
    return SORT_OPTIONS.find((option) => option.id === id) ?? (SORT_OPTIONS[1] as SortOption);
}

/**
 * `sortWorldInfoEntries` (WI:2146-2210) on a copy: primary key by the option, then `order` descending, then `uid`
 * ascending. `scores` (lower is better) drive the «Search» sort; entries without a score keep their place by order.
 */
export function sortEntries<T extends LoreEntry>(entries: readonly T[], id: number, scores?: Map<number, number>): T[] {
    const option = sortOption(id);
    const sign = option.order === 'asc' ? 1 : -1;
    const secondary = (a: T, b: T) => Number(b.order) - Number(a.order);
    const tertiary = (a: T, b: T) => Number(a.uid) - Number(b.uid);
    let primary: (a: T, b: T) => number;
    switch (option.rule) {
        case 'search':
            primary = (a, b) => (scores?.get(a.uid) ?? Number.NaN) - (scores?.get(b.uid) ?? Number.NaN);
            break;
        case 'custom':
            primary = (a, b) => displayIndexOf(a) - displayIndexOf(b);
            break;
        case 'priority':
            primary = (a, b) => rank(a) - rank(b);
            break;
        default:
            primary = (a, b) => {
                const left = a[option.field as string];
                const right = b[option.field as string];
                if (typeof left === 'string' && typeof right === 'string') {
                    if (option.rule === 'length') return sign * (left.length - right.length);
                    return sign * left.localeCompare(right);
                }
                return sign * (Number(left) - Number(right));
            };
    }
    // NaN from a comparator counts as "equal" in ST's `a || b || c` chain.
    const pick = (value: number) => (Number.isNaN(value) ? 0 : value);
    return [...entries].sort((a, b) => pick(primary(a, b)) || pick(secondary(a, b)) || pick(tertiary(a, b)));
}

/** Constant first, then normal, then disabled. */
function rank(entry: LoreEntry): number {
    if (entry.disable) return 2;
    return entry.constant ? 0 : 1;
}

export interface ApplyOrderOptions {
    start: number;
    step: number;
    ascending: boolean;
}

export type ApplyOrderError = 'start' | 'step';

/** Validation of «Apply current sorting as Order» (start ≥ 0, step ≥ 1). */
export function validateApplyOrder(options: ApplyOrderOptions): ApplyOrderError | null {
    if (!Number.isFinite(options.start) || options.start < 0) return 'start';
    if (!Number.isFinite(options.step) || options.step < 1) return 'step';
    return null;
}

/** The value of the last entry when descending values would go below 0 (ST's live warning), else null. */
export function clampedTail(count: number, options: ApplyOrderOptions): number | null {
    if (options.ascending || count === 0) return null;
    const last = options.start - (count - 1) * options.step;
    return last < 0 ? last : null;
}

/** New `order` values for the sorted list (WI:2600-2610): only entries whose value changes. */
export function applyOrder(sorted: readonly LoreEntry[], options: ApplyOrderOptions): { uid: number; order: number }[] {
    const changes: { uid: number; order: number }[] = [];
    sorted.forEach((entry, index) => {
        const order = options.ascending
            ? options.start + index * options.step
            : Math.max(options.start - index * options.step, 0);
        if (entry.order === order) return;
        changes.push({ uid: entry.uid, order });
    });
    return changes;
}

export const PAGE_SIZES = [10, 25, 50, 100, 500, 1000] as const;
export const DEFAULT_PAGE_SIZE = 25;

export interface PageInfo {
    /** 0-based, clamped. */
    page: number;
    pages: number;
    /** Index of the first item on the page. */
    start: number;
    /** Index after the last item. */
    end: number;
}

export function paginate(total: number, page: number, size: number): PageInfo {
    const perPage = Math.max(1, Math.floor(size) || DEFAULT_PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const current = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
    const start = current * perPage;
    return { page: current, pages, start, end: Math.min(total, start + perPage) };
}

/** Page holding the item at `index`. */
export function pageOfIndex(index: number, size: number): number {
    return index < 0 ? 0 : Math.floor(index / Math.max(1, size));
}

/**
 * Manual order after a drag on one page (WI:2650-2682): the page's entries get consecutive `displayIndex` values
 * in their new order. ST starts from the displayIndex of whichever entry ends up first; we start from the smallest
 * displayIndex the page had, so dragging an entry up never pushes the whole page past the next page.
 */
export function reorderPage(
    newOrder: readonly number[],
    entries: Record<string, LoreEntry>,
): { uid: number; displayIndex: number }[] {
    const present = newOrder.filter((uid) => entries[String(uid)]);
    if (!present.length) return [];
    const base = Math.min(...present.map((uid) => displayIndexOf(entries[String(uid)] as LoreEntry)));
    const changes: { uid: number; displayIndex: number }[] = [];
    present.forEach((uid, index) => {
        const entry = entries[String(uid)] as LoreEntry;
        const displayIndex = base + index;
        if (entry.displayIndex !== displayIndex) changes.push({ uid, displayIndex });
    });
    return changes;
}

/** Moves one item of a list (drag and drop, up/down buttons). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    const copy = [...list];
    if (from < 0 || from >= copy.length) return copy;
    const target = Math.min(Math.max(0, to), copy.length - 1);
    const [item] = copy.splice(from, 1) as [T];
    copy.splice(target, 0, item);
    return copy;
}

/** Fields and weights of ST's World Info search (power-user.js fuzzySearchWorldInfo). */
export const SEARCH_KEYS: readonly { name: string; weight: number }[] = [
    { name: 'key', weight: 20 },
    { name: 'group', weight: 15 },
    { name: 'comment', weight: 10 },
    { name: 'keysecondary', weight: 10 },
    { name: 'content', weight: 3 },
    { name: 'uid', weight: 1 },
    { name: 'automationId', weight: 1 },
];

function fieldTexts(entry: LoreEntry, name: string): string[] {
    const value = entry[name];
    if (Array.isArray(value)) return stringList(value).map((item) => item.toLowerCase());
    if (value === undefined || value === null) return [];
    return [String(value).toLowerCase()];
}

interface Term {
    text: string;
    mode: 'include' | 'exact' | 'prefix' | 'suffix' | 'equal';
    negate: boolean;
}

/** Fuse extended-search operators: `'exact`, `^prefix`, `suffix$`, `=equal`, `!not` (and `!^`, `!…$`). */
function parseTerms(query: string): Term[] {
    const terms: Term[] = [];
    for (const raw of query.trim().toLowerCase().split(/\s+/)) {
        if (!raw) continue;
        let text = raw;
        let negate = false;
        if (text.startsWith('!')) {
            negate = true;
            text = text.slice(1);
        }
        let mode: Term['mode'] = 'include';
        if (text.startsWith('=')) {
            mode = 'equal';
            text = text.slice(1);
        } else if (text.startsWith("'")) {
            mode = 'exact';
            text = text.slice(1);
        } else if (text.startsWith('^')) {
            mode = 'prefix';
            text = text.slice(1);
        } else if (text.endsWith('$') && text.length > 1) {
            mode = 'suffix';
            text = text.slice(0, -1);
        }
        if (text) terms.push({ text, mode, negate });
    }
    return terms;
}

function termMatches(term: Term, value: string): boolean {
    switch (term.mode) {
        case 'equal':
            return value === term.text;
        case 'prefix':
            return value.startsWith(term.text);
        case 'suffix':
            return value.endsWith(term.text);
        default:
            return value.includes(term.text);
    }
}

/**
 * Substring search with Fuse's weights and extended operators, used when ST's own fuzzy search is unavailable.
 * Every term must match some field (negated terms must match none). Returns uid → score (0 best … 1 worst) for
 * matching entries only.
 */
export function plainSearch(entries: readonly LoreEntry[], query: string): Map<number, number> {
    const result = new Map<number, number>();
    const terms = parseTerms(query);
    if (!terms.length) return result;
    const total = SEARCH_KEYS.reduce((sum, key) => sum + key.weight, 0);
    for (const entry of entries) {
        let weight = 0;
        let ok = true;
        for (const term of terms) {
            let best = 0;
            for (const key of SEARCH_KEYS) {
                if (fieldTexts(entry, key.name).some((value) => termMatches(term, value))) {
                    best = Math.max(best, key.weight);
                }
            }
            if (term.negate ? best > 0 : best === 0) {
                ok = false;
                break;
            }
            if (!term.negate) weight += best;
        }
        if (!ok) continue;
        const positive = terms.filter((term) => !term.negate).length;
        const score = positive ? 1 - weight / (total * positive) : 0.5;
        result.set(entry.uid, Math.max(0, Math.min(1, score)));
    }
    return result;
}

/** Characters of content over a list of entries (book size line). */
export function totalChars(entries: readonly LoreEntry[]): number {
    return entries.reduce((sum, entry) => sum + contentLength(entry), 0);
}
