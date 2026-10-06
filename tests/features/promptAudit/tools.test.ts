// M38 «Проверка промпта» from the assistant's chat: prompt_audit returns the report (or checks the last turn), and
// prompt_audit_fix proposes one fix as a before/after card; advice-only fixes and wrong scopes come back as sentences.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolSpec } from '../../../src/features/assistant/api';
import { createAuditEnv, realCaseMessages, realCaseSlots } from '../../helpers/prompt-audit-env';
import type { AuditEnv } from '../../helpers/prompt-audit-env';

type Dict = Record<string, unknown>;

let a: AuditEnv;

function tool(name: string): ToolSpec {
    const found = a.tools.get(name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
}

function context(): ToolContext {
    return { app: a.env.app, log: a.env.app.log, locale: 'en', settings: {} as ToolContext['settings'] };
}

beforeEach(async () => {
    a = await createAuditEnv();
});

afterEach(async () => {
    await a.stop();
});

describe('assistant tools', () => {
    it('are registered with the assistant and follow it when it restarts', async () => {
        expect([...a.tools.keys()]).toEqual(['prompt_audit', 'prompt_audit_fix']);
        const second = new Map<string, ToolSpec>();
        a.env.apis.set('assistant', {
            registerTool: (spec: ToolSpec) => {
                second.set(spec.name, spec);
                return () => second.delete(spec.name);
            },
        });
        a.env.settings.notify('core.modules.assistant');
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(a.tools.size).toBe(0);
        expect([...second.keys()]).toEqual(['prompt_audit', 'prompt_audit_fix']);
        await a.stop();
        expect(second.size).toBe(0);
        await a.restart();
    });

    it('prompt_audit: nothing to check before a turn, then the report with quotes, owners and ready fixes', async () => {
        const empty = await tool('prompt_audit').run!({}, context());
        expect(empty.data).toMatchObject({ available: false });
        (a.env.mock.context as unknown as Dict).extensionPrompts = realCaseSlots();
        await a.generate(realCaseMessages());
        const output = await tool('prompt_audit').run!({ mode: 'last' }, context());
        expect(output.untrusted).toBe(true);
        expect(output.summary).toMatch(/^Prompt check: conflicts \d+, serious \d+\.$/);
        const data = output.data as { conflicts: Dict[]; checked: string; preset: string };
        expect(data).toMatchObject({ checked: 'last turn', preset: 'Marinara' });
        const tight = data.conflicts.find((item) => item.title === 'The reply cannot hold everything')!;
        expect(tight).toMatchObject({
            severity: 'high',
            a: { owner: 'Preset «Marinara», block «Task»', quote: 'Keep it short: one line, no more than 150 words.' },
            b: { owner: 'DES tracker: instructions' },
            fix: { target: 'Preset «Marinara», block «Task»', kind: 'edit', scopes: ['global', 'character', 'chat'] },
        });
        expect(tight.also).toEqual(['NAI Studio picture rules', 'Preset «Marinara», block «World»']);
    });

    it('prompt_audit_fix: a card the user confirms; advice and wrong scopes come back as sentences', async () => {
        (a.env.mock.context as unknown as Dict).extensionPrompts = realCaseSlots();
        await a.generate(realCaseMessages());
        await a.api.check();
        const report = a.api.report()!;
        const tight = report.conflicts.find((item) => item.topic === 'tight')!;
        const plan = await tool('prompt_audit_fix').plan!({ conflict: tight.id, scope: 'character' }, context());
        expect(plan).toMatchObject({
            summary: 'Prompt check: The reply cannot hold everything — Preset «Marinara», block «Task»',
            target: 'Preset «Marinara», block «Task» · This character',
            before: 'Keep it short: one line, no more than 150 words.',
        });
        await plan.apply();
        expect(a.recorded.at(-1)).toMatchObject({ scope: 'character', op: { op: 'edit', identifier: 'task' } });
        await expect(tool('prompt_audit_fix').plan!({ conflict: 'nope' }, context())).rejects.toThrow(
            'There is no such conflict in the last report',
        );
        const role = report.conflicts.find((item) => item.topic === 'role' && item.a.ref === 'slot:maestro_wardrobe')!;
        await expect(tool('prompt_audit_fix').plan!({ conflict: role.id }, context())).rejects.toThrow(
            'This is a Maestro insert.',
        );
        role.fix = { side: 'a', kind: 'toggle', target: 'slot:maestro_wardrobe', enabled: false };
        a.env.settings.registerModule('wardrobe', () => ({ promptLine: true }), true);
        await expect(tool('prompt_audit_fix').plan!({ conflict: role.id, scope: 'chat' }, context())).rejects.toThrow(
            'This fix can be written here only: Everywhere.',
        );
    });
});
