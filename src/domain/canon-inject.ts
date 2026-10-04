// M6 «Канон чата» — scan-time injection, pure parts (plan M6 п. 3–7, §5 step 2; audit T1, B4). Applied to ST's
// per-scan entry copies in WORLDINFO_ENTRIES_LOADED and to the activations of WORLDINFO_SCAN_DONE:
// - additions: a copy `{...entry, world: canonBook, uid}` is pushed into chatLore;
// - overrides: the base copy (same world and uid) is REPLACED IN PLACE in whichever list holds it, with the override
//   fields as new values (nested arrays of ST's cache are never mutated);
// - suppressions: the base copy is taken out of its list;
// - pins: the base copy is forced into the first loop's activations.
// The event fires several times per generation (and for dry runs), so everything here is idempotent.
// Pure: no DOM, no SillyTavern.
import { copyValue, isDict, itemOverrideFields, materializeOverride, scanMarker } from './canon-book';
import type { CanonItemLike } from './canon-book';
import { CANON_BOOK_PREFIX } from './lore-journal';
import { parseRegexKey } from './lore-match';
import { normalizeForMatch } from './canon-keys';

type Dict = Record<string, unknown>;

export const LIST_NAMES = ['globalLore', 'characterLore', 'chatLore', 'personaLore'] as const;
export type ListName = (typeof LIST_NAMES)[number];
export type EntryListsLike = Record<ListName, Dict[]>;

export interface InjectOptions {
    canonBook: string;
    /** Archived items act only when this says they were mentioned recently (`base`: the base scan copy, if any). */
    mentioned?(item: CanonItemLike, base?: Dict): boolean;
    /** Pins with a condition (`pinWhen` other than 'always') act only when this says so. */
    pinActive?(item: CanonItemLike): boolean;
}

export interface InjectResult {
    added: number;
    replaced: number;
    suppressed: number;
    /** `world.uid` keys to force into the first scan loop. */
    pins: string[];
    /** Items skipped because they are archived and not mentioned. */
    dormant: number;
    /** Base entries an override or suppression could not find in this scan (book inactive or entry gone). */
    missing: number;
}

/** Activation key ST uses in `activated.entries`. */
export function activationKey(world: unknown, uid: unknown): string {
    return `${String(world)}.${String(uid)}`;
}

/** The four lists of a WORLDINFO_ENTRIES_LOADED payload; null when the payload does not look like one. */
export function listsOf(payload: unknown): EntryListsLike | null {
    if (!isDict(payload)) return null;
    const lists = {} as EntryListsLike;
    for (const name of LIST_NAMES) {
        const list = payload[name];
        if (!Array.isArray(list)) return null;
        lists[name] = list as Dict[];
    }
    return lists;
}

/**
 * Takes entries of canon books out of the lists (a canon book must never be active by itself: its overrides would
 * act as plain entries next to their bases). Returns the canon books that were found.
 */
export function stripCanonBooks(lists: EntryListsLike): string[] {
    const found = new Set<string>();
    for (const name of LIST_NAMES) {
        const list = lists[name];
        for (let i = list.length - 1; i >= 0; i--) {
            const world = list[i]?.world;
            if (typeof world !== 'string' || !world.startsWith(CANON_BOOK_PREFIX)) continue;
            // Our own addition copies carry the canon marker; the ones ST loaded from an active canon book do not.
            if (!isOwnCopy(list[i])) found.add(world);
            list.splice(i, 1);
        }
    }
    return [...found].sort();
}

function isOwnCopy(entry: Dict | undefined): boolean {
    const extensions = isDict(entry?.extensions) ? entry.extensions : undefined;
    const maestro = isDict(extensions?.maestro) ? extensions.maestro : undefined;
    return typeof maestro?.canonUid === 'number';
}

function findBase(lists: EntryListsLike, world: string, uid: number): { list: Dict[]; index: number } | null {
    for (const name of LIST_NAMES) {
        const list = lists[name];
        const index = list.findIndex((entry) => entry?.world === world && Number(entry?.uid) === uid);
        if (index >= 0) return { list, index };
    }
    return null;
}

function markerOf(entry: Dict): Dict | undefined {
    const extensions = isDict(entry.extensions) ? entry.extensions : undefined;
    return isDict(extensions?.maestro) ? extensions.maestro : undefined;
}

/** The scan copy of an addition: a fresh object with fresh arrays, in the canon book's name. */
export function additionCopy(item: CanonItemLike, canonBook: string): Dict {
    const copy = copyValue(item.entry);
    const extensions = isDict(copy.extensions) ? copy.extensions : {};
    return {
        ...copy,
        uid: item.uid,
        world: canonBook,
        extensions: { ...extensions, maestro: scanMarker(item) },
    };
}

/** The override of a base scan copy (world and uid of the base; base extensions kept, canon marker added). */
export function overrideCopy(base: Dict, item: CanonItemLike): Dict {
    const copy = materializeOverride(base, item.entry, itemOverrideFields(item.meta, item.entry));
    const extensions = isDict(base.extensions) ? base.extensions : {};
    copy.extensions = { ...extensions, maestro: scanMarker(item) };
    return copy;
}

function acts(item: CanonItemLike, options: InjectOptions, base?: Dict): boolean {
    if (item.meta.status !== 'archived') return true;
    return options.mentioned?.(item, base) === true;
}

