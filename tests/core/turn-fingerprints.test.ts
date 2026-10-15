// Release 1.26: ST's MESSAGE_DELETED gives the new chat length, not the deleted index. The turn pipeline keeps a light
// fingerprint list of the chat and says which messages went (`removedAt`, `removed`); `messageIndex` stays ST's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBus } from '../../src/core/bus';
import { createEphemeral } from '../../src/core/ephemeral';
import { messageFingerprint, removedRange, TurnPipeline } from '../../src/core/turn';
import type { EphemeralRunner } from '../../src/core/turn';
import type { Bus } from '../../src/shared/contracts';
import { createTestHost, createTestLogger } from '../helpers/core-host';
import { EVENT_TYPES, installStMock, message } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

describe('fingerprints', () => {
    it('name the author, the date and the start of the text', () => {
        expect(messageFingerprint(message('Hello there', { is_user: true, send_date: 'May 1, 2026 3:04pm' }))).toBe(
            'u|May 1, 2026 3:04pm|Hello there',
        );
        expect(messageFingerprint(message('x'.repeat(100)))).toBe(`a||${'x'.repeat(40)}`);
        expect(messageFingerprint(message('note', { is_system: true }))).toBe('s||note');
        expect(messageFingerprint(undefined)).toBe('-');
    });

    it('find the deleted range by the common prefix and a verified suffix', () => {
        const before = ['a', 'b', 'c', 'd', 'e'];
        expect(removedRange(before, ['a', 'b', 'd', 'e'])).toEqual({ at: 2, count: 1 });
        expect(removedRange(before, ['a', 'e'])).toEqual({ at: 1, count: 3 });
        expect(removedRange(before, ['a', 'b', 'c'])).toEqual({ at: 3, count: 2 });
        expect(removedRange(before, ['b', 'c', 'd', 'e'])).toEqual({ at: 0, count: 1 });
        // The rest does not line up: unknown.
        expect(removedRange(before, ['a', 'x', 'y'])).toBeNull();
        expect(removedRange(before, before)).toBeNull();
        expect(removedRange(['a'], ['a', 'b'])).toBeNull();
    });

    it('fall back to author and date when a text changed without an event', () => {
        const before = ['a|1|one', 'u|2|two', 'a|3|three', 'u|4|four'];
        expect(removedRange(before, ['a|1|one', 'a|3|three (edited)', 'u|4|four'])).toEqual({ at: 1, count: 1 });
    });
});

describe('the turn pipeline on MESSAGE_DELETED', () => {
    let mock: StMock;
    let bus: Bus;
    let turn: TurnPipeline;
    let events: Record<string, unknown>[];

    beforeEach(() => {
        mock = installStMock();
        const host = createTestHost(mock);
        bus = createBus(createTestLogger());
        events = [];
        bus.on('message:invalidated', (payload) => {
            events.push({ ...payload });
        });
        const ephemeral: EphemeralRunner = createEphemeral({ host, log: createTestLogger() });
        mock.chat.push(
            message('Hi', { is_user: true, send_date: 'd0' }),
            message('Reply one', { send_date: 'd1' }),
            message('Go on', { is_user: true, send_date: 'd2' }),
            message('Reply two', { send_date: 'd3' }),
            message('And then', { is_user: true, send_date: 'd4' }),
            message('Reply three', { send_date: 'd5' }),
        );
        turn = new TurnPipeline(host, bus, ephemeral, createTestLogger());
        turn.install();
    });

    afterEach(() => turn.dispose());

    it('says which messages went from the middle; messageIndex stays the new length', async () => {
        mock.chat.splice(2, 2);
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_DELETED!, mock.chat.length);
        expect(events).toEqual([{ messageIndex: 4, reason: 'deleted', removedAt: 2, removed: 2 }]);
        // The list follows: the next deletion compares with the chat after the first.
        mock.chat.splice(0, 1);
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_DELETED!, mock.chat.length);
        expect(events[1]).toEqual({ messageIndex: 3, reason: 'deleted', removedAt: 0, removed: 1 });
    });

    it('says so for a deletion at the end as well, and keeps up with new and edited messages', async () => {
        mock.chat.push(message('Fourth', { send_date: 'd6' }));
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_RECEIVED!, 6, 'normal');
        mock.chat[3]!.mes = 'Reply two, edited';
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_EDITED!, 3);
        mock.chat.splice(4, 1);
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_DELETED!, mock.chat.length);
        expect(events.at(-1)).toEqual({ messageIndex: 6, reason: 'deleted', removedAt: 4, removed: 1 });
        mock.chat.length = 5;
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_DELETED!, mock.chat.length);
        expect(events.at(-1)).toEqual({ messageIndex: 5, reason: 'deleted', removedAt: 5, removed: 1 });
    });

    it('leaves the range out when it cannot tell', async () => {
        // A message the pipeline never saw, then a deletion: the lengths do not tell.
        mock.chat.push(message('Narrator', { is_system: true, send_date: 'd9' }));
        mock.chat.splice(1, 1);
        await mock.eventSource.emit(EVENT_TYPES.MESSAGE_DELETED!, mock.chat.length);
        expect(events).toEqual([{ messageIndex: 6, reason: 'deleted' }]);
    });
});
