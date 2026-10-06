import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CHANGE_KIND,
    DES_STATS_KIND,
    DES_STATS_UNDO_TARGET,
    EXTRA_KEY,
    EXTRACT_TASK,
    readBlockRecord,
} from '../../../src/features/mechanics/tracking';
import { createMechanicsEnv, healthDef, magicDef, reply, reputationDef, userMessage } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

let env: MechanicsEnv;

beforeEach(async () => {
    vi.useFakeTimers();
    env = createMechanicsEnv();
    env.defs.defs = [magicDef()];
    await env.start();
});

afterEach(() => {
    env.stop();
    vi.useRealTimers();
});

const STORY = 'Кай поднял руку, и пламя вспыхнуло.';

describe('the service block', () => {
    it('is parsed on arrival, kept in extra, stripped from the text and applied on commit', async () => {
        const index = await env.receive(`${STORY}\n\n<mechanics>\nКай.Mana: -10\nKai.Schools += fire\n</mechanics>`, [
            { name: 'Kai' },
        ]);
        const message = env.mock.chat[index]!;
        expect(message.mes).toBe(STORY);
        expect((message.swipes as string[])[0]).toBe(STORY);
        expect(env.rerendered).toEqual([index]);
        const record = readBlockRecord(message);
        expect(record?.items.map((item) => item.line)).toEqual(['Кай.Mana: -10', 'Kai.Schools += fire']);
        expect(
            ((message.swipe_info as { extra: Record<string, unknown> }[])[0]!.extra[EXTRA_KEY] as { swipeId: number })
                .swipeId,
        ).toBe(0);
        // Nothing is applied before the commit (P14).
        expect(env.state.history()).toEqual([]);
        await env.commit(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        expect(env.state.value('magic', 'Kai', 'schools')).toEqual(['fire']);
        expect(env.state.history().map((change) => change.source)).toEqual(['block', 'block']);
        // A second commit of the same reply (the user message was deleted and sent again) changes nothing.
        await env.commit(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
    });

    it('repairs a broken block and notes an unreadable one', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\n- Кай . mana: −5 (spell)`);
        expect(env.mock.chat[index]!.mes).toBe(STORY);
        await env.commit(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(45);
        expect(env.state.history()[0]?.reason).toBe('spell');
        const broken = await env.receive(`${STORY}\n<mechanics>\nthe mana fades\n</mechanics>`);
        expect(env.mock.chat[broken]!.mes).toBe(STORY);
        expect(env.ui.notices.map((notice) => notice.text)).toEqual([
            `I could not read the mechanics changes in reply #${broken}, so I removed that service block from the reply.`,
        ]);
        const partial = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -1\nnonsense here\n</mechanics>`);
        expect(env.ui.notices[1]?.text).toBe(
            `Some mechanics changes in reply #${partial} could not be read, so I skipped them (lines: 1).`,
        );
        expect(readBlockRecord(env.mock.chat[partial])?.dropped).toBe(1);
    });

    it('ignores foreign messages, keeps swipes apart and merges a continuation', async () => {
        await env.receive(`${STORY}\n<mechanics>\nKai.mana: -1\n</mechanics>`, undefined, 'extension');
        expect(env.mock.chat[0]!.mes).toContain('<mechanics>');
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -1\n</mechanics>`);
        const message = env.mock.chat[index]!;
        // A new swipe inherits the old extra (ST copies it): the record of swipe 0 does not count for swipe 1.
        const second = 'Second take.\n<mechanics>\nKai.mana: -20\n</mechanics>';
        message.swipes = [STORY, second];
        message.swipe_id = 1;
        message.mes = second;
        expect(readBlockRecord(message)).toBeNull();
        await env.mock.eventSource.emit('message_received', index, 'swipe');
        expect(message.mes).toBe('Second take.');
        message.mes += '\n<mechanics>\nKai.schools += water\n</mechanics>';
        await env.mock.eventSource.emit('message_received', index, 'continue');
        expect(readBlockRecord(message)?.items.map((item) => item.value)).toEqual([-20, 'water']);
        await env.commit(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(30);
        expect(env.state.value('magic', 'Kai', 'schools')).toEqual(['water']);
    });

    it('takes a block the user writes in an edit, and leftovers at reply:ready or the commit', async () => {
        const index = await env.receive(STORY);
        env.mock.chat[index]!.mes = `${STORY}\n<mechanics>\nKai.mana = 5\n</mechanics>`;
        await env.mock.eventSource.emit('message_edited', index);
        expect(env.mock.chat[index]!.mes).toBe(STORY);
        env.mock.chat.push(reply(`${STORY}\n<mechanics>\nKai.mana: -1\n</mechanics>`));
        await env.app.bus.emit('reply:ready', { messageIndex: 1, type: 'normal' });
        expect(env.mock.chat[1]!.mes).toBe(STORY);
        env.mock.chat.push(userMessage(), reply(`${STORY}\n<mechanics>\nKai.mana: -2\n</mechanics>`));
        await env.commit(3);
        expect(env.mock.chat[3]!.mes).toBe(STORY);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(48);
    });

    it('applies only block attributes of mechanics in the scene', async () => {
        env.defs.defs = [magicDef(), healthDef()];
        const index = await env.receive(
            `${STORY}\n<mechanics>\nKai.Health: -10\nKai.Luck: +1\nKai.mana: -1\n</mechanics>`,
        );
        await env.commit(index);
        expect(env.state.history().map((change) => change.attribute)).toEqual(['mana']);
    });

    it('strips leftovers from assistant messages of the outgoing prompt', async () => {
        const data = {
            dryRun: false,
            chat: [
                { role: 'system', content: '<mechanics>\nKai.Mana: -2\n</mechanics>' },
                { role: 'assistant', content: `${STORY}\n<mechanics>\nKai.Mana: -2\n</mechanics>` },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: `${STORY}\n<mechanics>\nKai.mana: 1\n</mechanics>` },
                        { type: 'image' },
                    ],
                },
                { role: 'assistant', content: STORY },
                'junk',
            ],
        };
        await env.mock.eventSource.emit('chat_completion_prompt_ready', data);
        expect(data.chat[0]).toEqual({ role: 'system', content: '<mechanics>\nKai.Mana: -2\n</mechanics>' });
        expect((data.chat[1] as { content: string }).content).toBe(STORY);
        expect((data.chat[2] as { content: { text?: string }[] }).content[0]?.text).toBe(STORY);
        await env.mock.eventSource.emit('chat_completion_prompt_ready', null);
    });

    it('hides a streaming block through the message formatter while running', async () => {
        env.stop();
        const hooks: ((mes: string, info: unknown) => string)[] = [];
        (env.mock.context as unknown as { messageFormatter: unknown }).messageFormatter = {
            addHook: (hook: (mes: string, info: unknown) => string) => hooks.push(hook),
        };
        await env.start();
        expect(hooks).toHaveLength(1);
        const hook = hooks[0]!;
        expect(hook(`${STORY}\n<mechanics>\nKai.ma`, { isUser: false })).toBe(STORY);
        expect(hook(`${STORY}\n<mech`, {})).toBe(STORY);
        expect(hook(`${STORY}\n<mechanics>`, { isUser: true })).toBe(`${STORY}\n<mechanics>`);
        env.stop();
        expect(hook(`${STORY}\n<mechanics>\nKai.ma`, {})).toBe(`${STORY}\n<mechanics>\nKai.ma`);
        await env.start();
        expect(hooks).toHaveLength(1);
        expect(hook(`${STORY}\n<mechanics>`, {})).toBe(STORY);
    });

    it('delegates the instruction to the domain', () => {
        expect(env.tracking.blockInstruction([magicDef()], { magic: ['Kai'] })).toContain('Kai.Mana: -2');
        expect(env.tracking.blockInstruction([magicDef()], {})).toBe('');
    });

    it('derives an edited latest reply again after the state took it back', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`);
        await env.commit(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        env.mock.chat[index]!.mes = `${STORY}\n<mechanics>\nKai.mana: -3\n</mechanics>`;
        await env.mock.eventSource.emit('message_edited', index);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await env.tick(600);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(47);
        expect(env.state.history().map((change) => change.to)).toEqual([47]);
    });

    it('drops pending work on a swipe, a deletion or a chat change', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`);
        env.mock.chat.push(userMessage());
        await env.app.bus.emit('turn:committed', { messageIndex: index });
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await env.tick(600);
        expect(env.state.history()).toEqual([]);
        await env.app.bus.emit('turn:committed', { messageIndex: index });
        await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await env.tick(600);
        expect(env.state.history()).toEqual([]);
        env.leader.value = false;
        await env.commit(index);
        expect(env.state.history()).toEqual([]);
    });
});

describe('DES stats', () => {
    beforeEach(() => {
        env.defs.defs = [healthDef()];
    });

    it('reports which attributes DES tracks and adds them with consent, keeping the user stats', async () => {
        expect(env.tracking.desStatsStatus(healthDef())).toEqual([{ attribute: 'hp', inDes: false }]);
        expect(await env.tracking.enableDesStats(healthDef())).toBe(true);
        const proposal = env.autonomy.proposals[0]!;
        expect(proposal).toMatchObject({
            kind: DES_STATS_KIND,
            title: 'Add the stats of «Здоровье» to the DES tracker?',
        });
        expect(proposal.description).toContain('Health');
        expect(env.autonomy.never.has(DES_STATS_KIND)).toBe(true);
        expect(env.des.stats()).toEqual({
            enabled: true,
            customStats: [
                { id: 'health', name: 'Health', enabled: true },
                { id: 'arousal', name: 'Arousal', enabled: true },
            ],
        });
        expect(env.tracking.desStatsStatus(healthDef())).toEqual([{ attribute: 'hp', inDes: true }]);
        // Already there: nothing to ask.
        expect(await env.tracking.enableDesStats(healthDef())).toBe(true);
        expect(env.autonomy.proposals).toHaveLength(1);
        // Undo takes back only what it switched on.
        const record = env.journal.records.find((item) => item.kind === DES_STATS_KIND)!;
        expect(record.changes[0]?.target).toBe(DES_STATS_UNDO_TARGET);
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.des.stats()).toEqual({
            enabled: false,
            customStats: [
                { id: 'health', name: 'Health', enabled: false },
                { id: 'arousal', name: 'Arousal', enabled: true },
            ],
        });
    });

    it('adds a new stat, undo removes it and keeps stats added later', async () => {
        const def = healthDef();
        def.attributes[0]!.promptName = 'Vitality';
        expect(await env.tracking.enableDesStats(def)).toBe(true);
        expect(env.des.stats().customStats.map((stat) => stat.name)).toEqual(['Health', 'Arousal', 'Vitality']);
        env.des.stats().customStats.push({ id: 'mine', name: 'Mine', enabled: true });
        const record = env.journal.records.find((item) => item.kind === DES_STATS_KIND)!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.des.stats().customStats.map((stat) => stat.name)).toEqual(['Health', 'Arousal', 'Mine']);
    });

    it('refuses without DES, with the Workshop open, or when the user says no', async () => {
        env.autonomy.askAnswer = false;
        expect(await env.tracking.enableDesStats(healthDef())).toBe(false);
        env.autonomy.askAnswer = true;
        env.des.workshop = true;
        expect(await env.tracking.enableDesStats(healthDef())).toBe(false);
        expect(env.ui.notices[0]?.text).toBe('The DES Workshop is open: close it and try again.');
        env.des.workshop = false;
        expect(await env.tracking.enableDesStats(magicDef())).toBe(false);
        env.des.available = false;
        expect(await env.tracking.enableDesStats(healthDef())).toBe(false);
        expect(env.tracking.desStatsStatus(healthDef())).toEqual([{ attribute: 'hp', inDes: false }]);
        expect(
            await env.journal.handlers.get(DES_STATS_UNDO_TARGET)!({
                target: DES_STATS_UNDO_TARGET,
                ref: {},
                before: {},
                after: {},
            }),
        ).toBe(false);
    });

    it('applies a queued card from the Inbox', async () => {
        env.autonomy.levels.set(DES_STATS_KIND, 'inbox');
        expect(await env.tracking.enableDesStats(healthDef())).toBe(false);
        const applier = env.inbox.appliers.get(DES_STATS_KIND)!;
        await applier(env.autonomy.proposals[0]!.payload);
        expect(env.des.stats().enabled).toBe(true);
        await expect(applier({ junk: true })).rejects.toThrow('bad mechanics DES stats card');
        env.des.workshop = true;
        await expect(applier(env.autonomy.proposals[0]!.payload)).rejects.toThrow('Workshop');
        env.des.available = false;
        await expect(applier(env.autonomy.proposals[0]!.payload)).rejects.toThrow('DES is not available');
    });

    it('reads the committed tracker stats of the attributes DES tracks', async () => {
        env.des.stats().enabled = true;
        env.des.stats().customStats[0]!.enabled = true;
        const index = await env.receive(STORY, [
            { name: 'Кай', stats: { Health: 70, Arousal: 5 } },
            { name: 'Mira', stats: { health: '55' } },
            { name: 'Lena', stats: { Health: 'bad' } },
        ]);
        await env.commit(index);
        expect(env.state.value('health', 'Kai', 'hp')).toBe(70);
        expect(env.state.value('health', 'Mira', 'hp')).toBe(55);
        expect(env.state.history().every((change) => change.source === 'desStats')).toBe(true);
        expect(env.state.history()).toHaveLength(2);
        // Stamina is a background attribute: one task for the reply.
        expect(env.tasks.queued).toEqual([
            expect.objectContaining({ kind: EXTRACT_TASK, payload: { messageIndex: index, swipeId: 0 } }),
        ]);
    });

    it('parses a DES-stat attribute DES does not track in the background', async () => {
        const index = await env.receive(STORY, [{ name: 'Kai', stats: { Health: 70 } }]);
        await env.commit(index);
        expect(env.state.history()).toEqual([]);
        expect(env.tasks.queued).toHaveLength(1);
    });
});

describe('the background parse', () => {
    beforeEach(() => {
        env.defs.defs = [reputationDef(), magicDef()];
    });

    async function committed(): Promise<number> {
        const index = await env.receive('Гильдия довольна: Кай вернул долг.', [{ name: 'Kai' }]);
        await env.commit(index);
        return index;
    }

    it('enqueues one task and applies the validated answer through autonomy', async () => {
        const index = await committed();
        expect(env.tasks.queued).toHaveLength(1);
        env.llm.responses.push({
            ok: true,
            data: {
                changes: [
                    { holder: 'guild', attribute: 'Standing', value: 'liked', delta: null, reason: 'Гильдия довольна' },
                    { holder: 'Elves', attribute: 'Standing', value: 'liked', delta: null, reason: '' },
                ],
            },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        const request = env.llm.requests[0]!;
        expect(request.schema?.name).toBe('maestro_mechanics_extract');
        expect(request.task).toBe(EXTRACT_TASK);
        expect(request.messages[1]?.content).toContain('Guild: Standing neutral');
        expect(request.messages[1]?.content).toContain('Гильдия довольна');
        const proposal = env.autonomy.proposals.find((item) => item.kind === CHANGE_KIND)!;
        expect(proposal.title).toBe(`Mechanics changes in reply #${index}: 1`);
        expect(proposal.appliedNotice?.text).toBe(`Updated the mechanics from reply #${index}.`);
        expect(proposal.description).toBe('Guild · Отношение: neutral → liked («Гильдия довольна»)');
        expect(env.state.value('rep', 'Guild', 'standing')).toBe('liked');
        expect(env.state.history()[0]).toMatchObject({ source: 'background', messageIndex: index });
        // Journaled by autonomy with the value target: undo works.
        const record = env.journal.records.find((item) => item.kind === CHANGE_KIND)!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.state.value('rep', 'Guild', 'standing')).toBe('neutral');
        // Processed once.
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.llm.requests).toHaveLength(2);
    });

    it('drops malformed answers and failed requests', async () => {
        await committed();
        env.llm.responses.push({ ok: true, text: '{"changes": [' });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.state.history()).toEqual([]);
        expect(env.logLines.some((line) => line.args.join(' ').includes('not the expected JSON'))).toBe(true);
        env.llm.responses.push({ ok: false, error: 'cap' });
        await env.tasks.runLatest(EXTRACT_TASK);
        env.llm.responses.push({ ok: true, data: { changes: [] } });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.state.history()).toEqual([]);
        expect(env.autonomy.proposals).toEqual([]);
    });

    it('queues an Inbox card whose applier still works', async () => {
        env.autonomy.levels.set(CHANGE_KIND, 'inbox');
        const index = await committed();
        env.llm.responses.push({
            ok: true,
            data: { changes: [{ holder: 'Crown', attribute: 'standing', value: '', delta: -1, reason: '' }] },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.state.history()).toEqual([]);
        const applier = env.inbox.appliers.get(CHANGE_KIND)!;
        const payload = env.autonomy.proposals[0]!.payload;
        await applier(payload);
        expect(env.state.value('rep', 'Crown', 'standing')).toBe('hated');
        await expect(applier({})).rejects.toThrow('bad mechanics change card');
        env.mock.chat[index]!.swipe_id = 3;
        await applier(payload);
        expect(env.state.history()).toHaveLength(1);
    });

    it('stays quiet when switched off, over the cap, without a model, or for a stale reply', async () => {
        env.settings.background = false;
        await committed();
        env.settings.background = true;
        env.cost.cap = true;
        await committed();
        env.cost.cap = false;
        env.llm.availableFlag = false;
        await committed();
        expect(env.tasks.queued).toEqual([]);
        env.llm.availableFlag = true;
        const index = await committed();
        expect(env.tasks.queued).toHaveLength(1);
        env.mock.chat[index]!.swipe_id = 1;
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.llm.requests).toEqual([]);
        env.mock.chat[index]!.swipe_id = 0;
        env.leader.value = false;
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.llm.requests).toEqual([]);
        env.leader.value = true;
        env.mock.chat[index]!.mes = '';
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.llm.requests).toEqual([]);
    });

    it('drops an answer that arrives after the reply changed', async () => {
        const index = await committed();
        env.llm.responses.push({
            ok: true,
            data: { changes: [{ holder: 'Guild', attribute: 'standing', value: 'liked', delta: null, reason: '' }] },
        });
        const run = env.tasks.runLatest(EXTRACT_TASK);
        env.mock.chat[index]!.swipe_id = 2;
        await run;
        expect(env.state.history()).toEqual([]);
    });
});
