import { describe, expect, it } from 'vitest';
import {
    PLACES_LIMITS,
    PlacesError,
    addPlace,
    applyCapture,
    cleanAliases,
    collectForms,
    committedIndices,
    copyPlace,
    createCandidatePlace,
    dismissCandidate,
    emptyPlacesDoc,
    firstStaleRecord,
    flattenTree,
    lastRecordIndex,
    mergeCandidate,
    mergePlaces,
    normalizePlacesDoc,
    placeTree,
    reinsertPlace,
    removePlace,
    restorePlaceFields,
    rollbackFrom,
    updatePlace,
} from '../../src/domain/places-registry';
import type { CaptureDeps, CaptureInput, PlaceData, PlacesDocData } from '../../src/domain/places-registry';

function deps(): CaptureDeps & { count: number } {
    const state = {
        count: 0,
        newId: () => `p${++state.count}`,
        forms: (name: string) => (name === 'Таверна' ? ['Таверна', 'Таверны', 'Таверне'] : [name]),
    };
    return state;
}

function input(index: number, label: string | null, extra: Partial<CaptureInput> = {}): CaptureInput {
    return { index, stamp: `s${index}`, label, present: [], events: [], now: 1000 + index, ...extra };
}

function byName(doc: PlacesDocData, name: string): PlaceData {
    const found = doc.places.find((place) => place.name === name);
    if (!found) throw new Error(`no place ${name}`);
    return found;
}

describe('normalizePlacesDoc', () => {
    it('reads garbage as an empty registry', () => {
        expect(normalizePlacesDoc(null)).toEqual(emptyPlacesDoc());
        expect(normalizePlacesDoc({ places: 'x', candidates: 3, log: {} })).toEqual(emptyPlacesDoc());
    });

    it('repairs references, cycles and open visits', () => {
        const doc = normalizePlacesDoc({
            places: [
                {
                    id: 'a',
                    name: ' A ',
                    parent: 'b',
                    visits: [
                        { from: 1, to: null },
                        { from: 3, to: null },
                    ],
                    lastSeen: 4,
                },
                { id: 'b', name: 'B', parent: 'a', entry: { world: 'W', uid: 2 }, state: { time: 'night', n: 1 } },
                { id: 'c', name: 'C', parent: 'gone', passportId: 'pp', background: 'bg.png' },
                { id: 'a', name: 'dup' },
                { id: 'd', name: '' },
                { name: 'no id' },
                'junk',
            ],
            candidates: [
                { key: 'x', name: 'X', seen: [1, 'b'], proposed: true },
                { key: 'x', name: 'X again' },
                { name: 'no key' },
            ],
            current: 'a',
            log: [
                {
                    index: 5,
                    stamp: 's',
                    label: 'L',
                    candidate: 'x',
                    present: ['Ann'],
                    storyDate: 'd',
                    before: {
                        current: 'a',
                        places: { a: { firstSeen: 1, lastSeen: 2, tail: null }, n: null },
                        candidates: { x: null, y: { key: 'y', name: 'Y' } },
                    },
                },
                { index: 2, before: {} },
                { index: 'bad' },
            ],
            dismissed: ['z', 3],
        });
        expect(doc.places.map((place) => place.id)).toEqual(['a', 'b', 'c']);
        expect(doc.places[0]?.name).toBe('A');
        expect(doc.places.filter((place) => place.parent !== null)).toHaveLength(1);
        expect(doc.places[2]).toMatchObject({ parent: null, passportId: 'pp', background: 'bg.png' });
        expect(doc.places[1]?.entry).toEqual({ world: 'W', uid: 2 });
        expect(doc.places[1]?.state).toEqual({ time: 'night' });
        expect(doc.places[0]?.visits).toEqual([
            { from: 1, to: 4, present: [], events: [] },
            { from: 3, to: null, present: [], events: [] },
        ]);
        expect(doc.candidates).toEqual([
            {
                key: 'x',
                label: 'X',
                name: 'X',
                seen: [1],
                similar: [],
                parent: null,
                chain: [],
                proposed: true,
                createdAt: 0,
            },
        ]);
        expect(doc.log.map((record) => record.index)).toEqual([2, 5]);
        expect(doc.log[1]).toMatchObject({ candidate: 'x', present: ['Ann'], storyDate: 'd' });
        expect(doc.log[1]?.before.places).toEqual({ a: { firstSeen: 1, lastSeen: 2, tail: null }, n: null });
        expect(doc.log[1]?.before.candidates.y?.key).toBe('y');
        expect(doc.dismissed).toEqual(['z']);
    });
});

