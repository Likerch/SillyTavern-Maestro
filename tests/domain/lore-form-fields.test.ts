import { describe, expect, it } from 'vitest';
import { stableHash } from '../../src/domain/hash';
import {
    NUMBER_FIELDS,
    POSITION_OPTIONS,
    applyEntryState,
    applyPosition,
    avatarName,
    bookSuggestions,
    buildCharacterFilter,
    canonicalJson,
    cloneJson,
    commentPlaceholder,
    contentHash,
    entryPatch,
    entryState,
    groupNames,
    isKnownPosition,
    numberText,
    parseNumber,
    parseTriState,
    positionOptionId,
    readCharacterFilter,
    readTriggers,
    recursionDelayFromLevel,
    recursionDelayView,
    recursionLevel,
    restorePatch,
    sameValue,
    stEditorDifferences,
    toggleRecursionDelay,
    triStateOf,
} from '../../src/domain/lore-form-fields';

/** An entry as ST's template makes it (nothing for ST's editor to change). */
const NORMAL = {
    uid: 1,
    key: ['a'],
    keysecondary: [],
    selective: true,
    useProbability: true,
    probability: 100,
    addMemo: true,
    position: 0,
    depth: 4,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    groupWeight: 100,
    triggers: [],
};

describe('position, role and outlet', () => {
    it('maps stored values to options like ST', () => {
        expect(positionOptionId(undefined, undefined)).toBe('0');
        expect(positionOptionId(4, undefined)).toBe('4:0');
        expect(positionOptionId(4, 2)).toBe('4:2');
        expect(positionOptionId(7, null)).toBe('7');
        expect(positionOptionId(9, null)).toBe('9');
        expect(isKnownPosition('9')).toBe(false);
        expect(POSITION_OPTIONS.map((option) => option.id)).toEqual([
            '0',
            '1',
            '5',
            '6',
            '2',
            '3',
            '4:0',
            '4:1',
            '4:2',
            '7',
        ]);
    });

    it('writes the role only for «at depth»', () => {
        expect(applyPosition('4:1')).toEqual({ position: 4, role: 1 });
        expect(applyPosition('0')).toEqual({ position: 0, role: null });
        expect(applyPosition('7')).toEqual({ position: 7, role: null });
        expect(applyPosition('9')).toEqual({ position: 9, role: null });
        expect(applyPosition('4:7')).toEqual({ position: 4, role: 7 });
        expect(applyPosition('4:x')).toEqual({ position: 4, role: 0 });
        expect(applyPosition('junk')).toEqual({ position: 0, role: null });
    });
});

describe('status and tri-states', () => {
    it('reads and writes the status pair', () => {
        expect(entryState({ constant: true, vectorized: true })).toBe('constant');
        expect(entryState({ vectorized: true })).toBe('vectorized');
        expect(entryState({})).toBe('normal');
        expect(applyEntryState('vectorized')).toEqual({ constant: false, vectorized: true });
        expect(applyEntryState('normal')).toEqual({ constant: false, vectorized: false });
    });

    it('shows null/undefined as global', () => {
        expect([null, undefined, true, false, 1, 0].map(triStateOf)).toEqual([
            'null',
            'null',
            'true',
            'false',
            'true',
            'false',
        ]);
        expect(['null', 'true', 'false'].map(parseTriState)).toEqual([null, true, false]);
    });
});

describe('numbers', () => {
    it('validates like ST but rejects junk', () => {
        expect(parseNumber('', NUMBER_FIELDS.order)).toEqual({ ok: false, error: 'required' });
        expect(parseNumber('abc', NUMBER_FIELDS.order)).toEqual({ ok: false, error: 'notNumber' });
        expect(parseNumber('12.5', NUMBER_FIELDS.order)).toEqual({ ok: true, value: 12.5 });
        expect(parseNumber('-1', NUMBER_FIELDS.depth)).toEqual({ ok: false, error: 'negative' });
        expect(parseNumber('150', NUMBER_FIELDS.probability)).toEqual({ ok: true, value: 100, adjusted: 'max' });
        expect(parseNumber('-5', NUMBER_FIELDS.probability)).toEqual({ ok: true, value: 0, adjusted: 'min' });
        expect(parseNumber('', NUMBER_FIELDS.scanDepth)).toEqual({ ok: true, value: null });
        expect(parseNumber('2000', NUMBER_FIELDS.scanDepth)).toEqual({ ok: true, value: 1000, adjusted: 'max' });
        expect(parseNumber('3.7', NUMBER_FIELDS.scanDepth)).toEqual({ ok: true, value: 3, adjusted: 'floor' });
        expect(parseNumber('-1', NUMBER_FIELDS.scanDepth)).toEqual({ ok: true, value: 0, adjusted: 'min' });
        expect(parseNumber('0', NUMBER_FIELDS.groupWeight)).toEqual({ ok: true, value: 1, adjusted: 'min' });
        expect(parseNumber('2.5', NUMBER_FIELDS.sticky)).toEqual({ ok: false, error: 'notInteger' });
        expect(parseNumber('-1', NUMBER_FIELDS.sticky)).toEqual({ ok: false, error: 'negative' });
        expect(parseNumber(' 7 ', NUMBER_FIELDS.cooldown)).toEqual({ ok: true, value: 7 });
        expect(parseNumber('', NUMBER_FIELDS.delay)).toEqual({ ok: true, value: null });
        expect(parseNumber('5', { max: 3 })).toEqual({ ok: true, value: 5 });
    });

    it('shows stored numbers only', () => {
        expect(numberText(5)).toBe('5');
        expect(numberText(null)).toBe('');
        expect(numberText('5')).toBe('');
        expect(numberText(Number.NaN)).toBe('');
    });
});

