import { describe, expect, it } from 'vitest';
import {
    DEFAULT_OVERRIDE_FIELDS,
    WI_ENTRY_TEMPLATE,
    baseDriftOf,
    baseSlot,
    buildCanonEntry,
    buildExportBook,
    canonBookName,
    canonItemsOf,
    copyValue,
    findItemForBase,
    freeUid,
    itemOverrideFields,
    jsonClone,
    materializeOverride,
    overrideFields,
    readCanonMeta,
    scanMarker,
    uniqueBookName,
    withTemplate,
} from '../../src/domain/canon-book';
import type { CanonItemLike, CanonMetaLike, ExportLabels } from '../../src/domain/canon-book';
import { entryContentHash } from '../../src/domain/roles-meta';

function meta(fields: Partial<CanonMetaLike> = {}): CanonMetaLike {
    return { kind: 'addition', status: 'active', origin: 'user', createdAt: 1, updatedAt: 2, ...fields };
}

function item(uid: number, fields: Partial<CanonMetaLike>, entry: Record<string, unknown> = {}): CanonItemLike {
    return { uid, meta: meta(fields), entry: { uid, key: [], content: '', ...entry } };
}

describe('canon book names', () => {
    it('are stable per chat, prefixed and 8 characters long', () => {
        const name = canonBookName('Seraphina - 2026-10-04@12h00m00s');
        expect(name).toMatch(/^Maestro · канон · [0-9a-z]{8}$/);
        expect(canonBookName('Seraphina - 2026-10-04@12h00m00s')).toBe(name);
        expect(canonBookName('other chat')).not.toBe(name);
    });
});

describe('copies and templates', () => {
    it('copyValue rebuilds arrays and plain objects', () => {
        const source = { key: ['a'], filter: { names: ['x'] }, n: 1 };
        const copy = copyValue(source);
        expect(copy).toEqual(source);
        expect(copy.key).not.toBe(source.key);
        expect(copy.filter.names).not.toBe(source.filter.names);
        expect(jsonClone({ a: [1] })).toEqual({ a: [1] });
        expect(jsonClone(undefined)).toBeUndefined();
    });

    it('freeUid finds the lowest free uid', () => {
        expect(freeUid({})).toBe(0);
        expect(freeUid({ '0': {}, '1': {}, '3': {} })).toBe(2);
    });

    it('withTemplate fills missing fields without sharing arrays with the template', () => {
        const entry = withTemplate({ content: 'Hi', custom: [1] });
        expect(entry.content).toBe('Hi');
        expect(entry.order).toBe(100);
        expect(entry.key).toEqual([]);
        expect(entry.key).not.toBe(WI_ENTRY_TEMPLATE.key);
        expect(entry.custom).toEqual([1]);
        expect(entry.characterFilter).toEqual({ isExclude: false, names: [], tags: [] });
    });
});

describe('override fields', () => {
    it('come from the list, the entry or the defaults, never bookkeeping or disable', () => {
        expect(overrideFields(['content', 'uid', 'disable', 'order', 'content'])).toEqual(['content', 'order']);
        expect(overrideFields(undefined, { content: 'x', world: 'W', extensions: {}, key: [] })).toEqual([
            'content',
            'key',
        ]);
        expect(overrideFields([])).toEqual([...DEFAULT_OVERRIDE_FIELDS]);
        expect(overrideFields('x')).toEqual([...DEFAULT_OVERRIDE_FIELDS]);
    });

    it('items without a list override only the default fields that hold a value', () => {
        expect(itemOverrideFields({ fields: ['order'] }, { content: 'x' })).toEqual(['order']);
        expect(itemOverrideFields({}, { content: 'New', key: [], keysecondary: ['b'], comment: ' ' })).toEqual([
            'content',
            'keysecondary',
        ]);
    });

    it('materializeOverride assigns fresh values and keeps the base identity', () => {
        const base = Object.freeze({ uid: 4, world: 'World', key: Object.freeze(['old']), content: 'Old', order: 10 });
        const override = { uid: 9, world: 'Canon', key: ['new'], content: 'New', disable: true, order: 50 };
        const result = materializeOverride(base, override, ['key', 'content', 'disable', 'missing', 'uid']);
        expect(result).toEqual({ uid: 4, world: 'World', key: ['new'], content: 'New', order: 10 });
        expect(result.key).not.toBe(override.key);
        const stored = materializeOverride({ uid: 1, content: 'a' }, { content: 'b' }, ['content']);
        expect(stored).toEqual({ uid: 1, content: 'b' });
    });
});

