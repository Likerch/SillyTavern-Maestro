// M29 «Фоны»: words of background file names, place names and DES scene fields as tokens. File names of ST's
// background library are English and free-form («tavern day.jpg», «landscape beach night.jpg», «TavernNight_02.png»),
// place names are usually Russian («Таверна «Ржавый якорь»»), so both are split (camelCase, snake_case, dashes,
// digits) and mapped through one small RU/EN lexicon onto shared ids: place concepts (tavern, forest, castle…) and
// variant tags — time of day, weather, season and the place's state. Words the lexicon does not know are kept as
// stems (proper names: «Порт-Ройал» ~ «port royal»), compared across scripts through a rough transliteration.
// Pure: no DOM, no SillyTavern.
import { editDistance, wordStem } from './places-match';
import { parseClock, parseDay } from './signals-time';

export type TimeTag = 'morning' | 'day' | 'evening' | 'night';
export type WeatherTag = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog';
export type SeasonTag = 'spring' | 'summer' | 'autumn' | 'winter';
export type StateTag = 'ruined' | 'burning' | 'abandoned' | 'flooded' | 'festive';
/** Tags a background variant is chosen by (time of day, weather, season). */
export type VariantTag = TimeTag | WeatherTag | SeasonTag;

export const TIME_TAGS: readonly TimeTag[] = ['morning', 'day', 'evening', 'night'];
export const WEATHER_TAGS: readonly WeatherTag[] = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
export const SEASON_TAGS: readonly SeasonTag[] = ['spring', 'summer', 'autumn', 'winter'];
export const STATE_TAGS: readonly StateTag[] = ['ruined', 'burning', 'abandoned', 'flooded', 'festive'];
export const VARIANT_TAGS: readonly VariantTag[] = [...TIME_TAGS, ...WEATHER_TAGS, ...SEASON_TAGS];

type Kind = 'place' | 'time' | 'weather' | 'season' | 'state';

interface Entry {
    kind: Kind;
    id: string;
    /** English words, matched whole (plural and possessive forms too). */
    en: readonly string[];
    /** Russian roots (a root plus a case or adjective ending); a trailing `$` marks an exact word form. */
    ru: readonly string[];
    /** Related place concepts: a weaker match (a tavern for an inn's dining hall). */
    near?: readonly string[];
}

