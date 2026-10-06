// «Подготовить к игре» (M37, plan-2 §7 п. 1–2): what the background model reads — the card's fields (the chosen
// starting scene in full, the other greetings in short), the persona, and the entries of the card's books, the chat
// book, the DES campaign and the CarrotKernel archives of this story's characters — as numbered sources packed into
// parts that fit one request each. The card's own fields always go into the first part; book entries fill the parts
// in order; what does not fit the budget is left out and listed. Every source has a hash: the card's fingerprint for
// the character-level reuse is made of them, and only changed sources are read again. Pure.
import { charsToTokens, bootstrapCostUsd } from './doctor-budget';
import { stableHash } from './hash';

/** Where a source comes from. */
export type SourceOrigin = 'card' | 'persona' | 'book' | 'chat' | 'campaign' | 'archive';

/** Card fields read as sources (the id is `card.<field>`). */
export const CARD_FIELDS = [
    'description',
    'personality',
    'scenario',
    'greeting',
    'greetings',
    'examples',
    'notes',
    'system',
] as const;

export type CardField = (typeof CARD_FIELDS)[number];

/** English labels of the card fields for the model. */
const CARD_FIELD_LABELS: Record<CardField, string> = {
    description: 'Card description',
    personality: 'Card personality',
    scenario: 'Scenario',
    greeting: 'Starting scene (the greeting this chat opened with)',
    greetings: 'Other starting scenes of the card (alternate greetings, shortened)',
    examples: 'Dialogue examples',
    notes: "Creator's notes",
    system: 'System prompt, post-history instructions and depth prompt of the card',
};

/** Characters of each card field kept (the card is never cut much: it is the core of the story). */
const CARD_FIELD_CHARS: Record<CardField, number> = {
    description: 12000,
    personality: 3000,
    scenario: 4000,
    greeting: 8000,
    greetings: 4000,
    examples: 3000,
    notes: 2000,
    system: 3000,
};

const PERSONA_CHARS = 3000;
const ALTERNATE_CHARS = 700;

export interface PrepareSource {
    /** `card.<field>`, `persona`, `book:<book>#<uid>`. */
    id: string;
    origin: SourceOrigin;
    /** English label for the model («Card description», «World · Harbour»). */
    label: string;
    /** Card field of a card source (the feature translates it for the user). */
    field?: CardField;
    book?: string;
    uid?: number;
    /** Entry title of a book source. */
    title?: string;
    text: string;
    /** Hash of the text (reuse: a changed source is read again). */
    hash: string;
    /** Card fields and the persona: always in the first part. */
    core: boolean;
}

export interface CardInput {
    name: string;
    description: string;
    personality: string;
    /** The chat's scenario override wins over the card's. */
    scenario: string;
    firstMessage: string;
    alternateGreetings: readonly string[];
    examples: string;
    creatorNotes: string;
    systemPrompt: string;
    postHistory: string;
    depthPrompt: string;
    /** Starting scene the chat opened with (0 the first message, n alternate greeting n). */
    greeting: number;
}

export interface PersonaInput {
    name: string;
    description: string;
}

export interface BookEntryInput {
    uid: number;
    title: string;
    keys: readonly string[];
    content: string;
    disabled?: boolean;
}

/** Text cut to `max` characters at a word boundary when one is near, with «…». */
export function clipText(text: string, max: number): string {
    const value = text.trim();
    if (max <= 0 || value.length <= max) return value;
    const head = value.slice(0, max);
    const space = head.lastIndexOf(' ');
    return `${(space > max * 0.8 ? head.slice(0, space) : head).trimEnd()}…`;
}

function source(partial: Omit<PrepareSource, 'hash'>): PrepareSource {
    return { ...partial, hash: stableHash(partial.text) };
}

