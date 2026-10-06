// How the mechanics' journal records read (plan-2 §3 «Понятные уведомления»): every kind has a label in both
// languages, the journal targets are described, values read «было → стало», a definition shows its name while its
// English rules stay under «Подробнее», and DES's stats list is technical as a whole.
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { MECHANICS_DEF_TARGET, MECHANICS_STRINGS, mechanicsModule } from '../../../src/features/mechanics';
import { CHECK_KIND } from '../../../src/features/mechanics/checks';
import { SET_KIND, VALUE_UNDO_TARGET } from '../../../src/features/mechanics/state';
import { CHANGE_KIND, DES_STATS_KIND, DES_STATS_UNDO_TARGET } from '../../../src/features/mechanics/tracking';
import type { I18n } from '../../../src/shared/contracts';

const KINDS = [
    CHANGE_KIND,
    DES_STATS_KIND,
    SET_KIND,
    CHECK_KIND,
    'mechanics.def.create',
    'mechanics.def.update',
    'mechanics.def.remove',
];

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...MECHANICS_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M25 labels', () => {
    it('keeps the placeholders of every text in both languages', () => {
        expect(Object.keys(MECHANICS_STRINGS.ru).sort()).toEqual(Object.keys(MECHANICS_STRINGS.en).sort());
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(MECHANICS_STRINGS.en)) {
            expect(placeholders(MECHANICS_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });

    it('names every kind in words, in both languages', () => {
        for (const kind of KINDS) {
            for (const locale of ['en', 'ru'] as const) {
                const label = MECHANICS_STRINGS[locale][`kind.${kind}`];
                expect(label, `${locale} ${kind}`).toBeTruthy();
                expect(label).not.toContain(kind);
                expect(label).not.toMatch(/\bM\d+\b/);
            }
        }
    });

    it('describes every journal target with labels in both languages', () => {
        expect(mechanicsModule.targets?.map((spec) => spec.target).sort()).toEqual(
            [MECHANICS_DEF_TARGET, VALUE_UNDO_TARGET, DES_STATS_UNDO_TARGET].sort(),
        );
        for (const spec of mechanicsModule.targets ?? []) {
            const keys = [
                spec.labelKey ?? `target.${spec.target}`,
                ...Object.values(spec.fields ?? {}).map((field) => field.labelKey),
            ];
            for (const locale of ['en', 'ru'] as const) {
                for (const key of keys) expect(MECHANICS_STRINGS[locale][key], `${locale} ${key}`).toBeTruthy();
            }
        }
    });

    it('shows values and names in words, keeps rules and DES lists out of the main body', () => {
        const labels = createLabels();
        labels.register(mechanicsModule.targets ?? []);
        const i18n = i18nFor('ru');
        expect(
            describeChange(
                { target: VALUE_UNDO_TARGET, ref: { mechanicId: 'magic', holder: 'Kai' }, before: 50, after: 30 },
                labels,
                i18n,
            ),
        ).toEqual({ label: 'Значение механики', rows: [{ label: '', kind: 'changed', before: '50', after: '30' }] });
        const created = describeChange(
            {
                target: MECHANICS_DEF_TARGET,
                ref: { book: 'Maestro', uid: 4, id: 'magic' },
                before: null,
                after: { uid: 4, comment: 'Магия', content: 'Magic: mana pool, schools of fire and water.' },
            },
            labels,
            i18n,
        );
        expect(created).toEqual({ label: 'Механика', rows: [{ label: 'Название', kind: 'added', after: 'Магия' }] });
        expect(
            describeChange(
                {
                    target: DES_STATS_UNDO_TARGET,
                    ref: { mechanicId: 'hp' },
                    before: { enabled: false, customStats: [] },
                    after: { enabled: true, customStats: [{ id: 'maestro_hp_hp', name: 'Health' }] },
                },
                labels,
                i18n,
            ),
        ).toBeNull();
    });
});
