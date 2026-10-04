// Pure helpers over World Info entries for the Lore Studio (M23), mirroring ST 1.19 world-info.js semantics
// (research/parity-lore.md §3–§4). No DOM, no SillyTavern: books are plain objects `{ entries: {uid: entry} }`.

export type LoreEntry = Record<string, unknown> & { uid: number };

export interface LoreBook {
    entries: Record<string, LoreEntry>;
    originalData?: unknown;
    [key: string]: unknown;
}

/** `newWorldInfoEntryTemplate` of ST 1.19 (WI:4082-4129, fields without `excludeFromTemplate`). */
export const ENTRY_TEMPLATE: Readonly<Record<string, unknown>> = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
});

/** ST trims backfilled titles to this length (WI `MAX_COMMENT_LENGTH`). */
export const MAX_COMMENT_LENGTH = 100;

/** `originalWIDataKeyMap` of ST 1.19 (WI:2687-2724): entry field → path inside `originalData.entries[i]`. */
export const ORIGINAL_DATA_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
    displayIndex: 'extensions.display_index',
    excludeRecursion: 'extensions.exclude_recursion',
    preventRecursion: 'extensions.prevent_recursion',
    delayUntilRecursion: 'extensions.delay_until_recursion',
    selectiveLogic: 'selectiveLogic',
    comment: 'comment',
    constant: 'constant',
    order: 'insertion_order',
    depth: 'extensions.depth',
    probability: 'extensions.probability',
    position: 'extensions.position',
    role: 'extensions.role',
    content: 'content',
    enabled: 'enabled',
    key: 'keys',
    keysecondary: 'secondary_keys',
    selective: 'selective',
    matchWholeWords: 'extensions.match_whole_words',
    useGroupScoring: 'extensions.use_group_scoring',
    caseSensitive: 'extensions.case_sensitive',
    matchPersonaDescription: 'extensions.match_persona_description',
    matchCharacterDescription: 'extensions.match_character_description',
    matchCharacterPersonality: 'extensions.match_character_personality',
    matchCharacterDepthPrompt: 'extensions.match_character_depth_prompt',
    matchScenario: 'extensions.match_scenario',
    matchCreatorNotes: 'extensions.match_creator_notes',
    scanDepth: 'extensions.scan_depth',
    automationId: 'extensions.automation_id',
    vectorized: 'extensions.vectorized',
    groupOverride: 'extensions.group_override',
    groupWeight: 'extensions.group_weight',
    sticky: 'extensions.sticky',
    cooldown: 'extensions.cooldown',
    delay: 'extensions.delay',
    triggers: 'extensions.triggers',
    ignoreBudget: 'extensions.ignore_budget',
});

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-safe deep copy (book data is JSON on disk). */
export function cloneJson<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/** Structural equality of JSON values (key order does not matter). */
export function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    // NaN never appears in JSON; undefined and a missing key are both "absent" (handled for object keys below).
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((item, index) => sameJson(item, b[index]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
        if (left[key] === undefined && right[key] === undefined) continue;
        if (!sameJson(left[key], right[key])) return false;
    }
    return true;
}

/** A fresh entry from the template (`createWorldInfoEntry`). */
export function templateEntry(uid: number, partial: Record<string, unknown> = {}): LoreEntry {
    return { ...cloneJson({ ...ENTRY_TEMPLATE }), ...cloneJson(partial), uid };
}

/** Smallest unused uid (`getFreeWorldEntryUid`: 0, 1, 2…). */
export function freeUid(entries: Record<string, unknown>): number {
    let uid = 0;
    while (Object.prototype.hasOwnProperty.call(entries, String(uid))) uid++;
    return uid;
}

/** Highest `displayIndex` (missing counts as the uid, like ST's list normalization). */
export function maxDisplayIndex(entries: Record<string, LoreEntry>): number {
    let max = -1;
    for (const entry of Object.values(entries)) {
        const value = displayIndexOf(entry);
        if (value > max) max = value;
    }
    return max;
}

export function displayIndexOf(entry: LoreEntry): number {
    const value = entry.displayIndex;
    return typeof value === 'number' && Number.isFinite(value) ? value : Number(entry.uid);
}

/**
 * The entry as ST's list shows it (`addMissingWorldInfoFields` + `displayIndex` backfill, WI:2104-2136,
 * 2358-2381): a copy with template fields added, `key`/`keysecondary` as arrays and `characterFilter` as an
 * object. Unknown fields are kept. Never written back by itself (every change of a field resets sticky/cooldown).
 */
