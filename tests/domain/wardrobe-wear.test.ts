import { describe, expect, it } from 'vitest';
import { bodyWords, clothingOf, clothingPieces, detectUndress, mentionsClothing } from '../../src/domain/wardrobe-wear';

const text = (value: string) => clothingOf(value)?.text ?? null;

describe('clothingPieces / clothingOf', () => {
    it('cuts the clothing out of DES appearance texts, as written', () => {
        expect(
            text('высокая женщина с короткими белыми волосами и шрамом на щеке, в мокром тёмно-синем плаще, с фонарём'),
        ).toBe('в мокром тёмно-синем плаще');
        expect(text('в промокшем кожаном фартуке, с молотом')).toBe('в промокшем кожаном фартуке');
        expect(text('худой юноша-трактирщик с рыжими кудрями и веснушками, в белой рубахе и зелёном жилете')).toBe(
            'в белой рубахе и зелёном жилете',
        );
        expect(text('Длинные рыжие волосы, зелёные глаза, веснушки. Носит белую блузку и чёрную юбку.')).toBe(
            'Носит белую блузку и чёрную юбку',
        );
        expect(text('Одета в простое серое платье с белым воротничком, на ногах стоптанные башмаки')).toBe(
            'Одета в простое серое платье с белым воротничком, стоптанные башмаки',
        );
        expect(text('Стройная девушка лет двадцати в дорожной одежде')).toBe('в дорожной одежде');
    });

    it('keeps cuts that name a body part and garment parts with their garment', () => {
        expect(text('Красное шёлковое платье с открытыми плечами, золотые серьги, туфли на каблуках')).toBe(
            'Красное шёлковое платье с открытыми плечами, золотые серьги, туфли на каблуках',
        );
        expect(text('Кожаная куртка с латунными пряжками')).toBe('Кожаная куртка с латунными пряжками');
        expect(text('Бледно-голубое платье до колен, волосы перехвачены синей лентой')).toBe(
            'Бледно-голубое платье до колен',
        );
        expect(text('A dress with bare shoulders and knee-high boots')).toBe(
            'dress with bare shoulders and knee-high boots',
        );
    });

    it('reads English with its verb of wearing, and drops hair and body', () => {
        expect(
            text('A tall woman with long red hair and green eyes, wearing a black leather jacket and torn jeans.'),
        ).toBe('wearing a black leather jacket and torn jeans');
        expect(text('She has long hair tied with a ribbon and wears a simple grey dress')).toBe(
            'wears a simple grey dress',
        );
    });

    it('says nothing when there is no clothing; the waist is not a belt', () => {
        expect(clothingOf('Волосы собраны в тугую косу, на поясе кинжал')).toBeNull();
        expect(clothingOf('спокойна, настороженная')).toBeNull();
        expect(clothingOf('')).toBeNull();
        expect(clothingOf(42)).toBeNull();
        expect(clothingPieces('Мундир стражи, на рукаве потёртая нашивка')).toEqual(['Мундир']);
        expect(clothingPieces('Очки на цепочке; очки на цепочке')).toEqual(['Очки на цепочке']);
    });

    it('takes undressing with the clothes still on', () => {
        expect(clothingOf('в одном нижнем белье, босиком')).toEqual({
            text: 'в одном нижнем белье, босиком',
            undress: { kind: 'underwear', phrase: 'в одном нижнем белье' },
        });
        expect(clothingOf('Обнажена, волосы распущены по плечам')).toEqual({
            text: 'Обнажена',
            undress: { kind: 'naked', phrase: 'Обнажена' },
        });
        expect(clothingOf('topless, in ripped jeans')).toEqual({
            text: 'in ripped jeans',
            undress: { kind: 'partial', phrase: 'topless' },
        });
        // Underwear alone is being in underwear.
        expect(clothingOf('чёрное кружевное бельё')?.undress?.kind).toBe('underwear');
        expect(clothingOf('black lace lingerie and stockings')?.undress).toBeNull();
    });
});

describe('detectUndress', () => {
    it('knows the Russian and English words, the most covering first', () => {
        expect(detectUndress('завёрнута в банное полотенце, мокрые волосы')).toEqual({
            kind: 'towel',
            phrase: 'завёрнута в банное полотенце',
        });
        expect(detectUndress('обнажена, в одном полотенце')?.kind).toBe('towel');
        expect(detectUndress('wrapped in a towel')?.kind).toBe('towel');
        expect(detectUndress('раздета до нижнего белья')?.kind).toBe('underwear');
        expect(detectUndress('in her underwear')?.kind).toBe('underwear');
        expect(detectUndress('по пояс голый')?.kind).toBe('partial');
        expect(detectUndress('обнажённый торс')?.kind).toBe('partial');
        expect(detectUndress('без рубашки')?.kind).toBe('partial');
        expect(detectUndress('shirtless')?.kind).toBe('partial');
        expect(detectUndress('без одежды')?.kind).toBe('naked');
        expect(detectUndress('Совершенно голая')?.kind).toBe('naked');
        expect(detectUndress('naked')?.kind).toBe('naked');
        expect(detectUndress('in the nude')?.kind).toBe('naked');
    });

    it('skips negations, bare body parts, weapons and the colour «nude»', () => {
        expect(detectUndress('не раздета, в пижаме')).toBeNull();
        expect(detectUndress('уже не голая')).toBeNull();
        expect(detectUndress('not naked')).toBeNull();
        expect(detectUndress('голые плечи, лёгкое летнее платье')).toBeNull();
        expect(detectUndress('с обнажённым мечом в руке, в кольчуге')).toBeNull();
        expect(detectUndress('nude lipstick, black evening gown')).toBeNull();
        expect(detectUndress('nude-colored dress')).toBeNull();
        expect(detectUndress('Раздета. Нет, не голая')?.kind).toBe('naked');
        expect(detectUndress('')).toBeNull();
    });
});

describe('mentionsClothing / bodyWords', () => {
    it('gates the persona check cheaply', () => {
        expect(mentionsClothing('Кай накинул плащ и вышел')).toBe(true);
        expect(mentionsClothing('She took off her boots')).toBe(true);
        expect(mentionsClothing('он разделся')).toBe(true);
        expect(detectUndress('разделась до пояса')?.kind).toBe('partial');
        expect(mentionsClothing('Она обнажена')).toBe(true);
        expect(mentionsClothing('Они говорили о погоде')).toBe(false);
    });

    it('lists the body words of a text, cut idioms aside', () => {
        expect(bodyWords('рыжие волосы, зелёные глаза, платье с открытыми плечами')).toEqual(['волосы', 'глаза']);
        expect(bodyWords('long hair, bare shoulders')).toEqual(['hair']);
        expect(bodyWords('в белой рубахе')).toEqual([]);
    });
});
