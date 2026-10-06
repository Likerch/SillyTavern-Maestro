// M25 visibility (plan-2 §6.А): presets fill every field (В21/В22 defaults), the mechanic's and the attribute's own
// fields override them, stored data is cleaned, places and reveal decide what the player sees, word bands and the
// mention line for the model.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_WORDS,
    mentionLine,
    modelKnows,
    normalizeVisibilityInput,
    playerSees,
    presetVisibility,
    resolveVisibility,
    shownIn,
    VISIBILITY_PLACES,
    withPreset,
    wordsFor,
} from '../../src/domain/mechanics-visibility';
import type { VisibleAttribute } from '../../src/domain/mechanics-visibility';

const health: VisibleAttribute = { kind: 'number', min: 0, max: 100 };
const coins: VisibleAttribute = { kind: 'number', min: 0 };
const mood: VisibleAttribute = { kind: 'scale', levels: ['cold', 'neutral', 'warm'] };
const schools: VisibleAttribute = { kind: 'list' };

describe('presets', () => {
    it('game: numbers and bars everywhere, the model gets values and numbers; status block and narrator off', () => {
        expect(presetVisibility('game', health)).toEqual({
            preset: 'game',
            prompt: 'value',
            mention: 'numbers',
            places: { hud: true, strip: true, narrator: false, statusBlock: false, des: true, dossier: true },
            view: 'bar',
        });
        expect(presetVisibility('game', coins).view).toBe('number');
        expect(presetVisibility('game').view).toBe('number');
    });

    it('book: words, no HUD values; hidden like book once revealed; secret nowhere', () => {
        const book = presetVisibility('book', health);
        expect(book).toMatchObject({ prompt: 'value', mention: 'words', view: 'words' });
        expect(book.places).toMatchObject({
            hud: false,
            strip: true,
            dossier: true,
            narrator: false,
            statusBlock: false,
        });
        expect(presetVisibility('book', schools).view).toBe('number');
        expect(presetVisibility('hidden', mood)).toMatchObject({ prompt: 'value', mention: 'none', view: 'words' });
        expect(presetVisibility('hidden', schools).view).toBe('number');
        const secret = presetVisibility('secret', health);
        expect(secret).toMatchObject({ prompt: 'none', mention: 'none', view: 'hidden' });
        expect(VISIBILITY_PLACES.every((place) => !secret.places[place])).toBe(true);
    });
});

describe('resolveVisibility', () => {
    it('defaults to game, takes the mechanic preset and its fields, then the attribute', () => {
        expect(resolveVisibility(undefined, health).preset).toBe('game');
        expect(resolveVisibility({ visibility: { preset: 'book' } }, health).view).toBe('words');
        const mechanic = { visibility: { preset: 'book' as const, prompt: 'words' as const, places: { hud: true } } };
        expect(resolveVisibility(mechanic, health)).toMatchObject({
            prompt: 'words',
            places: { hud: true, strip: true },
        });
        const own = { ...health, visibility: { mention: 'none' as const, places: { strip: false } } };
        expect(resolveVisibility(mechanic, own)).toMatchObject({
            prompt: 'words',
            mention: 'none',
            places: { strip: false },
        });
        // An attribute preset of its own ignores the mechanic's fields.
        const secretAttr = { ...health, visibility: { preset: 'secret' as const } };
        expect(resolveVisibility(mechanic, secretAttr)).toMatchObject({ preset: 'secret', prompt: 'none' });
        expect(resolveVisibility(mechanic).preset).toBe('book');
    });

    it('treats the old visible:false as secret and keeps word bands of the mechanic', () => {
        expect(resolveVisibility(undefined, { ...health, visible: false }).preset).toBe('secret');
        const words = [{ upTo: 30, label: 'weak' }];
        expect(resolveVisibility({ visibility: { preset: 'book', words } }, health).words).toEqual(words);
        expect(resolveVisibility(undefined, { ...health, visibility: { view: 'icon' } }).view).toBe('icon');
    });
});

