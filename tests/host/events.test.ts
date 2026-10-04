import { beforeEach, describe, expect, it } from 'vitest';
import { createHostEvents } from '../../src/host/events';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { memoryLogger } from '../helpers/host-fakes';

let mock: StMock;

beforeEach(() => {
    mock = installStMock();
});

function makeEvents() {
    const log = memoryLogger();
    return { events: createHostEvents(() => SillyTavern.getContext(), log), log };
}

async function order(event: string): Promise<string[]> {
    const calls: string[] = [];
    (globalThis as unknown as { __calls: string[] }).__calls = calls;
    await mock.eventSource.emit(event);
    return calls;
}

function tagged(tag: string) {
    return () => {
        (globalThis as unknown as { __calls: string[] }).__calls.push(tag);
    };
}

describe('host events', () => {
    it('resolves eventTypes keys and raw names', () => {
        const { events } = makeEvents();
        expect(events.name('CHAT_CHANGED')).toBe('chat_id_changed');
        expect(events.name('NOPE')).toBeUndefined();
        expect(events.name('toString')).toBeUndefined();
    });

    it('reports how long each listener ran, async ones until they settle, and stops on null', async () => {
        const { events } = makeEvents();
        const timings: [string, number][] = [];
        events.setTimer!((event, ms) => timings.push([event, ms]));
        events.on('CHAT_CHANGED', () => {});
        events.on('CHAT_CHANGED', async () => {
            await Promise.resolve();
        });
        events.on('CHAT_CHANGED', () => {
            throw new Error('boom');
        });
        await mock.eventSource.emit('chat_id_changed');
        await Promise.resolve();
        expect(timings.map(([event]) => event)).toEqual(['chat_id_changed', 'chat_id_changed', 'chat_id_changed']);
        expect(timings.every(([, ms]) => ms >= 0)).toBe(true);
        events.setTimer!(null);
        await mock.eventSource.emit('chat_id_changed');
        expect(timings).toHaveLength(3);
    });

    it('subscribes by key or raw name and unsubscribes', async () => {
        const { events } = makeEvents();
        const seen: unknown[] = [];
        const off1 = events.on('MESSAGE_SENT', (id) => {
            seen.push(['key', id]);
        });
        const off2 = events.on('message_sent', (id) => {
            seen.push(['raw', id]);
        });
        await mock.eventSource.emit('message_sent', 3);
        expect(seen).toEqual([
            ['key', 3],
            ['raw', 3],
        ]);
        off1();
        off1();
        off2();
        await mock.eventSource.emit('message_sent', 4);
        expect(seen).toHaveLength(2);
        expect(mock.eventSource.events.get('message_sent')).toHaveLength(0);
    });

    it('places first and last listeners and keeps them there after reassertOrder', async () => {
        const { events } = makeEvents();
        const es = mock.eventSource;
        es.on('character_message_rendered', tagged('des'));
        events.on('CHARACTER_MESSAGE_RENDERED', tagged('maestro-last'), { order: 'last' });
        events.on('CHARACTER_MESSAGE_RENDERED', tagged('maestro-first'), { order: 'first' });
        events.on('CHARACTER_MESSAGE_RENDERED', tagged('maestro-normal'));
        expect(await order('character_message_rendered')).toEqual([
            'maestro-first',
            'des',
            'maestro-last',
            'maestro-normal',
        ]);

        // A neighbour registers after us: plain `on` pushes behind our 'last' listener, makeFirst jumps ahead.
        es.on('character_message_rendered', tagged('nai'));
        es.makeFirst('character_message_rendered', tagged('early-bird'));
        events.reassertOrder();
        expect(await order('character_message_rendered')).toEqual([
            'maestro-first',
            'early-bird',
            'des',
            'maestro-normal',
            'nai',
            'maestro-last',
        ]);
    });

    it('keeps the relative order of several last listeners', async () => {
        const { events } = makeEvents();
        events.on('generation_ended', tagged('a'), { order: 'last' });
        events.on('generation_ended', tagged('b'), { order: 'last' });
        mock.eventSource.on('generation_ended', tagged('other'));
        events.reassertOrder();
        expect(await order('generation_ended')).toEqual(['other', 'a', 'b']);
        // Already in place: a second reassert changes nothing.
        events.reassertOrder();
        expect(await order('generation_ended')).toEqual(['other', 'a', 'b']);
    });

    it('falls back to remove/push when the emitter has no makeLast', async () => {
        const es = mock.eventSource as unknown as { makeLast?: unknown };
        const own = Object.getPrototypeOf(es) as { makeLast?: unknown };
        const saved = own.makeLast;
        delete own.makeLast;
        try {
            const { events } = makeEvents();
            events.on('generation_ended', tagged('last'), { order: 'last' });
            mock.eventSource.on('generation_ended', tagged('late'));
            events.reassertOrder();
            expect(await order('generation_ended')).toEqual(['late', 'last']);
        } finally {
            own.makeLast = saved;
        }
    });

    it('does not re-fire auto-fire events when reasserting order', async () => {
        const es = mock.eventSource as unknown as { autoFireAfterEmit: Set<string> };
        es.autoFireAfterEmit = new Set(['app_ready']);
        const { events } = makeEvents();
        let calls = 0;
        events.on(
            'APP_READY',
            () => {
                calls++;
            },
            { order: 'last' },
        );
        mock.eventSource.on('app_ready', () => {});
        events.reassertOrder();
        expect(calls).toBe(0);
        const list = mock.eventSource.events.get('app_ready') ?? [];
        expect(list).toHaveLength(2);
        await mock.eventSource.emit('app_ready');
        expect(calls).toBe(1);
    });

    it('isolates handler errors and logs them', async () => {
        const { events, log } = makeEvents();
        let after = false;
        events.on('message_sent', () => {
            throw new Error('boom');
        });
        events.on('message_sent', async () => {
            throw new Error('async boom');
        });
        events.on('message_sent', () => {
            after = true;
        });
        await mock.eventSource.emit('message_sent', 1);
        expect(after).toBe(true);
        expect(log.lines.filter((line) => line.level === 'error')).toHaveLength(2);
    });

    it('emit goes through the ST emitter and dispose removes everything', async () => {
        const { events } = makeEvents();
        const seen: unknown[] = [];
        events.on('CHAT_CHANGED', (id) => {
            seen.push(id);
        });
        events.on('message_sent', () => {}, { order: 'first' });
        await events.emit('CHAT_CHANGED', 'x');
        expect(seen).toEqual(['x']);
        events.dispose();
        expect(mock.eventSource.events.get('chat_id_changed')).toHaveLength(0);
        expect(mock.eventSource.events.get('message_sent')).toHaveLength(0);
    });
});
