// «Твой слой» (M34 п.5): validation of layer operations, their base values (kept in the op so «Сохранить базу» can
// strip the layer), merging a new studio edit into the stored ops (one op per block and kind), conflict resolution
// and the fingerprints used to tell whether the working copy holds the layer (page load has no
// OAI_PRESET_CHANGED_BEFORE, research/parity-preset.md §10.2 п.3, §10.4 б).
import {
    effectiveOrder,
    findPrompt,
    globalOrder,
    isDict,
    MARKER_IDS,
    normalizeOwnBlock,
    normalizePatch,
    promptsOf,
    RESERVED_KEYS,
    SENSITIVE_KEYS,
    textHash,
} from './preset-layer-apply';
import type {
    AddOp,
    EditOp,
    KeyOp,
    LayerAnchor,
    LayerBody,
    LayerOp,
    LayerOrderItem,
    LayerPrompt,
} from './preset-layer-apply';
import { jsonCopy, valueHash, valuesEqual } from './settings-diff';

type Dict = Record<string, unknown>;

const OP_KINDS = ['add', 'edit', 'toggle', 'move', 'key'] as const;
const ANCHOR_KINDS = ['after', 'before', 'afterText', 'start', 'end'] as const;

/** Block fields compared by the fingerprints and by `baseMatches`. */
export const BLOCK_FIELDS = [
    'name',
    'role',
    'content',
    'injection_position',
    'injection_depth',
    'injection_order',
    'injection_trigger',
    'forbid_overrides',
    'system_prompt',
    'marker',
] as const;

/** One op per block and kind (an own block's edits, toggles and moves live inside its add op). */
export function opKey(op: LayerOp): string {
    switch (op.op) {
        case 'add':
            return `add:${op.prompt.identifier}`;
        case 'key':
            return `key:${op.key}`;
        default:
            return `${op.op}:${op.identifier}`;
    }
}

export function isValidAnchor(anchor: unknown): anchor is LayerAnchor {
    if (!isDict(anchor) || !ANCHOR_KINDS.includes(anchor.kind as (typeof ANCHOR_KINDS)[number])) return false;
    if (anchor.kind === 'after' || anchor.kind === 'before') {
        return typeof anchor.identifier === 'string' && anchor.identifier !== '';
    }
    if (anchor.kind === 'afterText') return typeof anchor.text === 'string' && anchor.text !== '';
    return true;
}

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value !== '';
}

function serialisable(value: unknown): boolean {
    try {
        return value !== undefined && JSON.stringify(value) !== undefined;
    } catch {
        return false;
    }
}

/**
 * Checks the shape of an op; returns the reason it is rejected, or null. An add op may come without an
 * identifier (the layer gives it one) and an edit op without a base hash (filled from the base body).
 */
export function validateOp(op: unknown): string | null {
    if (!isDict(op)) return 'not an object';
    if (!OP_KINDS.includes(op.op as (typeof OP_KINDS)[number])) return `unknown op ${String(op.op)}`;
    switch (op.op) {
        case 'add':
            if (!isDict(op.prompt)) return 'add: prompt missing';
            if (op.prompt.identifier !== undefined && typeof op.prompt.identifier !== 'string') {
                return 'add: identifier must be a string';
            }
            if (MARKER_IDS.includes(String(op.prompt.identifier))) return 'add: a marker cannot be added';
            if (!isValidAnchor(op.anchor)) return 'add: invalid anchor';
            if (typeof op.enabled !== 'boolean') return 'add: enabled must be a boolean';
            return null;
        case 'edit':
            if (!nonEmpty(op.identifier)) return 'edit: identifier missing';
            if (!isDict(op.patch)) return 'edit: patch missing';
            if (op.patch.identifier !== undefined && op.patch.identifier !== op.identifier) {
                return 'edit: the identifier cannot change';
            }
            if (typeof op.baseHash !== 'string') return 'edit: baseHash must be a string';
            return null;
        case 'toggle':
            if (!nonEmpty(op.identifier)) return 'toggle: identifier missing';
            if (typeof op.enabled !== 'boolean') return 'toggle: enabled must be a boolean';
            // Without chatHistory no history is sent at all (P-022, P-130).
            if (op.identifier === 'chatHistory' && op.enabled === false) return 'toggle: chatHistory stays on';
            return null;
        case 'move':
            if (!nonEmpty(op.identifier)) return 'move: identifier missing';
            return isValidAnchor(op.anchor) ? null : 'move: invalid anchor';
        default:
            if (!nonEmpty(op.key)) return 'key: key missing';
            if (RESERVED_KEYS.includes(op.key)) return `key: ${op.key} is not a key override`;
            if (SENSITIVE_KEYS.includes(op.key)) return `key: ${op.key} is never stored`;
            return serialisable(op.value) ? null : 'key: value is not JSON';
    }
}

