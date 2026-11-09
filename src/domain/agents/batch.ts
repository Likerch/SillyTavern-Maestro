// Batches (plan §4.6, release 1.30): several agents of one model and one moment in one request. The frame and the union
// of their sources once, then a block per agent with its task and answer form, and one JSON object with a key per
// agent. Agents missing from the answer, or with an answer of the wrong form, are asked again one by one (the
// caller). The cost is split by the length of each agent's task. Rewrites never go in a batch (they answer the whole
// reply).
import { AGENT_FRAME, answerForm, answerSchema, substitute } from './request';
import type { AgentMessage, RenderedSource, SubstitutionValues } from './request';
import type { AgentResultSpec } from './types';

export interface BatchItem {
    /** Short key in the answer ('a1', 'a2'…). */
    key: string;
    name: string;
    instruction: string;
    vars?: Record<string, string>;
    result: AgentResultSpec;
    sources: readonly RenderedSource[];
    extra?: string;
}

export const BATCH_FRAME = `${AGENT_FRAME}\nThis time you do several such jobs at once, each in its own <agent_task> block: keep them apart — every job sees the same context but answers only its own task.`;

/** The longest answer a batch asks for (sum of its agents' lengths, capped). */
export const BATCH_MAX_TOKENS = 6000;

/** The sources of every agent, once each (the longest version of a source when budgets differ), stable ones first. */
export function unionSources(items: readonly BatchItem[]): RenderedSource[] {
    const byId = new Map<string, RenderedSource>();
    for (const item of items) {
        for (const source of item.sources) {
            const known = byId.get(source.id);
            if (!known || source.text.length > known.text.length) byId.set(source.id, source);
        }
    }
    const all = [...byId.values()];
    return [...all.filter((source) => source.stable), ...all.filter((source) => !source.stable)];
}

function contextBlock(source: RenderedSource): string {
    return `<context source="${source.id}" title="${source.title}">\n${source.text.trim()}\n</context>`;
}

/** The messages of a batch request. */
export function buildBatchMessages(
    items: readonly BatchItem[],
    values: Omit<SubstitutionValues, 'sources' | 'vars'>,
): AgentMessage[] {
    const sources = unionSources(items);
    const byId = new Map(sources.map((source) => [source.id, source]));
    const tasks = items.map((item) => {
        const instruction = substitute(item.instruction, { ...values, vars: item.vars ?? {}, sources: byId });
        return [
            `<agent_task id="${item.key}" name="${item.name.replace(/"/g, "'")}">`,
            instruction.trim() || '(no task given)',
            item.extra?.trim() ? `Additional instruction for this run: ${item.extra.trim()}` : '',
            `Form of the value of "${item.key}": ${answerForm(item.result)}`,
            '</agent_task>',
        ]
            .filter(Boolean)
            .join('\n');
    });
    const skeleton = `{${items.map((item) => `"${item.key}": …`).join(', ')}}`;
    const closing = `Answer with ONE JSON object and nothing else: ${skeleton} — the value of each key is that task's answer in its own form (a JSON object for JSON answers, a string for text answers; "NONE" when a text task has nothing this time).`;
    const messages: AgentMessage[] = [{ role: 'system', content: BATCH_FRAME }];
    if (sources.length) messages.push({ role: 'user', content: sources.map(contextBlock).join('\n\n') });
    messages.push({ role: 'user', content: `${tasks.join('\n\n')}\n\n${closing}` });
    return messages;
}

/** The structured-output schema of a batch: one property per agent. */
export function batchSchema(items: readonly BatchItem[]): { name: string; schema: Record<string, unknown> } {
    const properties: Record<string, unknown> = {};
    for (const item of items) properties[item.key] = answerSchema(item.result)?.schema ?? { type: 'string' };
    return {
        name: 'agent_batch',
        schema: { type: 'object', properties, required: items.map((item) => item.key) },
    };
}

/** Each agent's part of a batch answer (undefined: missing). */
export function splitBatch(data: unknown, keys: readonly string[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return out;
    const record = data as Record<string, unknown>;
    for (const key of keys)
        if (key in record && record[key] !== null && record[key] !== undefined) out.set(key, record[key]);
    return out;
}

/** Shares of a batch's cost by the length of each agent's task (at least an equal tenth each). */
export function costShares(lengths: readonly number[]): number[] {
    const total = lengths.reduce((sum, value) => sum + Math.max(1, value), 0);
    if (!lengths.length) return [];
    return lengths.map((value) => Math.max(1, value) / total);
}

/** Groups items by a key, keeping the order of first appearance. */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const list = groups.get(key) ?? [];
        list.push(item);
        groups.set(key, list);
    }
    return [...groups.values()];
}
