// Names of outfits as a person would say them (plan-2 §4 п. 3 «с понятным русским названием»; brief: «Шёлковое
// платье», «Блузка и юбка»): the main garments of the outfit's tags in Russian, one with its most telling adjective
// (material, then purpose, then colour) agreeing in gender, or two joined with «и». Footwear, hats and jewellery name
// an outfit only when there is nothing else. The Russian wording, when there is one, picks the noun where English
// folds two («халат» / «мантия» are both "robe"). Also the built-in outfits of undressing and the clothing slot's
// stand-in that carries its tracker wordings. Pure.
import { outfitName, ruTermKey } from './wardrobe-tags';
import type { OutfitTag } from './wardrobe-tags';
import type { UndressKind } from './wardrobe-wear';

export type NameLocale = 'ru' | 'en';
type Gender = 'm' | 'f' | 'n' | 'pl';

interface Noun {
    word: string;
    gender: Gender;
    /** Footwear, headwear, gloves, scarves, jewellery: names an outfit only when nothing else does. */
    minor?: boolean;
    /** The word carries its own adjective («ночная рубашка»): no other is added. */
    fixed?: boolean;
}

const n = (word: string, gender: Gender, extra: Partial<Noun> = {}): Noun => ({ word, gender, ...extra });
const minor = (word: string, gender: Gender, extra: Partial<Noun> = {}): Noun =>
    n(word, gender, { minor: true, ...extra });

