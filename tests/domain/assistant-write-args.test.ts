import { describe, expect, it } from 'vitest';
import {
    ArgError,
    clip,
    exactlyOne,
    isDict,
    jsonCopy,
    optBool,
    optEnum,
    optInt,
    optObject,
    optString,
    optStringList,
    pickName,
    reqBool,
    reqEnum,
    reqInt,
    reqObject,
    reqString,
    reqStringList,
    sameJson,
} from '../../src/domain/assistant-write-args';

function code(run: () => unknown): { code: string; params: Record<string, unknown> } {
    try {
        run();
    } catch (error) {
        if (error instanceof ArgError) return { code: error.code, params: error.params };
        throw error;
    }
    throw new Error('expected an ArgError');
}

describe('assistant write args', () => {
    it('reads strings: trimmed, raw, empty, too long, numbers, wrong types', () => {
        expect(optString({ a: '  x ' }, 'a')).toBe('x');
        expect(optString({ a: 'a\r\nb ' }, 'a', { raw: true })).toBe('a\nb ');
        expect(optString({ a: 5 }, 'a')).toBe('5');
        expect(optString({}, 'a')).toBeUndefined();
        expect(optString({ a: null }, 'a')).toBeUndefined();
        expect(optString({ a: '' }, 'a', { allowEmpty: true })).toBe('');
        expect(code(() => optString({ a: ' ' }, 'a'))).toEqual({ code: 'argEmpty', params: { name: 'a' } });
        expect(code(() => optString({ a: 'long' }, 'a', { max: 2 }))).toEqual({
            code: 'argTooLong',
            params: { name: 'a', max: 2 },
        });
        expect(code(() => optString({ a: {} }, 'a')).code).toBe('argType');
        expect(reqString({ a: 'v' }, 'a')).toBe('v');
        expect(code(() => reqString({}, 'a'))).toEqual({ code: 'argMissing', params: { name: 'a' } });
    });

    it('reads booleans leniently', () => {
        expect(optBool({ a: true }, 'a')).toBe(true);
        expect(optBool({ a: 'False' }, 'a')).toBe(false);
        expect(optBool({ a: ' TRUE ' }, 'a')).toBe(true);
        expect(optBool({ a: 1 }, 'a')).toBe(true);
        expect(optBool({ a: 0 }, 'a')).toBe(false);
        expect(optBool({}, 'a')).toBeUndefined();
        expect(code(() => optBool({ a: 'yes' }, 'a'))).toEqual({
            code: 'argType',
            params: { name: 'a', expected: 'boolean' },
        });
        expect(reqBool({ a: false }, 'a')).toBe(false);
        expect(code(() => reqBool({}, 'a')).code).toBe('argMissing');
    });

    it('reads integers within bounds', () => {
        expect(optInt({ a: 3 }, 'a', 0, 5)).toBe(3);
        expect(optInt({ a: ' 4 ' }, 'a', 0, 5)).toBe(4);
        expect(optInt({}, 'a', 0, 5)).toBeUndefined();
        expect(code(() => optInt({ a: 2.5 }, 'a', 0, 5)).code).toBe('argType');
        expect(code(() => optInt({ a: '' }, 'a', 0, 5)).code).toBe('argType');
        expect(code(() => optInt({ a: 9 }, 'a', 0, 5))).toEqual({
            code: 'argRange',
            params: { name: 'a', min: 0, max: 5 },
        });
        expect(reqInt({ a: 0 }, 'a', 0, 1)).toBe(0);
        expect(code(() => reqInt({}, 'a', 0, 1)).code).toBe('argMissing');
    });

    it('reads enums exactly or case-insensitively', () => {
        const options = ['only', 'except'] as const;
        expect(optEnum({ a: 'only' }, 'a', options)).toBe('only');
        expect(optEnum({ a: ' EXCEPT ' }, 'a', options)).toBe('except');
        expect(optEnum({}, 'a', options)).toBeUndefined();
        expect(code(() => optEnum({ a: 'x' }, 'a', options))).toEqual({
            code: 'argEnum',
            params: { name: 'a', options: 'only, except' },
        });
        expect(code(() => optEnum({ a: 1 }, 'a', options)).code).toBe('argEnum');
        expect(reqEnum({ a: 'only' }, 'a', options)).toBe('only');
        expect(code(() => reqEnum({}, 'a', options)).code).toBe('argMissing');
    });

    it('reads string lists: arrays, comma strings, single strings, unique, limits', () => {
        expect(optStringList({ a: [' x ', 'y', 3] }, 'a')).toEqual(['x', 'y', '3']);
        expect(optStringList({ a: 'x, y,,X' }, 'a', { fromString: 'split', unique: true })).toEqual(['x', 'y']);
        expect(optStringList({ a: 'one, two' }, 'a', { fromString: 'single' })).toEqual(['one, two']);
        expect(optStringList({ a: [' a\r\nb '] }, 'a', { raw: true })).toEqual([' a\nb ']);
        expect(optStringList({}, 'a')).toBeUndefined();
        expect(code(() => optStringList({ a: 'x' }, 'a')).code).toBe('argType');
        expect(code(() => optStringList({ a: [{}] }, 'a')).code).toBe('argType');
        expect(code(() => optStringList({ a: ['long'] }, 'a', { maxLength: 2 })).code).toBe('argTooLong');
        expect(code(() => optStringList({ a: ['a', 'b'] }, 'a', { maxItems: 1 }))).toEqual({
            code: 'argTooMany',
            params: { name: 'a', max: 1 },
        });
        expect(reqStringList({ a: ['x'] }, 'a')).toEqual(['x']);
        expect(code(() => reqStringList({ a: [] }, 'a')).code).toBe('argMissing');
    });

    it('reads objects, also from JSON text', () => {
        expect(optObject({ a: { b: 1 } }, 'a')).toEqual({ b: 1 });
        expect(optObject({ a: '{"b":2}' }, 'a')).toEqual({ b: 2 });
        expect(optObject({}, 'a')).toBeUndefined();
        expect(code(() => optObject({ a: '{oops' }, 'a')).code).toBe('argType');
        expect(code(() => optObject({ a: '[1]' }, 'a')).code).toBe('argType');
        expect(code(() => optObject({ a: [1] }, 'a')).code).toBe('argType');
        expect(reqObject({ a: {} }, 'a')).toEqual({});
        expect(code(() => reqObject({}, 'a')).code).toBe('argMissing');
    });

    it('requires exactly one of two arguments', () => {
        expect(exactlyOne({ a: 1 }, 'a', 'b')).toBe('a');
        expect(exactlyOne({ b: 1 }, 'a', 'b')).toBe('b');
        expect(code(() => exactlyOne({ a: 1, b: 2 }, 'a', 'b'))).toEqual({
            code: 'argOneOf',
            params: { a: 'a', b: 'b' },
        });
        expect(code(() => exactlyOne({}, 'a', 'b')).code).toBe('argNeedOne');
    });

    it('has small helpers: isDict, jsonCopy, sameJson, clip, pickName', () => {
        expect(isDict({})).toBe(true);
        expect(isDict([])).toBe(false);
        expect(isDict(null)).toBe(false);
        const source = { a: [1, { b: 2 }] };
        const copy = jsonCopy(source);
        expect(copy).toEqual(source);
        expect(copy).not.toBe(source);
        expect(jsonCopy(undefined)).toBeUndefined();
        expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
        expect(sameJson({ a: 1, c: undefined }, { a: 1 })).toBe(true);
        expect(sameJson([1, 2], [2, 1])).toBe(false);
        expect(sameJson(undefined, null)).toBe(true);
        expect(clip('  a   b  ', 10)).toBe('a b');
        expect(clip('abcdef', 4)).toBe('abc…');
        expect(pickName(['World', 'world', 'Atlas'], 'World')).toEqual({ name: 'World', ambiguous: false });
        expect(pickName(['World', 'world'], 'WORLD')).toEqual({ name: null, ambiguous: true });
        expect(pickName(['Atlas'], 'atlas')).toEqual({ name: 'Atlas', ambiguous: false });
        expect(pickName(['Atlas'], 'x')).toEqual({ name: null, ambiguous: false });
    });
});