/** The selected starting scene: greeting n (0 the first message), the first message when n is out of range. */
export function greetingText(card: Pick<CardInput, 'firstMessage' | 'alternateGreetings'>, greeting: number): string {
    if (greeting > 0 && greeting <= card.alternateGreetings.length) return card.alternateGreetings[greeting - 1] ?? '';
    return card.firstMessage;
}

/** Sources of the card itself and of the persona (all core). Empty fields are left out. */
export function cardSources(card: CardInput, persona: PersonaInput | null): PrepareSource[] {
    const out: PrepareSource[] = [];
    const add = (field: CardField, text: string) => {
        const value = clipText(text, CARD_FIELD_CHARS[field]);
        if (!value) return;
        out.push(
            source({
                id: `card.${field}`,
                origin: 'card',
                label: CARD_FIELD_LABELS[field],
                field,
                text: value,
                core: true,
            }),
        );
    };
    add('description', card.description);
    add('personality', card.personality);
    add('scenario', card.scenario);
    const selected = Math.max(0, Math.floor(card.greeting));
    add('greeting', greetingText(card, selected));
    const others = [card.firstMessage, ...card.alternateGreetings]
        .map((text, index) => ({ text: text.trim(), index }))
        .filter((greeting) => greeting.text && greeting.index !== selected)
        .map(
            (greeting) =>
                `${greeting.index === 0 ? 'First message' : `Alternate greeting ${greeting.index}`}: ${clipText(greeting.text, ALTERNATE_CHARS)}`,
        );
    add('greetings', others.join('\n\n'));
    add('examples', card.examples);
    add('notes', card.creatorNotes);
    add(
        'system',
        [card.systemPrompt, card.postHistory, card.depthPrompt]
            .map((text) => text.trim())
            .filter(Boolean)
            .join('\n\n'),
    );
    if (persona && (persona.name.trim() || persona.description.trim())) {
        const text = clipText(
            [persona.name.trim() ? `Name: ${persona.name.trim()}` : '', persona.description.trim()]
                .filter(Boolean)
                .join('\n'),
            PERSONA_CHARS,
        );
        out.push(
            source({ id: 'persona', origin: 'persona', label: "The player's character (persona)", text, core: true }),
        );
    }
    return out;
}

/** Sources of a book's enabled, non-empty entries (each cut to `entryChars`). */
export function bookSources(
    book: string,
    entries: readonly BookEntryInput[],
    origin: SourceOrigin,
    entryChars: number,
): PrepareSource[] {
    const out: PrepareSource[] = [];
    for (const entry of entries) {
        if (entry.disabled) continue;
        const content = entry.content.trim();
        if (!content) continue;
        const keys = entry.keys.map((key) => key.trim()).filter(Boolean);
        const text = clipText(
            [keys.length ? `Keys: ${keys.slice(0, 12).join(', ')}` : '', content].filter(Boolean).join('\n'),
            entryChars,
        );
        const title = entry.title.trim() || keys[0] || `#${entry.uid}`;
        out.push(
            source({
                id: `book:${book}#${entry.uid}`,
                origin,
                label: `${book} · ${title}`,
                book,
                uid: entry.uid,
                title,
                text,
                core: false,
            }),
        );
    }
    return out;
}

/* ------------------------------------------------------------------ parts and the budget */

export interface ChunkLimits {
    /** Characters of sources per part (the instructions and the context come on top). */
    chunkChars: number;
    /** Parts at most; sources beyond them are left out. */
    maxChunks: number;
}

export interface PrepareChunk {
    index: number;
    sourceIds: string[];
    chars: number;
    /** Holds the card's own fields (the first part). */
    core: boolean;
}

export interface ChunkResult {
    chunks: PrepareChunk[];
    /** Sources that did not fit (ids). */
    skipped: string[];
    /** Repeated texts (the same entry in two books) read once (ids). */
    duplicates: string[];
}

/** Characters a source takes in a request (its label line and text). */
export function sourceChars(item: Pick<PrepareSource, 'label' | 'text'>): number {
    return item.label.length + item.text.length + 12;
}