export function normalizedEntry(entry: LoreEntry): LoreEntry {
    const copy: LoreEntry = { ...cloneJson(entry) };
    for (const [key, value] of Object.entries(ENTRY_TEMPLATE)) {
        if (!Object.prototype.hasOwnProperty.call(copy, key)) copy[key] = cloneJson(value);
    }
    if (!Array.isArray(copy.key)) copy.key = [];
    if (!Array.isArray(copy.keysecondary)) copy.keysecondary = [];
    if (!isRecord(copy.characterFilter)) copy.characterFilter = { isExclude: false, names: [], tags: [] };
    if (typeof copy.displayIndex !== 'number') copy.displayIndex = Number(copy.uid);
    return copy;
}

export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Title shown in lists: the memo, else the primary keys, else ''. */
export function entryTitle(entry: LoreEntry): string {
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    if (comment) return comment;
    return stringList(entry.key).join(', ');
}

export type EntryStatus = 'constant' | 'normal' | 'vectorized';

/** ST's status selector: constant wins over vectorized (WI:3284-3316). */
export function entryStatus(entry: LoreEntry): EntryStatus {
    if (entry.constant === true) return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
}

/** The pair of fields ST writes for a status choice. */
export function statusPatch(status: EntryStatus): { constant: boolean; vectorized: boolean } {
    return { constant: status === 'constant', vectorized: status === 'vectorized' };
}

/** «Положение» of ST: one list of position + role (WI:3413-3440). */
export const POSITION_CHOICES = [
    'before',
    'after',
    'emTop',
    'emBottom',
    'anTop',
    'anBottom',
    'depthSystem',
    'depthUser',
    'depthAssistant',
    'outlet',
] as const;
export type PositionChoice = (typeof POSITION_CHOICES)[number];

const POSITION_BY_CHOICE: Record<PositionChoice, { position: number; role: number | null }> = {
    before: { position: 0, role: null },
    after: { position: 1, role: null },
    anTop: { position: 2, role: null },
    anBottom: { position: 3, role: null },
    depthSystem: { position: 4, role: 0 },
    depthUser: { position: 4, role: 1 },
    depthAssistant: { position: 4, role: 2 },
    emTop: { position: 5, role: null },
    emBottom: { position: 6, role: null },
    outlet: { position: 7, role: null },
};

export function positionChoice(entry: LoreEntry): PositionChoice {
    const position = Number(entry.position ?? 0);
    if (position === 4) {
        const role = Number(entry.role ?? 0);
        return role === 1 ? 'depthUser' : role === 2 ? 'depthAssistant' : 'depthSystem';
    }
    const found = (Object.entries(POSITION_BY_CHOICE) as [PositionChoice, { position: number }][]).find(
        ([, spec]) => spec.position === position,
    );
    return found ? found[0] : 'before';
}

/** Fields ST writes for a position choice (role only kept for «at depth», else null). */
export function positionPatch(choice: PositionChoice): { position: number; role: number | null } {
    return { ...POSITION_BY_CHOICE[choice] };
}

/** Short label of a position for list rows (DES-style `↑Char ↓Char ↑AN ↓AN @D ↑EM ↓EM Outlet`). */
export function positionLabel(entry: LoreEntry): string {
    const choice = positionChoice(entry);
    const depth = Number(entry.depth ?? 4);
    switch (choice) {
        case 'before':
            return '↑Char';
        case 'after':
            return '↓Char';
        case 'anTop':
            return '↑AN';
        case 'anBottom':
            return '↓AN';
        case 'emTop':
            return '↑EM';
        case 'emBottom':
            return '↓EM';
        case 'outlet':
            return 'Outlet';
        case 'depthUser':
            return `@D👤${depth}`;
        case 'depthAssistant':
            return `@D🤖${depth}`;
        default:
            return `@D⚙${depth}`;
    }
}

/** «Заполнить пустые названия» (WI:2479-2494): entries without a memo but with keys get the keys as memo. */
export function backfillComments(entries: Record<string, LoreEntry>): { uid: number; comment: string }[] {
    const result: { uid: number; comment: string }[] = [];
    for (const entry of Object.values(entries)) {
        const keys = stringList(entry.key);
        if (!entry.comment && keys.length > 0) {
            result.push({ uid: entry.uid, comment: keys.join(', ').slice(0, MAX_COMMENT_LENGTH) });
        }
    }
    return result;
}

