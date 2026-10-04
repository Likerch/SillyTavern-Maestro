import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMEMBER_KIND } from '../../../src/features/chronicle/memory';
import type { RememberPayload } from '../../../src/features/chronicle/memory';
import type { Signal } from '../../../src/shared/contracts';
import { createChronicleTestApp, createServices, qvinkOf, reply, storedDoc, userMessage } from './helpers';
import type { ChronicleTestApp, Services } from './helpers';

type Dict = Record<string, unknown>;

let t: ChronicleTestApp;
let s: Services;

function signal(kind: string, extra: Partial<Signal> = {}): Signal {
    return { kind, chatId: 'chat-1', at: Date.now(), ...extra };
}

/** A reply with three swipes; the second one is shown. Qvink records differ per swipe. */
function swiped(text = 'They talked.'): STChatMessage {
    const message = reply(text, { memory: 'B', include: 'short' });
    message.swipes = ['a', 'b', 'c'];
    message.swipe_id = 1;
    message.swipe_info = [
        { send_date: 'x', extra: { qvink_memory: { memory: 'A', remember: false } } },
        { send_date: 'y', extra: {} },
        { send_date: 'z', extra: { qvink_memory: { memory: 'C', exclude: true } } },
    ];
    return message;
}

function swipeRecord(message: STChatMessage | undefined, swipe: number): Dict {
    const info = (message?.swipe_info as Dict[] | undefined)?.[swipe];
    return ((info?.extra as Dict | undefined)?.qvink_memory ?? {}) as Dict;
}

beforeEach(() => {
    t = createChronicleTestApp();
    s = createServices(t);
});

afterEach(() => {
    s.stop();
});

