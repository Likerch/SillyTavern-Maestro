// Lore entries written by the assistant (M33 «записи лора», M23 typed entries): the tool arguments in plain words
// (title, keys, position by name…) become ST's entry fields; a typed entry (domain/entry-types.ts) gets its content
// composed from the fields; the card shows only the fields that change. Pure: no DOM, no SillyTavern.
import {
    ArgError,
    isDict,
    jsonCopy,
    optBool,
    optEnum,
    optInt,
    optString,
    optStringList,
    sameJson,
} from './assistant-write-args';
import type { Dict } from './assistant-write-args';
import { composeContent, ENTRY_TYPES, ENTRY_TYPE_IDS, isEntryType, readTypedMeta } from './entry-types';
import type { EntryTypeId, TypedEntryMeta } from './entry-types';

/** ST's `world_info_position` by name (the outlet position needs an outlet name, so it is not offered). */
export const WI_POSITIONS = {
    before_char: 0,
    after_char: 1,
    an_top: 2,
    an_bottom: 3,
    at_depth: 4,
    em_top: 5,
    em_bottom: 6,
} as const;

export type WiPositionName = keyof typeof WI_POSITIONS;
export const WI_POSITION_NAMES = Object.keys(WI_POSITIONS) as WiPositionName[];

export const MAX_KEYS = 50;
export const MAX_KEY_LENGTH = 200;
export const MAX_CONTENT = 30000;
export const MAX_TITLE = 200;
export const MAX_DEPTH = 9999;
export const MAX_ORDER = 100000;

/** What the tool may set on an entry (plain words; ST field names in comments). */
export interface EntryChanges {
    /** comment */
    title?: string;
    content?: string;
    /** key */
    keys?: string[];
    /** keysecondary */
    secondaryKeys?: string[];
    constant?: boolean;
    /** !disable */
    enabled?: boolean;
    position?: WiPositionName;
    depth?: number;
    order?: number;
}

/** Reads the entry fields of a tool's arguments (all optional). */
export function readEntryChanges(args: Dict): EntryChanges {
    const changes: EntryChanges = {};
    const title = optString(args, 'title', { max: MAX_TITLE, allowEmpty: true });
    if (title !== undefined) changes.title = title;
    const content = optString(args, 'content', { raw: true, max: MAX_CONTENT, allowEmpty: true });
    if (content !== undefined) changes.content = content.trim();
    const keyOptions = { maxItems: MAX_KEYS, maxLength: MAX_KEY_LENGTH, unique: true, fromString: 'split' as const };
    const keys = optStringList(args, 'keys', keyOptions);
    if (keys !== undefined) changes.keys = keys;
    const secondary = optStringList(args, 'secondaryKeys', keyOptions);
    if (secondary !== undefined) changes.secondaryKeys = secondary;
    const constant = optBool(args, 'constant');
    if (constant !== undefined) changes.constant = constant;
    const enabled = optBool(args, 'enabled');
    if (enabled !== undefined) changes.enabled = enabled;
    const position = optEnum(args, 'position', WI_POSITION_NAMES);
    if (position !== undefined) changes.position = position;
    const depth = optInt(args, 'depth', 0, MAX_DEPTH);
    if (depth !== undefined) {
        changes.depth = depth;
        // A depth means «in the chat at that depth» unless a position says otherwise.
        changes.position ??= 'at_depth';
    }
    const order = optInt(args, 'order', 0, MAX_ORDER);
    if (order !== undefined) changes.order = order;
    return changes;
}

/** ST entry fields for the changes. */
export function entryPatch(changes: EntryChanges): Dict {
    const patch: Dict = {};
    if (changes.title !== undefined) patch.comment = changes.title;
    if (changes.content !== undefined) patch.content = changes.content;
    if (changes.keys !== undefined) patch.key = [...changes.keys];
    if (changes.secondaryKeys !== undefined) {
        patch.keysecondary = [...changes.secondaryKeys];
        // Secondary keys only work on a «selective» entry.
        if (changes.secondaryKeys.length) patch.selective = true;
    }
    if (changes.constant !== undefined) patch.constant = changes.constant;
    if (changes.enabled !== undefined) patch.disable = !changes.enabled;
    if (changes.position !== undefined) patch.position = WI_POSITIONS[changes.position];
    if (changes.depth !== undefined) patch.depth = changes.depth;
    if (changes.order !== undefined) patch.order = changes.order;
    return patch;
}

