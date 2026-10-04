// Prompt Manager data of a Chat Completion preset (Preset Studio data layer, M34, stage 5): built-in blocks, the
// global prompt order (dummy character 100001, research/parity-preset.md P-034) and the type rules ST's assembly
// checks strictly (P-039, P-044…P-047, P-132): a relative block is sent only when `system_prompt === false`,
// in-chat only when `injection_position === 1`, at a depth only when `injection_depth === depth` (a number), with a
// role from the three. Pure: no DOM, network or SillyTavern.

type Dict = Record<string, unknown>;

export interface OrderEntry {
    identifier: string;
    enabled: boolean;
}

/** The global order list of Chat Completion (`promptOrder.dummyId`, openai.js:696-699). */
export const GLOBAL_ORDER_ID = 100001;

/** Prompt Manager's built-in text blocks (`systemPrompts`, PromptManager.js:313-318). */
export const SYSTEM_PROMPT_IDS = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'] as const;

/** Places ST fills itself (PromptManager.js:2001-2081). */
export const MARKER_IDS = [
    'dialogueExamples',
    'chatHistory',
    'worldInfoAfter',
    'worldInfoBefore',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
] as const;

/** Blocks Prompt Manager puts back when they are missing (checkForMissingPrompts, P-037). */
export const DEFAULT_PROMPT_IDS: readonly string[] = [...SYSTEM_PROMPT_IDS, ...MARKER_IDS];

/** Blocks whose text lives in the quick-edit fields of the drawer (P-012). */
export const QUICK_EDIT_IDS = ['main', 'nsfw', 'jailbreak'] as const;

/** `promptManagerDefaultPromptOrder` (PromptManager.js:2087-2136): what PM creates when 100001 is missing. */
export const DEFAULT_PROMPT_ORDER: readonly OrderEntry[] = [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'personaDescription', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'charPersonality', enabled: true },
    { identifier: 'scenario', enabled: true },
    { identifier: 'enhanceDefinitions', enabled: false },
    { identifier: 'nsfw', enabled: true },
    { identifier: 'worldInfoAfter', enabled: true },
    { identifier: 'dialogueExamples', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
];

/** Prompt Manager form defaults (PromptManager.js:31-32, Prompt constructor 182-195). */
export const DEFAULT_DEPTH = 4;
export const DEFAULT_ORDER = 100;
const MAX_INJECTION = 9999;
const ROLES = ['system', 'user', 'assistant'] as const;
const TRIGGER_TYPES = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
/** Keys that exist only while ST assembles a prompt (P-055); never stored. */
const ASSEMBLY_ONLY_KEYS = ['extension', 'position'];

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBuiltinPrompt(identifier: string): boolean {
    return DEFAULT_PROMPT_IDS.includes(identifier);
}

/**
 * Built-ins are never deleted (P-029, P-037: PM would put them back anyway). A foreign block that merely carries
 * `system_prompt: true` is not protected: ST never sends it as a relative block (P-039), the studio fixes it.
 */
export function isProtectedPrompt(prompt: Dict): boolean {
    return typeof prompt.identifier === 'string' && isBuiltinPrompt(prompt.identifier);
}

function clampInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
    if (!Number.isFinite(parsed) || (typeof value === 'string' && value.trim() === '')) return fallback;
    return Math.min(MAX_INJECTION, Math.max(0, Math.round(parsed)));
}

function toPosition(value: unknown): 0 | 1 {
    return Number(value) === 1 ? 1 : 0;
}

function toRole(value: unknown): 'system' | 'user' | 'assistant' {
    const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return (ROLES as readonly string[]).includes(role) ? (role as 'system' | 'user' | 'assistant') : 'system';
}

function toTriggers(value: unknown): string[] {
    const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    const triggers = list
        .map((item) => String(item).trim().toLowerCase())
        .filter((item) => TRIGGER_TYPES.includes(item));
    return [...new Set(triggers)];
}

function toFlag(value: unknown): boolean {
    if (typeof value === 'string') return ['true', '1', 'on', 'yes'].includes(value.trim().toLowerCase());
    return value === true || value === 1;
}

/**
 * Types of the fields a patch sets, as ST's assembly compares them (P-132): position 0|1, depth and order as
 * integers 0…9999, a role from the three, triggers as a list of known generation types, boolean flags. The
 * identifier, assembly-only keys and the legacy `enabled` flag are dropped (the order entry holds the switch).
 */
export function normalizePromptPatch(patch: Dict): Dict {
    const clean: Dict = {};
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'identifier' || key === 'enabled' || ASSEMBLY_ONLY_KEYS.includes(key) || value === undefined)
            continue;
        switch (key) {
            case 'injection_position':
                clean[key] = toPosition(value);
                break;
            case 'injection_depth':
                clean[key] = clampInt(value, DEFAULT_DEPTH);
                break;
            case 'injection_order':
                clean[key] = clampInt(value, DEFAULT_ORDER);
                break;
            case 'role':
                clean[key] = toRole(value);
                break;
            case 'injection_trigger':
                clean[key] = toTriggers(value);
                break;
            case 'forbid_overrides':
            case 'system_prompt':
            case 'marker':
                clean[key] = toFlag(value);
                break;
            case 'name':
            case 'content':
                clean[key] = value === null ? '' : String(value);
                break;
            default:
                clean[key] = JSON.parse(JSON.stringify(value)) as unknown;
        }
    }
    return clean;
}

