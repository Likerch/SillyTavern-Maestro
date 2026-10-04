// Pure order helpers of the Preset Studio (M34): moving rows by drag or ↑/↓ (P-023, P-017), turning a reorder into
// the fewest «move» operations of the user's layer (anchored after the preceding block, layer-api.ts), ST's
// prompt-list import order rule (P-031) and detaching / inserting blocks (P-026, P-028).

export interface OrderEntry {
    identifier: string;
    enabled: boolean;
}

/** An anchor of a «move» layer operation (structurally a LayerAnchor). */
export type MoveAnchor = { kind: 'after'; identifier: string } | { kind: 'start' };

export interface MoveOp {
    identifier: string;
    anchor: MoveAnchor;
}

/** A copy of the list with the item at `from` moved to `to` (indices clamped). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
    const copy = [...list];
    if (from < 0 || from >= copy.length) return copy;
    const target = Math.max(0, Math.min(copy.length - 1, to));
    const [item] = copy.splice(from, 1);
    copy.splice(target, 0, item as T);
    return copy;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Indices (into `values`) of one longest strictly increasing subsequence, O(n log n). */
function longestIncreasing(values: readonly number[]): Set<number> {
    const tails: number[] = [];
    const previous: number[] = new Array<number>(values.length).fill(-1);
    for (let index = 0; index < values.length; index++) {
        const value = values[index] as number;
        let low = 0;
        let high = tails.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if ((values[tails[middle] as number] as number) < value) low = middle + 1;
            else high = middle;
        }
        if (low > 0) previous[index] = tails[low - 1] as number;
        tails[low] = index;
    }
    const kept = new Set<number>();
    let cursor = tails.length ? (tails[tails.length - 1] as number) : -1;
    while (cursor >= 0) {
        kept.add(cursor);
        cursor = previous[cursor] as number;
    }
    return kept;
}

/**
 * The fewest moves that turn `before` into `after` (blocks off the longest common ordered run), each anchored after
 * the block that precedes it in `after` (or at the start). Applied left to right they rebuild `after`. Identifiers
 * only in one list are ignored (adds and removals are not moves). `moved` names the blocks the user moved: they are
 * the ones recorded as moves (a swap of neighbours could be told either way).
 */
export function moveOps(before: readonly string[], after: readonly string[], moved: readonly string[] = []): MoveOp[] {
    const position = new Map(before.map((identifier, index) => [identifier, index]));
    const common = after.filter((identifier) => position.has(identifier));
    const forced = new Set(moved);
    const candidates = common
        .map((identifier, index) => ({ identifier, index }))
        .filter((item) => !forced.has(item.identifier));
    const run = longestIncreasing(candidates.map((item) => position.get(item.identifier) as number));
    const kept = new Set([...run].map((at) => (candidates[at] as { index: number }).index));
    const ops: MoveOp[] = [];
    common.forEach((identifier, index) => {
        if (kept.has(index)) return;
        const at = after.indexOf(identifier);
        const previous = at > 0 ? after[at - 1] : undefined;
        ops.push({ identifier, anchor: previous ? { kind: 'after', identifier: previous } : { kind: 'start' } });
    });
    return ops;
}

/**
 * ST's prompt-list import (P-031): `Object.assign(current, imported)` writes the imported entries over the current
 * ones by index without truncating, so older entries past the imported length stay at the end. The studio keeps
 * that rule but drops the duplicates it would create (first occurrence wins) and invalid entries.
 */
export function mergeImportedOrder(current: readonly OrderEntry[], imported: readonly unknown[]): OrderEntry[] {
    const valid: OrderEntry[] = [];
    for (const item of imported) {
        if (!item || typeof item !== 'object') continue;
        const { identifier, enabled } = item as { identifier?: unknown; enabled?: unknown };
        if (typeof identifier !== 'string' || !identifier) continue;
        valid.push({ identifier, enabled: enabled === true });
    }
    const merged = [...valid, ...current.slice(valid.length)];
    const seen = new Set<string>();
    return merged.filter((entry) => {
        if (seen.has(entry.identifier)) return false;
        seen.add(entry.identifier);
        return true;
    });
}

/** P-026: the block leaves the order, the block itself stays. */
export function detachFromOrder(order: readonly string[], identifier: string): string[] {
    return order.filter((item) => item !== identifier);
}

/** P-028: «Вставить промпт» puts the block at the start (disabled), only if it is not listed yet. */
export function insertAtStart(order: readonly string[], identifier: string): string[] {
    return order.includes(identifier) ? [...order] : [identifier, ...order];
}

/** The identifier a new block goes after: the given one when listed, otherwise the last block (or none). */
export function anchorFor(order: readonly string[], after: string | null | undefined): string | undefined {
    if (after && order.includes(after)) return after;
    return order.length ? order[order.length - 1] : undefined;
}
