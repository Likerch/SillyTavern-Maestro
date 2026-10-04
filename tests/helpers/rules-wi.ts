// Fake World Info for M22 tests: lorebooks as ST caches them, ST-like per-scan copies ({uid, world, ...entry} with
// nested arrays shared with the cache) and a miniature of ST's checkWorldInfo loop that emits
// WORLDINFO_ENTRIES_LOADED and WORLDINFO_SCAN_DONE through the mock event source.
import type { LoreActivation } from '../../src/features/loreJournal/api';
import type { EntryCopy, EntryLists } from '../../src/features/rules/api';
import { EVENT_TYPES } from './st-mock';
import type { StMock } from './st-mock';

export interface WiEntry {
    uid: number;
    key?: string[];
    keysecondary?: string[];
    content: string;
    comment?: string;
    constant?: boolean;
    disable?: boolean;
    position?: number;
    role?: number | null;
    depth?: number;
    order?: number;
    preventRecursion?: boolean;
    excludeRecursion?: boolean;
    delayUntilRecursion?: boolean | number;
    characterFilter?: { isExclude: boolean; names: string[]; tags: string[] };
    triggers?: string[];
}

export interface WiBook {
    name: string;
    entries: WiEntry[];
}

export function entry(uid: number, fields: Partial<WiEntry> = {}): WiEntry {
    return {
        uid,
        key: [`key${uid}`],
        keysecondary: [],
        content: `Content of entry ${uid}.`,
        comment: `Entry ${uid}`,
        position: 0,
        role: null,
        depth: 4,
        order: 100,
        characterFilter: { isExclude: false, names: [], tags: [] },
        triggers: [],
        ...fields,
    };
}

export function book(name: string, entries: WiEntry[]): WiBook {
    return { name, entries };
}

/** ST's copies (world-info.js getGlobalLore): `({ uid, ...rest }) => ({ uid, world, ...rest })`, shallow. */
export function copiesOf(books: WiBook[]): EntryCopy[] {
    return books.flatMap((item) =>
        item.entries.map(({ uid, ...rest }) => ({ uid, world: item.name, ...rest }) as unknown as EntryCopy),
    );
}

export function listsOf(books: WiBook[], where: keyof EntryLists = 'globalLore'): EntryLists {
    const lists: EntryLists = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
    lists[where] = copiesOf(books);
    return lists;
}

/** Deep-freezes the nested arrays and objects of cached entries: in-place mutation by a rule then throws. */
export function freezeNested(books: WiBook[]): void {
    for (const item of books) {
        for (const wi of item.entries) {
            if (wi.key) Object.freeze(wi.key);
            if (wi.keysecondary) Object.freeze(wi.keysecondary);
            if (wi.triggers) Object.freeze(wi.triggers);
            if (wi.characterFilter) {
                Object.freeze(wi.characterFilter.names);
                Object.freeze(wi.characterFilter.tags);
                Object.freeze(wi.characterFilter);
            }
        }
    }
}

function hashOf(value: unknown): number {
    const text = JSON.stringify(value);
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return hash;
}

function keysOf(wi: Record<string, unknown>): string[] {
    return Array.isArray(wi.key) ? wi.key.filter((key): key is string => typeof key === 'string' && !!key) : [];
}

export interface ScanResult {
    activated: Map<string, Record<string, unknown>>;
    sorted: Record<string, unknown>[];
    loops: number;
    /** `activated.entries` content after every loop (keys). */
    perLoop: string[][];
}

/**
 * A miniature of ST's checkWorldInfo (world-info.js 4709-5190): ENTRIES_LOADED with fresh copies, sort by order,
 * hash, structuredClone; then loops activating constants and entries whose key is in the chat text (initial loop)
 * or in chat + recursion text (recursion loops, not for excludeRecursion), skipping disabled and already activated
 * entries and delayUntilRecursion entries in the first loop. Recursion text grows with the content of new
 * activations that are not preventRecursion, before SCAN_DONE (as in ST). SCAN_DONE follows every loop and
 * `state.next` is read back.
 */
export async function runScan(mock: StMock, books: WiBook[], chatText: string, maxLoops = 10): Promise<ScanResult> {
    const lists = listsOf(books);
    await mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
    const merged = [...lists.globalLore, ...lists.characterLore, ...lists.chatLore, ...lists.personaLore].sort(
        (a, b) => Number(b.order ?? 100) - Number(a.order ?? 100),
    );
    const sorted = structuredClone(merged.map((item) => ({ ...item, hash: hashOf(item) }))) as Record<
        string,
        unknown
    >[];
    const activated = new Map<string, Record<string, unknown>>();
    const perLoop: string[][] = [];
    let recursion = '';
    let text = '';
    let state = 1;
    let loop = 0;
    while (state && loop < maxLoops) {
        loop++;
        const fresh: Record<string, unknown>[] = [];
        for (const wi of sorted) {
            if (activated.has(`${String(wi.world)}.${String(wi.uid)}`) || wi.disable === true) continue;
            if (state === 1 && wi.delayUntilRecursion) continue;
            const haystack = (
                state === 1 || wi.excludeRecursion ? chatText : `${chatText}\n${recursion}`
            ).toLowerCase();
            if (wi.constant === true || keysOf(wi).some((key) => haystack.includes(key.toLowerCase()))) fresh.push(wi);
        }
        for (const wi of fresh) activated.set(`${String(wi.world)}.${String(wi.uid)}`, wi);
        const forRecursion = fresh.filter((wi) => wi.preventRecursion !== true);
        const next = forRecursion.length ? 2 : 0;
        const added = forRecursion.map((wi) => String(wi.content ?? '')).join('\n');
        if (next && added) {
            recursion = `${added}\n${recursion}`;
            text = `${added}\n${text}`;
        }
        const args = {
            state: { current: state, next, loopCount: loop },
            new: { all: fresh, successful: fresh },
            activated: { entries: activated, text },
            sortedEntries: sorted,
            recursionDelay: { availableLevels: [], currentLevel: 0 },
            budget: { current: 1_000_000, overflowed: false },
            timedEffects: {},
        };
        await mock.eventSource.emit(EVENT_TYPES.WORLDINFO_SCAN_DONE!, args);
        state = args.state.next;
        perLoop.push([...activated.keys()]);
    }
    return { activated, sorted, loops: loop, perLoop };
}

/** LoreActivation rows (as M1 would record them) of a scan result. */
export function activationsOf(result: ScanResult): LoreActivation[] {
    return [...result.activated.values()].map((wi) => ({
        world: String(wi.world),
        uid: Number(wi.uid),
        comment: String(wi.comment ?? ''),
        chars: String(wi.content ?? '').length,
        tokens: Math.ceil(String(wi.content ?? '').length / 4),
        position: Number(wi.position ?? 0),
        order: Number(wi.order ?? 100),
        loop: 1,
        recursionLevel: 0,
        tags: [],
    }));
}
