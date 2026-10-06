// The registry of how journal targets read to the user (plan-2 §3): human rows for described fields, nothing for
// what nobody described, technical targets and unknown fields left to «Подробнее».
import { describe, expect, it } from 'vitest';
import {
    createLabels,
    describeChange,
    formatClip,
    formatEnum,
    formatPlain,
    formatTime,
    kindLabel,
    targetLabel,
    tPlural,
} from '../../src/core/labels';
import { CORE_STRINGS } from '../../src/core/strings';
import type { JournalChange } from '../../src/shared/contracts';
import { createTestI18n } from '../helpers/core-host';

function i18n(locale: 'ru' | 'en' = 'ru') {
    const value = createTestI18n(locale);
    value.register(CORE_STRINGS);
    value.register({
        en: {
            'kind.living.fact': 'New facts about the world',
            'target.living-fact': 'Fact about the world',
            'f.name': 'Name',
            'f.type': 'What it is',
            'f.secret': 'Secret',
            'f.text': 'Text',
            't.type.tradition': 'tradition',
            'n.one': '{count} fact',
            'n.few': '{count} facts',
            'n.many': '{count} facts',
        },
        ru: {
            'kind.living.fact': 'Новые факты о мире',
            'target.living-fact': 'Факт о мире',
            'f.name': 'Название',
            'f.type': 'Что это',
            'f.secret': 'Тайна',
            'f.text': 'Текст',
            't.type.tradition': 'традиция',
            'n.one': '{count} факт',
            'n.few': '{count} факта',
            'n.many': '{count} фактов',
        },
    });
    return value;
}

function registry() {
    const labels = createLabels();
    labels.register([
        {
            target: 'living-fact',
            fields: {
                name: { labelKey: 'f.name' },
                type: { labelKey: 'f.type', format: formatEnum('t.type.') },
                keys: { labelKey: 'f.name', hidden: true },
                secret: { labelKey: 'f.secret' },
            },
        },
        { target: 'note', valueLabelKey: 'f.text' },
        { target: 'canon', technical: true },
    ]);
    return labels;
}

const change = (patch: Partial<JournalChange>): JournalChange => ({
    target: 'living-fact',
    ref: { id: 'lf-1', book: 'Chat canon' },
    before: null,
    after: null,
    ...patch,
});

describe('labels registry', () => {
    it('registers, replaces and removes target specs', () => {
        const labels = createLabels();
        const off = labels.register([{ target: 'a' }]);
        const spec = { target: 'a', technical: true };
        labels.register([spec]);
        expect(labels.target('a')).toBe(spec);
        off();
        expect(labels.target('a')).toBe(spec);
        expect(labels.targets()).toEqual([spec]);
    });

    it('names kinds and targets only when someone did', () => {
        const t = i18n();
        expect(kindLabel(t, 'living.fact')).toBe('Новые факты о мире');
        expect(kindLabel(t, 'wardrobe.outfit')).toBeUndefined();
        expect(targetLabel(t, registry(), 'living-fact')).toBe('Факт о мире');
        expect(targetLabel(t, registry(), 'note')).toBeUndefined();
        expect(tPlural(t, 'n', 1)).toBe('1 факт');
        expect(tPlural(t, 'n', 3)).toBe('3 факта');
        expect(tPlural(t, 'n', 11)).toBe('11 фактов');
        expect(tPlural(i18n('en'), 'n', 2)).toBe('2 facts');
    });

    it('formats values in words', () => {
        const t = i18n();
        expect(formatPlain(true, t)).toBe('да');
        expect(formatPlain(false, i18n('en'))).toBe('no');
        expect(formatPlain(['a', 1, null, 'b'], t)).toBe('a, 1, b');
        expect(formatPlain({ a: 1 }, t)).toBe('');
        expect(formatPlain(Number.NaN, t)).toBe('');
        expect(formatEnum('t.type.')('tradition', t)).toBe('традиция');
        expect(formatEnum('t.type.')('unknown', t)).toBe('unknown');
        expect(formatEnum('t.type.')(3, t)).toBe('3');
        expect(formatClip(6)('один два три', t)).toBe('один…');
        expect(formatTime(0, t)).toBe('');
        expect(formatTime(Date.UTC(2026, 9, 6, 12, 0), t)).toMatch(/6/);
    });
});

describe('describeChange', () => {
    it('shows described fields of a new fact in words; ids, keys and unknown fields stay out', () => {
        const human = describeChange(
            change({ after: { name: 'Праздник урожая', type: 'tradition', keys: ['урожай'], quote: 'x', id: 'lf-1' } }),
            registry(),
            i18n(),
        );
        expect(human).toEqual({
            label: 'Факт о мире',
            rows: [
                { label: 'Название', kind: 'added', after: 'Праздник урожая' },
                { label: 'Что это', kind: 'added', after: 'традиция' },
            ],
        });
    });

    it('shows a change as before → after and skips unchanged fields', () => {
        const human = describeChange(
            change({
                before: { name: 'Праздник', type: 'tradition', secret: false },
                after: { name: 'Праздник урожая', type: 'tradition', secret: true },
            }),
            registry(),
            i18n(),
        );
        expect(human?.rows).toEqual([
            { label: 'Название', kind: 'changed', before: 'Праздник', after: 'Праздник урожая' },
            { label: 'Тайна', kind: 'changed', before: 'нет', after: 'да' },
        ]);
        expect(describeChange(change({ before: { name: 'a' }, after: null }), registry(), i18n())?.rows).toEqual([
            { label: 'Название', kind: 'removed', before: 'a' },
        ]);
    });

    it('formats a meaningful null (a reset to the default) instead of treating it as absent', () => {
        const labels = createLabels();
        const reset = (value: unknown) => (value === null ? 'как задано в модуле' : String(value));
        labels.register([
            { target: 'level', valueLabelKey: 'f.text', nullable: true, format: reset },
            { target: 'entry', fields: { depth: { labelKey: 'f.name', nullable: true, format: reset } } },
        ]);
        expect(describeChange(change({ target: 'level', before: 'auto', after: null }), labels, i18n())?.rows).toEqual([
            { label: 'Текст', kind: 'changed', before: 'auto', after: 'как задано в модуле' },
        ]);
        expect(
            describeChange(change({ target: 'entry', before: { depth: 1 }, after: { depth: null } }), labels, i18n())
                ?.rows,
        ).toEqual([{ label: 'Название', kind: 'changed', before: '1', after: 'как задано в модуле' }]);
    });

    it('labels plain values; leaves technical and undescribed targets to the details', () => {
        expect(describeChange(change({ target: 'note', before: 'old', after: 'new' }), registry(), i18n())).toEqual({
            rows: [{ label: 'Текст', kind: 'changed', before: 'old', after: 'new' }],
        });
        expect(describeChange(change({ target: 'canon', before: 'a', after: 'b' }), registry(), i18n())).toBeNull();
        expect(describeChange(change({ target: 'unknown', before: 'a', after: 'b' }), registry(), i18n())).toBeNull();
        expect(describeChange(change({ after: { quote: 'only unknown' } }), registry(), i18n())).toBeNull();
        expect(
            describeChange(change({ target: 'note', before: 'same', after: 'same' }), registry(), i18n()),
        ).toBeNull();
        expect(describeChange(change({}), undefined, i18n())).toBeNull();
    });
});
