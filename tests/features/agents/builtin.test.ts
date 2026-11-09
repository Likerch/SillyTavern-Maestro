// @vitest-environment happy-dom
// Built-in agents (release 1.29): the interceptor leaves an unchanged task's request as the same object, puts the
// user's instruction and model parameters into a changed one, and logs every run of a built-in agent.
import { afterEach, describe, expect, it } from 'vitest';
import { registerBuiltInAgent, resetBuiltInAgents } from '../../../src/core/builtin-agents';
import { ADDITION_HEADER } from '../../../src/domain/agents/builtin';
import type { LlmRequest } from '../../../src/shared/contracts';
import { settle } from '../../helpers/core-host';
import { harness, tabsOf } from './harness';

const DEFAULT = 'You are a strict quality judge.';

function judge(): LlmRequest {
    return {
        task: 'quality.judge',
        messages: [
            { role: 'system', content: `${DEFAULT}\nAnswer with JSON only.` },
            { role: 'user', content: 'Reply: …' },
        ],
        maxTokens: 600,
        temperature: 0,
    };
}

afterEach(() => resetBuiltInAgents());

describe('built-in agents', () => {
    it('an unchanged built-in agent leaves the request as the same object; a changed one gets the instruction and model', async () => {
        const off = registerBuiltInAgent({
            id: 'quality.judge',
            module: 'quality',
            group: 'quality',
            icon: 'fa-gavel',
            defaultInstructions: () => [DEFAULT],
            defaults: { maxTokens: 600, temperature: 0 },
            switch: { path: 'judge' },
        });
        const h = await harness();
        const interceptor = h.interceptors[0]!;
        const request = judge();
        expect(interceptor.before!(request)).toBe(request);
        const other: LlmRequest = { ...request, task: 'agent.u-x-aaaaa' };
        expect(interceptor.before!(other)).toBe(other);

        // What the editor saves, read by a fresh module.
        const file = {
            schema: 1,
            agents: [],
            sets: [],
            global: { overrides: {} },
            hintShown: true,
            builtins: {
                'quality.judge': {
                    mode: 'addition',
                    addition: 'Apologies are a defect.',
                    temperature: 0.3,
                    reasoning: 'low',
                },
            },
        };
        for (const dispose of h.disposers) await dispose();
        const h2 = await harness({ seed: new Map([['maestro-agents.json', file]]) });
        const changed = h2.interceptors[0]!.before!(judge());
        expect(changed.messages[0]?.content).toBe(
            `${DEFAULT}\n\n${ADDITION_HEADER}\nApologies are a defect.\nAnswer with JSON only.`,
        );
        expect(changed).toMatchObject({ temperature: 0.3, reasoning: 'low', maxTokens: 600 });
        off();
    });

    it('logs a run of a built-in agent with its request, answer and cost; shows it in the list', async () => {
        registerBuiltInAgent({
            id: 'quality.judge',
            module: 'quality',
            group: 'quality',
            icon: 'fa-gavel',
            defaultInstructions: () => [DEFAULT],
            defaults: { maxTokens: 600, temperature: 0 },
        });
        const h = await harness();
        h.interceptors[0]!.after!(
            judge(),
            { ok: true, data: { defects: [] }, text: '{"defects":[]}', costUsd: 0.002 },
            120,
        );
        h.interceptors[0]!.after!({ ...judge(), task: 'revision' }, { ok: true }, 10);
        await settle(5);
        const tabs = tabsOf(h);
        const log = document.createElement('div');
        tabs.find((tab) => tab.id === 'agents-log')!.render(log);
        expect(log.textContent).toContain('Судья качества');
        expect(log.textContent).toContain('$0.0020');
        const list = document.createElement('div');
        tabs[0]!.render(list);
        expect(list.textContent).toContain('Встроенные агенты');
        expect(list.textContent).toContain('Судья качества');
        const edit = [...list.querySelectorAll('button')]
            .filter((button) => button.getAttribute('title') === 'Изменить')
            .at(-1);
        edit?.click();
        await settle(5);
        expect(list.textContent).toContain('Дополнительные указания');
        expect(list.textContent).toContain(DEFAULT);
    });
});
