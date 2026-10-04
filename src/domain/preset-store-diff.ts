// Draft detection and body merging for the Preset Studio data layer (M34, stage 5). ST keeps the working copy of a
// preset in settings.json and the file separately, with no "dirty" flag (research/parity-preset.md P-073): the
// draft is the difference between the working copy and what applying the saved body would give back. Applying a
// body keeps the current value of every key the body lacks (P-061), Prompt Manager re-adds missing built-in blocks
// and creates the 100001 order when it is missing (P-037), and ST's input handlers turn numeric strings into
// numbers — none of that is a draft. Pure: no DOM, network or SillyTavern.
import { jsonClean, PROMPT_KEYS, SENSITIVE_PRESET_KEYS, pickKeys, withoutKeys } from './preset-store-keys';
import {
    DEFAULT_DEPTH,
    DEFAULT_ORDER,
    DEFAULT_PROMPT_IDS,
    GLOBAL_ORDER_ID,
    expectedActiveOrder,
    findOrderList,
    promptIds,
    readOrder,
} from './preset-store-prompts';
import type { OrderEntry } from './preset-store-prompts';
import { stableStringify, valueHash } from './settings-diff';

type Dict = Record<string, unknown>;

export interface DraftDiff {
    dirty: boolean;
    /** Prompts whose block differs, that were added or removed, or whose switch/presence in the order differs. */
    changedPrompts: string[];
    /** Body keys that differ; `prompt_order` when only the sequence (or another order list) differs. */
    changedKeys: string[];
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericLike(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** A JSON value with numeric strings as numbers and undefined object members dropped (comparison form). */
export function canonical(value: unknown): unknown {
    const number = numericLike(value);
    if (number !== null) return number;
    if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)));
    if (isDict(value)) {
        const result: Dict = {};
        for (const [key, item] of Object.entries(value)) if (item !== undefined) result[key] = canonical(item);
        return result;
    }
    return value;
}

/** Equality the way a draft cares about it: `"0.7"` equals `0.7`, key order does not matter. */
export function looseEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    try {
        return stableStringify(canonical(a)) === stableStringify(canonical(b));
    } catch {
        return false;
    }
}

/** A prompt in comparison form: ST's defaults filled in, the legacy `enabled` and assembly-only keys dropped. */
export function comparablePrompt(prompt: Dict): Dict {
    const copy: Dict = { ...prompt };
    delete copy.enabled;
    delete copy.extension;
    delete copy.position;
    copy.injection_position ??= 0;
    copy.injection_depth ??= DEFAULT_DEPTH;
    copy.injection_order ??= DEFAULT_ORDER;
    copy.injection_trigger ??= [];
    copy.forbid_overrides ??= false;
    copy.marker ??= false;
    copy.content ??= '';
    return copy;
}

export function promptsEqual(a: Dict, b: Dict): boolean {
    return looseEqual(comparablePrompt(a), comparablePrompt(b));
}

function promptMap(prompts: unknown): Map<string, Dict> {
    const map = new Map<string, Dict>();
    if (!Array.isArray(prompts)) return map;
    for (const prompt of prompts) {
        if (isDict(prompt) && typeof prompt.identifier === 'string' && !map.has(prompt.identifier)) {
            map.set(prompt.identifier, prompt);
        }
    }
    return map;
}

function diffPrompts(working: Dict, saved: Dict, changed: Set<string>): void {
    if (!Array.isArray(saved.prompts)) return;
    const mine = promptMap(working.prompts);
    const theirs = promptMap(saved.prompts);
    for (const [identifier, prompt] of mine) {
        const stored = theirs.get(identifier);
        if (!stored) {
            // Prompt Manager puts missing built-ins back after every apply.
            if (!DEFAULT_PROMPT_IDS.includes(identifier)) changed.add(identifier);
        } else if (!promptsEqual(prompt, stored)) {
            changed.add(identifier);
        }
    }
    for (const identifier of theirs.keys()) if (!mine.has(identifier)) changed.add(identifier);
}

