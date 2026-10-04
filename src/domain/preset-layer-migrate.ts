// «Твой слой» (M34 п.5–6): turning differences into layer ops. Three jobs, all pure:
// - planMigration (Q23): the user's current Marinara (the edited working body) against a reference base (the
//   original file, or the saved body of the base preset) becomes ops whose application to the reference reproduces
//   the edited blocks, global order and base keys;
// - transferOps: a layer moved onto another preset — anchors by identifier first, else by a neighbouring block's
//   text (e.g. «after `</task>`»), else at the end and reported;
// - splitForeign (п.6): a foreign preset split into blocks the user can pick into the layer.
import {
    contentOf,
    effectiveOrder,
    findPrompt,
    globalOrder,
    isDict,
    MARKER_IDS,
    normalizeOwnBlock,
    promptsOf,
    RESERVED_KEYS,
    SENSITIVE_KEYS,
    SYSTEM_PROMPT_IDS,
    textHash,
    CHARACTER_ORDER_ID,
} from './preset-layer-apply';
import type { AddOp, EditOp, LayerAnchor, LayerBody, LayerOp, LayerOrderItem, LayerPrompt } from './preset-layer-apply';
import { anchorOf } from './preset-layer-ops';
import { jsonCopy, valuesEqual } from './settings-diff';

type Dict = Record<string, unknown>;

/** Block fields a migration compares (the kind flags of a base block never change). */
const EDIT_FIELDS = [
    'name',
    'role',
    'content',
    'injection_position',
    'injection_depth',
    'injection_order',
    'injection_trigger',
    'forbid_overrides',
] as const;

/**
 * Values Prompt Manager's form writes for fields a file may omit (PM:182-195, PM:902-920): saving a block in the
 * classic editor adds them without changing anything.
 */
const FORM_DEFAULTS: Dict = {
    role: 'system',
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    injection_trigger: [],
    forbid_overrides: false,
};

/** Text anchors shorter than this match too much. */
const MIN_TEXT_ANCHOR = 4;

export interface MigrationPlan {
    ops: LayerOp[];
    /** Base blocks the edited body took out of the order (switched off by the layer instead). */
    removed: string[];
}

/** Longest common subsequence of two id lists: the blocks that keep their relative order. */
function longestCommon(a: readonly string[], b: readonly string[]): Set<string> {
    const width = b.length + 1;
    const table = new Array<number>((a.length + 1) * width).fill(0);
    const cell = (i: number, j: number) => table[i * width + j] ?? 0;
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i * width + j] = a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
        }
    }
    const kept = new Set<string>();
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const left = a[i];
        if (left !== undefined && left === b[j]) {
            kept.add(left);
            i++;
            j++;
        } else if (cell(i + 1, j) >= cell(i, j + 1)) i++;
        else j++;
    }
    return kept;
}

function editOf(base: LayerPrompt, edited: LayerPrompt): EditOp | null {
    const patch: Dict = {};
    for (const field of EDIT_FIELDS) {
        const value = edited[field];
        if (value === undefined) continue;
        const original = base[field];
        if (original === undefined && Object.hasOwn(FORM_DEFAULTS, field) && valuesEqual(value, FORM_DEFAULTS[field])) {
            continue;
        }
        if (valuesEqual(original ?? null, value)) continue;
        patch[field] = jsonCopy(value);
    }
    if (base.marker === true) delete patch.content;
    if (!Object.keys(patch).length) return null;
    const text = contentOf(base);
    const fields: Dict = {};
    const missing: string[] = [];
    for (const field of Object.keys(patch)) {
        if (field === 'content') continue;
        if (base[field] === undefined) missing.push(field);
        else fields[field] = jsonCopy(base[field]);
    }
    const edit: EditOp = {
        op: 'edit',
        identifier: base.identifier,
        patch: patch as Partial<LayerPrompt>,
        baseHash: textHash(text),
        baseText: text,
        baseFields: fields as Partial<LayerPrompt>,
    };
    if (missing.length) edit.baseMissing = missing;
    return edit;
}

/**
 * Differences between a reference base and the edited body as layer ops (Q23). The order is rebuilt by walking the
 * edited order: blocks that keep their place relative to each other (LCS) stay, every other block is added or moved
 * right after its edited predecessor — applied in sequence, this reproduces the edited order exactly. Then toggles,
 * text and field edits (fingerprinted against the reference) and base key changes. Keys the reference lacks are
 * left out (a body from ST has all 103 keys, mostly defaults); secrets are never stored. The layer cannot delete a
 * base block: one the edited order dropped is switched off and reported in `removed`. chatHistory is never switched
 * off (P-130).
 */
