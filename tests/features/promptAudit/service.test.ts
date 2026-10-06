// M38 «Проверка промпта», the report and the fixes over the ST mock: the rules over the last turn (the real case of the
// user's setup), «Пропустить» and «Не считать конфликтом» (remembered), the AI check through the mock schema with its
// job, every fix route (the preset layer in each scope, a neighbour's text everywhere or as a copy, a Maestro setting
// with undo, advice for the card, BunnyMo and risky roles), several fixes as one undo, and the check again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAiRequest } from '../../../src/domain/prompt-audit-ai';
import type { AuditConflict } from '../../../src/features/promptAudit/api';
import { AI_JOB } from '../../../src/features/promptAudit';
import { createAuditEnv, realCaseMessages, realCaseSlots } from '../../helpers/prompt-audit-env';
import type { AuditEnv } from '../../helpers/prompt-audit-env';
import { MARKERS_TEXT, TASK_TEXT, TRACKER_TEXT, WORLD_TEXT } from '../../helpers/prompt-audit-fixtures';
import { analyseRequest, buildReply } from '../../../tools/mock-llm/scenarios.mjs';

type Dict = Record<string, unknown>;

let a: AuditEnv;
let ctx: Dict;

async function realTurn(): Promise<void> {
    ctx.extensionPrompts = realCaseSlots();
    await a.generate(realCaseMessages());
}

function conflict(topic: AuditConflict['topic']): AuditConflict {
    const found = a.api.report()?.conflicts.find((item) => item.topic === topic);
    if (!found) throw new Error(`no ${topic} conflict`);
    return found;
}

beforeEach(async () => {
    a = await createAuditEnv();
    ctx = a.env.mock.context as unknown as Dict;
});

afterEach(async () => {
    await a.stop();
});

describe('the rules report', () => {
    it('is empty before the first turn', async () => {
        expect(await a.api.check()).toBeNull();
        expect(a.api.aiEstimate()).toBeNull();
    });

    it('finds the real case and words it: owners, why, the fix with its side, the risk on the model', async () => {
        await realTurn();
        const report = (await a.api.check())!;
        expect(report.source).toBe('turn');
        const tight = conflict('tight');
        expect(tight).toMatchObject({
            source: 'rules',
            severity: 'high',
            title: 'The reply cannot hold everything',
            a: { ref: 'preset:task' },
            b: { ref: 'slot:dooms-tracker-inject' },
        });
        expect(tight.why).toBe(
            'The reply is limited (≤1 line), while other instructions want more in every reply: the tracker JSON, picture markers and a world event every turn. It cannot all fit — the model will drop something required, most often the tracker JSON or the pictures.',
        );
        const plan = a.api.plan(tight.id)!;
        expect(plan).toMatchObject({
            route: 'preset',
            side: 'a',
            kind: 'edit',
            target: 'Preset «Marinara», block «Task»',
            before: 'Keep it short: one line, no more than 150 words.',
            scopes: ['global', 'character', 'chat'],
        });
        expect(plan.reason).toContain('required blocks do not count');
        const role = report.conflicts.find((item) => item.topic === 'role' && item.a.ref === 'slot:maestro_wardrobe')!;
        expect(role.risk).toContain('On deepseek/deepseek-v4-flash system messages');
        expect(a.api.plan(role.id)?.advice).toBe(
            'This is a Maestro insert. It is set up in the settings of «wardrobe».',
        );
    });

    it('skips for this report and remembers «not a conflict» for later ones', async () => {
        await realTurn();
        await a.api.check();
        const tight = conflict('tight');
        const role = a.api.report()!.conflicts.find((item) => item.topic === 'role')!;
        a.api.skip(role.id);
        expect(a.api.report()!.conflicts.find((item) => item.id === role.id)?.status).toBe('skipped');
        a.api.ignore(tight.id);
        expect(a.api.report()!.conflicts.some((item) => item.id === tight.id)).toBe(false);
        expect(a.api.report()!.hidden).toBe(1);
        const again = (await a.api.check())!;
        expect(again.conflicts.some((item) => item.topic === 'tight')).toBe(false);
        expect(again.hidden).toBe(1);
        expect(again.conflicts.find((item) => item.id === role.id)?.status).toBe('skipped');
        a.api.restoreIgnored();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(a.api.report()!.conflicts.some((item) => item.topic === 'tight')).toBe(true);
    });

    it('adds the blocks the Preset Studio says never go out (only for blocks of this turn)', async () => {
        a.env.apis.set('presetAnalysis', {
            findings: async () => [
                { kind: 'neverIncluded', severity: 'warn', identifier: 'world', text: 'Block «World» is never sent.' },
                { kind: 'neverIncluded', severity: 'warn', identifier: 'ghost', text: 'Not in this turn.' },
                { kind: 'heavyBlock', severity: 'info', identifier: 'task', text: 'Heavy.' },
            ],
            map: async () => [],
            hints: () => [],
        });
        await realTurn();
        const unused = (await a.api.check())!.conflicts.filter((item) => item.topic === 'unused');
        expect(unused).toHaveLength(1);
        expect(unused[0]).toMatchObject({
            severity: 'low',
            title: 'A block that does not go out',
            a: { ref: 'preset:world' },
            why: 'Block «World» is never sent.',
        });
        expect(a.api.plan(unused[0]!.id)).toBeNull();
    });

    it('keeps the report across a reload', async () => {
        await realTurn();
        const report = await a.api.check();
        await a.restart();
        expect(a.api.report()).toEqual(report);
    });
});