/** The typed meta from a type id and field values; unknown types and field ids are errors. */
export function typedMetaOf(type: string, fields: Dict | undefined, base?: TypedEntryMeta | null): TypedEntryMeta {
    if (!isEntryType(type)) throw new ArgError('loreBadType', { type, list: ENTRY_TYPE_IDS.join(', ') });
    const allowed = ENTRY_TYPES[type].fields.map((field) => field.id);
    const values: Record<string, string> = base && base.type === type ? { ...base.fields } : {};
    for (const [key, value] of Object.entries(fields ?? {})) {
        if (!allowed.includes(key)) {
            throw new ArgError('loreBadField', { type, field: key, list: allowed.join(', ') });
        }
        if (value === null || value === undefined) {
            delete values[key];
            continue;
        }
        if (typeof value !== 'string' && typeof value !== 'number') {
            throw new ArgError('argType', { name: `fields.${key}`, expected: 'string' });
        }
        values[key] = String(value).replace(/\r\n?/g, '\n').trim();
    }
    return { type: type as EntryTypeId, fields: values };
}

/** The type ids with their field ids (for the tool description and errors). */
export function typeCatalogue(): string {
    return ENTRY_TYPE_IDS.map((id) => `${id}(${ENTRY_TYPES[id].fields.map((field) => field.id).join(',')})`).join('; ');
}

/** The title of a new entry: the given one, the typed name, else the start of the content. */
export function defaultTitle(changes: EntryChanges, meta: TypedEntryMeta | null): string {
    if (changes.title) return changes.title;
    const first = meta ? ENTRY_TYPES[meta.type].fields[0] : undefined;
    const name = first && meta ? (meta.fields[first.id] ?? '').trim() : '';
    if (name) return name;
    const line = (changes.content ?? '').split('\n')[0] ?? '';
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Content composed from the typed meta (empty fields skipped). */
export function composedContent(meta: TypedEntryMeta): string {
    return composeContent(meta);
}

/** Typed meta stored on an entry (`extensions.maestro`), or null. */
export function entryTypedMeta(entry: Dict): TypedEntryMeta | null {
    return readTypedMeta(isDict(entry.extensions) ? entry.extensions.maestro : undefined);
}

/** Values of the patched fields before and after, only those that differ (the card). */
export function changedFields(entry: Dict, patch: Dict): { before: Dict; after: Dict } {
    const before: Dict = {};
    const after: Dict = {};
    for (const [key, value] of Object.entries(patch)) {
        const current = entry[key];
        if (sameJson(current ?? null, value ?? null)) continue;
        before[key] = current === undefined ? null : jsonCopy(current);
        after[key] = value === undefined ? null : jsonCopy(value);
    }
    return { before, after };
}

/** The entry as the card shows it (plain words, the fields a person cares about). */
export function entryView(fields: Dict): Dict {
    const view: Dict = {};
    if (typeof fields.comment === 'string') view.title = fields.comment;
    if (Array.isArray(fields.key)) view.keys = fields.key;
    if (Array.isArray(fields.keysecondary) && fields.keysecondary.length) view.secondaryKeys = fields.keysecondary;
    if (typeof fields.constant === 'boolean') view.constant = fields.constant;
    if (typeof fields.disable === 'boolean') view.enabled = !fields.disable;
    if (typeof fields.position === 'number') {
        const name = WI_POSITION_NAMES.find((item) => WI_POSITIONS[item] === fields.position);
        view.position = name ?? fields.position;
    }
    if (typeof fields.depth === 'number') view.depth = fields.depth;
    if (typeof fields.order === 'number') view.order = fields.order;
    if (typeof fields.content === 'string') view.content = fields.content;
    return view;
}

/** Names of the changed fields in plain words (for the summary line). */
export function changedNames(patch: Dict): string[] {
    return Object.keys(entryView(patch));
}
