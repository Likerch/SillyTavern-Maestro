// M6 «Канон чата» — the canon lorebook, pure parts (plan M6, §4.8, §4.9; audit T1, C1). One lorebook per chat, never
// active by itself: Maestro mixes it into the scan. Every item is an entry whose `extensions.maestro` holds its
// meta (kind, status, origin, base link). Here: the book name, entry templates, reading items, materialising an
// override over its base, base drift and the plain export.
// Pure: no DOM, no SillyTavern.
import { stableHash } from './hash';
import { CANON_BOOK_PREFIX } from './lore-journal';
import { entryContentHash } from './roles-meta';

type Dict = Record<string, unknown>;

export const CANON_KINDS = ['override', 'addition', 'suppress', 'pin'] as const;
export const CANON_STATUSES = ['active', 'provisional', 'archived'] as const;
export const CANON_ORIGINS = ['user', 'revision', 'living', 'chronicle', 'backstage', 'entity', 'import'] as const;

export type CanonKindId = (typeof CANON_KINDS)[number];
export type CanonStatusId = (typeof CANON_STATUSES)[number];

/** Fields of a WI entry that are bookkeeping, never override fields. */
export const BOOKKEEPING_FIELDS: readonly string[] = [
    'uid',
    'world',
    'displayIndex',
    'extensions',
    'hash',
    'decorators',
];
/** An override never switches its base on or off (that is what suppression is for). */
const NEVER_OVERRIDE: readonly string[] = [...BOOKKEEPING_FIELDS, 'disable'];
/** Override fields when the item does not list them (text and keys). */
export const DEFAULT_OVERRIDE_FIELDS: readonly string[] = ['content', 'key', 'keysecondary', 'comment'];

/** ST 1.19 `newWorldInfoEntryTemplate` (world-info.js 4082-4130). */
export const WI_ENTRY_TEMPLATE: Readonly<Dict> = Object.freeze({
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
    characterFilter: { isExclude: false, names: [], tags: [] },
});

export function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canon book of a chat: "Maestro · канон · <8 chars of a stable hash of the chat id>". */
export function canonBookName(chatId: string): string {
    const id = stableHash(chatId).padStart(8, '0').slice(0, 8);
    return `${CANON_BOOK_PREFIX} · ${id}`;
}

/**
 * A fresh copy of a value for an entry copy: arrays and plain objects are rebuilt (nested arrays of ST's cache must
 * never be shared with a copy someone may change), primitives pass through.
 */
export function copyValue<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => copyValue(item)) as T;
    if (isDict(value)) {
        const out: Dict = {};
        for (const [key, item] of Object.entries(value)) out[key] = copyValue(item);
        return out as T;
    }
    return value;
}

/** JSON-safe deep copy (books are JSON). */
export function jsonClone<T>(value: T): T {
    const text = JSON.stringify(value);
    return text === undefined ? value : (JSON.parse(text) as T);
}

/** Lowest free uid of a book (ST's getFreeWorldEntryUid). */
export function freeUid(entries: Dict): number {
    let uid = 0;
    while (Object.prototype.hasOwnProperty.call(entries, String(uid))) uid++;
    return uid;
}

/** Template fields missing from `entry`, filled with fresh defaults (arrays are never shared with the template). */
export function withTemplate(entry: Dict): Dict {
    const out: Dict = {};
    for (const [key, value] of Object.entries(WI_ENTRY_TEMPLATE)) {
        out[key] = Object.prototype.hasOwnProperty.call(entry, key) ? copyValue(entry[key]) : copyValue(value);
    }
    for (const [key, value] of Object.entries(entry)) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = copyValue(value);
    }
    return out;
}

/** Fields an override replaces: the listed ones (or text and keys), never bookkeeping or `disable`. */
export function overrideFields(explicit: unknown, entry?: Dict): string[] {
    const listed = Array.isArray(explicit) ? explicit.filter((item): item is string => typeof item === 'string') : null;
    const base = listed && listed.length ? listed : entry ? Object.keys(entry) : [...DEFAULT_OVERRIDE_FIELDS];
    return [...new Set(base)].filter((field) => !NEVER_OVERRIDE.includes(field));
}

function hasValue(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim() !== '';
    return value !== undefined && value !== null;
}

/**
 * Override fields of a stored item: its own list, or — for items made without one — the default fields that hold
 * a value (an empty template `key: []` must not wipe the base's keys).
 */
export function itemOverrideFields(meta: { fields?: unknown }, entry: Dict): string[] {
    if (Array.isArray(meta.fields) && meta.fields.length) return overrideFields(meta.fields);
    return DEFAULT_OVERRIDE_FIELDS.filter((field) => hasValue(entry[field]));
}

/**
 * The base entry with the override's fields (fresh arrays), keeping the base's world and uid. Works on a scan copy
 * (`{uid, world, ...}`) as well as on a stored entry.
 */
