import { describe, expect, it } from 'vitest';
import { freshMark } from '../../src/domain/turn-mark';

describe('freshMark', () => {
    it('keeps a mark inside the chat', () => {
        expect(freshMark(4, 10)).toBe(4);
        expect(freshMark(9, 10)).toBe(9);
        expect(freshMark(-1, 0)).toBe(-1);
    });

    it('resets a mark that points past the end of the chat', () => {
        expect(freshMark(10, 10)).toBe(-1);
        expect(freshMark(665, 660)).toBe(-1);
        expect(freshMark(Number.NaN, 5)).toBe(-1);
    });
});
