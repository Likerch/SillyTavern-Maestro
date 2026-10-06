// How the Preset Studio's journal records read (plan-2 §3 «Понятные уведомления»): every journal kind and target has
// a human label in both languages, the module registers its target descriptions, and changes read as
// «Текст блока: было → стало» with identifiers, hashes and anchors left for «Подробнее».
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { createLabels, describeChange } from '../../../src/core/labels';
import { CORE_STRINGS } from '../../../src/core/strings';
import { BINDING_TARGET, LAYER_TARGET } from '../../../src/features/presetStudio/layer';
import { LAYER_STRINGS } from '../../../src/features/presetStudio/layer-strings';
import { PRESET_STUDIO_STRINGS, createPresetStudioModule } from '../../../src/features/presetStudio/module';
import { FILE_TARGET, KEYS_TARGET, PROMPT_TARGET } from '../../../src/features/presetStudio/store';
import { PRESET_JOURNAL_KINDS, PRESET_TARGETS, TARGET_STRINGS } from '../../../src/features/presetStudio/targets';
import type { JournalChange } from '../../../src/shared/contracts';

const TARGETS = [PROMPT_TARGET, KEYS_TARGET, FILE_TARGET, LAYER_TARGET, BINDING_TARGET];

function i18n(locale: 'ru' | 'en') {
    const translations = createI18n(() => locale);
    translations.register(CORE_STRINGS);
    translations.register(PRESET_STUDIO_STRINGS);
    return translations;
}

function describe_(change: Omit<JournalChange, 'ref'> & { ref?: JournalChange['ref'] }, locale: 'ru' | 'en' = 'ru') {
    const labels = createLabels();
    labels.register(PRESET_TARGETS);
    return describeChange({ ref: {}, ...change }, labels, i18n(locale));
}