describe('M9 auto-memory: the «remember» mark', () => {
    it('marks the message and EVERY swipe on a revision signal, after the generation, with undo', async () => {
        t.mock.chat.push(userMessage(), swiped(), userMessage());
        await t.app.bus.emit(
            'signal',
            signal('memory.important', { data: { messageIndex: 1, reason: 'Turning point' } }),
        );
        await s.memory.flush();
        const message = t.mock.chat[1];
        expect(qvinkOf(message)).toEqual({
            memory: 'B',
            include: 'short',
            lagging: false,
            remember: true,
            exclude: false,
        });
        // Qvink's set_data copies the whole live record into the current swipe; the swipe-0 copy is written too.
        expect(swipeRecord(message, 1)).toEqual(qvinkOf(message));
        expect(swipeRecord(message, 0)).toEqual({ memory: 'A', remember: true, exclude: false });
        expect(swipeRecord(message, 2)).toEqual({ memory: 'C', remember: true, exclude: false });
        expect(t.slash).toEqual(['/qm-refresh']);
        expect(t.saves.count).toBe(1);
        expect(s.memory.remembered()).toEqual([{ messageIndex: 1, reason: 'important event (Turning point)' }]);
        const record = t.journal.records.find((entry) => entry.kind === REMEMBER_KIND)!;
        expect(record).toMatchObject({
            module: 'M9',
            summary: '«Remember» message #1: important event (Turning point)',
        });
        expect(record.changes[0]).toMatchObject({ target: 'm9.remember', ref: { index: 1 } });

        expect(await t.journal.undo(record.id)).toBe(true);
        expect(qvinkOf(message)).toEqual({
            memory: 'B',
            include: 'short',
            lagging: false,
            remember: false,
            exclude: false,
        });
        expect(swipeRecord(message, 0)).toEqual({ memory: 'A', remember: false, exclude: false });
        expect(swipeRecord(message, 1)).toEqual({ memory: 'B', include: 'short', lagging: false });
        expect(swipeRecord(message, 2)).toEqual({ memory: 'C', remember: false, exclude: true });
        expect(s.memory.remembered()).toEqual([]);
        expect(((await storedDoc(t)).remembered as unknown[]).length).toBe(0);
        expect(t.slash).toEqual(['/qm-refresh', '/qm-refresh']);
    });

    it('asks Qvink for a summary when the message has none, and creates missing records', async () => {
        const message = reply('He swore an oath.');
        t.mock.chat.push(userMessage(), message);
        await s.memory.remember(1, [{ code: 'oath' }]);
        expect(qvinkOf(message)).toEqual({ remember: true, exclude: false });
        expect(t.slash).toEqual(['/qm-summarize show_progress=false 1', '/qm-refresh']);
        const record = t.journal.records[0]!;
        expect(await t.journal.undo(record.id)).toBe(true);
        expect(message.extra?.qvink_memory).toBeUndefined();
    });

    it('leaves the user’s own mark alone and does not set a mark the user removed', async () => {
        t.mock.chat.push(reply('x', { memory: 'M', remember: true }));
        expect(await s.memory.remember(0, [{ code: 'quest' }])).toBeNull();
        expect(t.autonomy.proposals).toHaveLength(0);
        expect(s.memory.remembered()).toEqual([]);

        t.mock.chat.push(reply('y', { memory: 'N' }));
        await s.memory.remember(1, [{ code: 'secret' }]);
        // A second reason for a message Maestro marked: collected.
        await s.memory.remember(1, [{ code: 'quest', text: 'Find the ring' }]);
        expect(s.memory.remembered()).toEqual([
            { messageIndex: 1, reason: 'revealed secret; new quest (Find the ring)' },
        ]);
        // The user takes the mark off: Maestro does not put it back.
        (qvinkOf(t.mock.chat[1]) as Dict).remember = false;
        expect(s.memory.remembered()).toEqual([]);
        expect(await s.memory.remember(1, [{ code: 'oath' }])).toBeNull();
        expect(t.autonomy.proposals).toHaveLength(1);
    });

    it('collects signals of the signal service and ignores the rest', async () => {
        t.mock.chat.push(reply('a', { memory: 'A' }), reply('b', { memory: 'B' }), reply('c', { memory: 'C' }));
        await t.app.bus.emit('signal', signal('quest.added', { messageIndex: 0, entity: 'Find the ring' }));
        await t.app.bus.emit('signal', signal('quest.added', { messageIndex: 0, data: { title: 'Find the ring' } }));
        await t.app.bus.emit('signal', signal('relationship.changed', { messageIndex: 1, entity: 'Alice' }));
        await t.app.bus.emit('signal', signal('relationship.changed', { messageIndex: 2, chatId: 'other' }));
        await t.app.bus.emit('signal', signal('location.changed', { messageIndex: 2 }));
        await t.app.bus.emit('signal', signal('memory.important', { data: { reason: 'no index' } }));
        await s.memory.flush();
        expect(s.memory.remembered()).toEqual([
            { messageIndex: 0, reason: 'new quest (Find the ring)' },
            { messageIndex: 1, reason: 'relationship turn (Alice)' },
        ]);
    });

    it('finds oaths, secrets and quests in committed replies itself (after the generation)', async () => {
        t.mock.chat.push(
            reply('— Клянусь, я найду тебя, — сказал он.', { memory: 'He vowed to find her.' }),
            userMessage(),
            reply('Он молча пил чай.', { memory: 'Tea.' }),
            userMessage(),
        );
        t.turn.generation = { type: 'normal', dryRun: false, quiet: false };
        await t.app.bus.emit('turn:committed', { messageIndex: 0 });
        await t.app.bus.emit('turn:committed', { messageIndex: 2 });
        await s.memory.flush();
        expect(s.memory.remembered()).toEqual([]);
        t.turn.generation = null;
        await s.memory.flush();
        expect(s.memory.remembered()).toEqual([{ messageIndex: 0, reason: 'oath' }]);
        // Off: nothing is looked at.
        t.slice().keywords = false;
        t.mock.chat.push(reply('I swear it.', { memory: 'S' }));
        await t.app.bus.emit('turn:committed', { messageIndex: 4 });
        await s.memory.flush();
        expect(s.memory.remembered()).toHaveLength(1);
    });

    it('drops queued work for swiped or deleted messages', async () => {
        t.mock.chat.push(reply('a', { memory: 'A' }), reply('b', { memory: 'B' }), reply('c', { memory: 'C' }));
        s.memory.queue(0, [{ code: 'quest' }]);
        s.memory.queue(1, [{ code: 'quest' }]);
        s.memory.queue(2, [{ code: 'quest' }]);
        await t.app.bus.emit('message:invalidated', { messageIndex: 1, reason: 'deleted' });
        await s.memory.flush();
        expect(s.memory.remembered().map((row) => row.messageIndex)).toEqual([0]);
        s.memory.queue(2, [{ code: 'quest' }]);
        await t.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await s.memory.flush();
        expect(qvinkOf(t.mock.chat[2]).remember).toBeUndefined();
    });

    it('does nothing outside the leader tab, without Qvink, for picture posts or when switched off', async () => {
        t.mock.chat.push(reply('a', { memory: 'A' }));
        t.leader.value = false;
        s.memory.queue(0, [{ code: 'quest' }]);
        await s.memory.flush();
        expect(await s.memory.remember(0, [{ code: 'quest' }])).toBeNull();
        t.leader.value = true;
        t.qvink.present = false;
        expect(await s.memory.remember(0, [{ code: 'quest' }])).toBeNull();
        t.qvink.present = true;
        t.mock.chat.push(reply('', { memory: 'pic' }, { extra: { nai_studio: {}, qvink_memory: { memory: 'pic' } } }));
        expect(await s.memory.remember(1, [{ code: 'quest' }])).toBeNull();
        expect(await s.memory.remember(7, [{ code: 'quest' }])).toBeNull();
        expect(await s.memory.remember(0, [])).toBeNull();
        t.slice().autoMemory = false;
        expect(await s.memory.remember(0, [{ code: 'quest' }])).toBeNull();
        await t.app.bus.emit('signal', signal('quest.added', { messageIndex: 0 }));
        t.slice().autoMemory = true;
        t.autonomy.levels.set(REMEMBER_KIND, 'off');
        expect(await s.memory.remember(0, [{ code: 'quest' }])).toBeNull();
        expect(t.autonomy.proposals).toHaveLength(0);
        expect(qvinkOf(t.mock.chat[0]).remember).toBeUndefined();
    });

    it('waits in the Inbox when asked to, and applies from the card later', async () => {
        t.autonomy.levels.set(REMEMBER_KIND, 'inbox');
        t.mock.chat.push(reply('a', { memory: 'A' }));
        expect(await s.memory.remember(0, [{ code: 'secret' }])).toBe('queued');
        expect(qvinkOf(t.mock.chat[0]).remember).toBeUndefined();
        const payload = JSON.parse(JSON.stringify(t.autonomy.proposals[0]?.payload)) as RememberPayload;
        expect(await t.inbox.valid.get(REMEMBER_KIND)?.(payload)).toBe(true);
        await t.inbox.appliers.get(REMEMBER_KIND)?.(payload);
        expect(qvinkOf(t.mock.chat[0]).remember).toBe(true);
        expect(await t.inbox.valid.get(REMEMBER_KIND)?.(payload)).toBe(false);
        expect(s.memory.remembered()).toEqual([{ messageIndex: 0, reason: 'revealed secret' }]);
        await expect(t.inbox.appliers.get(REMEMBER_KIND)?.({ index: 'x' })).rejects.toThrow();
        // The message changed meanwhile: the card fails.
        (t.mock.chat[0] as STChatMessage).send_date = 'changed';
        await expect(t.inbox.appliers.get(REMEMBER_KIND)?.(payload)).rejects.toThrow(
            'The message has changed or is gone.',
        );
    });

    it('cannot undo a mark whose message changed', async () => {
        t.mock.chat.push(reply('a', { memory: 'A' }));
        await s.memory.remember(0, [{ code: 'quest' }]);
        const record = t.journal.records[0]!;
        (t.mock.chat[0] as STChatMessage).send_date = 'changed';
        expect(await t.journal.undo(record.id)).toBe(false);
        expect(
            await t.journal.handlers.get('m9.remember')!({ target: 'm9.remember', ref: {}, before: null, after: true }),
        ).toBe(false);
    });
});
