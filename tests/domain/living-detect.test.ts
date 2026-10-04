import { describe, expect, it } from 'vitest';
import {
    buildKnownNames,
    detectNames,
    distinctiveStems,
    findName,
    guessType,
    indexText,
    isDescriptive,
    isKnownName,
    mentionsAny,
    nameKey,
    normalizeWord,
    pickSignificant,
    quoteAround,
    sentenceBounds,
    significance,
    similarNames,
    stemRegexKey,
    stemWord,
    typeWordOf,
    wordsOf,
} from '../../src/domain/living-detect';
import type { NameCandidate } from '../../src/domain/living-detect';

function names(text: string): string[] {
    return detectNames(text).map((candidate) => candidate.name);
}

function one(text: string, name: string): NameCandidate {
    const found = detectNames(text).find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no ${name} in ${JSON.stringify(detectNames(text).map((item) => item.name))}`);
    return found;
}

describe('living-detect: words and stems', () => {
    it('normalises and stems Russian and English words', () => {
        expect(normalizeWord('Ёлка’s')).toBe("елка's");
        expect(stemWord('Празднике')).toBe('праздник');
        expect(stemWord('Фонарей')).toBe('фонар');
        expect(stemWord('Серебряной')).toBe('серебрян');
        expect(stemWord('Ржавого')).toBe('ржав');
        expect(stemWord('Ил')).toBe('ил');
        expect(stemWord("Varn's")).toBe('varn');
        expect(stemWord('Lanterns')).toBe('lantern');
        expect(stemWord('Moss')).toBe('moss');
        expect(stemWord('Bus')).toBe('bus');
    });

    it('splits words with inner hyphens and apostrophes', () => {
        expect(wordsOf('Сан-Ремо, O’Neil и «Ржавый якорь»!')).toEqual(['Сан-Ремо', 'O’Neil', 'и', 'Ржавый', 'якорь']);
        expect(wordsOf(undefined as unknown as string)).toEqual([]);
    });

    it('gives case forms one key', () => {
        expect(nameKey('Празднике Фонарей')).toBe(nameKey('Праздник Фонарей'));
        expect(nameKey('Ржавого якоря')).toBe(nameKey('Ржавый якорь'));
        expect(nameKey('Элдрином')).toBe(nameKey('Элдрин'));
    });
});

describe('living-detect: keys for case forms', () => {
    it('builds a stem key for Russian names of several words', () => {
        const key = stemRegexKey('Праздник Фонарей');
        expect(key).toBe(String.raw`/(?:^|[^\p{L}\p{N}_])праздник\p{L}{0,3}\s+фонар\p{L}{0,3}/iu`);
        const regex = new RegExp(key!.slice(1, -3), 'iu');
        expect(regex.test('гуляли на Празднике Фонарей')).toBe(true);
        expect(regex.test('о Праздниках Фонарей')).toBe(true);
        expect(regex.test('праздник фонтанов')).toBe(false);
        expect(stemRegexKey('Ёлка Ivy')).toBe(String.raw`/(?:^|[^\p{L}\p{N}_])[её]лк\p{L}{0,3}\s+Ivy/iu`);
    });

    it('leaves single words, Latin names and macros to the canon', () => {
        expect(stemRegexKey('Элдрин')).toBeNull();
        expect(stemRegexKey('Lantern Festival')).toBeNull();
        expect(stemRegexKey('{{char}} Дом')).toBeNull();
    });
});

describe('living-detect: type words', () => {
    it('knows Russian stems, exact forms and English words', () => {
        expect(typeWordOf('празднике')?.type).toBe('tradition');
        expect(typeWordOf('Ордена')?.base).toBe('орден');
        expect(typeWordOf('таверне')?.partOfName).toBe(false);
        expect(typeWordOf('дня')?.capitalizedOnly).toBe(true);
        expect(typeWordOf('лесу')?.type).toBe('place');
        expect(typeWordOf('festivals')?.type).toBe('tradition');
        expect(typeWordOf('tavern')?.type).toBe('place');
        expect(typeWordOf('captain')?.type).toBe('person');
    });

    it('does not take names for type words', () => {
        expect(typeWordOf('Лесли')).toBeNull();
        expect(typeWordOf('Горан')).toBeNull();
        expect(typeWordOf('культура')).toBeNull();
        expect(typeWordOf('дневник')).toBeNull();
        expect(typeWordOf('Mara')).toBeNull();
    });

    it('guesses a type from the name or the words before it', () => {
        expect(guessType('Праздник Урожая')).toBe('tradition');
        expect(guessType('Эльмира', 'в городе')).toBe('place');
        expect(guessType('Varis')).toBe('other');
    });
});

describe('living-detect: Russian names', () => {
    it('finds a capitalised tradition with its describing sentence', () => {
        const fest = one(
            'Вечером начинался Праздник Фонарей — каждый год жители запускают фонари над рекой. Элис улыбнулась.',
            'Праздник Фонарей',
        );
        expect(fest).toMatchObject({ type: 'tradition', pattern: 'multiword', count: 1, descriptive: true, words: 2 });
        expect(fest.quote).toBe('Вечером начинался Праздник Фонарей — каждый год жители запускают фонари над рекой.');
    });

    it('puts a declined leading type word back into the nominative and counts every form', () => {
        const fest = one('На Празднике Фонарей было шумно. Все говорили о Празднике Фонарей.', 'Праздник Фонарей');
        expect(fest.count).toBe(2);
        expect(fest.descriptive).toBe(false);
        expect(one('Говорят, он служил Ордену Серебряной Луны.', 'Орден Серебряной Луны').type).toBe('faction');
    });

    it('reads a quoted name after a type word and does not add its words alone', () => {
        const text = 'Они зашли в таверну «Ржавый якорь», где пахло элем. В «Ржавом якоре» всегда людно.';
        expect(names(text)).toEqual(['Ржавый якорь']);
        expect(one(text, 'Ржавый якорь')).toMatchObject({
            type: 'place',
            pattern: 'quoted',
            count: 2,
            descriptive: true,
        });
        expect(one('Он служил в гильдии «Серебряная рука».', 'Серебряная рука').type).toBe('faction');
    });

    it('reads naming phrases, lower-case ones too', () => {
        expect(one('Это был так называемый зимний сбор, когда старейшины собирают дань.', 'Зимний сбор')).toMatchObject(
            { pattern: 'naming', type: 'other', descriptive: true },
        );
        expect(one('Это был так называемый сбор.', 'Сбор').words).toBe(1);
        expect(one('По прозвищу Хромой Ворон его знали все.', 'Хромой Ворон').type).toBe('person');
        expect(one('Таверна под названием «Сломанный щит» пустовала.', 'Сломанный щит').type).toBe('place');
    });

    it('takes a lower-case type word in front into account', () => {
        expect(one('Начинался праздник Фонарей.', 'Праздник Фонарей')).toMatchObject({
            type: 'tradition',
            pattern: 'typed',
        });
        expect(one('В городе Эльмире шёл дождь.', 'Эльмире')).toMatchObject({ type: 'place', pattern: 'typed' });
        const street = detectNames('Он вышел на улицу Кузнецов и свернул к площади Трёх Королей.');
        expect(street.map((item) => [item.name, item.type])).toEqual([
            ['Кузнецов', 'place'],
            ['Трёх Королей', 'place'],
        ]);
    });

    it('drops person titles from names', () => {
        const captain = one('Говорят, капитан Элдрин когда-то служил на флоте. Капитан Элдрин молчал.', 'Элдрин');
        expect(captain).toMatchObject({ type: 'person', pattern: 'titled', count: 2 });
        expect(names('Капитан вошёл в зал.')).toEqual([]);
    });

    it('guards against sentence starts, dialogue and common words', () => {
        expect(names('Вчера Элдрин пришёл домой. — Пойдём, — сказала она. — Мира ждёт.')).toEqual(['Элдрин']);
        expect(names('— Ваше Величество, — поклонился Гвидо. — Господи, как холодно! Да, Мира, пойдём.')).toEqual([
            'Гвидо',
            'Мира',
        ]);
        expect(names('**Элдрин**: Привет!\nОна сказала: «Пойдём домой». Он ответил: "Нет".')).toEqual([]);
        expect(names('Вы знаете, о чём я. НЕТ! Он закричал.')).toEqual([]);
        expect(names('Он сказал: Элдрин придёт.')).toEqual([]);
        expect(names('Таверна стояла у пристани.')).toEqual([]);
    });

    it('lets an adjective that opens a sentence join the name', () => {
        expect(names('Серебряная Луна взошла над лесом.')).toEqual(['Серебряная Луна']);
        expect(names('Этот Элдрин был странным.')).toEqual(['Элдрин']);
    });

    it('sees through markdown emphasis', () => {
        expect(names('Он вспомнил *Праздник Фонарей* и улыбнулся.')).toEqual(['Праздник Фонарей']);
    });

    it('groups similar names of one reply', () => {
        const found = detectNames('Начался Праздник Фонарей. Все ждали Фонарей и огней над рекой, и Мира тоже.');
        expect(found.map((item) => item.name)).toEqual(['Праздник Фонарей', 'Мира']);
    });

    it('skips over-long capitalised runs (headings in title case)', () => {
        expect(names('он читал Первую Книгу Великих Древних Северных Королей Запада вчера')).toEqual([]);
    });
});

describe('living-detect: English names', () => {
    it('reads festivals, "of" links and type words after the name', () => {
        const found = detectNames(
            'They reached the Lantern Festival at dusk. The festival of Lanterns is held every year in the town of Elmira.',
        );
        expect(found.map((item) => [item.name, item.type, item.pattern])).toEqual([
            ['Festival of Lanterns', 'tradition', 'typed'],
            ['Elmira', 'place', 'typed'],
        ]);
        expect(found[0]?.count).toBe(2);
        expect(found[0]?.variants).toEqual(['Lantern Festival', 'Festival of Lanterns']);
        expect(one('They met at the Harvest festival.', 'Harvest Festival').pattern).toBe('typed');
        expect(one('The Rusty Anchor tavern was loud.', 'Rusty Anchor').type).toBe('place');
    });

    it('reads multiword names with connectors, naming phrases and quoted names', () => {
        const found = detectNames(
            'She was a member of the Order of the Silver Moon, known as the Silver Hand. The tavern "Rusty Anchor" was empty.',
        );
        expect(found.map((item) => [item.name, item.type, item.pattern])).toEqual([
            ['Order of the Silver Moon', 'faction', 'multiword'],
            ['Silver Hand', 'other', 'naming'],
            ['Rusty Anchor', 'place', 'quoted'],
        ]);
        expect(one('A man named Eldrin waited.', 'Eldrin').type).toBe('person');
        expect(
            one('They called it the Black Tide. The so-called black tide killed thousands.', 'Black Tide').count,
        ).toBe(2);
        expect(one('a plague so-called "Grey Cough" came', 'Grey Cough').pattern).toBe('naming');
    });

    it('guards against sentence starts, articles, pronouns and calendar words', () => {
        expect(names('"Rain," she said. "Come in, Mara." Mara smiled at Tom. Suddenly Tom laughed.')).toEqual([
            'Mara',
            'Tom',
        ]);
        expect(names('On Monday I met Mr Smith.')).toEqual(['Smith']);
        expect(names('The rain stopped. Then it started again. I know.')).toEqual([]);
        expect(names('visited The Rusty Anchor yesterday')).toEqual(['Rusty Anchor']);
        expect(names('Lord Varis bowed.')).toEqual(['Varis']);
        expect(names('called out to her, named after nobody')).toEqual([]);
    });

    it('describes with "is a", relative clauses and cue words', () => {
        expect(isDescriptive('Elmira is a city.', ' is a city.')).toBe(true);
        expect(isDescriptive('whatever', '», где пахло элем')).toBe(true);
        expect(isDescriptive('It was founded long ago.')).toBe(true);
        expect(isDescriptive('Испокон веков здесь варили эль.')).toBe(true);
        expect(isDescriptive('Он ушёл.', ' ушёл.')).toBe(false);
    });
});

describe('living-detect: quotes', () => {
    it('cuts the sentence around an offset', () => {
        const text = 'Первое. Второе предложение, где Имя стоит! Третье.';
        const at = text.indexOf('Имя');
        expect(sentenceBounds(text, at)).toEqual({ start: 7, end: 42 });
        expect(quoteAround(text, at)).toBe('Второе предложение, где Имя стоит!');
        expect(quoteAround('Строка\nИмя тут\nдругая', 7)).toBe('Имя тут');
        expect(quoteAround('Конец «Имя».» Дальше', 7)).toBe('Конец «Имя».»');
    });

    it('shortens long sentences to a window with ellipses', () => {
        const long = `${'слово '.repeat(80)}Имя ${'слово '.repeat(80)}`;
        const quote = quoteAround(long, long.indexOf('Имя'), 100);
        expect(quote.length).toBeLessThanOrEqual(101);
        expect(quote.startsWith('…')).toBe(true);
        expect(quote.endsWith('…')).toBe(true);
        expect(quote).toContain('Имя');
    });

    it('returns nothing for empty text', () => {
        expect(detectNames('')).toEqual([]);
        expect(detectNames('   ')).toEqual([]);
    });

    it('limits the number of candidates', () => {
        const text = 'и Альфа, и Бета, и Гамма, и Дельта, и Эпсилон';
        expect(detectNames(text, { max: 2 }).map((item) => item.name)).toEqual(['Альфа', 'Бета']);
    });
});

describe('living-detect: mentions and known names', () => {
    it('finds names by stems in any case form and regex keys', () => {
        const index = indexText('Все говорили о Празднике Фонарей и о Ржавом якоре.');
        expect(findName(index, 'Праздник Фонарей')).toEqual([3]);
        expect(findName(index, '')).toEqual([]);
        expect(mentionsAny(index, ['Ржавый якорь'])).toBe(true);
        expect(mentionsAny(index, ['/фонар/iu'])).toBe(true);
        expect(mentionsAny(index, ['/(/iu', '{{char}}', '', 'Элдрин'])).toBe(false);
    });

    it('knows names, regex keys and names inside known texts', () => {
        const known = buildKnownNames(
            ['Элдрин', '/праздник\\s+урожая/iu', '/(/', '', 42, '{{user}}'],
            ['Город Эльмира стоит у моря.', '', 7],
        );
        expect(isKnownName(known, 'Элдрина')).toBe(true);
        expect(isKnownName(known, 'Праздник Урожая')).toBe(true);
        expect(isKnownName(known, 'Эльмиры')).toBe(true);
        expect(isKnownName(known, 'Праздник Фонарей')).toBe(false);
        expect(isKnownName(known, '!!!')).toBe(true);
    });
});

describe('living-detect: similarity', () => {
    it('keeps distinctive words only', () => {
        expect(distinctiveStems('Орден Серебряной Луны')).toEqual(['серебрян', 'лун']);
        expect(distinctiveStems('Order of the Silver Moon')).toEqual(['silver', 'moon']);
    });

    it('tells other names of one thing from different things', () => {
        expect(similarNames('Праздник Фонарей', 'Празднике Фонарей')).toBe(true);
        expect(similarNames('Праздник Фонарей', 'Фестиваль Фонарей')).toBe(true);
        expect(similarNames('Орден Серебряной Луны', 'Серебряная Луна')).toBe(true);
        expect(similarNames('Великий Орден Серебряной Луны', 'Серебряная Луна')).toBe(true);
        expect(similarNames('Элдрин', 'Эльдрин')).toBe(true);
        expect(similarNames('Ржавый якорь', 'Золотой якорь')).toBe(false);
        expect(similarNames('Луна', 'Серебряная Луна')).toBe(false);
        expect(similarNames('Праздник Фонарей', 'Праздник Урожая')).toBe(false);
        expect(similarNames('Мира', 'Мила')).toBe(false);
        expect(similarNames('Праздник', 'Орден')).toBe(false);
        expect(similarNames('', 'Мира')).toBe(false);
        expect(similarNames('Silver Moon Rising Tide', 'Silver Moon Rising Storm')).toBe(true);
    });
});

describe('living-detect: significance', () => {
    const base = (patch: Partial<NameCandidate>): NameCandidate => ({
        name: 'X',
        type: 'other',
        pattern: 'single',
        count: 1,
        quote: '',
        descriptive: false,
        index: 0,
        words: 1,
        variants: ['X'],
        ...patch,
    });

    it('scores type, naming context, words, repetition, description and earlier mentions', () => {
        expect(significance(base({}))).toBe(0);
        expect(significance(base({ type: 'tradition', pattern: 'multiword', words: 2 }))).toBe(2);
        expect(significance(base({ type: 'place', pattern: 'quoted' }))).toBe(2);
        expect(significance(base({ type: 'person', pattern: 'titled' }))).toBe(1);
        expect(significance(base({ count: 2, descriptive: true }))).toBe(2);
        expect(significance(base({}), true)).toBe(1);
    });

    it('picks the K most significant ones', () => {
        const items = [
            { score: 1, candidate: base({ name: 'a', index: 0 }) },
            { score: 3, candidate: base({ name: 'b', index: 5 }) },
            { score: 2, candidate: base({ name: 'c', index: 1 }) },
            { score: 3, candidate: base({ name: 'd', index: 2 }) },
        ];
        expect(pickSignificant(items, 2).map((item) => item.candidate.name)).toEqual(['d', 'b']);
        expect(pickSignificant(items, 10).map((item) => item.candidate.name)).toEqual(['d', 'b', 'c']);
        expect(pickSignificant(items, -1)).toEqual([]);
    });
});
