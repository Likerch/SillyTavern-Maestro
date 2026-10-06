// Passports of lorebook entries (M28, plan §2.1, P2, P12, §16): the visual description of what an entry describes,
// in NAI Studio's passport format (N:domain/passport.ts) — kind, name, aliases, tags (world, location, object),
// slots (characters), outfits, states, NSFW layer, negative; unknown fields are kept. Maestro and canon books keep
// it in the entry (`extensions.maestro.passport`), base books in the bookRoles sidecar record under the same key.
// Tags are English Danbooru tags in lower case; explicit anatomy belongs only to the NSFW layer (N:isExplicitAnatomy).
// Pure: no DOM, no SillyTavern.
import { normalizeName } from './world-names';

export const PASSPORT_KINDS = ['character', 'location', 'object', 'world', 'scenario'] as const;
export type PassportKind = (typeof PASSPORT_KINDS)[number];

/** NAI Studio's slots, in the order it builds a character's tag list. */
export const PASSPORT_SLOTS = ['base', 'hair', 'eyes', 'body', 'skin', 'clothing', 'accessories', 'style'] as const;
export type PassportSlot = (typeof PASSPORT_SLOTS)[number];

/** Key of the record in `extensions.maestro` (Maestro books) and in the sidecar record (base books). */
export const PASSPORT_KEY = 'passport';

export const PASSPORT_SOURCES = ['nai', 'model', 'user'] as const;
export type PassportSource = (typeof PASSPORT_SOURCES)[number];

type Dict = Record<string, unknown>;

/** A passport as Maestro keeps it next to an entry. */
export interface PassportRecord {
    passport: Dict;
    generatedBy?: PassportSource;
    updatedAt: number;
    /** Hash of the entry content the passport was made for (roles-meta entryContentHash). */
    contentHash?: string;
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function jsonCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function isPassportKind(value: unknown): value is PassportKind {
    return typeof value === 'string' && (PASSPORT_KINDS as readonly string[]).includes(value);
}

/**
 * NAI kind for an entry type (M23 typed entries) or a world-model entity kind; null for things without a look
 * (rules, mechanics, chapters, notes, promises, secrets, quests).
 */
export function passportKindOf(type: unknown): PassportKind | null {
    switch (type) {
        case 'character':
        case 'persona':
        case 'creature':
        case 'npc':
            return 'character';
        case 'place':
        case 'location':
            return 'location';
        case 'item':
        case 'object':
            return 'object';
        case 'faction':
        case 'event':
        case 'tradition':
        case 'world':
            return 'world';
        case 'scenario':
            return 'scenario';
        default:
            return null;
    }
}

/* ------------------------------------------------------------------ tags */

/** Splits a tag string (commas, new lines), trims, drops empties and case-insensitive duplicates (first wins). */
export function splitTags(text: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of text.split(/,|\n/)) {
        const tag = raw.trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        result.push(tag);
    }
    return result;
}

export function joinTags(...parts: string[]): string {
    return splitTags(parts.filter(Boolean).join(', ')).join(', ');
}

/** A letter outside the Latin alphabet (Cyrillic, accents, CJK): tags are English. */
const NON_LATIN_LETTER = /[^\P{L}A-Za-z]/u;

export function isEnglishTag(tag: string): boolean {
    return !NON_LATIN_LETTER.test(tag);
}

/** Explicit anatomy (NAI Studio 0.9.8): it belongs to the NSFW layer and stays out of other scenes. */
const EXPLICIT_ANATOMY =
    /(^|\s)(futanari|futa|dickgirl|penis|testicles?|erection|flaccid|foreskin|pussy|vagina|clitoris|nipples?|areolae?|pubic hair)(\s|$)/i;

export function isExplicitAnatomy(tag: string): boolean {
    return EXPLICIT_ANATOMY.test(tag);
}

