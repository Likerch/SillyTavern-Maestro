// BunnyMo mode (M35 п. 5, 7): the tag dictionary of the loaded BunnyMo books and the tag checks of the sheet editor.
// Pure: the feature loads the books and passes their entries in (research/bunnymo-carrotkernel.md §1.2–1.6).
//
// - A tag is a pack key `<KEY:VALUE>` (category KEY) or a bare key `<KEY>`: bare MBTI archetypes `<ENFJ-U>` go to the
//   MBTI category, any other bare key is a flag whose category is the key itself (`<DEPRESSION>`).
// - Pack entries pull lore by their tag keys; section headers, guide notes, constants and the core's own entries are
//   informational (kind 'info').
// - Archives (CK repositories) use tags inside `<BunnymoTags>`; they are read with src/domain/bunnymo.ts archiveTags so
//   both extensions see the same tags. A used tag of a category that pulls lore but has no loaded entry is an orphan;
//   informational categories (ATTACHMENT, KINK, …) need no entry.
// - The same tag in two or more books: identical text is a duplicate (merged and split editions), different text is a
//   version conflict (MBTI v1 and V2). The BSM-5 + CoT Lenses pairing shares keys by design and is left out.
import { archiveTags, isCharacterArchive } from './bunnymo';
import { packContentSignature } from './rules-packs';

type Dict = Record<string, unknown>;

export type DictionaryEntryKind = 'pull' | 'info';

export interface DictionaryTag {
    tag: string;
    category: string;
    value: string | null;
    entries: { book: string; uid: number; kind: DictionaryEntryKind; comment: string; chars: number }[];
    usedBy: { book: string; uid: number; name: string }[];
    conflict: boolean;
    orphan: boolean;
    /** The same tag in two or more books with identical text (merged and split editions). */
    duplicate: boolean;
}

export interface DictionaryCategory {
    id: string;
    tags: number;
    /** No tag of the category pulls a pack entry (informational category). */
    info: boolean;
    /** Bare flags: every tag of the category has no value (`<DEPRESSION>`). */
    flag: boolean;
}

export interface Dictionary {
    builtAt: number;
    categories: DictionaryCategory[];
    tags: DictionaryTag[];
}

/** An entry with its uid (book data keeps entries by uid, the uid field may be missing). */
export interface UidEntry {
    uid: number;
    entry: Dict;
}

export interface DictionaryBook {
    name: string;
    /** The BunnyMo core: its keyed entries are system entries (informational). */
    core: boolean;
    entries: readonly UidEntry[];
}

export interface DictionaryInput {
    /** BunnyMo core and pack books. */
    books: readonly DictionaryBook[];
    /** Books holding character archives (CK repositories). */
    archives: readonly { name: string; entries: readonly UidEntry[] }[];
    builtAt: number;
    /** Categories that never need a pack entry, besides the built-in list (e.g. read from the core's templates). */
    infoCategories?: Iterable<string>;
}

export const MBTI_CATEGORY = 'MBTI';

/**
 * Categories that pull pack entries when their pack is loaded (research §1.2, «trigger-bearing»). A tag of such a
 * category without a loaded entry pulls nothing.
 */
export const TRIGGER_CATEGORIES: ReadonlySet<string> = new Set([
    'SPECIES',
    'DERE',
    'GENRE',
    'TRAIT',
    'LING',
    'BSM',
    'MENTAL',
    'MOOD',
    'ANXIETY',
    'TRAUMA',
    'PERSONALITY',
    'EATING',
    'DISSOCIATIVE',
    'ADDICTION',
    'SLEEP',
    'MED',
    'REC',
    'BENZO',
    'SSRI',
    'STIMULANT',
    'CONDITION',
    'MOBILITY',
    'SENSORY',
    'DOMAIN',
    'DIVINE',
    'BENDER',
    MBTI_CATEGORY,
]);

/** Categories only the model and CK read: no pack has entries keyed on them (research §1.2, core #2 and #44). */
export const INFO_CATEGORIES: ReadonlySet<string> = new Set([
    'NAME',
    'ATTACHMENT',
    'CONFLICT',
    'BOUNDARIES',
    'FLIRTING',
    'KINK',
    'POWER',
    'ORIENTATION',
    'CHEMISTRY',
    'AROUSAL',
    'JEALOUSY',
    'DECISION',
    'COMFORT',
    'VICE',
    'LOYALTY',
    'TRUST',
    'MASK',
    'GENDER',
    'BUILD',
    'HAIR',
    'HAIRCOLOR',
    'EYECOLOR',
    'SKIN',
    'SKINCOLOR',
    'SKINTONE',
    'STYLE',
    'AGE',
    'FONT',
    'ARCHETYPE',
]);

