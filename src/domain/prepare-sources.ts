// «Подготовить к игре» (M37, plan-2 §7 п. 1–2): what the background model reads — the card's fields, every starting
// scene of the card (the first message and each alternate greeting, in full, a source each: `greeting:<n>`), the
// persona, and the entries of the card's books, the chat book, the DES campaign and the CarrotKernel archives of this
// story's characters — as numbered sources packed into parts that fit one request each. The card's own fields and the
// greeting the chat opened with always go into the first part; the other greetings follow (spread over as many parts as
// they need, never shortened or left out); book entries fill the parts after them; what does not fit the budget is left
// out and listed. Every source has a hash: the card's fingerprint for the character-level reuse is made of them (a
// changed greeting is read again on its own), and only changed sources are read again. Pure.
import { charsToTokens, bootstrapCostUsd } from './doctor-budget';
import { stableHash } from './hash';

/** Where a source comes from. */
export type SourceOrigin = 'card' | 'persona' | 'book' | 'chat' | 'campaign' | 'archive';

/** Card fields read as sources (the id is `card.<field>`). */
export const CARD_FIELDS = ['description', 'personality', 'scenario', 'examples', 'notes', 'system'] as const;

export type CardField = (typeof CARD_FIELDS)[number];

/** English labels of the card fields for the model. */
const CARD_FIELD_LABELS: Record<CardField, string> = {
    description: 'Card description',
    personality: 'Card personality',
    scenario: 'Scenario',
    examples: 'Dialogue examples',
    notes: "Creator's notes",
    system: 'System prompt, post-history instructions and depth prompt of the card',
};

/** Characters of each card field kept (the card is never cut much: it is the core of the story). */
const CARD_FIELD_CHARS: Record<CardField, number> = {
    description: 12000,
    personality: 3000,
    scenario: 4000,
    examples: 3000,
    notes: 2000,
    system: 3000,
};

const PERSONA_CHARS = 3000;
/** A starting scene is read in full: this only stops a runaway greeting (a part of its own holds one this long). */
export const GREETING_CHARS = 20000;
/** Characters of a greeting's first words in the review («Сцена 2 · «Утро в гавани…»»). */
const OPENING_CHARS = 60;

export interface PrepareSource {
    /** `card.<field>`, `greeting:<n>`, `persona`, `book:<book>#<uid>`. */
    id: string;
    origin: SourceOrigin;
    /** English label for the model («Card description», «World · Harbour»). */
    label: string;
    /** Card field of a card source (the feature translates it for the user). */
    field?: CardField;
    /** Starting scene of a greeting source: 0 the first message, n alternate greeting n. */
    greeting?: number;
    book?: string;
    uid?: number;
    /** Entry title of a book source. */
    title?: string;
    text: string;
    /** Hash of the text (reuse: a changed source is read again). */
    hash: string;
    /** Card fields, the persona and the greeting the chat opened with: always in the first part. */
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

/** Id of the source of a starting scene. */
export function greetingSourceId(greeting: number): string {
    return `greeting:${greeting}`;
}

/** The greeting number of a source id (`greeting:2` → 2), null for other sources. */
export function greetingOfSource(id: string): number | null {
    const match = /^greeting:(\d+)$/.exec(id);
    return match ? Number(match[1]) : null;
}

/** English label of a starting scene for the model: its number is what the answer's `scenes[].greeting` names. */
export function greetingLabel(greeting: number, shown: boolean): string {
    const which = greeting === 0 ? 'the first message' : `alternate greeting ${greeting}`;
    return `Starting scene — greeting ${greeting} (${which}${shown ? ', the one this chat opened with' : ''})`;
}

/** The first words of a greeting for the player ({{user}} and {{char}} named, clipped at a word). */
export function greetingOpening(text: string, names: { user: string; char: string }): string {
    const value = text
        .replace(/\{\{user\}\}/gi, names.user.trim() || '…')
        .replace(/\{\{char\}\}/gi, names.char.trim() || '…')
        .replace(/\s+/g, ' ')
        .trim();
    return clipText(value, OPENING_CHARS);
}

/**
 * Sources of the card itself and of the persona: the fields (core), the greeting the chat opened with in full (core),
 * the persona (core), then every other greeting in full (not core: they follow in the next parts when the first one is
 * full). Empty fields and greetings are left out.
 */
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
    const greetings = [card.firstMessage, ...card.alternateGreetings];
    const requested = Math.max(0, Math.floor(card.greeting));
    const shown = requested < greetings.length ? requested : 0;
    const greeting = (index: number, core: boolean): PrepareSource | null => {
        const value = clipText(greetings[index] ?? '', GREETING_CHARS);
        if (!value) return null;
        return source({
            id: greetingSourceId(index),
            origin: 'card',
            label: greetingLabel(index, index === shown),
            greeting: index,
            text: value,
            core,
        });
    };
    add('description', card.description);
    add('personality', card.personality);
    add('scenario', card.scenario);
    const opened = greeting(shown, true);
    if (opened) out.push(opened);
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
    greetings.forEach((_text, index) => {
        if (index === shown) return;
        const other = greeting(index, false);
        if (other) out.push(other);
    });
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
    /** Holds starting scenes (greetings) of the card. */
    greetings: boolean;
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
 * Packs sources into parts: every core source into the first part; then the other starting scenes (greetings) after it,
 * a new part when the current one would grow past `chunkChars` — they are the card, so they are never left out, even
 * past `maxChunks`; then the book entries in order the same way, skipped after the last allowed part. A text seen
 * already (same hash) is read once.
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
    const isGreeting = (item: PrepareSource) => typeof item.greeting === 'number';
    const core = fresh.filter((item) => item.core);
    if (core.length) {
        chunks.push({
            index: 0,
            sourceIds: core.map((item) => item.id),
            chars: core.reduce((sum, item) => sum + sourceChars(item), 0),
            core: true,
            greetings: core.some(isGreeting),
        });
    }
    const place = (item: PrepareSource, mandatory: boolean): void => {
        const size = sourceChars(item);
        let current = chunks[chunks.length - 1];
        if (!current || (current.chars + size > budget && current.sourceIds.length)) {
            if (!mandatory && chunks.length >= maxChunks) {
                skipped.push(item.id);
                return;
            }
            current = { index: chunks.length, sourceIds: [], chars: 0, core: false, greetings: false };
            chunks.push(current);
        }
        current.sourceIds.push(item.id);
        current.chars += size;
        if (isGreeting(item)) current.greetings = true;
    };
    for (const item of fresh.filter((candidate) => !candidate.core && isGreeting(candidate))) place(item, true);
    for (const item of fresh.filter((candidate) => !candidate.core && !isGreeting(candidate))) place(item, false);
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
