import { describe, expect, it } from 'vitest';
import { defaultResult } from '../../../src/domain/agents/def';
import {
    AGENT_FRAME,
    answerForm,
    answerSchema,
    buildAgentMessages,
    estimateTokens,
    fitSources,
    inlineSources,
    isJsonType,
    missingVars,
    substitute,
} from '../../../src/domain/agents/request';
import type { RenderedSource } from '../../../src/domain/agents/request';
import { AGENT_RESULT_TYPES } from '../../../src/domain/agents/types';

const src = (id: string, text: string, stable: boolean): RenderedSource => ({
    id,
    title: id.toUpperCase(),
    text,
    stable,
});

describe('substitute', () => {
    const sources = new Map([['canon', src('canon', 'Mira is a smuggler.', true)]]);
    const values = { char: 'Мира', user: 'Игрок', language: 'Russian', vars: { forbidden: 'a, b' }, sources };

    it('fills the placeholders and places a source inline', () => {
        const text = substitute(
            '{{char}} vs {{user}} in {{язык_истории}} / {{story_language}}. No: {{agent.forbidden}}{{agent.none}}. {{source:canon}} {{source:none}} {{getvar::x}}',
            values,
        );
        expect(text).toBe(
            'Мира vs Игрок in Russian / Russian. No: a, b. <context source="canon" title="CANON">\nMira is a smuggler.\n</context>  {{getvar::x}}',
        );
    });

    it('lists inline sources and missing variables', () => {
        expect([...inlineSources('a {{source:canon}} b {{ source:lore }}')]).toEqual(['canon', 'lore']);
        expect(missingVars('{{agent.a}} {{agent.b}} {{agent.a}}', { a: '1' })).toEqual(['b']);
        expect(missingVars('{{agent.a}}', undefined)).toEqual(['a']);
    });
});

describe('answer forms', () => {
    it('describes every type; JSON types have a schema', () => {
        for (const type of AGENT_RESULT_TYPES) {
            const result = defaultResult(type);
            expect(answerForm(result).length).toBeGreaterThan(20);
            expect(Boolean(answerSchema(result))).toBe(isJsonType(type));
        }
    });

    it('lists the flags and the fields the model may use', () => {
        expect(answerForm({ type: 'flags', options: { names: ['tension', 'mood'] } })).toContain('tension, mood');
        const schema = answerSchema({ type: 'flags', options: { names: ['tension'] } });
        expect(schema?.schema).toMatchObject({ properties: { flags: { properties: { tension: {} } } } });
        const form = answerForm({
            type: 'memory',
            options: {
                fields: [{ name: 'goal', hint: 'the goal' }, { name: 'next' }],
                inject: false,
                injectOptions: { position: 'depth', depth: 2, role: 'system', lifetime: 'untilNext' },
            },
        });
        expect(form).toContain('- "goal": the goal');
        expect(form).toContain('- "next"');
        expect(answerForm({ type: 'choices', options: { count: 4, send: false } })).toContain('exactly 4');
    });
});

describe('fitSources', () => {
    it('cuts changing sources from their start first, then stable ones from their end', () => {
        const out = fitSources([src('card', 'C'.repeat(50), true), src('messages', 'OLD' + 'n'.repeat(47), false)], 60);
        expect(out[0]?.text).toBe('C'.repeat(50));
        expect(out[1]?.text).toBe('n'.repeat(10));
        const harder = fitSources([src('card', 'ABCDEFGHIJ', true), src('messages', 'xxxxxxxxxx', false)], 5);
        expect(harder).toEqual([src('card', 'ABCDE', true)]);
    });

    it('keeps everything that fits', () => {
        const list = [src('a', 'aaa', true)];
        expect(fitSources(list, 100)).toEqual(list);
    });
});

describe('buildAgentMessages', () => {
    const def = {
        instruction: 'Edit the reply of {{char}}. Avoid: {{agent.avoid}}. {{source:card}}',
        result: defaultResult('rewrite'),
        vars: { avoid: 'clichés' },
    };

    it('frame, then the sources (stable first, inline ones left out), then the task with the answer form', () => {
        const messages = buildAgentMessages({
            def,
            sources: [src('reply', 'The reply.', false), src('lore', 'Lore.', true), src('card', 'Card.', true)],
            values: { char: 'Мира', user: 'Я', language: 'Russian' },
            extra: 'be brief',
        });
        expect(messages[0]).toEqual({ role: 'system', content: AGENT_FRAME });
        expect(messages[1]?.content).toBe(
            '<context source="lore" title="LORE">\nLore.\n</context>\n\n<context source="reply" title="REPLY">\nThe reply.\n</context>',
        );
        expect(messages[2]?.content).toContain('Edit the reply of Мира. Avoid: clichés.');
        expect(messages[2]?.content).toContain('<context source="card" title="CARD">');
        expect(messages[2]?.content).toContain('Additional instruction for this run: be brief');
        expect(messages[2]?.content).toContain('editNeeded');
        expect(estimateTokens(messages)).toBeGreaterThan(10);
    });

    it('a variant replaces the instruction; no sources → no context message', () => {
        const messages = buildAgentMessages({
            def,
            variantInstruction: '',
            sources: [],
            values: { char: 'a', user: 'b', language: 'English' },
        });
        expect(messages).toHaveLength(2);
        expect(messages[1]?.content).toContain('(no task given)');
    });
});