// English garment (as the tags spell it) → Russian noun.
// prettier-ignore
const EN_NOUNS: Readonly<Record<string, Noun>> = {
    dress: n('платье', 'n'), gown: n('платье', 'n'), frock: n('платье', 'n'), sundress: n('сарафан', 'm'),
    skirt: n('юбка', 'f'), pants: n('брюки', 'pl'), trousers: n('брюки', 'pl'), slacks: n('брюки', 'pl'),
    jeans: n('джинсы', 'pl'), shorts: n('шорты', 'pl'), leggings: n('леггинсы', 'pl'), breeches: n('бриджи', 'pl'),
    shirt: n('рубашка', 'f'), blouse: n('блузка', 'f'), 't-shirt': n('футболка', 'f'), tee: n('футболка', 'f'),
    'tank top': n('майка', 'f'), 'crop top': n('топ', 'm'), top: n('топ', 'm'), camisole: n('топ', 'm'),
    sweater: n('свитер', 'm'), jumper: n('свитер', 'm'), pullover: n('свитер', 'm'), sweatshirt: n('свитшот', 'm'),
    cardigan: n('кофта', 'f'), hoodie: n('худи', 'n'), turtleneck: n('водолазка', 'f'), vest: n('жилет', 'm'),
    waistcoat: n('жилет', 'm'), blazer: n('пиджак', 'm'), jacket: n('куртка', 'f'), windbreaker: n('ветровка', 'f'),
    'down jacket': n('пуховик', 'm'), coat: n('пальто', 'n'), overcoat: n('пальто', 'n'), greatcoat: n('шинель', 'f'),
    'trench coat': n('тренч', 'm'), trenchcoat: n('тренч', 'm'), 'fur coat': n('шуба', 'f'),
    'sheepskin coat': n('дублёнка', 'f'), raincoat: n('дождевик', 'm'), parka: n('парка', 'f'), cloak: n('плащ', 'm'),
    mantle: n('плащ', 'm'), cape: n('накидка', 'f'), robe: n('мантия', 'f'), robes: n('мантия', 'f'),
    poncho: n('пончо', 'n'), kimono: n('кимоно', 'n'), yukata: n('юката', 'f'), tunic: n('туника', 'f'),
    cassock: n('ряса', 'f'), doublet: n('камзол', 'm'), kaftan: n('кафтан', 'm'), 'frock coat': n('сюртук', 'm'),
    tailcoat: n('фрак', 'm'), tuxedo: n('смокинг', 'm'), suit: n('костюм', 'm'), corset: n('корсет', 'm'),
    bodice: n('корсаж', 'm'), apron: n('фартук', 'm'), uniform: n('форма', 'f'), 'military uniform': n('мундир', 'm'),
    jumpsuit: n('комбинезон', 'm'), overalls: n('комбинезон', 'm'), pajamas: n('пижама', 'f'),
    nightgown: n('ночная рубашка', 'f', { fixed: true }), negligee: n('пеньюар', 'm'), underwear: n('бельё', 'n'),
    lingerie: n('бельё', 'n'), undergarments: n('бельё', 'n'), panties: n('трусики', 'pl'), bra: n('бюстгальтер', 'm'),
    boxers: n('трусы', 'pl'), briefs: n('трусы', 'pl'), swimsuit: n('купальник', 'm'), bikini: n('бикини', 'n'),
    leotard: n('боди', 'n'), bodysuit: n('боди', 'n'), kilt: n('килт', 'm'), sari: n('сари', 'n'), toga: n('тога', 'f'),
    chemise: n('сорочка', 'f'), petticoat: n('нижняя юбка', 'f', { fixed: true }), tabard: n('табард', 'm'),
    armor: n('доспехи', 'pl'), 'plate armor': n('латы', 'pl', { fixed: true }), chainmail: n('кольчуга', 'f'),
    breastplate: n('кираса', 'f'), clothes: n('одежда', 'f'),
    stockings: minor('чулки', 'pl'), thighhighs: minor('чулки', 'pl'), pantyhose: minor('колготки', 'pl'),
    tights: minor('колготки', 'pl'), socks: minor('носки', 'pl'), 'leg warmers': minor('гетры', 'pl'),
    boots: minor('сапоги', 'pl'), 'thigh boots': minor('ботфорты', 'pl'), shoes: minor('туфли', 'pl'),
    sneakers: minor('кроссовки', 'pl'), sandals: minor('сандалии', 'pl'), slippers: minor('тапочки', 'pl'),
    moccasins: minor('мокасины', 'pl'), 'high heels': minor('туфли на каблуках', 'pl', { fixed: true }),
    heels: minor('туфли на каблуках', 'pl', { fixed: true }), helmet: minor('шлем', 'm'),
    bracers: minor('наручи', 'pl'), greaves: minor('поножи', 'pl'), gauntlets: minor('латные перчатки', 'pl', { fixed: true }),
    hat: minor('шляпа', 'f'), cap: minor('кепка', 'f'), beret: minor('берет', 'm'), hood: minor('капюшон', 'm'),
    beanie: minor('шапка', 'f'), veil: minor('вуаль', 'f'), bandana: minor('бандана', 'f'), turban: minor('тюрбан', 'm'),
    bonnet: minor('чепец', 'm'), scarf: minor('шарф', 'm'), headscarf: minor('платок', 'm'), shawl: minor('шаль', 'f'),
    gloves: minor('перчатки', 'pl'), mittens: minor('варежки', 'pl'), necklace: minor('ожерелье', 'n'),
    earrings: minor('серьги', 'pl'), bracelet: minor('браслет', 'm'), tiara: minor('диадема', 'f'),
    crown: minor('корона', 'f'), glasses: minor('очки', 'pl'), mask: minor('маска', 'f'),
};

