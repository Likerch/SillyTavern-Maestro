// The assistant's conversation as model context (M33): turns (a user message and what followed it) are rendered
// newest first into a token budget. The newest turns go in full (tool calls and their results); older ones lose
// their tool results and keep only the texts; the oldest shrink to one line each (for the system prompt; a share of
// the budget is kept for them), and what does not fit even then is counted as omitted. Pure.
import type { LlmMessage } from '../shared/contracts';
import { wireCall } from './assistant-calls';
import { wrapUntrusted } from './assistant-safety';

export interface HistoryCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: string;
    summary?: string;
    error?: string;
    /** What the model received (capped). */
    result?: string;
    untrusted?: boolean;
}

export interface HistoryMessage {
    role: 'user' | 'assistant' | 'notice';
    text: string;
    toolCalls?: HistoryCall[];
}

export interface HistoryOptions {
    /** Token budget of the whole history (full turns, compact turns and summary lines). */
    budgetTokens: number;
    /** How many of the newest turns may keep their tool calls and results. */
    fullTurns: number;
}

export interface HistoryContext {
    /** Recent turns as chat messages, oldest first. */
    messages: LlmMessage[];
    /** One line per older turn, oldest first (for the system prompt). */
    earlier: string[];
    /** Turns dropped entirely. */
    omitted: number;
}

/** Share of the budget kept for the one-line summaries of older turns (full and compact turns use the rest). */
export const LINES_SHARE = 0.2;
/** Characters per token for the quick estimate (between English ~4 and Cyrillic ~3). */
const CHARS_PER_TOKEN = 3.6;
/** Per-message overhead of the chat format, in tokens. */
const MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
    return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

export function messagesTokens(messages: readonly LlmMessage[]): number {
    let total = 0;
    for (const message of messages) {
        total += MESSAGE_OVERHEAD + estimateTokens(message.content);
        if (message.tool_calls) total += estimateTokens(JSON.stringify(message.tool_calls));
    }
    return total;
}

/** Splits the conversation at user messages; messages before the first user message form their own turn. */
export function groupTurns<M extends HistoryMessage>(messages: readonly M[]): M[][] {
    const turns: M[][] = [];
    for (const message of messages) {
        const last = turns[turns.length - 1];
        if (message.role === 'user' || !last) turns.push([message]);
        else last.push(message);
    }
    return turns;
}

/** What the model is told a call returned (also for calls of earlier turns). */
export function toolMessageContent(call: HistoryCall): string {
    switch (call.status) {
        case 'ok': {
            const result = call.result ?? 'ok';
            return call.untrusted ? wrapUntrusted(call.name, result) : result;
        }
        case 'applied':
            return `Applied${call.summary ? `: ${call.summary}` : ''}.${call.result ? ` Result: ${call.result}` : ''}`;
        case 'declined':
            return 'The user declined this change. Nothing was changed.';
        case 'error':
            return `Error: ${call.error ?? 'the tool failed'}.`;
        default:
            return 'The call was interrupted before it finished. Nothing was changed.';
    }
}

function fullTurn(turn: readonly HistoryMessage[]): LlmMessage[] {
    const out: LlmMessage[] = [];
    for (const message of turn) {
        if (message.role === 'user') {
            out.push({ role: 'user', content: message.text });
        } else if (message.role === 'assistant') {
            const calls = message.toolCalls ?? [];
            if (calls.length) {
                out.push({
                    role: 'assistant',
                    content: message.text,
                    tool_calls: calls.map((call) => wireCall({ id: call.id, name: call.name, args: call.args ?? {} })),
                });
                for (const call of calls)
                    out.push({ role: 'tool', tool_call_id: call.id, content: toolMessageContent(call) });
            } else if (message.text.trim()) {
                out.push({ role: 'assistant', content: message.text });
            }
        }
    }
    return out;
}

function callNote(call: HistoryCall): string {
    if (call.status === 'applied' || call.status === 'declined')
        return `${call.name} ${call.status}${call.summary ? ` (${clip(call.summary, 120)})` : ''}`;
    if (call.status === 'error') return `${call.name} failed`;
    return call.name;
}

function compactTurn(turn: readonly HistoryMessage[]): LlmMessage[] {
    const out: LlmMessage[] = [];
    const texts: string[] = [];
    const notes: string[] = [];
    for (const message of turn) {
        if (message.role === 'user') out.push({ role: 'user', content: message.text });
        else if (message.role === 'assistant') {
            if (message.text.trim()) texts.push(message.text.trim());
            for (const call of message.toolCalls ?? []) notes.push(callNote(call));
        }
    }
    const tools = notes.length ? `[tools: ${notes.join('; ')}]` : '';
    const content = [texts.join('\n\n'), tools].filter(Boolean).join('\n');
    if (content) out.push({ role: 'assistant', content });
    return out;
}

export function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** One line for a turn: the question, the gist of the answer and the tools used. */
export function turnLine(turn: readonly HistoryMessage[]): string {
    const user = turn.find((message) => message.role === 'user');
    const answers = turn.filter((message) => message.role === 'assistant');
    const answer = answers
        .map((message) => message.text.trim())
        .filter(Boolean)
        .join(' ');
    const calls = answers.flatMap((message) => message.toolCalls ?? []);
    const parts = [user ? `User: «${clip(user.text, 120)}»` : 'User: —'];
    parts.push(answer ? `Assistant: «${clip(answer, 160)}»` : 'Assistant: no answer');
    if (calls.length) parts.push(`[${calls.map(callNote).join('; ')}]`);
    return parts.join(' → ');
}

/** Renders the conversation into the budget (see the file comment). */
export function buildHistory(history: readonly HistoryMessage[], options: HistoryOptions): HistoryContext {
    const turns = groupTurns(history);
    let remaining = Math.max(0, options.budgetTokens);
    const reserve = Math.floor(remaining * LINES_SHARE);
    let tier: 'full' | 'compact' | 'line' | 'drop' = 'full';
    const recent: LlmMessage[][] = [];
    const earlier: string[] = [];
    let omitted = 0;
    for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index] ?? [];
        const age = turns.length - 1 - index;
        if (tier === 'full' && age >= options.fullTurns) tier = 'compact';
        if (tier === 'full') {
            const messages = fullTurn(turn);
            const cost = messagesTokens(messages);
            if (cost <= remaining - reserve) {
                recent.push(messages);
                remaining -= cost;
                continue;
            }
            tier = 'compact';
        }
        if (tier === 'compact') {
            const messages = compactTurn(turn);
            const cost = messagesTokens(messages);
            if (cost <= remaining - reserve) {
                recent.push(messages);
                remaining -= cost;
                continue;
            }
            tier = 'line';
        }
        if (tier === 'line') {
            const line = turnLine(turn);
            const cost = estimateTokens(line) + 1;
            if (cost <= remaining) {
                earlier.unshift(line);
                remaining -= cost;
                continue;
            }
            tier = 'drop';
        }
        omitted++;
    }
    return { messages: recent.reverse().flat(), earlier, omitted };
}
