// Labels of M4's action kinds and journal targets (plan-2 §3 «Понятные уведомления»).
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { tPlural } from '../../../src/core/labels';
import { guardianModule } from '../../../src/features/guardian';
import { DRIFT_KIND, RESTORE_KIND, SETTING_TARGET } from '../../../src/features/guardian/service';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('M4 strings', () => {
    const { en, ru } = guardianModule.i18n!;

    it('has every string in both languages with the same placeholders', () => {
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        for (const [key, text] of Object.entries(en)) expect(placeholders(ru[key]!), key).toEqual(placeholders(text));
    });

    it('names its action kinds and its journal target', () => {
        for (const key of [`kind.${DRIFT_KIND}`, `kind.${RESTORE_KIND}`, `target.${SETTING_TARGET}`]) {
            expect(en[key], key).toBeTruthy();
            expect(ru[key], key).toBeTruthy();
        }
        // Settings values are technical: the whole change stays under «Подробнее».
        expect(guardianModule.targets).toEqual([{ target: SETTING_TARGET, technical: true }]);
    });

    it('counts changed settings in proper Russian', () => {
        const i18n = createI18n(() => 'ru');
        i18n.register(guardianModule.i18n!);
        expect(tPlural(i18n, 'm4.card.title', 1)).toBe('После эталона изменилась 1 настройка — вернуть как было?');
        expect(tPlural(i18n, 'm4.card.title', 3)).toBe('После эталона изменились 3 настройки — вернуть как было?');
        expect(tPlural(i18n, 'm4.card.title', 11)).toBe('После эталона изменилось 11 настроек — вернуть как было?');
    });
});