// A Russian word of the wording (its dictionary key) → the noun it says where English folds two.
// prettier-ignore
const RU_NOUNS: Readonly<Record<string, Noun>> = {
    'халат': n('халат', 'm'), 'манти': n('мантия', 'f'), 'шапк': minor('шапка', 'f'), 'шапоч': minor('шапка', 'f'),
    'ботинк': minor('ботинки', 'pl'), '=ботинок': minor('ботинки', 'pl'), 'башмак': minor('башмаки', 'pl'),
    'рубах': n('рубаха', 'f'), 'сорочк': n('сорочка', 'f'), 'униформ': n('униформа', 'f'), 'жакет': n('жакет', 'm'),
    'кофт': n('кофта', 'f'), 'штан': n('штаны', 'pl'), 'трус': n('трусы', 'pl'), 'платок': minor('платок', 'm'),
    'платк': minor('платок', 'm'), 'кафтан': n('кафтан', 'm'), 'туник': n('туника', 'f'), 'сутан': n('сутана', 'f'),
    'доспех': n('доспехи', 'pl'), '=латы': n('латы', 'pl'), '=латах': n('латы', 'pl'), '=латами': n('латы', 'pl'),
    'неглиже': n('неглиже', 'n'), 'топик': n('топик', 'm'), 'юбоч': n('юбка', 'f'), '=юбок': n('юбка', 'f'),
    'курточ': n('куртка', 'f'), 'сапож': minor('сапоги', 'pl'), 'туфел': minor('туфли', 'pl'),
};

type AdjType = 'hard' | 'stressed' | 'soft' | 'velar';

const ENDINGS: Readonly<Record<AdjType, Record<Gender, string>>> = {
    hard: { m: 'ый', f: 'ая', n: 'ое', pl: 'ые' },
    stressed: { m: 'ой', f: 'ая', n: 'ое', pl: 'ые' },
    soft: { m: 'ий', f: 'яя', n: 'ее', pl: 'ие' },
    velar: { m: 'ий', f: 'ая', n: 'ое', pl: 'ие' },
};

type AdjRank = 'material' | 'purpose' | 'colour' | 'cut';
interface Adjective {
    stem: string;
    type: AdjType;
    rank: AdjRank;
}

const adj = (stem: string, type: AdjType, rank: AdjRank): Adjective => ({ stem, type, rank });

