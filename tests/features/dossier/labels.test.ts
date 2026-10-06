// How the dossier reads (plan-2 §3 «Понятные уведомления»): every kind and journal target has a label in both
// languages, the Russian texts carry no storage jargon, and a typical change shows names in words while keys, NAI tags,
// canon text and the parts of «Оформить» stay in «Подробнее».
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { DOSSIER_STRINGS, dossierModule } from '../../../src/features/dossier';
import {
    ALIAS_TARGET,
    CANON_TARGET,
    ENTRY_TARGET,
    FIX_FILE_KIND,
    FIX_KIND,
    NOTE_KIND,
    NOTE_TARGET,
    PLACE_ENTRY_TARGET,
    PASSPORT_TARGET,
    PLACE_TARGET,
    SPREAD_KIND,
} from '../../../src/features/dossier/actions';
import {
    PROMOTE_KIND,
    STYLE_UP_KIND,
    STYLE_UP_PART_TARGET,
    STYLE_UP_TARGET,
} from '../../../src/features/dossier/style-up';
import type { I18n, JournalChange } from '../../../src/shared/contracts';

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...DOSSIER_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

const KINDS = [FIX_KIND, FIX_FILE_KIND, SPREAD_KIND, NOTE_KIND, STYLE_UP_KIND, PROMOTE_KIND];
const TARGETS = [
    ENTRY_TARGET,
    CANON_TARGET,
    PASSPORT_TARGET,
    PLACE_TARGET,
    ALIAS_TARGET,
    NOTE_TARGET,
    PLACE_ENTRY_TARGET,
    STYLE_UP_TARGET,
    STYLE_UP_PART_TARGET,
];

describe('M7 labels', () => {
    it('has the same keys and placeholders in both languages, none empty', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(Object.keys(DOSSIER_STRINGS.ru).sort()).toEqual(Object.keys(DOSSIER_STRINGS.en).sort());
        for (const [key, text] of Object.entries(DOSSIER_STRINGS.en)) {
            expect(text, key).not.toBe('');
            expect(placeholders(DOSSIER_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });

    it('names every kind and describes the nine journal targets', () => {
        expect(dossierModule.targets?.map((spec) => spec.target).sort()).toEqual([...TARGETS].sort());
        for (const locale of ['en', 'ru'] as const) {
            for (const kind of KINDS) {
                const label = DOSSIER_STRINGS[locale][`kind.${kind}`];
                expect(label, `${locale} ${kind}`).toBeTruthy();
                expect(label).not.toContain(kind);
                expect(label).not.toMatch(/\bM\d+\b/);
            }
            for (const target of TARGETS) {
                expect(DOSSIER_STRINGS[locale][`target.${target}`], `${locale} ${target}`).toBeTruthy();
            }
        }
    });

    it('keeps module codes and storage jargon out of the Russian texts', () => {
        for (const [key, text] of Object.entries(DOSSIER_STRINGS.ru)) {
            expect(text, key).not.toMatch(/\bP13\b|\bM\d+\b/);
            expect(text, key).not.toMatch(/\bCK\b/);
            expect(text, key).not.toMatch(/алиас|стек[аеу]?\b/i);
        }
    });

    it('asks about a namesake with the world model’s buttons', () => {
        const ru = DOSSIER_STRINGS.ru;
        expect([ru['m7.fix.sameAs.being'], ru['m7.fix.apart.being']]).toEqual(['Тот же', 'Другой']);
        expect([ru['m7.fix.sameAs.place'], ru['m7.fix.apart.place']]).toEqual(['То же место', 'Другое место']);
    });

    it('shows names in words and leaves keys, tags, canon text and «Оформить» parts to the details', () => {
        const labels = createLabels();
        labels.register(dossierModule.targets ?? []);
        const i18n = i18nFor('ru');
        const read = (change: Omit<JournalChange, 'ref'>) => describeChange({ ...change, ref: {} }, labels, i18n);

        expect(
            read({ target: PASSPORT_TARGET, before: { aliases: ['Lyra'] }, after: { aliases: ['Lyra', 'Лиса'] } }),
        ).toEqual({
            label: 'Внешность для картинок',
            rows: [{ label: 'Другие имена', kind: 'changed', before: 'Lyra', after: 'Lyra, Лиса' }],
        });
        expect(read({ target: PLACE_TARGET, before: { name: 'Таверна' }, after: { name: 'Корчма' } })).toEqual({
            label: 'Место',
            rows: [{ label: 'Название', kind: 'changed', before: 'Таверна', after: 'Корчма' }],
        });
        expect(
            read({
                target: ALIAS_TARGET,
                before: null,
                after: { alias: 'Лиса', entity: 'character:лира', name: 'Лира' },
            }),
        ).toEqual({
            label: 'Прозвище в этом чате',
            rows: [
                { label: 'Прозвище', kind: 'added', after: 'Лиса' },
                { label: 'Кто это', kind: 'added', after: 'Лира' },
            ],
        });

        // Technical only: the card's title and description say it in words.
        expect(
            read({ target: PASSPORT_TARGET, before: { slots: { body: '' } }, after: { slots: { body: 'scar' } } }),
        ).toBeNull();
        expect(
            read({ target: ENTRY_TARGET, before: { key: ['Лира'] }, after: { key: ['Лира', '/Лир(а|ы)/i'] } }),
        ).toBeNull();
        expect(read({ target: CANON_TARGET, before: { content: 'Lyra.' }, after: { content: 'Healer.' } })).toBeNull();
        expect(read({ target: NOTE_TARGET, before: null, after: 'Открой Workshop DES…' })).toBeNull();
        expect(read({ target: STYLE_UP_TARGET, before: null, after: { keys: ['Мира'], content: 'x' } })).toBeNull();
        expect(read({ target: STYLE_UP_PART_TARGET, before: null, after: '<Name:Мира>' })).toBeNull();
    });

    it('words a key fix in Russian with the names it adds', () => {
        const t = i18nFor('ru').t;
        expect(t('m7.fix.keys.title', { entry: 'Лира', names: '«Лисичка»' })).toBe(
            'Запись «Лира» будет откликаться и на «Лисичка»',
        );
        expect(t('m7.fix.keys.applied', { entry: 'Лира', names: '«Лисичка»' })).toBe(
            'Запись «Лира» теперь откликается и на «Лисичка».',
        );
    });
});
