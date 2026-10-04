import { describe, expect, it } from 'vitest';
import {
    absenceOf,
    cadenceOf,
    committedReplies,
    decideRun,
    importanceOf,
    isImportant,
    lastCommittedReply,
    lastStoryReply,
    MIN_SCENE_GAP,
    pickCandidates,
    pickRumour,
    pluralForm,
    pushCapped,
    rankCandidates,
    rumourDue,
    rumourPlausible,
    sceneEndOn,
    storyTimeLabel,
    turnsUntil,
} from '../../src/domain/offscreen-plan';
import type {
    CadenceSettings,
    CandidateInput,
    PickOptions,
    RumourEvent,
    RumourScene,
} from '../../src/domain/offscreen-plan';

const SETTINGS: CadenceSettings = {
    every: { balanced: 15, cinema: 10 },
    sceneEnd: { balanced: false, cinema: true },
};

describe('cadence', () => {
    it('is off in «Экономный», N per mode elsewhere, 0 or garbage = off', () => {
        expect(cadenceOf('economy', SETTINGS)).toBeNull();
        expect(cadenceOf('balanced', SETTINGS)).toBe(15);
        expect(cadenceOf('cinema', SETTINGS)).toBe(10);
        expect(cadenceOf('balanced', { ...SETTINGS, every: { balanced: 0, cinema: 10 } })).toBeNull();
        expect(cadenceOf('cinema', { ...SETTINGS, every: { balanced: 15, cinema: Number.NaN } })).toBeNull();
        expect(cadenceOf('cinema', { ...SETTINGS, every: { balanced: 15, cinema: 2.6 } })).toBe(3);
    });

    it('runs at scene ends only where switched on, never in «Экономный»', () => {
        expect(sceneEndOn('cinema', SETTINGS)).toBe(true);
        expect(sceneEndOn('balanced', SETTINGS)).toBe(false);
        expect(sceneEndOn('economy', { ...SETTINGS, sceneEnd: { balanced: true, cinema: true } })).toBe(false);
    });

    it('decides the run: interval, scene end after the gap, nothing in «Экономный»', () => {
        expect(decideRun({ mode: 'balanced', turnsSince: 14, sceneEnded: false }, SETTINGS)).toBeNull();
        expect(decideRun({ mode: 'balanced', turnsSince: 15, sceneEnded: false }, SETTINGS)).toBe('interval');
        expect(decideRun({ mode: 'balanced', turnsSince: 5, sceneEnded: true }, SETTINGS)).toBeNull();
        expect(decideRun({ mode: 'cinema', turnsSince: 9, sceneEnded: false }, SETTINGS)).toBeNull();
        expect(decideRun({ mode: 'cinema', turnsSince: 10, sceneEnded: false }, SETTINGS)).toBe('interval');
        expect(decideRun({ mode: 'cinema', turnsSince: MIN_SCENE_GAP, sceneEnded: true }, SETTINGS)).toBe('sceneEnd');
        expect(decideRun({ mode: 'cinema', turnsSince: MIN_SCENE_GAP - 1, sceneEnded: true }, SETTINGS)).toBeNull();
        expect(decideRun({ mode: 'cinema', turnsSince: 12, sceneEnded: true }, SETTINGS)).toBe('sceneEnd');
        expect(decideRun({ mode: 'economy', turnsSince: 500, sceneEnded: true }, SETTINGS)).toBeNull();
        expect(decideRun({ mode: 'cinema', turnsSince: 1, sceneEnded: true }, SETTINGS, 1)).toBe('sceneEnd');
    });

    it('counts the turns until the next run', () => {
        expect(turnsUntil('balanced', SETTINGS, 4)).toBe(11);
        expect(turnsUntil('balanced', SETTINGS, 20)).toBe(0);
        expect(turnsUntil('cinema', SETTINGS, -3)).toBe(10);
        expect(turnsUntil('economy', SETTINGS, 4)).toBeNull();
    });
});

function candidate(fields: Partial<CandidateInput> & { name: string }): CandidateInput {
    return {
        key: fields.name.toLowerCase(),
        sourceKinds: ['lore.entry'],
        roster: true,
        present: false,
        lastSeenTurn: 0,
        lastEventTurn: null,
        ...fields,
    };
}

const PICK: PickOptions = { now: 20, minAbsent: 5, cooldown: 10, max: 3 };