// English tag word → Russian adjective stem.
// prettier-ignore
const EN_ADJECTIVES: Readonly<Record<string, Adjective>> = {
    silk: adj('шёлков', 'hard', 'material'), leather: adj('кожан', 'hard', 'material'),
    suede: adj('замшев', 'hard', 'material'), satin: adj('атласн', 'hard', 'material'),
    velvet: adj('бархатн', 'hard', 'material'), brocade: adj('парчов', 'hard', 'material'),
    cotton: adj('хлопков', 'hard', 'material'), linen: adj('льнян', 'stressed', 'material'),
    wool: adj('шерстян', 'stressed', 'material'), woolen: adj('шерстян', 'stressed', 'material'),
    knitted: adj('вязан', 'hard', 'material'), lace: adj('кружевн', 'hard', 'material'),
    denim: adj('джинсов', 'hard', 'material'), tweed: adj('твидов', 'hard', 'material'),
    flannel: adj('фланелев', 'hard', 'material'), fur: adj('мехов', 'stressed', 'material'),
    latex: adj('латексн', 'hard', 'material'), steel: adj('стальн', 'stressed', 'material'),
    iron: adj('железн', 'hard', 'material'), chiffon: adj('шифонов', 'hard', 'material'),
    tulle: adj('фатинов', 'hard', 'material'), mesh: adj('сетчат', 'hard', 'material'),
    canvas: adj('холщов', 'stressed', 'material'), cashmere: adj('кашемиров', 'hard', 'material'),
    felt: adj('войлочн', 'hard', 'material'), straw: adj('соломенн', 'hard', 'material'),
    wooden: adj('деревянн', 'hard', 'material'), plate: adj('латн', 'hard', 'material'),
    evening: adj('вечерн', 'soft', 'purpose'), wedding: adj('свадебн', 'hard', 'purpose'),
    ball: adj('бальн', 'hard', 'purpose'), military: adj('военн', 'hard', 'purpose'),
    school: adj('школьн', 'hard', 'purpose'), sports: adj('спортивн', 'hard', 'purpose'),
    travel: adj('дорожн', 'hard', 'purpose'), traveling: adj('дорожн', 'hard', 'purpose'),
    formal: adj('парадн', 'hard', 'purpose'), business: adj('делов', 'stressed', 'purpose'),
    festive: adj('праздничн', 'hard', 'purpose'), casual: adj('повседневн', 'hard', 'purpose'),
    beach: adj('пляжн', 'hard', 'purpose'), winter: adj('зимн', 'soft', 'purpose'),
    summer: adj('летн', 'soft', 'purpose'), royal: adj('королевск', 'velar', 'purpose'),
    peasant: adj('крестьянск', 'velar', 'purpose'),
    white: adj('бел', 'hard', 'colour'), black: adj('чёрн', 'hard', 'colour'), red: adj('красн', 'hard', 'colour'),
    blue: adj('син', 'soft', 'colour'), 'light blue': adj('голуб', 'stressed', 'colour'),
    green: adj('зелён', 'hard', 'colour'), yellow: adj('жёлт', 'hard', 'colour'), gold: adj('золот', 'stressed', 'colour'),
    golden: adj('золот', 'stressed', 'colour'), grey: adj('сер', 'hard', 'colour'), gray: adj('сер', 'hard', 'colour'),
    silver: adj('серебрян', 'hard', 'colour'), brown: adj('коричнев', 'hard', 'colour'),
    pink: adj('розов', 'hard', 'colour'), purple: adj('фиолетов', 'hard', 'colour'),
    orange: adj('оранжев', 'hard', 'colour'), burgundy: adj('бордов', 'hard', 'colour'),
    beige: adj('бежев', 'hard', 'colour'), crimson: adj('багров', 'hard', 'colour'),
    scarlet: adj('ал', 'hard', 'colour'), emerald: adj('изумрудн', 'hard', 'colour'),
    turquoise: adj('бирюзов', 'hard', 'colour'), cream: adj('кремов', 'hard', 'colour'),
    olive: adj('оливков', 'hard', 'colour'), lilac: adj('сиренев', 'hard', 'colour'),
    azure: adj('лазурн', 'hard', 'colour'), multicolored: adj('разноцветн', 'hard', 'colour'),
    torn: adj('рван', 'hard', 'cut'), long: adj('длинн', 'hard', 'cut'), short: adj('коротк', 'velar', 'cut'),
    striped: adj('полосат', 'hard', 'cut'), plaid: adj('клетчат', 'hard', 'cut'),
};
const RANK_ORDER: readonly AdjRank[] = ['material', 'purpose', 'colour', 'cut'];
const MAX_NAME_CHARS = 40;

function agree(adjective: Adjective, gender: Gender): string {
    return adjective.stem + ENDINGS[adjective.type][gender];
}

const capital = (text: string) => (text ? (text[0] as string).toUpperCase() + text.slice(1) : text);

interface NamedGarment {
    noun: Noun;
    adjectives: Adjective[];
}

/** The garment of one tag («dark blue silk dress» → платье + шёлковое, синее). */
function garmentOfTag(tag: string, overrides: ReadonlyMap<string, Noun>): NamedGarment | null {
    const words = tag.toLowerCase().split(/\s+/).filter(Boolean);
    for (let size = Math.min(3, words.length); size >= 1; size--) {
        const head = words.slice(-size).join(' ');
        const noun = overrides.get(head) ?? EN_NOUNS[head];
        if (!noun) continue;
        const before = words.slice(0, -size);
        const adjectives: Adjective[] = [];
        for (let i = 0; i < before.length; i++) {
            const pair = i + 1 < before.length ? `${before[i]} ${before[i + 1]}` : '';
            const found = (pair && EN_ADJECTIVES[pair]) || EN_ADJECTIVES[before[i] as string];
            if (found) adjectives.push(found);
            if (pair && EN_ADJECTIVES[pair]) i++;
        }
        return { noun, adjectives };
    }
    return null;
}

