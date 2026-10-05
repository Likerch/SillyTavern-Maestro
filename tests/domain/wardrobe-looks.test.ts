import { describe, expect, it } from 'vitest';
import {
    addedLooks,
    lookKey,
    lookWording,
    MAX_LOOK_LENGTH,
    MAX_OUTFIT_LOOKS,
    outfitWithLooks,
    withLook,
    withoutLooks,
} from '../../src/domain/wardrobe-looks';

describe('outfit wordings for NAI Studio (looks)', () => {
    it('reduces a wording the way NAI Studio does', () => {
        expect(lookKey('Чёрная кожаная куртка — «потёртая», джинсы!')).toBe('черная кожаная куртка потертая джинсы');
        expect(lookKey('  Black   leather-jacket,\n"torn" jeans  ')).toBe('black leather jacket torn jeans');
        expect(lookKey('…')).toBe('');
        expect(lookWording(`  ${'x'.repeat(MAX_LOOK_LENGTH + 20)}`)).toHaveLength(MAX_LOOK_LENGTH);
    });

    it('adds a wording at the end, skips one known after reduction, keeps the newest ones', () => {
        expect(withLook(undefined, '  Красное платье ')).toEqual(['Красное платье']);
        expect(withLook(['Красное платье'], 'красное платье!')).toBeNull();
        expect(withLook(['Красное платье'], '—')).toBeNull();
        const full = Array.from({ length: MAX_OUTFIT_LOOKS }, (_, i) => `wording ${i}`);
        const next = withLook(full, 'newest')!;
        expect(next).toHaveLength(MAX_OUTFIT_LOOKS);
        expect(next[0]).toBe('wording 1');
        expect(next.at(-1)).toBe('newest');
        expect(full).toHaveLength(MAX_OUTFIT_LOOKS);
    });

    it('tells what a change added and takes exactly that back', () => {
        const added = addedLooks(['old'], ['old', 'New one']);
        expect(added).toEqual(['New one']);
        expect(withoutLooks(['old', 'new one!', 'later'], added)).toEqual(['old', 'later']);
        expect(withoutLooks(undefined, added)).toEqual([]);
    });

    it('sets the field on a copy and drops it when empty', () => {
        const outfit = { name: 'Gown', tags: 'gown', looks: ['a'] };
        expect(outfitWithLooks(outfit, ['a', 'b'])).toEqual({ name: 'Gown', tags: 'gown', looks: ['a', 'b'] });
        const bare = outfitWithLooks(outfit, []);
        expect(bare).toEqual({ name: 'Gown', tags: 'gown' });
        expect('looks' in bare).toBe(false);
        expect(outfit.looks).toEqual(['a']);
    });
});
