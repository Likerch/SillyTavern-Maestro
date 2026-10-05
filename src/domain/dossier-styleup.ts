// Dossier «Оформить» (M7 п. 6, plan §8 «Оформление нового NPC — Входящие»): a new NPC or place gets every store at
// once. Pure parts: which stores are missing, the typed canon entry made from what the stack already knows (DES
// tracker details, Workshop texts, living-canon quotes, world facts), its keys, the CK repository book to write the
// archive into, a free passport id, the texts handed to the cheap model and to NAI Studio's passport generator, and
// the copy of a canon entry promoted into the card's book.
import { uniqueStrings } from './canon-keys';
import { composeContent } from './entry-types';
import type { LoreEntry } from './lore-studio-entries';

/** The stores «Оформить» fills, in the order they are written. */
export const STYLE_UP_PARTS = ['canon', 'archive', 'passport', 'placeEntry', 'lorePassport'] as const;
export type StyleUpPartId = (typeof STYLE_UP_PARTS)[number];

/** The book a new CK archive goes to when no Character Repo can take it (role 'ck.archive', P13: never BunnyMo). */
export const ARCHIVE_BOOK_NAME = 'Maestro · архив';

/* ------------------------------------------------------------------ what is missing */

export interface StyleUpGapInput {
    /** Entity kind; only characters and places are styled up. */
    kind: string;
    /** Owners that can take a store (a store whose owner is off is not «missing»). */
    canonOn: boolean;
    archiveOn: boolean;
    naiOn: boolean;
    placesOn?: boolean;
    lorePassportsOn?: boolean;
    /** Character: a lorebook entry (not a place description) or a chat canon addition about it. */
    hasEntry?: boolean;
    hasArchive?: boolean;
    hasPassport?: boolean;
    /** Place: its description entry and a location passport (lore passport of the entry, NAI location passport). */
    hasPlaceEntry?: boolean;
    hasPlacePassport?: boolean;
}

export interface StyleUpGaps {
    kind: 'character' | 'place';
    missing: StyleUpPartId[];
}

/** The stores a character or place still lacks (with their owner on); null when nothing is missing. */
export function styleUpGaps(input: StyleUpGapInput): StyleUpGaps | null {
    const missing: StyleUpPartId[] = [];
    if (input.kind === 'character') {
        if (input.canonOn && !input.hasEntry) missing.push('canon');
        if (input.archiveOn && !input.hasArchive) missing.push('archive');
        if (input.naiOn && !input.hasPassport) missing.push('passport');
        return missing.length ? { kind: 'character', missing } : null;
    }
    if (input.kind === 'place') {
        if (input.placesOn && input.canonOn && !input.hasPlaceEntry) missing.push('placeEntry');
        if (input.lorePassportsOn && !input.hasPlacePassport) missing.push('lorePassport');
        return missing.length ? { kind: 'place', missing } : null;
    }
    return null;
}

/* ------------------------------------------------------------------ the canon entry */

export interface CharacterKnowledge {
    name: string;
    aliases: readonly string[];
    /** DES tracker details of the character (`appearance`, `demeanor`, `outfit`, …). */
    details: Readonly<Record<string, string>>;
    portraitPrompt?: string | undefined;
    workshopDescription?: string | undefined;
    cardDescription?: string | undefined;
    /** Relationship with the persona now. */
    relationship?: { with: string; value: string } | null | undefined;
    /** Living-canon quotes and texts about the character. */
    quotes: readonly string[];
    /** World model facts about the character. */
    facts: readonly string[];
}

export interface PlaceKnowledge {
    name: string;
    aliases: readonly string[];
    /** Containing places, outermost first. */
    path: readonly string[];
    background?: string | undefined;
    state: Readonly<Record<string, string>>;
    /** Characters seen there (place visits). */
    people: readonly string[];
    quotes: readonly string[];
    facts: readonly string[];
}

const MAX_LINES = 6;
const MAX_QUOTES = 3;
/** Tracker detail keys → the canon field they fill (English and Russian labels). */
const DETAIL_FIELDS: readonly { re: RegExp; field: string }[] = [
    { re: /appear|look|outfit|cloth|wear|hair|eyes?\b|body|face|внешн|одежд|облик|волос|глаз/i, field: 'appearance' },
    { re: /demeanou?r|personality|temper|manner|characte?r|нрав|характер|повед|манер/i, field: 'personality' },
    { re: /goal|intent|want|plan|desire|цел|намер|жела|план/i, field: 'goals' },
    { re: /role|occupation|job|profession|title|class|роль|занят|профес|долж/i, field: 'role' },
    { re: /\bage\b|возраст/i, field: 'age' },
    { re: /speech|voice|accent|речь|голос|говор/i, field: 'speech' },
];
/** Relationship fields of the tracker (the relations module knows them better). */
const RELATION_RE = /relation|attitude|отношен/i;
/** Momentary state in the tracker: not canon. */
const EPHEMERAL_RE =
    /thought|mood|feeling|emotion|status|position|location|action|doing|мысл|настроен|чувств|эмоц|сейчас|где|действ/i;