// prettier-ignore
const LEXICON: readonly Entry[] = [
    // Places.
    { kind: 'place', id: 'tavern', en: ['tavern', 'inn', 'pub', 'bar', 'saloon', 'alehouse', 'taproom', 'brewery', 'taverna'],
        ru: ['таверн', 'трактир', 'корчм', 'кабак', 'кабач', 'паб$', 'паба$', 'пабе$', 'бар$', 'бара$', 'баре$', 'бару$', 'баром$', 'бары$', 'пивн', 'харчевн', 'постоял'],
        near: ['restaurant', 'hotel', 'club', 'hall'] },
    { kind: 'place', id: 'restaurant', en: ['restaurant', 'cafe', 'diner', 'canteen', 'cafeteria', 'bistro', 'eatery', 'coffeeshop'],
        ru: ['ресторан', 'кафе$', 'столов', 'закусочн', 'кофейн', 'бистро$'], near: ['tavern'] },
    { kind: 'place', id: 'hotel', en: ['hotel', 'motel', 'hostel', 'lodge'], ru: ['гостиниц', 'отел', 'хостел', 'мотел'],
        near: ['tavern', 'bedroom'] },
    { kind: 'place', id: 'club', en: ['club', 'nightclub', 'disco', 'casino', 'lounge'], ru: ['клуб', 'дискотек', 'казино$'],
        near: ['tavern'] },
    { kind: 'place', id: 'bedroom', en: ['bedroom', 'bedchamber', 'bed'], ru: ['спальн', 'опочивальн', 'кроват'],
        near: ['room', 'house', 'hotel'] },
    { kind: 'place', id: 'room', en: ['room', 'chamber', 'apartment', 'chambers'],
        ru: ['комнат', 'покои$', 'покоях$', 'покоев$', 'квартир', 'горниц', 'светлиц'], near: ['bedroom', 'house'] },
    { kind: 'place', id: 'bathroom', en: ['bathroom', 'bath', 'bathhouse', 'sauna', 'onsen', 'toilet', 'restroom', 'shower'],
        ru: ['ванн', 'баня$', 'бани$', 'бане$', 'баню$', 'баней$', 'саун', 'туалет', 'уборн'], near: ['room'] },
    { kind: 'place', id: 'kitchen', en: ['kitchen', 'pantry'], ru: ['кухн', 'кладов'], near: ['house', 'restaurant'] },
    { kind: 'place', id: 'house', en: ['house', 'home', 'cottage', 'hut', 'cabin', 'shack', 'homestead'],
        ru: ['дом', 'домик', 'хижин', 'изб', 'избушк', 'лачуг', 'коттедж', 'хат'], near: ['room', 'village', 'mansion'] },
    { kind: 'place', id: 'mansion', en: ['mansion', 'manor', 'estate', 'villa', 'residence'],
        ru: ['особняк', 'поместь', 'усадьб', 'вилл'], near: ['house', 'palace'] },
    { kind: 'place', id: 'castle', en: ['castle', 'fortress', 'fort', 'citadel', 'keep', 'stronghold', 'bastion'],
        ru: ['замок$', 'замка$', 'замке$', 'замку$', 'замком$', 'замки$', 'замков$', 'замках$', 'крепост', 'цитадел', 'форт$', 'форта$', 'форте$', 'бастион'],
        near: ['palace', 'tower', 'hall'] },
    { kind: 'place', id: 'palace', en: ['palace', 'throne', 'throneroom'], ru: ['дворец$', 'дворц', 'дворцов', 'трон'],
        near: ['castle', 'hall', 'mansion'] },
    { kind: 'place', id: 'hall', en: ['hall', 'ballroom', 'lobby', 'foyer', 'auditorium', 'banquet'],
        ru: ['зал', 'вестибюл', 'холл', 'фойе$', 'приемн'], near: ['palace', 'castle'] },
    { kind: 'place', id: 'tower', en: ['tower', 'spire', 'belfry', 'lighthouse'], ru: ['башн', 'колокольн', 'маяк'],
        near: ['castle'] },
    { kind: 'place', id: 'dungeon', en: ['dungeon', 'prison', 'jail', 'cell', 'basement', 'cellar', 'crypt', 'catacomb', 'vault', 'sewer'],
        ru: ['подземел', 'темниц', 'тюрьм', 'тюрем', 'подвал', 'погреб', 'склеп', 'катакомб', 'застенк', 'канализац'],
        near: ['cave', 'graveyard'] },
    { kind: 'place', id: 'cave', en: ['cave', 'cavern', 'grotto', 'mine', 'tunnel', 'underground'],
        ru: ['пещер', 'грот', 'шахт', 'тоннел', 'туннел', 'рудник'], near: ['dungeon', 'mountain'] },
    { kind: 'place', id: 'temple', en: ['temple', 'shrine', 'church', 'cathedral', 'chapel', 'monastery', 'abbey', 'sanctuary', 'altar', 'mosque'],
        ru: ['храм', 'святилищ', 'церковь$', 'церкв', 'собор', 'часовн', 'монастыр', 'аббатств', 'алтар', 'капищ', 'мечет'],
        near: ['graveyard'] },
    { kind: 'place', id: 'library', en: ['library', 'archive', 'bookstore', 'bookshop'], ru: ['библиотек', 'архив', 'читальн', 'книжн'],
        near: ['school', 'office'] },
    { kind: 'place', id: 'school', en: ['school', 'classroom', 'academy', 'university', 'college', 'campus', 'lecture', 'schoolyard'],
        ru: ['школ', 'класс', 'академи', 'университет', 'институт', 'колледж', 'аудитори', 'училищ', 'гимнази', 'лицей$', 'лицея$', 'лицее$'],
        near: ['library'] },
    { kind: 'place', id: 'office', en: ['office', 'study', 'workplace'], ru: ['офис', 'кабинет', 'контор', 'бюро$'],
        near: ['library'] },
    { kind: 'place', id: 'hospital', en: ['hospital', 'clinic', 'infirmary', 'ward', 'hospice'],
        ru: ['больниц', 'госпитал', 'клиник', 'лазарет'] },
    { kind: 'place', id: 'lab', en: ['laboratory', 'lab'], ru: ['лаборатори'] },
    { kind: 'place', id: 'shop', en: ['shop', 'store', 'boutique', 'stall', 'emporium', 'pharmacy', 'apothecary', 'bakery', 'smithy', 'forge', 'workshop'],
        ru: ['магазин', 'лавк', 'лавочк', 'бутик', 'аптек', 'пекарн', 'кузниц', 'мастерск'], near: ['market'] },
    { kind: 'place', id: 'market', en: ['market', 'bazaar', 'marketplace', 'fair', 'fairground'],
        ru: ['рынок$', 'рынк', 'базар', 'ярмарк'], near: ['shop', 'square', 'city'] },
    { kind: 'place', id: 'city', en: ['city', 'town', 'cityscape', 'downtown', 'capital', 'metropolis', 'urban', 'skyline'],
        ru: ['город', 'городок$', 'городк', 'столиц', 'мегаполис'], near: ['street', 'square', 'market'] },
    { kind: 'place', id: 'street', en: ['street', 'alley', 'alleyway', 'avenue', 'lane', 'boulevard', 'sidewalk'],
        ru: ['улиц', 'переулок$', 'переулк', 'проспект', 'бульвар', 'подворотн', 'тротуар'], near: ['city', 'road'] },
    { kind: 'place', id: 'square', en: ['square', 'plaza', 'courtyard', 'yard'],
        ru: ['площад', 'двор$', 'двора$', 'дворе$', 'двору$', 'двором$', 'дворик'], near: ['city', 'market'] },
    { kind: 'place', id: 'village', en: ['village', 'hamlet', 'settlement'],
        ru: ['деревн', 'деревушк', 'село$', 'села$', 'селе$', 'селом$', 'сельск', 'поселен', 'поселок$', 'поселк', 'хутор'],
        near: ['house', 'farm', 'field'] },
    { kind: 'place', id: 'farm', en: ['farm', 'barn', 'stable', 'ranch', 'farmhouse', 'mill'],
        ru: ['ферм', 'амбар', 'сарай', 'конюшн', 'ранчо$', 'мельниц'], near: ['village', 'field'] },
    { kind: 'place', id: 'road', en: ['road', 'path', 'trail', 'highway', 'crossroads', 'roadside'],
        ru: ['дорог', 'троп', 'тропинк', 'тракт$', 'шоссе$', 'перекрест', 'путь$', 'пути$'], near: ['forest', 'field', 'street'] },
    { kind: 'place', id: 'bridge', en: ['bridge'], ru: ['мост'], near: ['river', 'road'] },
    { kind: 'place', id: 'forest', en: ['forest', 'woods', 'wood', 'grove', 'woodland', 'thicket'],
        ru: ['лес', 'чащ', 'рощ', 'бор$', 'бору$', 'бора$', 'дубрав', 'ельник', 'сосняк'], near: ['garden', 'jungle', 'swamp'] },
    { kind: 'place', id: 'jungle', en: ['jungle', 'rainforest', 'tropics', 'tropical'], ru: ['джунгл', 'тропик', 'тропическ'],
        near: ['forest'] },
    { kind: 'place', id: 'garden', en: ['garden', 'park', 'orchard', 'greenhouse'], ru: ['сад', 'садик', 'парк', 'оранжере', 'теплиц', 'алле'],
        near: ['forest', 'field'] },
    { kind: 'place', id: 'field', en: ['field', 'meadow', 'plain', 'plains', 'grassland', 'prairie', 'steppe', 'pasture'],
        ru: ['поле$', 'поля$', 'полю$', 'полем$', 'полях$', 'полей$', 'луг', 'равнин', 'степ', 'пастбищ'], near: ['farm', 'village', 'road'] },
    { kind: 'place', id: 'mountain', en: ['mountain', 'peak', 'summit', 'cliff', 'hill', 'canyon', 'gorge', 'ridge', 'volcano'],
        ru: ['гор', 'вершин', 'утес', 'скал', 'холм', 'ущель', 'каньон', 'хребт', 'хребет$', 'перевал', 'вулкан'], near: ['cave'] },
    { kind: 'place', id: 'desert', en: ['desert', 'dunes', 'dune', 'wasteland', 'badlands'], ru: ['пустын', 'дюн', 'бархан'],
        near: ['field'] },
    { kind: 'place', id: 'beach', en: ['beach', 'shore', 'coast', 'seaside', 'coastline'], ru: ['пляж', 'берег', 'побережь', 'взморь'],
        near: ['sea', 'island'] },
    { kind: 'place', id: 'sea', en: ['sea', 'ocean', 'waves', 'seascape'], ru: ['мор', 'океан'],
        near: ['beach', 'ship', 'harbor', 'island'] },
    { kind: 'place', id: 'lake', en: ['lake', 'pond', 'lagoon'], ru: ['озер', 'пруд', 'лагун'], near: ['river'] },
    { kind: 'place', id: 'river', en: ['river', 'stream', 'creek', 'waterfall', 'riverside', 'riverbank'],
        ru: ['рек', 'ручей$', 'ручья$', 'ручье$', 'водопад'], near: ['lake', 'bridge'] },
    { kind: 'place', id: 'island', en: ['island', 'isle', 'archipelago'], ru: ['остров', 'архипелаг'], near: ['beach', 'sea'] },
    { kind: 'place', id: 'swamp', en: ['swamp', 'marsh', 'bog', 'wetland', 'mire'], ru: ['болот', 'топь$', 'топи$', 'трясин'],
        near: ['forest'] },
    { kind: 'place', id: 'harbor', en: ['harbor', 'harbour', 'port', 'docks', 'dock', 'pier', 'wharf', 'bay', 'marina', 'quay'],
        ru: ['порт', 'гаван', 'пристан', 'причал', 'док$', 'доки$', 'доках$', 'бухт', 'залив'], near: ['sea', 'ship', 'city'] },
    { kind: 'place', id: 'ship', en: ['ship', 'boat', 'deck', 'galleon', 'vessel', 'warship', 'sailship'],
        ru: ['корабл', 'судн', 'лодк', 'палуб', 'галеон', 'фрегат', 'трюм', 'кают', 'шхун', 'бриг$'], near: ['sea', 'harbor'] },
    { kind: 'place', id: 'space', en: ['space', 'spaceship', 'starship', 'spacecraft', 'spacestation', 'cosmos', 'orbit'],
        ru: ['космос', 'космическ', 'звездолет', 'орбит'] },
    { kind: 'place', id: 'graveyard', en: ['graveyard', 'cemetery', 'tomb', 'mausoleum', 'grave', 'necropolis'],
        ru: ['кладбищ', 'могил', 'гробниц', 'мавзоле', 'некропол', 'погост'], near: ['dungeon', 'temple'] },
    { kind: 'place', id: 'arena', en: ['arena', 'colosseum', 'stadium', 'gym', 'dojo', 'ring'],
        ru: ['арен', 'колизе', 'стадион', 'спортзал', 'додзе', 'ринг'], near: ['field'] },
    { kind: 'place', id: 'camp', en: ['camp', 'campsite', 'tent', 'campfire', 'camping', 'encampment'],
        ru: ['лагер', 'стоянк', 'палатк', 'шатер$', 'шатр', 'костер$', 'костр'], near: ['forest', 'field'] },
    { kind: 'place', id: 'battlefield', en: ['battlefield', 'battleground', 'warzone', 'trenches'], ru: ['битв', 'сражени', 'окоп'],
        near: ['field', 'ruins'] },
    { kind: 'place', id: 'ruins', en: ['ruins', 'ruin'], ru: ['руин', 'развалин'], near: ['castle', 'temple', 'city'] },
    { kind: 'place', id: 'station', en: ['station', 'railway', 'train', 'platform', 'subway', 'metro', 'terminal', 'airport'],
        ru: ['вокзал', 'станци', 'перрон', 'метро$', 'аэропорт', 'поезд', 'вагон'], near: ['city', 'street'] },
    // Time of day.
    { kind: 'time', id: 'morning', en: ['morning', 'dawn', 'sunrise', 'daybreak'],
        ru: ['утр', 'утренн', 'рассвет', 'заря$', 'зари$', 'зарю$', 'зарей$', 'спозаранк'] },
    { kind: 'time', id: 'day', en: ['day', 'daytime', 'noon', 'midday', 'afternoon', 'daylight'],
        ru: ['день$', 'дня$', 'днем$', 'дню$', 'дневн', 'полдень$', 'полдня$', 'полдн', 'полудн'] },
    { kind: 'time', id: 'evening', en: ['evening', 'dusk', 'sunset', 'twilight', 'sundown'], ru: ['вечер', 'сумерк', 'сумеречн', 'закат'] },
    { kind: 'time', id: 'night', en: ['night', 'midnight', 'nighttime', 'nightfall', 'moonlight', 'moonlit', 'nocturnal'],
        ru: ['ноч', 'полноч', 'полуночн'] },
    // Weather.
    { kind: 'weather', id: 'clear', en: ['clear', 'sunny', 'sunshine', 'cloudless'], ru: ['ясн', 'солнечн', 'солнц', 'безоблачн'] },
    { kind: 'weather', id: 'cloudy', en: ['cloudy', 'clouds', 'cloud', 'overcast', 'gloomy'], ru: ['облач', 'пасмурн', 'туч', 'хмур'] },
    { kind: 'weather', id: 'rain', en: ['rain', 'rainy', 'raining', 'drizzle', 'downpour', 'raindrops', 'wet'],
        ru: ['дожд', 'дождлив', 'ливн', 'ливень$', 'морос', 'слякот'] },
    { kind: 'weather', id: 'storm', en: ['storm', 'stormy', 'thunder', 'thunderstorm', 'lightning', 'tempest', 'hurricane', 'typhoon'],
        ru: ['гроз', 'грозов', 'шторм', 'буря$', 'бури$', 'бурю$', 'бурей$', 'бурь$', 'молни', 'ураган', 'тайфун', 'ненаст'] },
    { kind: 'weather', id: 'snow', en: ['snow', 'snowy', 'snowing', 'snowfall', 'blizzard', 'snowstorm'],
        ru: ['снег', 'снеж', 'метел', 'вьюг', 'пург', 'буран', 'снегопад'] },
    { kind: 'weather', id: 'fog', en: ['fog', 'foggy', 'mist', 'misty', 'haze', 'hazy', 'smog'], ru: ['туман', 'мгл', 'дымк', 'смог$'] },
    // Seasons.
    { kind: 'season', id: 'spring', en: ['spring', 'springtime'], ru: ['весн', 'весенн'] },
    { kind: 'season', id: 'summer', en: ['summer', 'summertime'], ru: ['лето$', 'лета$', 'летом$', 'лете$', 'летн'] },
    { kind: 'season', id: 'autumn', en: ['autumn', 'fall', 'autumnal'], ru: ['осен', 'осенн'] },
    { kind: 'season', id: 'winter', en: ['winter', 'wintry', 'wintertime'], ru: ['зим', 'зимн'] },
    // The place's state.
    { kind: 'state', id: 'ruined', en: ['ruined', 'destroyed', 'wrecked', 'collapsed'],
        ru: ['разруш', 'разрушен', 'полуразрушен', 'разорен'] },
    { kind: 'state', id: 'burning', en: ['burning', 'fire', 'flames', 'ablaze', 'inferno', 'burnt', 'burned'],
        ru: ['горящ', 'пожар', 'пылающ', 'пламен', 'сгоревш', 'сожжен', 'огненн'] },
    { kind: 'state', id: 'abandoned', en: ['abandoned', 'deserted', 'derelict', 'forsaken'], ru: ['заброшен', 'покинут', 'опустевш'] },
    { kind: 'state', id: 'flooded', en: ['flooded', 'underwater', 'sunken', 'drowned'], ru: ['затоплен', 'затонувш', 'подводн'] },
    { kind: 'state', id: 'festive', en: ['festive', 'festival', 'celebration', 'decorated', 'fireworks', 'christmas', 'holiday', 'carnival'],
        ru: ['праздн', 'украшен', 'фейерверк', 'карнавал', 'рождеств'] },
];

