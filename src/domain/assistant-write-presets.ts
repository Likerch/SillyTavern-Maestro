// Pure helpers of the assistant's preset write tools (M33 over M34, plan-2 §1 «Ассистент работает с пресетами»):
// targeted text replacements in a block, a block's new place in the prompt order (and the layer anchor that rebuilds
// it), the scopes above a scope (their ops override it), the preset parameters the assistant may change (connection
// keys, addresses and passwords never), card warnings about roles the active model handles badly (DeepSeek V4 through
// OpenRouter: an assistant prefill closes the reply, system messages inside the history merge into the neighbouring
// turns; the DES tracker instructions in the system role broke the tracker JSON in practice) and a new preset
// assembled from a base and picked blocks. No DOM, no SillyTavern.
import { ArgError, clip } from './assistant-write-args';
import { HIDDEN_SETTING } from './assistant-safety';
import { DEFAULT_PROMPT_ORDER, MARKER_IDS, SYSTEM_DEFAULTS } from './preset-ui-blocks';
import { CONNECTION_KEYS, coerceParam, paramSpec } from './preset-ui-params';

export type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ scopes */

export const PRESET_SCOPES = ['global', 'character', 'chat'] as const;
export type PresetScope = (typeof PRESET_SCOPES)[number];

/** Scopes laid over the working copy after `scope` (an op there wins over one in `scope`). */
export function scopesAbove(scope: PresetScope): PresetScope[] {
    if (scope === 'global') return ['character', 'chat'];
    return scope === 'character' ? ['chat'] : [];
}

/* ------------------------------------------------------------------ text replacements */

export interface TextReplacement {
    find: string;
    replace: string;
}

/**
 * The text with each replacement made in turn. A `find` must occur exactly once in the text as it is at that step
 * (a guess between several places would change the wrong one); line ends are compared as `\n`.
 */
export function applyReplacements(text: string, edits: readonly TextReplacement[]): string {
    let result = text.replace(/\r\n?/g, '\n');
    for (const edit of edits) {
        const find = edit.find.replace(/\r\n?/g, '\n');
        if (!find) throw new ArgError('argEmpty', { name: 'find' });
        const first = result.indexOf(find);
        if (first < 0) throw new ArgError('presetFindMissing', { find: clip(find, 80) });
        let count = 0;
        for (let at = first; at >= 0; at = result.indexOf(find, at + find.length)) count++;
        if (count > 1) throw new ArgError('presetFindAmbiguous', { find: clip(find, 80), count });
        result = result.slice(0, first) + edit.replace.replace(/\r\n?/g, '\n') + result.slice(first + find.length);
    }
    return result;
}

/* ------------------------------------------------------------------ the order */

export const ORDER_PLACES = ['start', 'end', 'after', 'before'] as const;
export type OrderPlace = (typeof ORDER_PLACES)[number];

/** A «move» anchor of the layer (structurally a LayerAnchor): after the preceding block, or at the start. */
export type OrderAnchor = { kind: 'after'; identifier: string } | { kind: 'start' };

/**
 * Where a block goes in the prompt order: the new order and the anchor that rebuilds it (the studio's moves are
 * anchored after the preceding block). Throws when the anchor is missing, is the block itself, or nothing moves.
 */
export function placeBlock(
    order: readonly string[],
    identifier: string,
    place: OrderPlace,
    anchor?: string,
): { order: string[]; anchor: OrderAnchor } {
    const rest = order.filter((item) => item !== identifier);
    let index: number;
    if (place === 'start') index = 0;
    else if (place === 'end') index = rest.length;
    else {
        if (!anchor) throw new ArgError('presetNeedAnchor', { place });
        if (anchor === identifier) throw new ArgError('presetSelfAnchor');
        const at = rest.indexOf(anchor);
        if (at < 0) throw new ArgError('presetAnchorOff', { block: anchor });
        index = place === 'after' ? at + 1 : at;
    }
    const next = [...rest.slice(0, index), identifier, ...rest.slice(index)];
    if (next.length === order.length && next.every((item, i) => item === order[i])) {
        throw new ArgError('presetSamePlace');
    }
    const previous = next[index - 1];
    return { order: next, anchor: previous ? { kind: 'after', identifier: previous } : { kind: 'start' } };
}

/* ------------------------------------------------------------------ parameters */

/** Body keys that are never shown nor changed: the prompt lists, the extensions' data. */
const RESERVED = new Set(['prompts', 'prompt_order', 'extensions']);

/** Keys of addresses and passwords (preset-layer-apply SENSITIVE_KEYS, repeated: domain files stay independent). */
const SECRET_KEYS = new Set([
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
]);

/** A body key the assistant never sees: connection (source, models, routing), addresses, passwords, keys. */
export function isHiddenParam(key: string): boolean {
    if (RESERVED.has(key) || SECRET_KEYS.has(key) || CONNECTION_KEYS.has(key)) return true;
    // Known generation parameters are safe even when their names look technical.
    if (paramSpec(key)) return false;
    return HIDDEN_SETTING.test(key);
}

/**
 * A value for a generation parameter, typed and checked against ST's limits (the «Параметры» tab's rules). Only the
 * studio's parameters can be set; connection keys, addresses and passwords never.
 */
