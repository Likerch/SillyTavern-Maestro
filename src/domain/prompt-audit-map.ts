// M38 «Проверка промпта», pure parts of the capture (plan-2 §2 п. 1–2): the INSTRUCTION MAP of one assembled prompt —
// every text that reaches the model as an instruction, with its owner, role, place and the final message it landed
// in — built from what the feature read at CHAT_COMPLETION_PROMPT_READY (the outgoing messages, the extension prompt
// slots, the preset blocks with their conditionals resolved, the card's fields, the neighbours' prompt texts, the
// instruction-like lore entries). Lore as data, the chat history, memories and previous trackers stay out: only their
// roles and sizes are kept in the message skeleton. Size-capped so a chat document can hold it.
// Pure: no DOM, no SillyTavern.
import { messageTextParts, slotNeedles } from './architect-prompt';
import { slotOwner } from './lore-inspector';

/** Who an instruction belongs to (the report names them in plain words). */
export type AuditOwner =
    | 'preset'
    | 'card'
    | 'authorsNote'
    | 'des'
    | 'nai'
    | 'qvink'
    | 'desru'
    | 'ck'
    | 'bunnymo'
    | 'lore'
    | 'maestro'
    | 'other';

export type AuditRole = 'system' | 'user' | 'assistant';

/** Where an instruction goes: among the prompt blocks, before them, or into the chat history at a depth. */
export type AuditPlace = 'prompt' | 'before' | 'chat';

export interface AuditItem {
    /** Stable reference: `preset:<identifier>`, `card:system`, `slot:<key>`, `lore:<book>#<uid>`. */
    ref: string;
    owner: AuditOwner;
    /** Raw name: the block name, the slot key, the entry title (the view words it). */
    label: string;
    /** Preset block identifier, card field or slot key. */
    key?: string;
    /** Neighbour prompt ids (M36) whose text is inside this item. */
    neighbours?: string[];
    /** Maestro module that writes the item (its own injections). */
    module?: string;
    /** Lorebook of a lore entry. */
    book?: string;
    role: AuditRole;
    place: AuditPlace;
    depth?: number;
    /** Index of the final message that holds it; -1 when it was not found there. */
    message: number;
    /** The text (conditionals resolved, macros as written), capped. */
    text: string;
    /** Length of the whole text. */
    chars: number;
    /** The text was cut to fit the caps. */
    cut?: boolean;
    /** Dry run: the item was not in the test assembly and comes from the last real turn. */
    fromTurn?: boolean;
}

export interface AuditMessage {
    role: AuditRole | 'tool';
    chars: number;
    /** Items found in this message (none: chat history or data). */
    refs: string[];
}

export interface AuditConnection {
    source: string;
    model: string;
    /** Model quirks of domain/preset-analysis-hints.ts (systemMerge, prefillEos, assistantDepth). */
    quirks: string[];
}

export interface AuditCapture {
    v: 1;
    at: number;
    chatId: string | null;
    /** Generation type of the turn. */
    type: string;
    /** 'turn': a real generation; 'dry': a test assembly without sending. */
    source: 'turn' | 'dry';
    /** Reply the turn produced, when known. */
    messageIndex?: number;
    /** Preset (Chat Completion) the turn used. */
    preset?: string;
    connection?: AuditConnection | null;
    items: AuditItem[];
    messages: AuditMessage[];
    /** Messages of the prompt before the skeleton was cut (the skeleton keeps the last ones). */
    messageCount?: number;
}

/* ------------------------------------------------------------------ inputs */

export interface RawSlot {
    key: string;
    value: string;
    /** extension_prompt_types: -1 none, 0 in prompt, 1 in chat, 2 before prompt. */
    position: number;
    depth: number;
    /** 0 system, 1 user, 2 assistant. */
    role: number;
}

export interface RawBlock {
    identifier: string;
    name: string;
    role: AuditRole;
    inChat: boolean;
    depth: number;
    /** Conditionals resolved with the turn's flags, other macros as written. */
    text: string;
}