/** One tag as NovelAI reads it: lower case, spaces instead of underscores, single spaces. */
export function cleanTag(tag: string): string {
    return tag.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function cleanTags(text: string): string {
    return joinTags(splitTags(text).map(cleanTag).join(', '));
}

/* ------------------------------------------------------------------ the passport */

function aliasList(value: unknown, name: string): string[] {
    const raw = Array.isArray(value) ? value.map(str) : str(value).split(',');
    const seen = new Set<string>([name.trim().toLowerCase()]);
    const result: string[] = [];
    for (const item of raw) {
        const alias = item.trim();
        const key = alias.toLowerCase();
        if (!alias || seen.has(key)) continue;
        seen.add(key);
        result.push(alias);
    }
    return result;
}

/**
 * A typed copy of a stored passport (hand-edited, older, from NAI Studio); null for junk. Every NAI field gets its
 * type (all eight slots present), unknown fields are kept as they are.
 */
export function normalizePassport(raw: unknown, fallback: { kind?: PassportKind; name?: string } = {}): Dict | null {
    if (!isDict(raw)) return null;
    const copy = jsonCopy(raw);
    const kind = isPassportKind(copy.kind) ? copy.kind : (fallback.kind ?? 'character');
    const name = str(copy.name).trim() || (fallback.name ?? '').trim();
    const slotsIn = isDict(copy.slots) ? copy.slots : {};
    const slots: Record<string, string> = {};
    for (const slot of PASSPORT_SLOTS) slots[slot] = str(slotsIn[slot]);
    for (const [slot, value] of Object.entries(slotsIn)) {
        if (!(slot in slots) && typeof value === 'string') slots[slot] = value;
    }
    const nsfw = isDict(copy.nsfw) ? copy.nsfw : {};
    const outfits = (Array.isArray(copy.outfits) ? copy.outfits : [])
        .filter(isDict)
        .map((outfit) => {
            // The tracker wordings an outfit is drawn for (NAI Studio 0.12.1 `looks`) stay with it.
            const looks = Array.isArray(outfit.looks)
                ? outfit.looks.filter((look): look is string => typeof look === 'string' && look.trim() !== '')
                : [];
            return { name: str(outfit.name).trim(), tags: str(outfit.tags), ...(looks.length ? { looks } : {}) };
        })
        .filter((outfit) => outfit.name);
    const states = (Array.isArray(copy.states) ? copy.states : [])
        .filter(isDict)
        .map((state) => ({ id: str(state.id).trim(), tags: str(state.tags), enabled: state.enabled === true }))
        .filter((state) => state.id);
    const active = str(copy.activeOutfit);
    return {
        ...copy,
        kind,
        name,
        aliases: aliasList(copy.aliases, name),
        tags: str(copy.tags),
        slots,
        nsfw: { enabled: nsfw.enabled === true, tags: str(nsfw.tags) },
        outfits,
        activeOutfit: outfits.some((outfit) => outfit.name === active) ? active : '',
        states,
        negative: str(copy.negative),
    };
}

/** A bare passport stored without the record around it (hand-made, other tools). */
function looksLikePassport(value: Dict): boolean {
    return ['kind', 'slots', 'tags', 'name', 'aliases'].some((key) => key in value);
}

/** The record stored under `passport` (or a bare passport there, treated as made by the user); null for junk. */
export function readPassportRecord(raw: unknown): PassportRecord | null {
    if (!isDict(raw)) return null;
    const nested = isDict(raw.passport);
    if (!nested && !looksLikePassport(raw)) return null;
    const passport = normalizePassport(nested ? raw.passport : raw);
    if (!passport) return null;
    const record: PassportRecord = { passport, updatedAt: 0 };
    if (!nested) return record;
    if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) record.updatedAt = raw.updatedAt;
    if ((PASSPORT_SOURCES as readonly unknown[]).includes(raw.generatedBy)) {
        record.generatedBy = raw.generatedBy as PassportSource;
    }
    if (typeof raw.contentHash === 'string') record.contentHash = raw.contentHash;
    return record;
}

export function makePassportRecord(
    passport: Dict,
    generatedBy: PassportSource,
    contentHash: string | undefined,
    at: number,
): PassportRecord {
    const record: PassportRecord = { passport: normalizePassport(passport) ?? {}, generatedBy, updatedAt: at };
    if (contentHash !== undefined) record.contentHash = contentHash;
    return record;
}

/** Made by hand (or of unknown origin): generation must not replace it without asking. */
export function isUserMade(record: Pick<PassportRecord, 'generatedBy'> | null | undefined): boolean {
    return !!record && (record.generatedBy === undefined || record.generatedBy === 'user');
}

/** The passport record of an entry of a Maestro or canon book (`extensions.maestro.passport`). */
export function passportOfEntry(entry: unknown): PassportRecord | null {
    if (!isDict(entry) || !isDict(entry.extensions) || !isDict(entry.extensions.maestro)) return null;
    return readPassportRecord(entry.extensions.maestro[PASSPORT_KEY]);
}

/**
 * `extensions` with the record set (null: removed) in `extensions.maestro`; other keys of both objects are kept
 * (canon books keep their CanonMeta there, typed entries their type). `maestro` emptied this way is dropped, and
 * nothing is returned when nothing is left of an absent `extensions`. Returns a new object.
 */
