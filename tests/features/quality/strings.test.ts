// Labels of M12's action kinds and journal targets (plan-2 §3 «Понятные уведомления»).
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { DEFECT_KINDS, qualityModule } from '../../../src/features/quality';
import { CONTINUE_TARGET, SWIPE_TARGET, TEXT_TARGET } from '../../../src/features/quality/service';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('M12 strings', () => {
    const { en, ru } = qualityModule.i18n!;

    it('has every string in both languages with the same placeholders', () => {
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        for (const [key, text] of Object.entries(en)) expect(placeholders(ru[key]!), key).toEqual(placeholders(text));
    });

    it('names every defect kind as an action kind, in story words', () => {
        for (const kind of DEFECT_KINDS) {
            expect(en[`kind.quality.${kind}`], kind).toBeTruthy();
            const label = ru[`kind.quality.${kind}`];
            expect(label, kind).toBeTruthy();
            expect(label, kind).not.toContain('Качество ответа:');
        }
        expect(ru['kind.quality.junk']).toBe('Мусор в ответе');
    });

    it('describes its journal targets', () => {
        const targets = qualityModule.targets ?? [];
        expect(targets.map((spec) => spec.target).sort()).toEqual([CONTINUE_TARGET, SWIPE_TARGET, TEXT_TARGET].sort());
        for (const spec of targets) {
            expect(en[`target.${spec.target}`], spec.target).toBeTruthy();
            expect(ru[`target.${spec.target}`], spec.target).toBeTruthy();
            for (const field of Object.values(spec.fields ?? {})) {
                expect(en[field.labelKey], field.labelKey).toBeTruthy();
                expect(ru[field.labelKey], field.labelKey).toBeTruthy();
            }
        }
    });

    it('shows a cleaned reply as «Текст ответа» and keeps swipes under «Подробнее»', () => {
        const i18n = createI18n(() => 'ru');
        i18n.register(CORE_STRINGS);
        i18n.register(qualityModule.i18n!);
        const labels = createLabels();
        labels.register(qualityModule.targets ?? []);
        const ref = { chatId: 'c', messageIndex: 3, swipeId: 0, kinds: ['junk'] };
        expect(
            describeChange(
                { target: TEXT_TARGET, ref, before: { text: 'Она ушла.<|eot_id|>' }, after: { text: 'Она ушла.' } },
                labels,
                i18n,
            ),
        ).toEqual({
            label: 'Ответ',
            rows: [{ label: 'Текст ответа', kind: 'changed', before: 'Она ушла.<|eot_id|>', after: 'Она ушла.' }],
        });
        expect(
            describeChange(
                { target: SWIPE_TARGET, ref, before: { swipeId: 0 }, after: { note: 'Fix for this reply' } },
                labels,
                i18n,
            ),
        ).toBeNull();
        expect(
            describeChange({ target: CONTINUE_TARGET, ref, before: { text: 'Она' }, after: null }, labels, i18n),
        ).toBeNull();
    });
});