describe('delay until recursion', () => {
    it('reads boolean, level and ST default 0', () => {
        expect(recursionDelayView(true)).toEqual({ on: true, level: '' });
        expect(recursionDelayView(2)).toEqual({ on: true, level: '2' });
        expect(recursionDelayView(0)).toEqual({ on: false, level: '' });
        expect(recursionDelayView(false)).toEqual({ on: false, level: '' });
        expect(recursionDelayView('3')).toEqual({ on: true, level: '3' });
    });

    it('toggles and sets levels like ST', () => {
        expect(toggleRecursionDelay(2, true)).toBe(2);
        expect(toggleRecursionDelay(true, true)).toBe(true);
        expect(toggleRecursionDelay(0, true)).toBe(true);
        expect(toggleRecursionDelay(2, false)).toBe(false);
        expect(recursionDelayFromLevel(true, '')).toEqual({ ok: true, value: true });
        expect(recursionDelayFromLevel(false, '')).toEqual({ ok: true, value: false });
        expect(recursionDelayFromLevel(2, '')).toEqual({ ok: true, value: true });
        expect(recursionDelayFromLevel(true, '3')).toEqual({ ok: true, value: 3 });
        expect(recursionDelayFromLevel(true, '1')).toEqual({ ok: true, value: 1 });
        expect(recursionDelayFromLevel(true, 'abc')).toEqual({ ok: false });
        expect(recursionDelayFromLevel(true, '-1')).toEqual({ ok: false });
        expect([true, 3, 0, false, 'x'].map(recursionLevel)).toEqual([1, 3, 0, 0, 0]);
    });
});

describe('groups and suggestions', () => {
    it('splits groups like the engine', () => {
        expect(groupNames('a, b,c ,')).toEqual(['a', 'b', 'c ']);
        expect(groupNames(undefined)).toEqual([]);
    });

    it('suggests values of other entries, most used first', () => {
        const entries = [
            { uid: 1, group: 'x, y', automationId: 'qr', position: 7, outletName: 'scene' },
            { uid: 2, group: 'y', automationId: ' qr ', position: 0, outletName: 'ignored' },
            { uid: 3, group: 'z', position: 7, outletName: 'scene' },
            { uid: 4, group: 5 },
        ];
        expect(bookSuggestions(entries, 'group')).toEqual(['y', 'x', 'z']);
        expect(bookSuggestions(entries, 'group', 2)).toEqual(['x', 'y', 'z']);
        expect(bookSuggestions(entries, 'outletName')).toEqual(['scene']);
        expect(bookSuggestions(entries, 'automationId')).toEqual(['qr']);
    });
});

describe('character filter and triggers', () => {
    it('reads, builds and removes like ST', () => {
        expect(readCharacterFilter(undefined)).toEqual({ isExclude: false, names: [], tags: [] });
        expect(readCharacterFilter([])).toEqual({ isExclude: false, names: [], tags: [] });
        expect(readCharacterFilter({ isExclude: true, names: ['Anna', 3], tags: ['t1'] })).toEqual({
            isExclude: true,
            names: ['Anna'],
            tags: ['t1'],
        });
        expect(buildCharacterFilter({ isExclude: false, names: [], tags: [] })).toBeUndefined();
        expect(buildCharacterFilter({ isExclude: true, names: [], tags: [] })).toEqual({
            isExclude: true,
            names: [],
            tags: [],
        });
        expect(avatarName('Anna.png')).toBe('Anna');
        expect(avatarName('a.b.webp')).toBe('a.b');
        expect(avatarName('noext')).toBe('noext');
    });

    it('keeps unknown triggers apart', () => {
        expect(readTriggers(['normal', 'quiet', 'custom', 3])).toEqual({
            known: ['normal', 'quiet'],
            unknown: ['custom'],
        });
        expect(readTriggers(undefined)).toEqual({ known: [], unknown: [] });
    });
});

