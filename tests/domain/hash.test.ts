import { describe, expect, it } from 'vitest';
import { fnv1a32, hash53, stableHash } from '../../src/domain/hash';

describe('fnv1a32', () => {
    it('matches the reference vectors', () => {
        expect(fnv1a32('')).toBe(0x811c9dc5);
        expect(fnv1a32('a')).toBe(0xe40c292c);
        expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    });

    it('hashes UTF-8 bytes (2, 3 and 4 byte sequences)', () => {
        // Values cross-checked against Buffer.from(text, 'utf8') in Node.
        expect(fnv1a32('€')).toBe(0x298f832b);
        expect(fnv1a32('\u{1F600}')).toBe(0x33a29608);
        expect(fnv1a32('Привет, мир')).toBe(0xbc930f96);
        expect(fnv1a32('ß')).not.toBe(fnv1a32('ss'));
    });

    it('maps lone surrogates to U+FFFD like TextEncoder', () => {
        expect(fnv1a32('\uD800')).toBe(fnv1a32('�'));
        expect(fnv1a32('\uDC00')).toBe(fnv1a32('�'));
        expect(fnv1a32('x\uD800y')).toBe(fnv1a32('x�y'));
    });

    it('returns unsigned 32-bit integers', () => {
        for (const text of ['', 'a', 'zzzz', 'Мастер', '🎻🎻']) {
            const value = fnv1a32(text);
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(2 ** 32);
        }
    });
});

describe('hash53', () => {
    it('matches the published cyrb53 values for ASCII', () => {
        expect(hash53('a')).toBe(7929297801672961);
        expect(hash53('b')).toBe(8684336938537663);
        expect(hash53('revenge')).toBe(4051478007546757);
        expect(hash53('revenue')).toBe(8309097637345594);
    });

    it('stays within the safe integer range and depends on the seed', () => {
        const value = hash53('Maestro');
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeLessThan(2 ** 53);
        expect(hash53('Maestro', 1)).not.toBe(value);
    });

    it('treats surrogate pairs as one code point', () => {
        expect(hash53('\u{1F600}')).toBe(hash53('😀'));
        expect(hash53('\uD83D')).toBe(hash53('�'));
    });
});

describe('stableHash', () => {
    it('is deterministic, short and file-name safe', () => {
        const ids = ['chat-1', 'Anna - 2026-10-04@12h00m00s', 'Анна — чат', '', 'a/b\\c?.json'];
        for (const id of ids) {
            const value = stableHash(id);
            expect(value).toBe(stableHash(id));
            expect(value).toMatch(/^[0-9a-z]{1,11}$/);
        }
    });

    it('separates similar ids', () => {
        const values = new Set<string>();
        for (let i = 0; i < 5000; i++) values.add(stableHash(`chat-${i}`));
        expect(values.size).toBe(5000);
        expect(stableHash('revenge')).not.toBe(stableHash('revenue'));
    });
});
