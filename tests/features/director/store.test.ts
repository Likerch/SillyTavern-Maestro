import { describe, expect, it } from 'vitest';
import { DIRECTOR_FLAGS } from '../../../src/domain/director-flags';
import { defaultDirectorSettings, readDirectorSettings } from '../../../src/features/director/settings';
import type { DirectorSettings } from '../../../src/features/director/settings';
import { emptyDirectorDoc, readDirectorDoc } from '../../../src/features/director/store';
import { createDirectorEnv } from './helpers';

describe('director settings', () => {
    it('fills defaults and repairs junk in place', () => {
        expect(readDirectorSettings({})).toEqual(defaultDirectorSettings());
        const slice = {
            stallTurns: 99,
            every: { economy: -1, balanced: 'x', cinema: 2.6 },
            model: 'yes',
            pictures: 0,
            userWeight: 7,
        } as unknown as Partial<DirectorSettings>;
        const read = readDirectorSettings(slice);
        expect(read).toBe(slice);
        expect(read).toEqual({
            stallTurns: 20,
            every: { economy: 0, balanced: 6, cinema: 3 },
            model: true,
            pictures: true,
            userWeight: 2,
        });
        expect(readDirectorSettings({ userWeight: 0.66 }).userWeight).toBe(0.7);
        expect(readDirectorSettings({ userWeight: -1 }).userWeight).toBe(0);
        expect(readDirectorSettings({ stallTurns: 1, every: null } as never)).toMatchObject({
            stallTurns: 2,
            every: { economy: 0, balanced: 6, cinema: 4 },
        });
    });
});

describe('director document', () => {
    it('reads a stored document and drops junk', () => {
        const doc = readDirectorDoc({
            memory: {
                current: {
                    type: 'combat',
                    confidence: 2,
                    messageIndex: 4,
                    by: 'model',
                    held: 0,
                    fromUserMessage: true,
                },
                candidate: { type: 'drama', confidence: 'x', messageIndex: 6 },
            },
            override: 'social',
            overrideHeld: 2.7,
            explicitHits: -1,
            language: 'en',
            picture: { messageIndex: 4, cues: ['firstAppearance', 'nonsense'] },
            turns: [
                { index: 2, place: 'place:p1', events: 1, known: true, repetition: false, topic: ['меч', 3] },
                { place: 'x' },
                null,
            ],
            seen: ['лиза', 5],
            lastPlace: 'place:p1',
            notes: [
                {
                    at: 1,
                    messageIndex: 5,
                    text: 'Note',
                    source: 'quest',
                    detail: 'Q',
                    reasons: ['loop', 'bad'],
                    nudged: true,
                },
                { text: 'Bad', source: 'nowhere' },
                { source: 'quest' },
            ],
            turnsSinceNote: 3,
            lastCommitted: 4,
        });
        expect(doc.memory).toEqual({
            current: { type: 'combat', confidence: 1, messageIndex: 4, by: 'model', held: 1, fromUserMessage: true },
            candidate: { type: 'drama', confidence: 0.5, messageIndex: 6 },
        });
        expect(doc).toMatchObject({
            override: 'social',
            overrideHeld: 2,
            explicitHits: 0,
            language: 'en',
            picture: { messageIndex: 4, cues: ['firstAppearance'] },
            seen: ['лиза'],
            lastPlace: 'place:p1',
            turnsSinceNote: 3,
            lastCommitted: 4,
        });
        expect(doc.turns).toEqual([
            { index: 2, place: 'place:p1', events: 1, known: true, repetition: false, topic: ['меч'] },
        ]);
        expect(doc.notes).toEqual([
            { at: 1, messageIndex: 5, text: 'Note', source: 'quest', detail: 'Q', reasons: ['loop'], nudged: true },
        ]);
    });

    it('turns anything else into an empty document', () => {
        const doc = readDirectorDoc({ memory: 'x', override: 'picnic', language: 'de', picture: 1, turns: 'x' });
        expect(doc).toMatchObject({ ...emptyDirectorDoc() });
        expect(readDirectorDoc({ memory: { current: { type: 'nope' } } }).memory).toEqual({
            current: null,
            candidate: null,
        });
    });
});

describe('director API', () => {
    it('exposes the static flag catalogue as copies', () => {
        const env = createDirectorEnv();
        const service = env.start();
        const catalogue = service.catalogue();
        expect(catalogue).toEqual(DIRECTOR_FLAGS);
        catalogue[0]!.name = 'changed';
        expect(service.catalogue()[0]?.name).toBe('maestro_scene_dialogue');
        return env.stop();
    });
});