export interface RawCardField {
    field: 'system' | 'postHistory';
    text: string;
}

export interface RawNeighbour {
    id: string;
    /** The text as it goes out (the neighbour's own placeholders filled). */
    text: string;
    /** Slot key the neighbour writes, when known. */
    slot?: string;
}

export interface RawLore {
    world: string;
    uid: number;
    comment: string;
    content: string;
    bunnymo: boolean;
    /** world_info_position. */
    position: number;
    depth?: number;
    role?: number;
}

export interface CaptureInput {
    at: number;
    chatId: string | null;
    type: string;
    source: 'turn' | 'dry';
    messageIndex?: number;
    preset?: string;
    connection?: AuditConnection | null;
    messages: readonly unknown[];
    slots: readonly RawSlot[];
    blocks: readonly RawBlock[];
    card: readonly RawCardField[];
    neighbours: readonly RawNeighbour[];
    lore: readonly RawLore[];
    /** ST's macro substitution (to find texts with macros in the messages). */
    substitute?: (text: string) => string;
}

/* ------------------------------------------------------------------ caps */

export const CAPS = {
    /** One item's text. */
    item: 4000,
    /** Every item's text together. */
    total: 60_000,
    /** A lore entry's text. */
    lore: 1500,
    /** Instruction-like lore entries kept. */
    loreEntries: 10,
    /** Slots of unknown extensions and memory headers. */
    other: 1500,
    /** Message skeleton entries. */
    messages: 600,
    /** No item text is cut below this when the total is over. */
    floor: 600,
} as const;

/* ------------------------------------------------------------------ owners */

/** Maestro's own injections (core/ephemeral: slot `maestro_<key>`) by the module that writes them. */
export const MAESTRO_SLOTS: Readonly<Record<string, string>> = {
    maestro_director: 'director',
    maestro_voices: 'voices',
    maestro_mechanics: 'mechanics',
    maestro_mechanics_facts: 'mechanics',
    maestro_wardrobe: 'wardrobe',
    maestro_offscreen: 'offscreen',
    maestro_chronicle_recap: 'chronicle',
    'maestro_messageStyle.hint': 'messageStyle',
    maestro_quality_fix: 'quality',
};

/** The module of a Maestro slot: the table, else the word after `maestro_`. */
export function maestroModuleOf(key: string): string {
    const known = MAESTRO_SLOTS[key];
    if (known) return known;
    const rest = key.replace(/^maestro_/, '');
    return rest.split(/[._]/)[0] || rest;
}

/** Slots whose text is data, not an instruction (memories, previous trackers, vectors, the persona). */
const DATA_SLOTS: readonly RegExp[] = [
    /^dooms[-_]tracker[-_]example$/i,
    /^1_memory$/,
    /^3_vectors$/,
    /^4_vectors_data_bank$/,
    /^chromadb$/,
    /^PERSONA_DESCRIPTION/,
    /^customWIOutlet_/,
    /^customDepthWI/,
];

/** Neighbour slots whose text is mostly data with a short instruction (cut harder). */
const DATA_HEAVY = new Set<AuditOwner>(['qvink', 'other']);

export function isDataSlot(key: string): boolean {
    return DATA_SLOTS.some((pattern) => pattern.test(key));
}

/** Owner of an extension prompt slot. */
export function auditOwnerOfSlot(key: string): AuditOwner | null {
    if (isDataSlot(key)) return null;
    const owner = slotOwner(key);
    switch (owner) {
        case 'des':
        case 'ck':
        case 'qvink':
        case 'nai':
        case 'desru':
        case 'maestro':
        case 'authorsNote':
        case 'other':
            return owner;
        case 'card':
            return 'card';
        default:
            return null;
    }
}

function roleOf(value: unknown): AuditRole {
    const role = Number(value);
    return role === 1 ? 'user' : role === 2 ? 'assistant' : 'system';
}

