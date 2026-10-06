import { describe, expect, it } from 'vitest';
import { LIVING_TYPES } from '../../../src/domain/living-detect';
import { CONFIRM_REASONS } from '../../../src/domain/living-facts';
import { LIVING_STRINGS, livingCanonModule, readLivingSettings } from '../../../src/features/livingCanon';

describe('M26 strings and settings', () => {
    it('have the same keys in English and Russian, none empty', () => {
        expect(Object.keys(LIVING_STRINGS.ru).sort()).toEqual(Object.keys(LIVING_STRINGS.en).sort());
        for (const [key, text] of Object.entries(LIVING_STRINGS.ru)) expect(text, key).not.toBe('');
    });

    it('use their own prefixes and cover every type, reason and proposal body', () => {
        const keys = Object.keys(LIVING_STRINGS.en);
        expect(
            keys.every(
                (key) => key.startsWith('m26.') || key.startsWith('kind.living.') || key === 'target.living-fact',
            ),
        ).toBe(true);
        for (const type of LIVING_TYPES) expect(keys).toContain(`m26.type.${type}`);
        for (const reason of CONFIRM_REASONS) expect(keys).toContain(`m26.reason.${reason}`);
        for (const mode of ['new', 'existing', 'conflict']) expect(keys).toContain(`m26.proposal.${mode}Body`);
        expect(keys).toEqual(expect.arrayContaining(['kind.living.fact', 'kind.living.disputed', 'm26.tab']));
        for (const name of ['capturedMany', 'confirmedMany', 'droppedMany']) {
            for (const form of ['one', 'few', 'many']) expect(keys).toContain(`m26.notice.${name}.${form}`);
        }
    });

    it('describe the living fact target with labels in both languages', () => {
        const spec = livingCanonModule.targets?.find((item) => item.target === 'living-fact');
        expect(spec).toBeDefined();
        for (const field of Object.values(spec?.fields ?? {})) {
            expect(LIVING_STRINGS.en[field.labelKey], field.labelKey).toBeTruthy();
            expect(LIVING_STRINGS.ru[field.labelKey], field.labelKey).toBeTruthy();
        }
        expect(LIVING_STRINGS.ru['target.living-fact']).toBe('Факт о мире');
    });

    it('speak Russian without module ids in what the user reads', () => {
        for (const [key, text] of Object.entries(LIVING_STRINGS.ru)) {
            if (key.startsWith('m26.settings') || key === 'm26.profileTask') continue;
            expect(text, key).not.toMatch(/\bM\d+\b/);
        }
    });

    it('repairs the settings slice in place', () => {
        const slice: Record<string, unknown> = { maxPerTurn: 'x', surviveTurns: -1, extractEvery: 1e9 };
        expect(readLivingSettings(slice)).toEqual({ maxPerTurn: 3, surviveTurns: 10, extractEvery: 200 });
        expect(slice.maxPerTurn).toBe(3);
        expect(readLivingSettings({ maxPerTurn: 2.7, surviveTurns: 0, extractEvery: 0 })).toEqual({
            maxPerTurn: 2,
            surviveTurns: 0,
            extractEvery: 0,
        });
    });
});