describe('items', () => {
    it('readCanonMeta validates and keeps unknown fields', () => {
        expect(readCanonMeta({ kind: 'nope' })).toBeNull();
        expect(readCanonMeta(null)).toBeNull();
        expect(readCanonMeta({ kind: 'override' })).toBeNull();
        const parsed = readCanonMeta({
            kind: 'override',
            status: 'weird',
            origin: 'living',
            type: 'place',
            base: { world: 'W', uid: 2, contentHash: 'h', content: 'Then' },
            sourceMessage: 5,
            survivedTurns: 2,
            pinWhen: 'always',
            fields: ['content', 3],
            future: { x: 1 },
            createdAt: 'x',
        });
        expect(parsed).toEqual({
            kind: 'override',
            status: 'active',
            origin: 'living',
            type: 'place',
            base: { world: 'W', uid: 2, contentHash: 'h', content: 'Then' },
            sourceMessage: 5,
            survivedTurns: 2,
            pinWhen: 'always',
            fields: ['content'],
            future: { x: 1 },
            createdAt: 0,
            updatedAt: 0,
        });
        expect(readCanonMeta({ kind: 'pin', base: { world: 'W', uid: 1.5 } })).toBeNull();
        expect(readCanonMeta({ kind: 'suppress', base: { world: 'W', uid: 1 } })?.base?.contentHash).toBe('');
    });

    it('canonItemsOf lists items by uid; hand-made entries are user additions, broken meta is skipped', () => {
        const items = canonItemsOf({
            entries: {
                '3': { uid: 3, content: 'c', extensions: { maestro: meta() } },
                '1': {
                    content: 'a',
                    extensions: { maestro: meta({ kind: 'pin', base: { world: 'W', uid: 1, contentHash: '' } }) },
                },
                '2': { uid: 2, content: 'plain' },
                '5': { uid: 5, content: 'typed', extensions: { maestro: { type: 'place', typeFields: {} } } },
                '6': { uid: 6, extensions: { maestro: meta({ kind: 'override' }) } },
                x: { extensions: { maestro: meta() } },
                '4': 'junk',
            },
        });
        expect(items.map((entry) => entry.uid)).toEqual([1, 2, 3, 5]);
        expect(items[1]!.meta).toMatchObject({ kind: 'addition', status: 'active', origin: 'user' });
        expect(canonItemsOf(null)).toEqual([]);
    });

    it('finds the item occupying a base slot', () => {
        expect(baseSlot('override')).toBe('replace');
        expect(baseSlot('suppress')).toBe('replace');
        expect(baseSlot('pin')).toBe('pin');
        expect(baseSlot('addition')).toBeNull();
        const base = { world: 'W', uid: 1, contentHash: '' };
        const items = [item(0, { kind: 'suppress', base }), item(1, { kind: 'pin', base })];
        expect(findItemForBase(items, 'override', { world: 'W', uid: 1 })?.uid).toBe(0);
        expect(findItemForBase(items, 'pin', { world: 'W', uid: 1 })?.uid).toBe(1);
        expect(findItemForBase(items, 'pin', { world: 'W', uid: 2 })).toBeUndefined();
        expect(findItemForBase(items, 'addition', { world: 'W', uid: 1 })).toBeUndefined();
        expect(findItemForBase(items, 'override', undefined)).toBeUndefined();
    });

    it('buildCanonEntry stores meta in extensions and disables everything but additions', () => {
        const base = { world: 'W', uid: 1, contentHash: 'h' };
        const override = buildCanonEntry(
            5,
            { content: 'New', world: 'X', hash: 1, decorators: [], extensions: { other: 1 } },
            meta({ kind: 'override', base }),
            'Override: Castle',
        );
        expect(override).toMatchObject({ uid: 5, content: 'New', disable: true, comment: 'Override: Castle' });
        expect(override.extensions).toEqual({ other: 1, maestro: meta({ kind: 'override', base }) });
        expect('world' in override || 'hash' in override || 'decorators' in override).toBe(false);
        const addition = buildCanonEntry(6, { comment: 'Mine', disable: false }, meta(), 'unused');
        expect(addition).toMatchObject({ uid: 6, comment: 'Mine', disable: false });
    });

    it('scanMarker carries no timestamps', () => {
        expect(scanMarker(item(3, { type: 'place', updatedAt: 99 }))).toEqual({
            kind: 'addition',
            status: 'active',
            origin: 'user',
            canonUid: 3,
            type: 'place',
        });
        expect(scanMarker(item(3, {}))).not.toHaveProperty('type');
    });
});

