import { describe, expect, it } from 'vitest';
import { DIRECTOR_FLAGS } from '../../../src/domain/director-flags';
import { SCENE_KINDS } from '../../../src/domain/director-scene';
import { DIRECTOR_STRINGS } from '../../../src/features/director/strings';

describe('director strings', () => {
    it('have the same keys in English and Russian, none empty, with their own prefixes', () => {
        expect(Object.keys(DIRECTOR_STRINGS.ru).sort()).toEqual(Object.keys(DIRECTOR_STRINGS.en).sort());
        for (const [key, text] of Object.entries(DIRECTOR_STRINGS.ru)) expect(text, key).not.toBe('');
        for (const [key, text] of Object.entries(DIRECTOR_STRINGS.en)) expect(text, key).not.toBe('');
        expect(Object.keys(DIRECTOR_STRINGS.en).every((key) => /^m1[34]\./.test(key))).toBe(true);
    });

    it('cover every flag of the catalogue, every scene type, source, reason and steering kind', () => {
        for (const flag of DIRECTOR_FLAGS) {
            expect(DIRECTOR_STRINGS.en, flag.titleKey).toHaveProperty([flag.titleKey]);
            expect(DIRECTOR_STRINGS.ru, flag.descriptionKey).toHaveProperty([flag.descriptionKey]);
            expect(DIRECTOR_STRINGS.ru, flag.titleKey).toHaveProperty([flag.titleKey]);
            expect(DIRECTOR_STRINGS.en, flag.descriptionKey).toHaveProperty([flag.descriptionKey]);
        }
        for (const type of SCENE_KINDS) expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m13.scene.type.${type}`]);
        for (const source of ['quest', 'thread', 'deadline', 'offscreen', 'mechanic']) {
            expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m14.source.${source}`]);
        }
        for (const reason of ['samePlace', 'noEvents', 'repetition', 'loop']) {
            expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m14.reason.${reason}`]);
        }
        for (const steer of ['ooc', 'request', 'plot', 'long']) {
            expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m14.steer.${steer}`]);
        }
        for (const form of ['one', 'few', 'many'])
            expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m13.scene.held.${form}`]);
        for (const by of ['rules', 'model', 'user']) expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m13.scene.by.${by}`]);
        for (const cue of ['firstAppearance', 'placeChange', 'climax']) {
            expect(DIRECTOR_STRINGS.ru).toHaveProperty([`m13.picture.cue.${cue}`]);
        }
    });
});
