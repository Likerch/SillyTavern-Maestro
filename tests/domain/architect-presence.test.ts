import { describe, expect, it } from 'vitest';
import {
    firstPlainKey,
    isPinnable,
    judgeSubject,
    mentionDistances,
    nearPlaceIds,
    placeEntityId,
    subjectCacheKey,
    subjectNames,
    typedMetaOf,
} from '../../src/domain/architect-presence';
import type { PresenceFacts } from '../../src/domain/architect-presence';

// City → (Docks, Market); Docks → (Tavern, Warehouse); Tavern → (Hall, Cellar); another top-level City2.
const PLACES = [
    { id: 'city', parent: null },
    { id: 'docks', parent: 'city' },
    { id: 'market', parent: 'city' },
    { id: 'tavern', parent: 'docks' },
    { id: 'warehouse', parent: 'docks' },
    { id: 'hall', parent: 'tavern' },
    { id: 'cellar', parent: 'tavern' },
    { id: 'city2', parent: null },
    { id: 'farm', parent: 'city2' },
];

describe('nearPlaceIds', () => {
    it('takes the current place, ancestors, descendants and siblings', () => {
        expect([...nearPlaceIds(PLACES, 'tavern')].sort()).toEqual(
            ['cellar', 'city', 'docks', 'hall', 'tavern', 'warehouse'].sort(),
        );
    });

    it('has no siblings for a top-level place, and nothing without a current place', () => {
        expect([...nearPlaceIds(PLACES, 'city2')].sort()).toEqual(['city2', 'farm']);
        expect(nearPlaceIds(PLACES, null).size).toBe(0);
        expect([...nearPlaceIds(PLACES, 'unknown')]).toEqual(['unknown']);
    });

    it('survives a cycle in a hand-edited registry', () => {
        const cyclic = [
            { id: 'a', parent: 'b' },
            { id: 'b', parent: 'a' },
        ];
        expect([...nearPlaceIds(cyclic, 'a')].sort()).toEqual(['a', 'b']);
    });

    it('maps registry ids to entity ids', () => {
        expect(placeEntityId('tavern')).toBe('place:tavern');
    });
});

describe('mentionDistances', () => {
    it('counts messages since the newest mention', () => {
        const distances = mentionDistances([['a', 'b'], [], ['a'], ['c']]);
        expect(distances.get('a')).toBe(1);
        expect(distances.get('b')).toBe(3);
        expect(distances.get('c')).toBe(0);
        expect(distances.has('d')).toBe(false);
    });
});

describe('judgeSubject', () => {
    const facts = (patch: Partial<PresenceFacts> = {}): PresenceFacts => ({
        present: new Set(['character:anna']),
        absent: new Set(['character:bob']),
        currentPlace: 'place:tavern',
        nearPlaces: new Set(['place:tavern', 'place:docks']),
        mentions: new Map(),
        window: 6,
        ...patch,
    });

    it('pins present characters and the current place', () => {
        expect(judgeSubject({ id: 'character:anna', kind: 'character' }, facts())).toEqual({ action: 'pin' });
        expect(judgeSubject({ id: 'place:tavern', kind: 'place' }, facts())).toEqual({ action: 'pin' });
    });

    it('damps absent characters not mentioned in the last K messages', () => {
        expect(judgeSubject({ id: 'character:bob', kind: 'character' }, facts())).toEqual({
            action: 'damp',
            reason: 'absent',
            sinceMention: -1,
        });
        const mentioned = facts({ mentions: new Map([['character:bob', 5]]) });
        expect(judgeSubject({ id: 'character:bob', kind: 'character' }, mentioned)).toEqual({ action: 'none' });
        const older = facts({ mentions: new Map([['character:bob', 6]]) });
        expect(judgeSubject({ id: 'character:bob', kind: 'character' }, older)).toEqual({
            action: 'damp',
            reason: 'absent',
            sinceMention: 6,
        });
    });

    it('leaves characters outside the DES roster alone', () => {
        expect(judgeSubject({ id: 'character:carl', kind: 'character' }, facts())).toEqual({ action: 'none' });
    });

    it('damps far places, never near ones, and nothing without a current place', () => {
        expect(judgeSubject({ id: 'place:farm', kind: 'place' }, facts())).toMatchObject({
            action: 'damp',
            reason: 'farPlace',
        });
        expect(judgeSubject({ id: 'place:docks', kind: 'place' }, facts())).toEqual({ action: 'none' });
        const recent = facts({ mentions: new Map([['place:farm', 0]]) });
        expect(judgeSubject({ id: 'place:farm', kind: 'place' }, recent)).toEqual({ action: 'none' });
        expect(judgeSubject({ id: 'place:farm', kind: 'place' }, facts({ currentPlace: null }))).toEqual({
            action: 'none',
        });
    });
});

