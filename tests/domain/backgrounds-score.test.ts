import { describe, expect, it } from 'vitest';
import {
    DEFAULT_THRESHOLD,
    SCORE,
    baseKey,
    bestMatch,
    boundSet,
    chooseBound,
    conditionTags,
    conditionsKey,
    emptyConditions,
    indexLibrary,
    parseVariantKey,
    placeProfile,
    rankLibrary,
    sceneConditions,
    scoreItem,
    variantFit,
    variantKey,
    withPlace,
    withVariant,
} from '../../src/domain/backgrounds-score';
import type { LibraryItem, SceneConditions } from '../../src/domain/backgrounds-score';
import { tokenizeFile, tokenizeName } from '../../src/domain/backgrounds-tokens';

const ST_DEFAULTS = [
    '__transparent.png',
    '_black.jpg',
    'bedroom clean.jpg',
    'bedroom cyberpunk.jpg',
    'cityscape medieval market.jpg',
    'cityscape medieval night.jpg',
    'japan classroom.jpg',
    'landscape beach day.png',
    'landscape beach night.jpg',
    'landscape winter lake house.jpg',
    'royal.jpg',
    'tavern day.jpg',
];

const library = (files: string[] = ST_DEFAULTS, folders: Record<string, string[]> = {}) =>
    indexLibrary(files.map((file) => ({ file, folders: folders[file] })));

const scene = (time?: string, weather?: string, date?: string): SceneConditions =>
    sceneConditions({
        time: time ? { start: time } : null,
        weather: weather ? { forecast: weather } : null,
        date: date ?? null,
    });

const on = { variants: true };

describe('library index', () => {
    it('keeps titles, tokens, folders and the sibling key; skips system files and videos', () => {
        const items = library(['tavern day.jpg', 'tavern night.jpg', '_black.jpg', 'rain.mp4', 'tavern day.jpg', ''], {
            'tavern day.jpg': ['Taverns', 'Ночь'],
        });
        expect(items.map((item) => item.file)).toEqual([
            'tavern day.jpg',
            'tavern night.jpg',
            '_black.jpg',
            'rain.mp4',
        ]);
        expect(items[0]).toMatchObject({ title: 'tavern day', base: 'c:tavern', usable: true });
        expect(items[0]!.folder).toMatchObject({ concepts: ['tavern'], time: ['night'] });
        expect(items[1]!.base).toBe(items[0]!.base);
        expect(items[2]!.usable).toBe(false);
        expect(items[3]!.usable).toBe(false);
    });

    it('builds the base key without variant words', () => {
        expect(baseKey(tokenizeFile('Port Royal tavern ruined night rain.png'))).toBe(
            'c:harbor c:tavern n:royal s:ruined',
        );
        expect(baseKey(tokenizeFile('night.png'))).toBe('');
    });
});

describe('place profile and scene', () => {
    it('collects own names, parents nearest first and state', () => {
        const profile = placeProfile({
            name: 'Таверна «Ржавый якорь»',
            aliases: ['Якорь', 'The Rusty Anchor'],
            parents: ['Портовый квартал', 'Порт-Ройал'],
            state: { condition: 'разрушена', season: 'зима', 'bg:night': 'x.png', weather: 'туман', time: 'ночь' },
        });
        expect(profile.own.concepts).toEqual(['tavern']);
        expect(profile.own.names).toEqual(expect.arrayContaining(['ржав', 'якор', 'rusty', 'anchor']));
        expect(profile.parents.map((parent) => parent.concepts)).toEqual([['harbor'], ['harbor']]);
        expect(profile.state).toEqual(['ruined']);
        expect(profile.fixed).toEqual({ season: 'winter', weather: ['fog'], time: 'night' });
    });

    it('reads DES fields and lays the place state over them', () => {
        const conditions = sceneConditions({
            time: { start: '10:00', end: '21:30' },
            weather: { forecast: 'Rain' },
            date: '3 июля',
        });
        expect(conditions).toEqual({ time: 'night', weather: ['rain'], season: 'summer' });
        expect(sceneConditions({ time: { start: '07:00' } }).time).toBe('morning');
        expect(sceneConditions(null)).toEqual(emptyConditions());
        const profile = placeProfile({ name: 'Ледяной дворец', state: { season: 'зима' } });
        expect(withPlace(conditions, profile)).toEqual({ time: 'night', weather: ['rain'], season: 'winter' });
        expect(withPlace(conditions, placeProfile({ name: 'x' }))).toEqual(conditions);
        expect(conditionTags(conditions)).toEqual(['night', 'rain', 'summer']);
        expect(conditionsKey(conditions)).toBe('night|rain|summer');
        expect(conditionsKey(emptyConditions())).toBe('-|-|-');
    });
});

