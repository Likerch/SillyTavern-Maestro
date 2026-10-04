// File-level fixes of lorebook entries (plan M5 «Лечение», M22 «Архив CK по последнему сообщению»; P13).
// A fix is a list of per-entry patches `{uid, before, after}` over a few fields: applying checks that every entry still
// holds `before` (nothing changed since the proposal) and writes `after`; reverting does the opposite. The same patches
// are the journal's before/after, so undo restores exactly what the fix replaced.
// BunnyMo books (core and packs) are never edited: `isBunnyMoBook` is the last check before any write.
// I/O comes from the caller (`BookIo`): this file stays free of SillyTavern.
import { classifyWorlds, isCharacterArchive } from './bunnymo';
import { regexKeyProblem } from './doctor-keys';
import { convertKeyList, effectiveFlag, isLeftBoundaryCandidate } from './rules-keys';

export type RawEntry = Record<string, unknown>;
/** Field values of one entry (a subset of its fields); `undefined` means "field absent". */
export type FieldValues = Record<string, unknown>;

export interface BookData {
    entries: Record<string, RawEntry>;
    [key: string]: unknown;
}

export interface EntryPatch {
    uid: number;
    before: FieldValues;
    after: FieldValues;
}

export interface BookIo {
    /** A fresh deep copy of the book, null when it does not exist. */
    load(book: string): Promise<BookData | null>;
    /** Immediate save (and whatever must follow it: editor reload, neighbour caches). */
    save(book: string, data: BookData): Promise<void>;
}

export type PatchDirection = 'apply' | 'revert';

