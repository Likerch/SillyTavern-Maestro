import { describe, expect, it } from 'vitest';
import { VOICES_STRINGS } from '../../../src/features/voices/strings';

describe('M15 voices strings', () => {
    it('have the same keys in English and Russian, none empty, with their own prefix', () => {
        expect(Object.keys(VOICES_STRINGS.ru).sort()).toEqual(Object.keys(VOICES_STRINGS.en).sort());
        for (const [key, text] of Object.entries(VOICES_STRINGS.ru)) expect(text, key).not.toBe('');
        expect(Object.keys(VOICES_STRINGS.en).every((key) => key.startsWith('m15.'))).toBe(true);
    });

    it('name every trimming step and budget source the tab shows', () => {
        for (const step of ['goals', 'bonds', 'speech', 'state', 'extras', 'cards']) {
            expect(VOICES_STRINGS.en).toHaveProperty(`m15.trim.${step}`);
        }
        for (const source of ['architect', 'cap']) expect(VOICES_STRINGS.ru).toHaveProperty(`m15.budget.${source}`);
    });
});