describe('importance', () => {
    it('weighs the stores and the roster; repeats count a quarter; capped', () => {
        expect(importanceOf([], false)).toBe(0);
        expect(importanceOf([], true)).toBe(2);
        expect(importanceOf(['card'], false)).toBe(3);
        expect(importanceOf(['lore.entry', 'lore.entry'], false)).toBe(2.5);
        expect(importanceOf(['qvink.memory', 'chat.alias'], false)).toBe(1);
        expect(importanceOf(['canon.entry', 'des.character'], true)).toBe(4.5);
        expect(
            importanceOf(
                Array.from({ length: 10 }, () => 'card'),
                true,
            ),
        ).toBe(11.75);
        expect(
            importanceOf(['card', 'ck.archive', 'nai.passport', 'lore.entry', 'canon.entry', 'des.character'], true),
        ).toBe(12);
    });

    it('is important on the roster or with a real store', () => {
        expect(isImportant(['qvink.memory'], false)).toBe(false);
        expect(isImportant(['qvink.memory'], true)).toBe(true);
        expect(isImportant(['nai.passport'], false)).toBe(true);
    });

    it('absence counts from the last sighting, never seen = the whole chat', () => {
        expect(absenceOf({ lastSeenTurn: 12 }, 20)).toBe(8);
        expect(absenceOf({ lastSeenTurn: null }, 20)).toBe(20);
        expect(absenceOf({ lastSeenTurn: 30 }, 20)).toBe(0);
    });
});

describe('picking characters', () => {
    it('keeps only important absent characters away long enough and off cooldown', () => {
        const list = [
            candidate({ name: 'Persona', persona: true }),
            candidate({ name: 'Here', present: true }),
            candidate({ name: 'Hidden', removed: true }),
            candidate({ name: 'Waiting', pendingInbox: true }),
            candidate({ name: 'Nobody', roster: false, sourceKinds: ['qvink.memory'] }),
            candidate({ name: 'Recent', lastSeenTurn: 17 }),
            candidate({ name: 'Cooling', lastEventTurn: 15 }),
            candidate({ name: 'Narrator', main: true, lastSeenTurn: null }),
            candidate({ name: '   ', key: '' }),
            candidate({ name: 'Mira', lastSeenTurn: 2 }),
            candidate({ name: 'Liza', main: true, lastSeenTurn: 10, lastEventTurn: 5 }),
        ];
        const ranked = rankCandidates(list, PICK);
        expect(ranked.map((item) => item.name)).toEqual(['Mira', 'Liza']);
        expect(ranked[0]).toMatchObject({ importance: 4, absence: 18 });
        expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    });

    it('a roster character never seen in this chat is long gone; a lore-only one ranks lower', () => {
        const list = [
            candidate({ name: 'Lore', roster: false, lastSeenTurn: null, sourceKinds: ['lore.entry', 'ck.archive'] }),
            candidate({ name: 'Roster', roster: true, lastSeenTurn: null, sourceKinds: [] }),
        ];
        const ranked = rankCandidates(list, { ...PICK, now: 3 });
        expect(ranked.map((item) => item.name)).toEqual(['Roster']);
        const later = rankCandidates(list, { ...PICK, now: 40 });
        expect(later.map((item) => item.name)).toEqual(['Lore', 'Roster']);
        const lore = later.find((item) => item.name === 'Lore')!;
        expect(lore.score).toBeCloseTo(4 * (1 + Math.log2(41)) * 0.5, 2);
    });

    it('sorts by score, then by name; keeps the first of equal keys; picks at most max', () => {
        const list = [
            candidate({ name: 'Bob', lastSeenTurn: 0 }),
            candidate({ name: 'Ann', lastSeenTurn: 0 }),
            candidate({ name: 'ann', key: 'ann', lastSeenTurn: 0, sourceKinds: ['card', 'card'] }),
            candidate({ name: 'Cid', lastSeenTurn: 0, sourceKinds: ['card'] }),
            candidate({ name: 'Dan', lastSeenTurn: 10 }),
        ];
        expect(rankCandidates(list, PICK).map((item) => item.name)).toEqual(['Cid', 'Ann', 'Bob', 'Dan']);
        expect(pickCandidates(list, { ...PICK, max: 2 }).map((item) => item.name)).toEqual(['Cid', 'Ann']);
        expect(pickCandidates(list, { ...PICK, max: 0 })).toEqual([]);
    });
});