/** SLOT_POSITION → place (in chat at a depth, before the prompt, among the prompt blocks). */
function placeOfSlot(position: number): AuditPlace | null {
    if (position === 1) return 'chat';
    if (position === 2) return 'before';
    if (position === 0) return 'prompt';
    return null;
}

/* ------------------------------------------------------------------ instruction-like lore */

/** Titles of lore entries that instruct the model instead of describing the world (BunnyMo core, filters, styles). */
const INSTRUCTION_TITLE =
    /AUTO-FILTRATION|AUTO-TRIGGER|Master - |ANTI[\s-]*CLANKER|linguistic|ozone|filter|instruction|guideline|\brules?\b|writing style|prose|narrat|\bOOC\b|system note|правил|инструкц|стиль|фильтр|повествован/i;
const INSTRUCTION_START =
    /^\s*[[<(]?\s*(?:OOC|System|Instruction|Rules?|Note to (?:the )?(?:AI|model)|Системн|Инструкц|Правил)/i;

export interface LoreLike {
    comment: string;
    content: string;
    /** M1 tag 'bunnymo.core' or the book role 'bunnymo.core'. */
    bunnymoCore?: boolean;
}

/** A lore entry that is an instruction (the audit reads it), not world data (the audit leaves it out). */
export function isInstructionLore(entry: LoreLike): boolean {
    if (entry.bunnymoCore) return true;
    if (INSTRUCTION_TITLE.test(entry.comment)) return true;
    return INSTRUCTION_START.test(entry.content);
}

/* ------------------------------------------------------------------ finding texts in the messages */

/** A distinctive line of a text (to find it when ST changed the whitespace around it). */
function distinctiveLine(text: string): string | null {
    let best: string | null = null;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length < 24 || trimmed.includes('{{')) continue;
        if (!best || trimmed.length > best.length) best = trimmed;
        if (trimmed.length >= 80) break;
    }
    return best ? best.slice(0, 160) : null;
}

/** Forms of a text worth looking for in the outgoing messages, most exact first. */
export function textNeedlesOf(text: string, substitute?: (text: string) => string): string[] {
    const needles = slotNeedles(text, substitute).filter((needle) => needle.trim().length >= 8);
    const substituted = needles[needles.length - 1] ?? text;
    for (const source of [substituted, text]) {
        const line = distinctiveLine(source);
        if (line && !needles.includes(line)) needles.push(line);
    }
    return needles;
}

/** Index of the first message (from `from`) holding one of the needles, -1 when none does. */
export function messageOf(texts: readonly string[], needles: readonly string[]): number {
    for (const needle of needles) {
        if (!needle) continue;
        const index = texts.findIndex((text) => text.includes(needle));
        if (index >= 0) return index;
    }
    return -1;
}

/* ------------------------------------------------------------------ building */

function messageRole(message: unknown): AuditMessage['role'] {
    const role = typeof message === 'object' && message !== null ? (message as { role?: unknown }).role : undefined;
    return role === 'user' || role === 'assistant' || role === 'tool' ? role : 'system';
}