function clean(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+\n/g, '\n').trim();
}

function joinLines(lines: Iterable<string | null | undefined>, max = MAX_LINES): string {
    return uniqueStrings([...lines].map(clean))
        .slice(0, max)
        .join('\n');
}

function appendField(fields: Record<string, string>, field: string, value: string): void {
    const text = clean(value);
    if (!text) return;
    const previous = fields[field] ?? '';
    if (previous.split('\n').includes(text)) return;
    fields[field] = previous ? `${previous}\n${text}` : text;
}

/** Fields of a typed `character` canon entry (entry-types) from what the stack knows; values stay as written. */
export function characterFields(knowledge: CharacterKnowledge): Record<string, string> {
    const fields: Record<string, string> = {
        name: knowledge.name.trim(),
        aliases: uniqueStrings(knowledge.aliases)
            .filter((alias) => alias !== knowledge.name.trim())
            .join(', '),
    };
    const background: string[] = [];
    const related = Boolean(knowledge.relationship?.value.trim());
    for (const [key, value] of Object.entries(knowledge.details)) {
        if (!clean(value) || EPHEMERAL_RE.test(key)) continue;
        if (RELATION_RE.test(key)) {
            // The relations module knows with whom; the tracker's bare «Friend» only when it does not.
            if (!related) appendField(fields, 'relationships', `${key.replace(/_/g, ' ')}: ${clean(value)}`);
            continue;
        }
        const target = DETAIL_FIELDS.find((item) => item.re.test(key))?.field;
        if (target) appendField(fields, target, value);
        else background.push(`${key.replace(/_/g, ' ')}: ${clean(value)}`);
    }
    if (knowledge.portraitPrompt) appendField(fields, 'appearance', knowledge.portraitPrompt);
    if (related && knowledge.relationship) {
        appendField(fields, 'relationships', `${knowledge.relationship.with}: ${knowledge.relationship.value}`);
    }
    const quotes = uniqueStrings(knowledge.quotes).slice(0, MAX_QUOTES);
    const known = Object.values(fields).map((value) => value.toLowerCase());
    // A fact that only repeats a field («appearance: …» from the world model) is not background.
    const repeats = (line: string) => {
        const value = clean(line.replace(/^[^:\n]{1,40}:\s*/, '')).toLowerCase();
        return value.length > 0 && known.some((field) => field.includes(value));
    };
    fields.background = joinLines(
        [knowledge.workshopDescription, knowledge.cardDescription, ...background, ...knowledge.facts, ...quotes].filter(
            (line) => !line || !repeats(line),
        ),
    );
    for (const key of Object.keys(fields)) if (!fields[key]) delete fields[key];
    return fields;
}

/** Fields of a typed `place` canon entry from the place registry and the facts about it. */
export function placeFields(knowledge: PlaceKnowledge): Record<string, string> {
    const fields: Record<string, string> = {
        name: knowledge.name.trim(),
        aliases: uniqueStrings(knowledge.aliases)
            .filter((alias) => alias !== knowledge.name.trim())
            .join(', '),
        location: knowledge.path.filter((item) => item.trim()).join(' › '),
        description: clean(knowledge.background),
        atmosphere: Object.entries(knowledge.state)
            .filter(([, value]) => clean(value))
            .map(([key, value]) => `${key}: ${clean(value)}`)
            .join('; '),
        inhabitants: uniqueStrings(knowledge.people).slice(0, 8).join(', '),
        features: joinLines([...knowledge.facts, ...uniqueStrings(knowledge.quotes).slice(0, MAX_QUOTES)]),
    };
    for (const key of Object.keys(fields)) if (!fields[key]) delete fields[key];
    return fields;
}

/** Entry content of the typed fields («Character: Мира», «Appearance: …»). */
export function typedContent(type: 'character' | 'place', fields: Record<string, string>): string {
    return composeContent({ type, fields });
}

/** Keys of the canon entry: the name, the aliases and their Russian forms (canon.russianKeys / DES-RU), once each. */
export function styleUpKeys(name: string, aliases: readonly string[], russian: readonly string[]): string[] {
    return uniqueStrings([name, ...aliases, ...russian]);
}