/**
 * Applies the canon to the scan copies in place (the lists themselves are per-scan arrays; nested values of the
 * entries are never mutated). Canon books are stripped first, so a second run over the same payload gives the same
 * result.
 */
export function applyCanon(
    lists: EntryListsLike,
    items: readonly CanonItemLike[],
    options: InjectOptions,
): InjectResult {
    const result: InjectResult = { added: 0, replaced: 0, suppressed: 0, pins: [], dormant: 0, missing: 0 };
    stripCanonBooks(lists);
    const ordered = [...items].sort((a, b) => kindRank(a) - kindRank(b) || a.uid - b.uid);
    for (const item of ordered) {
        const base = item.meta.base;
        const found = base && item.meta.kind !== 'addition' ? findBase(lists, base.world, base.uid) : null;
        const current = found ? found.list[found.index] : undefined;
        if (!acts(item, options, current)) {
            result.dormant++;
            continue;
        }
        switch (item.meta.kind) {
            case 'addition':
                lists.chatLore.push(additionCopy(item, options.canonBook));
                result.added++;
                break;
            case 'override':
                if (!found || !current) {
                    result.missing++;
                    break;
                }
                // Already this override (same payload processed twice): rebuilding would give the same object.
                if (markerOf(current)?.canonUid !== item.uid) found.list[found.index] = overrideCopy(current, item);
                result.replaced++;
                break;
            case 'suppress':
                if (!found) {
                    result.missing++;
                    break;
                }
                found.list.splice(found.index, 1);
                result.suppressed++;
                break;
            case 'pin': {
                if (!base) break;
                if (item.meta.pinWhen && item.meta.pinWhen !== 'always' && options.pinActive?.(item) !== true) break;
                const key = activationKey(base.world, base.uid);
                if (!result.pins.includes(key)) result.pins.push(key);
                break;
            }
        }
    }
    return result;
}

/** Overrides first, suppressions after them (a suppression wins over an override of the same base), then the rest. */
function kindRank(item: CanonItemLike): number {
    switch (item.meta.kind) {
        case 'override':
            return 0;
        case 'suppress':
            return 1;
        case 'addition':
            return 2;
        default:
            return 3;
    }
}

/* ------------------------------------------------------------------ mentions */

/** The last `count` messages as one lower-case text (ё → е) for mention checks. */
export function recentText(messages: readonly unknown[], count: number): string {
    const parts: string[] = [];
    for (let i = messages.length - 1; i >= 0 && parts.length < count; i--) {
        const message = messages[i];
        if (!isDict(message) || message.is_system === true) continue;
        if (typeof message.mes === 'string' && message.mes) parts.push(message.mes);
    }
    return parts.reverse().join('\n');
}

/**
 * Any of the keys occurs in the text: plain keys as case-insensitive substrings (Cyrillic keys behave like that in
 * ST anyway), regex keys with their own flags. `text` is the raw recent text.
 */
export function keysMentioned(keys: unknown, text: string): boolean {
    if (!Array.isArray(keys) || !text) return false;
    const normalized = normalizeForMatch(text);
    for (const raw of keys) {
        if (typeof raw !== 'string') continue;
        const key = raw.trim();
        if (!key) continue;
        const regex = parseRegexKey(key);
        if (regex) {
            if (regex.test(text)) return true;
            continue;
        }
        if (normalized.includes(normalizeForMatch(key))) return true;
    }
    return false;
}

/** Keys of an item for the mention check: its own keys, primary and secondary. */
export function itemKeys(item: CanonItemLike): string[] {
    const list = (value: unknown) =>
        Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
    return [...list(item.entry.key), ...list(item.entry.keysecondary)];
}

/* ------------------------------------------------------------------ budget */

/** Is an activated entry the canon's own (an addition copy or an override copy)? */
export function isCanonActivation(entry: unknown, canonBook: string): boolean {
    if (!isDict(entry)) return false;
    if (entry.world === canonBook) return true;
    const marker = markerOf(entry);
    return typeof marker?.canonUid === 'number' && typeof marker.kind === 'string';
}

export interface BudgetCandidate {
    key: string;
    chars: number;
    order: number;
    /** Newer items are kept first among equal orders. */
    updatedAt: number;
}

/**
 * Which new canon activations fit the canon budget (plan M6 п. 7, audit B4): highest `order` first, then the newest;
 * lower-order and older ones are cut first. `used` is what earlier loops of the same scan already keep.
 */
export function planCanonBudget(
    used: number,
    candidates: readonly BudgetCandidate[],
    limit: number,
): { keep: string[]; cut: string[]; used: number } {
    const keep: string[] = [];
    const cut: string[] = [];
    let total = used;
    if (!(limit > 0)) return { keep: candidates.map((item) => item.key), cut, used: total + sum(candidates) };
    const ordered = [...candidates].sort(
        (a, b) => b.order - a.order || b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    for (const item of ordered) {
        if (total + item.chars <= limit) {
            keep.push(item.key);
            total += item.chars;
        } else {
            cut.push(item.key);
        }
    }
    return { keep, cut, used: total };
}

function sum(items: readonly BudgetCandidate[]): number {
    return items.reduce((total, item) => total + item.chars, 0);
}