describe('the AI check', () => {
    it('shows an estimate, runs as a user job through the strict schema and adds its conflicts', async () => {
        await realTurn();
        await a.api.check();
        const estimate = a.api.aiEstimate()!;
        expect(estimate.inputTokens).toBeGreaterThan(100);
        a.env.llm.request.mockImplementation(async (request) => {
            expect(request.task).toBe('promptAudit.ai');
            expect(request.schema?.name).toBe('maestro_prompt_audit');
            const body = {
                messages: request.messages,
                response_format: { type: 'json_schema', json_schema: request.schema },
            };
            const reply = buildReply(analyseRequest(body)) as { content: string };
            return { ok: true, data: JSON.parse(reply.content), costUsd: 0.002 };
        });
        const report = (await a.api.runAi())!;
        const ai = report.conflicts.filter((item) => item.source === 'ai');
        expect(ai).toHaveLength(1);
        expect(ai[0]).toMatchObject({
            topic: 'ai',
            a: { ref: 'preset:task' },
            b: { ref: 'preset:world' },
            why: 'Эти две инструкции спорят друг с другом (ответ заглушки).',
        });
        expect(report.ai).toMatchObject({ count: 1, costUsd: 0.002 });
        expect(report.conflicts.some((item) => item.source === 'rules')).toBe(true);
        // A check again of the same turn keeps the AI's findings.
        expect((await a.api.check())!.conflicts.filter((item) => item.source === 'ai')).toHaveLength(1);
        const plan = a.api.plan(ai[0]!.id)!;
        expect(plan).toMatchObject({
            route: 'preset',
            kind: 'edit',
            before: 'Write the next reply of the story as {{char}}.',
        });
    });

    it('sends the map, not the lore data or the chat history', async () => {
        a.loreContents.push({ world: 'World', uid: 2, comment: 'Tavern', content: 'A small tavern by the road.' });
        await realTurn();
        const request = buildAiRequest(a.api.capture()!, 'en');
        expect(request.user).not.toContain('A small tavern');
        expect(request.user).not.toContain('I follow her.');
        expect(request.user).toContain(TRACKER_TEXT);
    });

    it('reports a failed or unreadable answer without losing the rules', async () => {
        await realTurn();
        await a.api.check();
        a.env.llm.request.mockResolvedValue({ ok: true, data: { nonsense: true } });
        const report = (await a.api.runAi())!;
        expect(report.ai?.error).toBe('the model’s answer could not be read');
        expect(report.conflicts.some((item) => item.topic === 'tight')).toBe(true);
        a.env.llm.available.mockReturnValue(false);
        await a.api.runAi();
        expect(a.env.ui.notices.at(-1)?.text).toContain('No connection profile');
        a.env.llm.available.mockReturnValue(true);
        a.env.app.cost.backgroundCapReached = () => true;
        const calls = a.env.llm.request.mock.calls.length;
        await a.api.runAi();
        expect(a.env.ui.notices.at(-1)?.text).toContain('limit of background spending is reached');
        expect(a.env.llm.request.mock.calls.length).toBe(calls);
    });

    it('can be stopped from its job', async () => {
        await realTurn();
        await a.api.check();
        a.env.llm.request.mockImplementation(
            (request) =>
                new Promise((resolve) => {
                    request.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'aborted' }));
                }),
        );
        const running = a.api.runAi();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(a.api.busy()).toBe('ai');
        expect(a.env.app.jobs!.get(AI_JOB)?.state).toBe('active');
        a.env.app.jobs!.cancel(AI_JOB);
        await running;
        expect(a.api.busy()).toBeNull();
        expect(a.env.app.jobs!.get(AI_JOB)?.state).toBe('cancelled');
    });
});

