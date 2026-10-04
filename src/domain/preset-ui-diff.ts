// «Было / стало» of two Chat Completion preset bodies for the Preset Studio's versions and layer views (M34 п. 4):
// blocks added, removed and changed field by field, the active order (moves, toggles), and body keys. Secret keys are
// never shown (P-096): their values are masked, only «changed» is visible.
import { promptName } from './preset-ui-blocks';
import type { PromptLike } from './preset-ui-blocks';
import { moveOps } from './preset-ui-order';
import type { OrderEntry } from './preset-ui-order';

/** P-096 (OAI:287-299). */
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

export const MASK = '••••••';

/** The global prompt list of Chat Completion (P-034). */
export const ACTIVE_ORDER_ID = 100001;

export interface FieldChange {
    field: string;
    before: unknown;
    after: unknown;
}

export interface PromptChange {
    identifier: string;
    name: string;
    kind: 'added' | 'removed' | 'changed';
    fields: FieldChange[];
}

export interface OrderChange {
    moved: string[];
    enabled: string[];
    disabled: string[];
    added: string[];
    removed: string[];
}

export interface KeyChange {
    key: string;
    before: unknown;
    after: unknown;
    sensitive: boolean;
}

export interface PresetDiff {
    prompts: PromptChange[];
    order: OrderChange;
    keys: KeyChange[];
    /** Nothing differs. */
    same: boolean;
}

type BodyLike = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(a: unknown, b: unknown): boolean {
    return stable(a) === stable(b);
}

function stable(value: unknown): string {
    if (value === undefined) return 'undefined';
    return JSON.stringify(value, (_key, item: unknown) =>
        isRecord(item)
            ? Object.fromEntries(
                  Object.keys(item)
                      .sort()
                      .map((key) => [key, item[key]]),
              )
            : item,
    );
}

export function promptsOf(body: BodyLike | null | undefined): PromptLike[] {
    const list = body?.prompts;
    return Array.isArray(list)
        ? list.filter((item): item is PromptLike => isRecord(item) && typeof item.identifier === 'string')
        : [];
}

/** The active (100001) order of a body; the first list when 100001 is missing (Default.json has 100000, P-081). */
export function activeOrderOf(body: BodyLike | null | undefined): OrderEntry[] {
    const lists = body?.prompt_order;
    if (!Array.isArray(lists)) return [];
    const records = lists.filter(isRecord);
    const list = records.find((item) => String(item.character_id) === String(ACTIVE_ORDER_ID)) ?? records[0];
    const order = list?.order;
    if (!Array.isArray(order)) return [];
    return order
        .filter(isRecord)
        .filter((item) => typeof item.identifier === 'string')
        .map((item) => ({ identifier: item.identifier as string, enabled: item.enabled === true }));
}

export function isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEYS.includes(key);
}

/** The value as it may be shown: secrets masked. */
export function shownValue(key: string, value: unknown): unknown {
    if (!isSensitiveKey(key) || value === undefined || value === null || value === '') return value;
    return MASK;
}

function promptChanges(before: PromptLike[], after: PromptLike[]): PromptChange[] {
    const old = new Map(before.map((prompt) => [prompt.identifier, prompt]));
    const fresh = new Map(after.map((prompt) => [prompt.identifier, prompt]));
    const changes: PromptChange[] = [];
    for (const prompt of after) {
        const previous = old.get(prompt.identifier);
        if (!previous) {
            changes.push({ identifier: prompt.identifier, name: promptName(prompt), kind: 'added', fields: [] });
            continue;
        }
        const keys = [...new Set([...Object.keys(previous), ...Object.keys(prompt)])].filter(
            (key) => key !== 'identifier',
        );
        const fields = keys
            .filter((key) => !same(previous[key], prompt[key]))
            .map((key) => ({ field: key, before: previous[key], after: prompt[key] }));
        if (fields.length)
            changes.push({ identifier: prompt.identifier, name: promptName(prompt), kind: 'changed', fields });
    }
    for (const prompt of before) {
        if (!fresh.has(prompt.identifier))
            changes.push({ identifier: prompt.identifier, name: promptName(prompt), kind: 'removed', fields: [] });
    }
    return changes;
}

function orderChange(before: OrderEntry[], after: OrderEntry[]): OrderChange {
    const oldIds = before.map((entry) => entry.identifier);
    const newIds = after.map((entry) => entry.identifier);
    const oldEnabled = new Map(before.map((entry) => [entry.identifier, entry.enabled]));
    const change: OrderChange = {
        moved: moveOps(oldIds, newIds).map((op) => op.identifier),
        enabled: [],
        disabled: [],
        added: newIds.filter((identifier) => !oldEnabled.has(identifier)),
        removed: oldIds.filter((identifier) => !newIds.includes(identifier)),
    };
    for (const entry of after) {
        const previous = oldEnabled.get(entry.identifier);
        if (previous === undefined || previous === entry.enabled) continue;
        (entry.enabled ? change.enabled : change.disabled).push(entry.identifier);
    }
    return change;
}

function keyChanges(before: BodyLike, after: BodyLike): KeyChange[] {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (key) => key !== 'prompts' && key !== 'prompt_order',
    );
    return keys
        .filter((key) => !same(before[key], after[key]))
        .map((key) => {
            const sensitive = isSensitiveKey(key);
            return {
                key,
                before: shownValue(key, before[key]),
                after: shownValue(key, after[key]),
                sensitive,
            };
        });
}

/** Everything that differs between two bodies (either may be null: an empty body). */
export function presetDiff(before: BodyLike | null | undefined, after: BodyLike | null | undefined): PresetDiff {
    const a = before ?? {};
    const b = after ?? {};
    const prompts = promptChanges(promptsOf(a), promptsOf(b));
    const order = orderChange(activeOrderOf(a), activeOrderOf(b));
    const keys = keyChanges(a, b);
    const orderSame =
        !order.moved.length &&
        !order.enabled.length &&
        !order.disabled.length &&
        !order.added.length &&
        !order.removed.length;
    return { prompts, order, keys, same: !prompts.length && orderSame && !keys.length };
}

/** A short count line: blocks changed, order changes, keys changed. */
export function diffCounts(diff: PresetDiff): { prompts: number; order: number; keys: number } {
    const order = diff.order;
    return {
        prompts: diff.prompts.length,
        order:
            order.moved.length +
            order.enabled.length +
            order.disabled.length +
            order.added.length +
            order.removed.length,
        keys: diff.keys.length,
    };
}