export function planMigration(reference: LayerBody, edited: LayerBody): MigrationPlan {
    const basePrompts = new Map(promptsOf(reference).map((prompt) => [prompt.identifier, prompt]));
    const editedPrompts = new Map(promptsOf(edited).map((prompt) => [prompt.identifier, prompt]));
    const baseOrder = effectiveOrder(reference);
    const editedOrder = effectiveOrder(edited);
    const baseEntries = new Map(baseOrder.map((item) => [item.identifier, item]));
    const editedIds = new Set(editedOrder.map((item) => item.identifier));
    const kept = longestCommon(
        baseOrder.map((item) => item.identifier).filter((id) => editedIds.has(id)),
        editedOrder.map((item) => item.identifier).filter((id) => baseEntries.has(id)),
    );
    const ops: LayerOp[] = [];
    const toggles: LayerOp[] = [];
    const seen = new Set<string>();
    let previous: string | null = null;
    for (const entry of editedOrder) {
        const id = entry.identifier;
        if (seen.has(id)) continue;
        seen.add(id);
        const anchor: LayerAnchor = previous ? { kind: 'after', identifier: previous } : { kind: 'start' };
        const base = baseEntries.get(id);
        if (base) {
            if (!kept.has(id)) ops.push({ op: 'move', identifier: id, anchor, baseAnchor: anchorOf(baseOrder, id) });
            if (base.enabled !== entry.enabled && !(id === 'chatHistory' && !entry.enabled)) {
                toggles.push({ op: 'toggle', identifier: id, enabled: entry.enabled, baseEnabled: base.enabled });
            }
        } else if (basePrompts.has(id)) {
            // A base block that was outside the base order (inserted with «Вставить промпт», P-028).
            ops.push({ op: 'move', identifier: id, anchor, baseAnchor: null });
            if (entry.enabled) toggles.push({ op: 'toggle', identifier: id, enabled: true });
        } else {
            const prompt = editedPrompts.get(id);
            if (!prompt) continue; // a dangling order entry: Prompt Manager drops it (P-037)
            ops.push({ op: 'add', prompt: normalizeOwnBlock(prompt), anchor, enabled: entry.enabled });
        }
        previous = id;
    }
    // Own blocks outside the edited order are kept switched off at the end rather than lost.
    for (const prompt of editedPrompts.values()) {
        const id = prompt.identifier;
        if (basePrompts.has(id) || editedIds.has(id) || MARKER_IDS.includes(id)) continue;
        ops.push({ op: 'add', prompt: normalizeOwnBlock(prompt), anchor: { kind: 'end' }, enabled: false });
    }
    ops.push(...toggles);
    for (const [id, base] of basePrompts) {
        const prompt = editedPrompts.get(id);
        const edit = prompt ? editOf(base, prompt) : null;
        if (edit) ops.push(edit);
    }
    for (const [key, original] of Object.entries(reference)) {
        if (RESERVED_KEYS.includes(key) || SENSITIVE_KEYS.includes(key)) continue;
        const value = edited[key];
        if (value === undefined || valuesEqual(original, value)) continue;
        ops.push({ op: 'key', key, value: jsonCopy(value), baseValue: jsonCopy(original) });
    }
    const removed: string[] = [];
    for (const entry of baseOrder) {
        const id = entry.identifier;
        if (editedIds.has(id) || !basePrompts.has(id)) continue;
        removed.push(id);
        if (entry.enabled && id !== 'chatHistory') {
            ops.push({ op: 'toggle', identifier: id, enabled: false, baseEnabled: true });
        }
    }
    return { ops, removed };
}

/* ------------------------------------------------------------------ transfer */

export interface TransferResult {
    ops: LayerOp[];
    /** Ops that did not fit: adds placed at the end (switched off), edits/toggles/moves left behind. */
    orphaned: LayerOp[];
}

/** Lines of a block that can serve as a portable anchor: the last one first (`</task>`), then the first. */
function textCandidates(text: string): string[] {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_TEXT_ANCHOR);
    const last = lines.at(-1);
    const first = lines[0];
    const out: string[] = [];
    if (last) out.push(last);
    if (first && first !== last) out.push(first);
    return out;
}

/**
 * Copies ops of one base onto another. Anchors resolve by identifier (an own block of the layer, or a block of the
 * target order), then by the same block name, then by a text anchor taken from the source neighbour's content
 * (unique matches preferred); an add that still has no place goes to the end switched off and is reported. Edits,
 * toggles and moves need their block in the target (identifier or unique name); edits keep their base fingerprint,
 * so a different target text shows up as a conflict, never as a silent overwrite.
 */
