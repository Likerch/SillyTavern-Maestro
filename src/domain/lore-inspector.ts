// M2 «Инспектор хода», pure parts. ST glues injections of the same depth and role into one message and DES writes
// its history into the messages themselves, so the weight of each source is RECONSTRUCTED (audit T15): Prompt
// Manager token counts by identifier, extension prompt slots, the activated lore of M1 and the preset prompts that
// are injected into the chat; the chat history is what remains of the `chatHistory` block.

/** Who owns an extension prompt slot (`extension_prompts` key). */
export type SlotOwner =
    | 'des'
    | 'ck'
    | 'qvink'
    | 'nai'
    | 'desru'
    | 'maestro'
    | 'dramatis'
    | 'wiOutlet'
    | 'wiDepth'
    | 'summary'
    | 'authorsNote'
    | 'card'
    | 'other';

const OWNER_PATTERNS: readonly [RegExp, SlotOwner][] = [
    [/^dooms[-_]/i, 'des'],
    [/^(?:carrot|script_inject_carrot)/i, 'ck'],
    [/^qvink_memory/i, 'qvink'],
    [/^nai_studio/i, 'nai'],
    [/^desru_/i, 'desru'],
    [/^maestro_/i, 'maestro'],
    // Dramatis's cast block (release 1.17).
    [/^dramatis_/i, 'dramatis'],
    [/^customWIOutlet_/, 'wiOutlet'],
    [/^customDepthWI/, 'wiDepth'],
    [/^1_memory$/, 'summary'],
    [/^2_floating_prompt$/, 'authorsNote'],
    // The character's depth note (also per group member) and the persona description slot.
    [/^(?:DEPTH_PROMPT|PERSONA_DESCRIPTION)/, 'card'],
];

export function slotOwner(key: string): SlotOwner {
    for (const [pattern, owner] of OWNER_PATTERNS) if (pattern.test(key)) return owner;
    return 'other';
}

/** Prompt Manager identifiers of the slots ST maps by name (openai.js:1388-1430); others use `key.replace(/\W/g,'_')`. */
const KNOWN_SLOT_IDENTIFIERS: Record<string, string> = {
    '1_memory': 'summary',
    '2_floating_prompt': 'authorsNote',
    '3_vectors': 'vectorsMemory',
    '4_vectors_data_bank': 'vectorsDataBank',
    chromadb: 'smartContext',
};

export function promptIdentifierOf(key: string): string {
    return KNOWN_SLOT_IDENTIFIERS[key] ?? key.replace(/\W/g, '_');
}

/** Card blocks of the Prompt Manager (markers filled from the character and persona). */
const CARD_IDENTIFIERS = new Set(['charDescription', 'charPersonality', 'scenario', 'personaDescription']);

/** extension_prompt_types (script.js:484-489). */
export const SLOT_POSITION = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 } as const;

/** world_info_position values of entries injected into blocks other than before/after. */
const WI_POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };

/* ------------------------------------------------------------------ messages */

/** Text of a Chat Completion message (string content or multimodal parts). */
export function messageText(message: unknown): string {
    if (typeof message !== 'object' || message === null) return '';
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) =>
            typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
        )
        .join('');
}

export function messageRole(message: unknown): string {
    if (typeof message !== 'object' || message === null) return 'system';
    const role = (message as { role?: unknown }).role;
    return typeof role === 'string' ? role : 'system';
}

export interface RoleChars {
    system: number;
    user: number;
    assistant: number;
    tool: number;
}

export function charsByRole(messages: readonly unknown[]): RoleChars {
    const chars: RoleChars = { system: 0, user: 0, assistant: 0, tool: 0 };
    for (const message of messages) {
        const role = messageRole(message);
        const length = messageText(message).length;
        if (role === 'user' || role === 'assistant' || role === 'tool') chars[role] += length;
        else chars.system += length;
    }
    return chars;
}

/* ------------------------------------------------------------------ reconstruction */

