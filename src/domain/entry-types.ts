// Typed lorebook entries (plan M23, new possibility 1): templates of fields per entry type and composing the entry
// content from them. Other extensions and the WI engine only ever see the plain text content; the type and the
// field values live in `entry.extensions.maestro` of Maestro-owned and canon books, and in the bookRoles sidecar for
// base books (P2). Labels in the composed text are English (canon content is English, P6); values stay as typed.

/** Same ids as `EntryType` of the canon API (src/features/canon/api.ts). */
export const ENTRY_TYPE_IDS = [
    'character',
    'place',
    'item',
    'faction',
    'event',
    'tradition',
    'mechanic',
    'rule',
    'chapter',
    'note',
] as const;

export type EntryTypeId = (typeof ENTRY_TYPE_IDS)[number];

export interface TypeField {
    /** Stable id (also the i18n suffix of the form label). */
    id: string;
    /** English label written into the composed content. */
    label: string;
    /** Several lines of text (a textarea in the form). */
    multiline?: boolean;
}

export interface EntryTypeTemplate {
    id: EntryTypeId;
    /** English type name used in the first line of the composed content. */
    label: string;
    /** The first field is the name/title: it goes into the first line («Character: Anna»). */
    fields: TypeField[];
}

const line = (id: string, label: string): TypeField => ({ id, label });
const text = (id: string, label: string): TypeField => ({ id, label, multiline: true });

export const ENTRY_TYPES: Record<EntryTypeId, EntryTypeTemplate> = {
    character: {
        id: 'character',
        label: 'Character',
        fields: [
            line('name', 'Name'),
            line('aliases', 'Aliases'),
            line('role', 'Role'),
            line('age', 'Age'),
            text('appearance', 'Appearance'),
            text('personality', 'Personality'),
            text('background', 'Background'),
            text('relationships', 'Relationships'),
            text('speech', 'Speech'),
            text('goals', 'Goals'),
        ],
    },
    place: {
        id: 'place',
        label: 'Place',
        fields: [
            line('name', 'Name'),
            line('aliases', 'Aliases'),
            line('kind', 'Kind'),
            line('location', 'Location'),
            text('description', 'Description'),
            text('atmosphere', 'Atmosphere'),
            text('inhabitants', 'Inhabitants'),
            text('features', 'Notable features'),
            text('secrets', 'Secrets'),
        ],
    },
    item: {
        id: 'item',
        label: 'Item',
        fields: [
            line('name', 'Name'),
            line('aliases', 'Aliases'),
            line('kind', 'Kind'),
            text('appearance', 'Appearance'),
            text('properties', 'Properties'),
            line('owner', 'Owner'),
            text('origin', 'Origin'),
            line('whereabouts', 'Whereabouts'),
        ],
    },
    faction: {
        id: 'faction',
        label: 'Faction',
        fields: [
            line('name', 'Name'),
            line('aliases', 'Aliases'),
            line('kind', 'Kind'),
            line('leader', 'Leader'),
            text('members', 'Members'),
            text('goals', 'Goals'),
            line('territory', 'Territory'),
            line('allies', 'Allies'),
            line('enemies', 'Enemies'),
            text('symbols', 'Symbols and customs'),
        ],
    },
    event: {
        id: 'event',
        label: 'Event',
        fields: [
            line('name', 'Name'),
            line('when', 'When'),
            line('where', 'Where'),
            line('participants', 'Participants'),
            text('description', 'What happened'),
            text('consequences', 'Consequences'),
        ],
    },
    tradition: {
        id: 'tradition',
        label: 'Tradition',
        fields: [
            line('name', 'Name'),
            line('culture', 'Culture'),
            line('when', 'When'),
            text('practice', 'Practice'),
            text('meaning', 'Meaning'),
            text('taboos', 'Taboos'),
        ],
    },
    mechanic: {
        id: 'mechanic',
        label: 'Mechanic',
        fields: [
            line('name', 'Name'),
            text('summary', 'Summary'),
            text('rules', 'Rules'),
            text('limits', 'Costs and limits'),
            text('examples', 'Examples'),
        ],
    },
    rule: {
        id: 'rule',
        label: 'Rule',
        fields: [
            line('name', 'Name'),
            text('statement', 'Rule'),
            line('scope', 'Scope'),
            text('exceptions', 'Exceptions'),
        ],
    },
    chapter: {
        id: 'chapter',
        label: 'Chapter',
        fields: [
            line('name', 'Title'),
            line('period', 'Period'),
            text('summary', 'Summary'),
            text('events', 'Key events'),
            line('characters', 'Characters'),
            text('threads', 'Open threads'),
        ],
    },
    note: {
        id: 'note',
        label: 'Note',
        fields: [line('name', 'Title'), text('text', 'Text')],
    },
};

/**
 * Stored key of the field values next to `type` (in `extensions.maestro` or the sidecar record). Not `fields`:
 * canon items use `extensions.maestro.fields` for the list of WI fields an override replaces.
 */
export const TYPED_FIELDS_KEY = 'typeFields';