describe('variant fit', () => {
    const fit = (file: string, conditions: SceneConditions) => variantFit(tokenizeFile(file), conditions);

    it('rewards the time of day and pushes neighbours and opposites down', () => {
        expect(fit('tavern night', scene('23:00'))).toEqual({ score: SCORE.timeMatch, matched: ['night'] });
        expect(fit('tavern evening', scene('23:00')).score).toBe(SCORE.timeNear);
        expect(fit('tavern day', scene('09:00')).score).toBe(SCORE.timeDaylight);
        expect(fit('tavern morning', scene('09:00')).matched).toEqual(['morning']);
        expect(fit('tavern day', scene('23:00')).score).toBe(SCORE.timeConflict);
        expect(fit('tavern day and night', scene('23:00')).score).toBe(SCORE.timeMatch);
        expect(fit('tavern night', emptyConditions()).score).toBe(0);
    });

    it('rewards the weather and pushes wrong heavy weather down', () => {
        expect(fit('street rain', scene(undefined, 'Ливень'))).toEqual({
            score: SCORE.weatherMatch,
            matched: ['rain'],
        });
        expect(fit('street snow', scene(undefined, 'Rain')).score).toBe(SCORE.weatherConflict);
        expect(fit('street sunny', scene(undefined, 'Rain')).score).toBe(SCORE.weatherConflict);
        expect(fit('street cloudy', scene(undefined, 'Rain')).score).toBe(SCORE.weatherMild);
        expect(fit('street rain', emptyConditions()).score).toBe(SCORE.weatherUnknownHeavy);
        expect(fit('street sunny', emptyConditions()).score).toBe(0);
    });

    it('rewards the season and pushes the wrong one down', () => {
        expect(fit('lake winter', scene(undefined, undefined, 'January 5'))).toEqual({
            score: SCORE.seasonMatch,
            matched: ['winter'],
        });
        expect(fit('lake winter', scene(undefined, undefined, 'July 5')).score).toBe(SCORE.seasonConflict);
    });
});

