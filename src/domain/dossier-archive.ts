// Dossier «Оформить» (M7 п. 6): the CarrotKernel archive of a new character. The cheap model picks BunnyMo tags from
// the loaded packs' dictionary (strict JSON schema), the answer is checked against that dictionary (English only, no
// placeholders, no `!updatesheet` markup, values with a loaded pack entry for the categories that pull lore), and the
// archive is written the way CarrotKernel's Baby Bunny writes its single-path entry (research/bunnymo-carrotkernel.md
// §2.2, BunnyMo core #43/#44):
//
//   <BunnymoTags><Name:Мира>, <GENRE:FANTASY> <PHYSICAL><SPECIES:HUMAN>, <GENDER:FEMALE></PHYSICAL>
//   <PERSONALITY><DERE:KUUDERE>, <INTJ-U>, <TRAIT:STOIC></PERSONALITY></BunnymoTags>
//   <Linguistics>Character uses <LING:BLUNT>. Short, clipped sentences.</Linguistics>
//
// One block, one character; `<Name:…>` is the canonical name and never changes afterwards (research §5). Entry flags
// follow Baby Bunny (position 4 at depth 2, order 550, excludeRecursion, ignoreBudget) with two corrections the rules
// of M22/M5 would make anyway: role system instead of Baby Bunny's hardcoded assistant role, and the global scan depth
// and whole-word setting instead of scanDepth 1 / matchWholeWords (they make the archive fire only on the last message
// and break Cyrillic names). Pure.
import { INFO_CATEGORIES, MBTI_CATEGORY, isPlaceholderValue } from './bunnymo-mode-tags';
import { uniqueStrings } from './canon-keys';
import { templateEntry } from './lore-studio-entries';
import type { LoreEntry } from './lore-studio-entries';

/* ------------------------------------------------------------------ vocabulary */

/** The part of a BunnyMo-mode dictionary tag (bunnymoMode TagInfo) the archive needs. */
export interface ArchiveDictionaryTag {
    tag: string;
    category: string;
    value: string | null;
    entries: readonly { kind: string }[];
}

export interface ArchiveDictionaryLike {
    tags: readonly ArchiveDictionaryTag[];
}

export interface ArchiveVocabulary {
    /** Categories that pull pack lore: only values with a loaded pack entry (category → values, upper case). */
    strict: Map<string, string[]>;
    /** Informational categories with any English value (known values from archives as hints). */
    free: Map<string, string[]>;
    /** MBTI archetypes with a loaded pack entry (`INFP-H`). */
    mbti: string[];
}

/**
 * Informational categories offered for a new archive (research §1.2: no pack entry keys on them; CK and the model read
 * them). Intimate ones (KINK, AROUSAL, CHEMISTRY, JEALOUSY, FLIRTING) are left out: a first archive made from scraps
 * of the story would only guess them.
 */
export const FREE_CATEGORIES: readonly string[] = [
    'GENDER',
    'AGE',
    'BUILD',
    'HAIR',
    'EYECOLOR',
    'SKIN',
    'STYLE',
    'ATTACHMENT',
    'CONFLICT',
    'BOUNDARIES',
    'DECISION',
    'COMFORT',
    'VICE',
    'LOYALTY',
    'TRUST',
    'MASK',
    'ORIENTATION',
    'POWER',
];

/** Categories with at most one tag in an archive. */
const SINGLE_CATEGORIES: ReadonlySet<string> = new Set(['DERE', 'GENDER', 'AGE', 'BUILD', 'ORIENTATION']);
const CATEGORY_RE = /^[A-Z][A-Z0-9_]*$/;
const FREE_VALUE_RE = /^[A-Z0-9][A-Z0-9_]{0,39}$/;
const MBTI_RE = /^([EI][NS][FT][JP])-([HU])$/;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const TRANSITIONAL_RE = /→|->|↔|\d\s*%|\b(?:FADING|STRENGTHENING|WEAKENING|EMERGING|CONVERTING)\b/i;
const META_RE = /^(?:SECTION(?:_HEADER)?|[A-Z0-9_]+_(?:GUIDE(?:_NOTE)?|PRIMER|SECTION|HEADER))$/;
/** Tags in an archive (more only bloat CK's consistency slot). */
export const MAX_ARCHIVE_TAGS = 24;

function sorted(values: Iterable<string>): string[] {
    return [...new Set(values)].sort();
}

