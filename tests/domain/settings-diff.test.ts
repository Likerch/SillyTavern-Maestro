import { describe, expect, it } from 'vitest';
import {
    acknowledgePaths,
    diffTracked,
    driftHash,
    filterTracked,
    getPath,
    groupOf,
    isTabFresh,
    jsonCopy,
    mergeTracked,
    parseSettingsText,
    pathMatches,
    pickTracked,
    readStamp,
    sameStamp,
    setPath,
    stableStringify,
    stampFromSettingsText,
    topLevelDiff,
    trackedValue,
    valueHash,
    valuesEqual,
} from '../../src/domain/settings-diff';

describe('stable comparison', () => {
    it('ignores key order and maps undefined to null', () => {
        expect(stableStringify({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"c":null,"d":2},"b":1}');
        expect(stableStringify(undefined)).toBe('null');
        expect(stableStringify([1, undefined])).toBe('[1,null]');
        expect(valuesEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
        expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
        const same = { x: 1 };
        expect(valuesEqual(same, same)).toBe(true);
    });

    it('treats values that cannot be serialised as different', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(valuesEqual(cyclic, { self: {} })).toBe(false);
        expect(valueHash(cyclic)).toBe('unhashable');
        expect(valueHash({ a: 1, b: 2 })).toBe(valueHash({ b: 2, a: 1 }));
    });

    it('copies JSON values', () => {
        const source = { a: [1, { b: 2 }], f: () => 1 };
        const copy = jsonCopy(source);
        expect(copy).toEqual({ a: [1, { b: 2 }] });
        expect(copy.a).not.toBe(source.a);
        expect(jsonCopy(undefined)).toBeUndefined();
    });
});

describe('paths', () => {
    it('reads and writes dotted paths', () => {
        const target: Record<string, unknown> = { a: { b: 1 }, list: [1] };
        expect(getPath(target, 'a.b')).toBe(1);
        expect(getPath(target, 'a.c.d')).toBeUndefined();
        expect(getPath(target, 'list.0')).toBeUndefined();
        setPath(target, 'a.c', 2);
        setPath(target, 'x.y.z', 3);
        setPath(target, 'list.k', 4);
        expect(target).toEqual({ a: { b: 1, c: 2 }, x: { y: { z: 3 } }, list: { k: 4 } });
        setPath(target, 'a.b', undefined);
        expect(target.a).toEqual({ c: 2 });
        setPath(target, '', 1);
        expect(Object.keys(target)).toHaveLength(3);
    });

    it('matches path prefixes on segment boundaries', () => {
        expect(pathMatches('preset.body', ['preset'])).toBe(true);
        expect(pathMatches('preset', ['preset'])).toBe(true);
        expect(pathMatches('presets.x', ['preset'])).toBe(false);
        expect(groupOf('regex.abc.def')).toBe('regex');
        expect(groupOf('profiles')).toBe('profiles');
    });
});

describe('tracked keys', () => {
    it('picks keys, hashes long values and omits private parts', () => {
        const source = { a: 1, text: 'long', nested: { on: true, secret: 's' }, missing: undefined };
        const part = pickTracked(
            source,
            [{ path: 'a' }, { path: 'text', hash: true }, { path: 'nested', omit: ['secret'] }, { path: 'missing' }],
            'x',
        );
        expect(part.values['x.a']).toBe(1);
        expect(part.values['x.text']).toBe(valueHash('long'));
        expect(part.restore['x.text']).toBe('long');
        expect(part.values['x.nested']).toEqual({ on: true });
        expect(part.values).not.toHaveProperty('x.missing');
        expect(pickTracked(null, [{ path: 'a' }], 'x')).toEqual({ values: {}, restore: {} });
    });

    it('skips values that cannot be copied', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(pickTracked({ c: cyclic }, [{ path: 'c' }], 'x').values).toEqual({});
    });

    it('derives the tracked form of a full value', () => {
        expect(trackedValue({ on: true, secret: 's' }, { path: 'n', omit: ['secret'] })).toEqual({
            value: { on: true },
        });
        expect(trackedValue({ a: 1, b: 2 }, { path: 't', hash: true, omit: ['b'] })).toEqual({
            value: valueHash({ a: 1 }),
            restore: { a: 1 },
        });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(trackedValue(cyclic, { path: 'c' })).toBeNull();
    });

    it('filters a part by path', () => {
        const part = { values: { 'a.x': 1, 'b.y': 2 }, restore: { 'a.x': 'X', 'b.y': 'Y' } };
        expect(filterTracked(part, (path) => path.startsWith('a.'))).toEqual({
            values: { 'a.x': 1 },
            restore: { 'a.x': 'X' },
        });
        expect(part.values).toHaveProperty('b.y');
    });

    it('merges parts', () => {
        expect(
            mergeTracked({ values: { a: 1 }, restore: {} }, { values: { a: 2, b: 3 }, restore: { b: 'B' } }),
        ).toEqual({ values: { a: 2, b: 3 }, restore: { b: 'B' } });
    });
});