export function withPassport(extensions: unknown, record: PassportRecord | null): Dict | undefined {
    const had = isDict(extensions);
    const next: Dict = had ? { ...extensions } : {};
    const previous = next.maestro;
    const maestro: Dict = isDict(previous) ? { ...previous } : {};
    if (record) maestro[PASSPORT_KEY] = jsonCopy(record);
    else delete maestro[PASSPORT_KEY];
    const wasEmpty = isDict(previous) && Object.keys(previous).length === 0;
    if (Object.keys(maestro).length || wasEmpty) next.maestro = maestro;
    else delete next.maestro;
    if (!had && !Object.keys(next).length) return undefined;
    return next;
}

/** A sidecar record (bookRoles entry meta) with the passport set or removed; other keys kept; undefined when empty. */
export function withSidecarPassport(meta: unknown, record: PassportRecord | null): Dict | undefined {
    const next: Dict = isDict(meta) ? { ...meta } : {};
    if (record) next[PASSPORT_KEY] = jsonCopy(record);
    else delete next[PASSPORT_KEY];
    return Object.keys(next).length ? next : undefined;
}

/* ------------------------------------------------------------------ validation */

export type PassportIssueCode = 'notEnglish' | 'upperCase' | 'underscore' | 'anatomy' | 'empty';

export interface PassportIssue {
    /** 'tags', 'slots.hair', 'outfits.0', 'states.1', 'nsfw', 'negative'; '' for the passport as a whole. */
    field: string;
    code: PassportIssueCode;
    level: 'error' | 'warn';
    tag?: string;
}

interface TagField {
    field: string;
    text: string;
    /** The NSFW layer and the negative may name anatomy. */
    anatomyAllowed: boolean;
}

function tagFields(passport: Dict): TagField[] {
    const fields: TagField[] = [{ field: 'tags', text: str(passport.tags), anatomyAllowed: false }];
    const slots = isDict(passport.slots) ? passport.slots : {};
    for (const [slot, value] of Object.entries(slots)) {
        fields.push({ field: `slots.${slot}`, text: str(value), anatomyAllowed: false });
    }
    const outfits = Array.isArray(passport.outfits) ? passport.outfits : [];
    outfits.forEach((outfit, index) => {
        if (isDict(outfit)) fields.push({ field: `outfits.${index}`, text: str(outfit.tags), anatomyAllowed: false });
    });
    const states = Array.isArray(passport.states) ? passport.states : [];
    states.forEach((state, index) => {
        if (isDict(state)) fields.push({ field: `states.${index}`, text: str(state.tags), anatomyAllowed: false });
    });
    const nsfw = isDict(passport.nsfw) ? passport.nsfw : {};
    fields.push({ field: 'nsfw', text: str(nsfw.tags), anatomyAllowed: true });
    fields.push({ field: 'negative', text: str(passport.negative), anatomyAllowed: true });
    return fields;
}

/** Nothing to draw: a character without slots, outfits and NSFW tags; anything else without tags. */
export function isPassportEmpty(passport: Dict | null | undefined): boolean {
    if (!passport) return true;
    if (passport.kind !== 'character') return !str(passport.tags).trim();
    const slots = isDict(passport.slots) ? passport.slots : {};
    const nsfw = isDict(passport.nsfw) ? passport.nsfw : {};
    const outfits = Array.isArray(passport.outfits) ? passport.outfits : [];
    return Object.values(slots).every((value) => !str(value).trim()) && !outfits.length && !str(nsfw.tags).trim();
}

/**
 * What is wrong with a passport (plan §9 checks before writing): tags must be English (error) and lower case (error,
 * fixable), underscores are NovelAI's spaces (warning, fixable), explicit anatomy only in the NSFW layer (error,
 * fixable: moved there); an empty passport is a warning.
 */
export function validatePassport(passport: Dict): PassportIssue[] {
    const issues: PassportIssue[] = [];
    for (const { field, text, anatomyAllowed } of tagFields(passport)) {
        for (const tag of splitTags(text)) {
            if (!isEnglishTag(tag)) issues.push({ field, code: 'notEnglish', level: 'error', tag });
            else if (tag !== tag.toLowerCase()) issues.push({ field, code: 'upperCase', level: 'error', tag });
            if (tag.includes('_')) issues.push({ field, code: 'underscore', level: 'warn', tag });
            if (!anatomyAllowed && isExplicitAnatomy(tag)) issues.push({ field, code: 'anatomy', level: 'error', tag });
        }
    }
    if (isPassportEmpty(passport)) issues.push({ field: '', code: 'empty', level: 'warn' });
    return issues;
}

export function hasErrors(issues: readonly PassportIssue[]): boolean {
    return issues.some((issue) => issue.level === 'error');
}

/** Issues the fixer can repair (everything except non-English tags and an empty passport). */
export function isFixable(issue: PassportIssue): boolean {
    return issue.code === 'upperCase' || issue.code === 'underscore' || issue.code === 'anatomy';
}