export interface TypedEntryMeta {
    type: EntryTypeId;
    /** Field values by field id (only strings; unknown ids are kept). */
    fields: Record<string, string>;
}

export function isEntryType(value: unknown): value is EntryTypeId {
    return typeof value === 'string' && (ENTRY_TYPE_IDS as readonly string[]).includes(value);
}

/** Typed meta from `extensions.maestro` or a sidecar record; null when there is no valid type. */
export function readTypedMeta(value: unknown): TypedEntryMeta | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!isEntryType(record.type)) return null;
    const fields: Record<string, string> = {};
    const stored = record[TYPED_FIELDS_KEY];
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        for (const [key, item] of Object.entries(stored as Record<string, unknown>)) {
            if (typeof item === 'string') fields[key] = item;
        }
    }
    return { type: record.type, fields };
}

export function emptyFields(type: EntryTypeId): Record<string, string> {
    return Object.fromEntries(ENTRY_TYPES[type].fields.map((field) => [field.id, '']));
}

/** Field values of a meta for its type (template order), missing ones as ''. */
export function templateValues(meta: TypedEntryMeta): Record<string, string> {
    return { ...emptyFields(meta.type), ...meta.fields };
}

/** Same type and the same non-empty field values. */
export function sameTypedMeta(a: TypedEntryMeta | null, b: TypedEntryMeta | null): boolean {
    if (!a || !b) return a === b;
    if (a.type !== b.type) return false;
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    for (const key of keys) if ((a.fields[key] ?? '').trim() !== (b.fields[key] ?? '').trim()) return false;
    return true;
}

/**
 * Content from the fields: «Character: Anna» first (the name field), then «Label: value» per filled field;
 * multi-line values go under «Label:». Values are written as typed (trimmed); empty fields are skipped.
 */
export function composeContent(meta: TypedEntryMeta): string {
    const template = ENTRY_TYPES[meta.type];
    const lines: string[] = [];
    const [first, ...rest] = template.fields;
    const name = first ? (meta.fields[first.id] ?? '').trim() : '';
    if (name) lines.push(`${template.label}: ${name}`);
    for (const field of rest) {
        const value = (meta.fields[field.id] ?? '').trim();
        if (!value) continue;
        lines.push(value.includes('\n') ? `${field.label}:\n${value}` : `${field.label}: ${value}`);
    }
    return lines.join('\n');
}

/**
 * Best-effort reverse of composeContent: fills the fields of `type` from content written in the «Label: value»
 * form (lines that start with a known label). Unrecognised text is left out; used to pre-fill a newly typed entry.
 */
export function fieldsFromContent(type: EntryTypeId, content: string): Record<string, string> {
    const template = ENTRY_TYPES[type];
    const fields = emptyFields(type);
    const [first, ...rest] = template.fields;
    const byLabel = new Map(rest.map((field) => [field.label.toLowerCase(), field.id]));
    let current: string | null = null;
    for (const raw of content.split('\n')) {
        const match = /^([^:\n]{1,40}):\s?(.*)$/.exec(raw);
        const label = match?.[1]?.trim().toLowerCase();
        if (match && first && label === template.label.toLowerCase()) {
            fields[first.id] = (match[2] ?? '').trim();
            current = null;
            continue;
        }
        const id = label ? byLabel.get(label) : undefined;
        if (match && id) {
            fields[id] = (match[2] ?? '').trim();
            current = id;
            continue;
        }
        if (current !== null) fields[current] = fields[current] ? `${fields[current]}\n${raw}` : raw;
    }
    for (const key of Object.keys(fields)) fields[key] = (fields[key] ?? '').trim();
    return fields;
}

/**
 * `extensions` with the typed meta merged into `extensions.maestro` (other keys of both objects kept — canon
 * books keep their CanonMeta there). `meta = null` removes `type`/`typeFields`; `maestro` emptied that way is dropped.
 * Returns a new object (or undefined when nothing is left of an absent `extensions`).
 */
export function withTypedMeta(extensions: unknown, meta: TypedEntryMeta | null): Record<string, unknown> | undefined {
    const hadExtensions = typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions);
    const next: Record<string, unknown> = hadExtensions ? { ...(extensions as Record<string, unknown>) } : {};
    const previous = next.maestro;
    const hadMaestro = typeof previous === 'object' && previous !== null && !Array.isArray(previous);
    const maestro: Record<string, unknown> = hadMaestro ? { ...(previous as Record<string, unknown>) } : {};
    if (meta) {
        maestro.type = meta.type;
        maestro[TYPED_FIELDS_KEY] = { ...meta.fields };
    } else {
        delete maestro.type;
        delete maestro[TYPED_FIELDS_KEY];
    }
    const wasEmpty = hadMaestro && Object.keys(previous as Record<string, unknown>).length === 0;
    if (Object.keys(maestro).length || wasEmpty) next.maestro = maestro;
    else delete next.maestro;
    if (!hadExtensions && !Object.keys(next).length) return undefined;
    return next;
}
