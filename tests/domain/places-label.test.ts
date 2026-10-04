import { describe, expect, it } from 'vitest';
import {
    cleanLabel,
    lexiconDirection,
    normalizePlaceName,
    orderLabelParts,
    parsePlaceLabel,
    placeLevel,
    placeWords,
    separatorDirection,
    splitLabel,
    wordLevel,
} from '../../src/domain/places-label';

describe('normalizePlaceName', () => {
    it('folds case, ё, quotes, articles and edge punctuation', () => {
        expect(normalizePlaceName('Таверна «Ржавый якорь»')).toBe('таверна ржавый якорь');
        expect(normalizePlaceName('  The Rusty   Anchor. ')).toBe('rusty anchor');
        expect(normalizePlaceName('Ёлкино')).toBe('елкино');
        expect(normalizePlaceName('“Main Hall”')).toBe('main hall');
        expect(normalizePlaceName('Lyra’s Bedroom')).toBe("lyra's bedroom");
        expect(normalizePlaceName('— (Inn) —')).toBe('inn');
        expect(normalizePlaceName('Theater')).toBe('theater');
    });

    it('splits words', () => {
        expect(placeWords("Lyra's  Room-3")).toEqual(["lyra's", 'room', '3']);
        expect(placeWords('')).toEqual([]);
    });
});

describe('cleanLabel', () => {
    it('drops empty, filler and overly long labels', () => {
        expect(cleanLabel('  Rusty   Anchor ')).toBe('Rusty Anchor');
        expect(cleanLabel('Unknown')).toBeNull();
        expect(cleanLabel('Там же')).toBeNull();
        expect(cleanLabel('N/A')).toBeNull();
        expect(cleanLabel('   ')).toBeNull();
        expect(cleanLabel('...')).toBeNull();
        expect(cleanLabel('x'.repeat(201))).toBeNull();
        expect(cleanLabel(42)).toBeNull();
        expect(cleanLabel(undefined)).toBeNull();
    });
});

describe('splitLabel', () => {
    it('splits on commas, keeping the written order', () => {
        expect(splitLabel('Main Hall, Rusty Anchor Tavern, Docks District, Port Royal')).toEqual({
            parts: ['Main Hall', 'Rusty Anchor Tavern', 'Docks District', 'Port Royal'],
            kinds: [null, 'comma', 'comma', 'comma'],
        });
        expect(splitLabel('Kitchen; Manor').kinds).toEqual([null, 'comma']);
    });

    it('splits on dashes, arrows and bars but never inside hyphenated names', () => {
        expect(splitLabel('Москва — Арбат')).toEqual({ parts: ['Москва', 'Арбат'], kinds: [null, 'dash'] });
        expect(splitLabel('Город–район').parts).toEqual(['Город', 'район']);
        expect(splitLabel('Нью-Йорк, Бруклин').parts).toEqual(['Нью-Йорк', 'Бруклин']);
        expect(splitLabel('Castle > Throne Room').kinds).toEqual([null, 'dash']);
        expect(splitLabel('Castle -> Throne Room').parts).toEqual(['Castle', 'Throne Room']);
        expect(splitLabel('Inn / Tavern').parts).toEqual(['Inn', 'Tavern']);
        expect(splitLabel('24/7 Diner').parts).toEqual(['24/7 Diner']);
        expect(splitLabel('Forest - Clearing').parts).toEqual(['Forest', 'Clearing']);
        expect(splitLabel('Forest -- Clearing')).toEqual({ parts: ['Forest', 'Clearing'], kinds: [null, 'dash'] });
        expect(splitLabel('Docks | Pier 9 · Warehouse').parts).toEqual(['Docks', 'Pier 9', 'Warehouse']);
    });

    it('keeps quoted names whole', () => {
        expect(splitLabel('Таверна «Ржавый якорь, и сыновья», зал').parts).toEqual([
            'Таверна «Ржавый якорь, и сыновья»',
            'зал',
        ]);
        expect(splitLabel('The "Salt, Pepper" Inn, Kitchen').parts).toEqual(['The "Salt, Pepper" Inn', 'Kitchen']);
        expect(splitLabel('„Alte Mühle, Hof“ — Keller').parts).toEqual(['„Alte Mühle, Hof“', 'Keller']);
        expect(splitLabel('“Blue, Moon” Bar, Booth').parts).toEqual(['“Blue, Moon” Bar', 'Booth']);
    });

    it('treats parentheses as a boundary that wins over its neighbours', () => {
        expect(splitLabel('Main Hall (Rusty Anchor)')).toEqual({
            parts: ['Main Hall', 'Rusty Anchor'],
            kinds: [null, 'paren'],
        });
        expect(splitLabel('Hall, (Inn)').kinds).toEqual([null, 'paren']);
        expect(splitLabel('Hall [Inn]').kinds).toEqual([null, 'paren']);
    });

    it('drops empty, symbol-only, too long and repeated parts', () => {
        expect(splitLabel('Tavern, tavern, , —, Tavern').parts).toEqual(['Tavern']);
        expect(splitLabel(`Inn, ${'x'.repeat(101)}`).parts).toEqual(['Inn']);
        expect(splitLabel('- Tavern').parts).toEqual(['Tavern']);
        expect(splitLabel('Line one\nLine two').parts).toEqual(['Line one', 'Line two']);
    });
});

