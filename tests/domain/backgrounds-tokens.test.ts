import { describe, expect, it } from 'vitest';
import {
    VARIANT_TAGS,
    emptyTokens,
    fileTitle,
    mergeTokens,
    nameSkeleton,
    namesMatch,
    nearConcepts,
    placeConcepts,
    seasonOf,
    splitWords,
    timeFromMinutes,
    timeOfDay,
    tokenizeFile,
    tokenizeName,
    variantKind,
    weatherTags,
} from '../../src/domain/backgrounds-tokens';

describe('splitWords and fileTitle', () => {
    it('splits camelCase, snake_case, dashes, dots and digits', () => {
        expect(splitWords('TavernNight_02-old.v2')).toEqual(['tavern', 'night', '02', 'old', 'v', '2']);
        expect(splitWords('HTMLParser')).toEqual(['html', 'parser']);
        expect(splitWords('Ёлка  «Ржавый якорь»')).toEqual(['елка', 'ржавый', 'якорь']);
        expect(splitWords('King’s hall')).toEqual(["king's", 'hall']);
        expect(splitWords(undefined as unknown as string)).toEqual([]);
    });

    it('takes the title of a file: no folder, extension or credit', () => {
        expect(fileTitle('forest treehouse (by kallmeflocc).jpg')).toBe('forest treehouse');
        expect(fileTitle('sub/dir/tavern day.png')).toBe('tavern day');
        expect(fileTitle('C:\\bg\\castle [art by Someone].webp')).toBe('castle');
        expect(fileTitle('tavern (night).jpg')).toBe('tavern (night)');
        expect(fileTitle(null as unknown as string)).toBe('');
    });
});

describe('tokenizeName / tokenizeFile', () => {
    it('reads ST default background names', () => {
        expect(tokenizeFile('tavern day.jpg')).toMatchObject({ concepts: ['tavern'], time: ['day'] });
        expect(tokenizeFile('landscape beach night.jpg')).toMatchObject({ concepts: ['beach'], time: ['night'] });
        expect(tokenizeFile('cityscape medieval market.jpg')).toMatchObject({
            concepts: ['city', 'market'],
            names: ['medieval'],
        });
        expect(tokenizeFile('landscape winter lake house.jpg')).toMatchObject({
            concepts: ['lake', 'house'],
            season: ['winter'],
        });
        expect(tokenizeFile('japan classroom side.jpg')).toMatchObject({ concepts: ['school'], names: ['japan'] });
    });

    it('reads Russian place names through roots and endings', () => {
        expect(tokenizeName('Таверна «Ржавый якорь»')).toMatchObject({ concepts: ['tavern'], names: ['ржав', 'якор'] });
        expect(tokenizeName('Лесная хижина').concepts).toEqual(['forest', 'house']);
        expect(tokenizeName('Тронный зал').concepts).toEqual(['palace', 'hall']);
        expect(tokenizeName('Городской рынок').concepts).toEqual(['city', 'market']);
        expect(tokenizeName('Ночная улица')).toMatchObject({ concepts: ['street'], time: ['night'] });
        expect(tokenizeName('в замке у моря').concepts).toEqual(['castle', 'sea']);
    });

    it('does not take look-alike words for places', () => {
        expect(tokenizeName('лестница').concepts).toEqual([]);
        expect(tokenizeName('барон').concepts).toEqual([]);
        expect(tokenizeName('портрет').concepts).toEqual([]);
        expect(tokenizeName('мороз').concepts).toEqual([]);
        expect(tokenizeName('сел').concepts).toEqual([]);
    });

    it('collects time, weather, season and state words in both languages', () => {
        expect(tokenizeName('stormy winter night')).toMatchObject({
            time: ['night'],
            weather: ['storm'],
            season: ['winter'],
        });
        expect(tokenizeName('Разрушенный храм в огне, пожар')).toMatchObject({
            concepts: ['temple'],
            state: ['ruined', 'burning'],
        });
        expect(tokenizeName('Руины храма').state).toEqual(['ruined']);
        expect(tokenizeName('abandoned flooded festival').state).toEqual(['abandoned', 'flooded', 'festive']);
        expect(tokenizeName('Весенний сад, туман').season).toEqual(['spring']);
        expect(tokenizeName('летний дождливый вечер')).toMatchObject({
            season: ['summer'],
            weather: ['rain'],
            time: ['evening'],
        });
    });

    it('handles English plurals, possessives and compounds', () => {
        expect(tokenizeName('taverns').concepts).toEqual(['tavern']);
        expect(tokenizeName('libraries').concepts).toEqual(['library']);
        expect(tokenizeName('churches').concepts).toEqual(['temple']);
        expect(tokenizeName("king's castle")).toMatchObject({ concepts: ['castle'], names: ['king'] });
        expect(tokenizeName('treehouse')).toMatchObject({ concepts: ['house'], names: ['treehouse'] });
        expect(tokenizeName('Blackwood')).toMatchObject({ concepts: ['forest'], names: ['blackwood'] });
        expect(tokenizeName('waterfall').concepts).toEqual(['river']);
    });

    it('drops digits, stop words and short unknown words', () => {
        expect(tokenizeName('the bg 4 of xy')).toEqual(emptyTokens());
    });

    it('merges token sets without duplicates', () => {
        const merged = mergeTokens(tokenizeName('tavern night'), tokenizeName('Таверна ночью, дождь, зима, руины'));
        expect(merged).toEqual({
            concepts: ['tavern', 'ruins'],
            names: [],
            time: ['night'],
            weather: ['rain'],
            season: ['winter'],
            state: ['ruined'],
        });
    });

    it('knows related concepts', () => {
        expect(nearConcepts('tavern')).toContain('restaurant');
        expect(nearConcepts('nothing')).toEqual([]);
        expect(placeConcepts()).toContain('forest');
    });
});