/* ------------------------------------------------------------------ texts for the models */

function cut(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Everything known about a character for the archive's tag choice, cut to `max` characters. */
export function archiveKnownText(
    knowledge: CharacterKnowledge,
    extra: { lore?: readonly string[]; memories?: readonly string[]; passportTags?: string } = {},
    max = 4000,
): string {
    const lines: string[] = [];
    const add = (label: string, value: string | null | undefined) => {
        const text = clean(value);
        if (text) lines.push(`${label}: ${text}`);
    };
    for (const [key, value] of Object.entries(knowledge.details)) add(`Scene tracker ${key}`, value);
    add('Portrait prompt', knowledge.portraitPrompt);
    add('Description', knowledge.workshopDescription);
    add('Card description', knowledge.cardDescription);
    if (knowledge.relationship) add(`Relationship with ${knowledge.relationship.with}`, knowledge.relationship.value);
    add('Image tags', extra.passportTags);
    for (const text of extra.lore ?? []) add('Lore', text);
    for (const text of knowledge.facts) add('Fact', text);
    for (const text of knowledge.quotes) add('Story quote', text);
    for (const text of extra.memories ?? []) add('Memory', text);
    return cut(lines.join('\n'), max);
}

/** The appearance-first description NAI Studio's passport generator gets. */
export function passportDescription(knowledge: CharacterKnowledge, max = 1500): string {
    const fields = characterFields(knowledge);
    const parts = [
        fields.appearance ? `Appearance: ${fields.appearance}` : '',
        fields.age ? `Age: ${fields.age}` : '',
        fields.role ? `Role: ${fields.role}` : '',
        fields.personality ? `Personality: ${fields.personality}` : '',
        fields.background ? `Background: ${fields.background}` : '',
    ].filter(Boolean);
    return cut(parts.join('\n'), max);
}

/* ------------------------------------------------------------------ the repository book */

export interface ArchiveBookCandidate {
    book: string;
    /** Marked as a Character Repo in CarrotKernel. */
    repo: boolean;
    /** Role 'ck.archive' in Maestro's book roles. */
    role: boolean;
    /** BunnyMo core or pack (P13): never written. */
    protected: boolean;
    exists: boolean;
}

/**
 * Books a new archive may go to, best first (CK repos, then books with the role, then the rest), never a BunnyMo
 * book; `create` names the book to create when none is left.
 */
export function archiveBookChoice(
    candidates: readonly ArchiveBookCandidate[],
    fallback = ARCHIVE_BOOK_NAME,
): { books: string[]; create: string | null } {
    const usable = candidates.filter((item) => item.exists && !item.protected && item.book.trim());
    const rank = (item: ArchiveBookCandidate) => (item.repo ? 0 : item.role ? 1 : 2);
    const books = uniqueStrings(
        [...usable].sort((a, b) => rank(a) - rank(b) || a.book.localeCompare(b.book)).map((item) => item.book),
    );
    return { books, create: books.length ? null : fallback };
}

/* ------------------------------------------------------------------ passports */

/** `base` when it is free, else `base-2`, `base-3`… */
export function freeId(base: string, taken: (id: string) => boolean): string {
    if (!taken(base)) return base;
    let index = 2;
    while (taken(`${base}-${index}`)) index++;
    return `${base}-${index}`;
}

/* ------------------------------------------------------------------ promotion to the card's book */

/** WI fields a promoted canon entry keeps (Maestro's canon marker and bookkeeping stay behind). */
const PROMOTED_FIELDS: readonly string[] = [
    'key',
    'keysecondary',
    'comment',
    'content',
    'constant',
    'selective',
    'selectiveLogic',
    'order',
    'position',
    'depth',
    'role',
    'probability',
    'useProbability',
    'excludeRecursion',
    'preventRecursion',
    'delayUntilRecursion',
    'scanDepth',
    'caseSensitive',
    'matchWholeWords',
    'group',
    'groupOverride',
    'groupWeight',
    'sticky',
    'cooldown',
    'delay',
    'ignoreBudget',
];

/** The fields of a canon entry copied into a base book (enabled; no `extensions.maestro`, uid or world). */
export function promotedFields(entry: Readonly<Record<string, unknown>>): Partial<LoreEntry> {
    const out: Record<string, unknown> = {};
    for (const field of PROMOTED_FIELDS) {
        if (field in entry && entry[field] !== undefined) out[field] = structuredClone(entry[field]);
    }
    out.disable = false;
    return out as Partial<LoreEntry>;
}