describe('Preset Studio journal labels', () => {
    it('names every journal kind in both languages, in words', () => {
        expect(PRESET_JOURNAL_KINDS).toContain('preset.layer');
        expect(PRESET_JOURNAL_KINDS).toContain('presetStudio.toggle');
        for (const kind of PRESET_JOURNAL_KINDS) {
            for (const strings of [PRESET_STUDIO_STRINGS.en, PRESET_STUDIO_STRINGS.ru]) {
                const label = strings[`kind.${kind}`];
                expect(label, kind).toBeTruthy();
                expect(label, kind).not.toContain(kind);
                expect(label, kind).not.toMatch(/\bM\d+\b/);
            }
        }
    });

    it('describes every journal target, with labels for the target and its fields in both languages', () => {
        expect(PRESET_TARGETS.map((spec) => spec.target).sort()).toEqual([...TARGETS].sort());
        expect(createPresetStudioModule({}).targets).toBe(PRESET_TARGETS);
        for (const spec of PRESET_TARGETS) {
            const keys = [spec.labelKey ?? `target.${spec.target}`, spec.valueLabelKey];
            for (const field of Object.values(spec.fields ?? {})) keys.push(field.labelKey);
            for (const key of keys.filter((item): item is string => !!item)) {
                expect(PRESET_STUDIO_STRINGS.en[key], key).toBeTruthy();
                expect(PRESET_STUDIO_STRINGS.ru[key], key).toBeTruthy();
            }
        }
        expect(Object.keys(TARGET_STRINGS.ru).sort()).toEqual(Object.keys(TARGET_STRINGS.en).sort());
    });

    it('has every summary of «Твой слой» in both languages, with the same placeholders', () => {
        const keys = [
            ...['add', 'edit', 'on', 'off', 'move', 'key', 'remove', 'removeKey', 'resolve'],
            ...['migrate', 'transfer'].flatMap((what) => ['one', 'few', 'many'].map((form) => `${what}.${form}`)),
        ].map((what) => `m34.layerSvc.journal.${what}`);
        const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const key of keys) {
            expect(LAYER_STRINGS.en[key], key).toBeTruthy();
            expect(params(LAYER_STRINGS.ru[key] ?? ''), key).toEqual(params(LAYER_STRINGS.en[key] ?? ''));
        }
        expect(Object.keys(LAYER_STRINGS.ru).sort()).toEqual(Object.keys(LAYER_STRINGS.en).sort());
    });

    it('shows a block text edit as «Текст блока» and keeps the identifier out of the main body', () => {
        const human = describe_({
            target: PROMPT_TARGET,
            ref: { preset: 'Marinara', part: 'prompt', identifier: 'main' },
            before: { identifier: 'main', name: 'Main', role: 'system', content: 'Пиши кратко.' },
            after: { identifier: 'main', name: 'Main', role: 'user', content: 'Пиши подробно.' },
        });
        expect(human?.label).toBe('Блок пресета');
        expect(human?.rows).toEqual([
            { label: 'Роль', kind: 'changed', before: 'Система', after: 'Пользователь' },
            { label: 'Текст блока', kind: 'changed', before: 'Пиши кратко.', after: 'Пиши подробно.' },
        ]);
    });

    it('reads the block order as «включено N из M»', () => {
        const human = describe_({
            target: PROMPT_TARGET,
            ref: { preset: 'Marinara', part: 'order' },
            before: [
                { identifier: 'main', enabled: true },
                { identifier: 'nsfw', enabled: true },
                { identifier: 'jailbreak', enabled: false },
            ],
            after: [
                { identifier: 'main', enabled: true },
                { identifier: 'nsfw', enabled: false },
                { identifier: 'jailbreak', enabled: false },
            ],
        });
        expect(human?.rows).toEqual([
            { label: 'Блоки в порядке', kind: 'changed', before: 'включено 2 из 3', after: 'включено 1 из 3' },
        ]);
    });

    it('names preset parameters and their options the way the «Параметры» tab does', () => {
        const human = describe_({
            target: KEYS_TARGET,
            ref: { preset: 'Marinara', keys: ['temperature', 'reasoning_effort', 'chat_completion_source'] },
            before: { temperature: 0.7, reasoning_effort: 'low', chat_completion_source: 'openai' },
            after: { temperature: 0.9, reasoning_effort: 'high', chat_completion_source: 'claude' },
        });
        expect(human?.label).toBe('Параметры пресета');
        expect(human?.rows).toEqual([
            { label: 'Температура', kind: 'changed', before: '0.7', after: '0.9' },
            { label: 'Рассуждения', kind: 'changed', before: 'Низкие', after: 'Высокие' },
        ]);
    });

    it('shows a rename by names and keeps version ids for «Подробнее»', () => {
        expect(
            describe_({
                target: FILE_TARGET,
                ref: { op: 'rename', oldName: 'Old', newName: 'New' },
                before: { name: 'Old' },
                after: { name: 'New' },
            })?.rows,
        ).toEqual([{ label: 'Название', kind: 'changed', before: 'Old', after: 'New' }]);
        // A save changes only version ids and hashes: nothing for the main body.
        expect(
            describe_({
                target: FILE_TARGET,
                ref: { op: 'save', name: 'Marinara' },
                before: { version: 'v1', hash: 'a' },
                after: { version: 'v2', hash: 'b' },
            }),
        ).toBeNull();
    });

    it('reads layer operations in words: the change, the block text, the parameter', () => {
        const edit = describe_({
            target: LAYER_TARGET,
            ref: { base: 'Marinara', key: 'edit:main', index: 0 },
            before: null,
            after: { op: 'edit', identifier: 'main', patch: { content: 'Мой текст' }, baseHash: 'x1' },
        });
        expect(edit?.label).toBe('Твой слой');
        expect(edit?.rows).toEqual([
            { label: 'Что изменено', kind: 'added', after: 'правка блока' },
            { label: 'Текст блока', kind: 'added', after: 'Мой текст' },
        ]);
        const key = describe_(
            {
                target: LAYER_TARGET,
                ref: { base: 'Marinara', key: 'key:temperature', index: 1 },
                before: { op: 'key', key: 'temperature', value: 0.7, baseValue: 1 },
                after: { op: 'key', key: 'temperature', value: 0.9, baseValue: 1 },
            },
            'en',
        );
        expect(key?.label).toBe('Your layer');
        expect(key?.rows).toEqual([{ label: 'Value', kind: 'changed', before: '0.7', after: '0.9' }]);
    });
});
