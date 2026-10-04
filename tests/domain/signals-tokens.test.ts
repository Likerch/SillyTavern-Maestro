import { describe, expect, it } from 'vitest';
import {
    containsAll,
    jaccard,
    normalizeText,
    sameTokens,
    stemWord,
    textWords,
    textsDiffer,
    tokenSet,
    wordDiff,
} from '../../src/domain/signals-tokens';

describe('signals tokens', () => {
    it('normalises text and splits words', () => {
        expect(normalizeText('  Чёрные   ВОЛОСЫ ')).toBe('черные волосы');
        expect(normalizeText(undefined as unknown as string)).toBe('');
        expect(textWords('Red dress, silver-necklace!')).toEqual(['red', 'dress', 'silver', 'necklace']);
    });

    it('stems Russian case forms and English endings', () => {
        expect(stemWord('чёрные')).toBe(stemWord('черными'));
        expect(stemWord('волосы')).toBe(stemWord('волосами'));
        expect(stemWord('платье')).toBe(stemWord('платьем'));
        expect(stemWord('зеленого')).toBe(stemWord('зеленые'));
        expect(stemWord('кот')).toBe('кот');
        expect(stemWord('ivies')).toBe('ivy');
        expect(stemWord('dresses')).toBe('dress');
        expect(stemWord('wearing')).toBe('wear');
        expect(stemWord('torned')).toBe('torn');
        expect(stemWord('boots')).toBe('boot');
        expect(stemWord('glass')).toBe('glass');
        expect(stemWord('1856')).toBe('1856');
        expect(stemWord('')).toBe('');
    });

    it('builds token sets without stop words and short words', () => {
        expect([...tokenSet('She is wearing a red dress with her boots, 3 rings')]).toEqual([
            'red',
            'dress',
            'boot',
            '3',
            'ring',
        ]);
        expect([...tokenSet('она в красном платье')]).toEqual(['красн', 'плать']);
    });

    it('compares sets', () => {
        const a = new Set(['a', 'b', 'c']);
        const b = new Set(['a', 'b']);
        expect(jaccard(a, b)).toBeCloseTo(2 / 3);
        expect(jaccard(new Set(), new Set())).toBe(1);
        expect(containsAll(a, b)).toBe(true);
        expect(containsAll(b, a)).toBe(false);
        expect(containsAll(a, new Set())).toBe(false);
        expect(sameTokens(a, new Set(['c', 'b', 'a']))).toBe(true);
        expect(sameTokens(a, b)).toBe(false);
    });

    it('tells a meaningful change from wording noise', () => {
        expect(textsDiffer('long black hair, green eyes', 'green eyes and long black hair', 0.5)).toBe(false);
        expect(textsDiffer('Long black hair, green eyes', 'long black hair, green eyes, a scar', 0.5)).toBe(false);
        expect(textsDiffer('red dress, silver necklace', 'leather armor, sword belt', 0.5)).toBe(true);
        expect(textsDiffer('чёрные волосы, зелёные глаза', 'черными волосами и зелеными глазами', 0.5)).toBe(false);
        expect(textsDiffer('простое платье', 'кожаные доспехи', 0.5)).toBe(true);
        // One word differs: not enough on its own.
        expect(textsDiffer('red dress', 'blue dress', 0.9)).toBe(true);
        expect(textsDiffer('dress', 'gown', 0.5)).toBe(true);
        expect(textsDiffer('a b', 'c d', 0.5)).toBe(true);
        expect(textsDiffer('a b', 'a b', 0.5)).toBe(false);
    });

    it('lists added and removed words', () => {
        expect(wordDiff('red dress, silver necklace', 'black cloak over a red dress')).toEqual({
            added: ['black', 'cloak'],
            removed: ['silver', 'necklace'],
        });
        expect(wordDiff('a b c d e f g h i j', 'k l m', 2).removed.length).toBe(0);
        expect(wordDiff('cat dog fox owl', 'bee', 2).removed).toEqual(['cat', 'dog']);
    });
});
