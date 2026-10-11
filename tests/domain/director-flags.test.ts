import { describe, expect, it } from 'vitest';
import {
    DIRECTOR_FLAGS,
    FLAG_EXPLICIT,
    FLAG_PICTURE,
    REPLY_LENGTH,
    buildDirectorFlags,
    climaxWords,
    replyLength,
    dominantLanguage,
    languageFlag,
    pictureBudget,
    pictureMoment,
    replyFlag,
    sceneFlag,
} from '../../src/domain/director-flags';
import { SCENE_KINDS } from '../../src/domain/director-scene';

describe('director flags: catalogue', () => {
    it('lists every flag once with its i18n keys', () => {
        const names = DIRECTOR_FLAGS.map((flag) => flag.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual([
            'maestro_scene_dialogue',
            'maestro_scene_combat',
            'maestro_scene_intimate',
            'maestro_scene_exploration',
            'maestro_scene_timeskip',
            'maestro_scene_social',
            'maestro_scene_drama',
            'maestro_explicit',
            'maestro_lang_ru',
            'maestro_lang_en',
            'maestro_picture_moment',
            'maestro_reply_short',
            'maestro_reply_medium',
            'maestro_reply_long',
        ]);
        expect(DIRECTOR_FLAGS[0]).toEqual({
            name: 'maestro_scene_dialogue',
            titleKey: 'm13.flag.scene_dialogue',
            descriptionKey: 'm13.flag.scene_dialogue.hint',
        });
        for (const flag of DIRECTOR_FLAGS) expect(flag.name).toMatch(/^maestro_[a-z_]+$/);
    });

    it('every flag a state can produce is in the catalogue', () => {
        const names = new Set(DIRECTOR_FLAGS.map((flag) => flag.name));
        for (const scene of SCENE_KINDS) {
            for (const name of Object.keys(
                buildDirectorFlags({ scene, explicit: true, language: 'ru', picture: true }),
            )) {
                expect(names.has(name), name).toBe(true);
            }
        }
        expect(names.has(languageFlag('en'))).toBe(true);
        expect(names.has(FLAG_EXPLICIT) && names.has(FLAG_PICTURE)).toBe(true);
    });
});

describe('director flags: building', () => {
    it('sets the scene, the reply length, explicit, language and picture flags to "1"', () => {
        expect(buildDirectorFlags({ scene: 'combat', explicit: false, language: 'ru', picture: false })).toEqual({
            maestro_scene_combat: '1',
            maestro_reply_short: '1',
            maestro_lang_ru: '1',
        });
        expect(buildDirectorFlags({ scene: 'intimate', explicit: true, language: 'en', picture: true })).toEqual({
            maestro_scene_intimate: '1',
            maestro_reply_long: '1',
            maestro_explicit: '1',
            maestro_lang_en: '1',
            maestro_picture_moment: '1',
        });
        expect(buildDirectorFlags({ scene: null, explicit: false, language: 'de', picture: false })).toEqual({});
        expect(sceneFlag('drama')).toBe('maestro_scene_drama');
        expect(replyFlag(REPLY_LENGTH.exploration)).toBe('maestro_reply_long');
    });
});

describe('director flags: soft reply length and mixed scenes (1.22)', () => {
    const base = { explicit: false, language: null, picture: false } as const;

    it('a conversation is medium, not short', () => {
        expect(REPLY_LENGTH.dialogue).toBe('medium');
        expect(replyLength({ ...base, scene: 'dialogue' })).toBe('medium');
    });

    it('the length waits for a sure decision: confidence ≥ 0.7 held a second turn, or ≥ 0.85 at once', () => {
        expect(replyLength({ ...base, scene: 'combat', confidence: 0.6, held: 5 })).toBeNull();
        expect(replyLength({ ...base, scene: 'combat', confidence: 0.75, held: 1 })).toBeNull();
        expect(replyLength({ ...base, scene: 'combat', confidence: 0.75, held: 2 })).toBe('short');
        expect(replyLength({ ...base, scene: 'combat', confidence: 0.9, held: 1 })).toBe('short');
        // The user's own choice of the type sets it at once.
        expect(replyLength({ ...base, scene: 'combat', confidence: 0.1, held: 1, byUser: true })).toBe('short');
        expect(buildDirectorFlags({ ...base, scene: 'combat', confidence: 0.75, held: 1 })).toEqual({
            maestro_scene_combat: '1',
        });
    });

    it('a mixed scene sends both types and the longer length', () => {
        expect(replyLength({ ...base, scene: 'combat', secondary: 'intimate', confidence: 0.9, held: 1 })).toBe('long');
        expect(replyLength({ ...base, scene: 'combat', secondary: 'dialogue', confidence: 0.9, held: 1 })).toBe(
            'medium',
        );
        expect(
            buildDirectorFlags({ ...base, scene: 'dialogue', secondary: 'intimate', confidence: 0.9, held: 2 }),
        ).toEqual({ maestro_scene_dialogue: '1', maestro_scene_intimate: '1', maestro_reply_long: '1' });
        // The same type twice is one type.
        expect(buildDirectorFlags({ ...base, scene: 'drama', secondary: 'drama' })).toEqual({
            maestro_scene_drama: '1',
            maestro_reply_medium: '1',
        });
    });
});

describe('director flags: language', () => {
    it('tells Russian from English by letters', () => {
        expect(dominantLanguage(['Привет, как дела у тебя сегодня?'])).toBe('ru');
        expect(dominantLanguage(['Hello there, how are you doing today?'])).toBe('en');
        expect(dominantLanguage(['Hi'])).toBeNull();
        expect(dominantLanguage(['Привет мир hello world mixed text here'])).toBeNull();
        expect(dominantLanguage([])).toBeNull();
    });
});

describe('director flags: picture moments', () => {
    it('counts distinct climax words', () => {
        expect(climaxWords('Наконец-то! Наконец, впервые за годы, раздался взрыв.')).toBe(3);
        expect(climaxWords('A breathtaking view, majestic towers.')).toBe(2);
        expect(climaxWords('Обычный вечер.')).toBe(0);
    });

    it('reads the Anlas budget from NAI Studio settings', () => {
        expect(pictureBudget(null)).toBe('unknown');
        expect(pictureBudget({})).toBe('unknown');
        expect(pictureBudget({ anlas: { freeOnly: true } })).toBe('free');
        expect(pictureBudget({ anlas: { freeOnly: false }, markers: { allowPaid: false } })).toBe('free');
        expect(pictureBudget({ anlas: { freeOnly: false } })).toBe('free');
        expect(pictureBudget({ anlas: { freeOnly: false }, markers: { allowPaid: true } })).toBe('paid');
        expect(pictureBudget({ markers: { allowPaid: true } })).toBe('free');
    });

    it('never in economy, key moments in balanced, more in cinema, stricter when paid', () => {
        const first = { cues: ['firstAppearance'] as const, climax: 0 };
        expect(pictureMoment({ ...first, mode: 'economy', budget: 'free' })).toBe(false);
        expect(pictureMoment({ ...first, mode: 'balanced', budget: 'free' })).toBe(true);
        expect(pictureMoment({ ...first, mode: 'balanced', budget: 'paid' })).toBe(false);
        expect(
            pictureMoment({ cues: ['firstAppearance', 'placeChange'], climax: 0, mode: 'balanced', budget: 'paid' }),
        ).toBe(true);
        const climax = { cues: ['climax'] as const, climax: 1 };
        expect(pictureMoment({ ...climax, mode: 'balanced', budget: 'unknown' })).toBe(false);
        expect(pictureMoment({ ...climax, mode: 'cinema', budget: 'unknown' })).toBe(true);
        expect(pictureMoment({ ...climax, mode: 'cinema', budget: 'paid' })).toBe(false);
        expect(pictureMoment({ cues: [], climax: 5, mode: 'balanced', budget: 'paid' })).toBe(true);
        expect(pictureMoment({ cues: [], climax: 0, mode: 'cinema', budget: 'free' })).toBe(false);
    });
});
