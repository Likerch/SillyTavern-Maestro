import { describe, expect, it } from 'vitest';
import {
    blankAgent,
    capabilitiesOf,
    decidingScope,
    defaultPhaseFor,
    defaultResult,
    effectiveStates,
    newAgentId,
    sanitizeAgent,
    sanitizeScopeState,
    sanitizeSet,
    setFromStates,
    slugOf,
} from '../../../src/domain/agents/def';
import type { AgentScopeState, AgentSet, AgentState } from '../../../src/domain/agents/types';
import { AGENT_RESULT_TYPES } from '../../../src/domain/agents/types';

describe('ids', () => {
    it('makes a latin slug of a Russian name', () => {
        expect(slugOf('Прозаик')).toBe('prozaik');
        expect(slugOf('Сверка — голоса!')).toBe('sverka-golosa');
        expect(slugOf('???')).toBe('agent');
    });

    it('makes ids u-<slug>-<rand> that pass the id check', () => {
        const id = newAgentId('Хроникёр сцены', () => 0.5);
        expect(id).toMatch(/^u-hroniker-sceny-[a-z0-9]{5}$/);
        expect(sanitizeAgent({ id, name: 'x' }, 1)?.id).toBe(id);
    });
});

describe('defaults', () => {
    it('gives every result type its options and a fitting phase', () => {
        for (const type of AGENT_RESULT_TYPES) {
            const result = defaultResult(type);
            expect(result.type).toBe(type);
            expect(typeof defaultPhaseFor(type)).toBe('string');
        }
        expect(defaultPhaseFor('inject')).toBe('prefetch');
        expect(defaultPhaseFor('rewrite')).toBe('post');
        expect(defaultPhaseFor('memory')).toBe('schedule');
    });

    it('makes a blank agent: a note after the reply over the last 6 messages', () => {
        const def = blankAgent('Тест', 5, 'u-test-aaaaa');
        expect(def).toMatchObject({
            id: 'u-test-aaaaa',
            name: 'Тест',
            trigger: { phase: 'post' },
            result: { type: 'note' },
        });
        expect(def.sources).toEqual([{ id: 'messages', budget: 6 }]);
        expect(def.capabilities).toContain('note');
    });
});

describe('capabilities', () => {
    it('names what an agent may do', () => {
        expect(
            capabilitiesOf({ result: { type: 'rewrite', options: { holdReply: false } }, sources: [{ id: 'reply' }] }),
        ).toEqual(['reply.rewrite', 'read.reply']);
        expect(capabilitiesOf({ result: { type: 'verdict', options: { action: 'swipe' } }, sources: [] })).toEqual([
            'reply.verdict',
            'reply.redo',
        ]);
        const memory = defaultResult('memory');
        if (memory.type === 'memory') memory.options.inject = true;
        expect(capabilitiesOf({ result: memory, sources: [] })).toEqual(['memory', 'prompt.inject']);
        expect(capabilitiesOf({ result: defaultResult('flags'), sources: [] })).toEqual(['prompt.flags']);
        expect(capabilitiesOf({ result: defaultResult('choices'), sources: [] })).toEqual(['choices']);
        expect(capabilitiesOf({ result: defaultResult('inject'), sources: [] })).toEqual(['prompt.inject']);
    });
});

