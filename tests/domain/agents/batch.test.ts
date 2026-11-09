import { describe, expect, it } from 'vitest';
import {
    BATCH_FRAME,
    batchSchema,
    buildBatchMessages,
    costShares,
    groupBy,
    splitBatch,
    unionSources,
} from '../../../src/domain/agents/batch';
import type { BatchItem } from '../../../src/domain/agents/batch';
import { averageRunCost, estimateTurn, runsPerTurn } from '../../../src/domain/agents/cost';
import { defaultResult } from '../../../src/domain/agents/def';
import type { AgentRun } from '../../../src/domain/agents/types';

const src = (id: string, text: string, stable = false) => ({ id, title: id.toUpperCase(), text, stable });

const items: BatchItem[] = [
    {
        key: 'a1',
        name: 'Критик "злой"',
        instruction: 'Critique {{char}}. Avoid {{agent.x}}.',
        vars: { x: 'fluff' },
        result: defaultResult('note'),
        sources: [src('messages', 'short'), src('card', 'Card.', true)],
    },
    {
        key: 'a2',
        name: 'Варианты',
        instruction: 'Offer moves.',
        result: { type: 'choices', options: { count: 3, send: false } },
        sources: [src('messages', 'a longer version')],
        extra: 'only bold ones',
    },
];

describe('batches', () => {
    it('sends the union of sources once, stable first, the longest version of a source', () => {
        expect(unionSources(items)).toEqual([src('card', 'Card.', true), src('messages', 'a longer version')]);
    });

    it('one task block per agent with its answer form, and one JSON object for all', () => {
        const messages = buildBatchMessages(items, { char: 'Мира', user: 'Я', language: 'Russian' });
        expect(messages[0]).toEqual({ role: 'system', content: BATCH_FRAME });
        expect(messages[1]?.content).toContain('<context source="card"');
        const task = messages[2]?.content ?? '';
        expect(task).toContain('<agent_task id="a1" name="Критик \'злой\'">');
        expect(task).toContain('Critique Мира. Avoid fluff.');
        expect(task).toContain('Additional instruction for this run: only bold ones');
        expect(task).toContain('Form of the value of "a2": Answer with JSON: {"choices"');
        expect(task).toContain('{"a1": …, "a2": …}');
        const schema = batchSchema(items).schema as {
            properties: Record<string, { type?: unknown }>;
            required: string[];
        };
        expect(schema.required).toEqual(['a1', 'a2']);
        expect(schema.properties.a1).toEqual({ type: 'string' });
        expect(schema.properties.a2?.type).toBe('object');
        expect(buildBatchMessages([{ ...items[1]!, sources: [] }], { char: '', user: '', language: '' })).toHaveLength(
            2,
        );
    });

    it('splits the answer by key; missing or null parts are missing', () => {
        const parts = splitBatch({ a1: 'Note.', a2: null }, ['a1', 'a2', 'a3']);
        expect([...parts.entries()]).toEqual([['a1', 'Note.']]);
        expect(splitBatch('text', ['a1']).size).toBe(0);
        expect(splitBatch([1], ['a1']).size).toBe(0);
    });

    it('shares cost by task length and groups keeping the order', () => {
        expect(costShares([100, 300])).toEqual([0.25, 0.75]);
        expect(costShares([0, 0])).toEqual([0.5, 0.5]);
        expect(costShares([])).toEqual([]);
        expect(groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even'))).toEqual([
            [1, 3],
            [2, 4],
        ]);
    });
});

describe('turn cost estimate', () => {
    const run = (agentId: string, costUsd?: number, test = false): AgentRun =>
        ({
            id: Math.random().toString(),
            agentId,
            agentName: agentId,
            chatId: 'c',
            phase: 'post',
            reason: 'r',
            startedAt: 1,
            ms: 1,
            ok: true,
            costUsd,
            test,
        }) as AgentRun;

    it('runs per turn by moment', () => {
        expect(runsPerTurn({ phase: 'post' })).toBe(1);
        expect(runsPerTurn({ phase: 'manual' })).toBe(0);
        expect(runsPerTurn({ phase: 'schedule', everyMessages: 10 })).toBe(0.1);
        expect(runsPerTurn({ phase: 'schedule', events: ['sceneEnd'] })).toBe(0.1);
        expect(runsPerTurn({ phase: 'schedule' })).toBe(0);
    });

    it('averages the recent paid runs and sums the agents; unknown ones are counted apart', () => {
        const runs = [run('a', 0.002), run('a', 0.004), run('a', 1, true), run('b', 0.01), run('c')];
        expect(averageRunCost(runs, 'a')).toBeCloseTo(0.003);
        expect(averageRunCost(runs, 'c')).toBeNull();
        const estimate = estimateTurn(runs, [
            { id: 'a', trigger: { phase: 'post' } },
            { id: 'b', trigger: { phase: 'schedule', everyMessages: 5 } },
            { id: 'c', trigger: { phase: 'prefetch' } },
            { id: 'd', trigger: { phase: 'manual' } },
        ]);
        expect(estimate.usd).toBeCloseTo(0.003 + 0.002);
        expect(estimate).toMatchObject({ counted: 2, unknown: 1 });
    });
});
