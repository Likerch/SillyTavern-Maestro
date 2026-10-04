import { describe, expect, it } from 'vitest';
import {
    BULK_FIELDS,
    ENTRY_TEMPLATE,
    MAX_COMMENT_LENGTH,
    MIXED,
    POSITION_CHOICES,
    backfillComments,
    bulkValue,
    changedFields,
    cloneJson,
    commonValues,
    contentLength,
    diffEntries,
    diffSize,
    displayIndexOf,
    entryStatus,
    entryTitle,
    expandBulkPatch,
    freeUid,
    isNormalizationFill,
    maxDisplayIndex,
    mirrorBook,
    mirrorPaths,
    normalizedEntry,
    originalEntries,
    patchEntry,
    positionChoice,
    positionLabel,
    positionPatch,
    removeOriginal,
    sameJson,
    setByPath,
    setOriginalValue,
    statusPatch,
    stringList,
    templateEntry,
} from '../../src/domain/lore-studio-entries';
import type { LoreBook, LoreEntry } from '../../src/domain/lore-studio-entries';

const entry = (uid: number, fields: Record<string, unknown> = {}): LoreEntry => ({ uid, ...fields });

describe('JSON helpers', () => {
    it('compares structurally, ignoring key order and absent keys', () => {
        expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
        expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
        expect(sameJson([1, 2], [1, 2, 3])).toBe(false);
        expect(sameJson([1], { 0: 1 })).toBe(false);
        expect(sameJson(null, null)).toBe(true);
        expect(sameJson(null, {})).toBe(false);
        expect(sameJson('a', 'a')).toBe(true);
        expect(sameJson(1, '1')).toBe(false);
    });

    it('clones JSON values and passes undefined through', () => {
        const value = { a: [1, 2] };
        const copy = cloneJson(value);
        copy.a.push(3);
        expect(value.a).toEqual([1, 2]);
        expect(cloneJson(undefined)).toBeUndefined();
    });

    it('filters string lists', () => {
        expect(stringList(['a', 1, 'b'])).toEqual(['a', 'b']);
        expect(stringList('a')).toEqual([]);
    });
});

