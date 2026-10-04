// M26 «Живой канон» — the cheap search for new names in a reply (plan M26 п. 1, п. 3; P4: rules first, no model).
//
// What counts as a candidate (Russian and English prose):
// - a type word followed by a quoted name: «таверна „Ржавый якорь“», `the tavern "Rusty Anchor"`;
// - a naming phrase: «так называемый X», «под названием X», «известный как X», "known as X", "called X";
// - a capitalised sequence mid-sentence: «Праздник Фонарей», «Орден Серебряной Луны», "the Lantern Festival";
// - a lower-case type word next to a capitalised name: «праздник Фонарей», «город Эльмира», "the Lantern festival",
//   "the town of Elmira";
// - a person title before a name: «капитан Элдрин», "Captain Eldrin";
// - a single capitalised word mid-sentence (Russian capitalises only proper names there): «Гвидо».
// False-positive guards: sentence starts (incl. dialogue dashes and quotes), common capitalised words («Вы», "I",
// weekdays, nationalities), all-caps shouting and abbreviations, title-cased headings (long sequences). Known names
// are the caller's business (world model, canon keys, lore); this file only offers the matching helpers.
// Case forms are grouped by a crude stem («Празднике Фонарей» = «Праздник Фонарей»); a leading Russian type word is
// put back into the nominative. Pure: no DOM, no SillyTavern.
import { escapeForKey, hasCyrillic } from './canon-keys';
import { parseRegexKey } from './lore-match';
import { editDistance } from './places-match';

export type LivingType = 'tradition' | 'place' | 'item' | 'faction' | 'event' | 'person' | 'other';
export const LIVING_TYPES: readonly LivingType[] = [
    'tradition',
    'place',
    'item',
    'faction',
    'event',
    'person',
    'other',
] as const;

/**
 * How the name was found: a quoted name after a type word, a naming phrase, a type word next to it, a person title,
 * a capitalised sequence of several words, or one capitalised word.
 */
export type NamePattern = 'quoted' | 'naming' | 'typed' | 'titled' | 'multiword' | 'single';

export interface NameCandidate {
    /** Display name (the shortest surface form; a leading Russian type word in the nominative). */
    name: string;
    type: LivingType;
    pattern: NamePattern;
    /** Occurrences in the text, every case form counted. */
    count: number;
    /** The sentence around the best occurrence (a descriptive one when there is one), at most QUOTE_MAX chars. */
    quote: string;
    /** Some occurrence sits in a sentence that describes it («X — это…», «X, где…», "X is a…", «каждый год»). */
    descriptive: boolean;
    /** Offset of the first detection. */
    index: number;
    words: number;
    /** Every surface form seen («Празднике Фонарей», «Праздник Фонарей»). */
    variants: string[];
}