describe('sanitizeAgent', () => {
    it('drops what is not an agent', () => {
        expect(sanitizeAgent(null, 1)).toBeNull();
        expect(sanitizeAgent({ name: '   ' }, 1)).toBeNull();
        expect(sanitizeAgent([], 1)).toBeNull();
    });

    it('keeps a valid agent and recomputes its capabilities', () => {
        const def = sanitizeAgent(
            {
                id: 'u-prose-abcde',
                name: 'Прозаик',
                icon: 'fa-feather',
                description: 'стиль',
                origin: 'template:prose',
                templateId: 'prose',
                instruction: 'Fix the style. {{agent.forbidden}}',
                vars: { forbidden: 'a, b', 'bad key!': 'x', n: 5 },
                variants: [
                    { id: 'soft', name: 'Мягкий', instruction: 'soft' },
                    { id: 'soft', name: 'dup', instruction: '' },
                    { name: 'x' },
                ],
                sources: [{ id: 'messages', budget: 3 }, { id: 'reply' }, { id: 'reply' }, { id: '1bad' }, 'x'],
                trigger: {
                    phase: 'post',
                    priority: 10,
                    when: { words: ['меч'], modes: ['cinema', 'nope'], group: 'never', stalled: true },
                },
                result: { type: 'rewrite', options: { holdReply: true } },
                model: { profile: 'p1', temperature: 5, maxTokens: 10, reasoning: 'loud' },
                batch: true,
                limits: { perTurn: 2, dailyUsd: 0.5 },
                capabilities: ['everything'],
                updatedAt: 7,
            },
            1,
        );
        expect(def).toMatchObject({
            id: 'u-prose-abcde',
            icon: 'fa-feather',
            description: 'стиль',
            origin: 'template:prose',
            templateId: 'prose',
            vars: { forbidden: 'a, b' },
            variants: [{ id: 'soft', name: 'Мягкий', instruction: 'soft' }],
            sources: [{ id: 'messages', budget: 3 }, { id: 'reply' }],
            trigger: {
                phase: 'post',
                priority: 10,
                when: { words: ['меч'], modes: ['cinema'], group: 'never', stalled: true },
            },
            result: { type: 'rewrite', options: { holdReply: true } },
            model: { profile: 'p1', temperature: 2, maxTokens: 50, reasoning: 'off' },
            batch: true,
            limits: { perTurn: 2, dailyUsd: 0.5 },
            capabilities: ['reply.rewrite', 'read.messages', 'read.reply'],
            updatedAt: 7,
        });
    });

    it('gives a new id to a bad one and falls back on unknown parts', () => {
        const def = sanitizeAgent(
            { id: 'evil id', name: 'X', origin: 'hacker', result: { type: 'nuke' }, trigger: { phase: 'never' } },
            3,
        );
        expect(def?.id).toMatch(/^u-x-/);
        expect(def?.origin).toBe('user');
        expect(def?.result.type).toBe('note');
        expect(def?.trigger.phase).toBe('post');
        expect(def?.updatedAt).toBe(3);
        expect(def?.sources).toEqual([{ id: 'messages', budget: 6 }]);
    });

    it('sanitises the options of every type', () => {
        const flags = sanitizeAgent(
            { name: 'f', result: { type: 'flags', options: { names: ['ok_1', 'Bad', '9no', 'ok_1'] } } },
            1,
        );
        expect(flags?.result).toEqual({ type: 'flags', options: { names: ['ok_1'] } });
        const verdict = sanitizeAgent({ name: 'v', result: { type: 'verdict', options: { action: 'explode' } } }, 1);
        expect(verdict?.result).toEqual({ type: 'verdict', options: { action: 'mark' } });
        const choices = sanitizeAgent(
            { name: 'c', result: { type: 'choices', options: { count: 99, send: true } } },
            1,
        );
        expect(choices?.result).toEqual({ type: 'choices', options: { count: 5, send: true } });
        const note = sanitizeAgent({ name: 'n', result: { type: 'note', options: { show: 'toast' } } }, 1);
        expect(note?.result).toEqual({ type: 'note', options: { show: 'toast' } });
        const inject = sanitizeAgent(
            {
                name: 'i',
                result: {
                    type: 'inject',
                    options: { position: 'top', depth: 500, role: 'user', lifetime: 'untilNext' },
                },
            },
            1,
        );
        expect(inject?.result).toEqual({
            type: 'inject',
            options: { position: 'top', depth: 100, role: 'user', lifetime: 'untilNext' },
        });
        const memory = sanitizeAgent(
            {
                name: 'm',
                result: {
                    type: 'memory',
                    options: {
                        fields: [{ name: 'goal', hint: 'h' }, { name: 'goal' }, { name: '' }, 'x', { name: 'next' }],
                        inject: true,
                    },
                },
            },
            1,
        );
        expect(memory?.result).toMatchObject({
            type: 'memory',
            options: {
                fields: [{ name: 'goal', hint: 'h' }, { name: 'next' }],
                inject: true,
                injectOptions: { lifetime: 'untilNext' },
            },
        });
    });

    it('keeps the schedule part of a trigger', () => {
        const def = sanitizeAgent(
            {
                name: 's',
                trigger: {
                    phase: 'schedule',
                    everyMessages: 10,
                    events: ['sceneEnd', 'bogus'],
                    breakHours: 6,
                    onSendTimeoutMs: 999_999,
                },
            },
            1,
        );
        expect(def?.trigger).toEqual({
            phase: 'schedule',
            everyMessages: 10,
            events: ['sceneEnd'],
            breakHours: 6,
            onSendTimeoutMs: 30_000,
        });
    });

    it('accepts a card origin', () => {
        expect(sanitizeAgent({ name: 'c', origin: 'card:Alice.png' }, 1)?.origin).toBe('card:Alice.png');
    });
});