describe('entries', () => {
    it('creates template entries with the uid forced', () => {
        const created = templateEntry(3, { comment: 'Hi', uid: 99 });
        expect(created.uid).toBe(3);
        expect(created.comment).toBe('Hi');
        expect(created.order).toBe(100);
        expect(created.key).toEqual([]);
        // The template itself is never shared.
        (created.key as string[]).push('x');
        expect(ENTRY_TEMPLATE.key).toEqual([]);
    });

    it('finds the smallest free uid and the largest display index', () => {
        expect(freeUid({})).toBe(0);
        expect(freeUid({ 0: {}, 1: {}, 3: {} })).toBe(2);
        const entries = { 0: entry(0, { displayIndex: 5 }), 7: entry(7) };
        expect(maxDisplayIndex(entries)).toBe(7);
        expect(maxDisplayIndex({})).toBe(-1);
        expect(displayIndexOf(entry(4))).toBe(4);
        expect(displayIndexOf(entry(4, { displayIndex: 1 }))).toBe(1);
    });

    it('normalizes like the classic list without touching the input', () => {
        const raw = entry(2, { key: 'a', keysecondary: null, characterFilter: [], custom: { keep: true } });
        const view = normalizedEntry(raw);
        expect(view.key).toEqual([]);
        expect(view.keysecondary).toEqual([]);
        expect(view.characterFilter).toEqual({ isExclude: false, names: [], tags: [] });
        expect(view.displayIndex).toBe(2);
        expect(view.selective).toBe(true);
        expect(view.custom).toEqual({ keep: true });
        expect(raw.key).toBe('a');
        expect(raw.selective).toBeUndefined();
        expect(normalizedEntry(entry(1, { displayIndex: 9, characterFilter: { isExclude: true } })).displayIndex).toBe(
            9,
        );
    });

    it('titles entries by memo, then keys', () => {
        expect(entryTitle(entry(1, { comment: '  Anna ', key: ['a'] }))).toBe('Anna');
        expect(entryTitle(entry(1, { comment: '', key: ['a', 'b'] }))).toBe('a, b');
        expect(entryTitle(entry(1))).toBe('');
    });

    it('maps status like ST (constant wins)', () => {
        expect(entryStatus(entry(1, { constant: true, vectorized: true }))).toBe('constant');
        expect(entryStatus(entry(1, { vectorized: true }))).toBe('vectorized');
        expect(entryStatus(entry(1))).toBe('normal');
        expect(statusPatch('vectorized')).toEqual({ constant: false, vectorized: true });
        expect(statusPatch('constant')).toEqual({ constant: true, vectorized: false });
    });

    it('maps the position list both ways', () => {
        for (const choice of POSITION_CHOICES) {
            const patch = positionPatch(choice);
            expect(positionChoice(entry(1, patch))).toBe(choice);
            expect(positionLabel(entry(1, { ...patch, depth: 3 }))).toBeTruthy();
        }
        expect(positionPatch('depthUser')).toEqual({ position: 4, role: 1 });
        expect(positionPatch('after')).toEqual({ position: 1, role: null });
        expect(positionChoice(entry(1, { position: 4 }))).toBe('depthSystem');
        expect(positionChoice(entry(1, { position: 42 }))).toBe('before');
        expect(positionChoice(entry(1))).toBe('before');
        expect(positionLabel(entry(1, { position: 4, role: 2, depth: 6 }))).toBe('@D🤖6');
        expect(positionLabel(entry(1, { position: 4, role: 1 }))).toBe('@D👤4');
        expect(positionLabel(entry(1, { position: 4 }))).toBe('@D⚙4');
        expect(positionLabel(entry(1, { position: 7 }))).toBe('Outlet');
    });

    it('backfills empty titles from keys', () => {
        const long = Array.from({ length: 40 }, (_, i) => `key${i}`);
        const result = backfillComments({
            0: entry(0, { key: ['a', 'b'] }),
            1: entry(1, { comment: 'kept', key: ['c'] }),
            2: entry(2, { key: [] }),
            3: entry(3, { key: long }),
        });
        expect(result).toEqual([
            { uid: 0, comment: 'a, b' },
            { uid: 3, comment: long.join(', ').slice(0, MAX_COMMENT_LENGTH) },
        ]);
    });

    it('diffs entries by uid', () => {
        const before = { 0: entry(0, { a: 1 }), 1: entry(1, { a: 1 }), 2: entry(2) };
        const after = { 0: entry(0, { a: 2 }), 1: entry(1, { a: 1 }), 5: entry(5) };
        const diff = diffEntries(before, after);
        expect(diff).toEqual({ added: [5], removed: [2], changed: [{ uid: 0, fields: ['a'] }] });
        expect(diffSize(diff)).toBe(3);
        expect(changedFields(undefined, entry(1, { x: 1 }))).toEqual(['uid', 'x']);
        expect(diffEntries({ 9: { a: 1 } as unknown as LoreEntry }, {}).removed).toEqual([9]);
    });

    it('patches copies and never changes the uid', () => {
        const original = entry(1, { comment: 'a', drop: 1, nested: { x: 1 } });
        const next = patchEntry(original, { comment: 'b', uid: 7, drop: undefined });
        expect(next).toEqual({ uid: 1, comment: 'b', nested: { x: 1 } });
        (next.nested as { x: number }).x = 2;
        expect(original.nested).toEqual({ x: 1 });
        expect(contentLength(entry(1, { content: 'abc' }))).toBe(3);
        expect(contentLength(entry(1))).toBe(0);
    });
});