describe('scoring', () => {
    const items = library();
    const rank = (name: string, conditions: SceneConditions, parents: string[] = [], files?: LibraryItem[]) =>
        rankLibrary(files ?? items, placeProfile({ name, parents }), conditions, on);

    it('picks the tavern for a Russian tavern by day and pushes it down at night', () => {
        const day = rank('Таверна «Ржавый якорь»', scene('12:00'));
        expect(day[0]).toMatchObject({ file: 'tavern day.jpg', score: 4, variant: ['day'] });
        const night = rank('Таверна «Ржавый якорь»', scene('22:00'));
        expect(night[0]).toMatchObject({ file: 'tavern day.jpg', score: SCORE.concept + SCORE.timeConflict });
        expect(bestMatch(items, placeProfile({ name: 'Таверна' }), scene('22:00'), on, DEFAULT_THRESHOLD)).toBeNull();
        expect(
            bestMatch(items, placeProfile({ name: 'Таверна' }), scene('22:00'), { variants: false }, 3),
        ).toMatchObject({
            file: 'tavern day.jpg',
            score: 3,
            variant: [],
        });
    });

    it('chooses the night or day variant of a sibling pair', () => {
        expect(rank('Пляж', scene('02:00'))[0]).toMatchObject({ file: 'landscape beach night.jpg', score: 4 });
        expect(rank('Пляж', scene('13:00'))[0]).toMatchObject({ file: 'landscape beach day.png', score: 4 });
    });

    it('matches proper names across scripts and counts several concepts', () => {
        const files = library(['port royal docks.jpg', 'royal.jpg', 'docks.jpg', 'tavern docks.jpg']);
        const ranked = rank('Порт-Ройал', emptyConditions(), [], files);
        expect(ranked[0]).toMatchObject({ file: 'port royal docks.jpg', score: SCORE.concept + SCORE.nameSimilar });
        expect(ranked.find((item) => item.file === 'tavern docks.jpg')?.score).toBe(SCORE.concept + SCORE.extraConcept);
        const two = rank('Лесная хижина', emptyConditions(), [], library(['forest cabin.jpg', 'forest.jpg']));
        expect(two[0]).toMatchObject({ file: 'forest cabin.jpg', score: SCORE.concept + SCORE.conceptMore });
    });

    it('uses related concepts, parents and folders as weaker matches', () => {
        const near = rank('Трактир', emptyConditions(), [], library(['restaurant.jpg']));
        expect(near[0]!.score).toBe(SCORE.near);
        const parents = rank(
            'Зал «Якорь»',
            emptyConditions(),
            ['Таверна', 'Порт-Ройал'],
            library(['tavern.jpg', 'royal.jpg']),
        );
        expect(parents.find((item) => item.file === 'tavern.jpg')?.score).toBe(SCORE.near);
        expect(parents.find((item) => item.file === 'royal.jpg')?.score).toBe(SCORE.parentFar);
        const parentOnly = rank('Комната 3', emptyConditions(), ['Port Royal'], library(['port royal docks.jpg']));
        expect(parentOnly[0]!.score).toBeLessThan(DEFAULT_THRESHOLD);
        const folders = library(['IMG_0042.png', 'IMG_0043.png'], { 'IMG_0042.png': ['Taverns', 'Port Royal'] });
        const byFolder = rank('Таверна', emptyConditions(), ['Порт-Ройал'], folders);
        expect(byFolder).toHaveLength(1);
        expect(byFolder[0]).toMatchObject({ file: 'IMG_0042.png' });
        // The folder «Port Royal» gives the parent's concept (port) and its name (Ройал ~ Royal).
        expect(byFolder[0]!.score).toBeCloseTo(SCORE.concept * SCORE.folder + 2 * SCORE.parent * SCORE.folder);
        const nameFolder = rank('Блэквуд', emptyConditions(), [], library(['a.png'], { 'a.png': ['Blackwood'] }));
        expect(nameFolder[0]!.score).toBeCloseTo(SCORE.nameSimilar * SCORE.folder);
        const nearFolder = rank('Трактир', emptyConditions(), [], library(['b.png'], { 'b.png': ['Restaurants'] }));
        expect(nearFolder[0]!.score).toBeCloseTo(SCORE.near * SCORE.folder);
        const parentFolder = rank(
            'Комната',
            emptyConditions(),
            ['Таверна'],
            library(['c.png'], { 'c.png': ['Tavern'] }),
        );
        expect(parentFolder[0]!.score).toBeCloseTo(SCORE.near * SCORE.folder);
    });

    it('rewards a matching state and pushes a wrong one down', () => {
        const files = library(['temple.jpg', 'temple ruins.jpg', 'temple burning.jpg']);
        const ruined = rank('Руины храма', emptyConditions(), [], files);
        expect(ruined[0]).toMatchObject({ file: 'temple ruins.jpg', variant: ['ruined'] });
        const intact = rank('Храм', emptyConditions(), [], files);
        expect(intact[0]).toMatchObject({ file: 'temple.jpg', score: SCORE.concept });
        expect(intact.slice(1).map((item) => item.score)).toEqual([
            SCORE.concept + SCORE.stateMismatch,
            SCORE.concept + SCORE.stateMismatch,
        ]);
    });

    it('scores unrelated files zero and leaves out unusable ones', () => {
        const [item] = library(['bedroom clean.jpg']);
        expect(scoreItem(item!, placeProfile({ name: 'Лес' }), emptyConditions(), on)).toEqual({
            file: 'bedroom clean.jpg',
            score: 0,
            matched: false,
            variant: [],
        });
        expect(rank('Black', emptyConditions(), [], library(['_black.jpg']))).toEqual([]);
        expect(rankLibrary(items, placeProfile({ name: 'Таверна' }), emptyConditions(), on, 0)).toEqual([]);
    });

    it('breaks ties by title', () => {
        const ranked = rank('Спальня', emptyConditions());
        expect(ranked.slice(0, 2).map((item) => item.file)).toEqual(['bedroom clean.jpg', 'bedroom cyberpunk.jpg']);
    });
});

