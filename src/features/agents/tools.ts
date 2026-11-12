// Agent tools at work (release 1.34, domain/agents/tools.ts): the roll goes through the dice engine of M25 (the same
// formulas as the mechanics' checks), the lore search over the chat canon (M6), the chat search over the older
// messages. Each answer is a short text for the model; a tool that cannot run says why.
import { parseDice } from '../../domain/mechanics-defs';
import { rollDice } from '../../domain/mechanics-dice';
import {
    HIT_CHARS,
    SEARCH_HITS,
    agentToolSpec,
    matchScore,
    passageAround,
    queryWords,
    rollText,
} from '../../domain/agents/tools';
import type { AgentToolId } from '../../domain/agents/tools';
import { functionSpec } from '../../domain/assistant-calls';
import type { App } from '../../shared/contracts';
import type { CanonApi } from '../canon/api';
import { agentText } from './sources';

/** Function specs for the request. */
export function toolSpecs(ids: readonly AgentToolId[]): unknown[] {
    return ids.map((id) => {
        const spec = agentToolSpec(id);
        return functionSpec({ name: spec.id, description: spec.description, parameters: spec.parameters });
    });
}

function text(value: unknown, max = 200): string {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Runs one tool call; the text the model gets back. */
export async function runAgentTool(
    app: App,
    name: string,
    args: Record<string, unknown>,
    options: { allowed: readonly AgentToolId[]; focusIndex?: number; rng?: () => number },
): Promise<string> {
    if (!(options.allowed as readonly string[]).includes(name)) return `Error: no tool "${name}".`;
    switch (name as AgentToolId) {
        case 'roll': {
            const dice = text(args.dice, 60);
            const formula = dice ? parseDice(dice) : null;
            if (!formula) return `Error: "${dice}" is not a dice formula (e.g. 1d20+3, 2d6, 1d100<=45).`;
            const difficulty = typeof args.difficulty === 'number' ? args.difficulty : undefined;
            const roll = rollDice(formula, () => null, options.rng ?? Math.random, {
                ...(difficulty !== undefined ? { difficulty } : {}),
            });
            const why = text(args.why, 80);
            return rollText(dice, roll, why || undefined);
        }
        case 'lore_search': {
            const words = queryWords(text(args.query));
            if (!words.length) return 'Error: say what to look for.';
            const canon = app.modules.api<CanonApi>('canon');
            if (!canon) return 'The chat lore is not available.';
            const items = await canon.list();
            const hits = items
                .map((item) => {
                    const title = typeof item.entry.comment === 'string' ? item.entry.comment : '';
                    const content = typeof item.entry.content === 'string' ? item.entry.content : '';
                    const keys = Array.isArray(item.entry.key) ? item.entry.key.join(', ') : '';
                    return {
                        title,
                        content,
                        score: matchScore(`${title} ${keys} ${content}`, words) * 2 + matchScore(title, words),
                    };
                })
                .filter((hit) => hit.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, SEARCH_HITS);
            if (!hits.length) return `Nothing in the lore about: ${words.join(', ')}.`;
            return hits
                .map((hit) => `- ${hit.title || 'entry'}: ${passageAround(hit.content, words, HIT_CHARS)}`)
                .join('\n');
        }
        case 'chat_search': {
            const words = queryWords(text(args.query));
            if (!words.length) return 'Error: say what to look for.';
            const chat = app.host.ctx().chat ?? [];
            const end = options.focusIndex !== undefined ? Math.min(options.focusIndex, chat.length) : chat.length;
            const hits: { index: number; score: number; text: string }[] = [];
            for (let i = 0; i < end; i++) {
                const message = chat[i];
                if (!message || message.is_system) continue;
                const body = agentText(message);
                const score = matchScore(body, words);
                if (score > 0) hits.push({ index: i, score, text: body });
            }
            const best = hits
                .sort((a, b) => b.score - a.score || b.index - a.index)
                .slice(0, SEARCH_HITS)
                .sort((a, b) => a.index - b.index);
            if (!best.length) return `Nothing earlier in the chat about: ${words.join(', ')}.`;
            return best.map((hit) => `#${hit.index}: ${passageAround(hit.text, words, HIT_CHARS)}`).join('\n');
        }
    }
    return `Error: no tool "${name}".`;
}