describe('drift', () => {
    it('reports changed, added and removed paths in order', () => {
        const entries = diffTracked({ a: 1, b: { x: 1 }, c: 3 }, { a: 1, b: { x: 2 }, d: 4 });
        expect(entries).toEqual([
            { path: 'b', kind: 'changed', baseline: { x: 1 }, current: { x: 2 } },
            { path: 'c', kind: 'removed', baseline: 3, current: undefined },
            { path: 'd', kind: 'added', baseline: undefined, current: 4 },
        ]);
        expect(driftHash(entries)).toBe(driftHash(entries.map((entry) => ({ ...entry }))));
        expect(driftHash(entries)).not.toBe(driftHash(entries.slice(1)));
    });

    it('acknowledges matching paths into the baseline', () => {
        const baseline = { values: { 'q.a': 1, 'q.b': 2, 'p.x': 'h1', 'q.gone': 1 }, restore: { 'p.x': 'old' } };
        const current = { values: { 'q.a': 5, 'q.b': 2, 'p.x': 'h2', 'q.new': 7 }, restore: { 'p.x': 'new' } };
        expect(acknowledgePaths(baseline, current, ['q'])).toEqual(['q.a', 'q.gone', 'q.new']);
        expect(baseline.values).toEqual({ 'q.a': 5, 'q.b': 2, 'p.x': 'h1', 'q.new': 7 });
        expect(acknowledgePaths(baseline, current, ['p.x'])).toEqual(['p.x']);
        expect(baseline.restore['p.x']).toBe('new');
        const plain = { values: { 'r.v': 1 }, restore: { 'r.v': 'stale' } };
        acknowledgePaths(plain, { values: { 'r.v': 2 }, restore: {} }, ['r']);
        expect(plain.restore).toEqual({});
        expect(acknowledgePaths(baseline, current, ['nothing'])).toEqual([]);
    });
});

describe('settings.json comparison', () => {
    it('lists top-level keys that differ', () => {
        const local = { a: 1, b: { x: 1 }, skip: 1, c: 3 };
        const server = { a: 1, b: { x: 2 }, skip: 2, d: 4 };
        expect(topLevelDiff(local, server, { prefix: 'p', ignore: ['skip'] })).toEqual(['p.b', 'p.c', 'p.d']);
        expect(topLevelDiff(local, server, { prefix: 'p', limit: 1 })).toEqual(['p.b']);
        expect(topLevelDiff(null, server, { prefix: 'p' })).toEqual([]);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(topLevelDiff({ c: cyclic }, { c: {} }, { prefix: 'p' })).toEqual([]);
    });

    it('parses settings text', () => {
        expect(parseSettingsText('{"a":1}')).toEqual({ a: 1 });
        expect(parseSettingsText('[1]')).toBeUndefined();
        expect(parseSettingsText('nope')).toBeUndefined();
        expect(parseSettingsText(null)).toBeUndefined();
    });
});

describe('tab stamp', () => {
    const path = 'extension_settings.maestro.modules.guardian.stamp';
    const text = (stamp: unknown) =>
        JSON.stringify({ extension_settings: { maestro: { modules: { guardian: { stamp } } } } });

    it('reads stamps', () => {
        expect(readStamp({ tabId: 't', seq: 2, at: 5 })).toEqual({ tabId: 't', seq: 2, at: 5 });
        expect(readStamp({ tabId: 't', seq: 2 })).toEqual({ tabId: 't', seq: 2, at: 0 });
        expect(readStamp({ tabId: '', seq: 1 })).toBeNull();
        expect(readStamp({ tabId: 't', seq: 'x' })).toBeNull();
        expect(readStamp('x')).toBeNull();
        expect(stampFromSettingsText(text({ tabId: 't', seq: 1, at: 1 }), path)).toEqual({ tabId: 't', seq: 1, at: 1 });
        expect(stampFromSettingsText('{}', path)).toBeNull();
        expect(stampFromSettingsText('broken', path)).toBeUndefined();
    });

    it('compares stamps by tab and seq', () => {
        expect(sameStamp({ tabId: 'a', seq: 1, at: 1 }, { tabId: 'a', seq: 1, at: 9 })).toBe(true);
        expect(sameStamp({ tabId: 'a', seq: 1, at: 1 }, { tabId: 'a', seq: 2, at: 1 })).toBe(false);
        expect(sameStamp(null, null)).toBe(true);
        expect(sameStamp(null, { tabId: 'a', seq: 1, at: 1 })).toBe(false);
    });

    it('decides freshness', () => {
        const mine = { tabId: 'me', seq: 3, at: 1 };
        const other = { tabId: 'other', seq: 1, at: 1 };
        expect(isTabFresh({ kind: 'mine' }, mine, 'me')).toBe(true);
        expect(isTabFresh({ kind: 'mine' }, { ...mine, seq: 9 }, 'me')).toBe(true);
        expect(isTabFresh({ kind: 'mine' }, other, 'me')).toBe(false);
        expect(isTabFresh({ kind: 'mine' }, null, 'me')).toBe(false);
        expect(isTabFresh({ kind: 'exact', stamp: other }, other, 'me')).toBe(true);
        expect(isTabFresh({ kind: 'exact', stamp: other }, { ...other, seq: 2 }, 'me')).toBe(false);
        expect(isTabFresh({ kind: 'exact', stamp: null }, null, 'me')).toBe(true);
        expect(isTabFresh({ kind: 'exact', stamp: null }, mine, 'me')).toBe(true);
    });
});
