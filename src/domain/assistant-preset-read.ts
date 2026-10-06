// Pure helpers of the assistant's preset read tools (M33 over M34, plan-2 §1): the parameters of a preset the assistant
// may see (connection keys, addresses and passwords stay hidden, only counted) and the compact view of a dry run of
// the prompt — what goes out in which order and role, how big each part is, previews of the preset's own blocks, the
// card, the lore and the history only as sizes (their text never reaches the assistant this way). No DOM, no
// SillyTavern.
import { clip } from './assistant-write-args';
import { isHiddenParam } from './assistant-write-presets';
import type { Dict } from './assistant-write-presets';
import { paramSpec } from './preset-ui-params';

/** Body keys that are not parameters: the prompt lists and the extensions' data. */
const NOT_PARAMS = new Set(['prompts', 'prompt_order', 'extensions']);

/** The longest parameter text shown (prefills and utility prompts can be long). */
export const PARAM_TEXT_CHARS = 2000;

export interface ParamsView {
    /** The studio's generation parameters present in the body (temperature, top_p, reasoning_effort…). */
    params: Dict;
    /** Other visible body keys (the preset's own markers, bias preset…). */
    other: Dict;
    /** How many keys stay hidden (connection, addresses, passwords). */
    hidden: number;
}

function shown(value: unknown): unknown {
    if (typeof value === 'string')
        return value.length > PARAM_TEXT_CHARS ? `${value.slice(0, PARAM_TEXT_CHARS)}…` : value;
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
        const json = JSON.stringify(value) ?? '';
        return json.length > PARAM_TEXT_CHARS ? `${json.slice(0, PARAM_TEXT_CHARS)}…` : value;
    }
    return value;
}

/** What preset_params shows of a body. */
export function paramsView(body: Dict): ParamsView {
    const view: ParamsView = { params: {}, other: {}, hidden: 0 };
    for (const key of Object.keys(body).sort()) {
        if (NOT_PARAMS.has(key)) continue;
        if (isHiddenParam(key)) {
            view.hidden++;
            continue;
        }
        if (paramSpec(key)) view.params[key] = shown(body[key]);
        else view.other[key] = shown(body[key]);
    }
    return view;
}

/* ------------------------------------------------------------------ dry run */

/** A slot of the assembled prompt (structurally features/presetStudio/analysis-api.ts MapSlot). */
export interface DrySlot {
    identifier: string;
    name: string;
    role: 'system' | 'user' | 'assistant';
    placement: 'relative' | 'depth';
    depth?: number;
    order?: number;
    tokens: number;
    enabled: boolean;
    marker: boolean;
    injections: { owner: string; key: string; tokens: number; where?: string; depth?: number; role?: string }[];
    dropped?: string;
    note?: string;
}

export interface DryRunInput {
    slots: readonly DrySlot[];
    /** Block texts as they would be sent now (conditions resolved, macros filled), by identifier. */
    texts: ReadonlyMap<string, string>;
    /** Blocks a condition silences now (their text resolves to nothing with the flags set now). */
    silent: ReadonlySet<string>;
    /** Longest preview of one block, characters. */
    previewChars: number;
}

export interface DryRunRow {
    n: number;
    name: string;
    role: string;
    tokens: number;
    /** 'block' (the preset's text), 'marker' (filled by SillyTavern: card, lore, history…). */
    kind: 'block' | 'marker';
    depth?: number;
    preview?: string;
    /** Extension prompts that land here (owner and size, never their text). */
    injections?: string[];
    note?: string;
}

export interface DryRunView {
    /** What goes out, in order: the blocks before, inside (by depth) and after the chat history. */
    messages: DryRunRow[];
    /** Blocks that are switched off, dropped or silenced by a condition now. */
    notSent: { name: string; why: string }[];
    tokens: { total: number; presetBlocks: number; filledBySillyTavern: number; extensions: number };
}

/** The dry run as the model reads it (previews cut, the lore and the history only as sizes). */
export function dryRunView(input: DryRunInput): DryRunView {
    const view: DryRunView = {
        messages: [],
        notSent: [],
        tokens: { total: 0, presetBlocks: 0, filledBySillyTavern: 0, extensions: 0 },
    };
    const sent: DrySlot[] = [];
    for (const slot of input.slots) {
        if (!slot.enabled) view.notSent.push({ name: slot.name, why: 'switched off' });
        else if (slot.dropped) view.notSent.push({ name: slot.name, why: slot.dropped });
        else if (input.silent.has(slot.identifier)) view.notSent.push({ name: slot.name, why: 'condition is off now' });
        else sent.push(slot);
    }
    // In-chat blocks go inside the history: deeper first, the history marker stands for the chat itself.
    const relative = sent.filter((slot) => slot.placement === 'relative');
    const inChat = sent
        .filter((slot) => slot.placement === 'depth')
        .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || (a.order ?? 100) - (b.order ?? 100));
    const ordered: DrySlot[] = [];
    for (const slot of relative) {
        ordered.push(slot);
        if (slot.identifier === 'chatHistory') ordered.push(...inChat);
    }
    if (!relative.some((slot) => slot.identifier === 'chatHistory')) ordered.push(...inChat);
    ordered.forEach((slot, index) => {
        const injections = slot.injections.reduce((sum, item) => sum + item.tokens, 0);
        view.tokens.total += slot.tokens;
        view.tokens.extensions += injections;
        if (slot.marker) view.tokens.filledBySillyTavern += Math.max(0, slot.tokens - injections);
        else view.tokens.presetBlocks += Math.max(0, slot.tokens - injections);
        const text = input.texts.get(slot.identifier);
        const row: DryRunRow = {
            n: index + 1,
            name: slot.name,
            role: slot.role,
            tokens: slot.tokens,
            kind: slot.marker ? 'marker' : 'block',
        };
        if (slot.placement === 'depth') row.depth = slot.depth ?? 0;
        if (!slot.marker && text !== undefined) row.preview = clip(text, Math.max(20, input.previewChars));
        if (slot.injections.length) {
            row.injections = slot.injections.map(
                (item) =>
                    `${item.owner} (${item.tokens} tokens${item.where === 'chat' ? `, depth ${item.depth ?? 0}` : ''})`,
            );
        }
        if (slot.note) row.note = slot.note;
        view.messages.push(row);
    });
    return view;
}
