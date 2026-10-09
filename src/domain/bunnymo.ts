// BunnyMo recognition heuristics: which lorebooks are the BunnyMo core, which are packs, which entries are
// character archives and what tags they carry. BunnyMo is not an extension but a set of lorebooks without
// metadata, so everything is recognised by entry keys and content, never by file name (research/bunnymo-carrotkernel.md §1).
//
// Ported from SillyTavern-DES-RU 0.7.0 `src/bunnymo-adapter.js` (Copyright (C) 2026 Likerchik,
// AGPL-3.0-or-later, the same licence as Maestro). Checked against BunnyMo V3.0 (commit 7a61c9f) and its packs.
// Keep the behaviour identical to DES-RU so both extensions classify the same books the same way.

/** The parts of a World Info entry these heuristics read. Every field is optional and may hold junk. */
export interface BunnyMoEntryLike {
    key?: unknown;
    keysecondary?: unknown;
    comment?: unknown;
    content?: unknown;
    /** Lorebook name (ST adds it to scanned entries; callers add it to entries of a loaded book). */
    world?: unknown;
}

export interface WorldClassification {
    /** Books holding the BunnyMo core (sheet commands, Master entries, auto-detectors). */
    core: Set<string>;
    /** BunnyMo packs: books keyed by `<TAG:VALUE>` tags or made of `<BunnymoTags:…>`-wrapped entries. */
    packs: Set<string>;
}

export interface ArchiveTags {
    /** `<Name:…>` value, original case; null when the block has none. */
    name: string | null;
    /** `<KEY:VALUE>` tags (key upper-cased, value as written) and bare MBTI tags (`<ESFP-H>`). */
    tags: string[];
}

/** Sheet commands of the core lorebook (core entries #2–#7). */
export const BUNNYMO_SHEET_COMMANDS: readonly string[] = Object.freeze([
    '!fullsheet',
    '!quicksheet',
    '!tagsheet',
    '!memsheet',
    '!updatesheet',
    '!physheet',
]);

/** Comment prefixes of core entries; titles are stable between BunnyMo versions, uids are not. */
const CORE_COMMENT_RE = /Master - |AUTO-TRIGGER:|AUTO-FILTRATION:|ANTI[\s-]*CLANKER|HawThorne Link/i;
/** A pack key: `<SPECIES:ELF>`, `<DEPRESSION>`, `<ENFJ-U>`. */
const PACK_KEY_RE = /^<([A-Za-z][A-Za-z0-9_-]*)(?::([^<>]+))?>$/;
/** A character tag block: `<BunnymoTags>…</BunnymoTags>` (with a colon it is an entry wrapper instead). */
const TAG_BLOCK_RE = /<bunnymotags>([\s\S]*?)<\/bunnymotags>/i;
const TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;
/** Bare MBTI archetype without a colon: `<ESFP-H>`, `<INTJ-U>`. MBTI pack entries fire on it. */
const MBTI_TAG_RE = /<([EI][NS][FT][JP]-[UH])>/gi;
/**
 * Template placeholders in place of a tag value or name: `<Name:NAME>`, `<GENRE:BLANK>`, `<Dere:NEW>`.
 * NONE and OLD are not placeholders: packs have entries for `<LING:NONE>` and `<LING:OLD>`.
 */
const PLACEHOLDER_RE = /^(?:BLANK|NEW|VALUE|TARGET|NAME|NAME[\s_]HERE|PLACEHOLDER|TBD|X{3,})$/i;
/** Entry wrapper `<BunnymoTags:Title>…</BunnymoTags:Title>`, used by the core and by some packs. */
const WRAPPED_RE = /^<BunnymoTags:/i;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const REGEX_KEY_RE = /^\/[\s\S]+\/[gimsuy]*$/;

function text(value: unknown): string {
    return value === undefined || value === null ? '' : String(value);
}

/** Primary and secondary keys of an entry, trimmed, without empty ones. */
export function entryKeys(entry: BunnyMoEntryLike | null | undefined): string[] {
    const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    return [...list(entry?.key), ...list(entry?.keysecondary)].map((key) => text(key).trim()).filter(Boolean);
}

