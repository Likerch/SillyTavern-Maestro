import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SET_KIND, STATE_DOC_KIND, THRESHOLD_SIGNAL, VALUE_UNDO_TARGET } from '../../../src/features/mechanics/state';
import { createMechanicsEnv, healthDef, magicDef, reply, reputationDef, userMessage } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

let env: MechanicsEnv;

beforeEach(async () => {
    vi.useFakeTimers();
    env = createMechanicsEnv();
    env.defs.defs = [magicDef(), healthDef(), reputationDef()];
    await env.start({ tracking: false });
});

afterEach(() => {
    env.stop();
    vi.useRealTimers();
});

const user = (attribute: string, value: number | string | string[], holder = 'Kai') => ({
    mechanicId: 'magic',
    holder,
    attribute,
    value,
    source: 'user' as const,
    messageIndex: -1,
});

describe('MechanicState: values', () => {
    it('applies a user edit, journals it and undoes it', async () => {
        const applied = await env.state.apply([user('Mana', 30, 'кай')]);
        expect(applied).toEqual([
            expect.objectContaining({
                holder: 'Kai',
                attribute: 'mana',
                from: 50,
                to: 30,
                source: 'user',
                messageIndex: -1,
            }),
        ]);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(30);
        expect(env.state.value('magic', 'Кай', 'Mana')).toBe(30);
        expect(env.state.history()).toHaveLength(1);
        const record = env.journal.records[0]!;
        expect(record).toMatchObject({ module: 'M25', kind: SET_KIND, summary: 'Mechanics: Kai · Мана = 30' });
        expect(record.changes[0]).toMatchObject({ target: VALUE_UNDO_TARGET, before: 50, after: 30 });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
        expect(env.state.history()).toEqual([]);
    });

    it('journals several edits once and undoes a number edit followed by another change as a difference', async () => {
        await env.state.apply([user('mana', 40), user('schools', 'fire, water')]);
        expect(env.journal.records[0]?.summary).toBe('Mechanics: 2 values changed by hand');
        await env.state.apply([{ ...user('mana', -5), source: 'block', messageIndex: 3, delta: true }]);
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(45);
        expect(env.state.value('magic', 'Kai', 'schools')).toEqual([]);
    });

    it('refuses bad user edits with a reason and drops bad tracked changes quietly', async () => {
        await expect(env.state.apply([user('mana', 'lots')])).rejects.toThrow(
            'The value was not changed: the value does not fit the attribute.',
        );
        await expect(env.state.apply([{ ...user('mana', 1), mechanicId: 'nope' }])).rejects.toThrow('not in this chat');
        await expect(env.state.apply([{ ...user('standing', 'liked', 'Elves'), mechanicId: 'rep' }])).rejects.toThrow(
            'does not take part',
        );
        await expect(env.state.apply([user('luck', 1)])).rejects.toThrow('no such attribute');
        expect(await env.state.apply([{ ...user('mana', 'lots'), source: 'block', messageIndex: 1 }])).toEqual([]);
        expect(await env.state.apply([user('mana', 50)])).toEqual([]);
        expect(await env.state.apply([])).toEqual([]);
    });

    it('writes tracked changes in the leader tab only; the user edits anywhere', async () => {
        env.leader.value = false;
        expect(await env.state.apply([{ ...user('mana', 10), source: 'block', messageIndex: 1 }])).toEqual([]);
        await expect(
            env.state.apply([{ ...user('mana', 10), source: 'background', messageIndex: 1 }]),
        ).resolves.toEqual([]);
        expect(await env.state.apply([user('mana', 10)])).toHaveLength(1);
        await expect(
            env.state.apply([{ ...user('mana', 9), source: 'block', messageIndex: 1 }, user('mana', 8)]),
        ).resolves.toHaveLength(1);
    });

    it('fires threshold events once, signals them and keeps them pending until delivered', async () => {
        await env.state.apply([{ ...user('mana', 0), source: 'block', messageIndex: 4 }]);
        await env.tick();
        expect(env.signals).toEqual([
            expect.objectContaining({
                kind: THRESHOLD_SIGNAL,
                chatId: 'chat-1',
                messageIndex: 4,
                entity: 'Kai',
                data: {
                    mechanicId: 'magic',
                    holder: 'Kai',
                    attribute: 'mana',
                    eventId: 'empty',
                    text: 'Kai has no mana left.',
                },
            }),
        ]);
        const pending = env.state.pendingEvents();
        expect(pending.map((event) => event.text)).toEqual(['Kai has no mana left.']);
        expect(env.state.events()).toHaveLength(1);
        await env.state.markEventsDelivered(pending);
        expect(env.state.pendingEvents()).toEqual([]);
        await env.state.apply([user('mana', 0, 'Mira')]);
        expect(env.state.pendingEvents()).toHaveLength(1);
        await env.state.markEventsDelivered([]);
        await env.state.markEventsDelivered([{ ...pending[0]!, eventId: 'other' }]);
        expect(env.state.pendingEvents()).toHaveLength(1);
    });

    it('keeps the state per chat in its Maestro file', async () => {
        await env.state.apply([user('mana', 20)]);
        const stored = [...env.mock.files.entries()].find(([name]) => name.includes(STATE_DOC_KIND));
        expect(stored?.[1]).toContain('"mana":20');
        await env.switchTo('chat-2');
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
        await env.switchTo(undefined);
        expect(env.state.state()).toEqual([]);
        await expect(env.state.apply([user('mana', 1)])).rejects.toThrow('No chat is open.');
        expect(await env.state.apply([{ ...user('mana', 1), source: 'block', messageIndex: 1 }])).toEqual([]);
        await env.switchTo('chat-1');
        await env.state.load();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(20);
    });
});

