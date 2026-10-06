// How world changes read (plan-2 §3, §9): the namesake question in plain Russian with «Тот же» / «Другой», kinds and
// targets named in both languages, nicknames and merges shown by names instead of entity ids.
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import {
    ALIAS_KIND,
    ALIAS_TARGET,
    APART_KIND,
    EXCLUDE_TARGET,
    IDENTITY_TARGET,
    MERGE_KIND,
    MERGE_TARGET,
    SAME_AS_KIND,
    SEPARATE_KIND,
    SEPARATE_TARGET,
    WORLD_STRINGS,
    worldModule,
} from '../../../src/features/world';
import type { I18n } from '../../../src/shared/contracts';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...WORLD_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M7 world labels', () => {
    it('asks about a namesake in plain Russian', () => {
        const t = i18nFor('ru').t;
        const where = t('m7w.where.archive', { book: 'Архив персонажей' });
        expect(t('m7w.sameAs.title.being', { name: 'Офелия', where })).toBe(
            'Офелия здесь — тот же персонаж, что в книге «Архив персонажей»?',
        );
        expect([t('m7w.sameAs.same.being'), t('m7w.sameAs.other.being')]).toEqual(['Тот же', 'Другой']);
        expect(t('m7w.journal.apart.being', { name: 'Офелия', where })).toBe(
            'Запомнил: Офелия здесь — другой персонаж, не тот, что в книге «Архив персонажей»',
        );
    });

    it('names every kind and describes every target in both languages', () => {
        const targets = [ALIAS_TARGET, MERGE_TARGET, SEPARATE_TARGET, IDENTITY_TARGET, EXCLUDE_TARGET];
        expect(worldModule.targets?.map((spec) => spec.target)).toEqual(targets);
        for (const locale of ['en', 'ru'] as const) {
            for (const kind of [MERGE_KIND, ALIAS_KIND, SEPARATE_KIND, SAME_AS_KIND, APART_KIND]) {
                expect(WORLD_STRINGS[locale][`kind.${kind}`], `${locale} ${kind}`).toBeTruthy();
            }
            for (const target of targets) {
                expect(WORLD_STRINGS[locale][`target.${target}`], `${locale} ${target}`).toBeTruthy();
            }
        }
    });

    it('shows nicknames and the card look in words; ids stay technical', () => {
        const labels = createLabels();
        labels.register(worldModule.targets ?? []);
        const i18n = i18nFor('ru');
        expect(
            describeChange(
                { target: ALIAS_TARGET, ref: { alias: 'Рыжая' }, before: null, after: 'character:элизабет' },
                labels,
                i18n,
            ),
        ).toEqual({ label: 'Прозвище в этом чате', rows: [{ label: 'Означает', kind: 'added', after: 'элизабет' }] });
        expect(
            describeChange({ target: EXCLUDE_TARGET, ref: { id: 'npc1' }, before: false, after: true }, labels, i18n),
        ).toEqual({
            label: 'Внешность из карточки',
            rows: [
                {
                    label: 'Внешность из карточки в этом чате',
                    kind: 'changed',
                    before: 'используется',
                    after: 'не используется',
                },
            ],
        });
        expect(
            describeChange(
                { target: IDENTITY_TARGET, ref: {}, before: null, after: 'архив CarrotKernel' },
                labels,
                i18n,
            ),
        ).toBeNull();
    });
});
