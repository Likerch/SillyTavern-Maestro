// Prompt map of the Preset Studio (M34 п.1, stage 5), pure part: ST 1.19's Chat Completion assembly order for a
// preset body, reconstructed without generating (research/parity-preset.md §5.1 P-097…P-120; ST sources:
// PromptManager.js getPromptCollection/shouldTrigger, openai.js preparePromptsForChatCompletion,
// populateChatCompletion, populationInjectionPrompts, script.js getExtensionPrompt).
//
// What decides whether an enabled block is really sent (§10.2 п.4, P-039, P-044…P-047, P-118, P-130):
// - a relative block is added only by name (main, nsfw, jailbreak, enhanceDefinitions, the markers) or when
//   `system_prompt === false` (strict); anything else is silently left out;
// - "in chat" means `injection_position === 1` (strict number): the string "1" makes a relative block;
// - an in-chat block needs an integer depth 0…10000 (`injection_depth === i`), a role of exactly system/user/assistant
//   and non-empty text; in-chat blocks and in-chat extension prompts live inside the history, so without the
//   chatHistory block (disabled, missing, wrong trigger) none of them is sent;
// - triggers: an empty or non-array list fits every type; `main` with a wrong trigger becomes an empty anchor (its
//   before/after-main extension prompts still land); an external marker whose trigger does not fit, or that is not
//   in the list at all, is appended at the END of the prompt, after the history (P-118, derived);
// - in-chat order: deeper first; at one depth the smaller order is higher and, at equal order, assistant → user →
//   system; blocks of the same depth, order and role are glued into one message, and extension prompts of that depth
//   and role join only the order-100 group (P-102, P-103).
import { slotOwner } from './lore-inspector';
import type { SlotOwner } from './lore-inspector';

export type PromptRole = 'system' | 'user' | 'assistant';

/** Generation types a block trigger may name (constants.js:36-43). */
export const GENERATION_TYPES: readonly string[] = [
    'normal',
    'continue',
    'impersonate',
    'swipe',
    'regenerate',
    'quiet',
];

/** Markers ST fills by name and moves to the end when they are not in the list or their trigger does not fit. */
export const EXTERNAL_MARKERS: readonly string[] = [
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
];

/** All eight markers (PM:301-310): their text comes from ST, not from the block. */
export const MARKERS: ReadonlySet<string> = new Set([...EXTERNAL_MARKERS, 'dialogueExamples', 'chatHistory']);

/** System blocks ST adds by name whatever their `system_prompt` (OAI:1213-1258). */
const BY_NAME: ReadonlySet<string> = new Set(['main', 'nsfw', 'jailbreak', 'enhanceDefinitions']);

export const MAX_INJECTION_DEPTH = 10000;
export const DEFAULT_INJECTION_ORDER = 100;
/** PromptManager INJECTION_POSITION.ABSOLUTE. */
const ABSOLUTE = 1;
/** extension_prompt_types (script.js:484-489). */
const EXT_IN_PROMPT = 0;
const EXT_IN_CHAT = 1;
const EXT_BEFORE_PROMPT = 2;
/** Extension prompt keys ST never adds before/after main (OAI:1446-1455). */
const NOT_RELATIVE_KEYS: ReadonlySet<string> = new Set(['PERSONA_DESCRIPTION', 'QUIET_PROMPT', 'DEPTH_PROMPT']);
/** Dummy character id of the global prompt order (Chat Completion, P-034). */
export const GLOBAL_ORDER_ID = 100001;

const ROLES: readonly PromptRole[] = ['system', 'user', 'assistant'];
/** Position inside one depth: assistant, user, system (populationInjectionPrompts, reversed). */
const ROLE_RANK: Record<PromptRole, number> = { assistant: 0, user: 1, system: 2 };

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ types */

export interface AssemblyOrderItem {
    identifier: string;
    /** As stored: ST only checks it for truthiness. */
    enabled: unknown;
}

/** One `extension_prompts` slot (setExtensionPrompt). */
export interface ExtensionSlot {
    key: string;
    value: string;
    position: number;
    depth: number;
    role: number;
}

/** Why an enabled block is not sent. */
export type DropCode =
    | 'missing'
    | 'systemPrompt'
    | 'trigger'
    | 'triggerInvalid'
    | 'empty'
    | 'depthType'
    | 'depthRange'
    | 'role'
    | 'noHistory'
    | 'unknownMarker';