/**
 * What a new archive may use: values of the categories that pull pack lore (a 'pull' entry is loaded), the MBTI
 * archetypes with a loaded entry, and the informational categories of FREE_CATEGORIES (values seen in other archives
 * as hints). Bare flags (`<PTSD>`) and section headers are left out: CK reads only `<KEY:VALUE>` tags.
 */
export function archiveVocabularyOf(dictionary: ArchiveDictionaryLike): ArchiveVocabulary {
    const strict = new Map<string, Set<string>>();
    const seenFree = new Map<string, Set<string>>();
    const mbti = new Set<string>();
    for (const tag of dictionary.tags) {
        const category = tag.category.toUpperCase();
        const value = tag.value?.toUpperCase() ?? null;
        if (value === null || !CATEGORY_RE.test(category) || META_RE.test(category)) continue;
        const pulls = tag.entries.some((entry) => entry.kind === 'pull');
        if (category === MBTI_CATEGORY) {
            if (pulls && MBTI_RE.test(value)) mbti.add(value);
            continue;
        }
        if (pulls) {
            const set = strict.get(category) ?? new Set<string>();
            set.add(value);
            strict.set(category, set);
        } else if (FREE_CATEGORIES.includes(category) && FREE_VALUE_RE.test(value)) {
            const set = seenFree.get(category) ?? new Set<string>();
            set.add(value);
            seenFree.set(category, set);
        }
    }
    const free = new Map<string, string[]>();
    for (const category of FREE_CATEGORIES) {
        if (strict.has(category) || !INFO_CATEGORIES.has(category)) continue;
        free.set(category, sorted(seenFree.get(category) ?? []));
    }
    return {
        strict: new Map([...strict.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sorted(v)])),
        free,
        mbti: sorted(mbti),
    };
}

/** No pack is loaded that a tag could pull (nothing but informational categories). */
export function isEmptyVocabulary(vocabulary: ArchiveVocabulary): boolean {
    return vocabulary.strict.size === 0 && vocabulary.mbti.length === 0;
}

/* ------------------------------------------------------------------ prompt and schema */

export interface ArchivePromptInput {
    name: string;
    aliases: readonly string[];
    /** Everything known about the character (any language), already cut to size. */
    known: string;
}

const SYSTEM_PROMPT = [
    'You fill a BunnyMo character archive for the CarrotKernel extension of SillyTavern.',
    'Pick tags that the known facts support. Use only the categories and values from the allowed list,',
    'written exactly as listed (English, upper case). Never invent values, never write placeholders,',
    'never write Russian. At most one value for DERE, GENDER, AGE, BUILD and ORIENTATION.',
    `Choose 6 to ${MAX_ARCHIVE_TAGS} tags; skip a category when nothing supports it.`,
    'Informational categories (marked "any value") take a short English value in UPPER_SNAKE_CASE.',
    'mbti: one archetype from the list (H = healthy, U = unhealthy) or "" when unsure.',
    'linguistics: one or two short English sentences about how the character speaks, or "".',
    'Answer with JSON only: {"tags":[{"category":"…","value":"…"}],"mbti":"…","linguistics":"…"}.',
].join('\n');

/** The allowed list as prompt lines: `SPECIES: ELF, HUMAN`, `GENDER (any value): FEMALE, MALE`. */
export function vocabularyLines(vocabulary: ArchiveVocabulary): string[] {
    const lines: string[] = [];
    for (const [category, values] of vocabulary.strict) lines.push(`${category}: ${values.join(', ')}`);
    for (const [category, values] of vocabulary.free) {
        lines.push(`${category} (any value)${values.length ? `: e.g. ${values.slice(0, 12).join(', ')}` : ''}`);
    }
    if (vocabulary.mbti.length) lines.push(`mbti: ${vocabulary.mbti.join(', ')}`);
    return lines;
}