describe('drift', () => {
    it('reports changed and missing bases', () => {
        const base = { world: 'W', uid: 1, contentHash: entryContentHash({ content: 'Then' }), content: 'Then' };
        const override = item(0, { kind: 'override', base });
        expect(baseDriftOf(override, { content: 'Then' })).toBeNull();
        expect(baseDriftOf(override, { content: 'Now' })).toEqual({ then: 'Then', now: 'Now' });
        expect(baseDriftOf(override, undefined)).toEqual({ then: 'Then', now: '' });
        expect(
            baseDriftOf(item(0, { kind: 'override', base: { ...base, content: undefined } }), { content: 'x' }),
        ).toEqual({
            then: '',
            now: 'x',
        });
        expect(baseDriftOf(item(1, {}), { content: 'x' })).toBeNull();
    });
});

describe('export', () => {
    const labels: ExportLabels = {
        noteTitle: 'Note',
        suppressed: 'Suppressed:',
        overridden: 'Overridden:',
        pinned: 'Pinned:',
        line: (world, uid, comment) => `${world}/${uid}/${comment}`,
    };
    const bases: Record<string, Record<string, unknown>> = {
        'W#1': { uid: 1, comment: 'Castle', content: 'Old castle', key: ['castle'], order: 7, extensions: { x: 1 } },
        'W#2': { uid: 2, comment: 'Road', content: 'Road' },
    };
    const baseOf = (world: string, uid: number) => bases[`${world}#${uid}`] ?? null;

    it('materialises overrides, keeps additions and lists the rest in a disabled note', () => {
        const items = [
            item(0, {}, { comment: 'New fact', content: 'Fact', disable: true, extensions: { maestro: meta(), y: 2 } }),
            item(
                1,
                { kind: 'override', base: { world: 'W', uid: 1, contentHash: '' }, fields: ['content'] },
                {
                    content: 'Ruined castle',
                },
            ),
            item(2, { kind: 'override', base: { world: 'W', uid: 9, contentHash: '' } }, { content: 'Orphan' }),
            item(3, { kind: 'suppress', base: { world: 'W', uid: 2, contentHash: '' } }),
            item(4, { kind: 'pin', base: { world: 'W', uid: 1, contentHash: '' } }),
        ];
        const book = buildExportBook(items, baseOf, labels);
        const entries = Object.values(book.entries);
        expect(entries.map((entry) => entry.uid)).toEqual([0, 1, 2, 3]);
        expect(entries[0]).toMatchObject({
            comment: 'New fact',
            content: 'Fact',
            disable: false,
            extensions: { y: 2 },
        });
        expect(entries[1]).toMatchObject({ comment: 'Castle', content: 'Ruined castle', key: ['castle'], order: 7 });
        expect(entries[1]?.extensions).toEqual({ x: 1 });
        expect(entries[2]).toMatchObject({ content: 'Orphan', disable: false });
        expect(entries[2]).not.toHaveProperty('extensions');
        expect(entries[3]).toMatchObject({ comment: 'Note', disable: true, key: [] });
        expect(entries[3]?.content).toBe(
            'Suppressed:\nW/2/Road\n\nOverridden:\nW/1/Castle\nW/9/\n\nPinned:\nW/1/Castle',
        );
    });

    it('adds no note when nothing needs one', () => {
        expect(Object.keys(buildExportBook([item(0, {}, { content: 'x' })], baseOf, labels).entries)).toEqual(['0']);
    });

    it('picks a free book name', () => {
        expect(uniqueBookName('Chat — канон', ['Other'])).toBe('Chat — канон');
        expect(uniqueBookName('Chat — канон', ['chat — канон', 'Chat — канон (2)'])).toBe('Chat — канон (3)');
    });
});