/**
 * A copy with every tag in lower case and without underscores, and explicit anatomy moved from the slots, tags,
 * outfits and states into the NSFW layer (its switch is left as it was). Non-English tags stay: they need a person.
 */
export function fixPassport(passport: Dict): Dict {
    const next = normalizePassport(passport) ?? normalizePassport({})!;
    const moved: string[] = [];
    const keep = (text: string) =>
        splitTags(text)
            .map(cleanTag)
            .filter((tag) => (isExplicitAnatomy(tag) ? (moved.push(tag), false) : true))
            .join(', ');
    next.tags = keep(str(next.tags));
    const slots = next.slots as Record<string, string>;
    for (const slot of Object.keys(slots)) slots[slot] = keep(slots[slot] ?? '');
    next.outfits = (next.outfits as { name: string; tags: string }[]).map((outfit) => ({
        ...outfit,
        tags: keep(outfit.tags),
    }));
    next.states = (next.states as { id: string; tags: string; enabled: boolean }[]).map((state) => ({
        ...state,
        tags: keep(state.tags),
    }));
    const nsfw = next.nsfw as { enabled: boolean; tags: string };
    next.nsfw = { ...nsfw, tags: joinTags(cleanTags(nsfw.tags), ...moved) };
    next.negative = cleanTags(str(next.negative));
    return next;
}

/* ------------------------------------------------------------------ lists and NAI Studio */

/** One line of tags for lists: a character's slots (clothing included), else the tags; cut to `max` characters. */
export function passportTagLine(passport: Dict, max = 160): string {
    let line: string;
    if (passport.kind === 'character') {
        const slots = isDict(passport.slots) ? passport.slots : {};
        line = joinTags(...PASSPORT_SLOTS.map((slot) => str(slots[slot])));
    } else {
        line = joinTags(str(passport.tags));
    }
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Stable id of an entry's passport as NAI Studio sees it: `maestro:<world>#<uid>`. */
export function scenePassportId(world: string, uid: number): string {
    return `maestro:${world}#${uid}`;
}

/** The fields NAI Studio's API reads (adapters/nai NaiPassport), unknown ones kept. */
export interface NaiShapedPassport {
    id: string;
    kind: PassportKind;
    name: string;
    aliases: string[];
    tags: string;
    slots: Record<string, string>;
    outfits: { name: string; tags: string }[];
    activeOutfit: string;
    states: { id: string; tags: string; enabled: boolean }[];
    negative: string;
    [field: string]: unknown;
}

/** A passport of an entry in the shape NAI Studio's passport providers return (id = scenePassportId). */
export function toNaiShape(world: string, uid: number, name: string, passport: Dict): NaiShapedPassport {
    const normal = normalizePassport(passport, { name }) ?? normalizePassport({ name })!;
    return {
        ...normal,
        id: scenePassportId(world, uid),
        kind: normal.kind as PassportKind,
        name: str(normal.name) || name,
        aliases: normal.aliases as string[],
        tags: normal.tags as string,
        slots: normal.slots as Record<string, string>,
        outfits: normal.outfits as { name: string; tags: string }[],
        activeOutfit: normal.activeOutfit as string,
        states: normal.states as { id: string; tags: string; enabled: boolean }[],
        negative: normal.negative as string,
    };
}

export interface ScenePick {
    key: string;
    name: string;
    kind: string;
}

/** One passport per thing: the first of each kind + normalised name (or alias) wins; at most `limit`. */
export function dedupeScene<T extends ScenePick & { aliases?: readonly string[] }>(
    items: readonly T[],
    limit: number,
): T[] {
    const keys = new Set<string>();
    const names = new Set<string>();
    const result: T[] = [];
    for (const item of items) {
        if (result.length >= limit) break;
        if (keys.has(item.key)) continue;
        const own = [item.name, ...(item.aliases ?? [])]
            .map((name) => normalizeName(name))
            .filter(Boolean)
            .map((name) => `${item.kind}:${name}`);
        if (own.some((name) => names.has(name))) continue;
        keys.add(item.key);
        for (const name of own) names.add(name);
        result.push(item);
    }
    return result;
}

/** Display name of an entry: the typed name field, else the comment's first line, else the first key, else #uid. */
export function entryDisplayName(entry: Dict, typedName?: string): string {
    const typed = (typedName ?? '').trim();
    if (typed) return typed;
    const comment = str(entry.comment).trim().split('\n')[0]?.trim() ?? '';
    if (comment) return comment.slice(0, 80);
    const key = Array.isArray(entry.key)
        ? entry.key.find((item) => typeof item === 'string' && item.trim())
        : undefined;
    if (typeof key === 'string') return key.trim().slice(0, 80);
    return `#${typeof entry.uid === 'number' ? entry.uid : '?'}`;
}