describe('draft vs stored', () => {
    it('compares JSON with sorted keys and without undefined members', () => {
        expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, { y: 2, x: 1 }] } })).toBe(
            '{"a":{"c":[1,{"x":1,"y":2}]},"b":1}',
        );
        expect(canonicalJson(undefined)).toBe('undefined');
        expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
        expect(sameValue(undefined, null)).toBe(false);
        expect(cloneJson(undefined)).toBeUndefined();
        const source = { a: [1] };
        const copy = cloneJson(source);
        expect(copy).toEqual(source);
        expect(copy.a).not.toBe(source.a);
    });

    it('builds the patch of changed fields only', () => {
        const stored = { uid: 1, key: ['a'], content: 'x', extensions: { other: 1 }, gone: true };
        const draft = { uid: 2, key: ['a'], content: 'y', extensions: { other: 1, maestro: { type: 'note' } } };
        expect(entryPatch(stored, draft)).toEqual({
            content: 'y',
            extensions: { other: 1, maestro: { type: 'note' } },
            gone: undefined,
        });
        expect('gone' in entryPatch(stored, draft)).toBe(true);
        expect(restorePatch({ uid: 1, content: 'now' }, { uid: 1, content: 'then', comment: 'c' })).toEqual({
            content: 'then',
            comment: 'c',
        });
    });

    it('hashes content for canon bases', () => {
        expect(contentHash('Anna')).toBe(stableHash('Anna'));
        expect(contentHash(undefined)).toBe(stableHash(''));
    });

    it('limits the comment placeholder to 100 chars', () => {
        expect(commentPlaceholder(['a', 'b'])).toBe('a, b');
        expect(commentPlaceholder(['x'.repeat(150)])).toHaveLength(100);
    });
});

describe('stEditorDifferences', () => {
    it('finds nothing in a template entry', () => {
        expect(stEditorDifferences(NORMAL)).toEqual([]);
    });

    it('lists the hidden changes and whether they change the engine', () => {
        const fields = (entry: Record<string, unknown>) =>
            Object.fromEntries(stEditorDifferences(entry).map((item) => [item.field, item.engine]));
        expect(fields({ ...NORMAL, selective: false, keysecondary: ['b'] })).toEqual({ selective: true });
        expect(fields({ ...NORMAL, selective: false })).toEqual({ selective: false });
        expect(fields({ ...NORMAL, useProbability: false, probability: 50 })).toEqual({ useProbability: true });
        expect(fields({ ...NORMAL, useProbability: false })).toEqual({ useProbability: false });
        expect(fields({ ...NORMAL, probability: null })).toEqual({ probability: false });
        expect(fields({ ...NORMAL, probability: 150 })).toEqual({ probability: false });
        expect(fields({ ...NORMAL, addMemo: false })).toEqual({ addMemo: false });
        expect(fields({ ...NORMAL, position: undefined })).toEqual({ position: true });
        expect(fields({ ...NORMAL, sticky: null, cooldown: undefined })).toEqual({ sticky: false, cooldown: false });
        expect(fields({ ...NORMAL, depth: undefined, position: 4 })).toEqual({ depth: true });
        expect(fields({ ...NORMAL, depth: null })).toEqual({ depth: false });
        expect(fields({ ...NORMAL, groupWeight: undefined, group: 'g' })).toEqual({ groupWeight: true });
        expect(fields({ ...NORMAL, groupWeight: 0 })).toEqual({ groupWeight: false });
        expect(fields({ ...NORMAL, characterFilter: { isExclude: false, names: [], tags: [] } })).toEqual({
            characterFilter: false,
        });
        expect(fields({ ...NORMAL, characterFilter: { isExclude: true, names: [], tags: [] } })).toEqual({});
        expect(fields({ ...NORMAL, triggers: ['normal', 'bogus'] })).toEqual({ triggers: true });
        const probability = stEditorDifferences({ ...NORMAL, probability: null }).find(
            (item) => item.field === 'probability',
        );
        expect(probability).toMatchObject({ stored: null, st: 0 });
    });
});