describe('MechanicState: the scene', () => {
    it('takes present characters from the last DES tracker, canonical names, the persona when included', () => {
        env.mock.chat.push(
            reply('old', [{ name: 'Boris' }]),
            userMessage(),
            reply('now', [{ name: 'Кай' }, { name: 'Mira', offScene: true }, { name: 'Lena' }]),
            userMessage(),
            reply('no tracker'),
        );
        expect(env.state.holdersInScene(magicDef())).toEqual(['Kai', 'Lena', 'Алекс']);
        expect(env.state.holdersInScene(healthDef())).toEqual(['Kai', 'Lena']);
        expect(env.state.holdersInScene(magicDef({ holders: { kind: 'persona' } }))).toEqual(['Алекс']);
        expect(env.state.holdersInScene(magicDef({ holders: { kind: 'world' } }))).toEqual(['world']);
        expect(env.state.holdersInScene(reputationDef())).toEqual(['Guild', 'Crown']);
        expect(
            env.state.holdersInScene(magicDef({ holders: { kind: 'named', names: ['Мира', 'Kai', 'Alex', 'Zed'] } })),
        ).toEqual(['Kai', 'Alex']);
        // Cached parse of the same tracker.
        expect(env.state.holdersInScene(healthDef())).toEqual(['Kai', 'Lena']);
    });

    it('falls back to the card character, or the group members, without DES', () => {
        env.des.available = false;
        env.mock.chat.push(reply('x', [{ name: 'Lena' }]));
        expect(env.state.holdersInScene(healthDef())).toEqual(['Kai']);
        env.host.group = true;
        (env.mock.context as unknown as { groupId: string }).groupId = 'g1';
        (env.mock.context as unknown as { groups: unknown[] }).groups = [
            { id: 'g1', name: 'G', members: ['a.png', 'b.png'] },
        ];
        (env.mock.context as unknown as { characters: unknown[] }).characters = [
            { name: 'Kai', avatar: 'a.png' },
            { name: 'Мира', avatar: 'b.png' },
        ];
        expect(env.state.holdersInScene(healthDef())).toEqual(['Kai', 'Mira']);
        env.mock.context.name1 = '';
        expect(env.state.holdersInScene(magicDef({ holders: { kind: 'persona' } }))).toEqual([]);
    });

    it('lists stored holders and the scene holders with initial values', async () => {
        env.mock.chat.push(reply('now', [{ name: 'Kai' }, { name: 'Mira' }]));
        await env.state.apply([user('mana', 10)]);
        const all = env.state.state();
        expect(all).toContainEqual({
            mechanicId: 'magic',
            holder: 'Kai',
            values: { mana: 10, schools: [] },
            updatedAt: -1,
        });
        expect(all).toContainEqual({
            mechanicId: 'magic',
            holder: 'Mira',
            values: { mana: 50, schools: [] },
            updatedAt: -1,
        });
        expect(all).toContainEqual({
            mechanicId: 'health',
            holder: 'Mira',
            values: { hp: 100, stamina: 10 },
            updatedAt: -1,
        });
        expect(env.state.state('mira').every((item) => item.holder === 'Mira')).toBe(true);
        expect(env.state.state('Kai').find((item) => item.mechanicId === 'magic')?.values.mana).toBe(10);
        expect(env.state.value('nope', 'Kai', 'mana')).toBeNull();
        expect(env.state.value('magic', 'Zed', 'mana')).toBe(50);
    });
});