export type SourceKind = 'preset' | 'card' | 'lore' | 'extension' | 'history';

export interface InspectorSource {
    /** Stable across turns: `preset:main`, `lore:<book>`, `ext:des`, `history`. */
    id: string;
    kind: SourceKind;
    /** Extension slots: their owner. */
    owner?: SlotOwner;
    /** Raw name: preset prompt name, book name, card identifier (the view translates the rest). */
    name?: string;
    tokens: number;
}

export interface SlotMeasure {
    key: string;
    position: number;
    tokens: number;
}

export interface LoreMeasure {
    book: string;
    position: number;
    tokens: number;
}

export interface ReconstructInput {
    /** Prompt Manager counts by identifier (Chat Completion); null when unavailable. */
    counts: Record<string, number> | null;
    /** Preset prompt names by identifier. */
    presetNames?: Record<string, string>;
    slots: SlotMeasure[];
    /** Activated lore of the turn that reached the prompt (M1); null when M1 is off. */
    lore: LoreMeasure[] | null;
    /** Preset prompts injected into the chat at a depth (Prompt Manager "absolute" position). */
    absolute?: { identifier: string; name: string; tokens: number }[];
    /** Total tokens of the messages, used when `counts` is null. */
    messageTokens?: number;
}

export interface Reconstruction {
    total: number;
    /** Counted by the Prompt Manager (true) or estimated from our own counts (false). */
    exact: boolean;
    sources: InspectorSource[];
}

/**
 * Splits the prompt into sources. Slots with position NONE (outlets, `{{macro}}` reads) are left inside the block
 * that references them; depth lore lives in `customDepthWI_*` slots, so with M1 data it is shown per book.
 */
