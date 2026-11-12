// Release 1.34: the assistant's agent tools — list, read, make an agent from a template or a definition, switch it in a
// scope, change a built-in agent's instruction; each write is a before/after card applied through M44's API.
import { afterEach, describe, expect, it } from 'vitest';
import { registerBuiltInAgent, resetBuiltInAgents } from '../../../src/core/builtin-agents';
import { agentReadTools, agentWriteTools } from '../../../src/features/assistant/tools/agents';
import type { ToolContext, ToolSpec } from '../../../src/features/assistant/api';
import { harness } from '../agents/harness';

afterEach(() => resetBuiltInAgents());

const tool = (list: ToolSpec[], name: string) => list.find((item) => item.name === name)!;

describe('assistant: agent tools', () => {
    it('makes an agent from a template, switches it on in the chat, lists it', async () => {
        const h = await harness();
        const ctx = { app: h.app, locale: 'ru' } as unknown as ToolContext;
        const writes = agentWriteTools();
        const plan = await tool(writes, 'agent_save').plan!(
            { template: 'anti-loop', definition: { name: 'Петля' } },
            ctx,
        );
        expect(plan.before).toBeNull();
        expect(plan.after).toMatchObject({ name: 'Петля', template: 'anti-loop' });
        const saved = (await plan.apply()) as { result: { id: string } };
        const id = saved.result.id;
        expect(h.api.get(id)?.name).toBe('Петля');

        const change = await tool(writes, 'agent_save').plan!(
            { definition: { id, instruction: 'Watch the loops.' } },
            ctx,
        );
        expect(change.before).toMatchObject({ name: 'Петля' });
        expect(change.after).toMatchObject({ name: 'Петля', instruction: 'Watch the loops.' });

        const on = await tool(writes, 'agent_switch').plan!({ id, on: true }, ctx);
        expect(on.scope).toBe('chat');
        expect(on.summary).toContain('этот чат');
        await on.apply({ scope: 'chat' });
        expect(h.api.states().get(id)?.on).toBe(true);

        const listed = await tool(agentReadTools(), 'agents_list').run!({}, ctx);
        expect((listed.data as { agents: { id: string; on: boolean }[] }).agents).toContainEqual(
            expect.objectContaining({ id, on: true }),
        );
        await expect(tool(writes, 'agent_switch').plan!({ id: 'nobody', on: true }, ctx)).rejects.toThrow('nobody');
        await expect(tool(writes, 'agent_save').plan!({ template: 'nope' }, ctx)).rejects.toThrow('nope');
    });

    it("changes a built-in agent's instruction and puts it back", async () => {
        const h = await harness();
        const ctx = { app: h.app, locale: 'en' } as unknown as ToolContext;
        registerBuiltInAgent({
            id: 'dramatis.turn',
            module: 'dramatis',
            neighbour: 'dramatis',
            group: 'neighbours',
            icon: 'fa-masks-theater',
            defaultInstructions: () => ['Read the turn.'],
            defaults: { maxTokens: 900, temperature: 0.3 },
        });
        const read = await tool(agentReadTools(), 'agent_get').run!({ id: 'dramatis.turn' }, ctx);
        expect(read.data).toMatchObject({ builtin: true, defaultInstruction: 'Read the turn.', changed: null });
        const set = tool(agentWriteTools(), 'builtin_agent_instruction');
        const plan = await set.plan!({ id: 'dramatis.turn', mode: 'addition', text: 'Villains stay cruel.' }, ctx);
        await plan.apply();
        expect(h.api.builtinOverride?.('dramatis.turn')).toMatchObject({
            mode: 'addition',
            addition: 'Villains stay cruel.',
        });
        const reset = await set.plan!({ id: 'dramatis.turn', mode: 'default' }, ctx);
        await reset.apply();
        expect(h.api.builtinOverride?.('dramatis.turn')).toBeUndefined();
        await expect(set.plan!({ id: 'dramatis.turn', mode: 'full' }, ctx)).rejects.toThrow();
    });
});