/** Remarks that do not drop the block. */
export type NoteCode = 'movedToEnd' | 'notInList' | 'positionString' | 'merged' | 'mainAnchor' | 'cardOverride';

/** Values whose type ST compares strictly or ignores. */
export type TypeIssueCode =
    'systemPrompt' | 'position' | 'depth' | 'role' | 'order' | 'trigger' | 'triggerValues' | 'enabled';

export interface TypeIssue {
    code: TypeIssueCode;
    /** The stored value, printable. */
    value: string;
}

export interface AssembledInjection {
    key: string;
    owner: SlotOwner;
    text: string;
    /** Inside main (start = before its text, end = after it) or in the chat history at a depth. */
    where: 'start' | 'end' | 'chat';
    depth?: number;
    role?: PromptRole;
}

export interface AssembledSlot {
    identifier: string;
    name: string;
    role: PromptRole;
    placement: 'relative' | 'depth';
    depth?: number;
    order?: number;
    enabled: boolean;
    marker: boolean;
    /** The block's own text ('' for markers: ST fills them). */
    content: string;
    /** Reaches the prompt of this generation type (a marker may still turn out empty). */
    sent: boolean;
    dropped?: DropCode;
    notes: NoteCode[];
    /** Other blocks glued into the same in-chat message (P-103). */
    mergedWith?: string[];
    injections: AssembledInjection[];
    typeIssues: TypeIssue[];
    /** The trigger list as stored, when it is a non-empty array. */
    triggers?: string[];
}

export interface Assembly {
    type: string;
    /** Prompt order: relative blocks, the in-chat blocks right after chatHistory, then what ST appends at the end. */
    slots: AssembledSlot[];
    /** The chat history (and with it every in-chat block and injection) is part of the prompt. */
    history: boolean;
    /** Extension prompts that reach no place (no main for before/after-main ones, no history for in-chat ones). */
    lost: AssembledInjection[];
}