/** Case, number and adjective endings a Russian root may carry. */
// prettier-ignore
const RU_ENDINGS: ReadonlySet<string> = new Set([
    '', 'а', 'я', 'у', 'ю', 'е', 'и', 'ы', 'о', 'ь', 'й',
    'ом', 'ем', 'ой', 'ей', 'ам', 'ям', 'ах', 'ях', 'ами', 'ями', 'ов', 'ев', 'ью', 'ье', 'ья', 'ьи', 'ьям', 'ьях', 'ьев',
    'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ого', 'его', 'ому', 'ему', 'ых', 'их', 'ым', 'им', 'ыми', 'ими',
    'ный', 'ная', 'ное', 'ные', 'ной', 'ном', 'ную', 'ных', 'ным', 'ными', 'ного', 'ному',
    'ний', 'няя', 'нее', 'ние', 'нюю', 'них', 'ним', 'ними', 'него', 'нему',
    'ский', 'ская', 'ское', 'ские', 'ской', 'ском', 'скую', 'ских', 'ским', 'скими', 'ского', 'скому',
    'овый', 'овая', 'овое', 'овые', 'овой', 'овом', 'овую', 'овых', 'ьный', 'ьная', 'ьное', 'ьные', 'ьной', 'ьном',
]);

/** Words that say nothing about the place (articles, prepositions, credits, picture words). */
// prettier-ignore
const STOP_WORDS: ReadonlySet<string> = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'at', 'by', 'and', 'with', 'to', 'from', 'for', 'near', 'inside', 'outside',
    'interior', 'exterior', 'view', 'scene', 'background', 'backgrounds', 'bg', 'wallpaper', 'image', 'img', 'pic',
    'picture', 'photo', 'art', 'artwork', 'hd', 'hq', 'uhd', 'copy', 'final', 'new', 'old', 'big', 'small', 'side',
    'landscape', 'version', 'ver', 'edit', 'alt', 'jpg', 'png', 'webp', 'jpeg', 'gif', 'nai', 'sd', 'ai',
    'в', 'во', 'на', 'у', 'и', 'с', 'со', 'за', 'под', 'над', 'из', 'к', 'ко', 'от', 'до', 'по', 'о', 'об', 'при',
    'для', 'без', 'около', 'возле', 'рядом', 'внутри', 'снаружи', 'это', 'фон', 'вид', 'старый', 'новый', 'старая', 'новая',
]);

