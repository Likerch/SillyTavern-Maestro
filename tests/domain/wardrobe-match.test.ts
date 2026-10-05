import { describe, expect, it } from 'vitest';
import { conceptScore, matchOutfit, MATCH_THRESHOLD, outfitScore, wordingScore } from '../../src/domain/wardrobe-match';
import type { OutfitLike } from '../../src/domain/wardrobe-match';
import { outfitConcepts } from '../../src/domain/wardrobe-tags';

const OUTFITS: OutfitLike[] = [
    { name: 'black dress', tags: 'black dress, high heels' },
    { name: 'office', tags: 'white blouse, black pencil skirt, black pantyhose, high heels' },
    { name: 'maid', tags: 'white blouse, black skirt, black apron, white headdress' },
    { name: '', tags: 'blue jeans, grey hoodie, sneakers', seenAs: ['Джинсы и серая толстовка'] },
];

describe('matchOutfit', () => {
    it('recognises a Russian wording of an English-tagged outfit', () => {
        expect(matchOutfit('Чёрное платье', OUTFITS)).toMatchObject({ name: 'black dress', via: 'tags' });
        expect(matchOutfit('A black cocktail dress', OUTFITS)?.name).toBe('black dress');
    });

    it('tells outfits with the same garments apart by colour and by the rest', () => {
        expect(matchOutfit('красное платье', OUTFITS)).toBeNull();
        expect(matchOutfit('Белая блузка, чёрная юбка, колготки, туфли на каблуках', OUTFITS)?.name).toBe('office');
        expect(matchOutfit('white blouse, black skirt, black apron', OUTFITS)?.name).toBe('maid');
    });

    it('recognises the clothing slot and wordings seen before', () => {
        expect(matchOutfit('синие джинсы, серая худи, кроссовки', OUTFITS)?.name).toBe('');
        expect(matchOutfit('Джинсы и серая толстовка', OUTFITS)).toMatchObject({ name: '', score: 1, via: 'seen' });
    });

    it('finds nothing for new clothes, and respects the threshold', () => {
        expect(matchOutfit('Кожаная куртка, рваные джинсы', OUTFITS)).toBeNull();
        expect(matchOutfit('black dress', OUTFITS, 1.01)).toBeNull();
        expect(matchOutfit('black dress', [])).toBeNull();
        expect(MATCH_THRESHOLD).toBeGreaterThan(0.5);
    });

    it('keeps the earlier outfit on a tie (callers list the newest first)', () => {
        const twins: OutfitLike[] = [
            { name: 'first', tags: 'green cloak' },
            { name: 'second', tags: 'green cloak' },
        ];
        expect(matchOutfit('green cloak', twins)?.name).toBe('first');
    });
});

describe('scores', () => {
    it('is zero without content or without a common garment', () => {
        expect(conceptScore(outfitConcepts(''), outfitConcepts('dress'))).toBe(0);
        expect(conceptScore(outfitConcepts('red dress'), outfitConcepts('red boots'))).toBe(0);
    });

    it('compares materials and colours when no garment is named', () => {
        expect(conceptScore(outfitConcepts('silk'), outfitConcepts('silk'))).toBeCloseTo(0.8);
        expect(conceptScore(outfitConcepts('red silk'), outfitConcepts('blue silk'))).toBeLessThan(0.3);
    });

    it('scores wordings by words or concepts', () => {
        expect(wordingScore('Синее платье', 'синее  платье')).toBe(1);
        expect(wordingScore('синее платье', 'синим платьем')).toBe(1);
        expect(wordingScore('blue gown', 'синее платье')).toBeGreaterThan(0.9);
        expect(wordingScore('blue gown', 'leather boots')).toBe(0);
    });

    it('takes the better of seen wordings and tags', () => {
        expect(outfitScore('blue gown', { name: 'x', tags: '', seenAs: ['синее платье'] }).via).toBe('seen');
        expect(outfitScore('blue gown', { name: 'blue dress', tags: 'blue dress' }).via).toBe('tags');
        expect(outfitScore('blue gown', { name: '', tags: ' ' }).score).toBe(0);
    });
});
