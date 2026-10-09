// M41's strings: every key in both languages, prefixed m41., with the same placeholders; the settings reader.
import { describe, expect, it } from 'vitest';
import { PERSONA_CREATOR_STRINGS } from '../../../src/features/personaCreator';
import {
    defaultPersonaCreatorSettings,
    readPersonaCreatorSettings,
} from '../../../src/features/personaCreator/settings';

describe('M41 strings', () => {
    it('has every key in both languages, all prefixed m41.', () => {
        expect(Object.keys(PERSONA_CREATOR_STRINGS.ru).sort()).toEqual(Object.keys(PERSONA_CREATOR_STRINGS.en).sort());
        for (const key of Object.keys(PERSONA_CREATOR_STRINGS.en)) expect(key.startsWith('m41.')).toBe(true);
    });

    it('uses the same placeholders in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(PERSONA_CREATOR_STRINGS.en)) {
            expect(placeholders(PERSONA_CREATOR_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });
});

describe('M41 settings', () => {
    it('replaces junk with the defaults and keeps the lore budget in bounds', () => {
        expect(readPersonaCreatorSettings({})).toEqual(defaultPersonaCreatorSettings());
        expect(
            readPersonaCreatorSettings({ passport: false, picture: 'yes' as unknown as boolean, loreChars: 1e9 }),
        ).toEqual({ passport: false, picture: true, link: true, loreChars: 40000 });
        expect(readPersonaCreatorSettings({ loreChars: -5 }).loreChars).toBe(0);
        expect(readPersonaCreatorSettings({ loreChars: Number.NaN }).loreChars).toBe(8000);
    });
});
