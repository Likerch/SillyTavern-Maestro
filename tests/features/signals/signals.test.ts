import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatDocName } from '../../../src/core/chat-store';
import type { SignalsDocData } from '../../../src/domain/signals-doc';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import { signalsModule } from '../../../src/features/signals';
import type { SignalBatch } from '../../../src/features/signals/api';
import type { SignalsService } from '../../../src/features/signals/service';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type { Signal } from '../../../src/shared/contracts';
import { switchChat } from '../../helpers/core-host';
import { batches, createSignalsTestApp, reply, settle, startModule, turn, userMessage } from './helpers';
import type { SignalsTestApp } from './helpers';

let env: SignalsTestApp;
let api: SignalsService;
let stop: (() => Promise<void>) | undefined;
let seen: SignalBatch[];

async function start(): Promise<void> {
    const started = await startModule(env, signalsModule);
    stop = () => started.stop();
    api = env.modules.api<SignalsService>('signals')!;
    seen = batches(api);
    await settle();
}

function stored(): { version: number; data: SignalsDocData } | undefined {
    const text = env.mock.files.get(chatDocName(env.app.files, 'chat-1', 'signals'));
    return text ? (JSON.parse(text) as { version: number; data: SignalsDocData }) : undefined;
}

const kinds = (signals: readonly Signal[]) => signals.map((signal) => signal.kind);

beforeEach(() => {
    env = createSignalsTestApp();
});

