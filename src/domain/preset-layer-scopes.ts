// «Области действия» of «Твой слой» (M34, plan-2 «везде / персонаж / чат»): the layer of a base preset has a global
// part, a part of the card and a part of the chat, laid over the base in that order. Pure helpers: the stored
// document of a card or a chat, applying the parts one after another (conflicts and lost ops tagged with their scope),
// stripping some of them, telling whether a body holds a part (ST's own saves are written without the character and
// chat parts), and an op without the base values of the scope it came from (moving it to another scope).
import { applyLayer, emptyReport, isDict, stripLayer } from './preset-layer-apply';
import type { LayerApplyReport, LayerBody, LayerConflict, LayerOp } from './preset-layer-apply';
import { layerFingerprint, sanitizeOps } from './preset-layer-ops';
import { jsonCopy } from './settings-diff';

export type Scope = 'global' | 'character' | 'chat';

export const SCOPES: readonly Scope[] = ['global', 'character', 'chat'];

/** The scopes a chat switch changes (stored per card / per chat). */
export const CHAT_SCOPES: readonly ('character' | 'chat')[] = ['character', 'chat'];

/** The layer part of one card or one chat, per base preset name, and the preset bound to it. */
export interface ScopeLayerDoc {
    layers: Record<string, { ops: LayerOp[]; updatedAt: number }>;
    binding: { preset: string; at: number } | null;
}

export function emptyScopeDoc(): ScopeLayerDoc {
    return { layers: {}, binding: null };
}

/** Valid ops only; scope tags (`scope`, `owner`) are never stored in an op. */
export function plainOps(raw: unknown): LayerOp[] {
    return sanitizeOps(raw).map((op) => plainOp(op));
}

/** The op without the tags `get()` adds (a tagged op passed back to `record()`). */
export function plainOp<T extends LayerOp>(op: T): T {
    const copy = jsonCopy(op) as T & { scope?: unknown; owner?: unknown };
    delete copy.scope;
    delete copy.owner;
    return copy;
}

export function sanitizeScopeDoc(raw: unknown): ScopeLayerDoc {
    const doc = emptyScopeDoc();
    if (!isDict(raw)) return doc;
    if (isDict(raw.layers)) {
        for (const [base, value] of Object.entries(raw.layers)) {
            if (!base || !isDict(value)) continue;
            const ops = plainOps(value.ops);
            if (!ops.length) continue;
            doc.layers[base] = { ops, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 };
        }
    }
    const binding = raw.binding;
    if (isDict(binding) && typeof binding.preset === 'string' && binding.preset) {
        doc.binding = { preset: binding.preset, at: typeof binding.at === 'number' ? binding.at : 0 };
    }
    return doc;
}

/** One scope's ops for a base, in application order. */
export interface ScopeOps {
    scope: Scope;
    ops: readonly LayerOp[];
}

export type TaggedConflict = LayerConflict & { scope?: Scope };

/**
 * Lays the parts over the base one after another (the same result as applying their concatenation): the report says
 * which part a conflict or a lost op belongs to (global ones stay untagged, like before scopes existed).
 */
export function applyScoped(
    base: LayerBody,
    parts: readonly ScopeOps[],
): { body: LayerBody; report: LayerApplyReport } {
    let body = base;
    const report = emptyReport();
    for (const part of parts) {
        if (!part.ops.length) continue;
        const result = applyLayer(body, part.ops);
        body = result.body;
        report.applied += result.report.applied;
        for (const conflict of result.report.conflicts) {
            report.conflicts.push(part.scope === 'global' ? conflict : { ...conflict, scope: part.scope });
        }
        for (const op of result.report.orphaned) {
            report.orphaned.push(part.scope === 'global' ? op : ({ ...op, scope: part.scope } as unknown as LayerOp));
        }
    }
    return { body, report };
}

/**
 * Takes the parts out again, the last one first. A part goes back to what the parts below it give, not to the base
 * values its ops remembered when they were recorded: an edit made «везде» after a chat edit of the same value would
 * otherwise come back as the old base once the chat's part is stripped (chat 0.2, then everywhere 0.9 → leaving the
 * chat gave the old 1.0).
 */
export function stripScoped(
    body: LayerBody,
    parts: readonly ScopeOps[],
    /** Parts that stay laid under the stripped ones (the global part when a chat switch strips the card's and chat's). */
    under: readonly ScopeOps[] = [],
): LayerBody {
    let result = body;
    for (let index = parts.length - 1; index >= 0; index--) {
        const part = parts[index];
        if (!part?.ops.length) continue;
        const below = flatOps([...under, ...parts.slice(0, index)]);
        result = stripLayer(result, below.length ? part.ops.map((op) => withBaseBelow(op, below)) : part.ops);
    }
    return result;
}

