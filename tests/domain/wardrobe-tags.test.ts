import { describe, expect, it } from 'vitest';
import {
    cleanOutfitText,
    isAnatomyTag,
    lookupEn,
    lookupRu,
    outfitConcepts,
    outfitFromStatement,
    outfitName,
    outfitPhrases,
    outfitTagList,
    outfitTags,
    sanitizeTags,
    termOf,
} from '../../src/domain/wardrobe-tags';

const NAI_TAGS = /^[a-z0-9 ,'-]*$/;

describe('outfitTags: Russian wording through the dictionary', () => {
    it.each([
        [
            'Тёмно-синее шёлковое платье с открытыми плечами, кожаные сапоги',
            'off-shoulder dark blue silk dress, leather boots',
        ],
        [
            'Белая блузка и чёрная юбка, чулки, туфли на каблуках',
            'white blouse, black skirt, stockings, shoes, high heels',
        ],
        ['Кожаная куртка, рваные джинсы, кроссовки', 'leather jacket, torn jeans, sneakers'],
        [
            'Простое льняное платье, поверх — потёртый плащ с капюшоном; на ногах сапоги.',
            'linen dress, hooded worn cloak, boots',
        ],
        ['чёрно-белое платье без рукавов', 'sleeveless black and white dress'],
        ['ночная сорочка', 'nightgown'],
        ['платье в пол', 'floor-length dress'],
        ['юбка в клетку и блузка в горошек', 'plaid skirt, polka-dot blouse'],
        ['рубашка белая', 'white shirt'],
        ['школьная форма', 'school uniform'],
        ['Красное шёлковое вечернее платье', 'red silk evening dress'],
        ['длинное рваное чёрное платье', 'long torn black dress'],
        ['серьги и серое платье', 'earrings, grey dress'],
        ['латы и стальной шлем', 'plate armor, steel helmet'],
        ['босиком', 'barefoot'],
    ])('%s → %s', (text, tags) => {
        expect(outfitTags(text)).toBe(tags);
    });

    it('drops what it does not know and what is not clothing', () => {
        expect(outfitTags('синяк на руке')).toBe('');
        expect(outfitTags('в красном')).toBe('');
        expect(outfitTags('мокрая грязная одежда')).toBe('');
        expect(outfitTags('халат на голое тело')).toBe('robe');
    });

    it('marks garments and keeps mixed phrases (English words inside Russian text)', () => {
        expect(outfitTagList('кожаная jacket')).toEqual([{ tag: 'leather jacket', garment: true }]);
        expect(outfitTagList('рваные vintage')).toEqual([{ tag: 'torn vintage', garment: false }]);
    });
});

describe('outfitTags: English wording passes through', () => {
    it.each([
        ['A tattered grey cloak over leather armour', 'tattered grey cloak, leather armor'],
        ['red silk evening gown with a slit', 'red silk evening gown, slit'],
        ['Her favourite gray hoodie and blue jeans', 'grey hoodie, blue jeans'],
        ['travel clothes', 'travel clothes'],
        ['a crimson kimono-style wrap dress', 'crimson kimono-style wrap dress'],
    ])('%s → %s', (text, tags) => {
        expect(outfitTags(text)).toBe(tags);
    });

    it('drops colours alone, filler and numbers', () => {
        expect(outfitTags('red')).toBe('');
        expect(outfitTags('the, a, 42')).toBe('');
    });
});

describe('NAI tag rules', () => {
    it('never puts explicit anatomy into an outfit and keeps everything lower-case Latin', () => {
        expect(outfitTags('nude, nipples visible, black stockings')).toBe('nude, black stockings');
        expect(outfitTags('Pussy, BLACK Lace Panties')).toBe('black lace panties');
        for (const text of ['Тёмно-синее ПЛАТЬЕ', 'Leather ARMOUR, Steel Gauntlets', 'Юбка и Blouse']) {
            expect(outfitTags(text)).toMatch(NAI_TAGS);
        }
    });

    it('recognises anatomy words but not garments that contain them', () => {
        expect(isAnatomyTag('bare breasts')).toBe(true);
        expect(isAnatomyTag('nipples')).toBe(true);
        expect(isAnatomyTag('pubic hair')).toBe(true);
        expect(isAnatomyTag('breastplate')).toBe(false);
        expect(isAnatomyTag('leather armor')).toBe(false);
    });

    it('caps the tag count and the words of a tag', () => {
        const many = Array.from({ length: 20 }, (_, i) => `item${i} shirt`).join(', ');
        expect(outfitTagList(many)).toHaveLength(12);
        expect(outfitTags('very long magnificent shining dark enchanted royal ceremonial ball gown')).toBe(
            'shining dark enchanted royal ceremonial ball gown'.split(' ').slice(-6).join(' '),
        );
    });

    it('sanitizes stored tag strings', () => {
        expect(sanitizeTags('White_Shirt, юбка, nipples, <b>, white shirt,,  Black Skirt ')).toBe(
            'white shirt, black skirt',
        );
        expect(sanitizeTags('')).toBe('');
    });
});

describe('words and phrases', () => {
    it('looks Russian words up by the longest prefix or the exact form', () => {
        expect(lookupRu('Платьями')).toEqual({ en: 'dress', kind: 'garment' });
        expect(lookupRu('серебряный')).toEqual({ en: 'silver', kind: 'colour' });
        expect(lookupRu('синяки')?.kind).toBe('skip');
        expect(lookupRu('латы')).toEqual({ en: 'plate armor', kind: 'garment' });
        expect(lookupRu('латышский')).toBeNull();
        expect(lookupRu('')).toBeNull();
        expect(termOf('синяк')).toBeNull();
        expect(termOf('неизвестное')).toBeNull();
    });

    it('looks English words up with plurals, spelling and filler', () => {
        expect(lookupEn('dresses')).toEqual({ en: 'dresses', kind: 'garment' });
        expect(lookupEn('gray')).toEqual({ en: 'grey', kind: 'colour' });
        expect(lookupEn('Pyjamas')).toEqual({ en: 'pajamas', kind: 'garment' });
        expect(lookupEn('vintage')).toEqual({ en: 'vintage', kind: 'other' });
        expect(lookupEn('the')).toBeNull();
        expect(lookupEn('42')).toBeNull();
        expect(lookupEn('')).toBeNull();
    });

    it('splits phrases on punctuation and links in both languages', () => {
        expect(outfitPhrases('Плащ поверх доспеха, сапоги и перчатки')).toEqual([
            'плащ',
            'доспеха',
            'сапоги',
            'перчатки',
        ]);
        expect(outfitPhrases('a cloak over armor; boots with buckles')).toEqual([
            'a cloak',
            'armor',
            'boots',
            'buckles',
        ]);
    });

    it('cleans a wording and refuses empty ones', () => {
        expect(cleanOutfitText('  white   shirt ')).toBe('white shirt');
        for (const empty of ['', '  ', 'none', 'Нет', 'N/A', '—', '{{outfit}}', '[Outfit]', 42, null]) {
            expect(cleanOutfitText(empty)).toBeNull();
        }
        expect(cleanOutfitText('x'.repeat(700))).toHaveLength(600);
    });
});

describe('outfitName', () => {
    it('names an outfit after its first garments', () => {
        expect(outfitName(outfitTagList('Белая блузка и чёрная юбка, чулки'))).toBe('white blouse and black skirt');
        expect(outfitName(outfitTagList('Тёмно-синее шёлковое платье, кожаные сапоги'))).toBe('blue silk dress');
        expect(outfitName(outfitTagList('red silk evening gown with a slit'))).toBe('silk evening gown');
        expect(outfitName(outfitTagList('чёрно-белое платье'))).toBe('white dress');
        expect(outfitName(outfitTagList('nude, black stockings'))).toBe('black stockings');
        expect(outfitName(outfitTagList('torn vintage'))).toBe('torn vintage');
        expect(outfitName([])).toBe('outfit');
    });

    it('keeps names unique in the passport and short', () => {
        const tags = outfitTagList('blue dress');
        expect(outfitName(tags, ['Blue Dress'])).toBe('blue dress 2');
        expect(outfitName(tags, ['blue dress', 'blue dress 2'])).toBe('blue dress 3');
        const long = [{ tag: 'supercalifragilisticexpialidocious extraordinarily-magnificent gown', garment: true }];
        expect(outfitName(long).length).toBeLessThanOrEqual(40);
    });
});

describe('outfitFromStatement', () => {
    it.each([
        ['Anna now wears a black leather jacket and torn jeans.', 'a black leather jacket and torn jeans'],
        ['Changed into a red evening gown for the ball.', 'a red evening gown'],
        ['Her outfit: blue kimono', 'blue kimono'],
        ['Is dressed in travel clothes.', 'travel clothes'],
        ['Anna is in a white sundress', 'white sundress'],
        ['Puts on a fur coat while it snows', 'a fur coat'],
        ['Black cloak and boots.', 'Black cloak and boots'],
    ])('%s → %s', (statement, wording) => {
        expect(outfitFromStatement(statement)).toBe(wording);
    });

    it('refuses removals and empty statements', () => {
        expect(outfitFromStatement('Took off her armor.')).toBeNull();
        expect(outfitFromStatement('Removed the cloak')).toBeNull();
        expect(outfitFromStatement('Сняла плащ')).toBeNull();
        expect(outfitFromStatement('none')).toBeNull();
        expect(outfitFromStatement('Wears.')).toBeNull();
    });
});

describe('outfitConcepts', () => {
    it('folds synonyms and languages into one set', () => {
        const english = outfitConcepts('red evening gown, trousers');
        const russian = outfitConcepts('красное вечернее платье, брюки');
        expect([...english.garments].sort()).toEqual(['dress', 'pant']);
        expect([...russian.garments].sort()).toEqual(['dress', 'pant']);
        expect([...english.colours]).toEqual(['red']);
        expect([...russian.colours]).toEqual(['red']);
        expect(english.all.has('evening')).toBe(true);
    });

    it('splits multi-word terms and leaves out anatomy', () => {
        const heels = outfitConcepts('туфли на каблуках');
        expect([...heels.garments].sort()).toEqual(['heel', 'shoe']);
        expect(heels.all.has('high')).toBe(true);
        expect(outfitConcepts('nipples, stockings').all.has('nipple')).toBe(false);
        expect(outfitConcepts('').all.size).toBe(0);
    });
});