export function transferOps(ops: readonly LayerOp[], from: LayerBody | null, to: LayerBody | null): TransferResult {
    if (!to) return { ops: ops.map((op) => jsonCopy(op)), orphaned: [] };
    const targetPrompts = promptsOf(to);
    const targetIds = new Set(targetPrompts.map((prompt) => prompt.identifier));
    const targetOrder = effectiveOrder(to);
    const ordered = new Set(targetOrder.map((item) => item.identifier));
    const own = new Set(ops.filter((op): op is AddOp => op.op === 'add').map((op) => op.prompt.identifier));
    const sourceOrder = from ? effectiveOrder(from) : [];
    const content = (identifier: string) => contentOf(findPrompt(to, identifier));

    const byName = (identifier: string): string | null => {
        const name = from ? findPrompt(from, identifier)?.name : undefined;
        if (!name) return null;
        const matches = targetPrompts.filter((prompt) => prompt.name === name);
        return matches.length === 1 ? (matches[0]?.identifier ?? null) : null;
    };
    const blockIn = (identifier: string): string | null =>
        targetIds.has(identifier) ? identifier : byName(identifier);
    const textAnchor = (identifier: string): LayerAnchor | null => {
        const candidates = textCandidates(contentOf(from ? findPrompt(from, identifier) : undefined));
        const hits = (text: string) => targetOrder.filter((item) => content(item.identifier).includes(text)).length;
        const unique = candidates.find((text) => hits(text) === 1);
        const any = unique ?? candidates.find((text) => hits(text) > 1);
        return any ? { kind: 'afterText', text: any } : null;
    };
    const placeAfter = (identifier: string): LayerAnchor | null => {
        if (own.has(identifier) || ordered.has(identifier)) return { kind: 'after', identifier };
        const named = byName(identifier);
        if (named && ordered.has(named)) return { kind: 'after', identifier: named };
        return textAnchor(identifier);
    };
    const resolve = (anchor: LayerAnchor): LayerAnchor | null => {
        switch (anchor.kind) {
            case 'after':
                return placeAfter(anchor.identifier);
            case 'before': {
                if (own.has(anchor.identifier) || ordered.has(anchor.identifier)) return anchor;
                const named = byName(anchor.identifier);
                if (named && ordered.has(named)) return { kind: 'before', identifier: named };
                const index = sourceOrder.findIndex((item) => item.identifier === anchor.identifier);
                if (index === 0) return { kind: 'start' };
                const previous = sourceOrder[index - 1];
                return previous ? placeAfter(previous.identifier) : null;
            }
            case 'afterText':
                return targetOrder.some((item) => content(item.identifier).includes(anchor.text)) ? anchor : null;
            default:
                return anchor;
        }
    };

    const out: LayerOp[] = [];
    const orphaned: LayerOp[] = [];
    for (const source of ops) {
        const op = jsonCopy(source);
        switch (op.op) {
            case 'key':
                out.push(op);
                break;
            case 'add': {
                const anchor = resolve(op.anchor);
                const next: AddOp = anchor ? { ...op, anchor } : { ...op, anchor: { kind: 'end' }, enabled: false };
                out.push(next);
                if (!anchor) orphaned.push(next);
                break;
            }
            case 'edit': {
                const id = blockIn(op.identifier);
                if (id) out.push({ ...op, identifier: id });
                else orphaned.push(op);
                break;
            }
            case 'toggle': {
                const id = blockIn(op.identifier);
                if (id && ordered.has(id)) out.push({ ...op, identifier: id });
                else orphaned.push(op);
                break;
            }
            default: {
                const id = blockIn(op.identifier);
                const anchor = id ? resolve(op.anchor) : null;
                if (id && anchor) out.push({ ...op, identifier: id, anchor });
                else orphaned.push(op);
            }
        }
    }
    return { ops: out, orphaned };
}

/* ------------------------------------------------------------------ import of a foreign preset */

/** The order a foreign preset shows: 100001, else 100000, else its first list. */
function foreignOrder(body: LayerBody): LayerOrderItem[] {
    const global = globalOrder(body);
    if (global) return global;
    const lists = Array.isArray(body.prompt_order) ? body.prompt_order.filter(isDict) : [];
    const legacy = lists.find((list) => String(list.character_id) === String(CHARACTER_ORDER_ID)) ?? lists[0];
    const raw: unknown[] = legacy && Array.isArray(legacy.order) ? legacy.order : [];
    return raw.filter(
        (item): item is LayerOrderItem => isDict(item) && typeof item.identifier === 'string' && item.identifier !== '',
    );
}

/**
 * Blocks of a foreign preset for picking into the layer (п.6): in the preset's order, then the blocks outside it;
 * markers and empty ST defaults (main, nsfw, jailbreak, enhanceDefinitions placeholders) skipped; names kept; strict
 * types of an own block (P-132), so a picked block is sent by ST as it is.
 */
export function splitForeign(body: LayerBody): LayerPrompt[] {
    if (!isDict(body)) return [];
    const prompts = promptsOf(body);
    const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
    const sequence: LayerPrompt[] = [];
    const seen = new Set<string>();
    const take = (prompt: LayerPrompt | undefined) => {
        if (!prompt || seen.has(prompt.identifier)) return;
        seen.add(prompt.identifier);
        sequence.push(prompt);
    };
    for (const item of foreignOrder(body)) take(byId.get(item.identifier));
    for (const prompt of prompts) take(prompt);
    return sequence
        .filter((prompt) => prompt.marker !== true && !MARKER_IDS.includes(prompt.identifier))
        .filter((prompt) => !(SYSTEM_PROMPT_IDS.includes(prompt.identifier) && !contentOf(prompt).trim()))
        .map((prompt) => normalizeOwnBlock(prompt));
}
