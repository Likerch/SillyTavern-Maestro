import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus';
import { createFileStore } from '../../src/core/files';
import { createLeader } from '../../src/core/leader';
import type { LeaderChannel, LeaderLock, LeaderService } from '../../src/core/leader';
import type { Bus } from '../../src/shared/contracts';
import { createTestHost, createTestLogger, storedJson, switchChat } from '../helpers/core-host';
import type { TestHost } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

/** BroadcastChannel stand-in shared by the "tabs" of one test. */
function channelHub() {
    const members = new Set<{ handler?: (message: unknown) => void }>();
    const make = (): LeaderChannel => {
        const me: { handler?: (message: unknown) => void } = {};
        members.add(me);
        return {
            post: (message) => {
                for (const other of members) {
                    if (other !== me) queueMicrotask(() => other.handler?.(structuredClone(message)));
                }
            },
            listen: (handler) => {
                me.handler = handler;
            },
            close: () => members.delete(me),
        };
    };
    return { make, size: () => members.size };
}

let mock: StMock;
let host: TestHost;
let bus: Bus;
let hub: ReturnType<typeof channelHub>;
const tabs: LeaderService[] = [];

function tab(tabId: string, page: EventTarget | null = null): LeaderService {
    const leader = createLeader(host, createFileStore(host, createTestLogger()), bus, createTestLogger(), {
        tabId,
        channel: hub.make,
        page,
        confirmDelayMs: () => 100,
    });
    tabs.push(leader);
    return leader;
}

function lock(chatId = 'chat-1'): LeaderLock | undefined {
    const files = createFileStore(host, createTestLogger());
    return storedJson<LeaderLock>(mock, files.fileName('lock', chatId));
}

function writeLock(value: LeaderLock, chatId = 'chat-1'): void {
    const files = createFileStore(host, createTestLogger());
    mock.files.set(files.fileName('lock', chatId), JSON.stringify(value));
}

beforeEach(() => {
    vi.useFakeTimers();
    mock = installStMock();
    host = createTestHost(mock);
    bus = createBus(createTestLogger());
    hub = channelHub();
});

afterEach(() => {
    for (const leader of tabs.splice(0)) leader.stop();
    vi.useRealTimers();
});

describe('leader', () => {
    it('takes a free lock after confirming it and reports the change', async () => {
        const events: boolean[] = [];
        bus.on('leader:changed', ({ leader }) => void events.push(leader));
        const a = tab('A');
        const seen: boolean[] = [];
        a.onChange((value) => seen.push(value));
        a.start();
        await vi.advanceTimersByTimeAsync(50);
        expect(a.isLeader()).toBe(false);
        await vi.advanceTimersByTimeAsync(60);
        expect(a.isLeader()).toBe(true);
        expect(lock()).toMatchObject({ tabId: 'A', chatId: 'chat-1' });
        expect(events).toEqual([true]);
        expect(seen).toEqual([true]);
    });

    it('sends a heartbeat every 10 s', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        const first = lock()!.heartbeatAt;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(lock()!.heartbeatAt).toBeGreaterThanOrEqual(first + 10_000);
        expect(a.isLeader()).toBe(true);
    });

    it('does not take a fresh lock of another tab, but takes it once stale (> 30 s)', async () => {
        writeLock({ tabId: 'Z', heartbeatAt: Date.now() });
        const b = tab('B');
        b.start();
        await vi.advanceTimersByTimeAsync(200);
        expect(b.isLeader()).toBe(false);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(b.isLeader()).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(b.isLeader()).toBe(true);
        expect(lock()?.tabId).toBe('B');
    });

    it('keeps exactly one leader when two tabs start together', async () => {
        const a = tab('A');
        const b = tab('B');
        a.start();
        b.start();
        await vi.advanceTimersByTimeAsync(300);
        expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
    });

    it('hands over at once when the leader stops', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        const b = tab('B');
        b.start();
        await vi.advanceTimersByTimeAsync(200);
        expect([a.isLeader(), b.isLeader()]).toEqual([true, false]);
        a.stop();
        await vi.advanceTimersByTimeAsync(300);
        expect(a.isLeader()).toBe(false);
        expect(b.isLeader()).toBe(true);
        expect(lock()?.tabId).toBe('B');
    });

    it('releases on pagehide so another tab takes over quickly', async () => {
        const page = new EventTarget();
        const a = tab('A', page);
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        const b = tab('B');
        b.start();
        await vi.advanceTimersByTimeAsync(200);
        page.dispatchEvent(new Event('pagehide'));
        await vi.advanceTimersByTimeAsync(300);
        expect(b.isLeader()).toBe(true);
    });

    it('steps down when another tab claims the chat', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        expect(a.isLeader()).toBe(true);
        writeLock({ tabId: 'B', heartbeatAt: Date.now() });
        hub.make().post({ type: 'claim', chatId: 'chat-1', tabId: 'B' });
        await vi.advanceTimersByTimeAsync(10);
        expect(a.isLeader()).toBe(false);
    });

    it('ignores channel messages about other chats and its own messages', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        writeLock({ tabId: 'B', heartbeatAt: Date.now() });
        const other = hub.make();
        other.post({ type: 'claim', chatId: 'chat-9', tabId: 'B' });
        other.post({ type: 'claim', chatId: 'chat-1', tabId: 'A' });
        other.post({ type: 'bogus', chatId: 'chat-1', tabId: 'B' } as never);
        await vi.advanceTimersByTimeAsync(10);
        expect(a.isLeader()).toBe(true);
    });

    it('moves the lock with the chat and releases the old one', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        await switchChat(mock, 'chat-2');
        await vi.advanceTimersByTimeAsync(200);
        expect(lock('chat-1')).toBeUndefined();
        expect(lock('chat-2')?.tabId).toBe('A');
        expect(a.isLeader()).toBe(true);
    });

    it('is never leader without a chat or in a group chat', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        expect(a.isLeader()).toBe(true);
        await switchChat(mock, undefined);
        await vi.advanceTimersByTimeAsync(10);
        expect(a.isLeader()).toBe(false);
        expect(lock('chat-1')).toBeUndefined();

        host.group = true;
        await switchChat(mock, 'group-1');
        await vi.advanceTimersByTimeAsync(10_200);
        expect(a.isLeader()).toBe(false);
    });

    it('steps down when it cannot heartbeat for longer than the stale time', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        const original = globalThis.fetch;
        globalThis.fetch = async () => new Response('down', { status: 503 });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(a.isLeader()).toBe(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(a.isLeader()).toBe(false);
        globalThis.fetch = original;
    });

    it('closes the channel and stops the heartbeat on stop', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        expect(hub.size()).toBe(1);
        a.stop();
        await vi.advanceTimersByTimeAsync(10);
        expect(hub.size()).toBe(0);
        expect(lock()).toBeUndefined();
        const count = mock.requests.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(mock.requests.length).toBe(count);
    });

    it('refresh() re-evaluates on demand', async () => {
        const a = tab('A');
        a.start();
        await vi.advanceTimersByTimeAsync(200);
        writeLock({ tabId: 'Z', heartbeatAt: Date.now() });
        await a.refresh();
        expect(a.isLeader()).toBe(false);
    });
});