/** Russian nouns the wording names where English folds two words: English garment → noun. */
function wordingOverrides(wording: string, tags: readonly OutfitTag[]): Map<string, Noun> {
    const out = new Map<string, Noun>();
    if (!/\p{Script=Cyrillic}/u.test(wording)) return out;
    // The last one, two and three words of every tag: where a garment stands.
    const heads = new Set<string>();
    for (const item of tags) {
        const words = item.tag.split(' ').filter(Boolean);
        for (let size = 1; size <= Math.min(3, words.length); size++) heads.add(words.slice(-size).join(' '));
    }
    for (const word of wording.split(/[^\p{L}]+/u)) {
        const key = ruTermKey(word);
        const noun = key ? RU_NOUNS[key] : undefined;
        if (!noun) continue;
        for (const en of FAMILIES[noun.word] ?? []) if (heads.has(en) && !out.has(en)) out.set(en, noun);
    }
    return out;
}

/** The English garments a Russian noun of RU_NOUNS stands for. */
const FAMILIES: Readonly<Record<string, readonly string[]>> = {
    халат: ['robe', 'robes'],
    мантия: ['robe', 'robes'],
    шапка: ['hat', 'beanie'],
    ботинки: ['boots', 'boot'],
    башмаки: ['shoes', 'shoe'],
    рубаха: ['shirt'],
    сорочка: ['shirt', 'chemise'],
    униформа: ['uniform'],
    жакет: ['jacket'],
    кофта: ['cardigan'],
    штаны: ['pants'],
    трусы: ['panties', 'boxers', 'briefs'],
    платок: ['headscarf'],
    кафтан: ['kaftan'],
    туника: ['tunic'],
    сутана: ['cassock'],
    доспехи: ['armor'],
    латы: ['plate armor', 'armor'],
    неглиже: ['negligee'],
    топик: ['crop top', 'top'],
    юбка: ['skirt'],
    куртка: ['jacket'],
    сапоги: ['boots', 'boot'],
    туфли: ['shoes', 'shoe'],
};

function phrase(garment: NamedGarment, ranks: readonly AdjRank[]): string {
    if (garment.noun.fixed) return garment.noun.word;
    const words: string[] = [];
    for (const rank of ranks) {
        const found = garment.adjectives.find((item) => item.rank === rank);
        if (found) words.push(agree(found, garment.noun.gender));
    }
    return [...words, garment.noun.word].join(' ');
}

function bestRank(garment: NamedGarment): AdjRank | null {
    for (const rank of RANK_ORDER) if (garment.adjectives.some((item) => item.rank === rank)) return rank;
    return null;
}

/**
 * A Russian name for a new outfit from its tags (and the Russian wording, for the nouns): «Шёлковое платье», «Блузка и
 * юбка», «Платье и сапоги»; unique against `taken` (another adjective, else «… 2»). Null when no garment is known.
 */
