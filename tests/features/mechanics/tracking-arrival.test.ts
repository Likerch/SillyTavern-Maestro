// Release 1.25: a story reply's changes go into the values as soon as it is shown (provisional until the user answers),
// swipes and continuations take them back and read the reply again, and health() says what keeps the values still.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRACT_TASK, readBlockRecord } from '../../../src/features/mechanics/tracking';
import { createMechanicsEnv, healthDef, magicDef, SETTLE } from './helpers-state';
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

async function shown(index: number, type = 'normal'): Promise<void> {
    await env.app.bus.emit('reply:ready', { messageIndex: index, type });
    await env.tick(SETTLE);
}

describe('values follow the reply at once', () => {
    it('applies a reply when it is shown; the commit adds nothing', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`, [{ name: 'Kai' }]);
        expect(env.tracking.provisionalIndex()).toBe(-1);
        await shown(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        expect(env.tracking.provisionalIndex()).toBe(index);
        await env.commit(index);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        expect(env.state.history()).toHaveLength(1);
        // The user answered: nothing is provisional any more.
        expect(env.tracking.provisionalIndex()).toBe(-1);
    });

    it('takes a swipe back and brings an older variant back when the user swipes to it', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`, [{ name: 'Kai' }]);
        await shown(index);
        const message = env.mock.chat[index]!;
        // A new variant: the swipe takes the first one's changes back, the new reply is read when shown.
        (message.swipes as string[]).push('');
        (message.swipe_info as unknown[]).push({ extra: {} });
        message.swipe_id = 1;
        message.mes = 'Пламя погасло.\n<mechanics>\nKai.mana: -5\n</mechanics>';
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await env.tick(50);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
        await env.mock.eventSource.emit('message_received', index, 'swipe');
        await shown(index, 'swipe');
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(45);
        // Back to the first variant: no generation follows, so the variant is read again by itself.
        message.swipe_id = 0;
        message.mes = (message.swipes as string[])[0]!;
        expect(readBlockRecord(message)?.items.map((item) => item.value)).toEqual([-10]);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await env.tick(SETTLE * 3);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        expect(env.state.history()).toHaveLength(1);
    });

    it('reads a continued reply again as a whole, without counting the first part twice', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`, [{ name: 'Kai' }]);
        await shown(index);
        const message = env.mock.chat[index]!;
        message.mes += '\n<mechanics>\nKai.mana: -5\n</mechanics>';
        await env.mock.eventSource.emit('message_received', index, 'continue');
        await shown(index, 'continue');
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(35);
        expect(env.state.history()).toHaveLength(2);
    });

    it('re-reads an edited reply the user has not answered yet', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`, [{ name: 'Kai' }]);
        await shown(index);
        const message = env.mock.chat[index]!;
        message.mes = `${STORY}\n<mechanics>\nKai.mana: -20\n</mechanics>`;
        await env.mock.eventSource.emit('message_edited', index);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await env.tick(SETTLE);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(30);
    });

    it('leaves greetings and foreign messages alone', async () => {
        const index = await env.receive(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`, [{ name: 'Kai' }]);
        await shown(index, 'first_message');
        await shown(index, 'extension');
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
    });

    it('starts the background parse right after the reply', async () => {
        env.defs.defs = [magicDef({ tracking: 'background' })];
        const index = await env.receive(STORY, [{ name: 'Kai' }]);
        await shown(index);
        expect(env.tasks.queued).toEqual([
            expect.objectContaining({ kind: EXTRACT_TASK, payload: { messageIndex: index, swipeId: 0 } }),
        ]);
        await env.commit(index);
        expect(env.tasks.queued).toHaveLength(1);
    });
});

describe('the background parse is done once per reply', () => {
    it('does not read a parsed reply again after a reload, but does after an edit', async () => {
        env.defs.defs = [magicDef({ tracking: 'background' })];
        const index = await env.receive(STORY, [{ name: 'Kai' }]);
        await shown(index);
        env.llm.responses.push({ ok: true, data: { changes: [] } });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.tasks.queued).toHaveLength(1);
        // A reload forgets what this page enqueued; the mark on the message stays.
        (env.tracking as unknown as { enqueued: Set<string> }).enqueued.clear();
        await env.commit(index);
        expect(env.tasks.queued).toHaveLength(1);
        // The text changed: read again.
        env.mock.chat[index]!.mes = 'Пламя погасло.';
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await env.tick(SETTLE);
        expect(env.tasks.queued).toHaveLength(2);
    });
});

describe('tracking health', () => {
    it('is quiet while all is well', async () => {
        await env.receive(STORY, [{ name: 'Kai' }]);
        expect(env.tracking.health()).toEqual([]);
    });

    it('warns when the background parse cannot run, and why', async () => {
        env.defs.defs = [magicDef({ tracking: 'background' })];
        await env.receive(STORY, [{ name: 'Kai' }]);
        env.llm.availableFlag = false;
        expect(env.tracking.health()).toEqual([
            expect.objectContaining({ code: 'noProfile', level: 'warn', mechanics: ['magic'] }),
        ]);
        expect(env.tracking.health()[0]?.text).toContain('Магия');
        env.llm.availableFlag = true;
        env.cost.cap = true;
        expect(env.tracking.health().map((problem) => problem.code)).toEqual(['cap']);
        env.cost.cap = false;
        env.settings.background = false;
        expect(env.tracking.health().map((problem) => problem.code)).toEqual(['backgroundOff']);
        env.settings.background = true;
        env.leader.value = false;
        expect(env.tracking.health()).toEqual([expect.objectContaining({ code: 'otherTab', level: 'info' })]);
    });

    it('reports a failed background parse until one works, and tells the listeners', async () => {
        env.defs.defs = [magicDef({ tracking: 'background' })];
        const listener = vi.fn();
        env.tracking.onHealthChange(listener);
        const index = await env.receive(STORY, [{ name: 'Kai' }]);
        await shown(index);
        env.llm.responses.push({ ok: false, error: 'boom' });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.tracking.health()).toEqual([
            expect.objectContaining({ code: 'extractFailed', level: 'warn', detail: 'boom' }),
        ]);
        expect(listener).toHaveBeenCalledTimes(1);
        const next = await env.receive('Ничего не случилось.', [{ name: 'Kai' }]);
        await shown(next);
        env.llm.responses.push({ ok: true, data: { changes: [] } });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.tracking.health()).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('tells the listeners when the leadership moves', async () => {
        await env.receive(STORY, [{ name: 'Kai' }]);
        const listener = vi.fn();
        env.tracking.onHealthChange(listener);
        env.leader.set(false);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(env.tracking.health().map((problem) => problem.code)).toEqual(['otherTab']);
        env.leader.set(true);
        expect(env.tracking.health()).toEqual([]);
    });

    it('notes DES stats DES does not track yet', async () => {
        env.defs.defs = [healthDef()];
        await env.receive(STORY, [{ name: 'Kai' }]);
        const codes = env.tracking.health().map((problem) => problem.code);
        expect(codes).toContain('desStatsPending');
        env.des.stats().enabled = true;
        env.des.stats().customStats[0]!.enabled = true;
        expect(env.tracking.health().map((problem) => problem.code)).not.toContain('desStatsPending');
    });
});