interface Hit {
    kind: Kind;
    id: string;
    /** Found as the end of an English compound («Blackwood»): likely a proper name as well. */
    compound?: boolean;
}

const EN_INDEX = new Map<string, Hit>();
const RU_EXACT = new Map<string, Hit>();
const RU_ROOTS: { root: string; hit: Hit }[] = [];
/** English place words long enough to be found at the end of a compound («treehouse», «seashore»). */
const EN_PLACE_SUFFIXES: { word: string; hit: Hit }[] = [];
const NEAR = new Map<string, readonly string[]>();

for (const entry of LEXICON) {
    const hit: Hit = { kind: entry.kind, id: entry.id };
    for (const word of entry.en) {
        if (!EN_INDEX.has(word)) EN_INDEX.set(word, hit);
        if (entry.kind === 'place' && word.length >= 4) EN_PLACE_SUFFIXES.push({ word, hit });
    }
    for (const form of entry.ru) {
        if (form.endsWith('$')) RU_EXACT.set(form.slice(0, -1), hit);
        else RU_ROOTS.push({ root: form, hit });
    }
    if (entry.near) NEAR.set(entry.id, entry.near);
}
RU_ROOTS.sort((a, b) => b.root.length - a.root.length);
EN_PLACE_SUFFIXES.sort((a, b) => b.word.length - a.word.length);

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /^[a-z']+$/;
const DIGITS_RE = /^\p{N}+$/u;
const EXTENSION_RE = /\.[a-z0-9]{2,5}$/i;
const CREDIT_RE = /[([](?:\s*(?:art\s+)?by|\s*from|\s*credit|\s*source)\b[^)\]]*[)\]]/giu;