describe('bound backgrounds', () => {
    it('reads and writes variant keys', () => {
        expect(variantKey(['rain', 'night', 'rain', 'ruined'])).toBe('bg:night+rain');
        expect(variantKey(['ruined'])).toBeNull();
        expect(parseVariantKey('bg:night+rain')).toEqual(['night', 'rain']);
        expect(parseVariantKey('bg:')).toBeNull();
        expect(parseVariantKey('bg:night+lava')).toBeNull();
        expect(parseVariantKey('season')).toBeNull();
        expect(withVariant({ a: 'b' }, ['night'], 'n.png')).toEqual({ a: 'b', 'bg:night': 'n.png' });
        expect(withVariant({ 'bg:night': 'n.png' }, ['night'], null)).toEqual({});
        expect(withVariant(null, ['lava'], 'x.png')).toEqual({});
    });

    it('lists the main background and the variants', () => {
        expect(
            boundSet({
                background: 'main.png',
                state: { 'bg:night': 'n.png', 'bg:rain+night': 'nr.png', x: 'y', 'bg:z': 'q' },
            }),
        ).toEqual({
            main: 'main.png',
            variants: [
                { tags: ['night'], file: 'n.png' },
                { tags: ['night', 'rain'], file: 'nr.png' },
            ],
        });
        expect(boundSet({})).toEqual({ main: null, variants: [] });
    });

    it('chooses the most specific fitting variant, a time variant on ties', () => {
        const bound = boundSet({
            background: 'main.png',
            state: { 'bg:night': 'n.png', 'bg:night+rain': 'nr.png', 'bg:rain': 'r.png', 'bg:winter': 'w.png' },
        });
        expect(chooseBound(bound, scene('23:00', 'Rain'), on)).toEqual({ file: 'nr.png', variant: ['night', 'rain'] });
        expect(chooseBound(bound, scene('23:00'), on)).toEqual({ file: 'n.png', variant: ['night'] });
        expect(chooseBound(bound, scene('12:00', 'Rain'), on)).toEqual({ file: 'r.png', variant: ['rain'] });
        const tie = boundSet({ state: { 'bg:rain': 'r.png', 'bg:night': 'n.png' } });
        expect(chooseBound(tie, scene('23:00', 'Rain'), on)?.file).toBe('n.png');
        expect(chooseBound(bound, scene('12:00'), on)).toEqual({ file: 'main.png', variant: [] });
        expect(chooseBound(bound, scene('23:00'), { variants: false })).toEqual({ file: 'main.png', variant: [] });
        expect(chooseBound(boundSet({ state: { 'bg:night': 'n.png' } }), scene('12:00'), on)).toBeNull();
        expect(chooseBound(boundSet({}), scene('12:00'), { variants: false })).toBeNull();
    });

    it('takes a library sibling of the main file as a variant', () => {
        const items = library([
            'tavern day.jpg',
            'tavern night.jpg',
            'tavern night rain.jpg',
            'night.jpg',
            '_tavern night.jpg',
        ]);
        const bound = boundSet({ background: 'tavern day.jpg' });
        expect(chooseBound(bound, scene('23:00'), on, items)).toEqual({ file: 'tavern night.jpg', variant: ['night'] });
        expect(chooseBound(bound, scene('23:00', 'Rain'), on, items)).toEqual({
            file: 'tavern night rain.jpg',
            variant: ['night', 'rain'],
        });
        expect(chooseBound(bound, scene('12:00'), on, items)).toEqual({ file: 'tavern day.jpg', variant: ['day'] });
        expect(chooseBound(boundSet({ background: 'night.jpg' }), scene('12:00'), on, items)).toEqual({
            file: 'night.jpg',
            variant: [],
        });
        expect(chooseBound(boundSet({ background: 'gone.jpg' }), scene('12:00'), on, items)).toEqual({
            file: 'gone.jpg',
            variant: [],
        });
    });

    it('reads short participles of a state', () => {
        expect(tokenizeName('разрушена').state).toEqual(['ruined']);
        expect(tokenizeName('заброшен, затоплено').state).toEqual(['abandoned', 'flooded']);
        expect(tokenizeName('Портовый квартал').concepts).toEqual(['harbor']);
    });
});
