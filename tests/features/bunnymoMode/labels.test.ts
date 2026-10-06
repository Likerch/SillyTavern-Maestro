// How BunnyMo mode's journal records read (plan-2 §3 «Понятные уведомления»): its kinds have labels in both languages,
// the pack selection reads «Какие паки работают: все → только выбранные», and a character sheet (CarrotKernel markup)
// stays under «Подробнее» as a whole.
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import {
    BUNNYMO_MODE_STRINGS,
    SELECTION_TARGET,
    SHEET_TARGET,
    bunnymoModeModule,
} from '../../../src/features/bunnymoMode';
import type { I18n } from '../../../src/shared/contracts';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...BUNNYMO_MODE_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M35b labels', () => {
    it('has the same keys and placeholders in both languages', () => {
        const en = Object.keys(BUNNYMO_MODE_STRINGS.en).sort();
        expect(Object.keys(BUNNYMO_MODE_STRINGS.ru).sort()).toEqual(en);
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const key of en) {
            expect(key.startsWith('m35b.') || key.startsWith('kind.') || key.startsWith('target.'), key).toBe(true);
            expect(placeholders(BUNNYMO_MODE_STRINGS.ru[key] ?? ''), key).toEqual(
                placeholders(BUNNYMO_MODE_STRINGS.en[key]!),
            );
        }
    });

    it('names its kinds and describes its targets in both languages', () => {
        expect(bunnymoModeModule.targets?.map((spec) => spec.target)).toEqual([SELECTION_TARGET, SHEET_TARGET]);
        for (const locale of ['en', 'ru'] as const) {
            for (const kind of ['bunnymo.packSelection', 'bunnymo.sheet']) {
                const label = BUNNYMO_MODE_STRINGS[locale][`kind.${kind}`];
                expect(label, `${locale} ${kind}`).toBeTruthy();
                expect(label).not.toContain(kind);
            }
            for (const spec of bunnymoModeModule.targets ?? []) {
                const keys = [
                    spec.labelKey ?? `target.${spec.target}`,
                    ...Object.values(spec.fields ?? {}).map((field) => field.labelKey),
                ];
                for (const key of keys) expect(BUNNYMO_MODE_STRINGS[locale][key], `${locale} ${key}`).toBeTruthy();
            }
        }
    });

    it('shows a pack selection in words and keeps sheet markup out of the main body', () => {
        const labels = createLabels();
        labels.register(bunnymoModeModule.targets ?? []);
        const i18n = i18nFor('ru');
        expect(
            describeChange(
                {
                    target: SELECTION_TARGET,
                    ref: { chatId: 'c1' },
                    before: { mode: 'all' },
                    after: { mode: 'only', books: ['BunnyMo Species', 'BunnyMo MBTI'] },
                },
                labels,
                i18n,
            ),
        ).toEqual({
            label: 'Паки BunnyMo в чате',
            rows: [
                { label: 'Какие паки работают', kind: 'changed', before: 'все', after: 'только выбранные' },
                { label: 'Выбранные паки', kind: 'added', after: 'BunnyMo Species, BunnyMo MBTI' },
            ],
        });
        expect(
            describeChange(
                {
                    target: SHEET_TARGET,
                    ref: { book: 'Archives', uid: 3 },
                    before: '<Name:Mira>\n<BunnymoTags><SPECIES:ELF></BunnymoTags>',
                    after: '<Name:Mira>\n<BunnymoTags><SPECIES:HUMAN></BunnymoTags>',
                },
                labels,
                i18n,
            ),
        ).toBeNull();
    });
});