export const QUOTE_MAX = 280;
const MAX_NAME_CHARS = 60;
const MAX_NAME_WORDS = 6;
/** Longer capitalised runs are headings or title case, not names. */
const MAX_SEQUENCE = 6;
const MAX_CANDIDATES = 24;

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LETTER_RE = /\p{L}/u;
const UPPER_START_RE = /^\p{Lu}/u;
const DIGIT_RE = /\p{N}/u;
const TOKEN_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}]|['’-](?=[\p{L}\p{N}]))*/gu;
const OPEN_QUOTES = '«„“"';
const CLOSE_QUOTES = '»“”"';
/** Characters that do not end a sentence and are skipped when looking back (markdown, quotes, brackets). */
const TRANSPARENT_RE = /[\s*_~`«„“"'([]/u;
const TERMINATOR_RE = /[.!?…:;]/u;

/* ------------------------------------------------------------------ words and stems */

/** Russian endings, longest first (a crude stemmer: one ending, at least three letters left). */
// prettier-ignore
const RU_ENDINGS = [
    'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'иях', 'ией', 'ах', 'ях', 'ам', 'ям', 'ой', 'ей',
    'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ых', 'их', 'ом', 'ем', 'ов', 'ев', 'ью', 'ия', 'ию',
    'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
];

/** NFC, lower case, ё → е, typographic apostrophe → '. */
export function normalizeWord(word: string): string {
    return word.normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/’/g, "'");
}

/** Crude stem: a Russian word loses one ending (keeping three letters), an English one a possessive or plural s. */
export function stemWord(word: string): string {
    const lower = normalizeWord(word);
    if (CYRILLIC_RE.test(lower)) {
        for (const ending of RU_ENDINGS) {
            if (lower.endsWith(ending) && lower.length - ending.length >= 3) return lower.slice(0, -ending.length);
        }
        return lower;
    }
    if (lower.endsWith("'s")) return lower.slice(0, -2);
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
    return lower;
}

/** Words of a text (letters and digits, inner apostrophes and hyphens kept). */
export function wordsOf(text: string): string[] {
    return [...String(text ?? '').matchAll(TOKEN_RE)].map((match) => match[0]);
}

/** Identity of a name across case forms: the stems of its words. «Празднике Фонарей» → «праздник фонар». */
export function nameKey(name: string): string {
    return wordsOf(name).map(stemWord).join(' ');
}

/** Letters a Russian stem may take as its case ending in a key. */
const KEY_TAIL = 3;

/**
 * A World Info key for a Russian name of several words in any case form, for chats without DES-RU: every Cyrillic
 * word becomes its stem plus a short ending, Latin words stay as they are, a left word boundary in front
 * («Праздник Фонарей» → `/(?:^|[^\p{L}\p{N}_])праздник\p{L}{0,3}\s+фонар\p{L}{0,3}/iu`, which also matches
 * «Празднике Фонарей»). Null for single words (the canon's own key covers them) and names without Cyrillic.
 */
export function stemRegexKey(name: string): string | null {
    const words = wordsOf(name);
    if (words.length < 2 || !hasCyrillic(name) || name.includes('{{')) return null;
    const parts = words.map((word) =>
        hasCyrillic(word) ? `${escapeForKey(stemWord(word))}\\p{L}{0,${KEY_TAIL}}` : escapeForKey(word),
    );
    return `/(?:^|[^\\p{L}\\p{N}_])${parts.join('\\s+')}/iu`;
}

/* ------------------------------------------------------------------ type words */

interface TypeWord {
    type: LivingType;
    /** The type word belongs to the name («Праздник Фонарей») or only labels it («город Эльмира» → Эльмира). */
    partOfName: boolean;
    /** Nominative form (Russian) used when the name starts with a declined type word. */
    base: string;
    /** Only acts when capitalised inside a name («Дом Ланкастеров», "House Valerian", «День Урожая»). */
    capitalizedOnly?: boolean;
}

interface RuStem extends TypeWord {
    stem: string;
    /** Letters allowed after the stem. */
    tail: number;
}

const ru = (stem: string, tail: number, type: LivingType, base: string, extra: Partial<TypeWord> = {}): RuStem => ({
    stem,
    tail,
    type,
    base,
    partOfName: type === 'tradition' || type === 'event' || type === 'faction',
    ...extra,
});

/** Russian type words by stem (lower case, ё → е). */
// prettier-ignore
const RU_TYPE_STEMS: readonly RuStem[] = [
    ru('праздник', 3, 'tradition', 'праздник'), ru('фестивал', 3, 'tradition', 'фестиваль'),
    ru('обряд', 3, 'tradition', 'обряд'), ru('ритуал', 3, 'tradition', 'ритуал'),
    ru('церемони', 3, 'tradition', 'церемония'), ru('торжеств', 3, 'tradition', 'торжество'),
    ru('карнавал', 3, 'tradition', 'карнавал'), ru('ярмарк', 3, 'tradition', 'ярмарка'),
    ru('обыча', 3, 'tradition', 'обычай'), ru('традици', 3, 'tradition', 'традиция'),
    ru('недел', 2, 'tradition', 'неделя', { capitalizedOnly: true }),
    ru('битв', 3, 'event', 'битва'), ru('войн', 3, 'event', 'война'), ru('восстани', 3, 'event', 'восстание'),
    ru('сражени', 3, 'event', 'сражение'), ru('осад', 3, 'event', 'осада'), ru('резн', 3, 'event', 'резня'),
    ru('катастроф', 3, 'event', 'катастрофа'), ru('турнир', 3, 'event', 'турнир'),
    ru('переворот', 3, 'event', 'переворот'), ru('мятеж', 3, 'event', 'мятеж'), ru('бунт', 3, 'event', 'бунт'),
    ru('коронаци', 3, 'event', 'коронация'), ru('падени', 3, 'event', 'падение'),
    ru('нашестви', 3, 'event', 'нашествие'),
    ru('орден', 3, 'faction', 'орден'), ru('гильди', 3, 'faction', 'гильдия'), ru('братств', 3, 'faction', 'братство'),
    ru('сестринств', 3, 'faction', 'сестринство'), ru('клан', 3, 'faction', 'клан'), ru('союз', 3, 'faction', 'союз'),
    ru('легион', 3, 'faction', 'легион'), ru('династи', 3, 'faction', 'династия'),
    ru('таверн', 3, 'place', 'таверна'), ru('трактир', 3, 'place', 'трактир'), ru('корчм', 3, 'place', 'корчма'),
    ru('харчевн', 3, 'place', 'харчевня'), ru('гостиниц', 3, 'place', 'гостиница'), ru('кабак', 3, 'place', 'кабак'),
    ru('город', 3, 'place', 'город'), ru('деревн', 3, 'place', 'деревня'), ru('поселк', 3, 'place', 'посёлок'),
    ru('замок', 3, 'place', 'замок'), ru('замк', 3, 'place', 'замок'), ru('крепост', 3, 'place', 'крепость'),
    ru('башн', 3, 'place', 'башня'), ru('храм', 3, 'place', 'храм'), ru('монастыр', 3, 'place', 'монастырь'),
    ru('королевств', 3, 'place', 'королевство'), ru('импери', 3, 'place', 'империя'),
    ru('княжеств', 3, 'place', 'княжество'), ru('остров', 3, 'place', 'остров'), ru('долин', 3, 'place', 'долина'),
    ru('пещер', 3, 'place', 'пещера'), ru('улиц', 3, 'place', 'улица'), ru('площад', 3, 'place', 'площадь'),
    ru('квартал', 3, 'place', 'квартал'), ru('гаван', 3, 'place', 'гавань'), ru('перевал', 3, 'place', 'перевал'),
    ru('академи', 3, 'place', 'академия'), ru('пустын', 3, 'place', 'пустыня'), ru('провинци', 3, 'place', 'провинция'),
    ru('озер', 2, 'place', 'озеро'), ru('клинок', 3, 'item', 'клинок'), ru('клинк', 3, 'item', 'клинок'),
    ru('кинжал', 3, 'item', 'кинжал'), ru('амулет', 3, 'item', 'амулет'), ru('артефакт', 3, 'item', 'артефакт'),
    ru('кольц', 3, 'item', 'кольцо'), ru('книг', 3, 'item', 'книга'), ru('свиток', 3, 'item', 'свиток'),
    ru('свитк', 3, 'item', 'свиток'), ru('корабл', 3, 'item', 'корабль'), ru('посох', 3, 'item', 'посох'),
    ru('доспех', 3, 'item', 'доспех'), ru('талисман', 3, 'item', 'талисман'), ru('реликви', 3, 'item', 'реликвия'),
    ru('кристалл', 3, 'item', 'кристалл'),
    ru('лорд', 3, 'person', 'лорд'), ru('леди', 0, 'person', 'леди'), ru('сэр', 0, 'person', 'сэр'),
    ru('госпож', 3, 'person', 'госпожа'), ru('господин', 3, 'person', 'господин'), ru('мастер', 2, 'person', 'мастер'),
    ru('капитан', 3, 'person', 'капитан'), ru('корол', 3, 'person', 'король'), ru('принц', 4, 'person', 'принц'),
    ru('барон', 4, 'person', 'барон'), ru('герцог', 4, 'person', 'герцог'), ru('магистр', 3, 'person', 'магистр'),
    ru('жрец', 3, 'person', 'жрец'), ru('жриц', 3, 'person', 'жрица'), ru('старейшин', 3, 'person', 'старейшина'),
    ru('генерал', 3, 'person', 'генерал'), ru('командир', 3, 'person', 'командир'),
];

/** Russian type words given by their forms: short stems would catch names («лес» → «Лесли», «гор» → «Горан»). */
// prettier-ignore
const RU_TYPE_FORM_LIST: readonly { base: string; type: LivingType; forms: string[]; capitalizedOnly?: boolean }[] = [
    { base: 'день', type: 'tradition', forms: ['день', 'дня', 'дню', 'днем', 'дне'], capitalizedOnly: true },
    { base: 'ночь', type: 'tradition', forms: ['ночь', 'ночи', 'ночью'], capitalizedOnly: true },
    { base: 'род', type: 'faction', forms: ['род', 'рода', 'роду', 'родом', 'роде'] },
    { base: 'дом', type: 'faction', forms: ['дом', 'дома', 'дому', 'домом', 'доме'], capitalizedOnly: true },
    { base: 'культ', type: 'faction', forms: ['культ', 'культа', 'культу', 'культом', 'культе'] },
    { base: 'секта', type: 'faction', forms: ['секта', 'секты', 'секте', 'секту', 'сектой'] },
    { base: 'совет', type: 'faction', forms: ['совет', 'совета', 'совету', 'советом', 'совете'] },
    { base: 'лига', type: 'faction', forms: ['лига', 'лиги', 'лиге', 'лигу', 'лигой'] },
    { base: 'банда', type: 'faction', forms: ['банда', 'банды', 'банде', 'банду', 'бандой'] },
    { base: 'лес', type: 'place', forms: ['лес', 'леса', 'лесу', 'лесом', 'лесе'] },
    { base: 'гора', type: 'place', forms: ['гора', 'горы', 'горе', 'гору', 'горой'] },
    { base: 'река', type: 'place', forms: ['река', 'реки', 'реке', 'реку', 'рекой'] },
    { base: 'море', type: 'place', forms: ['море', 'моря', 'морю', 'морем'] },
    { base: 'страна', type: 'place', forms: ['страна', 'страны', 'стране', 'страну', 'страной'] },
    { base: 'меч', type: 'item', forms: ['меч', 'меча', 'мечу', 'мечом', 'мече'] },
    { base: 'щит', type: 'item', forms: ['щит', 'щита', 'щиту', 'щитом', 'щите'] },
    { base: 'корона', type: 'item', forms: ['корона', 'короны', 'короне', 'корону', 'короной'] },
    { base: 'зелье', type: 'item', forms: ['зелье', 'зелья', 'зелью', 'зельем'] },
];

const RU_TYPE_FORMS: ReadonlyMap<string, TypeWord> = new Map(
    RU_TYPE_FORM_LIST.flatMap((item) =>
        item.forms.map((form): [string, TypeWord] => [
            form,
            {
                type: item.type,
                base: item.base,
                partOfName: item.type === 'tradition' || item.type === 'event' || item.type === 'faction',
                ...(item.capitalizedOnly ? { capitalizedOnly: true } : {}),
            },
        ]),
    ),
);

const en = (type: LivingType, words: string[], extra: Partial<TypeWord> = {}): [string, TypeWord][] =>
    words.map((word) => [
        word,
        { type, base: word, partOfName: type === 'tradition' || type === 'event' || type === 'faction', ...extra },
    ]);

/** English type words (lower case, singular). */
const EN_TYPE_WORDS: ReadonlyMap<string, TypeWord> = new Map([
    ...en('tradition', ['festival', 'feast', 'holiday', 'ceremony', 'rite', 'ritual', 'tradition', 'celebration']),
    ...en('tradition', ['carnival', 'fair']),
    ...en('tradition', ['day', 'night', 'eve', 'week'], { capitalizedOnly: true }),
    ...en('event', ['battle', 'war', 'siege', 'uprising', 'rebellion', 'revolt', 'massacre', 'tournament']),
    ...en('event', ['coronation', 'plague', 'cataclysm']),
    ...en('faction', ['order', 'guild', 'brotherhood', 'sisterhood', 'clan', 'cult', 'sect', 'council', 'league']),
    ...en('faction', ['union', 'legion', 'covenant', 'dynasty']),
    ...en('faction', ['house', 'company', 'circle'], { capitalizedOnly: true }),
    ...en('place', ['tavern', 'inn', 'pub', 'city', 'town', 'village', 'castle', 'keep', 'fortress', 'tower']),
    ...en('place', ['temple', 'monastery', 'forest', 'woods', 'mountain', 'mount', 'lake', 'river', 'island']),
    ...en('place', ['isle', 'valley', 'cave', 'street', 'square', 'kingdom', 'empire', 'port', 'harbor', 'harbour']),
    ...en('place', ['market', 'bridge', 'pass', 'academy', 'library', 'sea', 'desert', 'swamp', 'province']),
    ...en('item', ['sword', 'blade', 'dagger', 'amulet', 'ring', 'artifact', 'artefact', 'book', 'tome', 'scroll']),
    ...en('item', ['ship', 'staff', 'crown', 'shield', 'armor', 'armour', 'potion', 'crystal', 'talisman', 'relic']),
    ...en('person', ['lord', 'lady', 'sir', 'master', 'captain', 'king', 'queen', 'prince', 'princess', 'duke']),
    ...en('person', ['duchess', 'countess', 'baron', 'baroness', 'general', 'commander', 'elder', 'priest']),
    ...en('person', ['priestess'], {}),
]);

/** The type word a token stands for (any case form), or null. */
export function typeWordOf(word: string): TypeWord | null {
    const lower = normalizeWord(word);
    if (CYRILLIC_RE.test(lower)) {
        const exact = RU_TYPE_FORMS.get(lower);
        if (exact) return exact;
        let best: RuStem | null = null;
        for (const entry of RU_TYPE_STEMS) {
            if (!lower.startsWith(entry.stem) || lower.length - entry.stem.length > entry.tail) continue;
            if (!best || entry.stem.length > best.stem.length) best = entry;
        }
        return best;
    }
    const direct = EN_TYPE_WORDS.get(lower);
    if (direct) return direct;
    if (lower.length > 3 && lower.endsWith('s')) return EN_TYPE_WORDS.get(lower.slice(0, -1)) ?? null;
    return null;
}

/** Guessed type of a name from the type words in it or right before it; 'other' when nothing tells. */
export function guessType(name: string, context = ''): LivingType {
    for (const word of [...wordsOf(name), ...wordsOf(context).slice(-3)]) {
        const type = typeWordOf(word);
        if (type) return type.type;
    }
    return 'other';
}

/* ------------------------------------------------------------------ common words */

// prettier-ignore
const RU_COMMON = new Set([
    'вы', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваши', 'вашего', 'вашей', 'вашему', 'вашим', 'вашу', 'ваших',
    'вашими', 'бог', 'бога', 'богу', 'богом', 'боже', 'господь', 'господи', 'господа', 'господу', 'мисс', 'мистер',
    'миссис', 'мадам', 'месье', 'величество', 'величества', 'величеству', 'высочество', 'высочества', 'высочеству',
    'светлость', 'светлости', 'честь', 'чести', 'я', 'он', 'она', 'оно', 'они', 'мы', 'ты',
]);

/** Words that open Russian sentences and never start a name. */
// prettier-ignore
const RU_STARTERS = new Set([
    'мой', 'моя', 'моё', 'мое', 'мои', 'твой', 'твоя', 'твои', 'наш', 'наша', 'наши', 'свой', 'своя', 'свои', 'этот',
    'эта', 'это', 'эти', 'тот', 'та', 'то', 'те', 'такой', 'такая', 'какой', 'какая', 'который', 'которая', 'каждый',
    'каждая', 'любой', 'весь', 'вся', 'все', 'всё', 'сам', 'сама', 'самый', 'другой', 'другая', 'иной', 'некий',
    'никакой', 'ее', 'её', 'его', 'их', 'старый', 'старая', 'молодой', 'молодая', 'новый', 'новая', 'первый',
    'последний', 'целый', 'один', 'одна',
]);

// prettier-ignore
const EN_COMMON = new Set([
    'i', "i'm", "i'd", "i'll", "i've", 'mr', 'mrs', 'ms', 'dr', 'sir', 'madam', "ma'am", 'god', 'oh', 'ok', 'okay',
    'yes', 'no', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
    'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'english',
    'french', 'german', 'russian', 'spanish', 'italian', 'japanese', 'chinese', 'american', 'british', 'european',
    'christmas', 'easter', 'internet', 'tv',
]);

/** Words that open English sentences and never start a name. */
// prettier-ignore
const EN_STARTERS = new Set([
    'the', 'a', 'an', 'i', 'he', 'she', 'it', 'they', 'we', 'you', 'this', 'that', 'these', 'those', 'there', 'then',
    'when', 'while', 'after', 'before', 'but', 'and', 'or', 'so', 'if', 'as', 'at', 'in', 'on', 'her', 'his', 'their',
    'our', 'my', 'your', 'its', 'yes', 'no', 'oh', 'well', 'now', 'still', 'even', 'just', 'only', 'every', 'each',
    'all', 'some', 'many', 'most', 'what', 'who', 'why', 'how', 'where', 'here', 'later', 'soon', 'once', 'with',
    'without', 'from', 'for', 'to', 'by', 'not', 'nothing', 'something', 'everyone', 'someone', 'no-one', 'perhaps',
    'maybe', 'sometimes', 'until', 'since', 'because', 'though', 'although', 'yet', 'again', 'outside', 'inside',
    'old', 'young', 'new', 'another', 'other', 'one', 'two', 'three', 'meanwhile', 'tonight', 'today', 'tomorrow',
    'yesterday', 'also', 'too',
]);

/** Lower-case words allowed between capitalised words of one name («Битва при Кровавом Броде», "Order of the Rose"). */
const CONNECTORS = new Set([
    'при',
    'де',
    'фон',
    'ван',
    'дер',
    'ибн',
    'аль',
    'of',
    'the',
    'de',
    'du',
    'da',
    'del',
    'von',
    'van',
    'der',
    'la',
    'le',
]);

/** English naming-phrase verbs that also start ordinary clauses: they need a capitalised or quoted name after. */
const RU_ADJECTIVE_RE = /(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ую|юю|ых|их)$/;

function isCommonWord(word: string): boolean {
    const lower = normalizeWord(word);
    return RU_COMMON.has(lower) || EN_COMMON.has(lower);
}

/* ------------------------------------------------------------------ tokens */

interface Token {
    text: string;
    start: number;
    end: number;
    lower: string;
    stem: string;
    cap: boolean;
    /** All capitals (shouting, abbreviations): never a name. */
    caps: boolean;
    cyr: boolean;
    digit: boolean;
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(TOKEN_RE)) {
        const word = match[0];
        const start = match.index ?? 0;
        const letters = word.replace(/[^\p{L}]/gu, '');
        tokens.push({
            text: word,
            start,
            end: start + word.length,
            lower: normalizeWord(word),
            stem: stemWord(word),
            cap: UPPER_START_RE.test(word),
            caps: letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase(),
            cyr: CYRILLIC_RE.test(word),
            digit: DIGIT_RE.test(word),
        });
    }
    return tokens;
}

/** The token begins a sentence: text start, a new line, or a terminator before it (quotes and markdown skipped). */
function sentenceStart(text: string, at: number): boolean {
    for (let i = at - 1; i >= 0; i--) {
        const char = text[i] ?? '';
        if (char === '\n') return true;
        if (TERMINATOR_RE.test(char)) return true;
        if (char === '—' || char === '–') {
            // A dash opens a line of dialogue (sentence start) unless it continues one after a comma.
            for (let j = i - 1; j >= 0; j--) {
                const before = text[j] ?? '';
                if (before === ' ' || before === '\t') continue;
                return before === '\n' || TERMINATOR_RE.test(before);
            }
            return true;
        }
        if (TRANSPARENT_RE.test(char)) continue;
        return false;
    }
    return true;
}

/** Only spaces (no punctuation, quotes or line breaks) between two tokens. */
function plainGap(text: string, from: number, to: number): boolean {
    const gap = text.slice(from, to);
    return gap.length > 0 && gap.length <= 3 && /^[ \t\u00a0]+$/.test(gap);
}

function capitalize(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/* ------------------------------------------------------------------ sentences and quotes */

/** Bounds of the sentence around `at` (terminators and line breaks end sentences). */
export function sentenceBounds(text: string, at: number): { start: number; end: number } {
    let start = 0;
    for (let i = Math.min(at, text.length) - 1; i >= 0; i--) {
        const char = text[i] ?? '';
        if (char === '\n' || (/[.!?…]/.test(char) && /\s/.test(text[i + 1] ?? ' '))) {
            start = i + 1;
            break;
        }
    }
    let end = text.length;
    for (let i = at; i < text.length; i++) {
        const char = text[i] ?? '';
        if (char === '\n') {
            end = i;
            break;
        }
        if (/[.!?…]/.test(char)) {
            let close = i + 1;
            while (close < text.length && /[.!?…»”"')\]*]/.test(text[close] ?? '')) close++;
            if (close >= text.length || /\s/.test(text[close] ?? '')) {
                end = close;
                break;
            }
        }
    }
    return { start, end };
}

/** The sentence around an offset, trimmed; a long sentence is cut to a window around the offset. */
export function quoteAround(text: string, at: number, max = QUOTE_MAX): string {
    const { start, end } = sentenceBounds(text, at);
    let quote = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (quote.length <= max) return quote;
    const offset = Math.max(0, at - start);
    const from = Math.max(0, offset - Math.floor(max * 0.4));
    const to = Math.min(quote.length, from + max - 2);
    let cut = quote.slice(from, to);
    if (from > 0) cut = `…${cut.replace(/^\S*\s/, '')}`;
    if (to < quote.length) cut = `${cut.replace(/\s\S*$/, '')}…`;
    quote = cut.trim();
    return quote;
}

const DESCRIPTIVE_RU =
    /(?<!\p{L})(?:это|являет\p{L}*|назыв\p{L}*|слав\p{L}*|знаменит\p{L}*|известн\p{L}*|традици\p{L}*|обыча\p{L}*|ежегодн\p{L}*|каждый\s+год|каждую\s+(?:весну|осень|зиму)|каждое\s+лето|раз\s+в\s+году?|по\s+обычаю|по\s+традиции|издавна|испокон|принято|в\s+честь|основан\p{L}*|построен\p{L}*|легенд\p{L}*|говорят|считает\p{L}*|когда-то|некогда|веками|столети\p{L}*|празднуют|отмечают)(?!\p{L})/iu;
const DESCRIPTIVE_EN =
    /\b(?:every\s+year|each\s+year|annual(?:ly)?|traditional(?:ly)?|tradition|custom(?:ary)?|it\s+is\s+said|legend(?:s|ary)?|known\s+for|famous|founded|built|named\s+after|in\s+hono(?:u)?r\s+of|for\s+centuries|ancient|celebrated|held\s+(?:every|each|on|in))\b/i;
const AFTER_NAME_RE =
    /^[\s»”"')]*(?:[—–]\s|,\s*(?:котор|где(?!\p{L})|что(?!\p{L})|which|who|where|whose)|(?:is|was|are|were)\s+(?:a|an|the|one|known|famous|held|celebrated)(?!\p{L}))/iu;

/** The sentence describes the name: definition dash, relative clause, «каждый год», "is a…", "famous". */
export function isDescriptive(sentence: string, afterName = ''): boolean {
    return AFTER_NAME_RE.test(afterName) || DESCRIPTIVE_RU.test(sentence) || DESCRIPTIVE_EN.test(sentence);
}

/* ------------------------------------------------------------------ detection */

interface Detection {
    name: string;
    type: LivingType;
    pattern: NamePattern;
    /** Offset of the name. */
    start: number;
    end: number;
    /** Offset where the whole match begins (type word, naming phrase): the generic scan skips it. */
    from: number;
}

const PATTERN_RANK: Record<NamePattern, number> = {
    quoted: 6,
    naming: 5,
    typed: 4,
    titled: 3,
    multiword: 2,
    single: 1,
};

const ARTICLES = new Set(['the', 'a', 'an']);

function cleanName(raw: string): string {
    return raw
        .replace(/\s+/g, ' ')
        .replace(/^[\s.,!?…;:'"«»„“”()\-–—]+|[\s.,!?…;:'"«»„“”()\-–—]+$/g, '')
        .trim();
}

function validName(name: string): boolean {
    if (!name || name.length < 2 || name.length > MAX_NAME_CHARS || !LETTER_RE.test(name)) return false;
    const words = wordsOf(name);
    if (!words.length || words.length > MAX_NAME_WORDS) return false;
    if (words.length === 1 && (isCommonWord(name) || typeWordOf(name))) return false;
    return true;
}

const QUOTED_AFTER_WORD_RE = new RegExp(
    `([\\p{L}]+)[ \\t\\u00a0]+[${OPEN_QUOTES}]([^${OPEN_QUOTES}${CLOSE_QUOTES}\\n]{1,60}?)[${CLOSE_QUOTES}]`,
    'gu',
);

/** «таверна „Ржавый якорь“», `the tavern "Rusty Anchor"`: a type word right before a quoted name. */
function quotedNames(text: string): Detection[] {
    const out: Detection[] = [];
    for (const match of text.matchAll(QUOTED_AFTER_WORD_RE)) {
        const type = typeWordOf(match[1] ?? '');
        if (!type) continue;
        const raw = match[2] ?? '';
        const name = cleanName(raw);
        if (!validName(name)) continue;
        const from = match.index ?? 0;
        const start = from + match[0].length - raw.length - 1;
        out.push({ name: capitalize(name), type: type.type, pattern: 'quoted', start, end: start + raw.length, from });
    }
    return out;
}

const NAMING_RE =
    /(?<![\p{L}])(так\s+называем\p{L}*|под\s+названием|под\s+именем|известн\p{L}*\s+как|именуем\p{L}*|по\s+прозвищу|по\s+имени|прозванн\p{L}*|наре[чк]енн\p{L}*|so[-\s]called|known\s+as|called|named|dubbed|nicknamed)(?![\p{L}])[ \t\u00a0]+/giu;
/** Phrases after which a lower-case name is allowed («так называемый зимний сбор», "so-called black tide"). */
const LOOSE_NAMING_RE = /^(?:так|so)/i;
const PERSON_NAMING_RE = /^(?:по\s+прозвищу|по\s+имени|named|nicknamed|под\s+именем)/i;

/** Words of a name after a naming phrase: capitalised ones (with connectors), or one or two lower-case words. */
function wordsAfter(text: string, tokens: Token[], index: number, loose: boolean): Token[] {
    const parts: Token[] = [];
    const first = tokens[index];
    if (!first) return parts;
    // Lower case: an adjective takes its noun along («зимний сбор»), a noun stands alone.
    const limit = loose ? (first.cyr && !RU_ADJECTIVE_RE.test(first.lower) ? 1 : 2) : 5;
    for (let i = index; i < tokens.length && parts.length < limit; i++) {
        const token = tokens[i];
        if (!token) break;
        const previous = parts[parts.length - 1];
        if (previous && !plainGap(text, previous.end, token.start)) break;
        if (loose) {
            if (token.cap && parts.length) break;
        } else if (!token.cap && !(CONNECTORS.has(token.lower) && tokens[i + 1]?.cap && parts.length)) {
            break;
        }
        parts.push(token);
    }
    return parts;
}

/** «так называемый X», «под названием X», "known as X", "called X": a quoted or capitalised name after the phrase. */
function namingPhrases(text: string, tokens: Token[]): Detection[] {
    const out: Detection[] = [];
    for (const match of text.matchAll(NAMING_RE)) {
        const phrase = match[1] ?? '';
        const from = match.index ?? 0;
        const after = from + match[0].length;
        let name: string;
        let start: number;
        const open = text[after] ?? '';
        if (OPEN_QUOTES.includes(open)) {
            const close = text.slice(after + 1).search(new RegExp(`[${CLOSE_QUOTES}\\n]`, 'u'));
            if (close <= 0 || close > MAX_NAME_CHARS) continue;
            name = text.slice(after + 1, after + 1 + close);
            start = after + 1;
        } else {
            let index = tokens.findIndex((token) => token.start >= after);
            if (index < 0) continue;
            if (ARTICLES.has(tokens[index]?.lower ?? '') && tokens[index + 1]?.cap) index++;
            const first = tokens[index];
            if (!first || first.start - after > 4 || first.caps || first.digit) continue;
            const loose = LOOSE_NAMING_RE.test(phrase) && !first.cap;
            if (!loose && !first.cap) continue;
            const parts = wordsAfter(text, tokens, index, loose);
            const last = parts[parts.length - 1];
            if (!last) continue;
            start = first.start;
            name = text.slice(start, last.end);
        }
        name = cleanName(name);
        if (!validName(name)) continue;
        // The word before the phrase tells the type («таверна под названием «Сломанный щит»» is a place), then the name.
        const before = wordsOf(text.slice(Math.max(0, from - 40), from)).slice(-3);
        const near = before.map(typeWordOf).find((item): item is TypeWord => item !== null);
        let type: LivingType = near ? near.type : guessType(name);
        if (type === 'other' && PERSON_NAMING_RE.test(phrase)) type = 'person';
        out.push({ name: capitalize(name), type, pattern: 'naming', start, end: start + name.length, from });
    }
    return out;
}

function isRuStarter(token: Token): boolean {
    return RU_STARTERS.has(token.lower) || RU_COMMON.has(token.lower);
}

/** Does a sentence-initial word belong to the name that follows it? */
function startJoins(token: Token): boolean {
    if (typeWordOf(token.text)) return true;
    if (token.cyr) return !isRuStarter(token) && RU_ADJECTIVE_RE.test(token.lower);
    return !EN_STARTERS.has(token.lower) && !EN_COMMON.has(token.lower) && !token.lower.endsWith('ly');
}

/** Capitalised runs outside the explicit patterns, with type words, titles and sentence starts sorted out. */
function capitalisedNames(text: string, tokens: Token[], covered: (at: number) => boolean): Detection[] {
    const out: Detection[] = [];
    const usable = (token: Token | undefined): token is Token =>
        !!token && token.cap && !token.caps && !token.digit && !covered(token.start);
    let i = 0;
    while (i < tokens.length) {
        if (!usable(tokens[i])) {
            i++;
            continue;
        }
        const run: number[] = [i];
        let j = i + 1;
        while (j < tokens.length) {
            const previous = tokens[run[run.length - 1] ?? i];
            const token = tokens[j];
            if (!previous || !token || !plainGap(text, previous.end, token.start)) break;
            if (usable(token)) {
                run.push(j);
                j++;
                continue;
            }
            // Up to two connectors, then a capitalised word.
            let k = j;
            while (k < tokens.length && k - j < 2 && CONNECTORS.has(tokens[k]?.lower ?? '')) {
                const next = tokens[k + 1];
                if (!next || !plainGap(text, tokens[k]?.end ?? 0, next.start)) break;
                k++;
            }
            if (k > j && usable(tokens[k])) {
                for (let n = j; n <= k; n++) run.push(n);
                j = k + 1;
                continue;
            }
            break;
        }
        i = j;
        if (run.length > MAX_SEQUENCE) continue;
        const detection = sequenceName(text, tokens, run);
        if (detection) out.push(detection);
    }
    return out;
}

interface TypeLink {
    word: Token;
    type: TypeWord;
    /** "the town of Elmira": the type word is linked by "of". */
    of: boolean;
}

/** A lower-case type word or title right before the name («праздник Фонарей», "the town of Elmira"). */
function typeBefore(text: string, tokens: Token[], startIndex: number): TypeLink | null {
    let back = startIndex - 1;
    let of = false;
    if (tokens[back]?.lower === 'the') back--;
    if (tokens[back]?.lower === 'of') {
        of = true;
        back--;
    }
    const word = tokens[back];
    if (!word || word.cap || (of && word.cyr)) return null;
    const type = typeWordOf(word.text);
    if (!type || type.capitalizedOnly || !plainGapChain(text, tokens, back, startIndex)) return null;
    return { word, type, of };
}

/** An English lower-case type word right after the name ("the Lantern festival", "the Rusty Anchor tavern"). */
function typeAfter(text: string, tokens: Token[], endIndex: number): TypeWord | null {
    const last = tokens[endIndex];
    const next = tokens[endIndex + 1];
    if (!last || !next || next.cap || next.cyr || !plainGap(text, last.end, next.start)) return null;
    const type = typeWordOf(next.text);
    return type && !type.capitalizedOnly ? type : null;
}

function sequenceName(text: string, tokens: Token[], run: number[]): Detection | null {
    let words = run.map((index) => tokens[index]).filter((token): token is Token => !!token);
    const head = words[0];
    if (!head) return null;
    if (sentenceStart(text, head.start) && !startJoins(head)) words = words.slice(1);
    // Leading connectors and articles (after a dropped first word) and common words at either end go.
    while (words.length && (CONNECTORS.has(words[0]?.lower ?? '') || ARTICLES.has(words[0]?.lower ?? ''))) {
        words = words.slice(1);
    }
    while (words.length && isCommonWord(words[0]?.text ?? '')) words = words.slice(1);
    while (words.length && isCommonWord(words[words.length - 1]?.text ?? '')) words = words.slice(0, -1);
    if (!words.length) return null;

    let pattern: NamePattern = words.length > 1 ? 'multiword' : 'single';
    let type: LivingType = 'other';
    let prefix = '';
    let suffix = '';
    const title = typeWordOf((words[0] as Token).text);
    if (title?.type === 'person') {
        // «Капитан Элдрин», "Lord Varis": the title is not part of the name.
        if (words.length === 1) return null;
        words = words.slice(1);
        type = 'person';
        pattern = 'titled';
    } else {
        // Titles only count in front («площадь Трёх Королей» is not a person).
        const inner = words
            .map((token) => typeWordOf(token.text))
            .find((item): item is TypeWord => item !== null && item.type !== 'person');
        if (inner) type = inner.type;
    }
    const lead = words[0] as Token;
    const tail = words[words.length - 1] as Token;
    if (type === 'other') {
        const before = typeBefore(text, tokens, tokens.indexOf(lead));
        const after = before ? null : typeAfter(text, tokens, tokens.indexOf(tail));
        const found = before?.type ?? after;
        if (found) {
            type = found.type;
            pattern = type === 'person' ? 'titled' : 'typed';
            if (before && found.partOfName && type !== 'person') {
                prefix = `${capitalize(before.word.cyr ? found.base : before.word.lower)}${before.of ? ' of' : ''} `;
            }
            if (after && found.partOfName) suffix = ` ${capitalize(found.base)}`;
        }
    }
    // A single capitalised word must not open a sentence (it is found mid-sentence or not at all).
    if (pattern === 'single' && (sentenceStart(text, lead.start) || lead.lower.length < 3)) return null;
    // A declined Russian type word in front goes back to the nominative («Празднике Фонарей» → «Праздник Фонарей»).
    let surface = text.slice(lead.start, tail.end);
    const leadType = typeWordOf(lead.text);
    if (lead.cyr && leadType?.partOfName && words.length > 1 && lead.lower !== leadType.base) {
        surface = `${capitalize(leadType.base)}${surface.slice(lead.text.length)}`;
    }
    const name = cleanName(`${prefix}${surface}${suffix}`);
    if (!validName(name)) return null;
    return { name, type, pattern, start: lead.start, end: tail.end, from: lead.start };
}

/** Only plain spaces from token `from` to token `to` (the words between are connectors such as "of", "the"). */
function plainGapChain(text: string, tokens: Token[], from: number, to: number): boolean {
    for (let i = from; i < to; i++) {
        const a = tokens[i];
        const b = tokens[i + 1];
        if (!a || !b || !plainGap(text, a.end, b.start)) return false;
    }
    return true;
}

/* ------------------------------------------------------------------ text index (mentions) */

export interface TextIndex {
    text: string;
    stems: string[];
    /** Token offsets in the text, parallel to `stems`. */
    offsets: number[];
    ends: number[];
    positions: Map<string, number[]>;
}

export function indexText(text: string): TextIndex {
    const source = String(text ?? '');
    const stems: string[] = [];
    const offsets: number[] = [];
    const ends: number[] = [];
    const positions = new Map<string, number[]>();
    for (const match of source.matchAll(TOKEN_RE)) {
        const stem = stemWord(match[0]);
        const list = positions.get(stem);
        if (list) list.push(stems.length);
        else positions.set(stem, [stems.length]);
        stems.push(stem);
        offsets.push(match.index ?? 0);
        ends.push((match.index ?? 0) + match[0].length);
    }
    return { text: source, stems, offsets, ends, positions };
}

/** Token positions where the stems of `name` occur in a row. */
export function findName(index: TextIndex, name: string): number[] {
    const stems = wordsOf(name).map(stemWord);
    const first = stems[0];
    if (!first) return [];
    const hits: number[] = [];
    for (const at of index.positions.get(first) ?? []) {
        let ok = true;
        for (let k = 1; k < stems.length; k++) {
            if (index.stems[at + k] !== stems[k]) {
                ok = false;
                break;
            }
        }
        if (ok) hits.push(at);
    }
    return hits;
}

function isRegexTerm(term: string): boolean {
    return /^\/[\s\S]+\/[gimsuy]*$/.test(term);
}

/**
 * The text mentions one of the terms: plain terms by their stems in a row (any case form), `/regex/` keys by
 * themselves. Terms with macros are skipped.
 */
export function mentionsAny(index: TextIndex, terms: readonly string[]): boolean {
    for (const term of terms) {
        if (typeof term !== 'string' || !term.trim() || term.includes('{{')) continue;
        const trimmed = term.trim();
        if (isRegexTerm(trimmed)) {
            const regex = parseRegexKey(trimmed);
            if (regex && regex.test(index.text)) return true;
            continue;
        }
        if (findName(index, trimmed).length) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ similarity */

const STOP_STEMS = new Set(['the', 'of', 'a', 'an', 'and', 'при', 'и', 'де', 'фон', 'ван', 'дер', 'de', 'von', 'van']);

/** Stems of the words that tell names apart (type words, titles and connectors left out). */
export function distinctiveStems(name: string): string[] {
    const out: string[] = [];
    for (const word of wordsOf(name)) {
        const stem = stemWord(word);
        if (STOP_STEMS.has(stem) || typeWordOf(word)) continue;
        if (!out.includes(stem)) out.push(stem);
    }
    return out;
}

/**
 * Two names of one thing: the same stems, the same distinctive stems («Праздник Фонарей» ~ «Фестиваль Фонарей»,
 * «Орден Серебряной Луны» ~ «Серебряная Луна»), one a subset of the other with at least two stems, mostly the same
 * words, or a one-letter typo in a single long word («Элдрин» ~ «Эльдрин»).
 */
export function similarNames(a: string, b: string): boolean {
    if (!a.trim() || !b.trim()) return false;
    if (nameKey(a) === nameKey(b)) return true;
    const da = distinctiveStems(a);
    const db = distinctiveStems(b);
    if (!da.length || !db.length) return false;
    const sb = new Set(db);
    const shared = da.filter((stem) => sb.has(stem)).length;
    const union = new Set([...da, ...db]).size;
    if (shared === da.length && shared === db.length) return true;
    if (shared === Math.min(da.length, db.length) && shared >= 2) return true;
    if (shared / union >= 0.6) return true;
    const [x] = da;
    const [y] = db;
    if (da.length === 1 && db.length === 1 && x && y && Math.min(x.length, y.length) >= 5) {
        return editDistance(x, y) <= 1;
    }
    return false;
}

/* ------------------------------------------------------------------ known names */

export interface KnownNames {
    keys: Set<string>;
    texts: TextIndex[];
    regexes: RegExp[];
}

/**
 * What the world already knows: names and keys (plain or `/regex/`), and longer texts (card description, lore of the
 * last turn) searched by stems.
 */
export function buildKnownNames(names: Iterable<unknown>, texts: Iterable<unknown> = []): KnownNames {
    const keys = new Set<string>();
    const regexes: RegExp[] = [];
    for (const value of names) {
        if (typeof value !== 'string' || !value.trim() || value.includes('{{')) continue;
        const trimmed = value.trim();
        if (isRegexTerm(trimmed)) {
            const regex = parseRegexKey(trimmed);
            if (regex) regexes.push(regex);
            continue;
        }
        const key = nameKey(trimmed);
        if (key) keys.add(key);
    }
    const indexes: TextIndex[] = [];
    for (const value of texts) {
        if (typeof value === 'string' && value.trim()) indexes.push(indexText(value));
    }
    return { keys, texts: indexes, regexes };
}

/** The name (any case form) is a known name or key, matches a regex key, or occurs in a known text. */
export function isKnownName(known: KnownNames, name: string): boolean {
    const key = nameKey(name);
    if (!key) return true;
    if (known.keys.has(key)) return true;
    for (const regex of known.regexes) {
        regex.lastIndex = 0;
        if (regex.test(name)) return true;
    }
    return known.texts.some((index) => findName(index, name).length > 0);
}

/* ------------------------------------------------------------------ the whole search */

export interface DetectOptions {
    max?: number;
    quoteChars?: number;
}

interface Group {
    detections: Detection[];
    best: Detection;
    /** Token position of each occurrence → number of tokens it spans. */
    hits: Map<number, number>;
}

function groupDetections(detections: readonly Detection[]): Group[] {
    const groups: Group[] = [];
    for (const detection of detections) {
        const group = groups.find((item) => item.detections.some((other) => similarNames(other.name, detection.name)));
        if (!group) {
            groups.push({ detections: [detection], best: detection, hits: new Map() });
            continue;
        }
        group.detections.push(detection);
        const rank = PATTERN_RANK[detection.pattern] - PATTERN_RANK[group.best.pattern];
        const longer = wordsOf(detection.name).length > wordsOf(group.best.name).length;
        if (rank > 0 || (rank === 0 && longer)) group.best = detection;
    }
    return groups;
}

/**
 * New-name candidates of a reply (cleaned story text), grouped by case form and similarity, in order of first
 * appearance. Known names are not filtered here.
 */
export function detectNames(text: string, options: DetectOptions = {}): NameCandidate[] {
    const source = String(text ?? '');
    if (!source.trim()) return [];
    const tokens = tokenize(source);
    const explicit = [...quotedNames(source), ...namingPhrases(source, tokens)];
    // The type word or naming phrase in front of an explicit name and the quotes around it are covered as well.
    const spans = explicit.map((item) => [item.from, item.end + 1] as const);
    const covered = (at: number) => spans.some(([from, to]) => at >= from && at < to);
    const detections = [...explicit, ...capitalisedNames(source, tokens, covered)].sort((a, b) => a.start - b.start);
    const index = indexText(source);
    const groups = groupDetections(detections);
    for (const group of groups) {
        for (const detection of group.detections) {
            const size = wordsOf(detection.name).length;
            for (const at of findName(index, detection.name))
                group.hits.set(at, Math.max(size, group.hits.get(at) ?? 0));
        }
    }
    // A lone capitalised word inside another name's occurrences («Ржавом» of «в „Ржавом якоре“») is not a name.
    const taken = new Set<number>();
    for (const group of groups) {
        if (group.best.pattern === 'single') continue;
        for (const [at, size] of group.hits) for (let k = 0; k < size; k++) taken.add(at + k);
    }
    const kept = groups.filter(
        (group) => group.best.pattern !== 'single' || ![...group.hits.keys()].every((at) => taken.has(at)),
    );

    const out: NameCandidate[] = [];
    for (const group of kept) {
        const variants = [...new Set(group.detections.map((item) => item.name))];
        // Display: the shortest form with the most words (case endings make forms longer, not shorter).
        const words = wordsOf(group.best.name).length;
        const display =
            variants.filter((name) => wordsOf(name).length === words).sort((a, b) => a.length - b.length)[0] ??
            group.best.name;
        const occurrences = [...group.hits].sort((a, b) => a[0] - b[0]);
        let quote = '';
        let descriptive = false;
        for (const [at, size] of occurrences) {
            const offset = index.offsets[at] ?? group.best.start;
            const end = index.ends[at + size - 1] ?? offset;
            const sentence = quoteAround(source, offset, options.quoteChars ?? QUOTE_MAX);
            if (isDescriptive(sentence, source.slice(end, end + 40))) {
                quote = sentence;
                descriptive = true;
                break;
            }
            quote ||= sentence;
        }
        if (!quote) quote = quoteAround(source, group.best.start, options.quoteChars ?? QUOTE_MAX);
        const type = group.detections.map((item) => item.type).find((item) => item !== 'other') ?? guessType(display);
        out.push({
            name: display,
            type,
            pattern: group.best.pattern,
            count: Math.max(1, group.hits.size),
            quote,
            descriptive,
            index: Math.min(...group.detections.map((item) => item.start)),
            words: wordsOf(display).length,
            variants,
        });
    }
    return out.sort((a, b) => a.index - b.index).slice(0, options.max ?? MAX_CANDIDATES);
}

/* ------------------------------------------------------------------ significance */

/** Score at which a candidate is worth the canon (plan M26 п. 2: «мелочь отсеивается»). */
export const SIGNIFICANT_SCORE = 2;

/**
 * Significance of a candidate: a thing type (tradition, place, item, faction, event), an explicit naming context
 * (type word, quotes, naming phrase, title), several words, repetition in the reply, a describing sentence, and an
 * earlier mention in the chat each add one.
 */
export function significance(candidate: NameCandidate, seenBefore = false): number {
    let score = 0;
    if (candidate.type !== 'other' && candidate.type !== 'person') score++;
    if (['quoted', 'naming', 'typed', 'titled'].includes(candidate.pattern)) score++;
    else if (candidate.pattern === 'multiword') score++;
    if (candidate.count >= 2) score++;
    if (candidate.descriptive) score++;
    if (seenBefore) score++;
    return score;
}

/** The K most significant candidates (score ≥ SIGNIFICANT_SCORE), best first, ties by order of appearance. */
export function pickSignificant<T extends { score: number; candidate: NameCandidate }>(
    items: readonly T[],
    k: number,
): T[] {
    return items
        .filter((item) => item.score >= SIGNIFICANT_SCORE)
        .sort((a, b) => b.score - a.score || a.candidate.index - b.candidate.index)
        .slice(0, Math.max(0, Math.floor(k)));
}
