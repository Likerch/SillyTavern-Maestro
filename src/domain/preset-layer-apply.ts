// «Твой слой» of the Preset Studio (M34 п.5): pure application of layer operations to a Chat Completion preset body,
// and the inverse (strip) for «Сохранить базу». Rules (research/parity-preset.md):
// - ops address blocks by identifier; own blocks are written with strict types (§5.1, P-039, P-132):
//   `system_prompt:false, marker:false`, numeric injection fields, a role of the three — otherwise ST silently drops
//   the block from the prompt;
// - the order lives in the global list 100001; a preset without it gets one built from 100000 or from ST's default
//   order, because Prompt Manager creates 100001 only after OAI_PRESET_CHANGED_AFTER (§10.4 б, P-034, P-037);
// - body keys use preset key names (`temperature`, not `temp_openai`, P-085); `prompts`, `prompt_order` and
//   `extensions` are never overridden by key ops (P-160);
// - a text edit carries the hash of the base text it was made on: a changed base gives a conflict (old base, new
//   base, mine) and keeps the base text — never a silent overwrite (§10.4 б п.4).
// Application is idempotent: a base that already holds the layer (saved with ST's own «Обновить пресет», or renamed —
// ST bakes the working copy into the renamed file, P-067) gives no conflicts and no duplicates.
// The types mirror features/presetStudio/layer-api.ts structurally (domain cannot import features).
import { stableHash } from './hash';
import { jsonCopy, valuesEqual } from './settings-diff';

export type Dict = Record<string, unknown>;
export type PromptRole = 'system' | 'user' | 'assistant';

export interface LayerPrompt {
    identifier: string;
    name: string;
    role?: PromptRole;
    content?: string;
    system_prompt?: boolean;
    marker?: boolean;
    injection_position?: 0 | 1;
    injection_depth?: number;
    injection_order?: number;
    injection_trigger?: string[];
    forbid_overrides?: boolean;
    [field: string]: unknown;
}

export interface LayerOrderItem {
    identifier: string;
    enabled: boolean;
}

export interface LayerOrderList {
    character_id: number;
    order: LayerOrderItem[];
}

export type LayerBody = Dict & { prompts?: LayerPrompt[]; prompt_order?: LayerOrderList[] };

export type LayerAnchor =
    | { kind: 'after'; identifier: string }
    | { kind: 'before'; identifier: string }
    | { kind: 'afterText'; text: string }
    | { kind: 'start' }
    | { kind: 'end' };

export interface AddOp {
    op: 'add';
    prompt: LayerPrompt;
    anchor: LayerAnchor;
    enabled: boolean;
}

export interface EditOp {
    op: 'edit';
    identifier: string;
    patch: Partial<LayerPrompt>;
    baseHash: string;
    baseText?: string;
    /** Base values of the patched fields other than `content` (for strip). */
    baseFields?: Partial<LayerPrompt>;
    /** Patched fields the base block did not have (strip deletes them). */
    baseMissing?: string[];
}

export interface ToggleOp {
    op: 'toggle';
    identifier: string;
    enabled: boolean;
    baseEnabled?: boolean;
}

export interface MoveOp {
    op: 'move';
    identifier: string;
    anchor: LayerAnchor;
    /** Where the block stood in the base; null = it was outside the order (strip takes it out again). */
    baseAnchor?: LayerAnchor | null;
}

export interface KeyOp {
    op: 'key';
    key: string;
    value: unknown;
    baseValue?: unknown;
    /** The base body had no such key (strip deletes it). */
    baseUnset?: boolean;
}

export type LayerOp = AddOp | EditOp | ToggleOp | MoveOp | KeyOp;

export interface LayerConflict {
    identifier: string;
    oldBase: string;
    newBase: string;
    mine: string;
    /** The layer scope of the op in conflict (preset-layer-scopes.ts; absent = global). */
    scope?: 'global' | 'character' | 'chat';
}

export interface LayerApplyReport {
    applied: number;
    conflicts: LayerConflict[];
    orphaned: LayerOp[];
    /** Base blocks a migrated body no longer had: the layer cannot delete them, they are switched off instead. */
    removed?: string[];
}

/* ------------------------------------------------------------------ constants */