/** Valid ops of a stored file (invalid ones dropped; a stored add op must have its identifier). */
export function sanitizeOps(raw: unknown): LayerOp[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((op): op is LayerOp => {
        if (validateOp(op) !== null) return false;
        const value = op as LayerOp;
        return value.op !== 'add' || nonEmpty(value.prompt.identifier);
    });
}

/** Where a block stands in an order: after its predecessor, or at the start. */
export function anchorOf(order: readonly LayerOrderItem[], identifier: string): LayerAnchor | null {
    const index = order.findIndex((item) => item.identifier === identifier);
    if (index < 0) return null;
    const previous = order[index - 1];
    return previous ? { kind: 'after', identifier: previous.identifier } : { kind: 'start' };
}

/**
 * The op with the base values it changes (for strip), read from the base body. Toggles, moves, keys and the
 * non-text fields of an edit always take the values of this base; the text fingerprint of an edit is filled only
 * when missing (it belongs to the base the user edited).
 */
export function withOrigins(op: LayerOp, base: LayerBody | null): LayerOp {
    const copy = jsonCopy(op);
    if (!base) return copy;
    switch (copy.op) {
        case 'edit': {
            const block = findPrompt(base, copy.identifier);
            if (!block) return copy;
            const text = typeof block.content === 'string' ? block.content : '';
            if (!copy.baseHash) {
                copy.baseHash = textHash(text);
                copy.baseText = text;
            } else if (copy.baseText === undefined && copy.baseHash === textHash(text)) {
                copy.baseText = text;
            }
            const fields: Dict = {};
            const missing: string[] = [];
            for (const field of Object.keys(copy.patch)) {
                if (field === 'content' || field === 'identifier') continue;
                if (block[field] === undefined) missing.push(field);
                else fields[field] = jsonCopy(block[field]);
            }
            copy.baseFields = fields as Partial<LayerPrompt>;
            if (missing.length) copy.baseMissing = missing;
            else delete copy.baseMissing;
            return copy;
        }
        case 'toggle': {
            const entry = effectiveOrder(base).find((item) => item.identifier === copy.identifier);
            if (entry) copy.baseEnabled = entry.enabled;
            return copy;
        }
        case 'move': {
            const anchor = anchorOf(effectiveOrder(base), copy.identifier);
            if (anchor) copy.baseAnchor = anchor;
            else if (findPrompt(base, copy.identifier)) copy.baseAnchor = null;
            return copy;
        }
        case 'key':
            if (base[copy.key] !== undefined) {
                copy.baseValue = jsonCopy(base[copy.key]);
                delete copy.baseUnset;
            } else {
                copy.baseUnset = true;
                delete copy.baseValue;
            }
            return copy;
        default:
            return copy;
    }
}

/** Drops patch fields that equal the base (an edit back to the original); null when nothing is left. */
export function pruneOp(op: LayerOp): LayerOp | null {
    switch (op.op) {
        case 'edit': {
            const patch: Dict = { ...op.patch };
            if (typeof op.baseText === 'string' && patch.content === op.baseText) delete patch.content;
            for (const field of Object.keys(patch)) {
                if (field === 'content') continue;
                if (
                    op.baseFields &&
                    Object.hasOwn(op.baseFields, field) &&
                    valuesEqual(op.baseFields[field], patch[field])
                ) {
                    delete patch[field];
                }
            }
            if (!Object.keys(patch).length) return null;
            return { ...op, patch: patch as Partial<LayerPrompt> };
        }
        case 'toggle':
            return typeof op.baseEnabled === 'boolean' && op.baseEnabled === op.enabled ? null : op;
        case 'move':
            return op.baseAnchor && valuesEqual(op.baseAnchor, op.anchor) ? null : op;
        case 'key':
            return op.baseUnset !== true && Object.hasOwn(op, 'baseValue') && valuesEqual(op.baseValue, op.value)
                ? null
                : op;
        default:
            return op;
    }
}

