// @vitest-environment happy-dom
// M44 «Агенты» end to end over the harness: phases, results, the run request, the reply gate.
import { describe, expect, it, vi } from 'vitest';
import type { LlmRequest } from '../../../src/shared/contracts';
import { settle } from '../../helpers/core-host';
import { harness, msg, strip, TRACKER, withAgents } from './harness';
import type { Dict } from './harness';

describe('agents module', () => {
    it('starts with the set «Как в 1.27»: no own agents, nothing injected, a one-time hint', async () => {
        const h = await harness();
        expect(h.api.list()).toEqual([]);
        await h.produce();
        expect(h.injections.size).toBe(0);
        const ui = h.app.ui as unknown as { notices: { text: string }[] };
        expect(ui.notices.some((notice) => notice.text.includes('Появились агенты'))).toBe(true);
        await settle(20);
        expect((h.files.get('maestro-agents.json') as Dict).hintShown).toBe(true);
    });

    it("a note after the reply goes under the message; the request uses the agent's task and profiles", async () => {
        const h = await withAgents([
            {
                id: 'u-critic-aaaaa',
                name: 'Критик',
                trigger: { phase: 'post' },
                result: { type: 'note', options: { show: 'strip' } },
            },
        ]);
        expect(h.api.list()).toHaveLength(1);
        h.answers.push(() => ({
            ok: true,
            text: 'Модель забыла про меч.',
            data: 'Модель забыла про меч.',
            costUsd: 0.001,
        }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        const request = h.llm.mock.calls[0]?.[0] as LlmRequest;
        expect(request).toMatchObject({ task: 'agent.u-critic-aaaaa', profileKeys: ['agents'], reasoning: 'off' });
        expect(request.schema).toBeUndefined();
        expect(request.messages[0]?.role).toBe('system');
        expect(request.messages.at(-1)?.content).toContain('Do it.');
        const items = strip(h, 2);
        expect(items).toHaveLength(1);
        expect(items[0]?.text).toBe('Критик: Модель забыла про меч.');
    });

    it('a rewrite keeps the DES tracker, is journaled and undone', async () => {
        const h = await withAgents([
            {
                id: 'u-prose-aaaaa',
                name: 'Прозаик',
                trigger: { phase: 'post' },
                result: { type: 'rewrite', options: { holdReply: true } },
            },
        ]);
        h.chat[2]!.mes = `${TRACKER}Мира улыбается тебе.`;
        h.answers.push((request) => {
            expect(request.messages.map((message) => message.content).join('\n')).not.toContain('infoBox');
            return {
                ok: true,
                data: { editNeeded: true, editedText: 'Мира мягко улыбается тебе.', changes: ['мягче'] },
            };
        });
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        expect(h.chat[2]?.mes).toBe(`${TRACKER}Мира мягко улыбается тебе.`);
        expect((h.chat[2]?.swipes as string[] | undefined)?.[0]).toBe(`${TRACKER}Мира мягко улыбается тебе.`);
        expect(h.saved).toBeGreaterThan(0);
        const record = h.journal.records.find((item) => item.kind === 'agents.rewrite');
        expect(record?.changes[0]).toMatchObject({ target: 'message.text', before: `${TRACKER}Мира улыбается тебе.` });
        expect(strip(h, 2)[0]?.text).toContain('Прозаик');
        expect(await h.journal.undo(record!.id)).toBe(true);
        expect(h.chat[2]?.mes).toBe(`${TRACKER}Мира улыбается тебе.`);
    });

    it('a rewrite that loses half the reply without saying why is refused', async () => {
        const h = await withAgents([
            {
                id: 'u-prose-aaaaa',
                name: 'Прозаик',
                trigger: { phase: 'post' },
                result: { type: 'rewrite', options: { holdReply: false } },
            },
        ]);
        h.chat[2]!.mes = 'Мира улыбается тебе и наливает вина в оба бокала, не спрашивая.';
        h.answers.push(() => ({ ok: true, data: { editNeeded: true, editedText: 'Мира.', changes: [] } }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        expect(h.chat[2]?.mes).toBe('Мира улыбается тебе и наливает вина в оба бокала, не спрашивая.');
    });

    it('«заранее»: prepared after the reply, injected into the next generation, skipped once the reply changed', async () => {
        const h = await withAgents([
            {
                id: 'u-director-aaaaa',
                name: 'Режиссёр',
                trigger: { phase: 'prefetch' },
                result: { type: 'inject', options: { position: 'depth', depth: 1, role: 'system', lifetime: 'turn' } },
            },
        ]);
        h.answers.push(() => ({
            ok: true,
            text: 'Пусть Мира заговорит первой.',
            data: 'Пусть Мира заговорит первой.',
        }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        h.chat.push(msg('Я сажусь рядом.', true));
        await h.produce();
        expect(h.injections.get('agent_u-director-aaaaa')).toEqual({
            text: 'Пусть Мира заговорит первой.',
            position: 1,
            depth: 1,
            role: 0,
            scan: false,
        });
        expect(h.flags.get('maestro_agent_director')).toBe('Пусть Мира заговорит первой.');
        h.chat[2]!.mes = 'Совсем другой ответ.';
        await h.produce();
        expect(h.injections.size).toBe(0);
    });

    it('scheduled records: due by the counter, queued, run in the background, written into the records', async () => {
        const h = await withAgents([
            {
                id: 'u-plot-aaaaa',
                name: 'Сюжет',
                trigger: { phase: 'schedule', everyMessages: 2 },
                result: {
                    type: 'memory',
                    options: {
                        fields: [{ name: 'goal' }],
                        inject: true,
                        injectOptions: { position: 'depth', depth: 3, role: 'system', lifetime: 'untilNext' },
                    },
                },
            },
        ]);
        h.tasks.length = 0;
        await h.app.bus.emit('turn:committed', { messageIndex: 2 });
        expect(h.tasks).toHaveLength(1);
        expect(h.tasks[0]).toMatchObject({
            kind: 'agent.run',
            payload: { agentId: 'u-plot-aaaaa', phase: 'schedule' },
        });
        h.answers.push((request) => {
            expect(request.schema?.name).toBe('agent_memory');
            return { ok: true, data: { fields: { goal: 'Бежать из города' } } };
        });
        await h.runners.get('agent.run')?.(h.tasks[0]!.payload, {} as never);
        await settle(20);
        await h.produce();
        expect(h.injections.get('agent_u-plot-aaaaa')?.text).toBe('goal: Бежать из города');
        // Counted from the last successful run: not due again right away.
        await h.app.bus.emit('turn:committed', { messageIndex: 3 });
        expect(h.tasks).toHaveLength(1);
    });

    it('a check with problems offers «Переделать»; the redo arms a one-shot fix for the next generation', async () => {
        const h = await withAgents([
            {
                id: 'u-voice-aaaaa',
                name: 'Голос',
                trigger: { phase: 'post' },
                result: { type: 'verdict', options: { action: 'offerRedo' } },
            },
        ]);
        const swipe = vi.fn();
        (h.app.host.ctx() as unknown as Dict).swipe = { right: swipe, isAllowed: () => true };
        h.answers.push(() => ({
            ok: true,
            data: { ok: false, problems: [{ quote: 'Сударь', issue: 'не её голос', fix: 'проще' }] },
        }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        const item = strip(h, 2)[0];
        expect(item?.kind).toBe('proposal');
        await item?.actions?.[0]?.run();
        expect(swipe).toHaveBeenCalledTimes(1);
        await h.produce('swipe');
        expect(h.injections.get('agent_fix')?.text).toContain('не её голос');
        await h.produce('swipe');
        expect(h.injections.has('agent_fix')).toBe(false);
    });

    it('a failing agent shows nothing and leaves the reply alone', async () => {
        const h = await withAgents([
            {
                id: 'u-critic-aaaaa',
                name: 'Критик',
                trigger: { phase: 'post' },
                result: { type: 'note', options: { show: 'strip' } },
            },
        ]);
        h.answers.push(() => ({ ok: false, refusal: true, error: 'refusal' }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        expect(strip(h, 2)).toEqual([]);
        expect(h.chat[2]?.mes).toBe('Мира улыбается тебе.');
    });

    it('a manual run with an extra instruction through the API', async () => {
        const h = await withAgents([
            {
                id: 'u-names-aaaaa',
                name: 'Имена',
                trigger: { phase: 'manual' },
                result: { type: 'note', options: { show: 'strip' } },
            },
        ]);
        h.answers.push((request) => {
            expect(request.interactive).toBe(true);
            expect(request.messages.at(-1)?.content).toContain('Additional instruction for this run: только женские');
            return { ok: true, text: 'Ала, Вета.', data: 'Ала, Вета.' };
        });
        const run = await h.api.run('u-names-aaaaa', { extra: 'только женские' });
        expect(run?.ok).toBe(true);
        expect(run?.applied).toEqual(['заметка']);
    });

    it('with M12 on, post agents wait for its verdict hook (not reply:ready)', async () => {
        const hooks: ((index: number, ok: boolean) => Promise<void>)[] = [];
        const h = await withAgents(
            [
                {
                    id: 'u-critic-aaaaa',
                    name: 'Критик',
                    trigger: { phase: 'post' },
                    result: { type: 'note', options: { show: 'strip' } },
                },
            ],
            {
                quality: true,
                qualityApi: {
                    addAfterVerdict: (hook: (index: number, ok: boolean) => Promise<void>) => {
                        hooks.push(hook);
                        return () => undefined;
                    },
                },
            },
        );
        h.answers.push(() => ({ ok: true, text: 'Хорошо.', data: 'Хорошо.' }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(20);
        expect(hooks).toHaveLength(1);
        expect(h.llm).not.toHaveBeenCalled();
        await hooks[0]!(2, true);
        await settle(20);
        expect(h.llm).toHaveBeenCalledTimes(1);
        // The same reply text is not worked on twice (the fallback timer after reply:ready was cleared).
        await hooks[0]!(2, true);
        await settle(20);
        expect(h.llm).toHaveBeenCalledTimes(1);
    });
});

describe('batches and the cheap-model question (release 1.30)', () => {
    const note = (id: string, name: string, batch = true) => ({
        id,
        name,
        batch,
        trigger: { phase: 'post' as const },
        result: { type: 'note' as const, options: { show: 'strip' as const } },
    });

    it('two batchable agents of one moment go in one request; each gets its part and a share of the cost', async () => {
        const h = await withAgents([note('u-one-aaaaa', 'Первый'), note('u-two-bbbbb', 'Второй')]);
        h.answers.push((request) => {
            expect(request.task).toBe('agent.batch');
            expect(request.schema?.name).toBe('agent_batch');
            return { ok: true, data: { a1: 'Первая заметка.', a2: 'Вторая заметка.' }, costUsd: 0.004 };
        });
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(80);
        expect(h.llm).toHaveBeenCalledTimes(1);
        expect(strip(h, 2).map((item) => item.text)).toEqual(['Первый: Первая заметка.', 'Второй: Вторая заметка.']);
    });

    it('agents with different temperatures still share a batch, at the average temperature', async () => {
        const h = await withAgents([
            { ...note('u-one-aaaaa', 'Первый'), model: { temperature: 0.5 } },
            { ...note('u-two-bbbbb', 'Второй'), model: { temperature: 0.9 } },
        ]);
        h.answers.push((request) => {
            expect(request.task).toBe('agent.batch');
            expect(request.temperature).toBe(0.7);
            return { ok: true, data: { a1: 'Раз.', a2: 'Два.' } };
        });
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(80);
        expect(h.llm).toHaveBeenCalledTimes(1);
    });

    it('an agent the batch answer left out is asked again on its own', async () => {
        const h = await withAgents([note('u-one-aaaaa', 'Первый'), note('u-two-bbbbb', 'Второй')]);
        h.answers.push(() => ({ ok: true, data: { a1: 'Первая заметка.' } }));
        h.answers.push((request) => {
            expect(request.task).toBe('agent.u-two-bbbbb');
            return { ok: true, text: 'Вторая отдельно.', data: 'Вторая отдельно.' };
        });
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(100);
        expect(h.llm).toHaveBeenCalledTimes(2);
        expect(strip(h, 2).map((item) => item.text)).toContain('Второй: Вторая отдельно.');
    });

    it('agents without «batch» go one by one', async () => {
        const h = await withAgents([note('u-one-aaaaa', 'Первый', false), note('u-two-bbbbb', 'Второй', false)]);
        h.answers.push(
            () => ({ ok: true, text: 'A', data: 'A' }),
            () => ({ ok: true, text: 'B', data: 'B' }),
        );
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(80);
        expect(h.llm.mock.calls.map((call) => (call[0] as LlmRequest).task).sort()).toEqual([
            'agent.u-one-aaaaa',
            'agent.u-two-bbbbb',
        ]);
    });

    it('a clear «no» of the cheap model skips the agent; a failed question lets it run', async () => {
        const h = await withAgents([{ ...note('u-one-aaaaa', 'Первый', false), gate: {} }]);
        h.answers.push((request) => {
            expect(request.task).toBe('agents.gate');
            expect(request.profileKeys).toEqual(['agents.gate', 'agents']);
            return { ok: true, data: { run: false } };
        });
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        expect(h.llm).toHaveBeenCalledTimes(1);
        expect(strip(h, 2)).toEqual([]);

        h.chat[2]!.mes = 'Другой ответ.';
        h.answers.push(() => ({ ok: false, error: 'transport: down' }));
        h.answers.push(() => ({ ok: true, text: 'Заметка.', data: 'Заметка.' }));
        await h.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        await settle(60);
        expect(h.llm).toHaveBeenCalledTimes(3);
        expect(strip(h, 2)[0]?.text).toBe('Первый: Заметка.');
    });
});
