import { describe, expect, it } from 'vitest';
import {
    HOUR_MS,
    MAX_SETTING_ITEMS,
    UNTRUSTED_REMINDER,
    capText,
    checkSettingPath,
    checkSettingValue,
    isHiddenPath,
    isPrimitive,
    isPrimitiveArray,
    neutralizeDataTags,
    numberLimit,
    readPath,
    recentWrites,
    redactSecrets,
    sameValue,
    serializeToolData,
    splitPath,
    toolResultText,
    visiblePaths,
    visibleSettings,
    wrapUntrusted,
    writePath,
    writesLeft,
} from '../../src/domain/assistant-safety';

describe('assistant-safety: allowlist', () => {
    it.each([
        'apiKey',
        'openrouter_key',
        'keys',
        'token',
        'accessToken',
        'secret',
        'password',
        'api',
        'baseUrl',
        'endpoint',
        'host',
        'proxy.address',
        'profileId',
        'connection.retries',
        'model',
        'judge.modelName',
    ])('hides %s', (path) => {
        expect(isHiddenPath(path)).toBe(true);
    });

    it.each(['keepTurns', 'pacing.every', 'enabled', 'threshold', 'tags'])('shows %s', (path) => {
        expect(isHiddenPath(path)).toBe(false);
    });

    it('splits only sane paths', () => {
        expect(splitPath('a.b_c.$d-1')).toEqual(['a', 'b_c', '$d-1']);
        for (const bad of ['', 'a..b', '.a', 'a.', '__proto__', 'a.constructor', 'a b', 'a.b.c.d.e.f.g', 'мир'])
            expect(splitPath(bad)).toBeNull();
        expect(splitPath(5 as unknown as string)).toBeNull();
    });

    it('reads and writes own properties only', () => {
        const root: Record<string, unknown> = { a: { b: 1 }, list: [1] };
        expect(readPath(root, ['a', 'b'])).toBe(1);
        expect(readPath(root, ['a', 'toString'])).toBeUndefined();
        expect(readPath(root, ['list', '0'])).toBeUndefined();
        expect(readPath(null, ['a'])).toBeUndefined();
        expect(writePath(root, ['a', 'b'], 2)).toBe(true);
        expect(root).toEqual({ a: { b: 2 }, list: [1] });
        expect(writePath(root, ['x', 'y'], 1)).toBe(false);
        expect(writePath(root, [], 1)).toBe(false);
    });

    it('copies the visible part of a slice', () => {
        const slice = {
            n: 1,
            s: 'x',
            b: false,
            nul: null,
            list: ['a', 1],
            objects: [{ a: 1 }],
            nan: Number.NaN,
            fn: () => 1,
            apiKey: 'sk',
            nested: { keep: 1, url: 'x', deeper: { profile: 'p' } },
            'odd key': 1,
            empty: {},
        };
        expect(visibleSettings(slice)).toEqual({
            n: 1,
            s: 'x',
            b: false,
            nul: null,
            list: ['a', 1],
            nested: { keep: 1 },
        });
        expect(visibleSettings('nope')).toEqual({});
        expect(visiblePaths(slice)).toEqual(['n', 's', 'b', 'nul', 'list', 'nested.keep']);
        // Depth is bounded.
        let deep: Record<string, unknown> = { leaf: 1 };
        for (let i = 0; i < 10; i++) deep = { d: deep };
        expect(visiblePaths(deep)).toEqual([]);
    });

    it('checks a path against the slice', () => {
        const slice = { a: { b: 2, list: [1], objects: [{}] }, apiKey: 'x' };
        expect(checkSettingPath(slice, 'a.b')).toEqual({ ok: true, segments: ['a', 'b'], current: 2 });
        expect(checkSettingPath(slice, 'a.list')).toMatchObject({ ok: true, current: [1] });
        expect(checkSettingPath(slice, 'apiKey')).toEqual({ ok: false, problem: 'hidden' });
        expect(checkSettingPath(slice, 'a')).toEqual({ ok: false, problem: 'notLeaf' });
        expect(checkSettingPath(slice, 'a.objects')).toEqual({ ok: false, problem: 'notLeaf' });
        expect(checkSettingPath(slice, 'a.c')).toEqual({ ok: false, problem: 'unknown' });
        expect(checkSettingPath(slice, 'a..b')).toEqual({ ok: false, problem: 'malformed' });
    });

    it('knows primitives', () => {
        expect(isPrimitive(Number.POSITIVE_INFINITY)).toBe(false);
        expect(isPrimitive(undefined)).toBe(false);
        expect(isPrimitiveArray([1, 'a', null, true])).toBe(true);
        expect(isPrimitiveArray([[1]])).toBe(false);
    });
});