describe('fixes', () => {
    beforeEach(async () => {
        await realTurn();
        await a.api.check();
    });

    it('a preset block: the layer of the chosen scope, then the working copy; the check again sees it fixed', async () => {
        const tight = conflict('tight');
        const outcome = await a.api.fix(tight.id, 'chat');
        expect(outcome).toMatchObject({ ok: true, message: 'Fixed for this chat: Preset «Marinara», block «Task».' });
        expect(a.recorded).toHaveLength(1);
        expect(a.recorded[0]).toMatchObject({
            base: 'Marinara',
            scope: 'chat',
            op: { op: 'edit', identifier: 'task' },
        });
        const op = a.recorded[0]!.op as { patch: { content: string }; baseText: string; baseHash: string };
        expect(op.baseText).toBe(TASK_TEXT);
        expect(op.patch.content).toContain('do not count toward it).');
        expect(a.store.updates.at(-1)).toMatchObject({ identifier: 'task' });
        expect(a.api.report()!.conflicts.find((item) => item.id === tight.id)?.status).toBe('fixed');
        expect((await a.api.fix(tight.id)).ok).toBe(false);
        const again = (await a.api.check())!;
        expect(again.conflicts.some((item) => item.topic === 'tight')).toBe(false);
    });

    it('a preset toggle and a role change', async () => {
        const capture = a.api.capture()!;
        capture.connection = { source: 'openrouter', model: 'deepseek/deepseek-v4-flash', quirks: ['prefillEos'] };
        capture.messages.push({ role: 'assistant', chars: 10, refs: ['preset:world'] });
        const report = (await a.api.check())!;
        const prefill = report.conflicts.find((item) => item.topic === 'prefill')!;
        expect(a.api.plan(prefill.id)).toMatchObject({ route: 'preset', kind: 'toggle', before: 'on', after: 'off' });
        expect((await a.api.fix(prefill.id)).ok).toBe(true);
        expect(a.recorded.at(-1)).toMatchObject({
            op: { op: 'toggle', identifier: 'world', enabled: false },
            scope: 'global',
        });
        expect(a.store.enabled.at(-1)).toEqual({ identifiers: ['world'], enabled: false });
    });

    it('a neighbour’s text: everywhere through its own setting, or a copy for the chat', async () => {
        const capture = a.api.capture()!;
        capture.items.push({
            ref: 'preset:nohtml',
            owner: 'preset',
            label: 'No pictures',
            key: 'nohtml',
            role: 'system',
            place: 'prompt',
            message: 0,
            text: 'Do not include images.',
            chars: 22,
        });
        const report = (await a.api.check())!;
        const images = report.conflicts.find((item) => item.topic === 'format' || item.topic === 'images')!;
        // The safest side is the preset: steer the fix to the neighbour to test its route.
        images.fix = {
            side: 'b',
            kind: 'edit',
            target: 'slot:nai_studio_markers',
            before: 'Place 1 to 3 picture markers in every reply',
            after: 'Place 1 picture marker when a scene changes',
        };
        const plan = a.api.plan(images.id)!;
        expect(plan).toMatchObject({ route: 'neighbour', scopes: ['global', 'character', 'chat'] });
        expect((await a.api.fix(images.id, 'global')).ok).toBe(true);
        expect(a.setGlobal).toHaveBeenCalledWith(
            'nai.markers',
            MARKERS_TEXT.replace(
                'Place 1 to 3 picture markers in every reply',
                'Place 1 picture marker when a scene changes',
            ),
        );
        images.status = undefined;
        images.fix = { ...images.fix, before: 'captions in English', after: 'captions in Russian' };
        expect((await a.api.fix(images.id, 'chat')).ok).toBe(true);
        expect(a.setScoped).toHaveBeenLastCalledWith(
            'nai.markers',
            'chat',
            expect.stringContaining('captions in Russian'),
        );
    });

    it('a Maestro line: its setting, journaled; one undo of several fixes brings them all back', async () => {
        const settings = a.env.settings;
        settings.registerModule('wardrobe', () => ({ promptLine: true, promptDepth: 1 }), true);
        settings.registerModule('messageStyle', () => ({ hint: true }), true);
        const capture = a.api.capture()!;
        capture.items.push({
            ref: 'slot:maestro_messageStyle.hint',
            owner: 'maestro',
            module: 'messageStyle',
            label: 'maestro_messageStyle.hint',
            role: 'system',
            place: 'chat',
            depth: 1,
            message: -1,
            text: 'Plain text only.',
            chars: 16,
        });
        await a.api.check();
        const report = a.api.report()!;
        const wardrobe = report.conflicts.find((item) => item.a.ref === 'slot:maestro_wardrobe')!;
        wardrobe.fix = { side: 'a', kind: 'toggle', target: 'slot:maestro_wardrobe', enabled: false };
        const style = report.conflicts.find((item) => item.topic === 'format')!;
        style.fix = { side: 'b', kind: 'toggle', target: 'slot:maestro_messageStyle.hint', enabled: false };
        expect(a.api.plan(wardrobe.id)).toMatchObject({ route: 'maestro', scopes: ['global'] });
        expect((await a.api.fix(wardrobe.id, 'chat')).message).toBe(
            '«Maestro: wardrobe» can only be changed everywhere.',
        );
        const outcomes = await a.api.fixMany([wardrobe.id, style.id], 'global');
        expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
        expect(settings.module<Dict>('wardrobe').promptLine).toBe(false);
        expect(settings.module<Dict>('messageStyle').hint).toBe(false);
        const records = a.env.journal.list();
        expect(records.map((record) => record.kind)).toEqual([
            'promptAudit.batch',
            'promptAudit.setting',
            'promptAudit.setting',
        ]);
        expect(a.env.ui.notices.at(-1)?.text).toBe('Fixed: 2. One undo in the journal brings them all back.');
        expect(await a.env.journal.undo(records[0]!.id)).toBe(true);
        expect(settings.module<Dict>('wardrobe').promptLine).toBe(true);
        expect(settings.module<Dict>('messageStyle').hint).toBe(true);
    });

    it('advice only for the card, BunnyMo and a risky role; never a button', async () => {
        const capture = a.api.capture()!;
        capture.items.push(
            {
                ref: 'card:system',
                owner: 'card',
                key: 'system',
                label: 'system',
                role: 'system',
                place: 'prompt',
                message: 0,
                text: 'Reply in English.',
                chars: 17,
            },
            {
                ref: 'lore:BunnyMo#1',
                owner: 'bunnymo',
                book: 'BunnyMo',
                label: 'Core',
                role: 'system',
                place: 'prompt',
                message: 0,
                text: 'Отвечай на русском языке.',
                chars: 25,
            },
        );
        const report = (await a.api.check())!;
        const language = report.conflicts.find((item) => item.topic === 'language')!;
        language.fix = {
            side: 'a',
            kind: 'edit',
            target: 'card:system',
            before: 'Reply in English.',
            after: 'Reply in Russian.',
        };
        const plan = a.api.plan(language.id)!;
        expect(plan.scopes).toEqual([]);
        expect(plan.advice).toBe(
            'This is a field of the character card. Change it in the card: replace «Reply in English.» with «Reply in Russian.».',
        );
        const outcome = await a.api.fix(language.id);
        expect(outcome.ok).toBe(false);
        language.fix = {
            side: 'b',
            kind: 'remove',
            target: 'lore:BunnyMo#1',
            before: 'Отвечай на русском языке.',
            after: '',
        };
        expect(a.api.plan(language.id)?.advice).toContain('Maestro never changes BunnyMo');
        const tracker = report.conflicts.find((item) => item.topic === 'tight')!;
        tracker.fix = { side: 'b', kind: 'role', target: 'slot:dooms-tracker-inject', role: 'system' };
        const risky = a.api.plan(tracker.id)!;
        expect(risky.advice).toContain('Better not change the role like this on your model');
        expect(risky.warning).toContain('tracker JSON');
    });
});

describe('the text of the real case', () => {
    it('keeps the world block text resolved for the check', async () => {
        await realTurn();
        expect(a.api.capture()!.items.find((item) => item.ref === 'preset:world')?.text).toBe(WORLD_TEXT);
        expect(TASK_TEXT).toContain('150 words');
    });
});
