import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVISION_TASK } from '../../../src/features/revision/settings';
import { createRevision, createRevisionTestApp, flushTimers, signal } from './helpers';
import type { RevisionParts, RevisionTestApp } from './helpers';

let env: RevisionTestApp;
let parts: RevisionParts;

beforeEach(() => {
    env = createRevisionTestApp();
    parts = createRevision(env);
});

afterEach(() => parts.dispose());

const queued = () =>
    env.app.tasks as unknown as { queued: { kind: string; dedupeKey?: string; payload: Record<string, unknown> }[] };

describe('triggers with the signals service', () => {
    it('queues a revision when three signals wait', async () => {
        env.signals.pendingList = [signal('relationship.changed', 2), signal('alias.added', 2)];
        env.signals.emit({ messageIndex: 2, signals: env.signals.pendingList, folded: 0 });
        await flushTimers();
        expect(queued().queued).toHaveLength(0);
        env.signals.pendingList.push(signal('appearance.changed', 3, 'Anna'));
        env.signals.emit({ messageIndex: 3, signals: env.signals.pendingList, folded: 0 });
        await flushTimers();
        expect(queued().queued).toEqual([
            expect.objectContaining({ kind: REVISION_TASK, dedupeKey: 'revision', payload: { reason: 'signals' } }),
        ]);
    });

    it('queues every N messages and at the end of a scene', async () => {
        env.signals.since = 10;
        expect(await parts.service.evaluate()).toBe('interval');
        env.signals.since = 1;
        env.signals.pendingList = [signal('location.changed', 3)];
        env.signals.emit({ messageIndex: 3, signals: [signal('scene.ended', 3)], folded: 0 });
        await flushTimers();
        expect(queued().queued.map((task) => task.payload.reason)).toEqual(['interval', 'sceneEnd']);
    });

    it('respects the settings', async () => {
        const slice = parts.settings();
        slice.signalThreshold = 5;
        slice.everyMessages = 0;
        slice.sceneEnd = false;
        env.signals.pendingList = [1, 2, 3, 4].map((index) => signal('alias.added', index));
        env.signals.since = 50;
        expect(await parts.service.evaluate()).toBeNull();
        env.signals.emit({ messageIndex: 3, signals: [signal('scene.ended', 3)], folded: 0 });
        await flushTimers();
        expect(queued().queued).toHaveLength(0);
    });

    it('does nothing in a tab that is not the leader, in a group chat, at the cap or without a profile', async () => {
        env.signals.since = 20;
        env.leader.value = false;
        expect(await parts.service.evaluate()).toBeNull();
        env.leader.value = true;
        env.host.group = true;
        expect(await parts.service.evaluate()).toBeNull();
        env.host.group = false;
        env.capped.value = true;
        expect(await parts.service.evaluate()).toBeNull();
        env.capped.value = false;
        env.llm.ready = false;
        expect(await parts.service.evaluate()).toBeNull();
        expect(queued().queued).toHaveLength(0);
    });

    it('never queues during a generation: it waits for the end', async () => {
        env.signals.since = 20;
        env.turn.generation = { type: 'normal', dryRun: false, quiet: false };
        expect(await parts.service.evaluate()).toBeNull();
        expect(queued().queued).toHaveLength(0);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await flushTimers();
        expect(queued().queued.map((task) => task.payload.reason)).toEqual(['interval']);
    });

    it('waits two more messages after a failed run', async () => {
        env.llm.script = [{ ok: false, error: 'transport: 500' }];
        env.signals.since = 20;
        await parts.service.execute('interval');
        expect(await parts.service.evaluate()).toBeNull();
        env.chat.push({ name: 'Anna', is_user: false, is_system: false, send_date: '', mes: 'a' });
        env.chat.push({ name: 'User', is_user: true, is_system: false, send_date: '', mes: 'b' });
        env.chat.push({ name: 'Anna', is_user: false, is_system: false, send_date: '', mes: 'c' });
        env.chat.push({ name: 'User', is_user: true, is_system: false, send_date: '', mes: 'd' });
        expect(await parts.service.evaluate()).toBe('interval');
    });
});

describe('triggers without the signals service', () => {
    beforeEach(() => {
        parts.dispose();
        env.modules.apis.delete('signals');
        parts = createRevision(env);
    });

    it('counts bus signals itself, ignoring its own', async () => {
        await env.app.bus.emit('signal', { ...signal('fact.new', 3), data: { source: 'revision' } });
        await env.app.bus.emit('signal', signal('alias.added', 3));
        await env.app.bus.emit('signal', { ...signal('alias.added', 3), chatId: 'other chat' });
        await flushTimers();
        expect(parts.service.status()).toMatchObject({ pending: 1, signalsApi: false });
        await env.app.bus.emit('signal', signal('memory.long', 3));
        await env.app.bus.emit('signal', signal('location.changed', 4));
        await flushTimers();
        expect(queued().queued.map((task) => task.payload.reason)).toEqual(['signals']);
    });

    it('counts committed messages since the last revision', async () => {
        // Messages 0..4 are committed; with nothing revised yet that is 5 messages.
        await parts.service.loadDoc();
        expect(parts.service.status().messagesSince).toBe(5);
        parts.settings().everyMessages = 5;
        await env.app.bus.emit('turn:committed', { messageIndex: 3 });
        await flushTimers();
        expect(queued().queued.map((task) => task.payload.reason)).toEqual(['interval']);
    });

    it('a scene end starts a run', async () => {
        await env.app.bus.emit('signal', signal('scene.ended', 4));
        await flushTimers();
        expect(queued().queued.map((task) => task.payload.reason)).toEqual(['sceneEnd']);
    });
});

describe('by hand', () => {
    it('queues a manual run; refuses without a chat or in a group chat', async () => {
        await env.modules.api<{ run(): Promise<void> }>('revision')!.run();
        expect(queued().queued.map((task) => task.payload.reason)).toEqual(['manual']);
        env.host.group = true;
        await expect(parts.service.request('manual')).rejects.toThrow('Maestro sleeps in group chats.');
        env.host.group = false;
        env.mock.chatId = undefined;
        await expect(parts.service.request('manual')).rejects.toThrow('No chat is open.');
    });

    it('the runner reads the reason from the payload', async () => {
        env.llm.script = [{ ok: true, data: { changes: [] } }];
        await parts.service.request('signals');
        await (env.app.tasks as unknown as { runLatest(kind: string): Promise<void> }).runLatest(REVISION_TASK);
        expect(
            parts.service
                .api()
                .runs()
                .map((run) => run.reason),
        ).toEqual(['signals']);
    });
});