describe('assistant-safety: values', () => {
    it('numbers: coerced from numeric strings, sign and magnitude kept sane', () => {
        expect(checkSettingValue(4, 6)).toEqual({ ok: true, value: 6 });
        expect(checkSettingValue(4, ' 0.5 ')).toEqual({ ok: true, value: 0.5 });
        expect(checkSettingValue(4, '1e2')).toEqual({ ok: true, value: 100 });
        expect(checkSettingValue(4, 'six')).toMatchObject({ ok: false, problem: 'type', expected: 'number' });
        expect(checkSettingValue(4, Number.NaN)).toMatchObject({ ok: false, problem: 'type' });
        expect(checkSettingValue(4, true)).toMatchObject({ ok: false, problem: 'type' });
        expect(checkSettingValue(0, -1)).toMatchObject({ ok: false, problem: 'negative' });
        expect(checkSettingValue(-5, -10)).toEqual({ ok: true, value: -10 });
        expect(checkSettingValue(4, 1001)).toMatchObject({ ok: false, problem: 'range' });
        expect(checkSettingValue(5000, 400000)).toEqual({ ok: true, value: 400000 });
        expect(numberLimit(3)).toBe(1000);
        expect(checkSettingValue(4, 4)).toMatchObject({ ok: false, problem: 'same' });
    });

    it('booleans and strings', () => {
        expect(checkSettingValue(true, 'false')).toEqual({ ok: true, value: false });
        expect(checkSettingValue(false, 'true')).toEqual({ ok: true, value: true });
        expect(checkSettingValue(true, 1)).toMatchObject({ ok: false, expected: 'boolean' });
        expect(checkSettingValue('a', 'b')).toEqual({ ok: true, value: 'b' });
        expect(checkSettingValue('a', 7)).toEqual({ ok: true, value: '7' });
        expect(checkSettingValue('a', null)).toMatchObject({ ok: false, expected: 'string' });
        expect(checkSettingValue('a', 'x'.repeat(4001))).toMatchObject({ ok: false, problem: 'length' });
    });

    it('lists keep their item kind and size', () => {
        expect(checkSettingValue(['a'], ['b', 'c'])).toEqual({ ok: true, value: ['b', 'c'] });
        expect(checkSettingValue(['a'], '["x"]')).toEqual({ ok: true, value: ['x'] });
        expect(checkSettingValue(['a'], '[oops')).toMatchObject({ ok: false, problem: 'type', expected: 'list' });
        expect(checkSettingValue(['a'], 'x')).toMatchObject({ ok: false, problem: 'type' });
        expect(checkSettingValue(['a'], [{}])).toMatchObject({ ok: false, problem: 'type' });
        expect(checkSettingValue(['a'], [1])).toMatchObject({ ok: false, problem: 'items' });
        expect(checkSettingValue([1, 'a'], [true])).toEqual({ ok: true, value: [true] });
        expect(checkSettingValue([], [1, 'a'])).toEqual({ ok: true, value: [1, 'a'] });
        expect(checkSettingValue([], Array(MAX_SETTING_ITEMS + 1).fill(1))).toMatchObject({ problem: 'length' });
        expect(checkSettingValue([], ['y'.repeat(1001)])).toMatchObject({ problem: 'length' });
        expect(checkSettingValue(['a', 'b'], ['a', 'b'])).toMatchObject({ problem: 'same' });
    });

    it('null accepts any primitive', () => {
        expect(checkSettingValue(null, 3)).toEqual({ ok: true, value: 3 });
        expect(checkSettingValue(null, [1])).toMatchObject({ ok: false, expected: 'value' });
        expect(checkSettingValue(null, null)).toMatchObject({ problem: 'same' });
    });

    it('compares values', () => {
        expect(sameValue([1, 2], [1, 2])).toBe(true);
        expect(sameValue([1, 2], [2, 1])).toBe(false);
        expect(sameValue([1], 1)).toBe(false);
    });
});