/** A pack key: `<SPECIES:ELF>`, `<DEPRESSION>`, `<ENFJ-U>` (the same shape src/domain/bunnymo.ts accepts). */
const TAG_KEY_RE = /^<([A-Za-z][A-Za-z0-9_-]*)(?::([^<>]+))?>$/;
const MBTI_VALUE_RE = /^[EI][NS][FT][JP]-[UH]$/i;
/** Section headers and guide notes of the packs (`<SECTION:…>`, `<GENRE_GUIDE_NOTE>`, `<BENDER_PRIMER>`). */
const META_CATEGORY_RE = /^(?:SECTION(?:_HEADER)?|[A-Z0-9_]+_(?:GUIDE(?:_NOTE)?|PRIMER|SECTION|HEADER))$/;
/**
 * BSM-5 + CoT Lenses: the same keys on purpose. Real titles start with an emoji (`💊 CoT LENS — DEPRESSION`), so a
 * leading symbol is allowed.
 */
const INTENDED_PAIR_RE = /^\s*[^\sA-Za-z0-9]*\s*CoT\s+LENS/i;
/** Template categories of the core that are not tag categories. */
const NOT_CATEGORIES: ReadonlySet<string> = new Set(['BUNNYMOTAGS', 'TAG', 'SECTION']);
const TEMPLATE_TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):[^<>\n]+>/g;