/** Top-level fields that differ between two versions of an entry. */
export function changedFields(before: LoreEntry | undefined, after: LoreEntry | undefined): string[] {
    const left = before ?? {};
    const right = after ?? {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].filter(
        (key) => !sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
}

export interface EntryDiff {
    added: number[];
    removed: number[];
    changed: { uid: number; fields: string[] }[];
}

/** Which entries a save adds, removes or changes (by uid key). */
export function diffEntries(before: Record<string, LoreEntry>, after: Record<string, LoreEntry>): EntryDiff {
    const diff: EntryDiff = { added: [], removed: [], changed: [] };
    for (const [key, entry] of Object.entries(after)) {
        const previous = before[key];
        if (!previous) {
            diff.added.push(uidOf(key, entry));
            continue;
        }
        const fields = changedFields(previous, entry);
        if (fields.length) diff.changed.push({ uid: uidOf(key, entry), fields });
    }
    for (const [key, entry] of Object.entries(before)) {
        if (!Object.prototype.hasOwnProperty.call(after, key)) diff.removed.push(uidOf(key, entry));
    }
    return diff;
}

function uidOf(key: string, entry: LoreEntry): number {
    return typeof entry.uid === 'number' ? entry.uid : Number(key);
}

export function diffSize(diff: EntryDiff): number {
    return diff.added.length + diff.removed.length + diff.changed.length;
}

/**
 * Paths in `originalData.entries[i]` that mirror a change of one entry field, exactly as the classic editor
 * writes them (sweeping rule 2): the key map plus the manual paths (`enabled`, `position` as before/after_char,
 * outlet, group, character filter) and `extensions.<snake_case>` for the remaining scalar fields.
 */
export function mirrorPaths(
    field: string,
    value: unknown,
    keyMap: Readonly<Record<string, string>> = ORIGINAL_DATA_KEY_MAP,
): { path: string; value: unknown }[] {
    switch (field) {
        case 'uid':
            return [];
        case 'disable':
            return [{ path: 'enabled', value: !value }];
        case 'position':
            return [
                { path: 'position', value: Number(value) === 0 ? 'before_char' : 'after_char' },
                { path: 'extensions.position', value },
            ];
        case 'outletName':
            return [{ path: 'extensions.outlet_name', value }];
        case 'group':
            return [{ path: 'extensions.group', value }];
        case 'characterFilter':
            return [{ path: 'character_filter', value }];
        default: {
            const mapped = keyMap[field];
            return mapped ? [{ path: mapped, value }] : [];
        }
    }
}

/** `setValueByPath` of ST utils (creates intermediate objects). */
export function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let node: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        const next = node[part];
        if (!isRecord(next)) node[part] = {};
        node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] as string] = cloneJson(value);
}

/** The `originalData.entries` array of a card-embedded book, or null. */
export function originalEntries(book: LoreBook): Record<string, unknown>[] | null {
    const original = book.originalData;
    if (!isRecord(original) || !Array.isArray(original.entries)) return null;
    return original.entries.filter(isRecord);
}

/** `setWIOriginalDataValue` (WI:2756-2766) in pure form. */
export function setOriginalValue(book: LoreBook, uid: number, path: string, value: unknown): boolean {
    const list = originalEntries(book);
    const target = list?.find((item) => item.uid === uid);
    if (!target) return false;
    setByPath(target, path, value);
    return true;
}

/** `deleteWIOriginalDataValue` (WI:2774-2784): loose uid comparison like ST. */
export function removeOriginal(book: LoreBook, uid: number): boolean {
    const original = book.originalData;
    if (!isRecord(original) || !Array.isArray(original.entries)) return false;
    const index = original.entries.findIndex((item) => isRecord(item) && String(item.uid) === String(uid));
    if (index < 0) return false;
    original.entries.splice(index, 1);
    return true;
}

const EMPTY_FILTER = { isExclude: false, names: [], tags: [] };

/** A field that normalizedEntry() added (absent before, now the default it fills in). */
export function isNormalizationFill(field: string, before: unknown, after: unknown, uid: number): boolean {
    if (before !== undefined) return false;
    if (field === 'displayIndex') return after === uid;
    if (field === 'characterFilter') return sameJson(after, EMPTY_FILTER);
    return Object.prototype.hasOwnProperty.call(ENTRY_TEMPLATE, field) && sameJson(after, ENTRY_TEMPLATE[field]);
}