describe('originalData mirror', () => {
    it('maps fields to ST paths, manual ones included', () => {
        expect(mirrorPaths('disable', true)).toEqual([{ path: 'enabled', value: false }]);
        expect(mirrorPaths('position', 0)).toEqual([
            { path: 'position', value: 'before_char' },
            { path: 'extensions.position', value: 0 },
        ]);
        expect(mirrorPaths('position', 4)[0]).toEqual({ path: 'position', value: 'after_char' });
        expect(mirrorPaths('outletName', 'x')).toEqual([{ path: 'extensions.outlet_name', value: 'x' }]);
        expect(mirrorPaths('group', 'g')).toEqual([{ path: 'extensions.group', value: 'g' }]);
        expect(mirrorPaths('characterFilter', { names: [] })).toEqual([
            { path: 'character_filter', value: { names: [] } },
        ]);
        expect(mirrorPaths('order', 5)).toEqual([{ path: 'insertion_order', value: 5 }]);
        expect(mirrorPaths('key', ['a'])).toEqual([{ path: 'keys', value: ['a'] }]);
        expect(mirrorPaths('uid', 1)).toEqual([]);
        expect(mirrorPaths('myExtensionField', 1)).toEqual([]);
        expect(mirrorPaths('custom', 1, { custom: 'extensions.custom' })).toEqual([
            { path: 'extensions.custom', value: 1 },
        ]);
    });

    it('sets values by path, creating objects', () => {
        const target: Record<string, unknown> = { extensions: 'broken' };
        setByPath(target, 'extensions.depth', 3);
        setByPath(target, 'comment', 'x');
        expect(target).toEqual({ extensions: { depth: 3 }, comment: 'x' });
    });

    it('edits and removes original entries', () => {
        const book: LoreBook = { entries: {}, originalData: { entries: [{ uid: 1, keys: [] }, 'junk', { uid: 2 }] } };
        expect(originalEntries(book)).toHaveLength(2);
        expect(setOriginalValue(book, 1, 'extensions.depth', 2)).toBe(true);
        expect(setOriginalValue(book, 9, 'comment', 'x')).toBe(false);
        expect(removeOriginal(book, 2)).toBe(true);
        expect(removeOriginal(book, 2)).toBe(false);
        expect((book.originalData as { entries: unknown[] }).entries).toEqual([
            { uid: 1, keys: [], extensions: { depth: 2 } },
            'junk',
        ]);
        expect(originalEntries({ entries: {} })).toBeNull();
        expect(removeOriginal({ entries: {} }, 1)).toBe(false);
    });

    it('mirrors a whole save', () => {
        const previous: LoreBook = {
            entries: { 1: entry(1, { comment: 'a', disable: false }), 2: entry(2) },
            originalData: { entries: [{ uid: 1, comment: 'a', enabled: true }, { uid: 2 }] },
        };
        const next = cloneJson(previous);
        next.entries['1'] = entry(1, { comment: 'b', disable: true });
        delete next.entries['2'];
        next.entries['3'] = entry(3);
        expect(mirrorBook(previous, next)).toBe(3);
        expect((next.originalData as { entries: unknown[] }).entries).toEqual([
            { uid: 1, comment: 'b', enabled: false },
        ]);
        expect(mirrorBook(previous, { entries: {} })).toBe(0);
    });

    it('does not mirror fields that normalization filled in', () => {
        const previous: LoreBook = {
            entries: { 1: entry(1, { comment: 'a' }) },
            originalData: { entries: [{ uid: 1, comment: 'a' }] },
        };
        const next = cloneJson(previous);
        next.entries['1'] = normalizedEntry(entry(1, { comment: 'b' }));
        expect(mirrorBook(previous, next)).toBe(1);
        expect((next.originalData as { entries: unknown[] }).entries).toEqual([{ uid: 1, comment: 'b' }]);
        expect(isNormalizationFill('displayIndex', undefined, 1, 1)).toBe(true);
        expect(isNormalizationFill('displayIndex', undefined, 4, 1)).toBe(false);
        expect(isNormalizationFill('characterFilter', undefined, { isExclude: false, names: [], tags: [] }, 1)).toBe(
            true,
        );
        expect(isNormalizationFill('depth', undefined, 6, 1)).toBe(false);
        expect(isNormalizationFill('depth', 4, 4, 1)).toBe(false);
        expect(isNormalizationFill('custom', undefined, 1, 1)).toBe(false);
    });

    it('uses the given setter and remover (ST functions)', () => {
        const calls: string[] = [];
        const previous: LoreBook = {
            entries: { 1: entry(1, { order: 1 }), 2: entry(2) },
            originalData: { entries: [] },
        };
        const next: LoreBook = { entries: { 1: entry(1, { order: 2 }) }, originalData: { entries: [] } };
        mirrorBook(previous, next, {
            set: (_book, uid, path, value) => calls.push(`set ${uid} ${path} ${String(value)}`),
            remove: (_book, uid) => calls.push(`remove ${uid}`),
        });
        expect(calls).toEqual(['set 1 insertion_order 2', 'remove 2']);
    });
});

describe('bulk editing', () => {
    it('finds common values and marks mixed ones', () => {
        const list = [entry(1, { order: 10, constant: true }), entry(2, { order: 10, constant: false })];
        const common = commonValues(list, ['order', 'status', 'positionChoice', 'disable']);
        expect(common.order).toBe(10);
        expect(common.status).toBe(MIXED);
        expect(common.positionChoice).toBe('before');
        expect(common.disable).toBe(false);
        expect(commonValues([], ['order']).order).toBe(MIXED);
        expect(bulkValue(entry(1, { position: 4, role: 2 }), 'positionChoice')).toBe('depthAssistant');
        expect(Object.keys(commonValues(list))).toEqual([...BULK_FIELDS]);
    });

    it('expands virtual fields into entry fields', () => {
        expect(
            expandBulkPatch({
                status: 'constant',
                positionChoice: 'depthUser',
                order: 5,
                group: MIXED,
                depth: undefined,
            }),
        ).toEqual({ constant: true, vectorized: false, position: 4, role: 1, order: 5 });
    });
});
