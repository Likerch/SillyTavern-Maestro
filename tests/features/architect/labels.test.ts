// How the architect's consent reads (plan-2 §3 «Понятные уведомления»): its kind has a label in both languages, the
// consent target is described, and a change shows the fact itself while sources, keys and refs stay in «Подробнее».
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { ARCHITECT_STRINGS, CONSENT_KIND, CONSENT_TARGET, architectModule } from '../../../src/features/architect';
import type { I18n } from '../../../src/shared/contracts';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...ARCHITECT_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M20 labels', () => {
    it('keeps the placeholders of every text in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(ARCHITECT_STRINGS.en)) {
            expect(key.startsWith('m20.') || key.startsWith('kind.') || key.startsWith('target.'), key).toBe(true);
            expect(placeholders(ARCHITECT_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });

    it('names its kind and describes its target in both languages', () => {
        expect(architectModule.targets?.map((spec) => spec.target)).toEqual([CONSENT_TARGET]);
        for (const locale of ['en', 'ru'] as const) {
            const label = ARCHITECT_STRINGS[locale][`kind.${CONSENT_KIND}`];
            expect(label, locale).toBeTruthy();
            expect(label).not.toMatch(/\bM\d+\b/);
            for (const spec of architectModule.targets ?? []) {
                const keys = [
                    spec.labelKey ?? `target.${spec.target}`,
                    ...Object.values(spec.fields ?? {}).map((field) => field.labelKey),
                ];
                for (const key of keys) expect(ARCHITECT_STRINGS[locale][key], `${locale} ${key}`).toBeTruthy();
            }
        }
    });

    it('shows the fact of a consent and keeps its sources out of the main body', () => {
        const labels = createLabels();
        labels.register(architectModule.targets ?? []);
        const consent = {
            id: 'd1',
            keys: ['scar'],
            text: 'Мира носит шрам на левой щеке.',
            sources: [
                { owner: 'lore', ref: 'World#1', tokens: 9 },
                { owner: 'qvink', ref: 'qvink_memory_short', tokens: 9 },
            ],
            keep: 'qvink_memory_short',
            at: 1,
        };
        const shown = describeChange(
            { target: CONSENT_TARGET, ref: { id: 'd1' }, before: null, after: consent },
            labels,
            i18nFor('ru'),
        );
        expect(shown).toEqual({
            label: 'Повтор факта',
            rows: [{ label: 'Факт', kind: 'added', after: 'Мира носит шрам на левой щеке.' }],
        });
        expect(JSON.stringify(shown)).not.toContain('qvink_memory_short');
    });
});