describe('names', () => {
    it('cleans aliases and collects forms', () => {
        expect(cleanAliases('Inn', ['inn', ' The  Anchor ', 'anchor', '', 'Anchor'])).toEqual(['The Anchor']);
        expect(collectForms('Таверна', ['Якорь'], deps().forms)).toEqual(['Таверны', 'Таверне']);
        expect(
            collectForms(
                'A',
                [],
                () => {
                    throw new Error('boom');
                },
                ['B', 'a', 'B'],
            ),
        ).toEqual(['B']);
        expect(collectForms('A', [], () => 'not a list' as unknown as string[])).toEqual([]);
    });
});

describe('committedIndices', () => {
    it('reports the last assistant reply before each user message', () => {
        const a = { is_user: false };
        const u = { is_user: true };
        const s = { is_user: false, is_system: true };
        expect(committedIndices([a, u, a, a, u, u, s, a])).toEqual([0, 3]);
        expect(committedIndices([u, null, a, s, u, a])).toEqual([2]);
        expect(committedIndices([])).toEqual([]);
    });
});

describe('capture', () => {
    it('applies the two-turn rule, nests containers and keeps visits', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const first = applyCapture(doc, input(1, 'Main Hall, Rusty Anchor Tavern', { present: ['Ann'] }), d);
        expect(first).toEqual({ changed: true, created: [], proposals: [] });
        expect(doc.places).toEqual([]);
        expect(doc.candidates[0]).toMatchObject({ key: 'main hall', seen: [1], chain: ['Rusty Anchor Tavern'] });

        const second = applyCapture(
            doc,
            input(3, 'Main Hall, Rusty Anchor Tavern', {
                present: ['Ann', 'Bob'],
                storyDate: 'Day 1',
                events: ['Arrived'],
            }),
            d,
        );
        expect(second.created).toEqual(['p1', 'p2']);
        const inn = byName(doc, 'Rusty Anchor Tavern');
        const hall = byName(doc, 'Main Hall');
        expect(hall.parent).toBe(inn.id);
        expect(doc.current).toBe(hall.id);
        expect(hall).toMatchObject({ firstSeen: 1, lastSeen: 3 });
        expect(hall.visits).toEqual([
            { from: 1, to: null, present: ['Ann', 'Bob'], storyDate: 'Day 1', events: ['Arrived'] },
        ]);
        expect(inn.visits).toEqual([]);
        expect(doc.candidates).toEqual([]);

        applyCapture(doc, input(5, 'Rusty Anchor Tavern, Upstairs Room', { present: ['Cid'] }), d);
        expect(doc.current).toBe(inn.id);
        expect(hall.visits[0]?.to).toBe(3);
        expect(doc.candidates[0]).toMatchObject({ key: 'upstairs room', parent: inn.id });

        applyCapture(doc, input(7, 'Rusty Anchor Tavern, Upstairs Room'), d);
        const room = byName(doc, 'Upstairs Room');
        expect(room.parent).toBe(inn.id);
        expect(doc.current).toBe(room.id);
        expect(room.visits[0]).toMatchObject({ from: 5, to: null });
        expect(inn.visits).toEqual([{ from: 5, to: 5, present: ['Cid'], events: [] }]);

        applyCapture(doc, input(9, null, { present: ['Dee'], events: ['Talked'] }), d);
        expect(room.lastSeen).toBe(9);
        expect(room.visits[0]?.present).toEqual(['Dee']);
        applyCapture(doc, input(11, 'Upstairs Room (Rusty Anchor Tavern)', { events: ['Slept'] }), d);
        expect(doc.current).toBe(room.id);
        expect(room.visits).toHaveLength(1);
        expect(room.visits[0]?.events).toEqual(['Talked', 'Slept']);
        expect(lastRecordIndex(doc)).toBe(11);

        const back = rollbackFrom(doc, 7);
        expect(back).toEqual({ count: 3, earliest: 7 });
        expect(doc.places.some((place) => place.name === 'Upstairs Room')).toBe(false);
        expect(doc.current).toBe(inn.id);
        expect(inn.visits).toEqual([{ from: 5, to: null, present: ['Cid'], events: [] }]);
        expect(inn.lastSeen).toBe(5);
        expect(doc.candidates[0]).toMatchObject({ key: 'upstairs room', seen: [5] });

        rollbackFrom(doc, 0);
        expect(doc).toEqual(emptyPlacesDoc());
    });

    it('keeps a created place the user invested in when its turn is undone', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        applyCapture(doc, input(1, 'Inn'), d);
        applyCapture(doc, input(3, 'Inn'), d);
        applyCapture(doc, input(5, 'Cave'), d);
        applyCapture(doc, input(7, 'Cave'), d);
        byName(doc, 'Inn').entry = { world: 'W', uid: 3 };
        rollbackFrom(doc, 3);
        expect(doc.places.map((place) => place.name)).toEqual(['Inn']);
        expect(byName(doc, 'Inn')).toMatchObject({
            visits: [],
            firstSeen: -1,
            lastSeen: -1,
            entry: { world: 'W', uid: 3 },
        });
        expect(doc.candidates).toEqual([]);
        expect(doc.current).toBeNull();
        applyCapture(doc, input(3, 'Inn'), d);
        expect(doc.current).toBe(byName(doc, 'Inn').id);
        expect(byName(doc, 'Inn').visits).toEqual([{ from: 3, to: null, present: [], events: [] }]);
    });

    it('keeps the stay when DES names only a container of the current place', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const inn = addPlace(doc, { name: 'Inn' }, d, 1);
        const hall = addPlace(doc, { name: 'Hall', parent: inn.id }, d, 1);
        applyCapture(doc, input(1, 'Hall, Inn'), d);
        applyCapture(doc, input(3, 'Inn'), d);
        expect(doc.current).toBe(hall.id);
        expect(hall.lastSeen).toBe(3);
        expect(inn.visits).toEqual([]);
        applyCapture(doc, input(5, 'Inn'), d);
        expect(doc.current).toBe(hall.id);
    });

    it('counts only consecutive labelled turns', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        applyCapture(doc, input(1, 'Inn'), d);
        applyCapture(doc, input(3, 'Forest'), d);
        applyCapture(doc, input(5, 'Inn'), d);
        expect(doc.places).toEqual([]);
        expect(doc.candidates.find((candidate) => candidate.key === 'inn')?.seen).toEqual([1, 5]);
        applyCapture(doc, input(7, null), d);
        expect(doc.log).toHaveLength(3);
        applyCapture(doc, input(9, 'Inn'), d);
        expect(byName(doc, 'Inn')).toMatchObject({ firstSeen: 1, lastSeen: 9 });
        expect(byName(doc, 'Inn').visits[0]?.from).toBe(5);
    });

    it('sends a candidate that resembles a known place to the Inbox instead', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const inn = addPlace(doc, { name: 'Rusty Anchor Tavern' }, d, 1);
        applyCapture(doc, input(1, 'Rusty Anchor'), d);
        const second = applyCapture(doc, input(3, 'Rusty Anchor'), d);
        expect(second.proposals).toEqual([
            {
                key: 'rusty anchor',
                label: 'Rusty Anchor',
                name: 'Rusty Anchor',
                parent: null,
                similar: [inn.id],
                index: 3,
            },
        ]);
        expect(doc.places).toHaveLength(1);
        expect(doc.candidates[0]).toMatchObject({ proposed: true, similar: [inn.id] });
        expect(applyCapture(doc, input(5, 'Rusty Anchor'), d).proposals).toEqual([]);

        const merged = mergeCandidate(doc, 'rusty anchor', inn.id, d);
        expect(merged.before.aliases).toEqual([]);
        expect(merged.after.aliases).toEqual(['Rusty Anchor']);
        expect(doc.current).toBe(inn.id);
        expect(inn.visits).toEqual([{ from: 5, to: null, present: [], events: [] }]);
        expect(inn.firstSeen).toBe(1);
        expect(applyCapture(doc, input(7, 'Rusty Anchor'), d).created).toEqual([]);
        expect(doc.current).toBe(inn.id);
        // Undoing the turn that named it takes the stay back but keeps the alias the user chose.
        rollbackFrom(doc, 5);
        expect(doc.current).toBeNull();
        expect(inn.visits).toEqual([]);
        expect(inn.aliases).toEqual(['Rusty Anchor']);
    });

    it('creates or dismisses candidates on request', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const city = addPlace(doc, { name: 'Port Royal' }, d, 1);
        applyCapture(doc, input(1, 'Room 3, Upper Floor, Port Royal'), d);
        expect(doc.current).toBe(city.id);
        const created = createCandidatePlace(doc, 'room 3', d, 2);
        expect(created.created).toHaveLength(2);
        const floor = byName(doc, 'Upper Floor');
        expect(floor.parent).toBe(city.id);
        expect(created.place.parent).toBe(floor.id);
        expect(doc.current).toBe(created.place.id);
        expect(created.place.visits[0]?.from).toBe(1);
        expect(city.visits[0]?.to).toBe(1);
        expect(() => createCandidatePlace(doc, 'room 3', d, 3)).toThrow(PlacesError);

        applyCapture(doc, input(3, 'Docks'), d);
        expect(dismissCandidate(doc, 'docks')).toBe(true);
        expect(dismissCandidate(doc, 'docks')).toBe(false);
        expect(applyCapture(doc, input(5, 'Docks'), d).changed).toBe(false);
        expect(doc.candidates).toEqual([]);
        expect(doc.current).toBeNull();
        applyCapture(doc, input(7, 'Docks'), d);
        expect(doc.places.some((place) => place.name === 'Docks')).toBe(false);
    });

    it('reuses known containers and skips ones that only look known', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const city = addPlace(doc, { name: 'Port Royal' }, d, 1);
        const floor = addPlace(doc, { name: 'Upper Floor', parent: city.id, aliases: ['First Floor'] }, d, 1);
        doc.candidates.push({
            key: 'room 3',
            label: 'L',
            name: 'Room 3',
            seen: [1],
            similar: [],
            parent: city.id,
            chain: ['first floor'],
            createdAt: 0,
        });
        expect(createCandidatePlace(doc, 'room 3', d, 2).place.parent).toBe(floor.id);
        addPlace(doc, { name: 'Upper Floors', parent: city.id }, d, 1);
        doc.candidates.push({
            key: 'room 4',
            label: 'L',
            name: 'Room 4',
            seen: [],
            similar: [],
            parent: city.id,
            chain: ['Upper Floorz'],
            createdAt: 0,
        });
        const outcome = createCandidatePlace(doc, 'room 4', d, 2);
        expect(outcome.created).toHaveLength(1);
        expect(outcome.place).toMatchObject({ parent: city.id, firstSeen: -1, lastSeen: -1 });
        doc.candidates.push({
            key: 'x',
            label: 'X',
            name: 'X',
            seen: [],
            similar: [],
            parent: 'gone',
            chain: [],
            createdAt: 0,
        });
        expect(createCandidatePlace(doc, 'x', d, 2).place.parent).toBeNull();
    });

    it('re-captures a message only once and rolls back what changed', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const inn = addPlace(doc, { name: 'Inn' }, d, 1);
        const forest = addPlace(doc, { name: 'Forest' }, d, 1);
        applyCapture(doc, input(1, 'Inn'), d);
        applyCapture(doc, input(3, 'Inn'), d);
        applyCapture(doc, input(3, 'Forest', { stamp: 'swiped' }), d);
        expect(doc.log.map((record) => record.stamp)).toEqual(['s1', 'swiped']);
        expect(doc.current).toBe(forest.id);
        expect(inn.visits).toEqual([{ from: 1, to: 1, present: [], events: [] }]);
        expect(firstStaleRecord(doc, (index) => `s${index}`)).toBe(3);
        expect(firstStaleRecord(doc, (index) => (index === 1 ? 'other' : 'swiped'))).toBe(1);
        expect(firstStaleRecord(doc, () => null, 1)).toBe(3);
        expect(firstStaleRecord(doc, (index) => (index === 1 ? 's1' : 'swiped'))).toBeNull();
        expect(rollbackFrom(doc, 4)).toEqual({ count: 0, earliest: null });
    });

    it('ignores fillers and a capture with nothing to say', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        expect(applyCapture(doc, input(1, null), d).changed).toBe(false);
        expect(applyCapture(doc, input(2, 'Unknown'), d).changed).toBe(false);
        expect(doc.log).toEqual([]);
    });

    it('caps events, presence, candidates and the log', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const inn = addPlace(doc, { name: 'Inn' }, d, 1);
        const many = Array.from({ length: 40 }, (_, i) => `Person ${i}`);
        applyCapture(doc, input(0, 'Inn', { present: many, events: ['a'.repeat(300), 'b', 'b'] }), d);
        const visit = inn.visits[0]!;
        expect(visit.present).toHaveLength(PLACES_LIMITS.present);
        expect(visit.events[0]).toHaveLength(PLACES_LIMITS.eventChars);
        expect(visit.events).toHaveLength(2);
        for (let i = 1; i <= 12; i++) applyCapture(doc, input(i, null, { events: [`e${i}`] }), d);
        expect(inn.visits[0]!.events).toHaveLength(PLACES_LIMITS.events);
        expect(inn.visits[0]!.events.at(-1)).toBe('e12');
        for (let i = 13; i < 13 + PLACES_LIMITS.candidates + 3; i++) applyCapture(doc, input(i, `Spot ${i}`), d);
        expect(doc.candidates).toHaveLength(PLACES_LIMITS.candidates);
        expect(doc.candidates.some((candidate) => candidate.key === 'spot 13')).toBe(false);
        for (let i = 100; i < 100 + PLACES_LIMITS.log; i++) applyCapture(doc, input(i, 'Inn'), d);
        expect(doc.log).toHaveLength(PLACES_LIMITS.log);
        expect(doc.log[0]!.index).toBe(100);
    });

    it('keeps a candidate sent to the Inbox when pruning', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        doc.candidates.push({
            key: 'old',
            label: 'Old',
            name: 'Old',
            seen: [0],
            similar: [],
            parent: null,
            chain: [],
            proposed: true,
            createdAt: 0,
        });
        for (let i = 1; i <= PLACES_LIMITS.candidates; i++) applyCapture(doc, input(i, `Spot ${i}`), d);
        expect(doc.candidates.some((candidate) => candidate.key === 'old')).toBe(true);
        expect(doc.candidates.some((candidate) => candidate.key === 'spot 1')).toBe(false);
    });
});

