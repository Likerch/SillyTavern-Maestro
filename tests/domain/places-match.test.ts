import { describe, expect, it } from 'vitest';
import {
    ancestorIds,
    canSetParent,
    descendantIds,
    editDistance,
    isAncestor,
    namesSimilar,
    placeKeyIndex,
    placeKeys,
    placeMap,
    placePath,
    resolvePlaceLabel,
    significantStems,
    similarPlaces,
    wordStem,
} from '../../src/domain/places-match';
import type { PlaceRef } from '../../src/domain/places-match';

function place(id: string, name: string, parent: string | null = null, extra: Partial<PlaceRef> = {}): PlaceRef {
    return { id, name, aliases: [], forms: [], parent, ...extra };
}

const CITY = place('city', 'Port Royal');
const INN = place('inn', 'Rusty Anchor', 'city', { aliases: ['The Anchor'], forms: [] });
const HALL = place('hall', 'Main Hall', 'inn', { lastSeen: 5 });
const CASTLE = place('castle', 'Castle', 'city');
const CASTLE_HALL = place('chall', 'Main Hall', 'castle', { lastSeen: 9 });
const RU = place('ru', 'Таверна', null, { forms: ['Таверны', 'Таверне', 'Таверной'] });
const PLACES = [CITY, INN, HALL, CASTLE, RU];

describe('keys and tree', () => {
    it('collects normalised names, aliases and forms', () => {
        expect(placeKeys(INN)).toEqual(['rusty anchor', 'anchor']);
        expect(placeKeys(RU)).toEqual(['таверна', 'таверны', 'таверне', 'таверной']);
        expect(placeKeys(place('x', '  ', null, { aliases: ['', 'Y'] }))).toEqual(['y']);
        const index = placeKeyIndex([
            ...PLACES,
            CASTLE_HALL,
            place('dup', 'Main Hall', null, { aliases: ['main hall'] }),
        ]);
        expect(index.get('main hall')).toEqual(['hall', 'chall', 'dup']);
    });

    it('walks ancestors safely', () => {
        const byId = placeMap(PLACES);
        expect(ancestorIds(byId, 'hall')).toEqual(['inn', 'city']);
        expect(ancestorIds(byId, 'missing')).toEqual([]);
        expect(isAncestor(byId, 'city', 'hall')).toBe(true);
        expect(isAncestor(byId, 'hall', 'city')).toBe(false);
        expect(isAncestor(byId, 'hall', 'hall')).toBe(false);
        const loop = placeMap([place('a', 'A', 'b'), place('b', 'B', 'a')]);
        expect(ancestorIds(loop, 'a')).toEqual(['b']);
        expect(descendantIds(PLACES, 'city').sort()).toEqual(['castle', 'hall', 'inn']);
        expect(placePath(byId, 'hall')).toEqual(['Port Royal', 'Rusty Anchor', 'Main Hall']);
        expect(placePath(byId, 'nope')).toEqual([]);
    });

    it('allows only parents that keep a tree', () => {
        expect(canSetParent(PLACES, 'inn', null)).toBe(true);
        expect(canSetParent(PLACES, 'inn', 'inn')).toBe(false);
        expect(canSetParent(PLACES, 'inn', 'nope')).toBe(false);
        expect(canSetParent(PLACES, 'city', 'hall')).toBe(false);
        expect(canSetParent(PLACES, 'hall', 'castle')).toBe(true);
    });
});

