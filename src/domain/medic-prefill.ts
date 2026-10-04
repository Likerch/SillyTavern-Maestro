// "Prefill" detection for the active Chat Completion preset (plan M3, M22, dev-plan 1.12): a prompt with the
// assistant role that ends the request. Through OpenRouter and several other providers an assistant message at the
// end is continued (or echoed) instead of answered, which produces garbage. ST's Prompt Manager keeps prompts in
// `oai_settings.prompts` and their order and toggles per character in `oai_settings.prompt_order`; with the
// 'global' strategy ST uses the dummy character 100001 (openai.js setupChatCompletionPromptManager). Pure.

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Dummy character id of the global prompt order (Chat Completion). */
export const GLOBAL_ORDER_ID = 100001;

export interface OrderEntry {
    identifier: string;
    enabled: boolean;
}

export interface PrefillHit {
    identifier: string;
    name: string;
    /** 'relative' = last prompt after the chat history; 'depth' = in-chat injection at depth 0. */
    placement: 'relative' | 'depth';
}

/**
 * The prompt order ST uses: Chat Completion runs the Prompt Manager with the 'global' strategy, so the dummy
 * 100001 wins; a list of `characterId` (left over from the per-character strategy) is the fallback, then the first.
 */
export function activePromptOrder(promptOrder: unknown, characterId?: string | number): OrderEntry[] {
    if (!Array.isArray(promptOrder)) return [];
    const lists = promptOrder.filter(isDict);
    const find = (id: string | number | undefined) =>
        id === undefined ? undefined : lists.find((item) => String(item.character_id) === String(id));
    const chosen = find(GLOBAL_ORDER_ID) ?? find(characterId) ?? lists[0];
    const order = chosen && Array.isArray(chosen.order) ? chosen.order : [];
    return order
        .filter(isDict)
        .filter((item) => typeof item.identifier === 'string')
        .map((item) => ({ identifier: item.identifier as string, enabled: item.enabled !== false }));
}

/** Index of the prompt list entry with this identifier (oai_settings.prompts). */
export function promptIndex(prompts: unknown, identifier: string): number {
    return Array.isArray(prompts)
        ? prompts.findIndex((prompt) => isDict(prompt) && prompt.identifier === identifier)
        : -1;
}

function hasContent(prompt: Dict): boolean {
    return typeof prompt.content === 'string' && prompt.content.trim() !== '';
}

/**
 * Finds an assistant prompt that ends the request: the last enabled, non-empty relative prompt after the chat
 * history marker, or an enabled in-chat injection at depth 0. Markers (chatHistory, worldInfoAfter, …) end the
 * search: their own messages come last then.
 */
export function findAssistantPrefill(prompts: unknown, order: readonly OrderEntry[]): PrefillHit | null {
    if (!Array.isArray(prompts)) return null;
    const byId = new Map<string, Dict>();
    for (const prompt of prompts) {
        if (isDict(prompt) && typeof prompt.identifier === 'string') byId.set(prompt.identifier, prompt);
    }
    const name = (prompt: Dict, identifier: string) =>
        typeof prompt.name === 'string' && prompt.name ? prompt.name : identifier;

    for (const entry of order) {
        if (!entry.enabled) continue;
        const prompt = byId.get(entry.identifier);
        if (!prompt || prompt.marker === true || !hasContent(prompt)) continue;
        if (Number(prompt.injection_position) === 1 && Number(prompt.injection_depth ?? 4) === 0) {
            if (prompt.role === 'assistant')
                return { identifier: entry.identifier, name: name(prompt, entry.identifier), placement: 'depth' };
        }
    }

    const historyAt = order.findIndex((entry) => entry.enabled && entry.identifier === 'chatHistory');
    if (historyAt < 0) return null;
    for (let i = order.length - 1; i > historyAt; i--) {
        const entry = order[i];
        if (!entry?.enabled) continue;
        const prompt = byId.get(entry.identifier);
        if (!prompt) continue;
        if (Number(prompt.injection_position) === 1) continue;
        if (prompt.marker === true) return null;
        if (!hasContent(prompt)) continue;
        return prompt.role === 'assistant'
            ? { identifier: entry.identifier, name: name(prompt, entry.identifier), placement: 'relative' }
            : null;
    }
    return null;
}