export function buildArchiveMessages(
    input: ArchivePromptInput,
    vocabulary: ArchiveVocabulary,
): { role: 'system' | 'user'; content: string }[] {
    const aliases = uniqueStrings(input.aliases).filter((alias) => alias !== input.name);
    const user = [
        `Character: ${input.name}${aliases.length ? ` (also: ${aliases.join(', ')})` : ''}`,
        '',
        'Known facts:',
        input.known.trim() || '(only the name)',
        '',
        'Allowed tags:',
        ...vocabularyLines(vocabulary),
    ].join('\n');
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

/**
 * Strict JSON schema of the answer. Each category is listed with its allowed values while the whole list stays under
 * `maxEnum` values (providers cap enum sizes); above that the categories stay an enum and the values are checked
 * after the answer.
 */
export function archiveSchema(vocabulary: ArchiveVocabulary, maxEnum = 400): Record<string, unknown> {
    const categories = [...vocabulary.strict.keys(), ...vocabulary.free.keys()];
    const total = [...vocabulary.strict.values()].reduce((sum, values) => sum + values.length, 0);
    const pair = (category: Record<string, unknown>, value: Record<string, unknown>) => ({
        type: 'object',
        additionalProperties: false,
        required: ['category', 'value'],
        properties: { category, value },
    });
    const item =
        total <= maxEnum && categories.length
            ? {
                  anyOf: [
                      ...[...vocabulary.strict].map(([category, values]) =>
                          pair({ type: 'string', enum: [category] }, { type: 'string', enum: values }),
                      ),
                      ...[...vocabulary.free.keys()].map((category) =>
                          pair({ type: 'string', enum: [category] }, { type: 'string' }),
                      ),
                  ],
              }
            : pair({ type: 'string', enum: categories.length ? categories : [''] }, { type: 'string' });
    return {
        type: 'object',
        additionalProperties: false,
        required: ['tags', 'mbti', 'linguistics'],
        properties: {
            tags: { type: 'array', maxItems: MAX_ARCHIVE_TAGS, items: item },
            mbti: { type: 'string', enum: ['', ...vocabulary.mbti] },
            linguistics: { type: 'string' },
        },
    };
}

/* ------------------------------------------------------------------ the answer */

export interface ArchiveTag {
    category: string;
    value: string;
}

export interface ArchiveMbti {
    type: string;
    variant: 'H' | 'U';
}

export type ArchiveRejectReason =
    'malformed' | 'cyrillic' | 'placeholder' | 'transitional' | 'unknownCategory' | 'unknownValue' | 'duplicate';

export interface ArchiveAnswer {
    tags: ArchiveTag[];
    mbti: ArchiveMbti | null;
    /** English prose for the `<Linguistics>` block ('' when none). */
    linguistics: string;
    /** Tags of the answer that were dropped, as written, with the reason. */
    rejected: { tag: string; reason: ArchiveRejectReason }[];
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first JSON object of a model answer (code fences and chatter around it allowed); null when there is none. */
export function readJsonObject(raw: unknown): Dict | null {
    if (isDict(raw)) return raw;
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
        return isDict(value) ? value : null;
    } catch {
        return null;
    }
}

/** `<KEY:VALUE>` or `KEY:VALUE` → its parts (as written); null otherwise. */
function splitTag(text: string): { category: string; value: string } | null {
    const match = /^<?\s*([^<>:]+?)\s*:\s*([^<>]*?)\s*>?$/.exec(text.trim());
    return match ? { category: match[1] ?? '', value: match[2] ?? '' } : null;
}

function readMbti(raw: string): ArchiveMbti | null {
    const match = MBTI_RE.exec(raw.trim().replace(/^<|>$/g, '').toUpperCase());
    return match?.[1] && match[2] ? { type: match[1], variant: match[2] === 'H' ? 'H' : 'U' } : null;
}

/**
 * The model's answer checked against the vocabulary: tags as `{category, value}` objects or `<KEY:VALUE>` strings;
 * values are upper-cased with spaces as `_`. Dropped: Russian, placeholders, transitional markup, unknown categories,
 * values without a loaded entry (strict categories), malformed free values, repeats and second values of single
 * categories. MBTI may also come as a tag of category MBTI.
 */
export function parseArchiveAnswer(raw: unknown, vocabulary: ArchiveVocabulary): ArchiveAnswer | null {
    const data = readJsonObject(raw);
    if (!data) return null;
    const tags: ArchiveTag[] = [];
    const rejected: ArchiveAnswer['rejected'] = [];
    const seen = new Set<string>();
    const used = new Set<string>();
    let mbti: ArchiveMbti | null = null;
    const reject = (tag: string, reason: ArchiveRejectReason) => rejected.push({ tag, reason });
    const takeMbti = (written: string, value: string) => {
        const parsed = readMbti(value);
        if (!parsed) return reject(written, 'malformed');
        if (!vocabulary.mbti.includes(`${parsed.type}-${parsed.variant}`)) return reject(written, 'unknownValue');
        if (mbti) return reject(written, 'duplicate');
        mbti = parsed;
    };
    const list = Array.isArray(data.tags) ? data.tags : [];
    for (const item of list) {
        let category: string;
        let value: string;
        if (isDict(item)) {
            category = typeof item.category === 'string' ? item.category : '';
            value = typeof item.value === 'string' ? item.value : '';
        } else if (typeof item === 'string') {
            const parsed = splitTag(item);
            if (!parsed) {
                if (readMbti(item)) takeMbti(item, item);
                else reject(item, 'malformed');
                continue;
            }
            category = parsed.category;
            value = parsed.value;
        } else {
            continue;
        }
        const written = `<${category}:${value}>`;
        if (CYRILLIC_RE.test(category) || CYRILLIC_RE.test(value)) {
            reject(written, 'cyrillic');
            continue;
        }
        const key = category.trim().toUpperCase();
        const normalised = value.trim().toUpperCase().replace(/\s+/g, '_');
        if (!key || !normalised || !CATEGORY_RE.test(key) || /[<>]/.test(normalised)) {
            reject(written, 'malformed');
            continue;
        }
        if (key === MBTI_CATEGORY) {
            takeMbti(written, normalised);
            continue;
        }
        if (isPlaceholderValue(normalised)) {
            reject(written, 'placeholder');
            continue;
        }
        if (TRANSITIONAL_RE.test(value)) {
            reject(written, 'transitional');
            continue;
        }
        const strict = vocabulary.strict.get(key);
        if (strict) {
            if (!strict.includes(normalised)) {
                reject(written, 'unknownValue');
                continue;
            }
        } else if (vocabulary.free.has(key)) {
            if (!FREE_VALUE_RE.test(normalised)) {
                reject(written, 'malformed');
                continue;
            }
        } else {
            reject(written, 'unknownCategory');
            continue;
        }
        const id = `${key}:${normalised}`;
        if (seen.has(id) || (SINGLE_CATEGORIES.has(key) && used.has(key)) || tags.length >= MAX_ARCHIVE_TAGS) {
            reject(written, 'duplicate');
            continue;
        }
        seen.add(id);
        used.add(key);
        tags.push({ category: key, value: normalised });
    }
    if (typeof data.mbti === 'string' && data.mbti.trim()) takeMbti(data.mbti.trim(), data.mbti);
    const prose = typeof data.linguistics === 'string' ? data.linguistics : '';
    const linguistics = CYRILLIC_RE.test(prose) ? '' : prose.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
    return { tags, mbti, linguistics: linguistics.slice(0, 400), rejected };
}

/** Tags as an archive carries them (`<SPECIES:ELF>`, `<INFP-H>`), for the BunnyMo mode's tag check. */
export function formatArchiveTags(tags: readonly ArchiveTag[], mbti: ArchiveMbti | null): string[] {
    const list = tags.map((tag) => `<${tag.category}:${tag.value}>`);
    if (mbti) list.push(`<${mbti.type}-${mbti.variant}>`);
    return list;
}

/* ------------------------------------------------------------------ the entry */

/** Order inside the block (BunnyMo's TAG SYNTHESIS template, core #2 / #44). */
const GROUPS: readonly { name: string; categories: readonly string[] }[] = [
    {
        name: 'PHYSICAL',
        categories: [
            'SPECIES',
            'GENDER',
            'AGE',
            'BUILD',
            'SKIN',
            'SKINCOLOR',
            'SKINTONE',
            'HAIR',
            'HAIRCOLOR',
            'EYECOLOR',
            'STYLE',
            'FONT',
        ],
    },
    {
        name: 'PERSONALITY',
        categories: [
            'DERE',
            MBTI_CATEGORY,
            'TRAIT',
            'ATTACHMENT',
            'CONFLICT',
            'BOUNDARIES',
            'FLIRTING',
            'DECISION',
            'COMFORT',
            'VICE',
            'LOYALTY',
            'TRUST',
            'MASK',
            'ARCHETYPE',
        ],
    },
    { name: 'NSFW', categories: ['ORIENTATION', 'POWER', 'KINK', 'CHEMISTRY', 'AROUSAL', 'TRAUMA', 'JEALOUSY'] },
    {
        name: 'HEALTH',
        categories: [
            'BSM',
            'MENTAL',
            'MOOD',
            'ANXIETY',
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
        ],
    },
];

/** Tags written before the groups (the template's `<GENRE:…>` right after the name). */
const LEADING: readonly string[] = ['GENRE'];
/** Tags written into the `<Linguistics>` prose block (as BunnyMo's template does). */
const LINGUISTIC = 'LING';

export interface ArchiveContentInput {
    /** `<Name:…>`: the canonical name, as is. */
    name: string;
    tags: readonly ArchiveTag[];
    mbti: ArchiveMbti | null;
    linguistics?: string;
}

function tagText(tag: ArchiveTag): string {
    return `<${tag.category}:${tag.value}>`;
}

/** The archive text: one `<BunnymoTags>` block, then `<Linguistics>` when there is speech to describe. */
export function buildArchiveContent(input: ArchiveContentInput): string {
    const name = input.name
        .replace(/[<>\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const rank = (list: readonly string[], category: string) => {
        const index = list.indexOf(category);
        return index < 0 ? list.length : index;
    };
    const byOrder = (list: readonly string[]) => (a: ArchiveTag, b: ArchiveTag) =>
        rank(list, a.category) - rank(list, b.category);
    const grouped = new Set<string>(GROUPS.flatMap((group) => group.categories));
    const leading = input.tags.filter((tag) => LEADING.includes(tag.category)).map(tagText);
    const blocks: string[] = [[`<Name:${name}>`, ...leading].join(', ')];
    for (const group of GROUPS) {
        const items = input.tags
            .filter((tag) => group.categories.includes(tag.category))
            .sort(byOrder(group.categories));
        const texts = items.map(tagText);
        if (group.name === 'PERSONALITY' && input.mbti) {
            const mbti = `<${input.mbti.type}-${input.mbti.variant}>`;
            const dere = items.filter((tag) => tag.category === 'DERE').length;
            texts.splice(dere, 0, mbti);
        }
        if (texts.length) blocks.push(`<${group.name}>${texts.join(', ')}</${group.name}>`);
    }
    const rest = input.tags.filter(
        (tag) => !LEADING.includes(tag.category) && !grouped.has(tag.category) && tag.category !== LINGUISTIC,
    );
    if (rest.length) blocks.push(rest.map(tagText).join(', '));
    let content = `<BunnymoTags>${blocks.join(' ')}</BunnymoTags>`;
    const ling = input.tags.filter((tag) => tag.category === LINGUISTIC).map(tagText);
    const prose = (input.linguistics ?? '').replace(/[<>]/g, '').trim();
    if (ling.length || prose) {
        const uses = ling.length ? `Character uses ${ling.join(', ')}.` : '';
        content += `\n<Linguistics>${[uses, prose].filter(Boolean).join(' ')}</Linguistics>`;
    }
    return content;
}

/**
 * Entry flags of an archive: Baby Bunny's single path (position 4 at depth 2, order 550, excludeRecursion,
 * ignoreBudget, probability 100, research §2.2) with role system (0) instead of its hardcoded assistant role, and the
 * global scan depth / whole-word setting instead of scanDepth 1 and matchWholeWords.
 */
export const ARCHIVE_ENTRY_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({
    constant: false,
    selective: true,
    selectiveLogic: 0,
    position: 4,
    depth: 2,
    role: 0,
    order: 550,
    excludeRecursion: true,
    preventRecursion: false,
    useProbability: true,
    probability: 100,
    ignoreBudget: true,
    scanDepth: null,
    matchWholeWords: null,
    caseSensitive: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    disable: false,
});

/** Baby Bunny's title pattern (CK falls back to it for the name; DES-RU and the dossier read it too). */
export function archiveTitle(name: string): string {
    return `${name.trim()} Character Archive`;
}

/** Archive keys: the canonical name and the aliases as plain keys (DES-RU widens Cyrillic ones to case forms). */
export function archiveKeys(name: string, aliases: readonly string[]): string[] {
    return uniqueStrings([name, ...aliases]).filter((key) => !/^\/[\s\S]+\/[gimsuy]*$/.test(key));
}

/** A complete World Info entry for the archive (ST's template fields, the archive flags, the given uid). */
export function archiveEntry(
    uid: number,
    input: { name: string; keys: readonly string[]; content: string },
): LoreEntry {
    return templateEntry(uid, {
        ...ARCHIVE_ENTRY_FIELDS,
        key: [...input.keys],
        keysecondary: [],
        comment: archiveTitle(input.name),
        content: input.content,
    });
}
