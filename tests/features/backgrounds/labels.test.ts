// How background changes read (plan-2 §3 «Понятные уведомления»): every kind has a label in both languages, the chat
// background target is described, and a change shows background titles while file paths and URLs stay in «Подробнее».
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import {
    BACKGROUNDS_STRINGS,
    CHAT_BG_TARGET,
    GENERATE_KIND,
    PICK_KIND,
    SET_KIND,
    backgroundsModule,
} from '../../../src/features/backgrounds';
import type { I18n } from '../../../src/shared/contracts';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...BACKGROUNDS_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M29 labels', () => {
    it('keeps the placeholders of every text in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(BACKGROUNDS_STRINGS.en)) {
            expect(key.startsWith('m29.') || key.startsWith('kind.') || key.startsWith('target.'), key).toBe(true);
            expect(placeholders(BACKGROUNDS_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
        // File names are details, not part of the summaries.
        for (const key of ['m29.journal.set', 'm29.journal.pick', 'm29.journal.bound', 'm29.journal.generate']) {
            expect(BACKGROUNDS_STRINGS.ru[key], key).not.toContain('{file}');
        }
    });

    it('names every kind and describes its target in both languages', () => {
        expect(backgroundsModule.targets?.map((spec) => spec.target)).toEqual([CHAT_BG_TARGET]);
        for (const locale of ['en', 'ru'] as const) {
            for (const kind of [SET_KIND, PICK_KIND, GENERATE_KIND]) {
                const label = BACKGROUNDS_STRINGS[locale][`kind.${kind}`];
                expect(label, `${locale} ${kind}`).toBeTruthy();
                expect(label).not.toContain(kind);
            }
            expect(BACKGROUNDS_STRINGS[locale][`target.${CHAT_BG_TARGET}`], locale).toBeTruthy();
        }
    });

    it('shows background titles and hides raw values', () => {
        const labels = createLabels();
        labels.register(backgroundsModule.targets ?? []);
        const i18n = i18nFor('ru');
        expect(
            describeChange(
                { target: CHAT_BG_TARGET, ref: { chatId: 'c1' }, before: 'tavern day', after: 'tavern night' },
                labels,
                i18n,
            ),
        ).toEqual({
            label: 'Фон чата',
            rows: [{ label: '', kind: 'changed', before: 'tavern day', after: 'tavern night' }],
        });
        const own = describeChange(
            {
                target: CHAT_BG_TARGET,
                ref: { chatId: 'c1' },
                before: 'url("/user/images/Mira/forest.png")',
                after: 'cave',
            },
            labels,
            i18n,
        );
        expect(own?.rows).toEqual([{ label: '', kind: 'changed', before: 'другой фон', after: 'cave' }]);
        expect(
            describeChange({ target: CHAT_BG_TARGET, ref: {}, before: null, after: 'cave' }, labels, i18n)?.rows,
        ).toEqual([{ label: '', kind: 'added', after: 'cave' }]);
    });
});
