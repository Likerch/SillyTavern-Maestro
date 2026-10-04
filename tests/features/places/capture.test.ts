import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatDocName } from '../../../src/core/chat-store';
import { placesModule } from '../../../src/features/places';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import type { MergePayload } from '../../../src/features/places/service';
import { switchChat } from '../../helpers/core-host';
import { createPlacesTestApp, reply, settle, startModule, turn, userMessage } from './helpers';
import type { PlacesTestApp } from './helpers';

let env: PlacesTestApp;
let places: Required<PlacesApi>;
let stop: () => Promise<void>;

async function start(): Promise<void> {
    const started = await startModule(env, placesModule);
    stop = () => started.stop();
    places = env.modules.api<Required<PlacesApi>>('places')!;
    await settle();
}

function named(name: string): Place {
    const found = places.list().find((place) => place.name === name);
    if (!found) throw new Error(`no place ${name}`);
    return found;
}

beforeEach(() => {
    env = createPlacesTestApp();
});

afterEach(async () => {
    await stop?.();
});

describe('capture on committed turns', () => {
    it('creates a place after two turns in a row, nested, with visits and present characters', async () => {
        await start();
        const entered: [string | null, string | null][] = [];
        places.onEnter((place, previous) => entered.push([place?.name ?? null, previous?.name ?? null]));
        await turn(env, 'Main Hall, Rusty Anchor Tavern', { characters: [{ name: 'Ann' }] });
        expect(places.list()).toEqual([]);
        expect(places.candidates()).toMatchObject([
            { label: 'Main Hall, Rusty Anchor Tavern', seen: [0], key: 'main hall' },
        ]);
        expect(places.current()).toBeNull();

        await turn(env, 'Main Hall, Rusty Anchor Tavern', {
            characters: [
                { name: 'Ann' },
                { name: 'Bob', present: false },
                { name: 'Cid', thoughts: 'He is off-scene.' },
            ],
            date: 'Day 1',
            time: '18:00',
            events: ['They arrived'],
        });
        const inn = named('Rusty Anchor Tavern');
        const hall = named('Main Hall');
        expect(hall.parent).toBe(inn.id);
        expect(hall.id).toMatch(/^p-[0-9a-z]{6}$/);
        expect(places.current()?.id).toBe(hall.id);
        expect(hall.visits).toEqual([
            { from: 0, to: null, present: ['Ann'], storyDate: 'Day 1, 18:00', events: ['They arrived'] },
        ]);
        expect(hall).toMatchObject({ firstSeen: 0, lastSeen: 2 });
        expect(places.candidates()).toEqual([]);
        expect(entered).toEqual([['Main Hall', null]]);
        expect(places.path(hall.id)).toEqual(['Rusty Anchor Tavern', 'Main Hall']);
        expect(places.resolve('main hall (rusty anchor tavern)')?.id).toBe(hall.id);
        expect(places.resolve('Nowhere')).toBeUndefined();
        expect(places.get('nope')).toBeUndefined();

        // The registry is a per-chat document.
        const stored = JSON.parse(env.mock.files.get(chatDocName(env.app.files, 'chat-1', 'places'))!) as {
            data: { places: Place[] };
        };
        expect(stored.data.places.map((place) => place.name).sort()).toEqual(['Main Hall', 'Rusty Anchor Tavern']);

        // DES drops the room for a turn: the stay goes on in the hall.
        await turn(env, 'Rusty Anchor Tavern', { characters: [{ name: 'Dee' }] });
        expect(places.current()?.id).toBe(hall.id);
        expect(named('Main Hall')).toMatchObject({
            lastSeen: 4,
            visits: [{ from: 0, to: null, present: ['Ann', 'Dee'] }],
        });
        // A new room of the tavern: the hall's stay ends, the tavern is current until the room holds.
        await turn(env, 'Rusty Anchor Tavern, Kitchen');
        expect(places.current()?.id).toBe(inn.id);
        expect(named('Main Hall').visits[0]?.to).toBe(4);
        expect(entered.at(-1)).toEqual(['Rusty Anchor Tavern', 'Main Hall']);
    });

    it('reads Russian labels, case forms and canonical names', async () => {
        env.neighbours.desruApi = {
            version: 1,
            nameForms: (name: string) => (name === 'библиотека' ? ['библиотека', 'библиотеки', 'библиотеке'] : [name]),
        };
        env.neighbours.desAliases = { Anna: ['Аня'] };
        env.neighbours.qvink = {
            2: { memory: 'Аня нашла дневник.', remember: true, include: 'long' },
            0: { memory: 'Short memory', remember: false, include: 'short' },
        };
        await start();
        await turn(env, 'Особняк Волковых, библиотека', { characters: [{ name: 'Аня' }] });
        await turn(env, 'Особняк Волковых, библиотека', { characters: [{ name: 'Аня' }], events: ['Нашли дневник'] });
        const mansion = named('Особняк Волковых');
        const library = named('библиотека');
        expect(library.parent).toBe(mansion.id);
        expect(library.forms).toEqual(['библиотеки', 'библиотеке']);
        expect(library.visits[0]).toMatchObject({ present: ['Anna'], events: ['Нашли дневник', 'Аня нашла дневник.'] });
        expect(places.resolve('библиотеке')?.id).toBe(library.id);
        await turn(env, 'Особняк Волковых — библиотеке');
        expect(places.current()?.id).toBe(library.id);
    });

    it('sends a look-alike to the Inbox and applies the card', async () => {
        await start();
        const inn = await places.create('Rusty Anchor Tavern');
        await turn(env, 'Rusty Anchor');
        await turn(env, 'Rusty Anchor');
        expect(places.list()).toHaveLength(1);
        const proposal = env.autonomy.proposals.find((item) => item.kind === 'places.merge');
        expect(proposal).toMatchObject({
            module: 'M24',
            title: '«Rusty Anchor» may be «Rusty Anchor Tavern»',
            sourceMessage: 2,
            payload: { key: 'rusty anchor', target: inn.id, name: 'Rusty Anchor', index: 2 },
        });
        expect(proposal?.changes[0]).toMatchObject({ target: 'places.place', ref: { id: inn.id } });
        expect(places.candidates()[0]).toMatchObject({ proposed: true, similar: [inn.id] });
        // Not proposed again on the next turn.
        await turn(env, 'Rusty Anchor');
        expect(env.autonomy.proposals.filter((item) => item.kind === 'places.merge')).toHaveLength(1);

        const applier = env.inbox.appliers.get('places.merge')!;
        await applier(proposal!.payload as MergePayload);
        await settle();
        expect(named('Rusty Anchor Tavern').aliases).toEqual(['Rusty Anchor']);
        expect(places.current()?.id).toBe(inn.id);
        expect(places.candidates()).toEqual([]);
        expect(await proposal!.stillValid!()).toBe(false);
        await expect(applier({ nope: true })).rejects.toThrow('This place (or name) is gone.');
    });

    it('makes a separate place when the card is rejected', async () => {
        await start();
        await places.create('Rusty Anchor Tavern');
        await turn(env, 'Rusty Anchor');
        await turn(env, 'Rusty Anchor');
        const proposal = env.autonomy.proposals.find((item) => item.kind === 'places.merge')!;
        const reject = env.inbox.rejecters.get('places.merge')!;
        await reject(proposal.payload);
        await settle();
        expect(
            places
                .list()
                .map((place) => place.name)
                .sort(),
        ).toEqual(['Rusty Anchor', 'Rusty Anchor Tavern']);
        expect(places.current()?.name).toBe('Rusty Anchor');
        expect(places.candidates()).toEqual([]);
        // A second reject (or one for a card that is out of date) does nothing.
        await reject(proposal.payload);
        await reject(null);
        expect(places.list()).toHaveLength(2);
    });

    it('applies the merge at once when the autonomy level is auto', async () => {
        env.autonomy.levels.set('places.merge', 'auto');
        await start();
        const inn = await places.create('Rusty Anchor Tavern');
        await turn(env, 'The Rusty Anchor');
        await turn(env, 'The Rusty Anchor');
        await settle();
        expect(named('Rusty Anchor Tavern').aliases).toEqual(['The Rusty Anchor']);
        expect(places.current()?.id).toBe(inn.id);
        expect(env.journal.records.at(-1)).toMatchObject({ kind: 'places.merge' });
    });

    it('rolls back what a swiped or deleted reply changed', async () => {
        await start();
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        expect(named('Inn').visits).toHaveLength(1);
        await turn(env, 'Forest');
        // An unknown place: the current place is unknown until «Forest» holds for another turn.
        expect(places.current()).toBeNull();
        expect(named('Inn').visits).toEqual([{ from: 0, to: 2, present: [], events: [] }]);

        // The user deletes their message: the reply stays as it was committed.
        env.mock.chat.pop();
        await env.app.bus.emit('message:invalidated', { messageIndex: env.mock.chat.length, reason: 'deleted' });
        await settle();
        expect(places.candidates().map((candidate) => candidate.key)).toEqual(['forest']);
        // Then swipes it: the committed variant is gone, and so is what it changed.
        const swiped = env.mock.chat[4]!;
        swiped.swipe_id = 1;
        (swiped.extra!.dooms_tracker_swipes as unknown[])[1] = { quests: null, infoBox: null, characterThoughts: null };
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'swiped' });
        await settle();
        expect(places.candidates()).toEqual([]);
        expect(places.current()?.name).toBe('Inn');
        expect(named('Inn').visits).toEqual([{ from: 0, to: null, present: [], events: [] }]);

        // Deleting the last two messages un-commits the turn that created the place.
        env.mock.chat.splice(2);
        env.mock.chat.pop();
        await env.app.bus.emit('message:invalidated', { messageIndex: env.mock.chat.length, reason: 'deleted' });
        await settle();
        expect(places.list()).toEqual([]);
        expect(places.current()).toBeNull();
        expect(places.candidates()).toMatchObject([{ key: 'inn', seen: [0] }]);
    });

    it('replays after a message in the middle is deleted or edited', async () => {
        await start();
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        await turn(env, 'Forest');
        await turn(env, 'Forest');
        expect(places.current()?.name).toBe('Forest');
        // Delete the reply at 2 and its answer: «Forest» moves to 2 and 4.
        env.mock.chat.splice(2, 2);
        await env.app.bus.emit('message:invalidated', { messageIndex: env.mock.chat.length, reason: 'deleted' });
        await settle();
        expect(places.list().map((place) => place.name)).toEqual(['Forest']);
        expect(places.candidates().map((candidate) => candidate.key)).toEqual(['inn']);

        // DES's tracker of a reply was edited in place: an edit event replays from there.
        const swipes = env.mock.chat[4]!.extra!.dooms_tracker_swipes as { infoBox: string }[];
        swipes[0]!.infoBox = JSON.stringify({ location: { value: 'Cave' } });
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'edited' });
        await settle();
        expect(places.list()).toEqual([]);
        expect(
            places
                .candidates()
                .map((candidate) => candidate.key)
                .sort(),
        ).toEqual(['cave', 'forest', 'inn']);

        // An edited user message changes nothing.
        const before = JSON.stringify(places.candidates());
        await env.app.bus.emit('message:invalidated', { messageIndex: 1, reason: 'edited' });
        await settle();
        expect(JSON.stringify(places.candidates())).toBe(before);
    });

    it('keeps place ids when a reply is edited without moving the location', async () => {
        await start();
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        const id = named('Inn').id;
        env.mock.chat[2]!.mes = 'A fixed typo';
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'edited' });
        await settle();
        expect(named('Inn').id).toBe(id);
        expect(named('Inn').visits).toEqual([{ from: 0, to: null, present: [], events: [] }]);
    });

    it('works only in the leader tab and catches up when it becomes the leader', async () => {
        env.leader.value = false;
        await start();
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        expect(places.list()).toEqual([]);
        env.leader.value = true;
        for (const listener of env.leader.listeners) listener(true);
        await settle();
        expect(places.list().map((place) => place.name)).toEqual(['Inn']);
    });

    it('bootstraps from the last committed replies of an existing chat', async () => {
        env.settings.module<{ bootstrapTurns: number }>('places').bootstrapTurns = 2;
        env.mock.chat.push(reply('Old Mill'), userMessage(), reply('Old Mill'), userMessage());
        env.mock.chat.push(reply('Inn'), userMessage(), reply('Inn'), userMessage(), reply('Inn'));
        await start();
        expect(places.list().map((place) => place.name)).toEqual(['Inn']);
        expect(places.current()?.name).toBe('Inn');
        expect(named('Inn').visits[0]).toMatchObject({ from: 4, to: null });
    });

    it('keeps each chat apart', async () => {
        await start();
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        const entered: (string | null)[] = [];
        places.onEnter((place) => entered.push(place?.name ?? null));
        env.mock.chat = [reply('Cave'), userMessage(), reply('Cave'), userMessage()];
        await switchChat(env.mock, 'chat-2');
        await env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        await settle();
        expect(places.list().map((place) => place.name)).toEqual(['Cave']);
        expect(entered).toEqual(['Cave']);
        await switchChat(env.mock, undefined);
        await env.app.bus.emit('chat:changed', { chatId: null });
        await settle();
        expect(places.list()).toEqual([]);
        expect(places.current()).toBeNull();
    });

    it('retries a write over a newer version from another tab', async () => {
        await start();
        await places.create('Mine');
        const name = chatDocName(env.app.files, 'chat-1', 'places');
        const stored = JSON.parse(env.mock.files.get(name)!) as { version: number; data: { places: unknown[] } };
        stored.version += 5;
        stored.data.places.push({ id: 'other', name: 'Other tab', aliases: [], forms: [], parent: null, visits: [] });
        env.mock.files.set(name, JSON.stringify(stored));
        await places.create('Second');
        expect(places.list().map((place) => place.name)).toEqual(['Mine', 'Other tab', 'Second']);
    });
});
