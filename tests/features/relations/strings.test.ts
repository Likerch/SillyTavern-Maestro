import { describe, expect, it } from 'vitest';
import { RELATIONS_STRINGS } from '../../../src/features/relations/strings';

describe('M19 relations strings', () => {
    it('have the same keys in English and Russian, none empty, with their own prefix', () => {
        expect(Object.keys(RELATIONS_STRINGS.ru).sort()).toEqual(Object.keys(RELATIONS_STRINGS.en).sort());
        for (const [key, text] of Object.entries(RELATIONS_STRINGS.ru)) expect(text, key).not.toBe('');
        expect(Object.keys(RELATIONS_STRINGS.en).every((key) => key.startsWith('m19.'))).toBe(true);
        for (const source of ['canon', 'user']) expect(RELATIONS_STRINGS.en).toHaveProperty(`m19.source.${source}`);
    });
});