describe('entry subjects', () => {
    it('finds the first plain key (regex keys skipped)', () => {
        expect(firstPlainKey({ key: ['/an+a/i', ' Anna ', 'Аня'] })).toBe('Anna');
        expect(firstPlainKey({ key: 'Anna' })).toBe('');
        expect(firstPlainKey({ key: [5, ''] })).toBe('');
    });

    it('reads typed metadata from the entry or the sidecar', () => {
        const entry = { extensions: { maestro: { type: 'character', typeFields: { name: 'Anna' } } } };
        expect(typedMetaOf(entry)).toEqual({ type: 'character', fields: { name: 'Anna' } });
        expect(typedMetaOf({}, { type: 'place', typeFields: { name: 'Tavern' } })).toEqual({
            type: 'place',
            fields: { name: 'Tavern' },
        });
        expect(typedMetaOf({}, null)).toBeNull();
    });

    it('lists names: typed name with its kind, then comment and first key', () => {
        const entry = { comment: 'Anna', key: ['Anna', 'Аня'] };
        expect(subjectNames(entry, { type: 'character', fields: { name: 'Anna Petrova' } })).toEqual([
            { name: 'Anna Petrova', kind: 'character' },
            { name: 'Anna', kind: 'character' },
        ]);
        expect(subjectNames(entry, { type: 'item', fields: { name: 'Sword' } })).toEqual([]);
        expect(subjectNames({ comment: 'Tavern', key: ['tavern'] }, null)).toEqual([{ name: 'Tavern' }]);
        expect(subjectNames({ comment: '', key: [] }, { type: 'place', fields: {} })).toEqual([]);
        expect(subjectNames({}, null)).toEqual([]);
    });

    it('builds a cache key from everything the resolution reads', () => {
        const entry = { world: 'W', uid: 3, comment: 'Anna', key: ['Anna'] };
        expect(subjectCacheKey(entry)).toBe('W#3#Anna#Anna#');
        const typed = { ...entry, extensions: { maestro: { type: 'character', typeFields: { name: 'A' } } } };
        expect(subjectCacheKey(typed)).not.toBe(subjectCacheKey(entry));
    });

    it('pins only entries without gates', () => {
        const base = { content: 'Text.', characterFilter: { isExclude: false, names: [], tags: [] }, triggers: [] };
        expect(isPinnable(base)).toBe(true);
        expect(isPinnable({ ...base, disable: true })).toBe(false);
        expect(isPinnable({ ...base, constant: true })).toBe(false);
        expect(isPinnable({ ...base, content: '  ' })).toBe(false);
        expect(isPinnable({ ...base, triggers: ['swipe'] })).toBe(false);
        expect(isPinnable({ ...base, characterFilter: { isExclude: false, names: ['x'], tags: [] } })).toBe(false);
        expect(isPinnable({ ...base, useProbability: true, probability: 50 })).toBe(false);
        expect(isPinnable({ ...base, useProbability: true, probability: 100 })).toBe(true);
        expect(isPinnable({ ...base, delayUntilRecursion: true })).toBe(false);
        expect(isPinnable({ ...base, delayUntilRecursion: 2 })).toBe(false);
        expect(isPinnable({ ...base, delayUntilRecursion: null })).toBe(true);
    });
});