/** A later op of the same key on top of an earlier one: the first base values win. */
function combine(existing: LayerOp, incoming: LayerOp): LayerOp {
    if (existing.op === 'edit' && incoming.op === 'edit') {
        const patch = { ...existing.patch, ...incoming.patch };
        const baseFields: Dict = {};
        const missing: string[] = [];
        for (const field of Object.keys(patch)) {
            if (field === 'content') continue;
            for (const source of [existing, incoming]) {
                if (source.baseFields && Object.hasOwn(source.baseFields, field)) {
                    baseFields[field] = source.baseFields[field];
                    break;
                }
                if (source.baseMissing?.includes(field)) {
                    missing.push(field);
                    break;
                }
            }
        }
        const merged: EditOp = {
            op: 'edit',
            identifier: existing.identifier,
            patch,
            baseHash: existing.baseHash || incoming.baseHash,
            baseFields: baseFields as Partial<LayerPrompt>,
        };
        const baseText = existing.baseHash ? existing.baseText : incoming.baseText;
        if (baseText !== undefined) merged.baseText = baseText;
        if (missing.length) merged.baseMissing = missing;
        return merged;
    }
    if (existing.op === 'toggle' && incoming.op === 'toggle') {
        const baseEnabled = existing.baseEnabled ?? incoming.baseEnabled;
        return baseEnabled === undefined ? { ...incoming } : { ...incoming, baseEnabled };
    }
    if (existing.op === 'move' && incoming.op === 'move') {
        const baseAnchor = existing.baseAnchor !== undefined ? existing.baseAnchor : incoming.baseAnchor;
        return baseAnchor === undefined ? { ...incoming } : { ...incoming, baseAnchor };
    }
    if (existing.op === 'key' && incoming.op === 'key') {
        const merged: KeyOp = { op: 'key', key: incoming.key, value: incoming.value };
        const source = Object.hasOwn(existing, 'baseValue') || existing.baseUnset ? existing : incoming;
        if (source.baseUnset) merged.baseUnset = true;
        else if (Object.hasOwn(source, 'baseValue')) merged.baseValue = source.baseValue;
        return merged;
    }
    return incoming;
}

export interface MergeResult {
    ops: LayerOp[];
    key: string;
    /** Position of the op in `ops` (or where it was, when it was dropped). */
    index: number;
    before: LayerOp | null;
    after: LayerOp | null;
}

/**
 * Records a studio edit into the ops: an edit, toggle or move of an own block changes its add op; otherwise the op
 * replaces the one of the same key (keeping the first base values) or is appended. An op that brings everything
 * back to the base is dropped.
 */
export function mergeOp(ops: readonly LayerOp[], incoming: LayerOp): MergeResult {
    const list = ops.map((op) => op);
    if (incoming.op === 'edit' || incoming.op === 'toggle' || incoming.op === 'move') {
        const at = list.findIndex((op) => op.op === 'add' && op.prompt.identifier === incoming.identifier);
        const add = list[at];
        if (add && add.op === 'add') {
            const next: AddOp = jsonCopy(add);
            if (incoming.op === 'edit') {
                next.prompt = normalizeOwnBlock({
                    ...next.prompt,
                    ...normalizePatch(incoming.patch),
                    identifier: add.prompt.identifier,
                } as LayerPrompt);
            } else if (incoming.op === 'toggle') {
                next.enabled = incoming.enabled;
            } else {
                next.anchor = jsonCopy(incoming.anchor);
            }
            list[at] = next;
            return { ops: list, key: opKey(add), index: at, before: add, after: next };
        }
    }
    const key = opKey(incoming);
    const index = list.findIndex((op) => opKey(op) === key);
    const existing = index >= 0 ? (list[index] ?? null) : null;
    const merged = pruneOp(existing ? combine(existing, incoming) : jsonCopy(incoming));
    if (existing) {
        if (merged) list[index] = merged;
        else list.splice(index, 1);
        return { ops: list, key, index, before: existing, after: merged };
    }
    if (merged) list.push(merged);
    return { ops: list, key, index: merged ? list.length - 1 : list.length, before: null, after: merged };
}

/** Puts `op` (or nothing) under `key`, at `index` when it was absent. */
export function setOpAt(ops: readonly LayerOp[], key: string, op: LayerOp | null, index?: number): LayerOp[] {
    const list = ops.filter((item) => opKey(item) !== key);
    if (!op) return list;
    const at = ops.findIndex((item) => opKey(item) === key);
    const position = at >= 0 ? at : (index ?? list.length);
    list.splice(Math.max(0, Math.min(position, list.length)), 0, jsonCopy(op));
    return list;
}

