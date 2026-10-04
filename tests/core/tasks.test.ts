import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus';
import { createChatStore } from '../../src/core/chat-store';
import { createFileStore } from '../../src/core/files';
import { createTaskQueue } from '../../src/core/tasks';
import type { TaskQueueOptions, TaskQueueService } from '../../src/core/tasks';
import type { Bus, TaskInfo } from '../../src/shared/contracts';
import { createTestHost, createTestLogger, storedJson } from '../helpers/core-host';
import type { TestHost } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;
let host: TestHost;
let bus: Bus;
let leading: boolean;
let idle: boolean;
let allowed: boolean;
const queues: TaskQueueService[] = [];

function queue(options: TaskQueueOptions = {}, isLeader: () => boolean = () => leading): TaskQueueService {
    const files = createFileStore(host, createTestLogger());
    const created = createTaskQueue(
        {
            host,
            chat: createChatStore(host, files, createTestLogger()),
            files,
            leader: { isLeader, onChange: () => () => {} },
            bus,
            log: createTestLogger(),
            isIdle: () => idle,
            canRun: () => allowed,
        },
        { pollMs: 5_000, ...options },
    );
    queues.push(created);
    return created;
}

async function flush(ms = 10): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    for (const item of queues) await item.idle();
    await vi.advanceTimersByTimeAsync(0);
}

function stored(): { tasks: TaskInfo[]; history: TaskInfo[] } {
    return (
        storedJson<{ tasks: TaskInfo[]; history: TaskInfo[] }>(mock, 'maestro-tasks.json') ?? { tasks: [], history: [] }
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    mock = installStMock();
    host = createTestHost(mock);
    bus = createBus(createTestLogger());
    leading = true;
    idle = true;
    allowed = true;
});

afterEach(() => {
    for (const item of queues.splice(0)) item.stop();
    vi.useRealTimers();
});