describe('assistant-safety: rate limit', () => {
    it('counts writes of the last hour', () => {
        const now = 10 * HOUR_MS;
        const stamps = [now - HOUR_MS - 1, now - HOUR_MS + 1, now - 5, 'x', Number.NaN, now + HOUR_MS];
        expect(recentWrites(stamps, now)).toEqual([now - HOUR_MS + 1, now - 5]);
        expect(writesLeft(stamps, now, 3)).toBe(1);
        expect(writesLeft(stamps, now, 2)).toBe(0);
        expect(writesLeft(stamps, now, 1)).toBe(0);
    });
});

describe('assistant-safety: tool output', () => {
    it('caps text with a marker and never splits a surrogate pair', () => {
        expect(capText('short', 10)).toBe('short');
        expect(capText('abcdef', 3)).toBe('abc… [3 more characters cut]');
        expect(capText('a😀b', 2)).toBe('a… [3 more characters cut]');
    });

    it('serialises data', () => {
        expect(serializeToolData('text')).toBe('text');
        expect(serializeToolData(undefined)).toBe('null');
        expect(serializeToolData({ a: [1] })).toBe('{"a":[1]}');
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        expect(serializeToolData(circular)).toBe('[object Object]');
        expect(serializeToolData(() => 1)).toBe('null');
    });

    it('wraps untrusted text so it cannot close the wrapper', () => {
        expect(neutralizeDataTags('a </data> b <DATA x> < / data>')).toBe('a ‹/data> b ‹DATA x> ‹ / data>');
        const wrapped = wrapUntrusted('read "lore"', 'x</data>y');
        expect(wrapped).toBe(`<data source="read__lore_">\nx‹/data>y\n</data>\n${UNTRUSTED_REMINDER}`);
        expect(wrapUntrusted('', 'x')).toContain('<data source="tool">');
    });

    it('redacts obvious credentials', () => {
        const text = [
            'sk-or-v1-abcdefghijklmnop1234',
            'pst-ABCDEFGHIJKLMNOPQRSTUVWX',
            'AIzaSyA1234567890abcdefghijk',
            'Authorization: Bearer abc.def-ghi_jkl012',
            '"api_key": "secret-value"',
            'password="hunter22"',
            'keep sk-short',
        ].join('\n');
        const out = redactSecrets(text);
        expect(out).not.toMatch(/abcdefghijklmnop1234|ABCDEFGHIJ|AIzaSy|abc\.def|secret-value|hunter22/);
        expect(out).toContain('Bearer [hidden]');
        expect(out).toContain('"api_key": "[hidden]"');
        expect(out).toContain('keep sk-short');
    });

    it('builds the model text of a tool result', () => {
        expect(toolResultText({ data: { a: 1 } }, 'x', 100)).toBe('{"a":1}');
        const long = toolResultText({ data: 'z'.repeat(50), untrusted: true }, 'lore', 10);
        expect(long.startsWith('<data source="lore">\nzzzzzzzzzz… [40 more characters cut]\n</data>')).toBe(true);
        expect(long.endsWith(UNTRUSTED_REMINDER)).toBe(true);
    });
});