describe('user edits', () => {
    it('adds, updates and validates places', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        expect(() => addPlace(doc, { name: '  ' }, d, 1)).toThrow('empty-name');
        expect(() => addPlace(doc, { name: 'A', parent: 'nope' }, d, 1)).toThrow('bad-parent');
        const city = addPlace(doc, { name: 'City' }, d, 1);
        const inn = addPlace(doc, { name: 'Таверна', parent: city.id }, d, 1);
        expect(inn.forms).toEqual(['Таверны', 'Таверне']);
        const renamed = updatePlace(doc, inn.id, { name: 'Таверна у моря' }, d);
        expect(renamed.before.name).toBe('Таверна');
        expect(renamed.after).toMatchObject({ name: 'Таверна у моря', aliases: ['Таверна'] });
        expect(renamed.after.forms).toEqual(['Таверны', 'Таверне']);
        updatePlace(doc, inn.id, { aliases: ['Якорь', 'якорь'] }, d);
        expect(inn.aliases).toEqual(['Якорь']);
        updatePlace(doc, inn.id, { forms: ['Якоре', 'якорь'] }, d);
        expect(inn.forms).toEqual(['Якоре']);
        expect(() => updatePlace(doc, city.id, { parent: inn.id }, d)).toThrow('bad-parent');
        expect(() => updatePlace(doc, inn.id, { name: ' ' }, d)).toThrow('empty-name');
        expect(() => updatePlace(doc, 'nope', {}, d)).toThrow('missing');
        updatePlace(
            doc,
            inn.id,
            {
                parent: null,
                firstSeen: 4,
                lastSeen: 6,
                createdAt: 9,
                entry: { world: 'W', uid: 1 },
                passportId: 'p',
                state: { s: '1' },
                background: 'b',
            },
            d,
        );
        expect(inn).toMatchObject({
            parent: null,
            firstSeen: 4,
            lastSeen: 6,
            createdAt: 9,
            entry: { world: 'W', uid: 1 },
            passportId: 'p',
            state: { s: '1' },
            background: 'b',
        });
        updatePlace(
            doc,
            inn.id,
            { entry: undefined, passportId: undefined, state: undefined, background: undefined },
            d,
        );
        expect(inn.entry).toBeUndefined();
        expect(inn.passportId).toBeUndefined();
        expect(inn.state).toBeUndefined();
        expect(inn.background).toBeUndefined();
        updatePlace(doc, inn.id, { name: 'Таверна у моря' }, d);
        expect(inn.aliases).toEqual(['Якорь']);
    });

    it('removes a place, lifting its children and forgetting it in records', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const city = addPlace(doc, { name: 'City' }, d, 1);
        const inn = addPlace(doc, { name: 'Inn', parent: city.id }, d, 1);
        const hall = addPlace(doc, { name: 'Hall', parent: inn.id }, d, 1);
        applyCapture(doc, input(1, 'Inn'), d);
        applyCapture(doc, input(3, 'Cellar, Inn'), d);
        doc.candidates[0]!.similar = [inn.id, hall.id];
        const outcome = removePlace(doc, inn.id);
        expect(outcome.removed.name).toBe('Inn');
        expect(outcome.reparented.map((place) => place.id)).toEqual([hall.id]);
        expect(outcome.currentBefore).toBe(inn.id);
        expect(hall.parent).toBe(city.id);
        expect(doc.current).toBeNull();
        expect(doc.candidates[0]).toMatchObject({ parent: city.id, similar: [hall.id] });
        expect(doc.log.every((record) => !(inn.id in record.before.places) && record.current !== inn.id)).toBe(true);
        expect(() => removePlace(doc, inn.id)).toThrow('missing');
        rollbackFrom(doc, 0);
        expect(doc.current).toBeNull();
        expect(reinsertPlace(doc, outcome.removed)).toBe(true);
        expect(reinsertPlace(doc, outcome.removed)).toBe(false);
        expect(restorePlaceFields(doc, outcome.reparented[0]!)).toBe(true);
        expect(hall.parent).toBe(inn.id);
        expect(restorePlaceFields(doc, { ...outcome.removed, id: 'nope' })).toBe(false);
    });

    it('merges places with their names, visits, children and the current place', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const keep = addPlace(doc, { name: 'Rusty Anchor', aliases: ['Anchor'] }, d, 5);
        const other = addPlace(doc, { name: 'Таверна' }, d, 3);
        const child = addPlace(doc, { name: 'Cellar', parent: other.id }, d, 3);
        other.entry = { world: 'W', uid: 7 };
        other.passportId = 'pass';
        other.state = { mood: 'calm' };
        other.background = 'bg';
        applyCapture(doc, input(1, 'Rusty Anchor'), d);
        applyCapture(doc, input(3, 'Таверна'), d);
        doc.candidates.push({
            key: 'c',
            label: 'C',
            name: 'C',
            seen: [],
            similar: [other.id, keep.id],
            parent: other.id,
            chain: [],
            createdAt: 0,
        });
        expect(() => mergePlaces(doc, keep.id, keep.id, d)).toThrow('same');
        expect(() => mergePlaces(doc, keep.id, 'nope', d)).toThrow('missing');
        const outcome = mergePlaces(doc, keep.id, other.id, d);
        expect(keep.aliases).toEqual(['Anchor', 'Таверна']);
        expect(keep.forms).toEqual(['Таверны', 'Таверне']);
        expect(keep.visits.map((visit) => [visit.from, visit.to])).toEqual([
            [1, 1],
            [3, null],
        ]);
        expect(keep).toMatchObject({
            firstSeen: 1,
            lastSeen: 3,
            createdAt: 3,
            entry: { world: 'W', uid: 7 },
            passportId: 'pass',
            state: { mood: 'calm' },
            background: 'bg',
        });
        expect(child.parent).toBe(keep.id);
        expect(doc.current).toBe(keep.id);
        expect(doc.candidates.at(-1)).toMatchObject({ parent: keep.id, similar: [keep.id] });
        expect(doc.log.every((record) => !(other.id in record.before.places))).toBe(true);
        expect(outcome.movedVisits).toEqual([3]);
        expect(outcome.currentBefore).toBe(other.id);
        expect(outcome.reparented.map((place) => place.id)).toEqual([child.id]);

        expect(reinsertPlace(doc, outcome.merged)).toBe(true);
        expect(restorePlaceFields(doc, outcome.keepBefore, outcome.movedVisits)).toBe(true);
        expect(keep.aliases).toEqual(['Anchor']);
        expect(keep.visits.map((visit) => visit.from)).toEqual([1]);
        expect(keep.entry).toBeUndefined();
        const restored = doc.places.find((place) => place.id === other.id)!;
        expect(restored.visits.every((visit) => visit.to !== null)).toBe(true);
    });

    it('merges a place into its own descendant without a loop', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const top = addPlace(doc, { name: 'Top' }, d, 1);
        const mid = addPlace(doc, { name: 'Mid', parent: top.id }, d, 1);
        const low = addPlace(doc, { name: 'Low', parent: mid.id }, d, 1);
        mergePlaces(doc, low.id, top.id, d);
        expect(low.parent).toBeNull();
        expect(mid.parent).toBe(low.id);
        expect(placeTree(doc.places).map((node) => node.place.name)).toEqual(['Low']);
    });

    it('builds the tree', () => {
        const d = deps();
        const doc = emptyPlacesDoc();
        const b = addPlace(doc, { name: 'B' }, d, 1);
        const a = addPlace(doc, { name: 'A' }, d, 1);
        addPlace(doc, { name: 'B2', parent: b.id }, d, 1);
        addPlace(doc, { name: 'B1', parent: b.id }, d, 1);
        const orphan = copyPlace(a);
        orphan.id = 'orphan';
        orphan.parent = 'missing';
        doc.places.push(orphan);
        const flat = flattenTree(placeTree(doc.places));
        expect(flat.map((node) => `${node.depth}:${node.place.name}`)).toEqual(['0:A', '0:A', '0:B', '1:B1', '1:B2']);
    });
});