export interface AssemblyInput {
    /** `prompts[]` of the preset body. */
    prompts: unknown;
    /** The active order (see resolveOrder). */
    order: readonly AssemblyOrderItem[];
    /** Generation type (default 'normal'). */
    type?: string;
    /** Extension prompts of the current chat (`extension_prompts`). */
    slots?: readonly ExtensionSlot[];
    /** External markers that carry text in this chat: a marker missing from the list is appended only then. */
    markersWithText?: ReadonlySet<string>;
    /** Blocks the character card replaces (main / jailbreak, P-049). */
    overridden?: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ helpers */

/** ST lower-cases and trims the generation type; empty means 'normal' (PM:1517). */
export function normalizeGenerationType(type: unknown): string {
    const value = String(type ?? '')
        .toLowerCase()
        .trim();
    return value || 'normal';
}

/** PromptManager.shouldTrigger: no list or an empty one fits every type. */
export function shouldTrigger(prompt: Dict, type: string): boolean {
    const trigger = prompt.injection_trigger;
    if (!Array.isArray(trigger) || !trigger.length) return true;
    return trigger.includes(type);
}

/**
 * The order ST uses: the global list (character 100001) of Chat Completion; a body without it falls back to its
 * first list (P-034). `enabled` is kept as stored.
 */
export function resolveOrder(promptOrder: unknown): AssemblyOrderItem[] {
    if (!Array.isArray(promptOrder)) return [];
    const lists = promptOrder.filter(isDict);
    const chosen = lists.find((item) => String(item.character_id) === String(GLOBAL_ORDER_ID)) ?? lists[0];
    const order = chosen && Array.isArray(chosen.order) ? chosen.order : [];
    return order
        .filter(isDict)
        .filter((item): item is Dict & { identifier: string } => typeof item.identifier === 'string')
        .map((item) => ({ identifier: item.identifier, enabled: item.enabled }));
}

/** `prompts[]` by identifier, first one wins (PM getPromptById uses find). */
export function promptsById(prompts: unknown): Map<string, Dict> {
    const result = new Map<string, Dict>();
    if (!Array.isArray(prompts)) return result;
    for (const prompt of prompts) {
        if (isDict(prompt) && typeof prompt.identifier === 'string' && !result.has(prompt.identifier)) {
            result.set(prompt.identifier, prompt);
        }
    }
    return result;
}

function isRole(value: unknown): value is PromptRole {
    return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** extension_prompt_roles → role name; anything else is system (getPromptRole). */
export function extensionRole(role: unknown): PromptRole {
    return role === 1 ? 'user' : role === 2 ? 'assistant' : 'system';
}

function printable(value: unknown): string {
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return JSON.stringify(value);
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function textOf(prompt: Dict): string {
    return typeof prompt.content === 'string' ? prompt.content : '';
}

function nameOf(prompt: Dict | undefined, identifier: string): string {
    return prompt && typeof prompt.name === 'string' && prompt.name ? prompt.name : identifier;
}

function validDepth(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_INJECTION_DEPTH;
}

/** `injection_order ?? 100` as ST groups it (object keys compared numerically). */
function orderOf(prompt: Dict): number {
    const raw = prompt.injection_order ?? DEFAULT_INJECTION_ORDER;
    const value = Number(raw);
    return Number.isFinite(value) ? value : DEFAULT_INJECTION_ORDER;
}

function typeIssues(prompt: Dict, item: AssemblyOrderItem, identifier: string, absolute: boolean): TypeIssue[] {
    const issues: TypeIssue[] = [];
    const marker = MARKERS.has(identifier);
    if (typeof item.enabled !== 'boolean') issues.push({ code: 'enabled', value: printable(item.enabled) });
    const position = prompt.injection_position;
    if (position !== undefined && position !== 0 && position !== 1) {
        issues.push({ code: 'position', value: printable(position) });
    }
    if (!marker && !BY_NAME.has(identifier) && !absolute && prompt.system_prompt !== false) {
        issues.push({ code: 'systemPrompt', value: printable(prompt.system_prompt) });
    }
    if (absolute && !validDepth(prompt.injection_depth)) {
        issues.push({ code: 'depth', value: printable(prompt.injection_depth) });
    }
    const role = prompt.role;
    // Relative blocks without a role go out as system; in-chat blocks (not markers) need one of the three.
    if ((role !== undefined && role !== '' && !isRole(role)) || (absolute && !marker && !isRole(role))) {
        issues.push({ code: 'role', value: printable(role) });
    }
    if (absolute && prompt.injection_order !== undefined && !Number.isFinite(Number(prompt.injection_order))) {
        issues.push({ code: 'order', value: printable(prompt.injection_order) });
    }
    const trigger = prompt.injection_trigger;
    if (trigger !== undefined && !Array.isArray(trigger)) {
        issues.push({ code: 'trigger', value: printable(trigger) });
    } else if (Array.isArray(trigger) && trigger.some((value) => !GENERATION_TYPES.includes(value as string))) {
        issues.push({ code: 'triggerValues', value: printable(trigger) });
    }
    return issues;
}

function triggerList(prompt: Dict): string[] | undefined {
    const trigger = prompt.injection_trigger;
    if (!Array.isArray(trigger) || !trigger.length) return undefined;
    return trigger.map((value) => String(value));
}

/** A non-empty trigger list that names no real generation type: the block is never sent. */
function triggerNeverFits(prompt: Dict): boolean {
    const trigger = prompt.injection_trigger;
    return (
        Array.isArray(trigger) &&
        trigger.length > 0 &&
        !trigger.some((value) => GENERATION_TYPES.includes(value as string))
    );
}

function addNote(slot: AssembledSlot, note: NoteCode): void {
    if (!slot.notes.includes(note)) slot.notes.push(note);
}

/* ------------------------------------------------------------------ assembly */

function baseSlot(identifier: string, prompt: Dict | undefined, enabled: boolean): AssembledSlot {
    const marker = MARKERS.has(identifier);
    return {
        identifier,
        name: nameOf(prompt, identifier),
        role: prompt && isRole(prompt.role) ? prompt.role : 'system',
        placement: 'relative',
        enabled,
        marker,
        content: prompt && !marker ? textOf(prompt) : '',
        sent: false,
        notes: [],
        injections: [],
        typeIssues: [],
    };
}

function relativeSlot(
    slot: AssembledSlot,
    prompt: Dict,
    triggered: boolean,
    moved: AssembledSlot[],
): 'keep' | 'moved' | 'history' {
    const id = slot.identifier;
    if (prompt.injection_position === String(ABSOLUTE)) addNote(slot, 'positionString');
    if (!slot.enabled) return 'keep';
    if (MARKERS.has(id)) {
        if (triggered) {
            slot.sent = true;
            return id === 'chatHistory' ? 'history' : 'keep';
        }
        if (EXTERNAL_MARKERS.includes(id)) {
            // P-118: the marker is not in the collection, so ST appends it and adds it at the end, after the history.
            slot.sent = true;
            addNote(slot, 'movedToEnd');
            moved.push(slot);
            return 'moved';
        }
        slot.dropped = triggerNeverFits(prompt) ? 'triggerInvalid' : 'trigger';
        return 'keep';
    }
    if (!triggered) {
        slot.dropped = triggerNeverFits(prompt) ? 'triggerInvalid' : 'trigger';
        if (id === 'main') addNote(slot, 'mainAnchor');
        return 'keep';
    }
    if (!BY_NAME.has(id) && prompt.system_prompt !== false) {
        slot.dropped = 'systemPrompt';
        return 'keep';
    }
    if (prompt.marker === true && !slot.content) {
        slot.dropped = 'unknownMarker';
        return 'keep';
    }
    if (!slot.content) {
        slot.dropped = 'empty';
        if (id === 'main') addNote(slot, 'mainAnchor');
        return 'keep';
    }
    slot.sent = true;
    return 'keep';
}

function depthSlot(slot: AssembledSlot, prompt: Dict, triggered: boolean): void {
    slot.placement = 'depth';
    slot.depth = typeof prompt.injection_depth === 'number' ? prompt.injection_depth : undefined;
    slot.order = orderOf(prompt);
    // Markers moved into the chat keep ST's system role unless the block sets one (OAI:1487).
    if (slot.marker && prompt.role === undefined) slot.role = 'system';
    if (!slot.enabled) return;
    if (!triggered) {
        slot.dropped = triggerNeverFits(prompt) ? 'triggerInvalid' : 'trigger';
        if (slot.identifier === 'main') addNote(slot, 'mainAnchor');
        return;
    }
    // ST compares the role strictly (OAI:847-852); a marker without one keeps system.
    const roleOk = slot.marker ? prompt.role === undefined || isRole(prompt.role) : isRole(prompt.role);
    if (!roleOk) slot.dropped = 'role';
    else if (typeof prompt.injection_depth !== 'number' || !Number.isInteger(prompt.injection_depth)) {
        slot.dropped = 'depthType';
    } else if (!validDepth(prompt.injection_depth)) slot.dropped = 'depthRange';
    else if (!slot.marker && !slot.content.trim()) slot.dropped = 'empty';
    else slot.sent = true;
}

/** Final prompt order of in-chat blocks: deeper first, then smaller order, then assistant → user → system. */
function compareDepth(a: AssembledSlot, b: AssembledSlot): number {
    const depthA = a.depth ?? -1;
    const depthB = b.depth ?? -1;
    if (depthA !== depthB) return depthB - depthA;
    const orderA = a.order ?? DEFAULT_INJECTION_ORDER;
    const orderB = b.order ?? DEFAULT_INJECTION_ORDER;
    if (orderA !== orderB) return orderA - orderB;
    return ROLE_RANK[a.role] - ROLE_RANK[b.role];
}

function markGroups(depthSlots: AssembledSlot[]): void {
    const groups = new Map<string, AssembledSlot[]>();
    for (const slot of depthSlots) {
        if (!slot.sent) continue;
        const key = `${slot.depth}|${slot.order}|${slot.role}`;
        const group = groups.get(key) ?? [];
        group.push(slot);
        groups.set(key, group);
    }
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        for (const slot of group) {
            slot.mergedWith = group.filter((other) => other !== slot).map((other) => other.identifier);
            addNote(slot, 'merged');
        }
    }
}

function placeInjections(
    slots: readonly ExtensionSlot[],
    main: AssembledSlot | null,
    history: AssembledSlot | null,
    depthSlots: AssembledSlot[],
    lost: AssembledInjection[],
): void {
    const ordered = [...slots].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const slot of ordered) {
        if (typeof slot.value !== 'string' || !slot.value) continue;
        const position = Number(slot.position);
        const owner = slotOwner(slot.key);
        if (position === EXT_IN_CHAT) {
            const role = extensionRole(slot.role);
            const injection: AssembledInjection = { key: slot.key, owner, text: slot.value, where: 'chat', role };
            if (validDepth(slot.depth)) injection.depth = slot.depth;
            if (!history?.sent || !validDepth(slot.depth)) {
                lost.push(injection);
                continue;
            }
            // Only the order-100 group takes extension prompts of its depth and role (P-103).
            const target = depthSlots.find(
                (item) =>
                    item.sent &&
                    item.depth === slot.depth &&
                    item.role === role &&
                    item.order === DEFAULT_INJECTION_ORDER,
            );
            if (target) {
                target.injections.push(injection);
                addNote(target, 'merged');
            } else history.injections.push(injection);
        } else if (position === EXT_BEFORE_PROMPT || position === EXT_IN_PROMPT) {
            if (NOT_RELATIVE_KEYS.has(slot.key)) continue;
            const injection: AssembledInjection = {
                key: slot.key,
                owner,
                text: slot.value,
                where: position === EXT_BEFORE_PROMPT ? 'start' : 'end',
            };
            // With main in the chat, they go into the chat next to it — which needs the history (OAI:1284-1301).
            if (!main || (main.placement === 'depth' && !history?.sent)) {
                lost.push(injection);
                continue;
            }
            if (main.placement === 'depth') {
                injection.depth = main.depth;
                injection.role = main.role;
            }
            main.injections.push(injection);
            if (!main.sent) addNote(main, 'mainAnchor');
        }
    }
}

/**
 * Reconstructs the prompt layout of a preset body for one generation type. Pure: texts are not evaluated (macros
 * stay as written) and marker texts are not known here.
 */
export function assemblePrompt(input: AssemblyInput): Assembly {
    const type = normalizeGenerationType(input.type);
    const byId = promptsById(input.prompts);
    const relative: AssembledSlot[] = [];
    const depthSlots: AssembledSlot[] = [];
    const moved: AssembledSlot[] = [];
    let main: AssembledSlot | null = null;
    let history: AssembledSlot | null = null;
    const listed = new Set<string>();

    for (const item of input.order) {
        listed.add(item.identifier);
        const prompt = byId.get(item.identifier);
        const enabled = !!item.enabled;
        if (!prompt) {
            if (!enabled) continue;
            const slot = baseSlot(item.identifier, undefined, enabled);
            slot.dropped = 'missing';
            relative.push(slot);
            continue;
        }
        const slot = baseSlot(item.identifier, prompt, enabled);
        const triggered = shouldTrigger(prompt, type);
        const triggers = triggerList(prompt);
        if (triggers) slot.triggers = triggers;
        // chatHistory and dialogueExamples are placed by index whatever their position (OAI:885-888, 1101-1104).
        const absolute =
            prompt.injection_position === ABSOLUTE &&
            item.identifier !== 'chatHistory' &&
            item.identifier !== 'dialogueExamples';
        slot.typeIssues = typeIssues(prompt, item, item.identifier, absolute);
        if (input.overridden?.has(item.identifier) && enabled && triggered && prompt.forbid_overrides !== true) {
            addNote(slot, 'cardOverride');
        }
        if (item.identifier === 'main') main = slot;
        if (absolute) {
            depthSlot(slot, prompt, triggered);
            depthSlots.push(slot);
            continue;
        }
        const kind = relativeSlot(slot, prompt, triggered, moved);
        if (kind === 'moved') continue;
        if (kind === 'history') history = slot;
        else if (slot.identifier === 'chatHistory' && !history) history = slot;
        relative.push(slot);
    }

    // External markers missing from the list are appended by ST and sent at the end when they carry text.
    for (const id of EXTERNAL_MARKERS) {
        if (listed.has(id) || !input.markersWithText?.has(id)) continue;
        const slot = baseSlot(id, byId.get(id), true);
        slot.sent = true;
        addNote(slot, 'notInList');
        moved.push(slot);
    }
    // ST appends in its own list order (OAI:1374-1435): the five card/lore markers, then the persona.
    moved.sort((a, b) => EXTERNAL_MARKERS.indexOf(a.identifier) - EXTERNAL_MARKERS.indexOf(b.identifier));

    const historyIncluded = !!history?.sent;
    for (const slot of depthSlots) {
        if (slot.sent && !historyIncluded) {
            slot.sent = false;
            slot.dropped = 'noHistory';
        }
    }
    depthSlots.sort(compareDepth);
    markGroups(depthSlots);

    const lost: AssembledInjection[] = [];
    placeInjections(input.slots ?? [], main, history, depthSlots, lost);

    const slots: AssembledSlot[] = [];
    const historyAt = history ? relative.indexOf(history) : -1;
    if (historyAt >= 0) {
        slots.push(...relative.slice(0, historyAt + 1), ...depthSlots, ...relative.slice(historyAt + 1));
    } else slots.push(...relative, ...depthSlots);
    slots.push(...moved);
    return { type, slots, history: historyIncluded, lost };
}

/* ------------------------------------------------------------------ the end of the prompt */

export interface PromptTail {
    role: PromptRole;
    /** Block identifier, `bias` («Start reply with»), `continue` (continue with prefill) or an extension key. */
    identifier: string;
    via: 'block' | 'bias' | 'continue' | 'injection';
}

export interface TailOptions {
    /** «Start reply with» (`power_user.user_prompt_bias`): an assistant message after the blocks (P-111). */
    bias?: string;
    /** `continue_prefill`: the continued message goes last as assistant (P-108). */
    continuePrefill?: boolean;
    /** Markers known to carry text (moved markers are sent at the very end). */
    markersWithText?: ReadonlySet<string>;
}

/**
 * Role of the last message ST would send (null: the last chat message, i.e. usually the user's). Used for the
 * "assistant at the end" check (prefill through OpenRouter, P-111).
 */
export function promptTail(assembly: Assembly, options: TailOptions = {}): PromptTail | null {
    const type = assembly.type;
    if (type === 'continue' && options.continuePrefill) {
        return { role: 'assistant', identifier: 'continue', via: 'continue' };
    }
    const hasText = (slot: AssembledSlot): boolean =>
        slot.sent && (slot.marker ? !!options.markersWithText?.has(slot.identifier) : slot.content.trim() !== '');
    // Blocks after the history, then what ST appends: the moved markers, «Start reply with», the persona.
    const historyAt = assembly.slots.findIndex((slot) => slot.identifier === 'chatHistory' && slot.sent);
    const sequence: PromptTail[] = [];
    assembly.slots.forEach((slot, index) => {
        if (slot.placement !== 'relative' || index <= historyAt || !hasText(slot)) return;
        if (slot.notes.includes('movedToEnd') || slot.notes.includes('notInList')) return;
        sequence.push({ role: slot.role, identifier: slot.identifier, via: 'block' });
    });
    const moved = assembly.slots.filter(
        (slot) => (slot.notes.includes('movedToEnd') || slot.notes.includes('notInList')) && hasText(slot),
    );
    for (const slot of moved.filter((item) => item.identifier !== 'personaDescription')) {
        sequence.push({ role: 'system', identifier: slot.identifier, via: 'block' });
    }
    const biasAllowed = type !== 'continue' && type !== 'impersonate' && type !== 'quiet';
    if (biasAllowed && options.bias?.trim()) sequence.push({ role: 'assistant', identifier: 'bias', via: 'bias' });
    for (const slot of moved.filter((item) => item.identifier === 'personaDescription')) {
        sequence.push({ role: 'system', identifier: slot.identifier, via: 'block' });
    }
    const last = sequence.at(-1);
    if (last) return last;
    if (historyAt < 0) return null;
    // Nothing after the history: the newest in-chat messages at depth 0 close the prompt.
    const zero: { role: PromptRole; order: number; identifier: string; via: PromptTail['via'] }[] = [];
    const injected = (injection: AssembledInjection, role: PromptRole): void => {
        zero.push({ role, order: DEFAULT_INJECTION_ORDER, identifier: injection.key, via: 'injection' });
    };
    for (const slot of assembly.slots) {
        if (slot.placement !== 'depth' || slot.depth !== 0 || !slot.sent) continue;
        const order = slot.order ?? DEFAULT_INJECTION_ORDER;
        zero.push({ role: slot.role, order, identifier: slot.identifier, via: 'block' });
        for (const injection of slot.injections) injected(injection, injection.role ?? slot.role);
    }
    const history = assembly.slots[historyAt];
    for (const injection of history?.injections ?? []) {
        if (injection.where === 'chat' && injection.depth === 0) injected(injection, injection.role ?? 'system');
    }
    zero.sort((a, b) => a.order - b.order || ROLE_RANK[a.role] - ROLE_RANK[b.role]);
    const final = zero.at(-1);
    return final ? { role: final.role, identifier: final.identifier, via: final.via } : null;
}