describe('task queue', () => {
    it('persists enqueued tasks with the current chat id', async () => {
        const q = queue();
        const id = await q.enqueue({ kind: 'demo', payload: { n: 1 } });
        expect(stored().tasks).toEqual([
            expect.objectContaining({
                id,
                kind: 'demo',
                chatId: 'chat-1',
                state: 'pending',
                attempts: 0,
                payload: { n: 1 },
            }),
        ]);
        expect(q.list()).toHaveLength(1);
    });

    it('runs a registered task in the leader tab and keeps it in history', async () => {
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        const id = await q.enqueue({ kind: 'demo', payload: { n: 1 } });
        await flush();
        expect(runner).toHaveBeenCalledTimes(1);
        const [payload, info] = runner.mock.calls[0] as unknown as [Record<string, unknown>, TaskInfo];
        expect(payload).toEqual({ n: 1 });
        expect(info).toMatchObject({ id, kind: 'demo', state: 'running', attempts: 1 });
        expect(stored().tasks).toEqual([]);
        expect(stored().history).toEqual([expect.objectContaining({ id, state: 'done', attempts: 1 })]);
        expect(q.list().map((task) => task.state)).toEqual(['done']);
    });

    it('waits for leadership, idleness and canRun', async () => {
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        leading = false;
        idle = false;
        allowed = false;
        await q.enqueue({ kind: 'demo', payload: {} });
        await flush(6_000);
        expect(runner).not.toHaveBeenCalled();

        leading = true;
        await bus.emit('leader:changed', { leader: true });
        await flush();
        expect(runner).not.toHaveBeenCalled();

        idle = true;
        await bus.emit('generation:ended', { type: 'normal', stopped: false });
        await flush();
        expect(runner).not.toHaveBeenCalled();

        allowed = true;
        await flush(5_000);
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('runs only tasks of the open chat', async () => {
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        await q.enqueue({ kind: 'demo', payload: {}, chatId: 'chat-2' });
        await flush(6_000);
        expect(runner).not.toHaveBeenCalled();
        mock.chatId = 'chat-2';
        await bus.emit('chat:changed', { chatId: 'chat-2' });
        await flush();
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('does not run in a group chat', async () => {
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        host.group = true;
        await q.enqueue({ kind: 'demo', payload: {} });
        await flush(6_000);
        expect(runner).not.toHaveBeenCalled();
    });

    it('rolls up pending tasks with the same dedupeKey', async () => {
        const q = queue();
        const first = await q.enqueue({ kind: 'demo', dedupeKey: 'scan', payload: { n: 1 } });
        const second = await q.enqueue({ kind: 'demo', dedupeKey: 'scan', payload: { n: 2 }, priority: 3 });
        await q.enqueue({ kind: 'demo', dedupeKey: 'other', payload: { n: 3 } });
        expect(second).toBe(first);
        expect(stored().tasks).toHaveLength(2);
        expect(stored().tasks[0]).toMatchObject({ id: first, payload: { n: 2 }, priority: 3 });
    });

    it('runs by priority, then oldest first, one at a time', async () => {
        const q = queue();
        const order: number[] = [];
        let release: () => void = () => {};
        let active = 0;
        let maxActive = 0;
        q.register('demo', async (payload) => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push(payload.n as number);
            if (payload.n === 2) await new Promise<void>((resolve) => (release = resolve));
            active--;
        });
        leading = false;
        q.start();
        await q.enqueue({ kind: 'demo', payload: { n: 1 } });
        await vi.advanceTimersByTimeAsync(1);
        await q.enqueue({ kind: 'demo', payload: { n: 2 }, priority: 5 });
        await vi.advanceTimersByTimeAsync(1);
        await q.enqueue({ kind: 'demo', payload: { n: 3 } });
        leading = true;
        q.kick();
        await vi.advanceTimersByTimeAsync(10);
        expect(order).toEqual([2]);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(order).toEqual([2]);
        release();
        await flush();
        await flush();
        expect(order).toEqual([2, 1, 3]);
        expect(maxActive).toBe(1);
    });

    it('retries failures after 2 s, 10 s and 30 s, then marks the task failed', async () => {
        const q = queue({ pollMs: 60_000 });
        const times: number[] = [];
        const start = Date.now();
        q.register('demo', async () => {
            times.push(Date.now() - start);
            throw new Error('nope');
        });
        q.start();
        await q.enqueue({ kind: 'demo', payload: {} });
        await flush();
        await flush(2_000);
        await flush(10_000);
        await flush(30_000);
        await flush(60_000);
        expect(times).toHaveLength(4);
        expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(2_000);
        expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(10_000);
        expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(30_000);
        expect(stored().history).toEqual([expect.objectContaining({ state: 'failed', attempts: 4, error: 'nope' })]);
    });

    it('finishes after a successful retry', async () => {
        const q = queue();
        let calls = 0;
        q.register('demo', async () => {
            calls++;
            if (calls === 1) throw new Error('flaky');
        });
        q.start();
        await q.enqueue({ kind: 'demo', payload: {} });
        await flush();
        expect(stored().tasks[0]).toMatchObject({ state: 'pending', attempts: 1, error: 'flaky' });
        await flush(2_000);
        expect(calls).toBe(2);
        expect(stored().history[0]).toMatchObject({ state: 'done', attempts: 2 });
        expect(stored().history[0]).not.toHaveProperty('error');
    });

    it('fails a runner that never settles', async () => {
        const q = queue({ runTimeoutMs: 1_000, retryDelaysMs: [] });
        q.register('demo', () => new Promise<void>(() => {}));
        q.start();
        await q.enqueue({ kind: 'demo', payload: {} });
        await flush(1_100);
        expect(stored().history[0]).toMatchObject({ state: 'failed', error: 'timed out after 1000 ms' });
    });

    it('expires tasks that did not start within their ttl', async () => {
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        leading = false;
        await q.enqueue({ kind: 'demo', payload: {}, ttlMs: 1_000 });
        await flush(2_000);
        leading = true;
        q.kick();
        await flush();
        expect(runner).not.toHaveBeenCalled();
        expect(stored().history[0]).toMatchObject({ state: 'expired' });
    });

    it('waits for a runner of its kind and starts when one registers', async () => {
        const q = queue();
        q.start();
        await q.enqueue({ kind: 'later', payload: {} });
        await flush(6_000);
        expect(stored().tasks[0]?.state).toBe('pending');
        const runner = vi.fn(async () => {});
        const off = q.register('later', runner);
        await flush();
        expect(runner).toHaveBeenCalledTimes(1);
        off();
    });

    it('survives a reload: another instance picks the stored task up', async () => {
        const first = queue();
        await first.enqueue({ kind: 'demo', payload: { n: 7 } });
        first.stop();
        const second = queue();
        const runner = vi.fn(async () => {});
        second.register('demo', runner);
        second.start();
        await flush();
        expect(runner).toHaveBeenCalledWith({ n: 7 }, expect.objectContaining({ kind: 'demo' }));
    });

    it('does not run a task twice when two tabs share the queue', async () => {
        const runsA = vi.fn(async () => {});
        const runsB = vi.fn(async () => {});
        const a = queue({}, () => true);
        const b = queue({}, () => false);
        a.register('demo', runsA);
        b.register('demo', runsB);
        a.start();
        b.start();
        await b.enqueue({ kind: 'demo', payload: {} });
        // A learns about B's task on its next idle refresh (at most 30 s).
        await flush(31_000);
        expect(runsA).toHaveBeenCalledTimes(1);
        expect(runsB).not.toHaveBeenCalled();
    });

    it('requeues a task left running by a closed tab', async () => {
        const now = Date.now();
        mock.files.set(
            'maestro-tasks.json',
            JSON.stringify({
                schema: 1,
                version: 1,
                tasks: [
                    {
                        id: 'old',
                        kind: 'demo',
                        payload: {},
                        chatId: 'chat-1',
                        state: 'running',
                        attempts: 1,
                        createdAt: now - 20 * 60_000,
                        updatedAt: now - 20 * 60_000,
                        startedAt: now - 20 * 60_000,
                        runningBy: 'gone',
                    },
                ],
                history: [],
            }),
        );
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        await flush();
        expect(runner).toHaveBeenCalledTimes(1);
        expect(stored().history[0]).toMatchObject({ id: 'old', state: 'done', attempts: 2 });
    });

    it('keeps a short history', async () => {
        const q = queue({ historyLimit: 3 });
        q.register('demo', async () => {});
        q.start();
        for (let i = 0; i < 5; i++) await q.enqueue({ kind: 'demo', payload: { i } });
        for (let i = 0; i < 5; i++) await flush();
        expect(stored().history.map((task) => task.payload)).toEqual([{ i: 2 }, { i: 3 }, { i: 4 }]);
    });

    it('does not read the file on every poll while the queue is empty', async () => {
        const q = queue();
        q.start();
        await flush();
        const reads = () => mock.requests.filter((request) => request.url.includes('maestro-tasks.json')).length;
        const before = reads();
        await flush(25_000);
        expect(reads()).toBe(before);
        await flush(10_000);
        expect(reads()).toBe(before + 1);
    });

    it('refuses to enqueue without a chat', async () => {
        mock.chatId = undefined;
        await expect(queue().enqueue({ kind: 'demo', payload: {} })).rejects.toThrow(/no chat/);
    });

    it('stops running after stop()', async () => {
        const q = queue();
        const runner = vi.fn(async () => {});
        q.register('demo', runner);
        q.start();
        q.stop();
        await q.enqueue({ kind: 'demo', payload: {} });
        await flush(20_000);
        expect(runner).not.toHaveBeenCalled();
    });
});
