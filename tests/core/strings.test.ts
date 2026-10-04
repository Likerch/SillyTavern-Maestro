import { describe, expect, it } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import { CORE_STRINGS } from '../../src/core/strings';

describe('core strings', () => {
    it('has every key in both languages, all prefixed core.', () => {
        expect(Object.keys(CORE_STRINGS.ru).sort()).toEqual(Object.keys(CORE_STRINGS.en).sort());
        for (const key of Object.keys(CORE_STRINGS.en)) expect(key.startsWith('core.')).toBe(true);
    });

    it('uses the same placeholders in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(CORE_STRINGS.en)) {
            expect(placeholders(CORE_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });

    it('fills placeholders through i18n', () => {
        const i18n = createI18n(() => 'ru');
        i18n.register(CORE_STRINGS);
        expect(i18n.t('core.autonomy.failed', { title: 'Факт' })).toBe('Не получилось применить: Факт');
        expect(i18n.missingRussian()).toEqual([]);
    });
});