export function materializeOverride(base: Dict, override: Dict, fields: readonly string[]): Dict {
    const out: Dict = { ...base };
    for (const field of fields) {
        if (NEVER_OVERRIDE.includes(field) || !Object.prototype.hasOwnProperty.call(override, field)) continue;
        out[field] = copyValue(override[field]);
    }
    if ('world' in base) out.world = base.world;
    out.uid = base.uid;
    return out;
}

/* ------------------------------------------------------------------ items */

/** The parts of CanonMeta the pure helpers read (structurally compatible with src/features/canon/api.ts). */
export interface CanonMetaLike {
    kind: CanonKindId;
    status: CanonStatusId;
    origin: string;
    type?: string;
    base?: { world: string; uid: number; contentHash: string; content?: string };
    sourceMessage?: number;
    createdAt: number;
    updatedAt: number;
    survivedTurns?: number;
    pinWhen?: string;
    fields?: string[];
}

export interface CanonItemLike {
    uid: number;
    meta: CanonMetaLike;
    entry: Dict;
}

const KNOWN_META_FIELDS: readonly string[] = [
    'kind',
    'status',
    'origin',
    'type',
    'base',
    'sourceMessage',
    'createdAt',
    'updatedAt',
    'survivedTurns',
    'pinWhen',
    'fields',
];

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
    return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Validated meta of a stored canon entry; null when the entry is not a canon item. */
export function readCanonMeta(raw: unknown): CanonMetaLike | null {
    if (!isDict(raw) || !(CANON_KINDS as readonly string[]).includes(String(raw.kind))) return null;
    const meta: CanonMetaLike = {
        kind: raw.kind as CanonKindId,
        status: oneOf(CANON_STATUSES, raw.status, 'active'),
        origin: oneOf(CANON_ORIGINS, raw.origin, 'user'),
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    };
    if (typeof raw.type === 'string') meta.type = raw.type;
    if (isDict(raw.base) && typeof raw.base.world === 'string' && Number.isInteger(raw.base.uid)) {
        meta.base = {
            world: raw.base.world,
            uid: raw.base.uid as number,
            contentHash: typeof raw.base.contentHash === 'string' ? raw.base.contentHash : '',
        };
        if (typeof raw.base.content === 'string') meta.base.content = raw.base.content;
    }
    if (typeof raw.sourceMessage === 'number') meta.sourceMessage = raw.sourceMessage;
    if (typeof raw.survivedTurns === 'number') meta.survivedTurns = raw.survivedTurns;
    if (typeof raw.pinWhen === 'string') meta.pinWhen = raw.pinWhen;
    if (Array.isArray(raw.fields)) meta.fields = raw.fields.filter((item): item is string => typeof item === 'string');
    // Unknown meta fields of later stages are kept as they are.
    for (const [key, value] of Object.entries(raw)) {
        if (!KNOWN_META_FIELDS.includes(key)) (meta as unknown as Dict)[key] = value;
    }
    if (meta.kind !== 'addition' && !meta.base) return null;
    return meta;
}

/**
 * Canon items of a loaded canon book, by uid. An entry without canon meta (made by hand in the Lore Studio or ST's
 * editor) is a user addition; one whose meta is broken (an override without a base) is not an item.
 */
export function canonItemsOf(data: unknown): CanonItemLike[] {
    const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
    const items: CanonItemLike[] = [];
    for (const [key, entry] of Object.entries(entries)) {
        if (!isDict(entry)) continue;
        const extensions = isDict(entry.extensions) ? entry.extensions : {};
        const raw = extensions.maestro;
        const meta =
            isDict(raw) && raw.kind !== undefined
                ? readCanonMeta(raw)
                : ({ kind: 'addition', status: 'active', origin: 'user', createdAt: 0, updatedAt: 0 } as CanonMetaLike);
        if (!meta) continue;
        const uid = Number.isInteger(entry.uid) ? (entry.uid as number) : Number(key);
        if (!Number.isInteger(uid)) continue;
        items.push({ uid, meta, entry });
    }
    return items.sort((a, b) => a.uid - b.uid);
}

/** The slot an item occupies on its base: an override and a suppression exclude each other, a pin is separate. */
export function baseSlot(kind: CanonKindId): 'replace' | 'pin' | null {
    if (kind === 'override' || kind === 'suppress') return 'replace';
    return kind === 'pin' ? 'pin' : null;
}

/** The existing item a new draft updates: same base and slot. */
export function findItemForBase(
    items: readonly CanonItemLike[],
    kind: CanonKindId,
    base: { world: string; uid: number } | undefined,
): CanonItemLike | undefined {
    const slot = baseSlot(kind);
    if (!slot || !base) return undefined;
    return items.find(
        (item) =>
            baseSlot(item.meta.kind) === slot &&
            item.meta.base?.world === base.world &&
            item.meta.base.uid === base.uid,
    );
}

/**
 * A canon entry as stored in the canon book: the WI template, the draft's fields, `extensions.maestro` = meta.
 * Items that are not additions are disabled in the book: alone they mean nothing (if the user ever activates the
 * canon book directly, only additions act).
 */
