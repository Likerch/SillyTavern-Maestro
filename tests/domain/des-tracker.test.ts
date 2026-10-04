import { describe, expect, it } from 'vitest';
import {
    desSwipeRecord,
    isEmptySnapshot,
    parseDesCharacters,
    parseDesInfoBox,
    parseDesQuests,
    parseDesTracker,
    parseTrackerJson,
} from '../../src/domain/des-tracker';

describe('parseTrackerJson', () => {
    it('parses strings, fenced blocks and passes parsed values through', () => {
        expect(parseTrackerJson('{"a":1}')).toEqual({ a: 1 });
        expect(parseTrackerJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
        expect(parseTrackerJson('  [1, 2] ')).toEqual([1, 2]);
        const parsed = { b: 1 };
        expect(parseTrackerJson(parsed)).toBe(parsed);
    });

    it('gives null for missing, empty and non-JSON values', () => {
        expect(parseTrackerJson(null)).toBeNull();
        expect(parseTrackerJson(undefined)).toBeNull();
        expect(parseTrackerJson('   ')).toBeNull();
        expect(parseTrackerJson('Main Quest: find the key')).toBeNull();
    });
});

describe('parseDesCharacters', () => {
    const unified = JSON.stringify([
        {
            name: ' Аня ',
            emoji: '😊',
            color: '#C71585',
            details: {
                appearance: 'short hair',
                demeanor: '[calm]',
                внешность: 'рыжая',
                empty: '',
                nested: { value: 'v' },
            },
            relationship: { status: 'Friend' },
            stats: [
                { name: 'Health', value: 90 },
                { name: 'Mood', value: 'good' },
                { name: '', value: 1 },
                { name: 'Bad', value: null },
                'junk',
            ],
            thoughts: { content: 'I should leave.' },
        },
        {
            name: 'Борис',
            relationship: 'Rival',
            stats: { Health: 50, Energy: { value: 20 } },
            thoughts: 'He is not in the scene right now.',
        },
        { name: 'Вера', Relationship: '[Lover]', relationship: { status: 'ignored' }, thoughts: '(off-scene) далеко' },
        { name: 'Гоша', present: false },
        { name: '' },
        { emoji: '👤' },
        'junk',
    ]);

    it('reads the array form with nested fields', () => {
        const [anya, boris, vera, gosha, ...rest] = parseDesCharacters(unified);
        expect(rest).toEqual([]);
        expect(anya).toEqual({
            name: 'Аня',
            emoji: '😊',
            color: '#C71585',
            details: { appearance: 'short hair', demeanor: 'calm', внешность: 'рыжая', nested: 'v' },
            relationship: 'Friend',
            stats: [
                { name: 'Health', value: 90 },
                { name: 'Mood', value: 'good' },
            ],
            thoughts: 'I should leave.',
            offScene: false,
        });
        expect(boris?.relationship).toBe('Rival');
        expect(boris?.stats).toEqual([
            { name: 'Health', value: 50 },
            { name: 'Energy', value: 20 },
        ]);
        expect(boris?.offScene).toBe(true);
        expect(vera?.relationship).toBe('Lover');
        expect(vera?.offScene).toBe(true);
        expect(gosha).toEqual({ name: 'Гоша', details: {}, stats: [], offScene: true });
    });

    it('reads the legacy {characters} form and parsed objects', () => {
        expect(parseDesCharacters('{"characters":[{"name":"A"}]}').map((c) => c.name)).toEqual(['A']);
        expect(parseDesCharacters({ characters: [{ name: 'B' }] }).map((c) => c.name)).toEqual(['B']);
        expect(parseDesCharacters({ other: [] })).toEqual([]);
        expect(parseDesCharacters('not json')).toEqual([]);
    });
});

describe('parseDesInfoBox', () => {
    it('reads the nested form', () => {
        const info = parseDesInfoBox(
            JSON.stringify({
                date: { value: 'Day 3' },
                time: { start: '18:00', end: '19:00' },
                location: { value: 'Tavern' },
                weather: { emoji: '🌧️', forecast: 'rain' },
                temperature: { value: 12, unit: 'C' },
                recentEvents: ['Fight', { text: 'Escape' }, ''],
                moonPhase: 'Full',
                doomTension: 3,
                custom_field: ['a', { value: 'b' }],
                empty: '',
            }),
        );
        expect(info).toEqual({
            date: 'Day 3',
            time: { start: '18:00', end: '19:00' },
            location: 'Tavern',
            weather: { emoji: '🌧️', forecast: 'rain' },
            temperature: { value: 12, unit: 'C' },
            recentEvents: ['Fight', 'Escape'],
            fields: { moonPhase: 'Full', doomTension: '3', custom_field: 'a, b' },
        });
    });

    it('reads the flat forms', () => {
        const info = parseDesInfoBox({
            location: 'Forest',
            time: 'evening',
            date: 'Monday',
            weather: 'snow',
            temperature: '-5C',
            recentEvents: 'One thing happened',
        });
        expect(info).toMatchObject({
            location: 'Forest',
            time: { start: 'evening' },
            date: 'Monday',
            weather: { forecast: 'snow' },
            temperature: { value: '-5C' },
            recentEvents: ['One thing happened'],
        });
    });

    it('reads other event and time shapes', () => {
        expect(parseDesInfoBox({ recentEvents: { events: ['a', 'b'] } })?.recentEvents).toEqual(['a', 'b']);
        expect(parseDesInfoBox({ recentEvents: { events: 'single' } })?.recentEvents).toEqual(['single']);
        expect(parseDesInfoBox({ recentEvents: { value: 'v' } })?.recentEvents).toEqual(['v']);
        expect(parseDesInfoBox({ time: { value: 'noon' } })?.time).toEqual({ start: 'noon' });
        expect(parseDesInfoBox({ time: { end: 'late' } })?.time).toEqual({ end: 'late' });
        expect(parseDesInfoBox({ time: {} })?.time).toBeUndefined();
        expect(parseDesInfoBox({ weather: { value: 'fog' } })?.weather).toEqual({ forecast: 'fog' });
        expect(parseDesInfoBox({ weather: {} })?.weather).toBeUndefined();
        expect(parseDesInfoBox({ temperature: 20 })?.temperature).toEqual({ value: 20 });
        expect(parseDesInfoBox({ temperature: { value: '20' } })?.temperature).toEqual({ value: '20' });
        expect(parseDesInfoBox({ temperature: { unit: 'C' } })?.temperature).toBeUndefined();
        expect(parseDesInfoBox({ temperature: '' })?.temperature).toBeUndefined();
        expect(parseDesInfoBox({ temperature: true })?.temperature).toBeUndefined();
    });

    it('gives null for missing or non-object sections', () => {
        expect(parseDesInfoBox(null)).toBeNull();
        expect(parseDesInfoBox('[1]')).toBeNull();
        expect(parseDesInfoBox('Location: Tavern')).toBeNull();
    });
});

describe('parseDesQuests', () => {
    it('reads titles from objects, strings and nested values', () => {
        expect(
            parseDesQuests(
                JSON.stringify({
                    main: { title: 'Find the key' },
                    optional: [{ title: 'Buy bread' }, 'Feed cat', { value: { value: 'Deep' } }],
                }),
            ),
        ).toEqual({ main: 'Find the key', optional: ['Buy bread', 'Feed cat', 'Deep'] });
    });

    it('treats None, Нет and empty as no quest', () => {
        expect(parseDesQuests({ main: 'None', optional: [{ title: 'Нет' }, ''] })).toEqual({
            main: null,
            optional: [],
        });
        expect(parseDesQuests({ main: { description: 'Only a description' } })).toEqual({
            main: 'Only a description',
            optional: [],
        });
        expect(parseDesQuests('nope')).toBeNull();
    });
});

describe('desSwipeRecord', () => {
    const record = { quests: '{"main":"Q"}', infoBox: null, characterThoughts: '[{"name":"A"}]' };

    it('reads the record of the current swipe', () => {
        const message = {
            is_user: false,
            swipe_id: 1,
            extra: { dooms_tracker_swipes: { 0: { infoBox: 'old' }, 1: record } },
        };
        expect(desSwipeRecord(message)).toEqual(record);
        expect(desSwipeRecord({ extra: { dooms_tracker_swipes: [record] } })).toEqual(record);
    });

    it('falls back to swipe_info like DES does', () => {
        const message = {
            swipe_id: 1,
            extra: {},
            swipe_info: [{}, { extra: { dooms_tracker_swipes: { 1: record } } }],
        };
        expect(desSwipeRecord(message)).toEqual(record);
    });

    it('gives null for user messages, all-null records and junk', () => {
        expect(desSwipeRecord({ is_user: true, extra: { dooms_tracker_swipes: [record] } })).toBeNull();
        expect(
            desSwipeRecord({
                extra: { dooms_tracker_swipes: [{ quests: null, infoBox: null, characterThoughts: null }] },
            }),
        ).toBeNull();
        expect(desSwipeRecord({ swipe_id: -1, extra: { dooms_tracker_swipes: ['junk'] } })).toBeNull();
        expect(desSwipeRecord(undefined)).toBeNull();
        expect(desSwipeRecord({ swipe_info: 'junk' })).toBeNull();
    });
});

describe('parseDesTracker', () => {
    it('combines the three sections', () => {
        const snapshot = parseDesTracker({
            quests: '{"main":{"title":"Q"}}',
            infoBox: '{"location":{"value":"L"}}',
            characterThoughts: '[{"name":"A"}]',
        });
        expect(snapshot.quests).toEqual({ main: 'Q', optional: [] });
        expect(snapshot.infoBox?.location).toBe('L');
        expect(snapshot.characters.map((c) => c.name)).toEqual(['A']);
        expect(isEmptySnapshot(snapshot)).toBe(false);
        expect(isEmptySnapshot(parseDesTracker({}))).toBe(true);
    });
});
