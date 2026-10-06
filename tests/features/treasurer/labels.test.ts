// How the treasurer's journal record reads (plan-2 §3 «Понятные уведомления»): its kind has a label in both
// languages, the mode target is described and a switch shows «Режим Maestro: Сбалансированный → Экономный».
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { ECONOMY_KIND, M21_STRINGS, MODE_TARGET, treasurerModule } from '../../../src/features/treasurer';
import type { I18n } from '../../../src/shared/contracts';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...M21_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M21 labels', () => {
    it('has the same keys and placeholders in both languages', () => {
        const en = Object.keys(M21_STRINGS.en).sort();
        expect(Object.keys(M21_STRINGS.ru).sort()).toEqual(en);
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const key of en) {
            expect(key.startsWith('m21.') || key.startsWith('kind.') || key.startsWith('target.'), key).toBe(true);
            expect(placeholders(M21_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(M21_STRINGS.en[key]!));
        }
    });

    it('names its kind and describes its target in both languages', () => {
        for (const locale of ['en', 'ru'] as const) {
            expect(M21_STRINGS[locale][`kind.${ECONOMY_KIND}`], locale).toBeTruthy();
            expect(M21_STRINGS[locale][`kind.${ECONOMY_KIND}`]).not.toMatch(/\bM\d+\b/);
            for (const spec of treasurerModule.targets ?? []) {
                expect(M21_STRINGS[locale][spec.labelKey ?? `target.${spec.target}`], spec.target).toBeTruthy();
            }
        }
        expect(treasurerModule.targets?.map((spec) => spec.target)).toEqual([MODE_TARGET]);
    });

    it('shows the mode switch in words', () => {
        const labels = createLabels();
        labels.register(treasurerModule.targets ?? []);
        const change = { target: MODE_TARGET, ref: { path: 'core.mode' }, before: 'balanced', after: 'economy' };
        expect(describeChange(change, labels, i18nFor('ru'))).toEqual({
            label: 'Режим Maestro',
            rows: [{ label: '', kind: 'changed', before: 'Сбалансированный', after: 'Экономный' }],
        });
        expect(describeChange(change, labels, i18nFor('en'))?.rows[0]).toMatchObject({
            before: 'Balanced',
            after: 'Economy',
        });
    });
});