describe('sets and scopes', () => {
    const sets = new Map<string, AgentSet>([
        [
            'a',
            {
                id: 'a',
                name: 'A',
                agents: { 'u-one-aaaaa': { on: true }, 'template:prose': { on: true, variant: 'soft' } },
            },
        ],
        ['b', { id: 'b', name: 'B', agents: { 'u-two-bbbbb': { on: true } } }],
    ]);
    const templates = new Map([['prose', 'u-prose-ccccc']]);

    it('takes the nearest set as a whole and point changes on top', () => {
        const layers: AgentScopeState[] = [
            { set: 'a', overrides: { 'u-two-bbbbb': { on: true } } },
            { overrides: { 'u-one-aaaaa': { on: false } } },
            { set: 'b', overrides: { 'u-three-ccccc': { on: true, profile: 'x' } } },
        ];
        const states = effectiveStates(layers, sets, templates);
        expect([...states.entries()]).toEqual([
            ['u-two-bbbbb', { on: true }],
            ['u-three-ccccc', { on: true, profile: 'x' }],
        ]);
    });

    it('maps template entries of a set to the own agents taken from them', () => {
        const states = effectiveStates([{ set: 'a', overrides: {} }, null, undefined], sets, templates);
        expect(states.get('u-prose-ccccc')).toEqual({ on: true, variant: 'soft' });
        expect(effectiveStates([{ set: 'a', overrides: {} }], sets, new Map()).has('u-prose-ccccc')).toBe(false);
    });

    it('tells which scope decides an agent', () => {
        const layers = [
            { scope: 'global', state: { set: 'a', overrides: {} } as AgentScopeState },
            { scope: 'chat', state: { overrides: { 'u-one-aaaaa': { on: false } } } as AgentScopeState },
        ];
        expect(decidingScope('u-one-aaaaa', layers)).toEqual({ scope: 'chat', bySet: false });
        expect(decidingScope('u-two-bbbbb', layers)).toEqual({ scope: 'global', bySet: true });
        expect(decidingScope('x', [{ scope: 'chat', state: null }])).toBeNull();
    });

    it('saves the agents that are on as a set', () => {
        const states = new Map<string, AgentState>([
            ['u-one-aaaaa', { on: true }],
            ['u-two-bbbbb', { on: false }],
        ]);
        expect(setFromStates('mine', 'Мой', states)).toEqual({
            id: 'mine',
            name: 'Мой',
            agents: { 'u-one-aaaaa': { on: true } },
        });
    });

    it('sanitises sets and scope states', () => {
        expect(sanitizeSet({ id: 'Bad Id', name: 'x' })).toBeNull();
        expect(sanitizeSet({ id: 'ok', name: '' })).toBeNull();
        expect(
            sanitizeSet({
                id: 'ok',
                name: 'Ок',
                agents: { 'u-one-aaaaa': { variant: 'v' }, 'bad key!': { on: true }, 'template:prose': 'x' },
            }),
        ).toEqual({
            id: 'ok',
            name: 'Ок',
            agents: { 'u-one-aaaaa': { on: false, variant: 'v' } },
        });
        expect(
            sanitizeScopeState({
                set: 'a',
                overrides: { 'u-one-aaaaa': { on: true, profile: 'p' }, 'u-two-bbbbb': {} },
            }),
        ).toEqual({
            set: 'a',
            overrides: { 'u-one-aaaaa': { on: true, profile: 'p' } },
        });
        expect(sanitizeScopeState(null)).toEqual({ overrides: {} });
    });
});