function diffOrder(working: Dict, saved: Dict, changed: Set<string>, keys: Set<string>): void {
    const ids = Array.isArray(saved.prompts)
        ? [...new Set([...promptIds(saved.prompts), ...DEFAULT_PROMPT_IDS])]
        : promptIds(working.prompts);
    const expected = expectedActiveOrder(saved, ids);
    if (!expected) return;
    const live = readOrder(findOrderList(working.prompt_order)?.order);
    const before = new Map(expected.map((entry) => [entry.identifier, entry]));
    const now = new Map(live.map((entry) => [entry.identifier, entry]));
    for (const entry of live) {
        const old = before.get(entry.identifier);
        if (!old || old.enabled !== entry.enabled) changed.add(entry.identifier);
    }
    for (const entry of expected) if (!now.has(entry.identifier)) changed.add(entry.identifier);
    const sequence = (list: OrderEntry[], other: Map<string, OrderEntry>) =>
        list.filter((entry) => other.has(entry.identifier)).map((entry) => entry.identifier);
    if (sequence(live, before).join('\n') !== sequence(expected, now).join('\n')) keys.add('prompt_order');
    // Other lists (character strategy leftovers, 100000 of Default.json) are kept as they are; report real edits.
    if (Array.isArray(saved.prompt_order)) {
        for (const list of saved.prompt_order) {
            if (!isDict(list) || String(list.character_id) === String(GLOBAL_ORDER_ID)) continue;
            const mine = findOrderList(working.prompt_order, list.character_id as string | number);
            if (!mine || !looseEqual(readOrder(mine.order), readOrder(list.order))) keys.add('prompt_order');
        }
    }
}

/**
 * The draft: what the working copy holds that applying `saved` would not give back. `saved` is the expected
 * working copy (the cached body, or the cached body with the user's layer applied). `knownKeys` are the keys ST
 * applies (settingsToUpdate): other keys of the file never reach the working copy (P-079) and are no draft — the
 * store keeps them on save. Without the list, keys the working copy lacks are skipped.
 */
export function diffDraft(working: Dict, saved: Dict, knownKeys?: readonly string[]): DraftDiff {
    const changedPrompts = new Set<string>();
    const changedKeys = new Set<string>();
    for (const key of Object.keys(saved)) {
        if ((PROMPT_KEYS as readonly string[]).includes(key) || key === 'extensions') continue;
        if (knownKeys ? !knownKeys.includes(key) : !(key in working)) continue;
        const stored = saved[key];
        // Applying a body leaves keys it lacks as they are (P-061).
        if (stored === undefined) continue;
        if (!looseEqual(working[key], stored)) changedKeys.add(key);
    }
    // `extensions` is replaced by `preset.extensions || {}` on apply (OAI:5051-5055), even when the body lacks it:
    // a sub-key the working copy holds differently is lost on a switch; one only the file has is not (a save
    // merges it back, mergeBodies).
    const mine = isDict(working.extensions) ? working.extensions : {};
    const theirs = isDict(saved.extensions) ? saved.extensions : {};
    if (Object.keys(mine).some((key) => !looseEqual(mine[key], theirs[key]))) changedKeys.add('extensions');
    diffPrompts(working, saved, changedPrompts);
    diffOrder(working, saved, changedPrompts, changedKeys);
    return {
        dirty: changedPrompts.size > 0 || changedKeys.size > 0,
        changedPrompts: [...changedPrompts],
        changedKeys: [...changedKeys],
    };
}

/**
 * The body to write: the cached body with the working copy over it (P-079, §10.4 в 2), so keys ST does not know
 * survive; `extensions` merged per sub-key, so data other extensions keep in the preset survives too (P-160).
 */
export function mergeBodies(cached: Dict | null | undefined, working: Dict): Dict {
    const base = cached ?? {};
    const merged: Dict = { ...base, ...working };
    if (isDict(base.extensions) && isDict(working.extensions)) {
        merged.extensions = { ...base.extensions, ...working.extensions };
    }
    return jsonClean(merged);
}

/** Hash of a body as versions see it: exact JSON (key order aside), sensitive keys left out. */
export function bodyHash(body: Dict): string {
    return valueHash(withoutKeys(body, SENSITIVE_PRESET_KEYS));
}

/** A stored body (sensitive keys stripped) with the sensitive values of `source` (the file now) put back. */
export function withSecretsOf(body: Dict, source: Dict | null | undefined): Dict {
    return { ...withoutKeys(body, SENSITIVE_PRESET_KEYS), ...pickKeys(source, SENSITIVE_PRESET_KEYS) };
}
