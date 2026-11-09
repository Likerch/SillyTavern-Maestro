// @vitest-environment happy-dom
// Proposals (release 1.31): an agent of type «Предложения» is told the receivers it may use, its items go through
// the receiver to autonomy (Inbox by default); an item of an unknown kind or of the wrong form is not taken.
import { afterEach, describe, expect, it } from 'vitest';
import { registerProposalReceiver, resetProposalReceivers } from '../../../src/core/proposal-receivers';
import type { LlmRequest } from '../../../src/shared/contracts';
import { settle } from '../../helpers/core-host';
import { withAgents } from './harness';

afterEach(() => resetProposalReceivers());

function receiver(applied: unknown[]) {
    return registerProposalReceiver({
        kind: 'canon.agentEntry',
        module: 'canon',
        labelKey: 'm44.recv.canon.agentEntry',
        describe: 'a new lore entry',
        schema: {
            type: 'object',
            properties: { name: { type: 'string' }, text: { type: 'string' } },
            required: ['name', 'text'],
        },
        defaultAutonomy: 'inbox',
        toProposal: (data) =>
            data.name === 'Известный'
                ? null
                : {
                      module: 'canon',
                      kind: 'canon.agentEntry',
                      title: `Новое: ${String(data.name)}`,
                      changes: [],
                      payload: data,
                      apply: async (payload) => void applied.push(payload),
                  },
        apply: async (payload) => void applied.push(payload),
    });
}

describe('agent proposals', () => {
    it('tells the model the receivers, routes each item to autonomy, skips duplicates and bad items', async () => {
        const applied: unknown[] = [];
        receiver(applied);
        const h = await withAgents([
            {
                id: 'u-creator-aaaaa',
                name: 'Создатель',
                trigger: { phase: 'manual' },
                result: { type: 'proposals', options: { receivers: ['canon.agentEntry'], max: 5 } },
            },
        ]);
        expect(h.appliers).toEqual(['canon.agentEntry']);
        h.answers.push((request: LlmRequest) => {
            expect(request.schema?.name).toBe('agent_proposals');
            expect(JSON.stringify(request.schema?.schema)).toContain('canon.agentEntry');
            expect(request.messages.at(-1)?.content).toContain('a new lore entry');
            return {
                ok: true,
                data: {
                    proposals: [
                        {
                            kind: 'canon.agentEntry',
                            why: 'Появился трактирщик Борис.',
                            data: { name: 'Борис', text: 'Innkeeper.' },
                        },
                        { kind: 'canon.agentEntry', data: { name: 'Известный', text: 'Dup.' } },
                        { kind: 'canon.agentEntry', data: { name: 'Без текста' } },
                        { kind: 'calendar.other', data: { what: 'x' } },
                    ],
                },
            };
        });
        const run = await h.api.run('u-creator-aaaaa');
        await settle(10);
        expect(run?.ok).toBe(true);
        expect(h.decisions).toHaveLength(1);
        expect(h.decisions[0]?.fallback).toBe('inbox');
        expect(h.decisions[0]?.proposal.title).toBe('Новое: Борис');
        expect(h.decisions[0]?.proposal.description).toBe('Появился трактирщик Борис.');
        expect(h.decisions[0]?.proposal.details).toContain('Создатель');
        expect(run?.applied).toEqual(['во «Входящих»: 1', 'не принято: 2']);
    });
});