describe('similarity', () => {
    it('stems Russian and English words', () => {
        expect(wordStem('якоря')).toBe('якор');
        expect(wordStem('таверной')).toBe('таверн');
        expect(wordStem('дом')).toBe('дом');
        expect(wordStem("Lyra's")).toBe('lyra');
        expect(wordStem('docks')).toBe('dock');
        expect(wordStem('glass')).toBe('glass');
        expect(wordStem('bus')).toBe('bus');
        expect(significantStems('Таверна «Ржавый якорь»')).toEqual(['ржав', 'якор']);
        expect(significantStems('The Main Hall of the Old Inn')).toEqual([]);
        expect(significantStems('Anchor, anchors')).toEqual(['anchor']);
    });

    it('measures edit distance', () => {
        expect(editDistance('', 'abc')).toBe(3);
        expect(editDistance('abc', '')).toBe(3);
        expect(editDistance('kitten', 'sitting')).toBe(3);
        expect(editDistance('якорь', 'якоря')).toBe(1);
    });

    it('finds names that may be one place', () => {
        expect(namesSimilar('Rusty Anchor', 'The Rusty Anchor Tavern')).toBe(true);
        expect(namesSimilar('Таверна', 'Таверна «Ржавый якорь»')).toBe(true);
        expect(namesSimilar('Ржавый якорь', 'у Ржавого якоря')).toBe(true);
        expect(namesSimilar('Rusty Anchor Tavern', 'Rusty Ancor Tavern')).toBe(true);
        expect(namesSimilar('Blackwood Manor', 'Blackwod Manor')).toBe(true);
        expect(namesSimilar('Old Tavern', 'Tavern')).toBe(true);
        expect(namesSimilar('Main Hall', 'main hall')).toBe(true);
    });

    it('keeps different places apart', () => {
        expect(namesSimilar('Room 3', 'Room 4')).toBe(false);
        expect(namesSimilar('Main Hall', 'Main Gate')).toBe(false);
        expect(namesSimilar('Port', 'Portal')).toBe(false);
        expect(namesSimilar('Inn', 'Ink')).toBe(false);
        expect(namesSimilar('', 'Inn')).toBe(false);
        expect(namesSimilar('Kitchen', 'Library')).toBe(false);
    });

    it('looks for similar places on the same branch only', () => {
        const places = [...PLACES, CASTLE_HALL];
        expect(similarPlaces(places, 'Main Hal', 'inn')).toEqual(['hall']);
        expect(similarPlaces([...PLACES], 'Main Hall', 'castle')).toEqual([]);
        expect(similarPlaces(places, 'Rusty Anchor Inn', null)).toEqual(['inn']);
        expect(similarPlaces(places, 'Rusty Anchor Hall', 'inn')).toEqual([]);
        expect(similarPlaces(places, 'Main Hall', 'city')).toEqual(['hall', 'chall']);
        expect(similarPlaces([place('top', 'Main Hall')], 'Main Hall', 'inn')).toEqual(['top']);
    });
});

describe('resolvePlaceLabel', () => {
    it('matches the whole label and case forms', () => {
        const named = place('named', 'Rusty Anchor, Main Hall');
        expect(resolvePlaceLabel([...PLACES, named], 'Rusty Anchor, Main Hall').match).toBe('named');
        expect(resolvePlaceLabel(PLACES, 'таверне')).toMatchObject({ match: 'ru', deepest: 'ru', unknown: [] });
        expect(resolvePlaceLabel(PLACES, 'the anchor').match).toBe('inn');
    });

    it('lets the registry order the parts', () => {
        expect(resolvePlaceLabel(PLACES, 'Main Hall, Rusty Anchor')).toMatchObject({
            parts: ['Main Hall', 'Rusty Anchor'],
            order: 'registry',
            match: 'hall',
        });
        expect(resolvePlaceLabel(PLACES, 'Rusty Anchor — Main Hall')).toMatchObject({
            parts: ['Main Hall', 'Rusty Anchor'],
            order: 'registry',
            match: 'hall',
        });
    });

    it('checks the nesting', () => {
        const places = [...PLACES, CASTLE_HALL];
        expect(resolvePlaceLabel(places, 'Main Hall, Castle')).toMatchObject({ match: 'chall', deepest: 'chall' });
        expect(resolvePlaceLabel(PLACES, 'Main Hall, Castle')).toMatchObject({
            match: null,
            deepest: 'castle',
            unknown: ['Main Hall'],
        });
        const loose = place('loose', 'Kitchen');
        expect(resolvePlaceLabel([...PLACES, loose], 'Kitchen, Castle').match).toBe('loose');
    });

    it('finds the known container of unknown parts', () => {
        expect(resolvePlaceLabel(PLACES, 'Room 3, Upper Floor, Rusty Anchor')).toMatchObject({
            match: null,
            deepest: 'inn',
            unknown: ['Room 3', 'Upper Floor'],
        });
        expect(resolvePlaceLabel(PLACES, 'Nowhere, Neverland')).toMatchObject({
            match: null,
            deepest: null,
            unknown: ['Nowhere', 'Neverland'],
        });
        expect(resolvePlaceLabel(PLACES, 'Unknown')).toMatchObject({ label: '', parts: [], deepest: null });
    });

    it('picks among places with one name', () => {
        const places = [...PLACES, CASTLE_HALL];
        expect(resolvePlaceLabel(places, 'Main Hall').match).toBe('chall');
        expect(resolvePlaceLabel(places, 'Main Hall', { current: 'hall' }).match).toBe('hall');
        expect(resolvePlaceLabel(places, 'Main Hall', { current: 'inn' }).match).toBe('hall');
        expect(resolvePlaceLabel(places, 'Main Hall', { current: 'castle' }).match).toBe('chall');
        const sibling = place('kitchen', 'Kitchen', 'inn');
        expect(resolvePlaceLabel([...places, sibling], 'Main Hall', { current: 'kitchen' }).match).toBe('hall');
        expect(resolvePlaceLabel([...places, sibling], 'Main Hall', { current: 'city' }).match).toBe('chall');
    });
});