export function russianOutfitName(
    tags: readonly OutfitTag[],
    wording = '',
    taken: readonly string[] = [],
): string | null {
    const overrides = wordingOverrides(wording, tags);
    const garments: NamedGarment[] = [];
    for (const item of tags) {
        const garment = garmentOfTag(item.tag, overrides);
        if (garment && !garments.some((known) => known.noun.word === garment.noun.word)) garments.push(garment);
    }
    if (!garments.length) {
        // «в дорожной одежде»: clothes named only by what they are for.
        const words = tags.flatMap((item) => item.tag.split(' '));
        const found = words.map((word) => EN_ADJECTIVES[word]).find((item) => item && item.rank !== 'cut');
        if (!found) return null;
        garments.push({ noun: EN_NOUNS.clothes as Noun, adjectives: [found] });
    }
    const main = garments.filter((item) => !item.noun.minor);
    const pool = main.length ? main : garments;
    const first = pool[0] as NamedGarment;
    const second = pool[1] ?? (main.length ? garments.find((item) => item.noun.minor) : undefined);
    const used = new Set(taken.map((name) => name.trim().toLowerCase()));
    const candidates: string[] = [];
    const rank = bestRank(first);
    if (pool.length >= 2 && second) candidates.push(`${first.noun.word} и ${second.noun.word}`);
    else if (rank) {
        candidates.push(phrase(first, [rank]));
        // Taken already: two adjectives («красное шёлковое платье»), then with the other garment.
        const colour = rank !== 'colour' && first.adjectives.some((item) => item.rank === 'colour');
        if (colour) candidates.push(phrase(first, ['colour', rank]));
        if (second) candidates.push(`${phrase(first, [rank])} и ${second.noun.word}`);
    } else if (second) candidates.push(`${first.noun.word} и ${second.noun.word}`);
    else candidates.push(first.noun.word);
    const fitted = candidates.map((item) => capital(item).slice(0, MAX_NAME_CHARS).trim());
    for (const name of fitted) if (!used.has(name.toLowerCase())) return name;
    const base = fitted[0] as string;
    for (let index = 2; ; index++) {
        const name = `${base} ${index}`;
        if (!used.has(name.toLowerCase())) return name;
    }
}

/** A name for a new outfit in the UI language: Russian as above, English as before (wardrobe-tags outfitName). */
export function newOutfitName(
    locale: NameLocale,
    tags: readonly OutfitTag[],
    wording: string,
    taken: readonly string[],
): string {
    if (locale === 'ru') {
        const name = russianOutfitName(tags, wording, taken);
        if (name) return name;
    }
    return outfitName(tags, taken);
}

/* ------------------------------------------------------------------ built-in outfits */

const UNDRESS_NAMES: Readonly<Record<NameLocale, Readonly<Record<string, string>>>> = {
    ru: { naked: 'Без одежды', towel: 'В полотенце', underwear: 'Нижнее бельё' },
    en: { naked: 'No clothes', towel: 'In a towel', underwear: 'Underwear' },
};

/**
 * NAI tags of the undress outfits. «nude» is in NAI Studio's explicit-scene words: with its «allow NSFW» on such a
 * picture is an explicit scene, otherwise NovelAI's undesired-content preset keeps it modest; no anatomy is written
 * (that stays in the passport's NSFW layer, NAI Studio's guard).
 */
export const UNDRESS_TAGS: Readonly<Record<string, string>> = {
    naked: 'nude',
    towel: 'naked towel, towel',
    underwear: 'underwear only, underwear',
};

const OWN_CLOTHES: Readonly<Record<NameLocale, string>> = { ru: 'Своя одежда', en: 'Own clothes' };

/** The name of an undress outfit in the UI language. */
export function undressOutfitName(kind: UndressKind, locale: NameLocale): string {
    return UNDRESS_NAMES[locale][kind] ?? UNDRESS_NAMES.en[kind] ?? kind;
}

const lower = (text: string) => text.trim().toLowerCase().replace(/ё/g, 'е');

/** Which undress outfit a passport outfit is (by its name in either language); null for any other. */
export function undressOfOutfit(name: string): UndressKind | null {
    const key = lower(name);
    if (!key) return null;
    for (const names of Object.values(UNDRESS_NAMES)) {
        for (const [kind, value] of Object.entries(names)) if (lower(value) === key) return kind as UndressKind;
    }
    return null;
}

/** The name of the clothing slot's stand-in outfit (it carries the tracker wordings of the own clothes). */
export function ownClothesName(locale: NameLocale): string {
    return OWN_CLOTHES[locale];
}

/** True for the clothing slot's stand-in outfit in either language. */
export function isOwnClothes(name: string): boolean {
    const key = lower(name);
    return !!key && Object.values(OWN_CLOTHES).some((value) => lower(value) === key);
}
