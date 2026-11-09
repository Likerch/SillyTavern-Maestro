import { describe, expect, it } from 'vitest';
import { capabilitiesOf, defaultPhaseFor, defaultResult, sanitizeAgent } from '../../../src/domain/agents/def';
import { parseAgentOutput } from '../../../src/domain/agents/output';
import { answerForm, answerSchema } from '../../../src/domain/agents/request';

const result = {
    type: 'proposals' as const,
    options: { receivers: ['canon.agentEntry', 'calendar.agentPromise'], max: 2 },
};
const receivers = [
    { kind: 'canon.agentEntry', describe: 'a new entry', schema: { type: 'object' } },
    { kind: 'calendar.agentPromise', describe: 'a promise', schema: { type: 'object' } },
    { kind: 'other.kind', describe: 'not allowed', schema: {} },
];

describe('proposals in the domain', () => {
    it('defaults, phase, capabilities and sanitising', () => {
        expect(defaultResult('proposals')).toEqual({ type: 'proposals', options: { receivers: [], max: 5 } });
        expect(defaultPhaseFor('proposals')).toBe('schedule');
        expect(capabilitiesOf({ result, sources: [] })).toEqual([
            'propose.canon.agentEntry',
            'propose.calendar.agentPromise',
        ]);
        const def = sanitizeAgent(
            {
                name: 'p',
                result: { type: 'proposals', options: { receivers: ['canon.agentEntry', 'Bad Kind!', 5], max: 99 } },
            },
            1,
        );
        expect(def?.result).toEqual({ type: 'proposals', options: { receivers: ['canon.agentEntry'], max: 20 } });
    });

    it('tells the model only the allowed receivers; the schema lists their kinds', () => {
        const form = answerForm(result, receivers);
        expect(form).toContain('"canon.agentEntry": a new entry');
        expect(form).toContain('"calendar.agentPromise": a promise');
        expect(form).not.toContain('not allowed');
        expect(form).toContain('at most 2 proposals');
        const schema = answerSchema(result, receivers)?.schema as {
            properties: { proposals: { items: { properties: { kind: { enum: string[] } } } } };
        };
        expect(schema.properties.proposals.items.properties.kind.enum).toEqual([
            'canon.agentEntry',
            'calendar.agentPromise',
        ]);
        expect(answerForm(result)).toContain('(none)');
    });

    it('takes allowed items with data, up to the limit; an empty list is nothing', () => {
        expect(
            parseAgentOutput(result, {
                proposals: [
                    { kind: 'other.kind', data: {} },
                    { kind: 'canon.agentEntry', why: 'Новое лицо.', data: { name: 'Борис' } },
                    { kind: 'canon.agentEntry', data: 'x' },
                    { kind: 'calendar.agentPromise', data: { what: 'a' } },
                    { kind: 'calendar.agentPromise', data: { what: 'b' } },
                ],
            }),
        ).toEqual({
            ok: true,
            output: {
                type: 'proposals',
                items: [
                    { kind: 'canon.agentEntry', why: 'Новое лицо.', data: { name: 'Борис' } },
                    { kind: 'calendar.agentPromise', why: '', data: { what: 'a' } },
                ],
            },
        });
        expect(parseAgentOutput(result, { proposals: [] })).toEqual({ ok: true, output: { type: 'none' } });
        expect(parseAgentOutput(result, { nope: 1 })).toEqual({ ok: false, error: 'shape' });
    });
});