export type MirrorSetter = (book: LoreBook, uid: number, path: string, value: unknown) => void;
export type MirrorRemover = (book: LoreBook, uid: number) => void;

/**
 * Keeps `originalData` of a card-embedded book in line with a save: every changed field of every changed entry is
 * mirrored, removed entries are dropped. Added entries are not mirrored (ST does not add them either). Mutates
 * `next` (call before handing it to saveWorldInfo). Returns the number of mirrored writes.
 */
export function mirrorBook(
    previous: LoreBook,
    next: LoreBook,
    options: { set?: MirrorSetter; remove?: MirrorRemover; keyMap?: Readonly<Record<string, string>> } = {},
): number {
    if (!originalEntries(next)) return 0;
    const set: MirrorSetter =
        options.set ?? ((book, uid, path, value) => void setOriginalValue(book, uid, path, value));
    const remove: MirrorRemover = options.remove ?? ((book, uid) => void removeOriginal(book, uid));
    const diff = diffEntries(previous.entries ?? {}, next.entries ?? {});
    let writes = 0;
    for (const change of diff.changed) {
        const entry = next.entries[String(change.uid)];
        if (!entry) continue;
        const before = previous.entries?.[String(change.uid)];
        for (const field of change.fields) {
            // ST fills missing template fields without mirroring them (addMissingWorldInfoFields): neither do we.
            if (isNormalizationFill(field, before?.[field], entry[field], change.uid)) continue;
            for (const { path, value } of mirrorPaths(field, entry[field], options.keyMap)) {
                set(next, change.uid, path, value);
                writes++;
            }
        }
    }
    for (const uid of diff.removed) {
        remove(next, uid);
        writes++;
    }
    return writes;
}

/** Fields the bulk editor may set on many entries at once (common scalar fields of ST's entry form). */
export const BULK_FIELDS = [
    'disable',
    'status',
    'positionChoice',
    'depth',
    'order',
    'probability',
    'useProbability',
    'selectiveLogic',
    'group',
    'groupOverride',
    'groupWeight',
    'scanDepth',
    'caseSensitive',
    'matchWholeWords',
    'useGroupScoring',
    'excludeRecursion',
    'preventRecursion',
    'delayUntilRecursion',
    'ignoreBudget',
    'sticky',
    'cooldown',
    'delay',
    'automationId',
    'outletName',
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
] as const;
export type BulkField = (typeof BULK_FIELDS)[number];

/** Marker for «values differ» in commonValues(). */
export const MIXED = Symbol('mixed');

/** A bulk field's value on one entry (virtual fields `status` and `positionChoice` are derived). */
export function bulkValue(entry: LoreEntry, field: BulkField): unknown {
    const view = normalizedEntry(entry);
    if (field === 'status') return entryStatus(view);
    if (field === 'positionChoice') return positionChoice(view);
    return view[field];
}

/** Value shared by every entry for each field, or MIXED. */
export function commonValues(
    entries: LoreEntry[],
    fields: readonly BulkField[] = BULK_FIELDS,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of fields) {
        let value: unknown = MIXED;
        let first = true;
        for (const entry of entries) {
            const current = bulkValue(entry, field);
            if (first) {
                value = current;
                first = false;
            } else if (!sameJson(value, current)) {
                value = MIXED;
                break;
            }
        }
        result[field] = value;
    }
    return result;
}

/** Real entry fields for a bulk patch (expands `status` and `positionChoice`). */
export function expandBulkPatch(patch: Partial<Record<BulkField, unknown>>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch)) {
        if (value === MIXED || value === undefined) continue;
        if (field === 'status') Object.assign(result, statusPatch(value as EntryStatus));
        else if (field === 'positionChoice') Object.assign(result, positionPatch(value as PositionChoice));
        else result[field] = cloneJson(value);
    }
    return result;
}

/** Applies a patch to an entry copy; `uid` never changes. */
export function patchEntry(entry: LoreEntry, patch: Record<string, unknown>): LoreEntry {
    const next: LoreEntry = { ...cloneJson(entry) };
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'uid') continue;
        if (value === undefined) delete next[key];
        else next[key] = cloneJson(value);
    }
    return next;
}

/** Characters of an entry's content (ST's «Tokens» sorting uses the string length). */
export function contentLength(entry: LoreEntry): number {
    return typeof entry.content === 'string' ? entry.content.length : 0;
}