export function buildCanonEntry(uid: number, fields: Dict, meta: CanonMetaLike, fallbackComment = ''): Dict {
    const entry = withTemplate(fields);
    entry.uid = uid;
    if (!entry.comment && fallbackComment) entry.comment = fallbackComment;
    if (meta.kind !== 'addition') entry.disable = true;
    const extensions = isDict(fields.extensions) ? copyValue(fields.extensions) : {};
    entry.extensions = { ...extensions, maestro: copyValue(meta) };
    delete entry.world;
    delete entry.hash;
    delete entry.decorators;
    return entry;
}

/** The marker a scan copy carries (stable between turns: no timestamps, so the entry hash stays the same). */
export function scanMarker(item: CanonItemLike): Dict {
    const marker: Dict = {
        kind: item.meta.kind,
        status: item.meta.status,
        origin: item.meta.origin,
        canonUid: item.uid,
    };
    if (item.meta.type) marker.type = item.meta.type;
    return marker;
}

/* ------------------------------------------------------------------ drift */

/** Base text when the item was made vs now; null when the base did not change. A missing base counts as drift. */
export function baseDriftOf(item: CanonItemLike, baseEntry: unknown): { then: string; now: string } | null {
    const base = item.meta.base;
    if (!base) return null;
    const now = isDict(baseEntry) && typeof baseEntry.content === 'string' ? baseEntry.content : '';
    if (isDict(baseEntry) && entryContentHash(baseEntry) === base.contentHash) return null;
    return { then: base.content ?? '', now };
}

/* ------------------------------------------------------------------ export */

export interface ExportLabels {
    noteTitle: string;
    suppressed: string;
    overridden: string;
    pinned: string;
    /** "{world} — {comment} (uid {uid})". */
    line(world: string, uid: number, comment: string): string;
}

function stripMaestro(entry: Dict): Dict {
    const out = { ...entry };
    if (isDict(out.extensions)) {
        const extensions = { ...out.extensions };
        delete extensions.maestro;
        if (Object.keys(extensions).length) out.extensions = extensions;
        else delete out.extensions;
    }
    delete out.world;
    delete out.hash;
    delete out.decorators;
    return out;
}

/**
 * A plain lorebook from the canon (plan §4.9 «Экспорт канона»): additions as they are, overrides materialised over
 * their base (the base itself when the override is gone), and one disabled note entry listing the suppressed,
 * overridden and pinned base entries (they need the user's attention once Maestro no longer mixes the canon in).
 */
export function buildExportBook(
    items: readonly CanonItemLike[],
    baseOf: (world: string, uid: number) => Dict | null,
    labels: ExportLabels,
): { entries: Record<string, Dict> } {
    const entries: Record<string, Dict> = {};
    let next = 0;
    const add = (entry: Dict) => {
        const uid = next++;
        entries[String(uid)] = { ...withTemplate(stripMaestro(entry)), uid, displayIndex: uid };
    };
    const notes = { suppressed: [] as string[], overridden: [] as string[], pinned: [] as string[] };
    const describe = (item: CanonItemLike): string => {
        const base = item.meta.base;
        const entry = base ? baseOf(base.world, base.uid) : null;
        const comment = entry && typeof entry.comment === 'string' ? entry.comment : '';
        return labels.line(base?.world ?? '', base?.uid ?? -1, comment);
    };
    for (const item of items) {
        const base = item.meta.base;
        if (item.meta.kind === 'addition') {
            add({ ...item.entry, disable: false });
        } else if (item.meta.kind === 'override' && base) {
            const baseEntry = baseOf(base.world, base.uid);
            const fields = itemOverrideFields(item.meta, item.entry);
            add(baseEntry ? materializeOverride(baseEntry, item.entry, fields) : { ...item.entry, disable: false });
            notes.overridden.push(describe(item));
        } else if (item.meta.kind === 'suppress') {
            notes.suppressed.push(describe(item));
        } else if (item.meta.kind === 'pin') {
            notes.pinned.push(describe(item));
        }
    }
    const sections: string[] = [];
    if (notes.suppressed.length) sections.push(`${labels.suppressed}\n${notes.suppressed.join('\n')}`);
    if (notes.overridden.length) sections.push(`${labels.overridden}\n${notes.overridden.join('\n')}`);
    if (notes.pinned.length) sections.push(`${labels.pinned}\n${notes.pinned.join('\n')}`);
    if (sections.length) {
        add({ comment: labels.noteTitle, content: sections.join('\n\n'), disable: true, key: [] });
    }
    return { entries };
}

/** `base`, or `base (2)`, `base (3)`… — the first name not taken (case-insensitive, like ST's world names). */
export function uniqueBookName(base: string, existing: Iterable<string>): string {
    const taken = new Set([...existing].map((name) => name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let index = 2; ; index++) {
        const name = `${base} (${index})`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}
