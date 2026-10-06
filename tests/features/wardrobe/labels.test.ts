// How wardrobe changes read (plan-2 §3 «Понятные уведомления»): kinds and targets are named in both languages, a card
// speaks of clothes and pictures (NAI tags only under «Подробнее»), an automatic change is announced the way the story
// says it («Anna переоделась: «Шёлковое платье»») and outfit changes of one turn fold into one notice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import {
    DES_FIELD_UNDO_TARGET,
    WARDROBE_KINDS,
    WARDROBE_STRINGS,
    WARDROBE_UNDO_TARGET,
    WARDROBE_WEAR_KIND,
    wardrobeModule,
} from '../../../src/features/wardrobe';
import type { I18n } from '../../../src/shared/contracts';
import { createWardrobeEnv } from './helpers';
import type { WardrobeEnv } from './helpers';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...WARDROBE_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M27 labels', () => {
    it('keeps the placeholders of every text in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(WARDROBE_STRINGS.en)) {
            expect(placeholders(WARDROBE_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
        // No storage words in what a card or the tab says in Russian.
        for (const [key, text] of Object.entries(WARDROBE_STRINGS.ru)) {
            const main = key.startsWith('m27.card.') && !key.startsWith('m27.card.details.');
            if (main || key.startsWith('m27.done.') || key === 'm27.hint') {
                expect(text, key).not.toMatch(/паспорт|слот|clothing|тег/i);
            }
        }
    });

    it('names every kind and describes both targets', () => {
        expect(wardrobeModule.targets?.map((spec) => spec.target)).toEqual([
            WARDROBE_UNDO_TARGET,
            DES_FIELD_UNDO_TARGET,
        ]);
        for (const locale of ['en', 'ru'] as const) {
            for (const kind of [...Object.values(WARDROBE_KINDS), WARDROBE_WEAR_KIND]) {
                const label = WARDROBE_STRINGS[locale][`kind.${kind}`];
                expect(label, `${locale} ${kind}`).toBeTruthy();
                expect(label).not.toContain(kind);
            }
            for (const target of [WARDROBE_UNDO_TARGET, DES_FIELD_UNDO_TARGET]) {
                expect(WARDROBE_STRINGS[locale][`target.${target}`], `${locale} ${target}`).toBeTruthy();
            }
        }
    });

    it('shows outfits and states in words; tags and tracker wordings stay technical', () => {
        const labels = createLabels();
        labels.register(wardrobeModule.targets ?? []);
        const i18n = i18nFor('ru');
        const ref = { op: 'o1', passportId: 'p-anna' };
        expect(
            describeChange(
                {
                    target: WARDROBE_UNDO_TARGET,
                    ref,
                    before: { activeOutfit: '', looks: [] },
                    after: {
                        activeOutfit: 'Шёлковое платье',
                        outfit: { name: 'Шёлковое платье', tags: 'blue silk dress' },
                        looks: ['в синем шёлковом платье'],
                    },
                },
                labels,
                i18n,
            ),
        ).toEqual({
            label: 'Внешность в этом чате',
            rows: [
                { label: 'Наряд', kind: 'changed', before: 'своя одежда', after: 'Шёлковое платье' },
                { label: 'Новый наряд', kind: 'added', after: 'Шёлковое платье' },
            ],
        });
        expect(
            describeChange(
                {
                    target: WARDROBE_UNDO_TARGET,
                    ref,
                    before: { state: null },
                    after: { state: { id: 'wet', tags: 'wet clothes', enabled: true } },
                },
                labels,
                i18n,
            )?.rows,
        ).toEqual([{ label: 'Состояние', kind: 'added', after: 'мокрая одежда' }]);
        expect(
            describeChange(
                {
                    target: DES_FIELD_UNDO_TARGET,
                    ref: { fieldId: 'outfit' },
                    before: null,
                    after: { name: 'Одежда', description: 'Во что персонаж одет прямо сейчас' },
                },
                labels,
                i18n,
            ),
        ).toEqual({ label: 'Поле трекера DES', rows: [{ label: 'Поле', kind: 'added', after: 'Одежда' }] });
    });
});

describe('M27 cards and notices (Russian UI)', () => {
    let env: WardrobeEnv;
    const dressed = (appearance: string) => ({ characters: [{ name: 'Anna', details: { appearance } }] });

    beforeEach(() => {
        vi.useFakeTimers();
        env = createWardrobeEnv('ru');
    });

    afterEach(async () => {
        await env.stop();
        vi.useRealTimers();
    });

    it('tells the outfit change as the story does and keeps the tags for «Подробнее»', async () => {
        await env.start();
        await env.turn(dressed('Высокая, в тёмно-синем шёлковом платье и кожаных сапогах'));
        await env.turn(dressed('в тёмно-синем шёлковом платье, кожаные сапоги'));
        const created = env.autonomy.proposals.at(-1)!;
        expect(created.kind).toBe(WARDROBE_KINDS.outfit);
        expect(created.title).toBe('Anna переоделась: «Шёлковое платье»');
        expect(created.description).toContain('Запомнить это как новый наряд «Шёлковое платье»?');
        expect(created.description).not.toMatch(/silk|dress|тег/i);
        expect(created.details).toMatch(/^Теги для картинок: .*silk dress/);
        expect(created.appliedNotice?.text).toBe('Anna переоделась: «Шёлковое платье» (новый наряд)');
        expect(created.appliedNotice?.group).toBe('m27.outfit');
        expect(created.appliedNotice?.groupText?.(2)).toBe('Переоделись 2 персонажа');
        expect(created.appliedNotice?.groupText?.(5)).toBe('Переоделись 5 персонажей');
        await env.turn(dressed('в одном полотенце'));
        const towel = env.autonomy.proposals.at(-1)!;
        expect(towel.title).toBe('Anna в полотенце');
        expect(towel.appliedNotice?.text).toBe('Anna в полотенце');
    });
});