export type ConflictChoice = 'mine' | 'newBase' | { text: string };

/**
 * Resolves a text conflict of an op against the new base text: 'mine' rebases the edit (the patch stays, the base
 * fingerprint becomes the new base), 'newBase' drops the text change (and the op when nothing else is left), a
 * custom text replaces the patch text. An add op whose identifier the base now has becomes an edit of that block.
 */
export function resolveOp(op: LayerOp, choice: ConflictChoice, newBase: string): LayerOp | null {
    const rebased = { baseHash: textHash(newBase), baseText: newBase };
    if (op.op === 'add') {
        if (choice === 'newBase') return null;
        const text = choice === 'mine' ? (op.prompt.content ?? '') : choice.text;
        return pruneOp({ op: 'edit', identifier: op.prompt.identifier, patch: { content: text }, ...rebased });
    }
    if (op.op !== 'edit') return op;
    const patch: Dict = { ...op.patch };
    if (choice === 'newBase') delete patch.content;
    else if (choice !== 'mine') patch.content = choice.text;
    return pruneOp({ ...op, patch: patch as Partial<LayerPrompt>, ...rebased });
}

/* ------------------------------------------------------------------ fingerprints */

function pick(prompt: Dict, fields: readonly string[]): Dict {
    const out: Dict = {};
    for (const field of fields) out[field] = prompt[field] ?? null;
    return out;
}

/** What the layer decides in a body: one item per op (block fields, order place, key value). */
export function layerView(body: LayerBody, ops: readonly LayerOp[]): unknown[] {
    const order = effectiveOrder(body);
    const place = new Map(order.map((item, index) => [item.identifier, index]));
    const previous = (identifier: string): string | null => {
        const index = place.get(identifier);
        if (index === undefined) return null;
        return index === 0 ? '^' : (order[index - 1]?.identifier ?? null);
    };
    const enabled = (identifier: string): boolean | null => {
        const index = place.get(identifier);
        return index === undefined ? null : (order[index]?.enabled ?? null);
    };
    return ops.map((op) => {
        switch (op.op) {
            case 'add': {
                const id = op.prompt.identifier;
                const prompt = findPrompt(body, id);
                return ['add', id, prompt ? pick(prompt, BLOCK_FIELDS) : null, enabled(id), previous(id)];
            }
            case 'edit': {
                const prompt = findPrompt(body, op.identifier);
                return ['edit', op.identifier, prompt ? pick(prompt, Object.keys(op.patch).sort()) : null];
            }
            case 'toggle':
                return ['toggle', op.identifier, enabled(op.identifier)];
            case 'move':
                return ['move', op.identifier, previous(op.identifier)];
            default:
                return ['key', op.key, body[op.key] ?? null];
        }
    });
}

/** Fingerprint of the layer's part of a body: equal for the working copy and `applyLayer(base)` when it holds. */
export function layerFingerprint(body: LayerBody, ops: readonly LayerOp[]): string {
    return valueHash(layerView(body, ops));
}

/** Fingerprint of a base body (blocks, order, keys; `extensions` left out — ST rewrites it for regexes, P-152). */
export function baseFingerprint(body: LayerBody): string {
    const keys: Dict = {};
    for (const [key, value] of Object.entries(body)) if (!RESERVED_KEYS.includes(key)) keys[key] = value;
    const prompts = promptsOf(body)
        .map((prompt) => [prompt.identifier, pick(prompt, BLOCK_FIELDS)] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return valueHash({ prompts, order: globalOrder(body), keys });
}

/**
 * The candidate holds the saved base: every saved block with the same fields, the same global order (when the base
 * has one) and the same values for the base keys the candidate knows. Blocks ST adds itself (missing defaults) and
 * keys the file lacks do not count.
 */
export function baseMatches(saved: LayerBody, candidate: LayerBody): boolean {
    for (const prompt of promptsOf(saved)) {
        const other = findPrompt(candidate, prompt.identifier);
        if (!other || !valuesEqual(pick(prompt, BLOCK_FIELDS), pick(other, BLOCK_FIELDS))) return false;
    }
    const order = globalOrder(saved);
    if (order && !valuesEqual(order, globalOrder(candidate))) return false;
    for (const [key, value] of Object.entries(saved)) {
        if (RESERVED_KEYS.includes(key) || !Object.hasOwn(candidate, key)) continue;
        if (!valuesEqual(value, candidate[key])) return false;
    }
    return true;
}
