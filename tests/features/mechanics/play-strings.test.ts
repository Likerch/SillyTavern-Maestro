// Strings of the play surfaces and the constructor of plan-2 §6.А: both languages carry the same keys and
// placeholders, every counted phrase has its three forms, every view, place, preset hint and operation has words, and
// the Russian texts are Russian.
import { describe, expect, it } from 'vitest';
import { VALUE_VIEWS, VISIBILITY_PRESETS } from '../../../src/domain/mechanics-visibility';
import { MECHANICS_STRINGS, PLAY_STRINGS } from '../../../src/features/mechanics/strings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('play strings', () => {
    it('have the same keys and placeholders in both languages', () => {
        expect(Object.keys(PLAY_STRINGS.ru).sort()).toEqual(Object.keys(PLAY_STRINGS.en).sort());
        for (const [key, text] of Object.entries(PLAY_STRINGS.en)) {
            expect(placeholders(PLAY_STRINGS.ru[key]!), key).toEqual(placeholders(text));
        }
    });

    it('count turns and story time in three forms and name every view, set and operation', () => {
        for (const base of [
            'm25.play.turns',
            'm25.play.time.minute',
            'm25.play.time.hour',
            'm25.play.time.day',
            'm25.play.time.week',
        ]) {
            for (const form of ['one', 'few', 'many']) expect(PLAY_STRINGS.ru[`${base}.${form}`], base).toBeTruthy();
        }
        for (const view of VALUE_VIEWS) expect(PLAY_STRINGS.ru[`m25.ctor.vis.view.${view}`]).toBeTruthy();
        for (const preset of VISIBILITY_PRESETS) {
            expect(PLAY_STRINGS.ru[`m25.ctor.vis.hint.${preset}`]).toBeTruthy();
            expect(MECHANICS_STRINGS.ru[`m25.visibility.${preset}`]).toBeTruthy();
        }
        for (const op of ['add', 'sub', 'set', 'mul', 'push', 'pull'])
            expect(PLAY_STRINGS.ru[`m25.ctor.action.op.value.${op}`]).toBeTruthy();
        for (const group of ['status', 'item', 'combat'])
            for (const op of ['push', 'pull'])
                expect(PLAY_STRINGS.ru[`m25.ctor.action.op.${group}.${op}`]).toBeTruthy();
        expect(PLAY_STRINGS.ru['m25.ctor.action.op.reveal.set']).toBeTruthy();
    });

    it('are Russian in Russian (English only in examples of what the model reads)', () => {
        const english = Object.entries(PLAY_STRINGS.ru)
            .filter(([, text]) => /[a-z]{3,}/i.test(text.replace(/\{\w+\}/g, '')) && !/[а-яё]/i.test(text))
            .map(([key]) => key)
            .sort();
        expect(english).toEqual([
            'm25.ctor.action.value.hint',
            'm25.ctor.effect.text.hint',
            'm25.ctor.words.label.hint',
        ]);
    });
});
