// Labels of M22's action kinds and journal targets (plan-2 §3 «Понятные уведомления»).
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { createLabels, describeChange } from '../../../src/core/labels';
import { rulesModule } from '../../../src/features/rules';
import { ARCHIVE_DEPTH_KIND, PACK_CHOICE_TARGET, PACK_VERSION_KIND } from '../../../src/features/rules/builtin';
import { QVINK_EXCLUDE_KIND, QVINK_EXCLUDE_TARGET } from '../../../src/features/rules/builtin/qvink';
import { RULE_FLAG_TARGET, RULE_TOGGLE_KIND, ruleSwitchGroup } from '../../../src/features/rules/engine';
import type { JournalChange } from '../../../src/shared/contracts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('M22 strings', () => {
    const { en, ru } = rulesModule.i18n!;

    it('has every string in both languages with the same placeholders', () => {
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        for (const [key, text] of Object.entries(en)) expect(placeholders(ru[key]!), key).toEqual(placeholders(text));
    });

    it('names its action kinds without module tags', () => {
        for (const kind of [RULE_TOGGLE_KIND, QVINK_EXCLUDE_KIND, ARCHIVE_DEPTH_KIND, PACK_VERSION_KIND]) {
            expect(en[`kind.${kind}`], kind).toBeTruthy();
            expect(ru[`kind.${kind}`], kind).toBeTruthy();
            expect(ru[`kind.${kind}`], kind).not.toMatch(/\bCK\b|архив/i);
        }
    });

    it('describes its own targets and leaves lore-entry to M5', () => {
        const targets = (rulesModule.targets ?? []).map((spec) => spec.target).sort();
        expect(targets).toEqual([PACK_CHOICE_TARGET, QVINK_EXCLUDE_TARGET, RULE_FLAG_TARGET].sort());
        for (const target of targets) {
            expect(en[`target.${target}`], target).toBeTruthy();
            expect(ru[`target.${target}`], target).toBeTruthy();
        }
        // M5 «Включить правило» folds its notice into M22's under this group (see doctor/rules.ts).
        expect(ruleSwitchGroup('role.assistantToSystem', true)).toBe('rules.switch:role.assistantToSystem:on');
    });

    it('shows its changes in words', () => {
        const i18n = createI18n(() => 'ru');
        i18n.register(rulesModule.i18n!);
        const labels = createLabels();
        labels.register(rulesModule.targets ?? []);
        const show = (change: JournalChange) => describeChange(change, labels, i18n);
        expect(show({ target: RULE_FLAG_TARGET, ref: { id: 'x' }, before: true, after: false })).toEqual({
            label: 'Правило',
            rows: [{ label: '', kind: 'changed', before: 'включено', after: 'выключено' }],
        });
        expect(show({ target: QVINK_EXCLUDE_TARGET, ref: { index: 3 }, before: false, after: true })).toEqual({
            label: 'Картинка в пересказах Qvink',
            rows: [{ label: '', kind: 'changed', before: 'пересказывается', after: 'не пересказывается' }],
        });
        expect(show({ target: PACK_CHOICE_TARGET, ref: { group: 'g' }, before: null, after: 'MBTI V2' })).toEqual({
            label: 'Версия пака',
            rows: [{ label: '', kind: 'added', after: 'оставить «MBTI V2»' }],
        });
    });
});