describe('MechanicState: invalidation', () => {
    async function seed(): Promise<void> {
        env.mock.chat.push(reply('a'), userMessage(), reply('b'), userMessage(), reply('c'));
        await env.state.apply([{ ...user('mana', -10), delta: true, source: 'block', messageIndex: 0 }]);
        await env.state.apply([{ ...user('mana', -10), delta: true, source: 'block', messageIndex: 2 }]);
        await env.state.apply([user('schools', 'fire')]);
        await env.state.apply([{ ...user('mana', -10), delta: true, source: 'background', messageIndex: 4 }]);
    }

    it('takes a swiped or deleted reply back, from that message on', async () => {
        await seed();
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'swiped' });
        await env.tick();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(30);
        await env.app.bus.emit('message:invalidated', { messageIndex: 1, reason: 'deleted' });
        await env.tick();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        expect(env.state.value('magic', 'Kai', 'schools')).toEqual(['fire']);
    });

    it('takes back an edit of the latest committed reply only', async () => {
        await seed();
        await env.app.bus.emit('message:invalidated', { messageIndex: 0, reason: 'edited' });
        await env.tick();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(20);
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'edited' });
        await env.tick();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(30);
    });

    it('does nothing in another tab, and a journal undo of a gone change is fine', async () => {
        await env.state.apply([user('mana', 5)]);
        await env.app.bus.emit('message:invalidated', { messageIndex: 0, reason: 'deleted' });
        env.leader.value = false;
        await env.state.apply([{ ...user('mana', 1), source: 'check', messageIndex: 3 }]);
        await env.app.bus.emit('message:invalidated', { messageIndex: 0, reason: 'deleted' });
        await env.tick();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(1);
        const handler = env.journal.handlers.get(VALUE_UNDO_TARGET)!;
        expect(
            await handler({
                target: VALUE_UNDO_TARGET,
                ref: { chatId: 'chat-1', changeId: 'gone' },
                before: 1,
                after: 2,
            }),
        ).toBe(true);
        expect(
            await handler({ target: VALUE_UNDO_TARGET, ref: { chatId: 'chat-9', changeId: 'x' }, before: 1, after: 2 }),
        ).toBe(false);
        expect(await handler({ target: VALUE_UNDO_TARGET, ref: {}, before: 1, after: 2 })).toBe(false);
        const located = await handler({
            target: VALUE_UNDO_TARGET,
            ref: {
                chatId: 'chat-1',
                mechanicId: 'magic',
                holder: 'kai',
                attribute: 'mana',
                messageIndex: 3,
                source: 'check',
            },
            before: 5,
            after: 1,
        });
        expect(located).toBe(true);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(5);
    });

    it('notifies listeners and stops after dispose', async () => {
        const seen = vi.fn();
        const off = env.state.onChange(seen);
        await env.state.apply([user('mana', 5)]);
        expect(seen).toHaveBeenCalled();
        env.defs.emit();
        off();
        env.stop();
        env.stop();
        expect(await env.state.apply([user('mana', 6)])).toEqual([]);
        await env.state.settled();
    });
});
