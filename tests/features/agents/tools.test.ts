// Release 1.34: agent tools — the model calls a roll or a search before it answers, Maestro runs them and gives the
// results back, then the answer is asked in the agent's form; the calls are in the run log; a definition keeps only known
// tools; agents with tools are never batched.
import { describe, expect, it } from 'vitest';
import { sanitizeAgent } from '../../../src/domain/agents/def';
import { matchScore, passageAround, queryWords, rollText, sanitizeTools } from '../../../src/domain/agents/tools';
import { AgentRunner } from '../../../src/features/agents/runner';
import { runAgentTool } from '../../../src/features/agents/tools';
import type { LlmRequest } from '../../../src/shared/contracts';
import { msg, withAgents } from './harness';

describe('agent tools: pure parts', () => {
    it('words, matches with Russian forms, passages, roll text; known tools only', () => {
        expect(queryWords('Карта контрабандистов, и Кай!')).toEqual(['карта', 'контрабандистов', 'кай']);
        expect(matchScore('Кай прячет карту у контрабандиста', queryWords('карта контрабандистов'))).toBe(2);
        expect(passageAround('a'.repeat(500) + ' Кай здесь', ['кай'], 40)).toMatch(/^…a+ Кай здесь$/);
        expect(
            rollText(
                '1d20+3',
                {
                    rolls: [14],
                    natural: 14,
                    modifier: 3,
                    total: 17,
                    target: 15,
                    under: false,
                    outcome: 'success',
                    missing: [],
                },
                'взлом',
            ),
        ).toBe('взлом: 1d20+3 = [14] + 3 = 17 vs 15 → success');
        expect(sanitizeTools(['roll', 'roll', 'shell', 3, 'chat_search'])).toEqual(['roll', 'chat_search']);
        const def = sanitizeAgent({ name: 'A', tools: ['roll', 'nope'] }, 1)!;
        expect(def.tools).toEqual(['roll']);
        expect(def.capabilities).toContain('tool.roll');
        expect(AgentRunner.batchable({ def: { ...def, batch: true }, phase: 'post', reason: 'r' })).toBe(false);
    });

    it('runs: a roll by the dice engine, a search of the older chat; refuses tools it was not given', async () => {
        const h = await withAgents([]);
        const rng = () => 0.5;
        expect(await runAgentTool(h.app, 'roll', { dice: '1d20+3', difficulty: 12 }, { allowed: ['roll'], rng })).toBe(
            '1d20+3 = [11] + 3 = 14 vs 12 → success',
        );
        expect(await runAgentTool(h.app, 'roll', { dice: 'много' }, { allowed: ['roll'] })).toMatch(/^Error/);
        expect(await runAgentTool(h.app, 'chat_search', { query: 'таверну' }, { allowed: ['roll'] })).toMatch(
            /no tool/,
        );
        expect(await runAgentTool(h.app, 'chat_search', { query: 'таверну' }, { allowed: ['chat_search'] })).toBe(
            '#1: Я вхожу в таверну.',
        );
    });
});

describe('agent tools: the rounds', () => {
    it('a roll asked by the model, its result given back, then the answer in the agent’s form; logged', async () => {
        const h = await withAgents([
            {
                id: 'u-mech-aaaaa',
                name: 'Механика',
                trigger: { phase: 'manual' },
                result: { type: 'note', options: { show: 'strip' } },
                tools: ['roll'],
            },
        ]);
        h.chat.push(msg('Кай пробует вскрыть замок.', false));
        h.answers.push((request: LlmRequest) => {
            expect(request.tools).toHaveLength(1);
            expect(request.schema).toBeUndefined();
            return {
                ok: true,
                text: '',
                toolCalls: [{ id: 'c1', function: { name: 'roll', arguments: '{"dice":"1d20","difficulty":10}' } }],
            };
        });
        h.answers.push((request: LlmRequest) => {
            const tool = request.messages.find((m) => m.role === 'tool');
            expect(tool?.tool_call_id).toBe('c1');
            expect(tool?.content).toMatch(/^1d20 = \[\d+\] = \d+ vs 10 → (success|failure|critical|fumble)$/);
            return { ok: true, text: '' };
        });
        h.answers.push((request: LlmRequest) => {
            expect(request.tools).toBeUndefined();
            expect(request.messages.at(-1)?.content).toMatch(/final answer/);
            return { ok: true, text: 'Замок поддался.' };
        });
        const run = await h.api.run('u-mech-aaaaa', { messageIndex: 3 });
        expect(run?.ok).toBe(true);
        expect(run?.tools).toHaveLength(1);
        expect(run?.tools?.[0]).toMatchObject({ name: 'roll', args: { dice: '1d20', difficulty: 10 } });
        expect(h.llm).toHaveBeenCalledTimes(3);
    });
});
