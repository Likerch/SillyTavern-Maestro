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

/** Takes the parts out again, the last one first. */
export function stripScoped(body: LayerBody, parts: readonly ScopeOps[]): LayerBody {
    let result = body;
    for (const part of [...parts].reverse()) if (part.ops.length) result = stripLayer(result, part.ops);
    return result;
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