/**
 * Packs sources into parts: every core source into the first part, then the others in order, a new part when the
 * current one would grow past `chunkChars`. Sources after the last allowed part are skipped; a text seen already (same
 * hash) is read once.
 */
export function chunkSources(sources: readonly PrepareSource[], limits: ChunkLimits): ChunkResult {
    const maxChunks = Math.max(1, Math.floor(limits.maxChunks));
    const budget = Math.max(1000, Math.floor(limits.chunkChars));
    const chunks: PrepareChunk[] = [];
    const skipped: string[] = [];
    const duplicates: string[] = [];
    const seen = new Set<string>();
    const fresh = sources.filter((item) => {
        if (seen.has(item.hash)) {
            duplicates.push(item.id);
            return false;
        }
        seen.add(item.hash);
        return true;
    });
    const core = fresh.filter((item) => item.core);
    if (core.length) {
        chunks.push({
            index: 0,
            sourceIds: core.map((item) => item.id),
            chars: core.reduce((sum, item) => sum + sourceChars(item), 0),
            core: true,
        });
    }
    for (const item of fresh.filter((candidate) => !candidate.core)) {
        const size = sourceChars(item);
        let current = chunks[chunks.length - 1];
        if (!current || (current.chars + size > budget && current.sourceIds.length)) {
            if (chunks.length >= maxChunks) {
                skipped.push(item.id);
                continue;
            }
            current = { index: chunks.length, sourceIds: [], chars: 0, core: false };
            chunks.push(current);
        }
        current.sourceIds.push(item.id);
        current.chars += size;
    }
    return { chunks, skipped, duplicates };
}

export interface PrepareEstimate {
    chunks: number;
    /** Sources that will be read. */
    sources: number;
    /** Sources left out by the budget. */
    skipped: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
}

/**
 * A rough price before running: every part is one request (sources + instructions + context, Russian text at
 * ≈ 3.5 characters a token) and an answer of about `outputTokens`; priced like the other background estimates.
 */
export function estimateChunks(
    result: ChunkResult,
    options: { overheadChars: number; outputTokens: number; usdPerMillion?: number },
): PrepareEstimate {
    const inputTokens = result.chunks.reduce(
        (sum, chunk) => sum + charsToTokens(chunk.chars + options.overheadChars, 3.5),
        0,
    );
    const outputTokens = result.chunks.length * Math.max(0, Math.round(options.outputTokens));
    return {
        chunks: result.chunks.length,
        sources: result.chunks.reduce((sum, chunk) => sum + chunk.sourceIds.length, 0),
        skipped: result.skipped.length,
        inputTokens,
        outputTokens,
        usd: bootstrapCostUsd(inputTokens + outputTokens, options.usdPerMillion),
    };
}

/* ------------------------------------------------------------------ fingerprints */

/** Source id → hash. */
export function sourceHashes(sources: readonly Pick<PrepareSource, 'id' | 'hash'>[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const item of sources) out[item.id] = item.hash;
    return out;
}

/** One hash of the card and its books (order-independent). */
export function fingerprintOf(hashes: Record<string, string>): string {
    const lines = Object.keys(hashes)
        .sort()
        .map((id) => `${id}=${hashes[id]}`);
    return stableHash(lines.join('\n'));
}

export interface SourceDiff {
    changed: string[];
    added: string[];
    removed: string[];
}

/** What changed between the saved hashes and the current ones. */
export function diffSources(before: Record<string, string>, after: Record<string, string>): SourceDiff {
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [id, hash] of Object.entries(after)) {
        if (!(id in before)) added.push(id);
        else if (before[id] !== hash) changed.push(id);
    }
    for (const id of Object.keys(before)) if (!(id in after)) removed.push(id);
    return { changed, added, removed };
}

/** True when nothing changed. */
export function sameSources(diff: SourceDiff): boolean {
    return !diff.changed.length && !diff.added.length && !diff.removed.length;
}
