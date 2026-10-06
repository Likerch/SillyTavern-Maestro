// Comparing two Chat Completion preset bodies (M34, for the assistant's «сравни два пресета» and the prompt audit):
// blocks added, removed and changed (by field), blocks switched on or off and the order of the global list, and the
// body parameters that differ. Addresses and passwords are never shown, only that they differ. Pure.
import { effectiveOrder, promptsOf, RESERVED_KEYS, SENSITIVE_KEYS } from './preset-layer-apply';
import type { LayerBody } from './preset-layer-apply';
import { BLOCK_FIELDS } from './preset-layer-ops';
import { looseEqual } from './preset-store-diff';

export interface CompareBlock {
    identifier: string;
    /** The block's name (in `b` when it has it, else in `a`). */
    name: string;
}

export interface PresetComparison {
    /** Blocks only `b` has. */
    added: CompareBlock[];
    /** Blocks only `a` has. */
    removed: CompareBlock[];
    /** Blocks both have, with the fields that differ (`content`, `role`, `injection_depth`…). */
    changed: (CompareBlock & { fields: string[] })[];
    /** Blocks on in one global order and off (or missing, null) in the other. */
    toggled: (CompareBlock & { a: boolean | null; b: boolean | null })[];
    /** The blocks both orders list stand in a different order. */
    reordered: boolean;
    /** Body parameters that differ; sensitive values are replaced by '•••'. */
    params: { key: string; a: unknown; b: unknown }[];
}

export const MASKED = '•••';

/** Defaults Prompt Manager fills for missing block fields (so «absent» and «the default» compare equal). */
const FIELD_DEFAULTS: Record<string, unknown> = {
    role: 'system',
    content: '',
    injection_position: 0,
    injection_depth: 4,
    injection_order: 100,
    injection_trigger: [],
    forbid_overrides: false,
    system_prompt: false,
    marker: false,
};

function nameOf(prompt: Record<string, unknown> | undefined, identifier: string): string {
    return typeof prompt?.name === 'string' && prompt.name.trim() ? prompt.name.trim() : identifier;
}

function field(prompt: Record<string, unknown>, key: string): unknown {
    return prompt[key] ?? FIELD_DEFAULTS[key] ?? null;
}

export function comparePresets(a: LayerBody, b: LayerBody): PresetComparison {
    const result: PresetComparison = { added: [], removed: [], changed: [], toggled: [], reordered: false, params: [] };
    const left = new Map(promptsOf(a).map((prompt) => [prompt.identifier, prompt]));
    const right = new Map(promptsOf(b).map((prompt) => [prompt.identifier, prompt]));
    for (const [identifier, prompt] of right) {
        const before = left.get(identifier);
        if (!before) {
            result.added.push({ identifier, name: nameOf(prompt, identifier) });
            continue;
        }
        const fields = BLOCK_FIELDS.filter((key) => !looseEqual(field(before, key), field(prompt, key)));
        if (fields.length) result.changed.push({ identifier, name: nameOf(prompt, identifier), fields: [...fields] });
    }
    for (const [identifier, prompt] of left) {
        if (!right.has(identifier)) result.removed.push({ identifier, name: nameOf(prompt, identifier) });
    }
    const orderA = effectiveOrder(a);
    const orderB = effectiveOrder(b);
    const stateA = new Map(orderA.map((item) => [item.identifier, item.enabled !== false]));
    const stateB = new Map(orderB.map((item) => [item.identifier, item.enabled !== false]));
    for (const identifier of new Set([...stateA.keys(), ...stateB.keys()])) {
        const was = stateA.get(identifier) ?? null;
        const now = stateB.get(identifier) ?? null;
        if (was === now) continue;
        const prompt = right.get(identifier) ?? left.get(identifier);
        result.toggled.push({ identifier, name: nameOf(prompt, identifier), a: was, b: now });
    }
    const common = (order: typeof orderA, other: Map<string, boolean>) =>
        order.filter((item) => other.has(item.identifier)).map((item) => item.identifier);
    result.reordered = common(orderA, stateB).join('\n') !== common(orderB, stateA).join('\n');
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((key) => !RESERVED_KEYS.includes(key)));
    for (const key of [...keys].sort()) {
        if (looseEqual(a[key] ?? null, b[key] ?? null)) continue;
        const secret = SENSITIVE_KEYS.includes(key);
        result.params.push({
            key,
            a: secret && a[key] !== undefined ? MASKED : (a[key] ?? null),
            b: secret && b[key] !== undefined ? MASKED : (b[key] ?? null),
        });
    }
    return result;
}

/** True when nothing differs. */
export function sameBodies(comparison: PresetComparison): boolean {
    return (
        !comparison.added.length &&
        !comparison.removed.length &&
        !comparison.changed.length &&
        !comparison.toggled.length &&
        !comparison.reordered &&
        !comparison.params.length
    );
}