afterEach(async () => {
    await stop?.();
    stop = undefined;
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

describe('commit on send', () => {
    it('compares in an idle slot, never on the send path', async () => {
        const requests: { callback: () => void; options?: { timeout?: number } }[] = [];
        const cancelled: number[] = [];
        (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (
            callback: () => void,
            options?: { timeout?: number },
        ) => requests.push({ callback, options });
        (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback = (handle: number) =>
            cancelled.push(handle);
        await start();
        env.mock.chat.push(reply({ characters: [{ name: 'Anna', relationship: 'Neutral' }] }), userMessage());
        const calls = env.neighbours.trackerCalls;
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        // Nothing was read or written while the send handlers ran.
        expect(env.neighbours.trackerCalls).toBe(calls);
        expect(stored()).toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(requests[0]?.options).toEqual({ timeout: 1000 });
        requests[0]!.callback();
        await settle();
        expect(env.neighbours.trackerCalls).toBeGreaterThan(calls);
        expect(stored()?.data.records.map((record) => record.index)).toEqual([0]);
        // A commit whose idle slot never came is cancelled on disable.
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await stop?.();
        stop = undefined;
        expect(cancelled).toEqual([2]);
    });

    it('reports tracker changes of committed turns with entity ids', async () => {
        await start();
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        // The first turn of a chat only sets the baselines.
        expect(env.bus).toEqual([]);
        expect(seen.map((batch) => batch.signals.length)).toEqual([0]);
        const second = await turn(env, { characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        expect(kinds(env.bus)).toEqual(['character.appeared']);
        const third = await turn(env, { characters: [{ name: 'Anna', relationship: 'Friendly' }] });
        const [appeared, changed] = env.bus;
        expect(appeared).toMatchObject({ messageIndex: second, entity: 'character:anna', chatId: 'chat-1' });
        expect(changed).toMatchObject({
            kind: 'relationship.changed',
            chatId: 'chat-1',
            messageIndex: third,
            entity: 'character:anna',
            data: { name: 'Anna', from: 'Neutral', to: 'Friendly' },
        });
        expect(typeof changed!.at).toBe('number');
        expect(seen.at(-1)).toEqual({ messageIndex: third, signals: [changed], folded: 0 });
        expect(api.last()).toEqual(seen.at(-1));
        expect(kinds(api.pending())).toEqual(['character.appeared', 'relationship.changed']);
        expect(api.messagesSinceRevision()).toBe(3);
        expect(stored()?.data.records.map((record) => record.index)).toEqual([0, 2, 4]);
    });

    it('applies the two-turn rule to DES locations and ends the scene', async () => {
        await start();
        await turn(env, { location: 'Rusty Anchor Tavern' });
        await turn(env, { location: 'Rusty Anchor Tavern, Main Hall' });
        await turn(env, { location: 'Old Forest' });
        expect(env.bus).toEqual([]);
        const index = await turn(env, { location: 'Old Forest' });
        expect(env.bus.map((signal) => [signal.kind, signal.messageIndex, signal.data])).toEqual([
            ['location.changed', index, { from: 'Rusty Anchor Tavern, Main Hall', to: 'Old Forest', via: 'des' }],
            ['scene.ended', index, { reasons: ['location'] }],
        ]);
        expect(env.bus[0]?.entity).toBeUndefined();
    });

    it('resolves names and ids through the world model', async () => {
        const anna: Entity = {
            id: 'character:anna',
            kind: 'character',
            name: 'Anna',
            aliases: ['Аня'],
            forms: [],
            sources: [],
        };
        const world: Partial<WorldModelApi> = {
            resolve: (name: string) => (['anna', 'аня'].includes(name.toLowerCase()) ? anna : undefined),
            entities: () => [anna],
        };
        env.modules.expose('world', world);
        await start();
        await turn(env, { characters: [{ name: 'Аня', relationship: 'Neutral' }], main: 'Find the amulet' });
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Hostile' }], main: 'Find the amulet' });
        expect(env.bus.find((signal) => signal.kind === 'relationship.changed')).toMatchObject({
            entity: 'character:anna',
            data: { name: 'Anna', from: 'Neutral', to: 'Hostile' },
        });
        await turn(env, { main: 'Find the amulet', optional: ['Pay the debt'] });
        await turn(env, { main: 'Find the amulet', optional: ['Pay the debt'] });
        expect(env.bus.find((signal) => signal.kind === 'quest.added')).toMatchObject({
            entity: 'quest:pay the debt',
            data: { title: 'Pay the debt', main: false },
        });
    });

    it('reports DES aliases, Qvink memories and new names', async () => {
        env.neighbours.desAliases = { Anna: ['Аня'] };
        env.neighbours.qvink = { 0: { memory: 'Old memory', remember: false } };
        env.neighbours.roster = ['Hale'];
        await start();
        await turn(env, { text: 'They met Marcus near the gate.' });
        expect(env.bus).toEqual([]);
        env.neighbours.desAliases = { Anna: ['Аня', 'Анечка'] };
        env.neighbours.qvink = {
            0: { memory: 'Old memory', remember: true },
            2: { memory: 'Anna found the diary.', remember: false },
        };
        const index = await turn(env, { text: 'Then Marcus and Hale spoke of the inn «Ржавый якорь».' });
        expect(env.bus.map((signal) => [signal.kind, signal.data])).toEqual([
            ['alias.added', { name: 'Anna', aliases: ['Анечка'] }],
            ['memory.added', { items: [{ index: 2, text: 'Anna found the diary.' }] }],
            ['memory.long', { items: [{ index: 0, text: 'Old memory' }] }],
            ['name.new', { name: 'Ржавый якорь', quoted: true }],
            ['name.new', { name: 'Marcus', quoted: false }],
        ]);
        expect(env.bus[0]).toMatchObject({ entity: 'character:anna', messageIndex: index });
        // Without DES and Qvink nothing of theirs is compared.
        env.neighbours.desPresent = false;
        env.neighbours.qvinkPresent = false;
        env.neighbours.desAliases = { Anna: ['Аня', 'Анечка', 'Анька'] };
        await turn(env, { text: 'Nothing new.' });
        expect(kinds(env.bus)).toHaveLength(5);
    });

    it('can be told to skip names', async () => {
        env.settings.module<{ names: boolean }>('signals').names = false;
        await start();
        await turn(env, { text: 'the inn «Ржавый якорь»' });
        await turn(env, { text: 'the inn «Ржавый якорь»' });
        expect(env.bus).toEqual([]);
    });
});

describe('first visit and catch-up', () => {
    it('reads an existing chat silently and counts only new replies', async () => {
        for (let i = 0; i < 6; i++) env.mock.chat.push(reply({ location: i < 3 ? 'Tavern' : 'Forest' }), userMessage());
        await start();
        expect(env.bus).toEqual([]);
        expect(seen).toEqual([]);
        expect(stored()?.data.records.map((record) => record.index)).toEqual([6, 8, 10]);
        expect(stored()?.data).toMatchObject({ initialized: true, consumedUpTo: 10 });
        expect(api.messagesSinceRevision()).toBe(0);
        expect(api.pending()).toEqual([]);
        await turn(env, { location: 'Forest' });
        expect(api.messagesSinceRevision()).toBe(1);
    });

    it('compares the newest reply on the first commit of a chat it has not seen', async () => {
        env.leader.value = false;
        await start();
        env.mock.chat.push(reply({ location: 'Tavern' }), userMessage(), reply({ location: 'Forest' }), userMessage());
        env.mock.chat.push(reply({ location: 'Forest' }), userMessage());
        env.leader.value = true;
        await env.app.bus.emit('turn:committed', { messageIndex: 4 });
        await settle();
        expect(kinds(env.bus)).toEqual(['location.changed', 'scene.ended']);
        expect(stored()?.data.consumedUpTo).toBe(2);
        expect(api.messagesSinceRevision()).toBe(1);
    });

    it('catches up on replies committed while another tab led', async () => {
        await start();
        await turn(env, { location: 'Tavern' });
        env.leader.value = false;
        await turn(env, { location: 'Forest' });
        await turn(env, { location: 'Forest' });
        expect(env.bus).toEqual([]);
        expect(stored()?.data.records.map((record) => record.index)).toEqual([0]);
        env.leader.value = true;
        for (const listener of env.leader.listeners) listener(true);
        await settle();
        expect(kinds(env.bus)).toEqual(['location.changed', 'scene.ended']);
        expect(env.bus[0]?.messageIndex).toBe(4);
        expect(seen.map((batch) => batch.messageIndex)).toEqual([0, 2, 4]);
    });
});

describe('leader only', () => {
    it('never writes or emits in another tab', async () => {
        env.leader.value = false;
        await start();
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Hostile' }] });
        expect(stored()).toBeUndefined();
        expect(env.bus).toEqual([]);
        await api.consume(10);
        expect(stored()).toBeUndefined();
        expect(api.pending()).toEqual([]);
        expect(api.messagesSinceRevision()).toBe(0);
    });
});

describe('consume', () => {
    it('marks signals consumed up to an index', async () => {
        await start();
        await turn(env, { location: 'Tavern' });
        await turn(env, { location: 'Forest' });
        const third = await turn(env, { location: 'Forest' });
        await turn(env, { location: 'Forest', date: 'Day 1' });
        expect(api.pending()).toHaveLength(2);
        expect(api.messagesSinceRevision()).toBe(4);
        await api.consume(third);
        expect(api.pending()).toEqual([]);
        expect(api.messagesSinceRevision()).toBe(1);
        await api.consume(0);
        await api.consume(Number.NaN);
        expect(stored()?.data.consumedUpTo).toBe(third);
    });
});

describe('invalidation', () => {
    it('drops the signals of a swiped reply and of everything after it, exactly', async () => {
        await start();
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        const changed = await turn(env, { characters: [{ name: 'Anna', relationship: 'Hostile' }] });
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Friendly' }] });
        expect(kinds(api.pending())).toEqual(['character.appeared', 'relationship.changed', 'relationship.changed']);
        const busCount = env.bus.length;
        // The user deleted the last two user messages and swiped the reply at `changed`.
        env.mock.chat.splice(changed + 1);
        const message = env.mock.chat[changed]!;
        message.swipe_id = 1;
        (message.extra as { dooms_tracker_swipes: unknown[] }).dooms_tracker_swipes[1] = {
            quests: null,
            infoBox: null,
            characterThoughts: JSON.stringify([{ name: 'Anna', relationship: { status: 'Neutral' } }]),
        };
        await env.app.bus.emit('message:invalidated', { messageIndex: changed, reason: 'swiped' });
        await settle();
        expect(kinds(api.pending())).toEqual(['character.appeared']);
        expect(stored()?.data.records.map((record) => record.index)).toEqual([0, 2]);
        expect(stored()?.data.baseline.chars.anna?.rel).toBe('Neutral');
        expect(env.bus).toHaveLength(busCount);
        // The new swipe is committed: compared against the restored baseline.
        env.mock.chat.push(userMessage());
        await env.app.bus.emit('turn:committed', { messageIndex: changed });
        await settle();
        expect(kinds(api.pending())).toEqual(['character.appeared']);
    });

    it('re-reads an edited reply quietly and keeps consumed signals consumed', async () => {
        await start();
        await turn(env, { characters: [{ name: 'Anna', relationship: 'Neutral' }] });
        const second = await turn(env, { characters: [{ name: 'Anna', relationship: 'Hostile' }] });
        const third = await turn(env, { characters: [{ name: 'Anna', relationship: 'Friendly' }] });
        await api.consume(second);
        const busCount = env.bus.length;
        const batchCount = seen.length;
        // DES re-parsed the edited reply: Anna is still hostile there.
        const extra = env.mock.chat[third]!.extra as { dooms_tracker_swipes: Record<string, unknown>[] };
        extra.dooms_tracker_swipes[0]!.characterThoughts = JSON.stringify([
            { name: 'Anna', relationship: { status: 'Hostile' } },
        ]);
        await env.app.bus.emit('message:invalidated', { messageIndex: third, reason: 'edited' });
        await settle();
        expect(api.pending()).toEqual([]);
        expect(stored()?.data.records.map((record) => record.index)).toEqual([0, second, third]);
        expect(env.bus).toHaveLength(busCount);
        expect(seen).toHaveLength(batchCount);
        // An edit of a user message changes nothing.
        await env.app.bus.emit('message:invalidated', { messageIndex: third + 1, reason: 'edited' });
        await settle();
        expect(stored()?.data.records).toHaveLength(3);
    });

    it('finds replies shifted by a deletion in the middle', async () => {
        await start();
        await turn(env, { location: 'Tavern' });
        await turn(env, { location: 'Forest' });
        const third = await turn(env, { location: 'Forest' });
        expect(kinds(api.pending())).toEqual(['location.changed', 'scene.ended']);
        env.mock.chat.splice(1, 2);
        await env.app.bus.emit('message:invalidated', { messageIndex: env.mock.chat.length, reason: 'deleted' });
        await settle();
        // The forest reply now sits at third - 2 and is read again, quietly.
        expect(stored()?.data.records.map((record) => record.index)).toEqual([0, third - 2]);
        expect(api.pending()).toEqual([]);
    });
});

describe('other modules', () => {
    it('keeps fact.new signals other modules put on the bus for a committed turn', async () => {
        await start();
        await turn(env, { location: 'Tavern' });
        env.mock.chat.push(reply({ location: 'Tavern' }), userMessage());
        // M26 commits first: the signal waits for the turn's record.
        await env.app.bus.emit('signal', {
            kind: 'fact.new',
            chatId: 'chat-1',
            messageIndex: 2,
            at: 1,
            data: { text: 'A feast' },
        });
        await env.app.bus.emit('turn:committed', { messageIndex: 2 });
        await settle();
        // … or after it: appended to the record.
        await env.app.bus.emit('signal', {
            kind: 'fact.new',
            chatId: 'chat-1',
            messageIndex: 2,
            at: 2,
            data: { text: 'A song' },
        });
        await env.app.bus.emit('signal', { kind: 'fact.new', chatId: 'other', messageIndex: 2, at: 3 });
        await env.app.bus.emit('signal', { kind: 'quality.bad', chatId: 'chat-1', messageIndex: 2, at: 4 });
        await env.app.bus.emit('signal', { kind: 'fact.new', chatId: 'chat-1', at: 5 });
        // A consumer's own output (the revision marks it with its source) is never pending.
        await env.app.bus.emit('signal', {
            kind: 'fact.new',
            chatId: 'chat-1',
            messageIndex: 2,
            at: 6,
            data: { source: 'revision', text: 'From the revision' },
        });
        await env.app.bus.emit('signal', {
            kind: 'memory.important',
            chatId: 'chat-1',
            messageIndex: 2,
            at: 7,
            data: { source: 'revision' },
        });
        await settle();
        expect(api.pending().map((signal) => signal.data?.text)).toEqual(['A feast', 'A song']);
        expect(seen.at(-1)?.signals).toEqual([]);
        // Signals of this service carry no source.
        const own = stored()!.data.records.flatMap((record) => record.signals);
        expect(own.filter((signal) => signal.data && 'source' in signal.data)).toEqual([]);
    });

    it('takes place changes from the place registry when it is on', async () => {
        let enter: ((place: Place | null, previous: Place | null) => void) | undefined;
        const place = (id: string, name: string): Place => ({
            id,
            name,
            aliases: [],
            forms: [],
            parent: null,
            createdAt: 0,
            firstSeen: 0,
            lastSeen: 0,
            visits: [],
        });
        const places: Partial<PlacesApi> = {
            onEnter: (listener) => {
                enter = listener;
                return () => {
                    enter = undefined;
                };
            },
            list: () => [place('p-1', 'Tavern'), place('p-2', 'Forest')],
            resolve: () => undefined,
        };
        env.modules.expose('places', places);
        await start();
        expect(enter).toBeDefined();
        await turn(env, { location: 'Tavern' });
        // Registry reports before the comparison ran.
        env.mock.chat.push(reply({ location: 'Forest' }), userMessage());
        await env.app.bus.emit('turn:committed', { messageIndex: 2 });
        enter!(place('p-2', 'Forest'), place('p-1', 'Tavern'));
        await settle();
        expect(env.bus.map((signal) => [signal.kind, signal.entity, signal.data])).toEqual([
            [
                'location.changed',
                'place:p-2',
                { from: 'Tavern', to: 'Forest', placeId: 'p-2', previousPlaceId: 'p-1', via: 'places' },
            ],
            ['scene.ended', undefined, { reasons: ['location'] }],
        ]);
        // … and after it: a late batch for the same turn.
        const index = await turn(env, { location: 'Tavern' });
        enter!(place('p-1', 'Tavern'), place('p-2', 'Forest'));
        await settle();
        expect(seen.at(-1)).toMatchObject({ messageIndex: index, late: true, folded: 0 });
        expect(kinds(seen.at(-1)!.signals)).toEqual(['location.changed', 'scene.ended']);
        expect(kinds(api.pending()).filter((kind) => kind === 'location.changed')).toHaveLength(2);
        // Enter events outside a commit (chat open, manual edits) are ignored.
        enter!(place('p-2', 'Forest'), null);
        enter!(place('p-2', 'Forest'), place('p-2', 'Forest'));
        await env.app.bus.emit('message:invalidated', { messageIndex: 99, reason: 'deleted' });
        enter!(place('p-2', 'Forest'), place('p-1', 'Tavern'));
        await settle();
        expect(kinds(api.pending()).filter((kind) => kind === 'location.changed')).toHaveLength(2);
    });
});

describe('lifecycle', () => {
    it('starts over on another chat and leaves nothing when disabled', async () => {
        await start();
        await turn(env, { location: 'Tavern' });
        await turn(env, { location: 'Forest' });
        await turn(env, { location: 'Forest' });
        expect(api.pending()).toHaveLength(2);
        env.mock.chat = [];
        await switchChat(env.mock, 'chat-2');
        await settle();
        expect(api.pending()).toEqual([]);
        expect(api.last()).toBeNull();
        expect(env.ui.tabs.map((tab) => tab.id)).toEqual(['signals']);
        await stop?.();
        stop = undefined;
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        const count = env.bus.length;
        env.mock.chat.push(reply({ location: 'A' }), userMessage());
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await settle();
        expect(env.bus).toHaveLength(count);
    });

    it('works without a chat or with a broken document', async () => {
        env.mock.chatId = undefined;
        await start();
        expect(api.pending()).toEqual([]);
        expect(api.messagesSinceRevision()).toBe(0);
        expect(api.last()).toBeNull();
        await api.consume(3);
        env.mock.files.set(
            chatDocName(env.app.files, 'chat-2', 'signals'),
            JSON.stringify({ schema: 1, version: 1, data: { records: 'x' } }),
        );
        await switchChat(env.mock, 'chat-2');
        await settle();
        expect(api.pending()).toEqual([]);
        expect(api.last()).toBeNull();
    });
});