/**
 * Is this an entry of the BunnyMo core lorebook? By a sheet command in its keys or by a known entry title.
 * The `<BunnymoTags:…>` wrapper is no sign: pack entries (CarrotCast, Linguistics, lenses) use it too.
 */
export function isBunnyMoCoreEntry(entry: BunnyMoEntryLike | null | undefined): boolean {
    if (entryKeys(entry).some((key) => BUNNYMO_SHEET_COMMANDS.includes(key.toLowerCase()))) return true;
    return CORE_COMMENT_RE.test(text(entry?.comment));
}

/**
 * Which books are BunnyMo: the core (3+ core entries) and packs ((3+ tag-keyed entries that are at least 60 %
 * of the keyed entries) or 3+ wrapped entries). Entries without `world` are ignored.
 */
export function classifyWorlds(entries: Iterable<BunnyMoEntryLike>): WorldClassification {
    const stats = new Map<string, { core: number; keyed: number; tagged: number; wrapped: number }>();
    for (const entry of entries) {
        const world = text(entry?.world);
        if (!world) continue;
        const item = stats.get(world) ?? { core: 0, keyed: 0, tagged: 0, wrapped: 0 };
        if (isBunnyMoCoreEntry(entry)) item.core += 1;
        if (WRAPPED_RE.test(text(entry?.content).trimStart())) item.wrapped += 1;
        const keys = entryKeys(entry);
        if (keys.length) {
            item.keyed += 1;
            if (keys.some((key) => PACK_KEY_RE.test(key))) item.tagged += 1;
        }
        stats.set(world, item);
    }
    const core = new Set<string>();
    const packs = new Set<string>();
    for (const [world, item] of stats) {
        if (item.core >= 3) core.add(world);
        else if ((item.tagged >= 3 && item.tagged / Math.max(item.keyed, 1) >= 0.6) || item.wrapped >= 3)
            packs.add(world);
    }
    return { core, packs };
}

/**
 * Tags the packs react to: KEY → values (upper case), read from entry keys. Use this rather than CK's
 * `{{BUNNYMO_PACK_TAGS}}`, which reads only `key[0]` and lets the last pack win on shared prefixes.
 */
export function packVocabulary(entries: Iterable<BunnyMoEntryLike>): Map<string, Set<string>> {
    const vocabulary = new Map<string, Set<string>>();
    for (const entry of entries) {
        for (const key of entryKeys(entry)) {
            const match = PACK_KEY_RE.exec(key);
            if (!match?.[1] || !match[2]) continue;
            const name = match[1].toUpperCase();
            let values = vocabulary.get(name);
            if (!values) {
                values = new Set<string>();
                vocabulary.set(name, values);
            }
            values.add(match[2].trim().toUpperCase());
        }
    }
    return vocabulary;
}

/**
 * Character tags of an archive entry: name (from `<Name:…>`), `<KEY:VALUE>` tags and the MBTI archetype.
 * Template placeholders (`<GENRE:BLANK>`, `<Dere:NEW>`) are skipped.
 */
export function archiveTags(entry: BunnyMoEntryLike | null | undefined): ArchiveTags {
    const block = TAG_BLOCK_RE.exec(text(entry?.content));
    if (!block?.[1]) return { name: null, tags: [] };
    let name: string | null = null;
    const tags = new Set<string>();
    for (const match of block[1].matchAll(TAG_RE)) {
        const key = (match[1] ?? '').trim();
        const value = (match[2] ?? '').trim();
        if (key.toUpperCase() === 'NAME') name = value;
        else if (!PLACEHOLDER_RE.test(value)) tags.add(`<${key.toUpperCase()}:${value}>`);
    }
    for (const match of block[1].matchAll(MBTI_TAG_RE)) tags.add(`<${(match[1] ?? '').toUpperCase()}>`);
    return { name, tags: [...tags] };
}

