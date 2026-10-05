import { describe, expect, it } from 'vitest';
import { ArgError } from '../../src/domain/assistant-write-args';
import {
    changedFields,
    changedNames,
    composedContent,
    defaultTitle,
    entryPatch,
    entryTypedMeta,
    entryView,
    readEntryChanges,
    typeCatalogue,
    typedMetaOf,
} from '../../src/domain/assistant-write-lore';

function codeOf(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof ArgError) return error.code;
        throw error;
    }
    return 'none';
}

describe('readEntryChanges and entryPatch', () => {
    it('reads plain-word fields into ST entry fields', () => {
        const changes = readEntryChanges({
            title: ' Kai ',
            content: '  Kai is a smith.\r\n',
            keys: ['Kai', 'kai', 'Кай'],
            secondaryKeys: 'forge, smith',
            constant: 'true',
            enabled: false,
            position: 'an_top',
            order: 50,
        });
        expect(changes).toEqual({
            title: 'Kai',
            content: 'Kai is a smith.',
            keys: ['Kai', 'Кай'],
            secondaryKeys: ['forge', 'smith'],
            constant: true,
            enabled: false,
            position: 'an_top',
            order: 50,
        });
        expect(entryPatch(changes)).toEqual({
            comment: 'Kai',
            content: 'Kai is a smith.',
            key: ['Kai', 'Кай'],
            keysecondary: ['forge', 'smith'],
            selective: true,
            constant: true,
            disable: true,
            position: 2,
            order: 50,
        });
    });

    it('takes a depth as «in the chat at that depth» unless a position is given', () => {
        expect(readEntryChanges({ depth: 3 })).toEqual({ depth: 3, position: 'at_depth' });
        expect(readEntryChanges({ depth: 3, position: 'before_char' })).toEqual({ depth: 3, position: 'before_char' });
        expect(entryPatch({ depth: 3, position: 'at_depth' })).toEqual({ depth: 3, position: 4 });
        expect(entryPatch({ secondaryKeys: [] })).toEqual({ keysecondary: [] });
        expect(entryPatch({})).toEqual({});
        expect(readEntryChanges({ title: '' })).toEqual({ title: '' });
    });

    it('refuses bad values', () => {
        expect(codeOf(() => readEntryChanges({ position: 'top' }))).toBe('argEnum');
        expect(codeOf(() => readEntryChanges({ depth: -1 }))).toBe('argRange');
        expect(codeOf(() => readEntryChanges({ keys: 5 }))).toBe('argType');
    });
});

describe('typed entries', () => {
    it('builds the typed meta and composes the content', () => {
        const meta = typedMetaOf('character', { name: ' Mira ', age: 30, role: null });
        expect(meta).toEqual({ type: 'character', fields: { name: 'Mira', age: '30' } });
        expect(composedContent(meta)).toBe('Character: Mira\nAge: 30');
        const merged = typedMetaOf('character', { role: 'Captain', age: null }, meta);
        expect(merged).toEqual({ type: 'character', fields: { name: 'Mira', role: 'Captain' } });
        expect(typedMetaOf('place', undefined, meta)).toEqual({ type: 'place', fields: {} });
    });

    it('refuses unknown types, unknown fields and non-text values', () => {
        expect(codeOf(() => typedMetaOf('monster', {}))).toBe('loreBadType');
        expect(codeOf(() => typedMetaOf('item', { colour: 'red' }))).toBe('loreBadField');
        expect(codeOf(() => typedMetaOf('item', { name: { a: 1 } }))).toBe('argType');
    });

    it('lists the types with their fields', () => {
        expect(typeCatalogue()).toMatch(/^character\(name,aliases,role,/);
        expect(typeCatalogue()).toContain('; note(name,text)');
    });

    it('reads the meta stored in an entry', () => {
        expect(entryTypedMeta({ extensions: { maestro: { type: 'note', typeFields: { name: 'N' } } } })).toEqual({
            type: 'note',
            fields: { name: 'N' },
        });
        expect(entryTypedMeta({})).toBeNull();
    });

    it('titles a new entry: given, typed name, first line of the text', () => {
        expect(defaultTitle({ title: 'T' }, null)).toBe('T');
        expect(defaultTitle({}, { type: 'place', fields: { name: 'Harbor' } })).toBe('Harbor');
        expect(defaultTitle({ content: 'First line\nsecond' }, { type: 'place', fields: {} })).toBe('First line');
        expect(defaultTitle({ content: 'x'.repeat(80) }, null)).toBe(`${'x'.repeat(59)}…`);
        expect(defaultTitle({}, null)).toBe('');
    });
});

describe('changedFields and views', () => {
    it('keeps only the fields that differ', () => {
        const entry = { comment: 'Anna', key: ['Anna'], content: 'old', disable: false };
        const patch = { comment: 'Anna', key: ['Anna', 'Ann'], content: 'new', depth: 2 };
        expect(changedFields(entry, patch)).toEqual({
            before: { key: ['Anna'], content: 'old', depth: null },
            after: { key: ['Anna', 'Ann'], content: 'new', depth: 2 },
        });
        expect(changedFields(entry, { extensions: undefined })).toEqual({ before: {}, after: {} });
    });

    it('shows ST fields in plain words', () => {
        expect(
            entryView({
                comment: 'T',
                key: ['k'],
                keysecondary: ['s'],
                constant: false,
                disable: true,
                position: 4,
                depth: 2,
                order: 10,
                content: 'c',
                selective: true,
            }),
        ).toEqual({
            title: 'T',
            keys: ['k'],
            secondaryKeys: ['s'],
            constant: false,
            enabled: false,
            position: 'at_depth',
            depth: 2,
            order: 10,
            content: 'c',
        });
        expect(entryView({ keysecondary: [], position: 7 })).toEqual({ position: 7 });
        expect(changedNames({ content: 'x', disable: false, extensions: {} })).toEqual(['enabled', 'content']);
    });
});