export function reconstructSources(input: ReconstructInput): Reconstruction {
    const sources = new Map<string, InspectorSource>();
    const add = (source: InspectorSource): void => {
        if (!(source.tokens > 0)) return;
        const existing = sources.get(source.id);
        if (existing) existing.tokens += source.tokens;
        else sources.set(source.id, { ...source });
    };
    const take = (id: string, tokens: number): void => {
        const source = sources.get(id);
        if (source) source.tokens = Math.max(0, source.tokens - tokens);
    };
    const names = input.presetNames ?? {};
    const inPromptSlots = new Map<string, SlotMeasure>();
    for (const slot of input.slots) {
        if (slot.position === SLOT_POSITION.IN_PROMPT || slot.position === SLOT_POSITION.BEFORE_PROMPT) {
            inPromptSlots.set(promptIdentifierOf(slot.key), slot);
        }
    }
    const extensionSource = (slot: SlotMeasure, tokens: number): InspectorSource => {
        const owner = slotOwner(slot.key);
        return owner === 'card'
            ? { id: `card:${slot.key}`, kind: 'card', name: slot.key, tokens }
            : { id: `ext:${owner}`, kind: 'extension', owner, tokens };
    };

    let total = 0;
    let history = 0;
    let worldInfo = 0;
    const exact = input.counts !== null;
    if (input.counts) {
        for (const [identifier, value] of Object.entries(input.counts)) {
            const tokens = Number(value);
            if (!Number.isFinite(tokens) || tokens <= 0) continue;
            total += tokens;
            if (identifier === 'chatHistory') history += tokens;
            else if (identifier === 'worldInfoBefore' || identifier === 'worldInfoAfter') worldInfo += tokens;
            else if (identifier === 'dialogueExamples' || CARD_IDENTIFIERS.has(identifier)) {
                add({ id: `card:${identifier}`, kind: 'card', name: identifier, tokens });
            } else {
                const slot = inPromptSlots.get(identifier);
                if (slot) {
                    add(extensionSource(slot, tokens));
                    inPromptSlots.delete(identifier);
                } else {
                    add({ id: `preset:${identifier}`, kind: 'preset', name: names[identifier] ?? identifier, tokens });
                }
            }
        }
    } else {
        total = Math.max(0, input.messageTokens ?? 0);
        history = total;
    }

    for (const slot of input.slots) {
        if (!(slot.tokens > 0)) continue;
        const owner = slotOwner(slot.key);
        if (slot.position === SLOT_POSITION.IN_CHAT) {
            history -= slot.tokens;
            if (owner === 'wiDepth') {
                if (input.lore === null) add({ id: 'lore:', kind: 'lore', tokens: slot.tokens });
            } else add(extensionSource(slot, slot.tokens));
        } else if (!exact && inPromptSlots.has(promptIdentifierOf(slot.key))) {
            // Without Prompt Manager counts every block is still inside the estimated total.
            history -= slot.tokens;
            add(extensionSource(slot, slot.tokens));
        }
    }

    for (const prompt of input.absolute ?? []) {
        if (!(prompt.tokens > 0)) continue;
        history -= prompt.tokens;
        add({
            id: `preset:${prompt.identifier}`,
            kind: 'preset',
            name: prompt.name || prompt.identifier,
            tokens: prompt.tokens,
        });
    }

    if (input.lore) {
        // Lore lives inside another block: take it out of that block (or, without counts, out of the estimate).
        const takeFrom = (id: string, tokens: number): void => {
            if (sources.has(id)) take(id, tokens);
            else if (!exact) history -= tokens;
        };
        for (const item of input.lore) {
            if (!(item.tokens > 0)) continue;
            add({ id: `lore:${item.book}`, kind: 'lore', name: item.book, tokens: item.tokens });
            switch (item.position) {
                case WI_POSITION.before:
                case WI_POSITION.after:
                    if (exact) worldInfo -= item.tokens;
                    else history -= item.tokens;
                    break;
                case WI_POSITION.ANTop:
                case WI_POSITION.ANBottom:
                    takeFrom('ext:authorsNote', item.tokens);
                    break;
                case WI_POSITION.EMTop:
                case WI_POSITION.EMBottom:
                    takeFrom('card:dialogueExamples', item.tokens);
                    break;
                case WI_POSITION.atDepth:
                    // Already taken out of the history through the customDepthWI_* slots.
                    break;
                default:
                    // Outlets end up wherever {{outlet::…}} is used; only the estimate can account for them.
                    if (!exact) history -= item.tokens;
            }
        }
        // What is left of the WI blocks is the `wi_format` wrapper and per-message overhead.
        if (worldInfo > 0)
            add({ id: 'preset:worldInfoFormat', kind: 'preset', name: 'worldInfoFormat', tokens: worldInfo });
    } else if (worldInfo > 0) {
        add({ id: 'lore:', kind: 'lore', tokens: worldInfo });
    }

    add({ id: 'history', kind: 'history', tokens: Math.max(0, history) });
    const list = [...sources.values()].filter((source) => source.tokens > 0);
    return { total, exact, sources: list };
}

/** Lore of a turn by book and placement (entries cut from the prompt are left out). */
export function loreMeasures(
    activations: readonly { world: string; position: number; tokens: number; cut?: boolean }[],
): LoreMeasure[] {
    const measures = new Map<string, LoreMeasure>();
    for (const row of activations) {
        if (row.cut) continue;
        const key = `${row.world}\u0000${row.position}`;
        const measure = measures.get(key) ?? { book: row.world, position: row.position, tokens: 0 };
        measure.tokens += row.tokens;
        measures.set(key, measure);
    }
    return [...measures.values()];
}

/** Adds a turn to a rolling list: the same message replaces its earlier turn; at most `keep` are kept. */
export function pushTurn<T extends { messageIndex: number }>(list: T[], record: T, keep: number): T[] {
    const next = list.filter((item) => item.messageIndex !== record.messageIndex);
    next.push(record);
    const limit = Math.max(1, Math.floor(keep));
    return next.length > limit ? next.slice(next.length - limit) : next;
}

/* ------------------------------------------------------------------ comparison */

export interface SourceComparison {
    source: InspectorSource;
    share: number;
    /** Tokens vs the previous turn (undefined: no previous turn). */
    deltaPrevious?: number;
    /** Tokens vs the average of the stored turns. */
    deltaAverage?: number;
}

