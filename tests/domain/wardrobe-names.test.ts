import { describe, expect, it } from 'vitest';
import {
    isOwnClothes,
    newOutfitName,
    ownClothesName,
    russianOutfitName,
    undressOfOutfit,
    undressOutfitName,
    UNDRESS_TAGS,
} from '../../src/domain/wardrobe-names';
import { outfitTagList } from '../../src/domain/wardrobe-tags';

const name = (wording: string, taken: string[] = []) => russianOutfitName(outfitTagList(wording), wording, taken);

describe('russianOutfitName', () => {
    it('names one garment with its most telling adjective, in agreement', () => {
        expect(name('Тёмно-синее шёлковое платье, кожаные сапоги')).toBe('Шёлковое платье');
        expect(name('в промокшем кожаном фартуке')).toBe('Кожаный фартук');
        expect(name('вечернее платье цвета слоновой кости')).toBe('Вечернее платье');
        expect(name('в мокром тёмно-синем плаще')).toBe('Синий плащ');
        expect(name('чёрное кружевное бельё')).toBe('Кружевное бельё');
        expect(name('лёгкое летнее платье')).toBe('Летнее платье');
        expect(name('голубая блузка')).toBe('Голубая блузка');
        expect(name('шерстяные брюки')).toBe('Шерстяные брюки');
        expect(name('в дорожной одежде')).toBe('Дорожная одежда');
    });

    it('names two main garments with «и», footwear only when nothing else', () => {
        expect(name('белая блузка и чёрная юбка')).toBe('Блузка и юбка');
        expect(name('в белой рубахе и зелёном жилете')).toBe('Рубаха и жилет');
        expect(name('Шерстяной свитер, джинсы, высокие ботинки')).toBe('Свитер и джинсы');
        expect(name('платье, сапоги')).toBe('Платье и сапоги');
        expect(name('в махровом халате и тапочках')).toBe('Халат и тапочки');
        expect(name('высокие сапоги')).toBe('Сапоги');
        expect(name('black leather jacket and torn jeans')).toBe('Куртка и джинсы');
        expect(name('кольчуга')).toBe('Кольчуга');
    });

    it('stays unique: another adjective, then a number', () => {
        expect(name('красное шёлковое платье', ['Шёлковое платье'])).toBe('Красное шёлковое платье');
        expect(name('шёлковое платье, сапоги', ['Шёлковое платье'])).toBe('Шёлковое платье и сапоги');
        expect(name('белая блузка и чёрная юбка', ['блузка и юбка'])).toBe('Блузка и юбка 2');
        expect(name('шёлковое платье', ['Шёлковое платье', 'Шёлковое платье 2'])).toBe('Шёлковое платье 3');
    });

    it('gives up without a known garment', () => {
        expect(name('нечто странное')).toBeNull();
        expect(russianOutfitName([], '')).toBeNull();
    });
});

describe('newOutfitName', () => {
    it('is Russian in a Russian UI and English otherwise', () => {
        const wording = 'Тёмно-синее шёлковое платье, кожаные сапоги';
        const tags = outfitTagList(wording);
        expect(newOutfitName('ru', tags, wording, [])).toBe('Шёлковое платье');
        expect(newOutfitName('en', tags, wording, [])).toBe('blue silk dress');
        expect(newOutfitName('ru', outfitTagList('travel gear'), 'travel gear', [])).toBe('Дорожная одежда');
        expect(newOutfitName('ru', outfitTagList('cyberdeck harness'), 'cyberdeck harness', [])).toBe(
            'cyberdeck harness',
        );
    });
});

describe('built-in outfits', () => {
    it('names undressing in both languages and knows it back', () => {
        expect(undressOutfitName('naked', 'ru')).toBe('Без одежды');
        expect(undressOutfitName('towel', 'ru')).toBe('В полотенце');
        expect(undressOutfitName('underwear', 'ru')).toBe('Нижнее бельё');
        expect(undressOutfitName('naked', 'en')).toBe('No clothes');
        expect(undressOutfitName('partial', 'en')).toBe('partial');
        expect(undressOfOutfit('нижнее белье')).toBe('underwear');
        expect(undressOfOutfit('In a towel')).toBe('towel');
        expect(undressOfOutfit('Шёлковое платье')).toBeNull();
        expect(undressOfOutfit('')).toBeNull();
        expect(UNDRESS_TAGS.naked).toBe('nude');
        expect(UNDRESS_TAGS.towel).toContain('towel');
    });

    it('names the clothing slot stand-in', () => {
        expect(ownClothesName('ru')).toBe('Своя одежда');
        expect(ownClothesName('en')).toBe('Own clothes');
        expect(isOwnClothes(' своя одежда ')).toBe(true);
        expect(isOwnClothes('Own clothes')).toBe(true);
        expect(isOwnClothes('ballgown')).toBe(false);
        expect(isOwnClothes('')).toBe(false);
    });
});