function cutText(text: string, max: number): { text: string; cut: boolean } {
    return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

function item(base: Omit<AuditItem, 'text' | 'chars' | 'cut'>, text: string, max: number = CAPS.item): AuditItem {
    const capped = cutText(text, max);
    const result: AuditItem = { ...base, text: capped.text, chars: text.length };
    if (capped.cut) result.cut = true;
    return result;
}

/** Neighbour ids whose outgoing text is inside a slot value. */
function neighboursIn(value: string, neighbours: readonly RawNeighbour[], key: string): string[] {
    const ids: string[] = [];
    for (const neighbour of neighbours) {
        if (neighbour.slot && neighbour.slot === key) {
            ids.push(neighbour.id);
            continue;
        }
        const text = neighbour.text.trim();
        if (text.length < 12) continue;
        const line = distinctiveLine(text);
        if (value.includes(text) || (line && value.includes(line))) ids.push(neighbour.id);
    }
    return ids;
}

/** Card fields replace the preset's main / post-history blocks (ST prefers the card's prompts). */
const CARD_REPLACES: Record<RawCardField['field'], string> = { system: 'main', postHistory: 'jailbreak' };

/**
 * The instruction map of one assembled prompt. Items are located in the final messages; a message without items is
 * chat history (or data) and keeps only its role and size.
 */
export function buildCapture(input: CaptureInput): AuditCapture {
    const texts = input.messages.map((message) => messageTextParts(message).join('\n'));
    const items: AuditItem[] = [];
    const locate = (text: string): number => messageOf(texts, textNeedlesOf(text, input.substitute));

    /* card fields: they replace the preset's main / jailbreak blocks unless they include {{original}} */
    const replaced = new Set<string>();
    for (const field of input.card) {
        const text = field.text.trim();
        if (!text) continue;
        if (!/\{\{original\}\}/i.test(text)) replaced.add(CARD_REPLACES[field.field]);
        items.push(
            item(
                {
                    ref: `card:${field.field}`,
                    owner: 'card',
                    label: field.field,
                    key: field.field,
                    role: 'system',
                    place: 'prompt',
                    message: locate(text.replace(/\{\{original\}\}/gi, '').trim() || text),
                },
                text,
            ),
        );
    }

    /* preset blocks (the working copy: layers applied, conditionals resolved) */
    for (const block of input.blocks) {
        const text = block.text;
        if (!text.trim() || replaced.has(block.identifier)) continue;
        const entry: Omit<AuditItem, 'text' | 'chars' | 'cut'> = {
            ref: `preset:${block.identifier}`,
            owner: 'preset',
            label: block.name || block.identifier,
            key: block.identifier,
            role: block.role,
            place: block.inChat ? 'chat' : 'prompt',
            message: locate(text),
        };
        if (block.inChat) entry.depth = block.depth;
        items.push(item(entry, text));
    }

    /* extension prompt slots: neighbours, Maestro, the author's note, the card's depth note */
    for (const slot of input.slots) {
        const value = slot.value;
        if (!value || !value.trim()) continue;
        const owner = auditOwnerOfSlot(slot.key);
        const place = placeOfSlot(slot.position);
        if (!owner || !place) continue;
        const entry: Omit<AuditItem, 'text' | 'chars' | 'cut'> = {
            ref: owner === 'card' ? 'card:depth' : `slot:${slot.key}`,
            owner,
            label: slot.key,
            key: slot.key,
            role: roleOf(slot.role),
            place,
            message: locate(value),
        };
        if (place === 'chat') entry.depth = Math.max(0, Math.floor(Number(slot.depth) || 0));
        if (owner === 'maestro') entry.module = maestroModuleOf(slot.key);
        const neighbours = neighboursIn(value, input.neighbours, slot.key);
        if (neighbours.length) entry.neighbours = neighbours;
        let text = value;
        // Qvink's slot holds the memories themselves: its own headers are the instruction.
        if (owner === 'qvink') {
            const headers = input.neighbours.filter((neighbour) => neighbours.includes(neighbour.id));
            if (headers.length) text = headers.map((neighbour) => neighbour.text).join('\n');
        }
        items.push(item(entry, text, DATA_HEAVY.has(owner) ? CAPS.other : CAPS.item));
    }

    /* neighbour texts not found in any slot (sent some other way): located in the messages when possible */
    const linked = new Set(items.flatMap((entry) => entry.neighbours ?? []));
    for (const neighbour of input.neighbours) {
        if (linked.has(neighbour.id) || neighbour.slot) continue;
        const text = neighbour.text.trim();
        if (text.length < 12) continue;
        const message = locate(text);
        if (message < 0) continue;
        const owner = neighbour.id.split('.')[0] as AuditOwner;
        const known: AuditOwner[] = ['des', 'nai', 'qvink', 'desru', 'ck'];
        items.push(
            item(
                {
                    ref: `neighbour:${neighbour.id}`,
                    owner: known.includes(owner) ? owner : 'other',
                    label: neighbour.id,
                    key: neighbour.id,
                    neighbours: [neighbour.id],
                    role: messageRole(input.messages[message]) === 'user' ? 'user' : 'system',
                    place: 'prompt',
                    message,
                },
                text,
            ),
        );
    }

    /* instruction-like lore entries (BunnyMo core and filters, style rules) */
    let loreCount = 0;
    for (const entry of input.lore) {
        if (loreCount >= CAPS.loreEntries) break;
        const text = entry.content.trim();
        if (!text) continue;
        loreCount++;
        const inChat = entry.position === 4;
        const base: Omit<AuditItem, 'text' | 'chars' | 'cut'> = {
            ref: `lore:${entry.world}#${entry.uid}`,
            owner: entry.bunnymo ? 'bunnymo' : 'lore',
            label: entry.comment || `#${entry.uid}`,
            key: String(entry.uid),
            book: entry.world,
            role: inChat ? roleOf(entry.role) : 'system',
            place: inChat ? 'chat' : 'prompt',
            message: locate(text),
        };
        if (inChat) base.depth = Math.max(0, Math.floor(Number(entry.depth) || 0));
        items.push(item(base, text, CAPS.lore));
    }

    /* the message skeleton */
    const byMessage = new Map<number, string[]>();
    for (const entry of items) {
        if (entry.message < 0) continue;
        const list = byMessage.get(entry.message) ?? [];
        list.push(entry.ref);
        byMessage.set(entry.message, list);
    }
    let messages: AuditMessage[] = input.messages.map((message, index) => ({
        role: messageRole(message),
        chars: texts[index]?.length ?? 0,
        refs: byMessage.get(index) ?? [],
    }));
    const capture: AuditCapture = {
        v: 1,
        at: input.at,
        chatId: input.chatId,
        type: input.type,
        source: input.source,
        items,
        messages,
    };
    if (messages.length > CAPS.messages) {
        // Keep the last messages: the tail is where in-chat instructions and their risks are.
        const drop = messages.length - CAPS.messages;
        capture.messageCount = messages.length;
        messages = messages.slice(drop);
        capture.messages = messages;
        for (const entry of items) entry.message = entry.message >= drop ? entry.message - drop : -1;
    }
    if (input.messageIndex !== undefined) capture.messageIndex = input.messageIndex;
    if (input.preset) capture.preset = input.preset;
    if (input.connection !== undefined) capture.connection = input.connection;
    return capCapture(capture);
}

/** Cuts the longest texts until every item's text together fits `CAPS.total`. */
export function capCapture(capture: AuditCapture, total: number = CAPS.total): AuditCapture {
    const size = () => capture.items.reduce((sum, entry) => sum + entry.text.length, 0);
    let guard = 0;
    while (size() > total && guard++ < 200) {
        const longest = capture.items.reduce<AuditItem | null>(
            (best, entry) => (!best || entry.text.length > best.text.length ? entry : best),
            null,
        );
        if (!longest || longest.text.length <= CAPS.floor) break;
        longest.text = longest.text.slice(0, Math.max(CAPS.floor, Math.floor(longest.text.length / 2)));
        longest.cut = true;
    }
    return capture;
}

/* ------------------------------------------------------------------ storage */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const OWNERS: readonly AuditOwner[] = [
    'preset',
    'card',
    'authorsNote',
    'des',
    'nai',
    'qvink',
    'desru',
    'ck',
    'bunnymo',
    'lore',
    'maestro',
    'other',
];
const ROLES: readonly AuditRole[] = ['system', 'user', 'assistant'];
const PLACES: readonly AuditPlace[] = ['prompt', 'before', 'chat'];

function sanitizeItem(raw: unknown): AuditItem | null {
    if (!isDict(raw) || typeof raw.ref !== 'string' || !raw.ref || typeof raw.text !== 'string') return null;
    const owner = OWNERS.includes(raw.owner as AuditOwner) ? (raw.owner as AuditOwner) : 'other';
    const result: AuditItem = {
        ref: raw.ref,
        owner,
        label: typeof raw.label === 'string' ? raw.label : raw.ref,
        role: ROLES.includes(raw.role as AuditRole) ? (raw.role as AuditRole) : 'system',
        place: PLACES.includes(raw.place as AuditPlace) ? (raw.place as AuditPlace) : 'prompt',
        message: Number.isInteger(raw.message) ? (raw.message as number) : -1,
        text: raw.text.slice(0, CAPS.item),
        chars: Number.isFinite(raw.chars) ? (raw.chars as number) : raw.text.length,
    };
    if (typeof raw.key === 'string') result.key = raw.key;
    if (Array.isArray(raw.neighbours)) {
        const ids = raw.neighbours.filter((id): id is string => typeof id === 'string');
        if (ids.length) result.neighbours = ids;
    }
    if (typeof raw.module === 'string') result.module = raw.module;
    if (typeof raw.book === 'string') result.book = raw.book;
    if (Number.isFinite(raw.depth)) result.depth = raw.depth as number;
    if (raw.cut === true) result.cut = true;
    if (raw.fromTurn === true) result.fromTurn = true;
    return result;
}

/** A capture read back from a chat document (hand edits and older versions never break the audit). */
export function sanitizeCapture(raw: unknown): AuditCapture | null {
    if (!isDict(raw) || raw.v !== 1 || !Array.isArray(raw.items) || !Array.isArray(raw.messages)) return null;
    const items = raw.items.map(sanitizeItem).filter((entry): entry is AuditItem => entry !== null);
    const messages: AuditMessage[] = raw.messages
        .filter(isDict)
        .slice(-CAPS.messages)
        .map((message) => ({
            role:
                message.role === 'user' || message.role === 'assistant' || message.role === 'tool'
                    ? message.role
                    : 'system',
            chars: Number.isFinite(message.chars) ? (message.chars as number) : 0,
            refs: Array.isArray(message.refs)
                ? message.refs.filter((ref): ref is string => typeof ref === 'string')
                : [],
        }));
    const capture: AuditCapture = {
        v: 1,
        at: Number.isFinite(raw.at) ? (raw.at as number) : 0,
        chatId: typeof raw.chatId === 'string' ? raw.chatId : null,
        type: typeof raw.type === 'string' ? raw.type : 'normal',
        source: raw.source === 'dry' ? 'dry' : 'turn',
        items,
        messages,
    };
    if (Number.isInteger(raw.messageIndex)) capture.messageIndex = raw.messageIndex as number;
    if (typeof raw.preset === 'string') capture.preset = raw.preset;
    if (Number.isInteger(raw.messageCount)) capture.messageCount = raw.messageCount as number;
    if (isDict(raw.connection) && typeof raw.connection.source === 'string') {
        capture.connection = {
            source: raw.connection.source,
            model: typeof raw.connection.model === 'string' ? raw.connection.model : '',
            quirks: Array.isArray(raw.connection.quirks)
                ? raw.connection.quirks.filter((quirk): quirk is string => typeof quirk === 'string')
                : [],
        };
    }
    return capCapture(capture);
}

/* ------------------------------------------------------------------ dry run merge */

/**
 * A dry run skips the generation interceptors, so the injections made there (Maestro's own, NAI Studio's markers,
 * CarrotKernel's data) are missing: the slots of the last real turn that the dry run lacks are added, marked.
 */
export function mergeFromTurn(dry: AuditCapture, turn: AuditCapture | null): AuditCapture {
    if (!turn) return dry;
    const have = new Set(dry.items.map((entry) => entry.ref));
    for (const entry of turn.items) {
        if (have.has(entry.ref) || !entry.ref.startsWith('slot:')) continue;
        dry.items.push({ ...entry, message: -1, fromTurn: true });
    }
    return capCapture(dry);
}

/** Every item's text, by ref. */
export function itemsByRef(capture: AuditCapture): Map<string, AuditItem> {
    return new Map(capture.items.map((entry) => [entry.ref, entry]));
}