/** Related place concepts of a concept (empty for unknown ids). */
export function nearConcepts(id: string): readonly string[] {
    return NEAR.get(id) ?? [];
}

/** Every place concept id the lexicon knows (tests, UI). */
export function placeConcepts(): string[] {
    return LEXICON.filter((entry) => entry.kind === 'place').map((entry) => entry.id);
}

/**
 * Words of a file or place name: camelCase and digits split off, any punctuation is a separator, lower case, ё → е.
 * «TavernNight_02-old» → tavern, night, 02, old.
 */
export function splitWords(text: string): string[] {
    let value = String(text ?? '').normalize('NFC');
    value = value
        .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
        .replace(/(\p{L})(\p{N})/gu, '$1 $2')
        .replace(/(\p{N})(\p{L})/gu, '$1 $2');
    value = value
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[’‘`´]/g, "'");
    return value
        .split(/[^\p{L}\p{N}']+/u)
        .map((word) => word.replace(/^'+|'+$/g, ''))
        .filter(Boolean);
}

/** A background file's readable title: no folder, no extension, no «(by author)» credit. */
export function fileTitle(file: string): string {
    const base =
        String(file ?? '')
            .split(/[\\/]/)
            .pop() ?? '';
    return base.replace(EXTENSION_RE, '').replace(CREDIT_RE, ' ').replace(/\s+/g, ' ').trim();
}

function englishForms(word: string): string[] {
    const forms = [word];
    if (word.endsWith("'s")) forms.push(word.slice(0, -2));
    if (word.endsWith('ies') && word.length > 4) forms.push(`${word.slice(0, -3)}y`);
    if (word.endsWith('es') && word.length > 3) forms.push(word.slice(0, -2));
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) forms.push(word.slice(0, -1));
    return forms;
}

function lookup(word: string): Hit | null {
    if (CYRILLIC_RE.test(word)) {
        const exact = RU_EXACT.get(word);
        if (exact) return exact;
        for (const { root, hit } of RU_ROOTS) {
            if (word.startsWith(root) && RU_ENDINGS.has(word.slice(root.length))) return hit;
        }
        return null;
    }
    for (const form of englishForms(word)) {
        const hit = EN_INDEX.get(form);
        if (hit) return hit;
    }
    if (word.length >= 6 && LATIN_RE.test(word)) {
        for (const { word: suffix, hit } of EN_PLACE_SUFFIXES) {
            if (word.length > suffix.length && word.endsWith(suffix)) return { ...hit, compound: true };
        }
    }
    return null;
}

export interface NameTokens {
    /** Place concepts (tavern, forest, castle…) in order of appearance. */
    concepts: string[];
    /** Words the lexicon does not know (proper names), as stems. */
    names: string[];
    time: TimeTag[];
    weather: WeatherTag[];
    season: SeasonTag[];
    state: StateTag[];
}

export function emptyTokens(): NameTokens {
    return { concepts: [], names: [], time: [], weather: [], season: [], state: [] };
}

function push<T>(list: T[], value: T): void {
    if (!list.includes(value)) list.push(value);
}

/** Tokens of a name or text: place concepts, variant tags and the stems of unknown words. */
export function tokenizeName(text: string): NameTokens {
    const tokens = emptyTokens();
    for (const word of splitWords(text)) {
        if (DIGITS_RE.test(word) || STOP_WORDS.has(word)) continue;
        const hit = lookup(word);
        if (hit) {
            if (hit.kind === 'place') push(tokens.concepts, hit.id);
            else if (hit.kind === 'time') push(tokens.time, hit.id as TimeTag);
            else if (hit.kind === 'weather') push(tokens.weather, hit.id as WeatherTag);
            else if (hit.kind === 'season') push(tokens.season, hit.id as SeasonTag);
            else push(tokens.state, hit.id as StateTag);
            if (!hit.compound) continue;
        }
        if ([...word].length < 3) continue;
        const stem = wordStem(word.replace(/'/g, ''));
        if (stem && !STOP_WORDS.has(stem)) push(tokens.names, stem);
    }
    // Ruins are a place and a state at once: a ruined temple suits «Руины храма».
    if (tokens.concepts.includes('ruins')) push(tokens.state, 'ruined');
    return tokens;
}

/** Tokens of a background file name (its title: no folder, extension or credit). */
export function tokenizeFile(file: string): NameTokens {
    return tokenizeName(fileTitle(file));
}

/** Union of token sets (order: first seen). */
export function mergeTokens(...parts: readonly NameTokens[]): NameTokens {
    const out = emptyTokens();
    for (const part of parts) {
        for (const value of part.concepts) push(out.concepts, value);
        for (const value of part.names) push(out.names, value);
        for (const value of part.time) push(out.time, value);
        for (const value of part.weather) push(out.weather, value);
        for (const value of part.season) push(out.season, value);
        for (const value of part.state) push(out.state, value);
    }
    return out;
}

// prettier-ignore
const TRANSLIT: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
    о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
    ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** A rough Latin skeleton of a word in either script: «Гарвард» and «Harvard» both give «garvard». */
export function nameSkeleton(word: string): string {
    let value = [
        ...String(word ?? '')
            .toLowerCase()
            .replace(/ё/g, 'е'),
    ]
        .map((char) => TRANSLIT[char] ?? char)
        .join('');
    value = value
        .replace(/ph/g, 'f')
        .replace(/ck/g, 'k')
        .replace(/q/g, 'k')
        .replace(/c/g, 'k')
        .replace(/w/g, 'v')
        .replace(/x/g, 'ks')
        .replace(/h/g, 'g')
        .replace(/[yj]/g, 'i')
        .replace(/[^a-z]/g, '');
    return value.replace(/(.)\1+/g, '$1');
}

export type NameMatch = 'exact' | 'similar' | null;

/**
 * Two name stems: 'exact' when equal or one is a prefix of the other in the same script (both ≥ 4 letters),
 * 'similar' when their transliterated skeletons agree (equal, or one letter apart for longer names), else null.
 */
export function namesMatch(a: string, b: string): NameMatch {
    if (!a || !b) return null;
    if (a === b) return 'exact';
    const sameScript = CYRILLIC_RE.test(a) === CYRILLIC_RE.test(b);
    if (sameScript && Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return 'exact';
    const x = nameSkeleton(a);
    const y = nameSkeleton(b);
    if (x.length < 3 || y.length < 3) return null;
    if (x === y) return 'similar';
    if (Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x))) return 'similar';
    if (Math.min(x.length, y.length) >= 5 && editDistance(x, y) <= 1) return 'similar';
    // Vowels are where transliterations disagree most («Блэквуд» — «Blackwood»): compare the consonants.
    const cx = x.replace(/[aeiou]/g, '');
    const cy = y.replace(/[aeiou]/g, '');
    if (cx.length >= 4 && cx === cy) return 'similar';
    return null;
}

/* ------------------------------------------------------------------ DES scene fields */

/** Time of day of a clock time in minutes since midnight: 5–11 morning, 11–17 day, 17–21 evening, else night. */
export function timeFromMinutes(minutes: number): TimeTag {
    const hours = (((minutes % 1440) + 1440) % 1440) / 60;
    if (hours >= 5 && hours < 11) return 'morning';
    if (hours >= 11 && hours < 17) return 'day';
    if (hours >= 17 && hours < 21) return 'evening';
    return 'night';
}

/** Time of day of a DES time text («18:30», «6 PM», «Late evening», «Глубокая ночь»); null when unreadable. */
export function timeOfDay(text: string | undefined): TimeTag | null {
    if (!text || !String(text).trim()) return null;
    const words = tokenizeName(text).time;
    // A written part of the day beats the clock («Evening, 16:50» is the story's evening).
    if (words.length === 1) return words[0] as TimeTag;
    const minutes = parseClock(text);
    if (minutes !== null) return timeFromMinutes(minutes);
    return words[0] ?? null;
}

// prettier-ignore
const WEATHER_EMOJI: readonly [RegExp, WeatherTag][] = [
    [/⛈|🌩/u, 'storm'],
    [/🌧|☔|🌦/u, 'rain'],
    [/❄|🌨|☃|⛄/u, 'snow'],
    [/🌫/u, 'fog'],
    [/☁|⛅|🌥/u, 'cloudy'],
    [/☀|🌤|🌞/u, 'clear'],
];

/** Weather tags of a DES weather field (forecast words and the emoji); a storm counts as rain too. */
export function weatherTags(weather: { emoji?: string; forecast?: string } | undefined | null): WeatherTag[] {
    if (!weather) return [];
    const tags: WeatherTag[] = [];
    const words = tokenizeName(String(weather.forecast ?? '')).weather;
    for (const tag of words) push(tags, tag);
    if (!tags.length) {
        const emoji = `${weather.emoji ?? ''}${weather.forecast ?? ''}`;
        for (const [re, tag] of WEATHER_EMOJI) if (re.test(emoji)) push(tags, tag);
    }
    if (tags.includes('storm')) push(tags, 'rain');
    // «Clear» next to a heavy tag is noise («ясно, к вечеру дождь»): the heavier weather shows.
    if (tags.length > 1 && tags.some((tag) => tag === 'rain' || tag === 'snow' || tag === 'fog')) {
        return tags.filter((tag) => tag !== 'clear');
    }
    return tags;
}

const MONTH_SEASON: readonly SeasonTag[] = [
    'winter',
    'winter',
    'spring',
    'spring',
    'spring',
    'summer',
    'summer',
    'summer',
    'autumn',
    'autumn',
    'autumn',
    'winter',
];

/** Season of a DES date: a season word, else the month of a calendar date (northern hemisphere); null if neither. */
export function seasonOf(date: string | undefined): SeasonTag | null {
    if (!date) return null;
    const words = tokenizeName(date).season;
    if (words.length) return words[0] as SeasonTag;
    const parsed = parseDay(date);
    if (parsed?.kind === 'date' && parsed.month) return MONTH_SEASON[parsed.month - 1] ?? null;
    return null;
}

/** The kind of a variant tag. */
export function variantKind(tag: string): 'time' | 'weather' | 'season' | null {
    if ((TIME_TAGS as readonly string[]).includes(tag)) return 'time';
    if ((WEATHER_TAGS as readonly string[]).includes(tag)) return 'weather';
    if ((SEASON_TAGS as readonly string[]).includes(tag)) return 'season';
    return null;
}