describe('names across scripts', () => {
    it('builds the same skeleton for Russian and English spellings', () => {
        expect(nameSkeleton('Гарвард')).toBe(nameSkeleton('Harvard'));
        expect(nameSkeleton('ройал')).toBe(nameSkeleton('royal'));
        expect(nameSkeleton(undefined as unknown as string)).toBe('');
    });

    it('matches exact, prefixes in one script and similar spellings', () => {
        expect(namesMatch('royal', 'royal')).toBe('exact');
        expect(namesMatch('блэквуд', 'блэквудск')).toBe('exact');
        expect(namesMatch('ройал', 'royal')).toBe('similar');
        expect(namesMatch('блэквуд', 'blackwood')).toBe('similar');
        expect(namesMatch('рочестер', 'rochester')).toBe('similar');
        expect(namesMatch('лондон', 'londonderry')).toBe('similar');
        expect(namesMatch('ab', 'ab ')).toBeNull();
        expect(namesMatch('', 'x')).toBeNull();
        expect(namesMatch('kraken', 'dragon')).toBeNull();
    });
});

describe('DES scene fields', () => {
    it('reads the time of day from a clock or words', () => {
        expect(timeOfDay('18:30')).toBe('evening');
        expect(timeOfDay('6:30 AM')).toBe('morning');
        expect(timeOfDay('2 pm')).toBe('day');
        expect(timeOfDay('23:10')).toBe('night');
        expect(timeOfDay('Late evening')).toBe('evening');
        expect(timeOfDay('Глубокая ночь')).toBe('night');
        expect(timeOfDay('Утро, 16:00')).toBe('morning');
        expect(timeOfDay('полдень')).toBe('day');
        expect(timeOfDay('from evening till night')).toBe('evening');
        expect(timeOfDay('soon')).toBeNull();
        expect(timeOfDay('   ')).toBeNull();
        expect(timeOfDay(undefined)).toBeNull();
    });

    it('splits the day into four parts', () => {
        expect(timeFromMinutes(4 * 60 + 59)).toBe('night');
        expect(timeFromMinutes(5 * 60)).toBe('morning');
        expect(timeFromMinutes(11 * 60)).toBe('day');
        expect(timeFromMinutes(17 * 60)).toBe('evening');
        expect(timeFromMinutes(21 * 60)).toBe('night');
        expect(timeFromMinutes(-60)).toBe('night');
    });

    it('reads the weather from the forecast, then the emoji', () => {
        expect(weatherTags({ forecast: 'Light rain' })).toEqual(['rain']);
        expect(weatherTags({ emoji: '⛈️' })).toEqual(['storm', 'rain']);
        expect(weatherTags({ forecast: 'Ясно, к вечеру дождь' })).toEqual(['rain']);
        expect(weatherTags({ forecast: 'Снегопад' })).toEqual(['snow']);
        expect(weatherTags({ emoji: '☀️', forecast: '24°' })).toEqual(['clear']);
        expect(weatherTags({ emoji: '🌫' })).toEqual(['fog']);
        expect(weatherTags({ emoji: '☁️' })).toEqual(['cloudy']);
        expect(weatherTags({ emoji: '❄️' })).toEqual(['snow']);
        expect(weatherTags({ emoji: '🌧' })).toEqual(['rain']);
        expect(weatherTags({ forecast: 'Sunny and cloudy' })).toEqual(['clear', 'cloudy']);
        expect(weatherTags(null)).toEqual([]);
        expect(weatherTags({})).toEqual([]);
    });

    it('reads the season from words or the month', () => {
        expect(seasonOf('5 марта 1856')).toBe('spring');
        expect(seasonOf('December 24')).toBe('winter');
        expect(seasonOf('July 3, 1990')).toBe('summer');
        expect(seasonOf('October 1')).toBe('autumn');
        expect(seasonOf('Winter, day 4')).toBe('winter');
        expect(seasonOf('Day 3')).toBeNull();
        expect(seasonOf(undefined)).toBeNull();
    });

    it('classifies variant tags', () => {
        expect(variantKind('night')).toBe('time');
        expect(variantKind('rain')).toBe('weather');
        expect(variantKind('winter')).toBe('season');
        expect(variantKind('ruined')).toBeNull();
        expect(VARIANT_TAGS).toHaveLength(14);
    });
});