/** Prompt Manager's global order list in Chat Completion (OAI:696-699). */
export const GLOBAL_ORDER_ID = 100001;
/** The per-character dummy list found in old presets and Default.json (P-081). */
export const CHARACTER_ORDER_ID = 100000;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_INJECTION_ORDER = 100;

/** The eight places ST fills itself (PM:2001-2081, P-035). */
export const MARKER_IDS: readonly string[] = [
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'dialogueExamples',
    'chatHistory',
];

/** Built-in system blocks (P-036). */
export const SYSTEM_PROMPT_IDS: readonly string[] = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];

/** Body keys a key op never touches. */
export const RESERVED_KEYS: readonly string[] = ['prompts', 'prompt_order', 'extensions'];

/** Addresses, keys and passwords (OAI:287-299, P-096): never stored in Maestro files. */
export const SENSITIVE_KEYS: readonly string[] = [
    'reverse_proxy',
    'proxy_password',
    'custom_url',
    'custom_include_body',
    'custom_exclude_body',
    'custom_include_headers',
    'vertexai_region',
    'vertexai_express_project_id',
    'azure_base_url',
    'azure_deployment_name',
    'workers_ai_account_id',
];

/** ST's default order (PromptManager.js promptManagerDefaultPromptOrder). */
export const DEFAULT_ORDER: readonly LayerOrderItem[] = [
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

const ROLES: readonly PromptRole[] = ['system', 'user', 'assistant'];
/** Fields a block may carry only while ST assembles a prompt, or the legacy flag ST ignores (P-055). */
const ASSEMBLY_FIELDS = ['enabled', 'extension', 'position'];

/* ------------------------------------------------------------------ small helpers */

export function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fingerprint of a block text (line endings normalised so a file edited on Windows keeps its hash). */
export function textHash(text: string): string {
    return stableHash(text.replace(/\r\n/g, '\n'));
}

export function contentOf(prompt: unknown): string {
    return isDict(prompt) && typeof prompt.content === 'string' ? prompt.content : '';
}

function isPrompt(value: unknown): value is LayerPrompt {
    return isDict(value) && typeof value.identifier === 'string' && value.identifier !== '';
}

/** The blocks of a body (entries without an identifier skipped). */
export function promptsOf(body: unknown): LayerPrompt[] {
    if (!isDict(body) || !Array.isArray(body.prompts)) return [];
    return body.prompts.filter(isPrompt);
}

export function findPrompt(body: unknown, identifier: string): LayerPrompt | undefined {
    return promptsOf(body).find((prompt) => prompt.identifier === identifier);
}

function orderItems(raw: unknown): LayerOrderItem[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (item): item is LayerOrderItem => isDict(item) && typeof item.identifier === 'string' && item.identifier !== '',
    );
}

function orderLists(body: unknown): unknown[] {
    return isDict(body) && Array.isArray(body.prompt_order) ? body.prompt_order : [];
}

function listIndex(lists: readonly unknown[], characterId: number): number {
    return lists.findIndex(
        (list) => isDict(list) && String(list.character_id) === String(characterId) && Array.isArray(list.order),
    );
}

/** The order the layer builds when the global list is missing: 100000 (non-empty), else ST's default. */
function fallbackOrder(lists: readonly unknown[]): LayerOrderItem[] {
    const at = listIndex(lists, CHARACTER_ORDER_ID);
    const legacy = at >= 0 ? orderItems((lists[at] as Dict).order) : [];
    return (legacy.length ? legacy : DEFAULT_ORDER).map((item) => ({
        identifier: item.identifier,
        enabled: item.enabled !== false,
    }));
}

/** The order the layer works on: the global list 100001, else what applyLayer would create. */
export function effectiveOrder(body: unknown): LayerOrderItem[] {
    const lists = orderLists(body);
    const at = listIndex(lists, GLOBAL_ORDER_ID);
    return at >= 0 ? orderItems((lists[at] as Dict).order) : fallbackOrder(lists);
}

/** The global list only (null when the body has none). */
export function globalOrder(body: unknown): LayerOrderItem[] | null {
    const lists = orderLists(body);
    const at = listIndex(lists, GLOBAL_ORDER_ID);
    return at >= 0 ? orderItems((lists[at] as Dict).order) : null;
}