export function compareSources(
    current: readonly InspectorSource[],
    previous: readonly InspectorSource[] | undefined,
    all: readonly (readonly InspectorSource[])[],
): SourceComparison[] {
    const total = current.reduce((sum, source) => sum + source.tokens, 0);
    const previousById = previous ? new Map(previous.map((source) => [source.id, source.tokens])) : null;
    const sums = new Map<string, number>();
    for (const turn of all) for (const source of turn) sums.set(source.id, (sums.get(source.id) ?? 0) + source.tokens);
    return [...current]
        .sort((a, b) => b.tokens - a.tokens)
        .map((source) => {
            const row: SourceComparison = { source, share: total ? source.tokens / total : 0 };
            if (previousById) row.deltaPrevious = source.tokens - (previousById.get(source.id) ?? 0);
            if (all.length) row.deltaAverage = Math.round(source.tokens - (sums.get(source.id) ?? 0) / all.length);
            return row;
        });
}

/** Bar segments: presets, card, lore, history, and each extension owner on its own. */
export function barGroups(sources: readonly InspectorSource[]): { group: string; tokens: number }[] {
    const groups = new Map<string, number>();
    for (const source of sources) {
        const group = source.kind === 'extension' ? (source.owner ?? 'other') : source.kind;
        groups.set(group, (groups.get(group) ?? 0) + source.tokens);
    }
    return [...groups].map(([group, tokens]) => ({ group, tokens })).sort((a, b) => b.tokens - a.tokens);
}

/* ------------------------------------------------------------------ repeated facts */

export interface SourceText {
    source: string;
    text: string;
}

export interface RepeatedFact {
    sentence: string;
    sources: string[];
}

const LIST_MARKER = /^(?:[-*•>]+|\d+[.)])\s+/;

export function splitSentences(text: string): string[] {
    return text
        .split(/(?<=[.!?…])\s+|\n+/)
        .map((part) => part.replace(LIST_MARKER, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/** Identical sentences of at least `minLength` characters found in two or more different sources. */
export function findRepeats(texts: readonly SourceText[], minLength = 60, limit = 20): RepeatedFact[] {
    const seen = new Map<string, { sentence: string; sources: Set<string> }>();
    for (const { source, text } of texts) {
        if (!text) continue;
        for (const sentence of splitSentences(text)) {
            if (sentence.length < minLength) continue;
            const key = sentence.toLowerCase();
            const item = seen.get(key) ?? { sentence, sources: new Set<string>() };
            item.sources.add(source);
            seen.set(key, item);
        }
    }
    return [...seen.values()]
        .filter((item) => item.sources.size >= 2)
        .sort((a, b) => b.sentence.length - a.sentence.length)
        .slice(0, limit)
        .map((item) => ({ sentence: item.sentence, sources: [...item.sources] }));
}

/* ------------------------------------------------------------------ export */

const SECRET_PATTERNS: readonly RegExp[] = [
    /\bsk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}/g,
    /\bpst-[A-Za-z0-9_-]{16,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

/** Replaces API-key-like strings (OpenAI/Anthropic/OpenRouter, NovelAI, bearer tokens, Google, GitHub, Slack). */
export function scrubSecrets(text: string): string {
    let result = text;
    for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, '[secret]');
    return result;
}

export interface ExportedMessage {
    role: string;
    chars: number;
    content?: string;
    redacted?: true;
}

/** Prompt messages for an export: secrets always scrubbed; with `redactChat`, user and assistant text dropped. */
export function exportMessages(messages: readonly unknown[], redactChat: boolean): ExportedMessage[] {
    return messages.map((message) => {
        const role = messageRole(message);
        const text = messageText(message);
        if (redactChat && (role === 'user' || role === 'assistant'))
            return { role, chars: text.length, redacted: true };
        return { role, chars: text.length, content: scrubSecrets(text) };
    });
}