function text(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Entries of book data (`{entries: {uid: entry}}`) with their uid; invalid entries are skipped. */
export function entriesWithUid(data: unknown): UidEntry[] {
    const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
    const result: UidEntry[] = [];
    for (const [key, entry] of Object.entries(entries)) {
        if (!isDict(entry)) continue;
        const uid = Number(entry.uid ?? key);
        if (Number.isFinite(uid)) result.push({ uid, entry });
    }
    return result;
}

export interface ParsedTag {
    /** Normalised tag: `<SPECIES:ELF>`, `<ENFJ-U>`, `<DEPRESSION>`. */
    tag: string;
    category: string;
    value: string | null;
}

/** A pack key as a tag (upper case, value trimmed, spaces after `:` dropped); null when the key is not a tag. */
export function parseTagKey(key: string): ParsedTag | null {
    const match = TAG_KEY_RE.exec(key.trim());
    if (!match?.[1]) return null;
    const name = match[1].toUpperCase();
    if (match[2] !== undefined) {
        const value = match[2].trim().toUpperCase();
        if (!value) return null;
        return { tag: `<${name}:${value}>`, category: name, value };
    }
    if (MBTI_VALUE_RE.test(name)) return { tag: `<${name}>`, category: MBTI_CATEGORY, value: name };
    return { tag: `<${name}>`, category: name, value: null };
}

function keyList(entry: Dict): string[] {
    const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    return [...list(entry.key), ...list(entry.keysecondary)].filter((key): key is string => typeof key === 'string');
}

/** Tags of an entry's primary and secondary keys (each tag once). */
export function entryTags(entry: Dict): ParsedTag[] {
    const seen = new Set<string>();
    const tags: ParsedTag[] = [];
    for (const key of keyList(entry)) {
        const parsed = parseTagKey(key);
        if (!parsed || seen.has(parsed.tag)) continue;
        seen.add(parsed.tag);
        tags.push(parsed);
    }
    return tags;
}

/** Section headers and guide notes (`<SECTION:…>`, `<…_GUIDE_NOTE>`) are informational. */
export function isMetaTag(tag: ParsedTag): boolean {
    return META_CATEGORY_RE.test(tag.category);
}

/** Pull or info: the core's entries, constants and entries keyed by a section/guide tag only inform. */
export function entryKind(
    entry: Dict,
    core: boolean,
    tags: readonly ParsedTag[] = entryTags(entry),
): DictionaryEntryKind {
    if (core || entry.constant === true) return 'info';
    return tags.some(isMetaTag) ? 'info' : 'pull';
}

/** Categories the core's sheet templates use (`<KEY:VALUE>` in entry text), upper case. */
export function templateCategories(entries: Iterable<UidEntry>): Set<string> {
    const categories = new Set<string>();
    for (const { entry } of entries) {
        for (const match of text(entry.content).matchAll(TEMPLATE_TAG_RE)) {
            const name = (match[1] ?? '').toUpperCase();
            if (name && !NOT_CATEGORIES.has(name)) categories.add(name);
        }
    }
    return categories;
}

/** Character name of an archive entry: `<Name:…>`, else its title, else the first key. */
export function archiveNameOf(entry: Dict): string {
    const { name } = archiveTags(entry);
    if (name) return name;
    const comment = text(entry.comment).trim();
    if (comment) return comment;
    return keyList(entry)[0]?.trim() ?? '';
}

interface TagBuild {
    tag: DictionaryTag;
    /** Pull entries' content signatures per book (conflict / duplicate test). */
    texts: Map<string, Set<string>>;
}

function compareTags(a: DictionaryTag, b: DictionaryTag): number {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

/**
 * The tag dictionary: every tag key of the BunnyMo books (enabled entries) with the entries it pulls, the archives
 * using it, duplicates, version conflicts and orphans.
 */
export function buildTagDictionary(input: DictionaryInput): Dictionary {
    const tags = new Map<string, TagBuild>();
    const ensure = (parsed: ParsedTag): TagBuild => {
        let item = tags.get(parsed.tag);
        if (!item) {
            item = {
                tag: {
                    tag: parsed.tag,
                    category: parsed.category,
                    value: parsed.value,
                    entries: [],
                    usedBy: [],
                    conflict: false,
                    orphan: false,
                    duplicate: false,
                },
                texts: new Map(),
            };
            tags.set(parsed.tag, item);
        }
        return item;
    };

    for (const book of input.books) {
        for (const { uid, entry } of book.entries) {
            if (entry.disable === true) continue;
            const parsed = entryTags(entry);
            if (!parsed.length) continue;
            const kind = entryKind(entry, book.core, parsed);
            const content = text(entry.content);
            const comment = text(entry.comment).trim();
            for (const tag of parsed) {
                const item = ensure(tag);
                item.tag.entries.push({ book: book.name, uid, kind, comment, chars: content.length });
                if (kind !== 'pull' || INTENDED_PAIR_RE.test(comment)) continue;
                let set = item.texts.get(book.name);
                if (!set) {
                    set = new Set();
                    item.texts.set(book.name, set);
                }
                set.add(packContentSignature(content));
            }
        }
    }

    for (const book of input.archives) {
        for (const { uid, entry } of book.entries) {
            if (entry.disable === true || !isCharacterArchive(entry)) continue;
            const name = archiveNameOf(entry);
            const seen = new Set<string>();
            for (const raw of archiveTags(entry).tags) {
                const parsed = parseTagKey(raw);
                if (!parsed || seen.has(parsed.tag)) continue;
                seen.add(parsed.tag);
                ensure(parsed).tag.usedBy.push({ book: book.name, uid, name });
            }
        }
    }

    const info = new Set<string>([...INFO_CATEGORIES, ...(input.infoCategories ?? [])]);
    for (const category of TRIGGER_CATEGORIES) info.delete(category);
    const result: DictionaryTag[] = [];
    for (const { tag, texts } of tags.values()) {
        const books = [...texts.values()];
        if (books.length >= 2) {
            const first = [...(books[0] ?? [])].sort().join('\u0001');
            const same = books.every((set) => [...set].sort().join('\u0001') === first);
            tag.duplicate = same;
            tag.conflict = !same;
        }
        tag.orphan = tag.usedBy.length > 0 && tag.entries.length === 0 && !info.has(tag.category);
        result.push(tag);
    }
    result.sort(compareTags);

    const categories = new Map<string, DictionaryCategory>();
    for (const tag of result) {
        let category = categories.get(tag.category);
        if (!category) {
            category = { id: tag.category, tags: 0, info: true, flag: true };
            categories.set(tag.category, category);
        }
        category.tags += 1;
        if (tag.entries.some((entry) => entry.kind === 'pull')) category.info = false;
        if (tag.value !== null) category.flag = false;
    }
    return { builtAt: input.builtAt, categories: [...categories.values()], tags: result };
}

/* ------------------------------------------------------------------ tag checks of the sheet editor */

export type TagProblem =
    | 'malformed'
    | 'cyrillic'
    | 'placeholder'
    | 'transitional'
    | 'duplicate'
    | 'unknownCategory'
    | 'unknownValue'
    | 'noPack';

export interface TagCheck {
    /** The tag normalised (`<SPECIES:ELF>`), or as given when it cannot be read. */
    tag: string;
    ok: boolean;
    reason?: TagProblem;
    suggestions?: string[];
}

/** What the checks compare against: values with a loaded entry per category, flags, informational categories. */
export interface TagVocabulary {
    values: Map<string, Set<string>>;
    flags: Set<string>;
    info: Set<string>;
}

/** Vocabulary of a dictionary: tags with at least one loaded entry; informational categories per INFO_CATEGORIES. */
export function tagVocabulary(
    dictionary: Pick<Dictionary, 'tags'>,
    infoCategories: Iterable<string> = [],
): TagVocabulary {
    const values = new Map<string, Set<string>>();
    const flags = new Set<string>();
    for (const tag of dictionary.tags) {
        if (!tag.entries.length) continue;
        if (tag.value === null) {
            flags.add(tag.tag);
            continue;
        }
        let set = values.get(tag.category);
        if (!set) {
            set = new Set();
            values.set(tag.category, set);
        }
        set.add(tag.value);
    }
    const info = new Set<string>([...INFO_CATEGORIES, ...infoCategories]);
    for (const category of TRIGGER_CATEGORIES) info.delete(category);
    return { values, flags, info };
}

const WRITTEN_TAG_RE = /^<([^<>:\n]+)(?::([^<>\n]*))?>$/;
const NAME_TAG_RE = /^<\s*name\s*:([^<>\n]*)>$/i;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** `!updatesheet` transitional markup that must never be written into a block (research §5). */
const TRANSITIONAL_RE = /→|->|↔|\d\s*%|\b(?:FADING|STRENGTHENING|WEAKENING|EMERGING|CONVERTING)\b/i;
const MBTI_PLACEHOLDER_RE = /^X{4}(?:-|$)/i;
const MBTI_BARE_RE = /^[EI][NS][FT][JP]$/i;

/** Levenshtein distance (small strings: tag values and categories). */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
        }
        previous = current;
    }
    return previous[b.length] ?? 0;
}

