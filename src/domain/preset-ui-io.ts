// Prompt-list import and export in Prompt Manager's own format (research/parity-preset.md P-031, P-032):
// `{version: 1, type: 'full', data: {prompts, prompt_order}}`, file `st-prompts-MM_DD_YYYY.json`. Pure: the studio
// reads the file and applies the plan through the store (and the layer).
import { isBuiltinId, normalizePrompt } from './preset-ui-blocks';
import type { PromptLike } from './preset-ui-blocks';
import { mergeImportedOrder } from './preset-ui-order';
import type { OrderEntry } from './preset-ui-order';

export interface PromptListFile {
    version: number;
    type: string;
    data: { prompts: PromptLike[]; prompt_order?: unknown };
}

export type ParseResult = { ok: true; file: PromptListFile } | { ok: false; reason: 'json' | 'shape' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * PM's `validateObject` (PM:1877-1893): a number `version`, a string `type`, an object `data` with an object
 * `prompts` (an array in practice); `prompt_order` may be missing. Prompts without a string identifier are skipped.
 */
export function parsePromptList(text: string): ParseResult {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'json' };
    }
    if (!isRecord(json) || typeof json.version !== 'number' || typeof json.type !== 'string') {
        return { ok: false, reason: 'shape' };
    }
    const data = json.data;
    if (!isRecord(data) || typeof data.prompts !== 'object' || data.prompts === null) {
        return { ok: false, reason: 'shape' };
    }
    const raw = Array.isArray(data.prompts) ? data.prompts : Object.values(data.prompts);
    const prompts = raw.filter(
        (item): item is PromptLike => isRecord(item) && typeof item.identifier === 'string' && item.identifier !== '',
    );
    return { ok: true, file: { version: json.version, type: json.type, data: { ...data, prompts } } };
}

export interface ImportPlan {
    /** Blocks that exist: replaced field by field (the imported block wins, PM's mergeKeepNewer). */
    update: { identifier: string; patch: Record<string, unknown> }[];
    /** New blocks, normalized (P-132). */
    add: PromptLike[];
    /** The resulting active order, or null when the file has none. */
    order: OrderEntry[] | null;
}

/** What importing the file changes (P-031); the imported block wins over the one with the same identifier. */
export function planPromptListImport(
    current: readonly PromptLike[],
    currentOrder: readonly OrderEntry[],
    file: PromptListFile,
): ImportPlan {
    const byId = new Map(current.map((prompt) => [prompt.identifier, prompt]));
    const plan: ImportPlan = { update: [], add: [], order: null };
    const seen = new Set<string>();
    for (const prompt of file.data.prompts) {
        if (seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        const existing = byId.get(prompt.identifier);
        const incoming = isBuiltinId(prompt.identifier) ? { ...prompt } : normalizePrompt(prompt);
        if (!existing) {
            plan.add.push(incoming);
            continue;
        }
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(incoming)) {
            if (key === 'identifier') continue;
            if (JSON.stringify(existing[key]) !== JSON.stringify(value)) patch[key] = value;
        }
        if (Object.keys(patch).length) plan.update.push({ identifier: prompt.identifier, patch });
    }
    const order = file.data.prompt_order;
    if (Array.isArray(order)) plan.order = mergeImportedOrder(currentOrder, order);
    return plan;
}

/**
 * PM's «Экспортировать этот список промптов» (P-032): user blocks and the whole active order (markers included).
 * PM keeps only `system_prompt === false && marker === false`, so a user block without the `marker` key is lost; the
 * studio exports it too (normalized).
 */
export function buildPromptListExport(prompts: readonly PromptLike[], order: readonly OrderEntry[]): PromptListFile {
    return {
        version: 1,
        type: 'full',
        data: {
            prompts: prompts
                .filter((prompt) => prompt.system_prompt === false && prompt.marker !== true)
                .map((prompt) => normalizePrompt(prompt)),
            prompt_order: order.map((entry) => ({ identifier: entry.identifier, enabled: entry.enabled })),
        },
    };
}

/** `st-prompts-MM_DD_YYYY.json` (PM:1900-1910). */
export function promptListFileName(date: Date, base = 'st-prompts'): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${base}-${month}_${day}_${date.getFullYear()}.json`;
}

/** A preset body from a foreign file (for «Импорт чужого пресета»): the object itself, or null. */
export function parsePresetBody(text: string): Record<string, unknown> | null {
    try {
        const json: unknown = JSON.parse(text);
        return isRecord(json) ? json : null;
    } catch {
        return null;
    }
}
