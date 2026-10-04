import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    defaultOffscreenSettings,
    isOffscreenPayload,
    OFFSCREEN_STRINGS,
    offscreenModule,
    readOffscreenSettings,
} from '../../../src/features/offscreen';
import type { OffscreenApi, OffscreenSettings } from '../../../src/features/offscreen';
import { readOffscreenDoc, trimSeen } from '../../../src/features/offscreen/store';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createOffscreenEnv, seedMira, seedScene } from './helpers';
import type { OffscreenEnv } from './helpers';

let env: OffscreenEnv;

beforeEach(() => {
    vi.useFakeTimers();
    env = createOffscreenEnv();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('offscreen module', () => {
    it('is M16 of stage 9, on by default, and leaves no trace when switched off', async () => {
        expect(offscreenModule).toMatchObject({ id: 'M16', key: 'offscreen', stage: 9, titleKey: 'm16.title' });
        expect(offscreenModule.enabledByDefault).toBe(true);
        seedScene(env);
        seedMira(env);
        const owned: (Unsubscribe | (() => void | Promise<void>))[] = [];
        const settings = offscreenModule.defaults();
        await offscreenModule.init({
            app: env.app,
            settings,
            log: env.app.log,
            own: (dispose) => void owned.push(dispose),
        });
        await env.tick(20);
        const api = env.modules.api<Required<OffscreenApi>>('offscreen');
        expect(api?.nextIn()).toBe(15);
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['offscreen', 'm16.tab', 57]]);
        expect(env.ui.styles.has('maestro-m16')).toBe(true);
        expect(env.tasks.runners.has('offscreen.run')).toBe(true);
        expect(env.inbox.appliers.has('offscreen.event')).toBe(true);
        expect(env.journal.handlers.has('offscreen.event')).toBe(true);
        for (const dispose of owned.reverse()) await dispose();
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        expect(env.tasks.runners.size).toBe(0);
        expect(env.inbox.appliers.size).toBe(0);
        // The producer is gone: a generation sets nothing.
        await env.generate('normal');
        expect(env.prompts.size).toBe(0);
    });

    it('has every string in both languages', () => {
        expect(Object.keys(OFFSCREEN_STRINGS.ru).sort()).toEqual(Object.keys(OFFSCREEN_STRINGS.en).sort());
        for (const value of Object.values(OFFSCREEN_STRINGS.ru)) expect(value.trim()).not.toBe('');
    });
});

describe('settings', () => {
    it('defaults follow plan §12', () => {
        expect(defaultOffscreenSettings()).toEqual({
            every: { balanced: 15, cinema: 10 },
            sceneEnd: { balanced: false, cinema: true },
            maxCharacters: 3,
            minAbsentTurns: 5,
            rumours: true,
        });
    });

    it('repairs a broken slice in place', () => {
        const slice = {
            every: { balanced: -4, cinema: 'x' },
            sceneEnd: { balanced: 'yes' },
            maxCharacters: 9.4,
            minAbsentTurns: 0,
            rumours: 1,
        } as unknown as Partial<OffscreenSettings>;
        expect(readOffscreenSettings(slice)).toEqual({
            every: { balanced: 0, cinema: 10 },
            sceneEnd: { balanced: false, cinema: true },
            maxCharacters: 3,
            minAbsentTurns: 1,
            rumours: true,
        });
        expect(readOffscreenSettings({ every: [] as never, sceneEnd: null as never })).toMatchObject({
            every: { balanced: 15, cinema: 10 },
            sceneEnd: { balanced: false, cinema: true },
        });
    });
});

describe('the chat document', () => {
    it('reads a broken document safely', () => {
        const doc = readOffscreenDoc({
            turns: 7.8,
            lastCommitted: 'x',
            lastRunTurn: 99,
            seen: { mira: { name: 'Mira', turn: 3, index: 4, place: 'Порт', time: ' ' }, bad: { turn: 1 }, junk: 5 },
            events: [
                {
                    id: 'e1',
                    character: 'Mira',
                    characterKey: 'mira',
                    text: 'Mira left.',
                    status: 'weird',
                    rumour: 'r',
                    drastic: true,
                    rumourUsed: true,
                    canonUid: 5,
                    placeKey: 'place:port',
                    location: '',
                },
                { id: 'e2', character: 'Oleg' },
                null,
            ],
            runs: [
                { at: 1, reason: 'manual', characters: ['Mira', 3], events: -2, costUsd: 'x', error: 'parse' },
                { reason: 'other' },
            ],
            bootstrapped: 'yes',
        });
        expect(doc).toMatchObject({ turns: 7, lastCommitted: -1, lastRunTurn: 7, bootstrapped: false });
        expect(doc.seen).toEqual({ mira: { name: 'Mira', turn: 3, index: 4, place: 'Порт' } });
        expect(doc.events).toEqual([
            {
                id: 'e1',
                character: 'Mira',
                characterKey: 'mira',
                text: 'Mira left.',
                messageIndex: -1,
                status: 'rejected',
                at: 0,
                turn: 0,
                rumour: 'r',
                canonUid: 5,
                drastic: true,
                rumourUsed: true,
                placeKey: 'place:port',
            },
        ]);
        expect(doc.runs).toEqual([
            { at: 1, reason: 'manual', characters: ['Mira'], events: 0, costUsd: 0, error: 'parse' },
        ]);
    });

    it('keeps the latest sightings', () => {
        const seen = Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`c${i}`, { name: `C${i}`, turn: 10 - i, index: i }]),
        );
        trimSeen(seen, 3);
        expect(Object.keys(seen).sort()).toEqual(['c0', 'c1', 'c2']);
    });

    it('recognises its Inbox payloads', () => {
        expect(isOffscreenPayload({ m16: 1, eventId: 'e', entityName: 'Mira', value: 'x', keys: [] })).toBe(true);
        expect(isOffscreenPayload({ m8: 1, eventId: 'e', entityName: 'Mira', value: 'x', keys: [] })).toBe(false);
        expect(isOffscreenPayload(null)).toBe(false);
    });
});