/** Closest candidates (edit distance within a third of the length, or containment), best first, at most `limit`. */
export function closest(target: string, candidates: Iterable<string>, limit = 3): string[] {
    const scored: { value: string; score: number }[] = [];
    const threshold = Math.max(2, Math.floor(target.length / 3));
    for (const candidate of candidates) {
        if (candidate === target) continue;
        let score = editDistance(target, candidate);
        if (score > threshold) {
            const contains =
                target.length >= 3 &&
                candidate.length >= 3 &&
                (candidate.includes(target) || target.includes(candidate));
            if (!contains) continue;
            score = threshold + Math.abs(candidate.length - target.length) / 100;
        }
        scored.push({ value: candidate, score });
    }
    scored.sort((a, b) => a.score - b.score || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    return scored.slice(0, limit).map((item) => item.value);
}

/** A value the archive parser treats as a template placeholder (BLANK, NEW, NAME…), decided by bunnymo.ts itself. */
export function isPlaceholderValue(value: string): boolean {
    if (!value.trim() || /[<>\n]/.test(value)) return false;
    return archiveTags({ content: `<BunnymoTags><X:${value}></BunnymoTags>` }).tags.length === 0;
}

/** A `<Name:…>` value that is a placeholder (`NAME`, `NAME HERE`). */
export function isPlaceholderName(value: string): boolean {
    if (!value.trim() || /[<>\n]/.test(value)) return true;
    return !isCharacterArchive({ content: `<BunnymoTags><Name:${value}></BunnymoTags>` });
}

/** Writes a tag from a category and a value (`<SPECIES:ELF>`, bare MBTI and flags without a colon). */
export function formatTag(category: string, value: string | null): string {
    if (value === null || category === MBTI_CATEGORY) return `<${(value ?? category).toUpperCase()}>`;
    return `<${category}:${value}>`;
}

function checkOne(raw: string, vocabulary: TagVocabulary, seen: Set<string>, mbti: { count: number }): TagCheck {
    const trimmed = raw.trim();
    const written = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
    // `<Name:…>` is the identity (any script, never renamed): only a placeholder is wrong there.
    const name = NAME_TAG_RE.exec(written);
    if (name) {
        const value = (name[1] ?? '').trim();
        return isPlaceholderName(value)
            ? { tag: written, ok: false, reason: 'placeholder' }
            : { tag: written, ok: true };
    }
    if (CYRILLIC_RE.test(written)) return { tag: written, ok: false, reason: 'cyrillic' };
    const match = WRITTEN_TAG_RE.exec(written);
    const key = match?.[1]?.trim() ?? '';
    if (!match || !KEY_RE.test(key)) {
        if (MBTI_PLACEHOLDER_RE.test(written.slice(1))) return { tag: written, ok: false, reason: 'placeholder' };
        const repaired = /^<([A-Za-z][A-Za-z0-9_-]*)\s*[,;=]\s*([^<>\n]+)>$/.exec(written);
        const suggestions =
            repaired?.[1] && repaired[2] ? [`<${repaired[1].toUpperCase()}:${repaired[2].trim()}>`] : [];
        return { tag: written, ok: false, reason: 'malformed', ...(suggestions.length ? { suggestions } : {}) };
    }
    const rawValue = match[2];
    if (rawValue !== undefined && (!rawValue.trim() || /[()]/.test(rawValue))) {
        const cleaned = rawValue.replace(/\([^)]*\)?/g, '').trim();
        const suggestions = cleaned ? [`<${key.toUpperCase()}:${cleaned.toUpperCase()}>`] : [];
        return { tag: written, ok: false, reason: 'malformed', ...(suggestions.length ? { suggestions } : {}) };
    }
    // A space inside the brackets (`< SPECIES:ELF>`) is not read as a key by ST's tag matching.
    const parsed = parseTagKey(written);
    if (!parsed) return { tag: written, ok: false, reason: 'malformed' };
    const { tag, category, value } = parsed;
    if (value === null && MBTI_PLACEHOLDER_RE.test(category)) return { tag, ok: false, reason: 'placeholder' };
    if (rawValue !== undefined && isPlaceholderValue(rawValue.trim())) return { tag, ok: false, reason: 'placeholder' };
    if (rawValue !== undefined && TRANSITIONAL_RE.test(rawValue)) return { tag, ok: false, reason: 'transitional' };
    if (seen.has(tag)) return { tag, ok: false, reason: 'duplicate' };
    seen.add(tag);
    if (category === MBTI_CATEGORY) {
        mbti.count += 1;
        if (mbti.count > 1) return { tag, ok: false, reason: 'duplicate' };
    }

    if (value === null) {
        if (vocabulary.flags.has(tag)) return { tag, ok: true };
        if (MBTI_BARE_RE.test(category)) {
            return { tag, ok: false, reason: 'malformed', suggestions: [`<${category}-H>`, `<${category}-U>`] };
        }
        const suggestions = closest(tag, vocabulary.flags);
        return { tag, ok: false, reason: 'unknownValue', ...(suggestions.length ? { suggestions } : {}) };
    }
    const known = vocabulary.values.get(category);
    if (known) {
        if (known.has(value)) return { tag, ok: true };
        const suggestions = closest(value, known).map((item) => formatTag(category, item));
        for (const [other, values] of vocabulary.values) {
            if (other !== category && values.has(value) && suggestions.length < 3) {
                suggestions.push(formatTag(other, value));
            }
        }
        return { tag, ok: false, reason: 'unknownValue', ...(suggestions.length ? { suggestions } : {}) };
    }
    if (TRIGGER_CATEGORIES.has(category)) return { tag, ok: false, reason: 'noPack' };
    if (vocabulary.info.has(category)) return { tag, ok: true };
    const categories = new Set<string>([...vocabulary.values.keys(), ...vocabulary.info, ...TRIGGER_CATEGORIES]);
    categories.delete(MBTI_CATEGORY);
    categories.delete('NAME');
    const suggestions = closest(category, categories).map((item) => formatTag(item, value));
    return { tag, ok: false, reason: 'unknownCategory', ...(suggestions.length ? { suggestions } : {}) };
}

/**
 * Checks tags as a sheet would carry them: well-formed (CK reads only `<KEY:VALUE>`), English, no placeholder, no
 * `!updatesheet` transitional markup, no repeats (one MBTI archetype), and a loaded pack entry for every category that
 * pulls lore. Suggestions come from the vocabulary by edit distance.
 */
export function checkTags(tags: readonly string[], vocabulary: TagVocabulary): TagCheck[] {
    const seen = new Set<string>();
    const mbti = { count: 0 };
    return tags.map((tag) => checkOne(tag, vocabulary, seen, mbti));
}
