// How the assistant's journal records read (plan-2 §3): every kind it journals has a label, every journal target a
// description with labels in both languages, and a change shows «было → стало» in words while paths, keys and regex
// patterns stay out of the main body.
import { describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { ASSISTANT_TARGETS, assistantModule, M33_STRINGS, SETTING_KIND } from '../../../src/features/assistant';
import { UNDO_TARGETS } from '../../../src/features/assistant/tools/write';
import type { I18n, JournalChange } from '../../../src/shared/contracts';
import { UI_STRINGS } from '../../../src/ui/views/strings';

const KINDS = [
    SETTING_KIND,
    'assistant.module',
    'assistant.autonomy',
    'assistant.mechanicChat',
    'assistant.regexCreate',
    'assistant.regexToggle',
];

function i18nFor(locale: 'en' | 'ru'): I18n {
    const strings: Record<string, string> = { ...CORE_STRINGS[locale], ...UI_STRINGS[locale], ...M33_STRINGS[locale] };
    return {
        t: (key, params) =>
            (strings[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
                params && name in params ? String(params[name]) : match,
            ),
        register: () => undefined,
        locale: () => locale,
    };
}

describe('M33 labels', () => {
    it('has the same keys and placeholders in both languages', () => {
        const en = Object.keys(M33_STRINGS.en).sort();
        expect(Object.keys(M33_STRINGS.ru).sort()).toEqual(en);
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const key of en) {
            expect(key.startsWith('m33.') || key.startsWith('kind.') || key.startsWith('target.'), key).toBe(true);
            expect(placeholders(M33_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(M33_STRINGS.en[key]!));
        }
    });

    it('names every kind it journals, in words', () => {
        for (const kind of KINDS) {
            for (const locale of ['en', 'ru'] as const) {
                const label = M33_STRINGS[locale][`kind.${kind}`];
                expect(label, `${locale} ${kind}`).toBeTruthy();
                expect(label).not.toContain(kind);
                expect(label).not.toMatch(/\bM\d+\b/);
            }
        }
    });

    it('describes every journal target with labels in both languages', () => {
        expect(assistantModule.targets).toBe(ASSISTANT_TARGETS);
        const targets = ASSISTANT_TARGETS.map((spec) => spec.target).sort();
        expect(targets).toEqual(['assistant.setting', ...Object.values(UNDO_TARGETS)].sort());
        for (const spec of ASSISTANT_TARGETS) {
            const keys = [
                spec.labelKey ?? `target.${spec.target}`,
                ...Object.values(spec.fields ?? {}).map((f) => f.labelKey),
            ];
            for (const key of keys) {
                expect(M33_STRINGS.en[key], `en ${key}`).toBeTruthy();
                expect(M33_STRINGS.ru[key], `ru ${key}`).toBeTruthy();
            }
        }
    });

    it('shows a change in words and keeps paths, keys and patterns out of the main body', () => {
        const labels = createLabels();
        labels.register(ASSISTANT_TARGETS);
        const i18n = i18nFor('ru');
        const show = (change: JournalChange) => describeChange(change, labels, i18n);

        expect(
            show({
                target: 'assistant.setting',
                ref: { module: 'director', path: 'pacing.every' },
                before: 4,
                after: 6,
            }),
        ).toEqual({ label: 'Настройка модуля', rows: [{ label: '', kind: 'changed', before: '4', after: '6' }] });
        expect(show({ target: UNDO_TARGETS.module, ref: { key: 'director' }, before: true, after: false })).toEqual({
            label: 'Модуль Maestro',
            rows: [{ label: '', kind: 'changed', before: 'включён', after: 'выключен' }],
        });
        expect(
            show({ target: UNDO_TARGETS.mechanicChat, ref: { chatId: 'c', id: 'hp' }, before: false, after: true }),
        ).toEqual({
            label: 'Механика в этом чате',
            rows: [{ label: '', kind: 'changed', before: 'выключена', after: 'включена' }],
        });
        expect(
            show({ target: UNDO_TARGETS.autonomy, ref: { kind: 'canon.fact' }, before: 'ask', after: 'auto' }),
        ).toEqual({
            label: 'Уровень автономии',
            rows: [{ label: '', kind: 'changed', before: 'Спросить', after: 'Само' }],
        });
        expect(
            show({
                target: UNDO_TARGETS.regex,
                ref: { op: 'toggle', scriptId: 'a1', name: 'Trim' },
                before: { disabled: false },
                after: { disabled: true },
            }),
        ).toEqual({
            label: 'Регекс SillyTavern',
            rows: [{ label: 'Состояние', kind: 'changed', before: 'включён', after: 'выключен' }],
        });
        const created = show({
            target: UNDO_TARGETS.regex,
            ref: { op: 'create', scriptId: 'uuid-1', name: 'No asterisks' },
            before: null,
            after: {
                scriptName: 'No asterisks',
                findRegex: '/\\*+/g',
                replaceString: '',
                placement: [2],
                disabled: false,
            },
        });
        expect(created).toEqual({
            label: 'Регекс SillyTavern',
            rows: [
                { label: 'Название', kind: 'added', after: 'No asterisks' },
                { label: 'Где действует', kind: 'added', after: 'ответы модели' },
                { label: 'Состояние', kind: 'added', after: 'включён' },
            ],
        });
        expect(JSON.stringify(created)).not.toContain('\\*');
    });
});
