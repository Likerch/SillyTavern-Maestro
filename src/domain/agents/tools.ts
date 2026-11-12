// Agent tools (release 1.34, deferred from 1.31/1.32): an agent may look things up and roll dice before it answers —
// «Своя механика» rolls by the dice engine of M25, a creator searches the lore, a keeper of secrets searches the old
// chat. The agent's request then goes in rounds: the model calls tools (at most AGENT_TOOL_ROUNDS times), Maestro runs
// them and gives back the results, then the final answer is asked in the agent's form. Pure: the specs, argument
// checks and result texts; the feature runs them over the app.
import type { DiceRoll } from '../mechanics-dice';

export type AgentToolId = 'roll' | 'lore_search' | 'chat_search';

export const AGENT_TOOL_IDS: readonly AgentToolId[] = ['roll', 'lore_search', 'chat_search'];

/** Rounds of tool calls before the final answer is asked for. */
export const AGENT_TOOL_ROUNDS = 3;
/** Results of one search at most. */
export const SEARCH_HITS = 5;
/** Characters of one search hit. */
export const HIT_CHARS = 400;

export interface AgentToolSpec {
    id: AgentToolId;
    description: string;
    parameters: Record<string, unknown>;
}

export const AGENT_TOOLS: readonly AgentToolSpec[] = [
    {
        id: 'roll',
        description:
            'Rolls dice by a formula: "1d20+3", "2d6", "1d100<=45" (roll-under), "4d6kh3" (keep highest), "1d6!" (exploding). With difficulty the outcome is success or failure. Use it when a rule asks for a roll; never invent a result.',
        parameters: {
            type: 'object',
            properties: {
                dice: { type: 'string', description: 'The dice formula.' },
                difficulty: { type: 'number', description: 'The total to reach (optional).' },
                why: { type: 'string', description: 'What the roll decides, a few words.' },
            },
            required: ['dice'],
            additionalProperties: false,
        },
    },
    {
        id: 'lore_search',
        description:
            "Searches the chat's lore (the chat canon: characters, places, items, events, chapters) for words; returns up to 5 entries with their beginning.",
        parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Words to find (a name, a thing).' } },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        id: 'chat_search',
        description:
            'Searches the older messages of this chat for words; returns up to 5 passages with their message numbers. Use it to check what was said or happened earlier.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Words to find.' } },
            required: ['query'],
            additionalProperties: false,
        },
    },
];

export function isAgentToolId(value: unknown): value is AgentToolId {
    return typeof value === 'string' && (AGENT_TOOL_IDS as readonly string[]).includes(value);
}

/** The tools of a definition, cleaned (known ids, no repeats). */
export function sanitizeTools(raw: unknown): AgentToolId[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(isAgentToolId))];
}

export function agentToolSpec(id: AgentToolId): AgentToolSpec {
    return AGENT_TOOLS.find((tool) => tool.id === id)!;
}

const fold = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Words of a query worth looking for (two letters and more). */
export function queryWords(query: string): string[] {
    return [
        ...new Set(
            fold(query)
                .split(/[^\p{L}\p{N}]+/u)
                .filter((word) => word.length >= 2),
        ),
    ].slice(0, 8);
}

/** A word's stem for Russian forms («карта» → «карт», «контрабандистов» → «контра»). */
export function stemOf(word: string): string {
    return word.length >= 5 ? word.slice(0, Math.max(4, Math.min(6, word.length - 2))) : word;
}

/** How well a text matches the words: how many of them it has (0 — none), by their stems. */
export function matchScore(text: string, words: readonly string[]): number {
    const folded = fold(text);
    let score = 0;
    for (const word of words) if (folded.includes(stemOf(word))) score += 1;
    return score;
}

/** The passage of a text around the first word found, at most HIT_CHARS. */
export function passageAround(text: string, words: readonly string[], chars = HIT_CHARS): string {
    const folded = fold(text);
    let at = -1;
    for (const word of words) {
        const index = folded.indexOf(stemOf(word));
        if (index >= 0 && (at < 0 || index < at)) at = index;
    }
    const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(chars / 3));
    const piece = text.slice(start, start + chars).trim();
    return `${start > 0 ? '…' : ''}${piece}${start + chars < text.length ? '…' : ''}`;
}

/** A roll as the model reads it. */
export function rollText(dice: string, roll: DiceRoll, why?: string): string {
    const faces = `[${roll.rolls.join(', ')}]`;
    const mod = roll.modifier ? ` ${roll.modifier > 0 ? '+' : '-'} ${Math.abs(roll.modifier)}` : '';
    const target = roll.target === null ? '' : ` vs ${roll.under ? '≤' : ''}${roll.target}`;
    const outcome = roll.outcome === 'none' ? '' : ` → ${roll.outcome}`;
    return `${why ? `${why}: ` : ''}${dice} = ${faces}${mod} = ${roll.total}${target}${outcome}`;
}