describe('stored data', () => {
    it('keeps only known fields and values', () => {
        expect(normalizeVisibilityInput('book')).toEqual({ preset: 'book' });
        expect(normalizeVisibilityInput('loud')).toBeUndefined();
        expect(normalizeVisibilityInput(null)).toBeUndefined();
        expect(normalizeVisibilityInput({})).toBeUndefined();
        expect(
            normalizeVisibilityInput({
                preset: 'hidden',
                prompt: 'words',
                mention: 'numbers',
                view: 'bar',
                places: { hud: true, strip: 'yes', nowhere: true },
                words: [
                    { upTo: 10, label: ' low ', display: ' мало ' },
                    { level: 'warm', label: 'warm' },
                    { label: '' },
                    3,
                ],
                extra: 1,
            }),
        ).toEqual({
            preset: 'hidden',
            prompt: 'words',
            mention: 'numbers',
            view: 'bar',
            places: { hud: true },
            words: [
                { upTo: 10, label: 'low', display: 'мало' },
                { level: 'warm', label: 'warm' },
            ],
        });
        expect(normalizeVisibilityInput({ places: {}, words: [] })).toBeUndefined();
    });

    it('a preset picked now drops the fields but keeps the words', () => {
        expect(withPreset('book', { preset: 'game', prompt: 'none', words: [{ label: 'x' }] })).toEqual({
            preset: 'book',
            words: [{ label: 'x' }],
        });
        expect(withPreset('secret')).toEqual({ preset: 'secret' });
    });
});

describe('where the player sees it', () => {
    it('honours places, hidden-until-revealed and secret', () => {
        const game = presetVisibility('game', health);
        expect(shownIn(game, 'hud')).toBe(true);
        expect(shownIn(game, 'narrator')).toBe(false);
        const hidden = presetVisibility('hidden', health);
        expect(shownIn(hidden, 'strip')).toBe(false);
        expect(shownIn(hidden, 'strip', true)).toBe(true);
        expect(shownIn(presetVisibility('secret'), 'strip', true)).toBe(false);
        expect(shownIn({ ...game, view: 'hidden' }, 'hud')).toBe(false);
        expect(playerSees(game)).toBe(true);
        expect(playerSees(hidden)).toBe(false);
        expect(playerSees(hidden, true)).toBe(true);
        expect(playerSees(presetVisibility('secret'))).toBe(false);
        expect(modelKnows(hidden)).toBe(true);
        expect(modelKnows(presetVisibility('secret'))).toBe(false);
    });
});

describe('words', () => {
    it('numbers by the attribute bands, the open band, the last band', () => {
        const visibility = {
            words: [
                { upTo: 10, label: 'dying', display: 'при смерти' },
                { upTo: 50, label: 'wounded' },
                { label: 'fine' },
            ],
        };
        expect(wordsFor(health, visibility, 5)).toEqual({ label: 'dying', display: 'при смерти' });
        expect(wordsFor(health, visibility, '40')).toEqual({ label: 'wounded' });
        expect(wordsFor(health, visibility, 90)).toEqual({ label: 'fine' });
        expect(wordsFor(health, { words: [{ upTo: 10, label: 'low' }] }, 90)).toEqual({ label: 'low' });
        expect(wordsFor(health, visibility, 'many')).toBeNull();
        expect(wordsFor(health, visibility, null)).toBeNull();
    });

    it('default bands for bounded numbers, none for open ones', () => {
        expect(wordsFor(health, {}, 0)).toEqual({ label: DEFAULT_WORDS[0]!.label, band: 0 });
        expect(wordsFor(health, {}, 15)).toEqual({ label: 'very low', band: 1 });
        expect(wordsFor(health, {}, 60)).toEqual({ label: 'moderate', band: 3 });
        expect(wordsFor(health, {}, 100)).toEqual({ label: 'full', band: 5 });
        expect(wordsFor(health, {}, 140)).toEqual({ label: 'full', band: 5 });
        expect(wordsFor(coins, {}, 5)).toBeNull();
    });

    it('scales by level words or the level itself; lists and texts as they are', () => {
        const words = { words: [{ level: 'Warm', label: 'friendly', display: 'тепло' }] };
        expect(wordsFor(mood, words, 'warm')).toEqual({ label: 'friendly', display: 'тепло' });
        expect(wordsFor(mood, { words: [{ level: 'cold', label: 'icy' }] }, 'cold')).toEqual({ label: 'icy' });
        expect(wordsFor(mood, {}, 'neutral')).toEqual({ label: 'neutral' });
        expect(wordsFor(schools, {}, ['fire', 'air'])).toEqual({ label: 'fire, air' });
        expect(wordsFor({ kind: 'text' }, {}, '')).toBeNull();
    });
});

describe('mentionLine', () => {
    it('tells the model how changes may be mentioned', () => {
        expect(
            mentionLine([
                { mention: 'numbers', names: ['mana'] },
                { mention: 'words', names: ['attitude', 'trust'] },
                { mention: 'none', names: [] },
            ]),
        ).toBe(
            'Changes: mana may be stated with numbers (e.g. "-15 mana"); attitude, trust in words only, never as numbers.',
        );
        expect(mentionLine([{ mention: 'none', names: ['suspicion'] }])).toBe(
            'Changes: suspicion never mentioned; let them show only through behaviour.',
        );
        expect(mentionLine([])).toBe('');
    });
});