/**
 * A whole prompt with ST-strict types (import, studio edits). Blocks that are not built-ins are always
 * `system_prompt: false, marker: false` (P-039: otherwise a relative block is silently never sent); built-ins
 * keep their flags. Fields that were absent stay absent (ST's defaults apply to them).
 */
export function normalizePrompt(prompt: Dict): Dict {
    const identifier = typeof prompt.identifier === 'string' ? prompt.identifier : '';
    const clean = normalizePromptPatch(prompt);
    if (identifier) clean.identifier = identifier;
    if (!isBuiltinPrompt(identifier)) {
        clean.system_prompt = false;
        clean.marker = false;
    }
    if (prompt.enabled !== undefined) clean.enabled = prompt.enabled === true;
    return clean;
}

/**
 * The prompt after a patch, as the store writes it back into `oai_settings.prompts`: unknown fields kept, the
 * known ones of the whole block typed strictly (a string `"1"` position from a foreign file is fixed on any edit),
 * and blocks that are not built-ins marked `system_prompt: false, marker: false` (P-039).
 */
export function applyPromptPatch(prompt: Dict, patch: Dict): Dict {
    const next: Dict = { ...prompt, ...normalizePromptPatch(patch) };
    const identifier = typeof next.identifier === 'string' ? next.identifier : '';
    if (!isBuiltinPrompt(identifier)) {
        next.system_prompt = false;
        next.marker = false;
    }
    if (next.injection_position !== undefined) next.injection_position = toPosition(next.injection_position);
    if (next.injection_depth !== undefined) next.injection_depth = clampInt(next.injection_depth, DEFAULT_DEPTH);
    if (next.injection_order !== undefined) next.injection_order = clampInt(next.injection_order, DEFAULT_ORDER);
    if (next.role !== undefined) next.role = toRole(next.role);
    return next;
}

/* ------------------------------------------------------------------ prompt order */

/** The order list of one character id (`String()` comparison like PM, PromptManager.js:1207-1209), or null. */
export function findOrderList(promptOrder: unknown, characterId: number | string = GLOBAL_ORDER_ID): Dict | null {
    if (!Array.isArray(promptOrder)) return null;
    return promptOrder.filter(isDict).find((list) => String(list.character_id) === String(characterId)) ?? null;
}

/** Entries of an order array (malformed items dropped, `enabled` strictly boolean). */
export function readOrder(order: unknown): OrderEntry[] {
    if (!Array.isArray(order)) return [];
    return order
        .filter(isDict)
        .filter((item) => typeof item.identifier === 'string' && item.identifier !== '')
        .map((item) => ({ identifier: item.identifier as string, enabled: item.enabled === true }));
}

/** The active (global) order of a body or settings object; [] when the list is missing. */
export function activeOrder(promptOrder: unknown): OrderEntry[] {
    return readOrder(findOrderList(promptOrder)?.order);
}

/**
 * New order: the listed identifiers first, in the given sequence, then entries that were not listed (their
 * relative order kept). Identifiers that are not in the order are ignored; duplicates count once.
 */
export function reorderEntries(entries: readonly OrderEntry[], identifiers: readonly string[]): OrderEntry[] {
    const byId = new Map(entries.map((entry) => [entry.identifier, entry]));
    const seen = new Set<string>();
    const result: OrderEntry[] = [];
    for (const identifier of identifiers) {
        const entry = byId.get(identifier);
        if (!entry || seen.has(identifier)) continue;
        seen.add(identifier);
        result.push({ ...entry });
    }
    for (const entry of entries) if (!seen.has(entry.identifier)) result.push({ ...entry });
    return result;
}

/** Index to insert a new entry at: right after `after`, else at the start (PM's appendPrompt unshifts, P-028). */
export function insertIndex(entries: readonly OrderEntry[], after?: string): number {
    if (after === undefined) return 0;
    const index = entries.findIndex((entry) => entry.identifier === after);
    return index < 0 ? 0 : index + 1;
}

/**
 * The global order ST will hold after applying a saved body: its 100001 list, or — when the body has an order
 * without it — PM's default order without references to missing prompts (sanitizeServiceSettings, P-037).
 * null when the body has no `prompt_order` at all (applying it keeps the previous order).
 */
export function expectedActiveOrder(body: Dict, promptIds: readonly string[]): OrderEntry[] | null {
    if (!Array.isArray(body.prompt_order)) return null;
    const list = findOrderList(body.prompt_order);
    if (list) return readOrder(list.order).filter((entry) => promptIds.includes(entry.identifier));
    return DEFAULT_PROMPT_ORDER.filter((entry) => promptIds.includes(entry.identifier)).map((entry) => ({ ...entry }));
}

/** Prompt identifiers of a prompts array. */
export function promptIds(prompts: unknown): string[] {
    if (!Array.isArray(prompts)) return [];
    return prompts
        .filter(isDict)
        .map((prompt) => prompt.identifier)
        .filter((identifier): identifier is string => typeof identifier === 'string');
}