export function normalizeRole(role: unknown): PromptRole {
    return ROLES.includes(role as PromptRole) ? (role as PromptRole) : 'system';
}

function finiteNumber(value: unknown): number | null {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? Math.trunc(number) : null;
}

function triggers(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** An own block with the strict types ST's assembly needs (P-039, P-044…P-047, P-132). */
export function normalizeOwnBlock(prompt: LayerPrompt): LayerPrompt {
    const rest: Dict = jsonCopy({ ...prompt });
    for (const field of ASSEMBLY_FIELDS) delete rest[field];
    const identifier = String(prompt.identifier);
    const depth = finiteNumber(prompt.injection_depth);
    const order = finiteNumber(prompt.injection_order);
    return {
        ...rest,
        identifier,
        name: typeof prompt.name === 'string' && prompt.name !== '' ? prompt.name : identifier,
        role: normalizeRole(prompt.role),
        content: typeof prompt.content === 'string' ? prompt.content : '',
        system_prompt: false,
        marker: false,
        injection_position: finiteNumber(prompt.injection_position) === 1 ? 1 : 0,
        injection_depth: depth !== null && depth >= 0 ? depth : DEFAULT_DEPTH,
        injection_order: order !== null ? order : DEFAULT_INJECTION_ORDER,
        injection_trigger: triggers(prompt.injection_trigger),
        forbid_overrides: prompt.forbid_overrides === true,
    };
}

/**
 * A patch for a base block with strict types. The kind of a base block (`system_prompt`, `marker`) and its
 * identifier are never changed by the layer.
 */
export function normalizePatch(patch: Partial<LayerPrompt>): Partial<LayerPrompt> {
    const out: Dict = isDict(patch) ? jsonCopy({ ...patch }) : {};
    for (const field of ['identifier', 'system_prompt', 'marker', ...ASSEMBLY_FIELDS]) delete out[field];
    if ('role' in out) out.role = normalizeRole(out.role);
    if ('content' in out) out.content = typeof out.content === 'string' ? out.content : String(out.content ?? '');
    if ('injection_position' in out) out.injection_position = finiteNumber(out.injection_position) === 1 ? 1 : 0;
    for (const field of ['injection_depth', 'injection_order']) {
        if (!(field in out)) continue;
        const number = finiteNumber(out[field]);
        if (number === null) delete out[field];
        else out[field] = number;
    }
    if ('injection_trigger' in out) out.injection_trigger = triggers(out.injection_trigger);
    if ('forbid_overrides' in out) out.forbid_overrides = out.forbid_overrides === true;
    return out as Partial<LayerPrompt>;
}

/**
 * Insertion index for an anchor in an order list, -1 when the anchor is not there. `afterText` = after the first
 * block (in order) whose content contains the text.
 */
export function anchorIndex(
    order: readonly LayerOrderItem[],
    anchor: LayerAnchor,
    content: (identifier: string) => string,
): number {
    switch (anchor.kind) {
        case 'start':
            return 0;
        case 'end':
            return order.length;
        case 'after': {
            const index = order.findIndex((item) => item.identifier === anchor.identifier);
            return index < 0 ? -1 : index + 1;
        }
        case 'before':
            return order.findIndex((item) => item.identifier === anchor.identifier);
        case 'afterText': {
            if (!anchor.text) return -1;
            const index = order.findIndex((item) => content(item.identifier).includes(anchor.text));
            return index < 0 ? -1 : index + 1;
        }
        default:
            return -1;
    }
}

/* ------------------------------------------------------------------ copy-on-write draft of a body */

/** A shallow copy of a body whose `prompts` and global order are copied on the first change only. */
class Draft {
    readonly body: LayerBody;
    private readonly prompts: unknown[] | null;
    private promptsDirty = false;
    private order: LayerOrderItem[] | null = null;
    /** Index of the global list in `prompt_order`; -1 = the list is created. */
    private orderListAt = -1;
    private orderDirty = false;

    constructor(source: LayerBody) {
        this.body = { ...source };
        this.prompts = Array.isArray(source.prompts) ? [...source.prompts] : null;
    }

    hasPrompts(): boolean {
        return this.prompts !== null;
    }

    indexOf(identifier: string): number {
        return this.prompts
            ? this.prompts.findIndex((prompt) => isPrompt(prompt) && prompt.identifier === identifier)
            : -1;
    }

    at(index: number): LayerPrompt | undefined {
        const prompt = this.prompts?.[index];
        return isPrompt(prompt) ? prompt : undefined;
    }

    get(identifier: string): LayerPrompt | undefined {
        return this.at(this.indexOf(identifier));
    }

    content = (identifier: string): string => contentOf(this.get(identifier));

    put(index: number, prompt: LayerPrompt): void {
        if (!this.prompts) return;
        this.prompts[index] = prompt;
        this.promptsDirty = true;
    }

    push(prompt: LayerPrompt): void {
        if (!this.prompts) return;
        this.prompts.push(prompt);
        this.promptsDirty = true;
    }

    removeAt(index: number): void {
        if (!this.prompts || index < 0) return;
        this.prompts.splice(index, 1);
        this.promptsDirty = true;
    }

    /** The working global order; `create` builds it (from 100000 or the default) when the body has none. */
    orderFor(create: boolean): LayerOrderItem[] | null {
        if (this.order) return this.order;
        const lists = orderLists(this.body);
        const at = listIndex(lists, GLOBAL_ORDER_ID);
        if (at >= 0) {
            this.orderListAt = at;
            this.order = [...orderItems((lists[at] as Dict).order)];
            return this.order;
        }
        if (!create) return null;
        this.orderListAt = -1;
        this.order = fallbackOrder(lists);
        this.orderDirty = true;
        return this.order;
    }

    setOrder(order: LayerOrderItem[]): void {
        this.order = order;
        this.orderDirty = true;
    }

    insert(index: number, item: LayerOrderItem): void {
        const order = this.orderFor(true);
        if (!order) return;
        order.splice(Math.max(0, Math.min(index, order.length)), 0, item);
        this.orderDirty = true;
    }

    replaceEntry(index: number, item: LayerOrderItem): void {
        const order = this.orderFor(true);
        if (!order || index < 0 || index >= order.length) return;
        order[index] = item;
        this.orderDirty = true;
    }

    finish(): LayerBody {
        if (this.promptsDirty && this.prompts) this.body.prompts = this.prompts as LayerPrompt[];
        if (this.orderDirty && this.order) {
            const lists = [...orderLists(this.body)] as LayerOrderList[];
            const at = this.orderListAt;
            const existing = at >= 0 ? lists[at] : undefined;
            if (existing) lists[at] = { ...existing, order: this.order };
            else lists.push({ character_id: GLOBAL_ORDER_ID, order: this.order });
            this.body.prompt_order = lists;
        }
        return this.body;
    }
}

/* ------------------------------------------------------------------ apply */

type Outcome = 'applied' | 'orphaned' | LayerConflict;

function applyAdd(draft: Draft, op: AddOp): Outcome {
    if (!draft.hasPrompts() || !isPrompt(op.prompt)) return 'orphaned';
    const block = normalizeOwnBlock(op.prompt);
    const id = block.identifier;
    const index = draft.indexOf(id);
    const existing = draft.at(index);
    if (existing) {
        // Already in the base (a baked layer) — or a different block under the same identifier: a conflict.
        if (contentOf(existing) !== contentOf(block)) {
            return { identifier: id, oldBase: '', newBase: contentOf(existing), mine: contentOf(block) };
        }
        if (existing.system_prompt === false && !valuesEqual(existing, block)) draft.put(index, block);
    } else {
        draft.push(block);
    }
    const order = draft.orderFor(true) ?? [];
    if (order.some((item) => item.identifier === id)) return 'applied';
    const at = anchorIndex(order, op.anchor, draft.content);
    if (at < 0) {
        // Kept, but switched off at the end: a lost anchor must not send an instruction in the wrong place.
        draft.insert(order.length, { identifier: id, enabled: false });
        return 'orphaned';
    }
    draft.insert(at, { identifier: id, enabled: op.enabled === true });
    return 'applied';
}

function applyEdit(draft: Draft, op: EditOp): Outcome {
    if (!draft.hasPrompts()) return 'orphaned';
    const index = draft.indexOf(op.identifier);
    const current = draft.at(index);
    if (!current) return 'orphaned';
    const patch = normalizePatch(op.patch);
    if (current.marker === true) delete patch.content; // marker texts come from ST (P-035)
    const next: LayerPrompt = { ...current, ...patch };
    let conflict: LayerConflict | null = null;
    if (typeof patch.content === 'string') {
        const text = contentOf(current);
        if (text !== patch.content && textHash(text) !== op.baseHash) {
            conflict = { identifier: op.identifier, oldBase: op.baseText ?? '', newBase: text, mine: patch.content };
            if (current.content === undefined) delete next.content;
            else next.content = current.content;
        }
    }
    if (!valuesEqual(next, current)) draft.put(index, next);
    return conflict ?? 'applied';
}

function applyToggle(draft: Draft, op: ToggleOp): Outcome {
    if (!draft.hasPrompts()) return 'orphaned';
    const order = draft.orderFor(true) ?? [];
    const index = order.findIndex((item) => item.identifier === op.identifier);
    const entry = order[index];
    if (!entry) return 'orphaned';
    if (entry.enabled !== op.enabled) draft.replaceEntry(index, { ...entry, enabled: op.enabled });
    return 'applied';
}

function applyMove(draft: Draft, op: MoveOp): Outcome {
    if (!draft.hasPrompts()) return 'orphaned';
    const order = draft.orderFor(true) ?? [];
    const index = order.findIndex((item) => item.identifier === op.identifier);
    // A block of the prompts that is outside the order is put into it (switched off; a toggle op enables it).
    const entry = order[index] ?? (draft.get(op.identifier) ? { identifier: op.identifier, enabled: false } : null);
    if (!entry) return 'orphaned';
    const rest = index >= 0 ? order.filter((_, position) => position !== index) : [...order];
    const at = anchorIndex(rest, op.anchor, draft.content);
    if (at < 0) return 'orphaned';
    if (at !== index) draft.setOrder([...rest.slice(0, at), entry, ...rest.slice(at)]);
    return 'applied';
}

function applyKey(draft: Draft, op: KeyOp): Outcome {
    if (typeof op.key !== 'string' || !op.key || RESERVED_KEYS.includes(op.key)) return 'orphaned';
    if (!valuesEqual(draft.body[op.key], op.value)) draft.body[op.key] = jsonCopy(op.value);
    return 'applied';
}

function applyOne(draft: Draft, op: LayerOp): Outcome {
    switch (op.op) {
        case 'add':
            return applyAdd(draft, op);
        case 'edit':
            return applyEdit(draft, op);
        case 'toggle':
            return applyToggle(draft, op);
        case 'move':
            return applyMove(draft, op);
        case 'key':
            return applyKey(draft, op);
        default:
            return 'orphaned';
    }
}

export function emptyReport(): LayerApplyReport {
    return { applied: 0, conflicts: [], orphaned: [] };
}

/**
 * Lays the ops over a base body. The base is not changed: the result is a shallow copy whose `prompts` and
 * `prompt_order` are fresh arrays when (and only when) the layer changed them; changed blocks and order entries are
 * fresh objects too, the rest is shared with the base.
 */
export function applyLayer(base: LayerBody, ops: readonly LayerOp[]): { body: LayerBody; report: LayerApplyReport } {
    const draft = new Draft(base);
    const report = emptyReport();
    for (const op of ops) {
        const outcome = applyOne(draft, op);
        if (outcome === 'applied') report.applied++;
        else if (outcome === 'orphaned') report.orphaned.push(op);
        else report.conflicts.push(outcome);
    }
    return { body: draft.finish(), report };
}

/* ------------------------------------------------------------------ strip */

function stripKey(draft: Draft, op: KeyOp): void {
    if (!valuesEqual(draft.body[op.key], op.value)) return;
    if (op.baseUnset === true) delete draft.body[op.key];
    else if (Object.hasOwn(op, 'baseValue')) draft.body[op.key] = jsonCopy(op.baseValue);
}

function stripEdit(draft: Draft, op: EditOp): void {
    const index = draft.indexOf(op.identifier);
    const current = draft.at(index);
    if (!current) return;
    const next: LayerPrompt = { ...current };
    let changed = false;
    for (const [field, value] of Object.entries(normalizePatch(op.patch))) {
        if (!valuesEqual(current[field], value)) continue; // not the layer's value any more (conflict or a draft)
        if (field === 'content') {
            if (typeof op.baseText === 'string') {
                next.content = op.baseText;
                changed = true;
            }
        } else if (op.baseFields && Object.hasOwn(op.baseFields, field)) {
            next[field] = jsonCopy(op.baseFields[field]);
            changed = true;
        } else if (op.baseMissing?.includes(field)) {
            delete next[field];
            changed = true;
        }
    }
    if (changed) draft.put(index, next);
}

function stripToggle(draft: Draft, op: ToggleOp): void {
    if (typeof op.baseEnabled !== 'boolean' || op.baseEnabled === op.enabled) return;
    const order = draft.orderFor(false);
    if (!order) return;
    const index = order.findIndex((item) => item.identifier === op.identifier);
    const entry = order[index];
    if (entry && entry.enabled === op.enabled) draft.replaceEntry(index, { ...entry, enabled: op.baseEnabled });
}

function stripAdd(draft: Draft, op: AddOp): void {
    if (!isPrompt(op.prompt)) return;
    const index = draft.indexOf(op.prompt.identifier);
    const existing = draft.at(index);
    // Only the layer's own block: a base block under the same identifier (a conflict) stays.
    if (!existing || existing.system_prompt === true || contentOf(existing) !== contentOf(op.prompt)) return;
    draft.removeAt(index);
    const order = draft.orderFor(false);
    if (order?.some((item) => item.identifier === op.prompt.identifier)) {
        draft.setOrder(order.filter((item) => item.identifier !== op.prompt.identifier));
    }
}

/**
 * Moved blocks go back to their base anchors. All of them are taken out first and put back while their anchors
 * resolve (base anchors point at base neighbours, which may be moved blocks themselves); a lost anchor keeps the
 * block at the end.
 */
function stripMoves(draft: Draft, moves: readonly MoveOp[]): void {
    const tracked = moves.filter((op) => op.baseAnchor !== undefined);
    const order = tracked.length ? draft.orderFor(false) : null;
    if (!order) return;
    const ids = new Set(tracked.map((op) => op.identifier));
    const entries = new Map(order.filter((item) => ids.has(item.identifier)).map((item) => [item.identifier, item]));
    if (!entries.size) return;
    let next = order.filter((item) => !ids.has(item.identifier));
    const waiting = tracked.filter((op) => op.baseAnchor && entries.has(op.identifier));
    let progress = true;
    while (waiting.length && progress) {
        progress = false;
        for (let k = 0; k < waiting.length; k++) {
            const op = waiting[k];
            const entry = op ? entries.get(op.identifier) : undefined;
            const at = op?.baseAnchor && entry ? anchorIndex(next, op.baseAnchor, draft.content) : -1;
            if (!entry || at < 0) continue;
            next = [...next.slice(0, at), entry, ...next.slice(at)];
            waiting.splice(k, 1);
            k--;
            progress = true;
        }
    }
    for (const op of waiting) {
        const entry = entries.get(op.identifier);
        if (entry) next.push(entry);
    }
    draft.setOrder(next);
}

/**
 * The base body without the layer («Сохранить базу»): own blocks removed, base texts and fields back, toggles,
 * moves and keys back to the base values stored in the ops. Only what still holds the layer's value is reverted —
 * a conflict that kept the new base text, or a later draft change, stays as it is.
 */
export function stripLayer(body: LayerBody, ops: readonly LayerOp[]): LayerBody {
    const draft = new Draft(body);
    const reversed = [...ops].reverse();
    for (const op of reversed) if (op.op === 'key') stripKey(draft, op);
    for (const op of reversed) if (op.op === 'edit') stripEdit(draft, op);
    for (const op of reversed) if (op.op === 'toggle') stripToggle(draft, op);
    for (const op of reversed) if (op.op === 'add') stripAdd(draft, op);
    stripMoves(
        draft,
        ops.filter((op): op is MoveOp => op.op === 'move'),
    );
    return draft.finish();
}