describe('rumours', () => {
    it('come up one turn in three after the event, then they are old news', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((turns) => rumourDue(turns))).toEqual([1, 4, 7]);
        expect(rumourDue(3, 2, 9)).toBe(true);
        expect(rumourDue(2, 0, 9)).toBe(true);
    });

    const scene = (fields: Partial<RumourScene> = {}): RumourScene => ({
        presentKeys: ['liza'],
        placeKey: 'place:port',
        related: new Set<string>(),
        ...fields,
    });

    it('reach only someone who could know: the same place or a relationship', () => {
        const event = { characterKey: 'mira', placeKey: 'place:port' };
        expect(rumourPlausible(event, scene())).toBe(true);
        expect(rumourPlausible({ ...event, placeKey: 'place:capital' }, scene())).toBe(false);
        expect(rumourPlausible({ ...event, placeKey: null }, scene({ related: new Set(['mira']) }))).toBe(true);
        expect(rumourPlausible(event, scene({ presentKeys: [] }))).toBe(false);
        expect(rumourPlausible(event, scene({ presentKeys: ['liza', 'mira'] }))).toBe(false);
        expect(rumourPlausible(event, scene({ placeKey: null }))).toBe(false);
    });

    it('picks at most one: the newest saved, unused, due and plausible rumour', () => {
        const event = (fields: Partial<RumourEvent> & { id: string }): RumourEvent => ({
            characterKey: 'mira',
            rumour: 'They say Mira left the port.',
            turn: 9,
            status: 'saved',
            placeKey: 'place:port',
            ...fields,
        });
        const events = [
            event({ id: 'old', turn: 6 }),
            event({ id: 'a', turn: 9 }),
            event({ id: 'b', turn: 9 }),
            event({ id: 'used', turn: 9, rumourUsed: true }),
            event({ id: 'inbox', turn: 9, status: 'inbox' }),
            event({ id: 'silent', turn: 9, rumour: '  ' }),
            event({ id: 'far', turn: 9, placeKey: 'place:capital', characterKey: 'oleg' }),
        ];
        expect(pickRumour(events, scene(), 10)?.id).toBe('b');
        expect(pickRumour(events, scene(), 7)?.id).toBe('old');
        expect(pickRumour(events, scene(), 11)).toBeNull();
        expect(pickRumour([], scene(), 10)).toBeNull();
    });
});

describe('chat readers', () => {
    const user = (mes = 'user') => ({ is_user: true, is_system: false, mes });
    const reply = (mes = 'reply') => ({ is_user: false, is_system: false, mes });
    const system = { is_user: false, is_system: true, mes: 'note' };
    const picture = { is_user: false, is_system: false, mes: '', extra: { nai_studio: {} } };

    it('finds committed replies (answered by the user), skipping notes and picture posts', () => {
        const chat = [reply(), user(), reply(), picture, system, user(), reply('draft')];
        expect(committedReplies(chat)).toEqual([0, 2]);
        expect(lastCommittedReply(chat)).toBe(2);
        expect(lastStoryReply(chat)).toBe(6);
        expect(committedReplies([reply()])).toEqual([]);
        expect(lastCommittedReply([reply(), undefined, system])).toBe(-1);
        expect(lastStoryReply([user(), system])).toBe(-1);
        expect(lastCommittedReply([picture, user()])).toBe(-1);
    });

    it('labels the story time from DES date and time', () => {
        expect(storyTimeLabel({ date: '3 марта', time: { start: '14:00', end: '15:30' } })).toBe(
            '3 марта, 14:00–15:30',
        );
        expect(storyTimeLabel({ date: ' Day 3 ', time: { start: '9:00', end: '9:00' } })).toBe('Day 3, 9:00');
        expect(storyTimeLabel({ time: { end: 'evening' } })).toBe('evening');
        expect(storyTimeLabel({ date: '  ' })).toBeUndefined();
        expect(storyTimeLabel(null)).toBeUndefined();
    });

    it('chooses Russian and English plural forms', () => {
        expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 104].map((n) => pluralForm(n, 'ru'))).toEqual([
            'one',
            'few',
            'many',
            'many',
            'many',
            'one',
            'few',
            'many',
            'many',
            'few',
        ]);
        expect([1, 2, 0].map((n) => pluralForm(n, 'en'))).toEqual(['one', 'many', 'many']);
    });

    it('keeps lists capped', () => {
        const list = [1, 2, 3];
        expect(pushCapped(list, 4, 3)).toEqual([2, 3, 4]);
        expect(pushCapped([1], 2, -1)).toEqual([1, 2]);
    });
});