export interface PatchResult {
    ok: boolean;
    /** 'missing' (no book or entry), 'stale' (an entry changed since), 'protected' (the guard refused). */
    reason?: 'missing' | 'stale' | 'protected';
    /** uids that blocked the write. */
    uids: number[];
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBookData(value: unknown): value is BookData {
    return isDict(value) && isDict(value.entries);
}

/** JSON with sorted object keys; `undefined` and `null` are the same ("use the default"). */
export function stableStringify(value: unknown): string {
    if (value === undefined || value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (isDict(value)) {
        return `{${Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** The entry holds exactly these field values. */
export function entryHas(entry: RawEntry, values: FieldValues): boolean {
    return Object.entries(values).every(([field, value]) => stableStringify(entry[field]) === stableStringify(value));
}

/** The stored key of an entry by uid (`entries[uid]`, or the entry whose `uid` field matches). */
export function entryKeyOf(data: BookData, uid: number): string | null {
    const direct = data.entries[String(uid)];
    if (isDict(direct)) return String(uid);
    for (const [key, entry] of Object.entries(data.entries)) {
        if (isDict(entry) && Number(entry.uid) === uid) return key;
    }
    return null;
}

function copyValue<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * A new book object with the patches applied (or reverted); the input is not modified. All or nothing: any missing
 * or changed entry blocks the whole write.
 */
export function patchBookData(
    data: BookData,
    patches: readonly EntryPatch[],
    direction: PatchDirection = 'apply',
): PatchResult & { data?: BookData } {
    const missing: number[] = [];
    const stale: number[] = [];
    const targets: { key: string; entry: RawEntry; values: FieldValues }[] = [];
    for (const patch of patches) {
        const key = entryKeyOf(data, patch.uid);
        const entry = key === null ? undefined : data.entries[key];
        if (key === null || !entry) {
            missing.push(patch.uid);
            continue;
        }
        const from = direction === 'apply' ? patch.before : patch.after;
        const to = direction === 'apply' ? patch.after : patch.before;
        if (!entryHas(entry, from)) stale.push(patch.uid);
        else targets.push({ key, entry, values: to });
    }
    if (missing.length) return { ok: false, reason: 'missing', uids: missing };
    if (stale.length) return { ok: false, reason: 'stale', uids: stale };
    const entries = { ...data.entries };
    for (const { key, entry, values } of targets) {
        const next: RawEntry = { ...(entries[key] ?? entry) };
        for (const [field, value] of Object.entries(values)) {
            if (value === undefined) delete next[field];
            else next[field] = copyValue(value);
        }
        entries[key] = next;
    }
    return { ok: true, uids: [], data: { ...data, entries } };
}

/** Loads, checks (guard, then every patch) and saves the book in one go. */
export async function commitPatches(
    io: BookIo,
    book: string,
    patches: readonly EntryPatch[],
    options: { direction?: PatchDirection; guard?: (data: BookData) => boolean } = {},
): Promise<PatchResult> {
    const data = await io.load(book);
    if (!data) return { ok: false, reason: 'missing', uids: [] };
    if (options.guard && !options.guard(data)) return { ok: false, reason: 'protected', uids: [] };
    const result = patchBookData(data, patches, options.direction ?? 'apply');
    if (!result.ok || !result.data) return { ok: false, reason: result.reason, uids: result.uids };
    await io.save(book, result.data);
    return { ok: true, uids: patches.map((patch) => patch.uid) };
}

/** Entries of a stored book in the shape the BunnyMo heuristics read. */
function likeScan(book: string, data: BookData): RawEntry[] {
    return Object.values(data.entries)
        .filter(isDict)
        .map((entry) => ({ ...entry, world: book }));
}

/** The book is the BunnyMo core or a pack by its content (P13: never edited). */
export function isBunnyMoBook(book: string, data: BookData): boolean {
    const classified = classifyWorlds(likeScan(book, data));
    return classified.core.has(book) || classified.packs.has(book);
}

/** The book holds at least one character archive. */
export function hasArchives(data: BookData): boolean {
    return Object.values(data.entries).some((entry) => isDict(entry) && isCharacterArchive(entry));
}

/** Enabled entries with their uid. */
export function enabledEntriesOf(data: BookData): { uid: number; entry: RawEntry }[] {
    const result: { uid: number; entry: RawEntry }[] = [];
    for (const [key, entry] of Object.entries(data.entries)) {
        if (!isDict(entry) || entry.disable === true) continue;
        const uid = Number(entry.uid ?? key);
        if (Number.isFinite(uid)) result.push({ uid, entry });
    }
    return result;
}

/* ------------------------------------------------------------------ planners */

const AT_DEPTH = 4;
const ROLE_ASSISTANT = 2;
const ROLE_SYSTEM = 0;

/** At-depth entry with the assistant role → system (audit A9: user-role entries stay). */
export function planRoleFix(uid: number, entry: RawEntry): EntryPatch | null {
    if (Number(entry.position) !== AT_DEPTH || entry.role === null || Number(entry.role) !== ROLE_ASSISTANT)
        return null;
    return { uid, before: { role: entry.role }, after: { role: ROLE_SYSTEM } };
}

/** Scan depth 1 → the global setting (null). */
export function planScanDepthFix(uid: number, entry: RawEntry): EntryPatch | null {
    if (entry.scanDepth === null || entry.scanDepth === undefined || Number(entry.scanDepth) !== 1) return null;
    return { uid, before: { scanDepth: entry.scanDepth }, after: { scanDepth: null } };
}

/** Lorebook Localizer's provenance marker (`extensions.lorebook_localizer`). */
const LOCALIZER_MARKER = 'lorebook_localizer';
const KEY_FIELDS = ['key', 'keysecondary'] as const;

function stringKeys(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
}

/** `\{` / `\}` → `[{]` / `[}]`; null when the key is still broken afterwards. */
export function repairBraces(key: string): string | null {
    const repaired = key.replace(/\\([{}])/g, '[$1]');
    return regexKeyProblem(repaired) === null ? repaired : null;
}

/**
 * Keys Lorebook Localizer added that do not work in ST (audit T2): `\{`/`\}` are respelled `[{]`/`[}]` when that
 * makes them valid, other broken ones (flags, unescaped `/`, `\-` with `u`) are removed — from the key lists and from
 * the marker's `added` lists, so the marker keeps describing the entry.
 */
export function planLocalizerFix(uid: number, entry: RawEntry): EntryPatch | null {
    const extensions = isDict(entry.extensions) ? entry.extensions : null;
    const marker = extensions && isDict(extensions[LOCALIZER_MARKER]) ? extensions[LOCALIZER_MARKER] : null;
    const languages = marker && isDict(marker.languages) ? marker.languages : null;
    if (!extensions || !marker || !languages) return null;
    const replace = new Map<string, string | null>();
    for (const state of Object.values(languages)) {
        const added = isDict(state) && isDict(state.added) ? state.added : null;
        if (!added) continue;
        for (const field of KEY_FIELDS) {
            for (const key of stringKeys(added[field])) {
                const problem = regexKeyProblem(key);
                if (problem === null || replace.has(key)) continue;
                replace.set(key, problem === 'braces' ? repairBraces(key) : null);
            }
        }
    }
    if (!replace.size) return null;
    const fix = (keys: unknown): unknown =>
        Array.isArray(keys)
            ? keys.flatMap((key: unknown) => {
                  if (typeof key !== 'string' || !replace.has(key)) return [key];
                  const next = replace.get(key);
                  return next ? [next] : [];
              })
            : keys;
    const nextLanguages = Object.fromEntries(
        Object.entries(languages).map(([lang, state]) => {
            if (!isDict(state) || !isDict(state.added)) return [lang, state];
            const added = { ...state.added };
            for (const field of KEY_FIELDS) if (Array.isArray(added[field])) added[field] = fix(added[field]);
            return [lang, { ...state, added }];
        }),
    );
    const after: FieldValues = {
        extensions: { ...extensions, [LOCALIZER_MARKER]: { ...marker, languages: nextLanguages } },
    };
    const before: FieldValues = { extensions };
    for (const field of KEY_FIELDS) {
        if (!Array.isArray(entry[field])) continue;
        const next = fix(entry[field]);
        if (stableStringify(next) === stableStringify(entry[field])) continue;
        before[field] = entry[field];
        after[field] = next;
    }
    return { uid, before, after };
}

export interface MatchGlobals {
    /** `world_info_case_sensitive`. */
    caseSensitive: boolean;
    /** `world_info_match_whole_words`. */
    wholeWords: boolean;
}

/**
 * Plain Cyrillic keys of an enabled entry with effective whole-word matching → left-boundary regex keys (the same
 * conversion as rule `keys.cyrillicLeftBoundary`, written to the file).
 */
export function planCyrillicFix(uid: number, entry: RawEntry, globals: MatchGlobals): EntryPatch | null {
    if (entry.disable === true || !effectiveFlag(entry.matchWholeWords, globals.wholeWords)) return null;
    const caseSensitive = effectiveFlag(entry.caseSensitive, globals.caseSensitive);
    const before: FieldValues = {};
    const after: FieldValues = {};
    for (const field of KEY_FIELDS) {
        const next = convertKeyList(entry[field], caseSensitive);
        if (!next) continue;
        before[field] = entry[field];
        after[field] = next;
    }
    return Object.keys(after).length ? { uid, before, after } : null;
}

/**
 * A CK archive saved with scan depth 1 (Baby Bunny): scan depth → global and, when `formsKey` is given (DES-RU's
 * `nameFormsKey`), one regex key with every case form added after the plain Cyrillic name keys. The plain keys stay
 * first: CarrotKernel takes a character's name from `key[0]` when the entry has no comment.
 */
export function planArchiveDepthFix(
    uid: number,
    entry: RawEntry,
    formsKey?: (name: string) => string | null,
): EntryPatch | null {
    const depth = planScanDepthFix(uid, entry);
    if (!depth) return null;
    const before: FieldValues = { ...depth.before };
    const after: FieldValues = { ...depth.after };
    if (formsKey && Array.isArray(entry.key)) {
        const added: string[] = [];
        for (const key of entry.key as unknown[]) {
            if (!isLeftBoundaryCandidate(key) && !(typeof key === 'string' && isMultiWordName(key))) continue;
            let regex: string | null;
            try {
                regex = formsKey((key as string).trim());
            } catch {
                regex = null;
            }
            if (typeof regex === 'string' && regex && !entry.key.includes(regex)) added.push(regex);
        }
        if (added.length) {
            before.key = entry.key;
            after.key = [...new Set([...(entry.key as unknown[]), ...added])];
        }
    }
    return { uid, before, after };
}

/** «Аня Петрова»: a plain multi-word Cyrillic name (DES-RU forms every word). */
function isMultiWordName(key: string): boolean {
    const trimmed = key.trim();
    return /\s/.test(trimmed) && trimmed.split(/\s+/).every((word) => isLeftBoundaryCandidate(word));
}