/**
 * A character archive: an entry with a `<BunnymoTags>` block holding a real name or tags (a CarrotKernel
 * archive, BunnyMo example #43). Not archives: sheet templates of the core (`<Name:NAME>`, `<…:BLANK>`) and any
 * block whose name is a placeholder.
 */
export function isCharacterArchive(entry: BunnyMoEntryLike | null | undefined): boolean {
    if (!TAG_BLOCK_RE.test(text(entry?.content)) || isBunnyMoCoreEntry(entry)) return false;
    const { name, tags } = archiveTags(entry);
    return name !== null ? !PLACEHOLDER_RE.test(name) : tags.length > 0;
}

/**
 * Words of character names in archives: `<Name:…>` and plain Cyrillic keys (lower case, ё → е). Lets a caller
 * keep one archive's key from firing on another character's name ("Петров" vs "Петрова").
 */
export function archiveNameWords(archives: Iterable<BunnyMoEntryLike>): Set<string> {
    const words = new Set<string>();
    const add = (value: string): void => {
        for (const word of value
            .toLowerCase()
            .replace(/ё/g, 'е')
            .split(/[\s_]+/)) {
            if (word) words.add(word);
        }
    };
    for (const entry of archives) {
        const { name } = archiveTags(entry);
        if (name && !PLACEHOLDER_RE.test(name)) add(name);
        for (const key of entryKeys(entry)) {
            if (CYRILLIC_RE.test(key) && !REGEX_KEY_RE.test(key)) add(key);
        }
    }
    return words;
}

/* ------------------------------------------------------------------ Medicine Check (core #41) */

/** Title of the core's Medicine Check entry (V3.0 uid 41: «💉 Master - Medicine Check»). */
const MEDICINE_COMMENT_RE = /Master\s*-\s*Medicine\s+Check/i;
/** Its wrapper `<BunnymoTags:Master - Medicine Check>` at the start of the content. */
const MEDICINE_WRAPPER_RE = /^<BunnymoTags:\s*Master\s*-\s*Medicine\s+Check\s*>/i;
/** The always-firing key the entry carries (`/^/`). */
const MATCH_ALL_KEY = '/^/';

/**
 * BunnyMo core's «Medicine Check» (V3.0 #41): a per-turn instruction for every present character with `<MED:…>` /
 * `<REC:…>` tags. Recognised by its title or its `<BunnymoTags:…>` wrapper, and by firing on every turn (the key `/^/`
 * or `constant`); the caller checks that the book is the BunnyMo core (book role, adapter, classification). Uids
 * change between versions, titles do not.
 */
export function isMedicineCheckEntry(entry: (BunnyMoEntryLike & { constant?: unknown }) | null | undefined): boolean {
    if (!entry) return false;
    const titled = MEDICINE_COMMENT_RE.test(text(entry.comment));
    const wrapped = MEDICINE_WRAPPER_RE.test(text(entry.content).trimStart());
    if (!titled && !wrapped) return false;
    return entry.constant === true || entryKeys(entry).includes(MATCH_ALL_KEY);
}

/** Tag categories the Medicine Check reads (core #41: «characters … who have <MED:> or <REC:> tags»). */
export const DEPENDENCE_CATEGORIES: readonly string[] = ['MED', 'REC'];

/** The archive tags carry a medication or a recreational substance (`<MED:…>`, `<REC:…>`). */
export function hasDependenceTags(tags: readonly string[]): boolean {
    return tags.some((tag) => {
        const match = /^<\s*([A-Za-z]+)\s*:/.exec(tag);
        return !!match?.[1] && DEPENDENCE_CATEGORIES.includes(match[1].toUpperCase());
    });
}

/** Books that hold at least one character archive (by `world`). */
export function archiveWorlds(entries: Iterable<BunnyMoEntryLike>): Set<string> {
    const worlds = new Set<string>();
    for (const entry of entries) {
        const world = text(entry?.world);
        if (world && !worlds.has(world) && isCharacterArchive(entry)) worlds.add(world);
    }
    return worlds;
}
