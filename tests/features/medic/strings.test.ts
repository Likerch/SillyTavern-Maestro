// Labels of M3's action kinds and journal targets (plan-2 §3 «Понятные уведомления»).
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { medicModule } from '../../../src/features/medic';
import { PREFILL_KIND, PREFILL_TARGET } from '../../../src/features/medic/prefill';
import { REPAIR_KIND, TRACKER_TARGET } from '../../../src/features/medic/tracker-repair';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('M3 strings', () => {
    const { en, ru } = medicModule.i18n!;

    it('has every string in both languages with the same placeholders', () => {
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        for (const [key, text] of Object.entries(en)) expect(placeholders(ru[key]!), key).toEqual(placeholders(text));
    });

    it('names its action kinds and journal targets', () => {
        for (const kind of [REPAIR_KIND, PREFILL_KIND]) {
            expect(en[`kind.${kind}`], kind).toBeTruthy();
            expect(ru[`kind.${kind}`], kind).toBeTruthy();
        }
        const targets = medicModule.targets ?? [];
        expect(targets.map((spec) => spec.target).sort()).toEqual([TRACKER_TARGET, PREFILL_TARGET].sort());
        for (const spec of targets) {
            const keys = [spec.labelKey ?? `target.${spec.target}`, spec.valueLabelKey].filter(Boolean) as string[];
            for (const key of keys) {
                expect(en[key], key).toBeTruthy();
                expect(ru[key], key).toBeTruthy();
            }
        }
    });

    it('shows the prefill fix in words and keeps the tracker under «Подробнее»', () => {
        const i18n = createI18n(() => 'ru');
        i18n.register(CORE_STRINGS);
        i18n.register(medicModule.i18n!);
        const labels = createLabels();
        labels.register(medicModule.targets ?? []);
        const role = describeChange(
            { target: PREFILL_TARGET, ref: { preset: 'P', identifier: 'x' }, before: 'assistant', after: 'user' },
            labels,
            i18n,
        );
        expect(role).toEqual({
            label: 'Блок пресета',
            rows: [{ label: 'Роль', kind: 'changed', before: 'модель (assistant)', after: 'ты (user)' }],
        });
        const tracker = describeChange(
            { target: TRACKER_TARGET, ref: {}, before: { record: null }, after: { record: { infoBox: '{}' } } },
            labels,
            i18n,
        );
        expect(tracker).toBeNull();
    });
});