describe('placeLevel', () => {
    it('reads the head word of English parts', () => {
        expect(placeLevel('Throne Room of the Castle')).toBe(4);
        expect(placeLevel('Castle Kitchen')).toBe(4);
        expect(placeLevel('Tavern District')).toBe(2);
        expect(placeLevel('Port Royal')).toBe(2);
        expect(placeLevel('Upstairs Rooms')).toBe(4);
        expect(placeLevel('Old Churches')).toBe(3);
        expect(placeLevel('Kingdom of Eldoria')).toBe(0);
        expect(placeLevel('Ravenholm')).toBeNull();
        expect(placeLevel('')).toBeNull();
        expect(placeLevel('of Inn')).toBe(3);
    });

    it('reads the first place word of Russian parts in any case', () => {
        expect(placeLevel('Кухня замка')).toBe(4);
        expect(placeLevel('Таверна «Якорь»')).toBe(3);
        expect(placeLevel('в таверне')).toBe(3);
        expect(placeLevel('Нижний город')).toBe(1);
        expect(placeLevel('Странный дом')).toBe(3);
        expect(placeLevel('Москва')).toBeNull();
        expect(placeLevel('Дворянский клуб')).toBe(3);
        expect(placeLevel('Кафе Paris')).toBe(3);
        expect(placeLevel('Отель Hilton')).toBe(3);
        expect(placeLevel('Club «Ночь»')).toBe(3);
        expect(placeLevel('«Ночь»')).toBeNull();
    });

    it('levels single words', () => {
        expect(wordLevel('библиотеке')).toBe(4);
        expect(wordLevel('доминион')).toBeNull();
        expect(wordLevel('домик')).toBe(3);
        expect(wordLevel('boxes')).toBeNull();
        expect(wordLevel('churches')).toBe(3);
    });
});

describe('direction', () => {
    it('compares the levels at both ends', () => {
        expect(lexiconDirection(['Library', 'Blackwood Manor', 'Ravenholm'])).toBe(-1);
        expect(lexiconDirection(['Ravenholm', 'Blackwood Manor', 'Library'])).toBe(1);
        expect(lexiconDirection(['Hall', 'Room'])).toBe(0);
    });

    it('uses a single level only at an end', () => {
        expect(lexiconDirection(['Москва', 'кафе «Прага»'])).toBe(1);
        expect(lexiconDirection(['кафе «Прага»', 'Москва'])).toBe(-1);
        expect(lexiconDirection(['Город мастеров', 'Ржавые ворота'])).toBe(1);
        expect(lexiconDirection(['Ржавые ворота', 'Город мастеров'])).toBe(-1);
        expect(lexiconDirection(['A', 'Market', 'B'])).toBe(0);
        expect(lexiconDirection(['A', 'Inn', 'B'])).toBe(0);
        expect(lexiconDirection(['A', 'City', 'B'])).toBe(0);
        expect(lexiconDirection(['Neo-Tokyo', 'Shibuya'])).toBe(0);
    });

    it('falls back to the separators', () => {
        expect(separatorDirection('Shibuya (Neo-Tokyo)', [null, 'paren'])).toBe(-1);
        expect(separatorDirection('Москва — Арбат', [null, 'dash'])).toBe(1);
        expect(separatorDirection('Москва, Арбат', [null, 'comma'])).toBe(1);
        expect(separatorDirection('Shibuya, Neo-Tokyo', [null, 'comma'])).toBe(-1);
    });

    it('lets the registry vote win', () => {
        const split = splitLabel('Library, Manor');
        expect(orderLabelParts('Library, Manor', split, 1)).toEqual({ parts: ['Manor', 'Library'], order: 'registry' });
        expect(orderLabelParts('Library, Manor', split)).toEqual({ parts: ['Library', 'Manor'], order: 'lexicon' });
        expect(orderLabelParts('Inn', splitLabel('Inn'))).toEqual({ parts: ['Inn'], order: 'single' });
    });
});

describe('parsePlaceLabel', () => {
    it('orders English and Russian labels most specific first', () => {
        expect(parsePlaceLabel('Room 3, Rusty Anchor Inn, Docks District, Port Royal')).toEqual({
            parts: ['Room 3', 'Rusty Anchor Inn', 'Docks District', 'Port Royal'],
            order: 'lexicon',
        });
        expect(parsePlaceLabel('Город — район')).toEqual({ parts: ['район', 'Город'], order: 'lexicon' });
        expect(parsePlaceLabel('Москва — Арбат')).toEqual({ parts: ['Арбат', 'Москва'], order: 'separator' });
        expect(parsePlaceLabel('Особняк Волковых, библиотека').parts).toEqual(['библиотека', 'Особняк Волковых']);
        expect(parsePlaceLabel('Main Hall (Rusty Anchor)').parts).toEqual(['Main Hall', 'Rusty Anchor']);
        expect(parsePlaceLabel('Shibuya (Neo-Tokyo)')).toEqual({
            parts: ['Shibuya', 'Neo-Tokyo'],
            order: 'separator',
        });
        expect(parsePlaceLabel('Kingdom of Eldoria — Capital — Royal Palace — Throne Room').parts).toEqual([
            'Throne Room',
            'Royal Palace',
            'Capital',
            'Kingdom of Eldoria',
        ]);
        expect(parsePlaceLabel('Unknown')).toEqual({ parts: [], order: 'single' });
    });
});
