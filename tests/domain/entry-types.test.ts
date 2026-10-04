import { describe, expect, it } from 'vitest';
import {
    ENTRY_TYPES,
    ENTRY_TYPE_IDS,
    composeContent,
    emptyFields,
    fieldsFromContent,
    isEntryType,
    readTypedMeta,
    sameTypedMeta,
    templateValues,
    withTypedMeta,
} from '../../src/domain/entry-types';

describe('entry type templates', () => {
    it('cover every type with a name field first and unique field ids', () => {
        expect(Object.keys(ENTRY_TYPES).sort()).toEqual([...ENTRY_TYPE_IDS].sort());
        for (const id of ENTRY_TYPE_IDS) {
            const template = ENTRY_TYPES[id];
            expect(template.id).toBe(id);
            expect(template.fields[0]?.id).toBe('name');
            const ids = template.fields.map((field) => field.id);
            expect(new Set(ids).size).toBe(ids.length);
        }
        expect(isEntryType('place')).toBe(true);
        expect(isEntryType('planet')).toBe(false);
        expect(isEntryType(3)).toBe(false);
    });

    it('reads typed meta defensively', () => {
        expect(readTypedMeta(null)).toBeNull();
        expect(readTypedMeta([])).toBeNull();
        expect(readTypedMeta({ type: 'planet' })).toBeNull();
        expect(readTypedMeta({ type: 'place' })).toEqual({ type: 'place', fields: {} });
        expect(readTypedMeta({ type: 'place', typeFields: { name: 'Rome', size: 3, extra: 'x' } })).toEqual({
            type: 'place',
            fields: { name: 'Rome', extra: 'x' },
        });
        expect(readTypedMeta({ type: 'place', typeFields: ['x'] })).toEqual({ type: 'place', fields: {} });
        expect(emptyFields('rule')).toEqual({ name: '', statement: '', scope: '', exceptions: '' });
        expect(templateValues({ type: 'note', fields: { name: 'N' } })).toEqual({ name: 'N', text: '' });
    });

    it('compares metas by type and trimmed values', () => {
        expect(sameTypedMeta(null, null)).toBe(true);
        expect(sameTypedMeta(null, { type: 'note', fields: {} })).toBe(false);
        expect(sameTypedMeta({ type: 'note', fields: {} }, { type: 'rule', fields: {} })).toBe(false);
        expect(
            sameTypedMeta({ type: 'note', fields: { name: 'a ' } }, { type: 'note', fields: { name: 'a', text: '' } }),
        ).toBe(true);
        expect(sameTypedMeta({ type: 'note', fields: { name: 'a' } }, { type: 'note', fields: { name: 'b' } })).toBe(
            false,
        );
    });
});

describe('composeContent and fieldsFromContent', () => {
    it('writes English labels and the values as typed', () => {
        const content = composeContent({
            type: 'character',
            fields: { name: ' Анна ', age: '19', appearance: 'tall\ndark hair', goals: '', unknown: 'x' },
        });
        expect(content).toBe('Character: Анна\nAge: 19\nAppearance:\ntall\ndark hair');
        expect(composeContent({ type: 'note', fields: { text: 'Only text' } })).toBe('Text: Only text');
        expect(composeContent({ type: 'note', fields: {} })).toBe('');
    });

    it('reads fields back from composed content', () => {
        const meta = {
            type: 'place' as const,
            fields: { name: 'Silver Tower', kind: 'tower', description: 'Tall.\nOld.', secrets: 'A door' },
        };
        expect(fieldsFromContent('place', composeContent(meta))).toEqual({ ...emptyFields('place'), ...meta.fields });
        expect(fieldsFromContent('note', 'Free text\nNote: Hi\nText: body\nmore: lines')).toEqual({
            name: 'Hi',
            text: 'body\nmore: lines',
        });
        expect(fieldsFromContent('rule', 'nothing here')).toEqual(emptyFields('rule'));
    });
});

describe('withTypedMeta', () => {
    it('merges into extensions.maestro and keeps other keys', () => {
        const meta = { type: 'item' as const, fields: { name: 'Sword' } };
        expect(withTypedMeta(undefined, meta)).toEqual({ maestro: { type: 'item', typeFields: { name: 'Sword' } } });
        const canon = { lorebook_localizer: { v: 1 }, maestro: { kind: 'override', status: 'active' } };
        const merged = withTypedMeta(canon, meta);
        expect(merged).toEqual({
            lorebook_localizer: { v: 1 },
            maestro: { kind: 'override', status: 'active', type: 'item', typeFields: { name: 'Sword' } },
        });
        expect(canon.maestro).toEqual({ kind: 'override', status: 'active' });
    });

    it('removes the type and drops what it emptied', () => {
        expect(withTypedMeta({ maestro: { kind: 'pin', type: 'note', typeFields: {} } }, null)).toEqual({
            maestro: { kind: 'pin' },
        });
        expect(withTypedMeta({ other: 1, maestro: { type: 'note', typeFields: {} } }, null)).toEqual({ other: 1 });
        expect(withTypedMeta({ maestro: {} }, null)).toEqual({ maestro: {} });
        expect(withTypedMeta({}, null)).toEqual({});
        expect(withTypedMeta(undefined, null)).toBeUndefined();
        expect(withTypedMeta({ maestro: 'junk' }, null)).toEqual({});
    });
});