export function paramValue(key: string, value: unknown): unknown {
    if (isHiddenParam(key)) throw new ArgError('presetParamHidden', { key });
    const spec = paramSpec(key);
    if (!spec) throw new ArgError('presetParamUnknown', { key });
    if (spec.type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 'false') return value === 'true';
        throw new ArgError('presetParamType', { key, expected: 'boolean' });
    }
    if (spec.type === 'text' || spec.type === 'textarea') {
        if (typeof value !== 'string') throw new ArgError('presetParamType', { key, expected: 'string' });
        if (value.length > 20000) throw new ArgError('argTooLong', { name: key, max: 20000 });
        return value;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ArgError('presetParamType', { key, expected: spec.type === 'number' ? 'number' : 'string' });
    }
    const result = coerceParam(spec, String(value));
    if (result.ok) return result.value;
    if (result.error === 'range' && spec.type === 'number') {
        throw new ArgError('presetParamRange', { key, min: spec.min, max: spec.max });
    }
    if (result.error === 'option' && spec.type === 'select') {
        throw new ArgError('presetParamOption', {
            key,
            options: spec.options.map((item) => JSON.stringify(item)).join(', '),
        });
    }
    throw new ArgError('presetParamType', { key, expected: 'number' });
}

/* ------------------------------------------------------------------ role warnings */

/** Quirks of the active model (domain/preset-analysis-hints.ts ModelQuirk). */
export type RoleQuirk = 'prefillEos' | 'systemMerge' | 'assistantDepth';

export type RoleWarning = 'prefillEos' | 'systemMerge' | 'assistantDepth' | 'trackerSystem';

const TRACKER_TEXT = /\btracker\b|трекер/i;

/**
 * Warnings for a block as it will be: an assistant message after the chat history (a prefill) or inside it, a
 * system message inside the history — for a model with those quirks — and tracker instructions moved to the
 * system role (it broke the DES tracker JSON and the coloured dialogue in practice).
 */
export function roleWarnings(
    block: { role: string; inChat: boolean; depth: number; afterHistory: boolean; text: string },
    quirks: ReadonlySet<string>,
    changedRole: boolean,
): RoleWarning[] {
    const warnings: RoleWarning[] = [];
    if (block.role === 'assistant') {
        const prefill = block.inChat ? block.depth === 0 : block.afterHistory;
        if (prefill && quirks.has('prefillEos')) warnings.push('prefillEos');
        else if (block.inChat && quirks.has('assistantDepth')) warnings.push('assistantDepth');
    }
    if (block.role === 'system' && block.inChat && block.depth > 0 && quirks.has('systemMerge')) {
        warnings.push('systemMerge');
    }
    if (changedRole && block.role === 'system' && TRACKER_TEXT.test(block.text)) warnings.push('trackerSystem');
    return warnings;
}

/* ------------------------------------------------------------------ a new preset */

export interface ComposePrompt extends Dict {
    identifier: string;
    name?: unknown;
    content?: unknown;
}

export const NEW_BLOCK_PLACES = ['beforeHistory', 'afterHistory', 'start', 'end'] as const;
export type NewBlockPlace = (typeof NEW_BLOCK_PLACES)[number];

export interface ComposeAddition {
    prompt: ComposePrompt;
    place: NewBlockPlace;
    enabled: boolean;
}

export interface ComposedPreset {
    prompts: ComposePrompt[];
    order: { identifier: string; enabled: boolean }[];
}

/** ST's own fresh preset: the built-in blocks with their default texts and the markers, in ST's default order. */
export function emptyPreset(): ComposedPreset {
    const prompts: ComposePrompt[] = [];
    for (const [identifier, block] of Object.entries(SYSTEM_DEFAULTS)) {
        const prompt: ComposePrompt = {
            identifier,
            name: block.name,
            role: 'system',
            content: block.content,
            system_prompt: true,
            marker: false,
        };
        if (block.forbidOverrides === false) prompt.forbid_overrides = false;
        prompts.push(prompt);
    }
    for (const identifier of MARKER_IDS)
        prompts.push({ identifier, name: identifier, system_prompt: true, marker: true });
    return { prompts, order: DEFAULT_PROMPT_ORDER.map((item) => ({ ...item })) };
}

/**
 * The base with the additions put in place: before or after the chat history (at the end when the base has none),
 * at the start or the end. A picked block whose identifier the result already has gets a new one (`newId`).
 */
export function composePreset(
    base: ComposedPreset,
    additions: readonly ComposeAddition[],
    newId: () => string,
): ComposedPreset {
    const prompts = base.prompts.map((prompt) => ({ ...prompt }));
    const order = base.order.map((item) => ({ ...item }));
    const taken = new Set(prompts.map((prompt) => prompt.identifier));
    const head: typeof order = [];
    const before: typeof order = [];
    const after: typeof order = [];
    const tail: typeof order = [];
    for (const addition of additions) {
        let identifier = addition.prompt.identifier;
        while (!identifier || taken.has(identifier)) identifier = newId();
        taken.add(identifier);
        prompts.push({ ...addition.prompt, identifier });
        const item = { identifier, enabled: addition.enabled };
        if (addition.place === 'start') head.push(item);
        else if (addition.place === 'end') tail.push(item);
        else if (addition.place === 'afterHistory') after.push(item);
        else before.push(item);
    }
    const history = order.findIndex((item) => item.identifier === 'chatHistory');
    const middle =
        history < 0
            ? [...order, ...before, ...after]
            : [...order.slice(0, history), ...before, order[history]!, ...after, ...order.slice(history + 1)];
    return { prompts, order: [...head, ...middle, ...tail] };
}