/** The op with its base values taken from the last op below it that sets the same thing (unchanged when none does). */
export function withBaseBelow(op: LayerOp, below: readonly LayerOp[]): LayerOp {
    const last = <T extends LayerOp>(match: (candidate: LayerOp) => candidate is T): T | undefined => {
        for (let index = below.length - 1; index >= 0; index--) {
            const candidate = below[index];
            if (candidate && match(candidate)) return candidate;
        }
        return undefined;
    };
    const added = (identifier: string) =>
        last((candidate): candidate is Extract<LayerOp, { op: 'add' }> => {
            return candidate.op === 'add' && candidate.prompt.identifier === identifier;
        });
    switch (op.op) {
        case 'key': {
            const lower = last((candidate): candidate is Extract<LayerOp, { op: 'key' }> => {
                return candidate.op === 'key' && candidate.key === op.key;
            });
            if (!lower) return op;
            const copy = { ...op, baseValue: jsonCopy(lower.value) };
            delete copy.baseUnset;
            return copy;
        }
        case 'toggle': {
            const lower = last((candidate): candidate is Extract<LayerOp, { op: 'toggle' }> => {
                return candidate.op === 'toggle' && candidate.identifier === op.identifier;
            });
            if (lower) return { ...op, baseEnabled: lower.enabled };
            const add = added(op.identifier);
            return add ? { ...op, baseEnabled: add.enabled } : op;
        }
        case 'move': {
            const lower = last((candidate): candidate is Extract<LayerOp, { op: 'move' }> => {
                return candidate.op === 'move' && candidate.identifier === op.identifier;
            });
            if (lower) return { ...op, baseAnchor: jsonCopy(lower.anchor) };
            const add = added(op.identifier);
            return add ? { ...op, baseAnchor: jsonCopy(add.anchor) } : op;
        }
        case 'edit': {
            const copy = { ...op, baseFields: { ...(op.baseFields ?? {}) } };
            const add = added(op.identifier);
            const edits = below.filter(
                (candidate): candidate is Extract<LayerOp, { op: 'edit' }> =>
                    candidate.op === 'edit' && candidate.identifier === op.identifier,
            );
            let touched = false;
            for (const field of Object.keys(op.patch)) {
                // The last op below that sets the field: an edit, else the block the layer added.
                let value: unknown;
                let found = false;
                for (let index = edits.length - 1; index >= 0 && !found; index--) {
                    const patch = edits[index]?.patch as Record<string, unknown> | undefined;
                    if (patch && Object.hasOwn(patch, field)) {
                        value = patch[field];
                        found = true;
                    }
                }
                if (!found && add && Object.hasOwn(add.prompt, field)) {
                    value = (add.prompt as unknown as Record<string, unknown>)[field];
                    found = true;
                }
                if (!found) continue;
                touched = true;
                if (field === 'content') {
                    if (typeof value === 'string') copy.baseText = value;
                } else {
                    (copy.baseFields as Record<string, unknown>)[field] = jsonCopy(value);
                    if (copy.baseMissing) copy.baseMissing = copy.baseMissing.filter((name) => name !== field);
                }
            }
            return touched ? copy : op;
        }
        default:
            return op;
    }
}

/** All ops of the parts, in order. */
export function flatOps(parts: readonly ScopeOps[]): LayerOp[] {
    return parts.flatMap((part) => [...part.ops]);
}

/**
 * The body holds the parts: laying them over it again changes nothing they decide. Used to tell a body built from the
 * working copy (ST's «Обновить пресет») from one the studio already wrote without them.
 */
export function holdsParts(body: LayerBody, parts: readonly ScopeOps[]): boolean {
    const ops = flatOps(parts);
    if (!ops.length) return false;
    const again = applyScoped(body, parts).body;
    return layerFingerprint(body, ops) === layerFingerprint(again, ops);
}

/**
 * The op as made anew in another scope: the base values of the old scope are dropped (an edit keeps its patch and gets
 * the fingerprint of the base below its new scope when it is recorded there).
 */
export function rebaseOp(op: LayerOp): LayerOp {
    const copy = plainOp(op) as LayerOp & Record<string, unknown>;
    switch (copy.op) {
        case 'edit':
            copy.baseHash = '';
            delete copy.baseText;
            delete copy.baseFields;
            delete copy.baseMissing;
            break;
        case 'toggle':
            delete copy.baseEnabled;
            break;
        case 'move':
            delete copy.baseAnchor;
            break;
        case 'key':
            delete copy.baseValue;
            delete copy.baseUnset;
            break;
        default:
            break;
    }
    return copy;
}
