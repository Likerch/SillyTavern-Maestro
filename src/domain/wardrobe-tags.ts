// Outfit wording → NAI tags (plan M27 п.1, §2.1; research/qvink-nai-studio.md §B5–B6): DES writes what a character
// wears in free text, Russian or English, a little differently every turn, while NAI Studio wants English Danbooru tags
// in lower case, comma-separated, without explicit anatomy (that belongs only to the passport's NSFW layer). A small
// built-in dictionary turns common Russian garments, colours, materials and cuts into English; English words pass
// through. The same vocabulary gives the «concepts» outfits are compared by (wardrobe-match.ts). No AI. Pure.

export type TermKind = 'garment' | 'accessory' | 'colour' | 'shade' | 'material' | 'modifier' | 'other' | 'skip';

export interface Term {
    /** English output (may be several words); '' for 'skip'. */
    en: string;
    kind: TermKind;
}

/** One output tag; `garment` when it names something worn (names are made from those first). */
export interface OutfitTag {
    tag: string;
    garment: boolean;
}

/** Concepts of a wording: canonical English stems (synonyms folded), garments and colours apart. */
export interface OutfitConcepts {
    all: Set<string>;
    garments: Set<string>;
    colours: Set<string>;
}

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const MAX_TAGS = 12;
const MAX_TAG_WORDS = 6;
const MAX_NAME_CHARS = 40;

/* ------------------------------------------------------------------ Russian dictionary */

// Prefix of a normalised word (lower case, ё → е) → English; `=form` matches that exact word only. The longest prefix
// wins, so a longer entry with kind 'skip' blocks a shorter one («синяк» is not «синий», «серьги» are not «серый»).
// prettier-ignore
const RU_TABLE: readonly (readonly [string, string, TermKind])[] = [
    // garments
    ['плать', 'dress', 'garment'], ['сарафан', 'sundress', 'garment'], ['юбк', 'skirt', 'garment'],
    ['юбоч', 'skirt', 'garment'], ['=юбок', 'skirt', 'garment'], ['брюк', 'pants', 'garment'],
    ['брюч', 'pants', 'garment'], ['штан', 'pants', 'garment'], ['джинс', 'jeans', 'garment'],
    ['шорт', 'shorts', 'garment'], ['леггинс', 'leggings', 'garment'], ['лосин', 'leggings', 'garment'],
    ['рубаш', 'shirt', 'garment'], ['рубах', 'shirt', 'garment'], ['сорочк', 'shirt', 'garment'],
    ['блуз', 'blouse', 'garment'], ['футбол', 't-shirt', 'garment'], ['майк', 'tank top', 'garment'],
    ['=маек', 'tank top', 'garment'], ['топик', 'crop top', 'garment'], ['=топ', 'crop top', 'garment'],
    ['свитер', 'sweater', 'garment'], ['свитш', 'sweatshirt', 'garment'], ['кофт', 'cardigan', 'garment'],
    ['толстовк', 'hoodie', 'garment'], ['=худи', 'hoodie', 'garment'], ['водолазк', 'turtleneck', 'garment'],
    ['жилет', 'vest', 'garment'], ['пиджак', 'blazer', 'garment'], ['жакет', 'jacket', 'garment'],
    ['куртк', 'jacket', 'garment'], ['курточ', 'jacket', 'garment'], ['=курток', 'jacket', 'garment'],
    ['ветровк', 'windbreaker', 'garment'], ['пуховик', 'down jacket', 'garment'], ['пальт', 'coat', 'garment'],
    ['шинел', 'greatcoat', 'garment'], ['тренч', 'trench coat', 'garment'], ['шуб', 'fur coat', 'garment'],
    ['полушуб', 'fur coat', 'garment'], ['дублен', 'sheepskin coat', 'garment'], ['плащ', 'cloak', 'garment'],
    ['манти', 'robe', 'garment'], ['накидк', 'cape', 'garment'], ['=накидок', 'cape', 'garment'],
    ['пончо', 'poncho', 'garment'], ['халат', 'robe', 'garment'], ['кимоно', 'kimono', 'garment'],
    ['юкат', 'yukata', 'garment'], ['туник', 'tunic', 'garment'], ['ряс', 'cassock', 'garment'],
    ['сутан', 'cassock', 'garment'], ['камзол', 'doublet', 'garment'], ['кафтан', 'kaftan', 'garment'],
    ['сюртук', 'frock coat', 'garment'], ['фрак', 'tailcoat', 'garment'], ['смокинг', 'tuxedo', 'garment'],
    ['костюм', 'suit', 'garment'], ['корсет', 'corset', 'garment'], ['корсаж', 'bodice', 'garment'],
    ['=лиф', 'bodice', 'garment'], ['фартук', 'apron', 'garment'], ['передник', 'apron', 'garment'],
    ['униформ', 'uniform', 'garment'], ['мундир', 'military uniform', 'garment'], ['=форма', 'uniform', 'garment'],
    ['=форме', 'uniform', 'garment'], ['=форму', 'uniform', 'garment'], ['=формой', 'uniform', 'garment'],
    ['=формы', 'uniform', 'garment'], ['комбинезон', 'jumpsuit', 'garment'], ['пижам', 'pajamas', 'garment'],
    ['неглиже', 'negligee', 'garment'], ['пеньюар', 'negligee', 'garment'], ['бель', 'underwear', 'garment'],
    ['трус', 'panties', 'garment'], ['бюстгальтер', 'bra', 'garment'], ['лифчик', 'bra', 'garment'],
    ['купальник', 'swimsuit', 'garment'], ['бикини', 'bikini', 'garment'], ['чулк', 'stockings', 'garment'],
    ['=чулок', 'stockings', 'garment'], ['колготк', 'pantyhose', 'garment'], ['=колготок', 'pantyhose', 'garment'],
    ['носк', 'socks', 'garment'], ['=носок', 'socks', 'garment'], ['носоч', 'socks', 'garment'],
    ['гетр', 'leg warmers', 'garment'],
    // armour
    ['доспех', 'armor', 'garment'], ['=латы', 'plate armor', 'garment'], ['=латах', 'plate armor', 'garment'],
    ['=латами', 'plate armor', 'garment'], ['кольчуг', 'chainmail', 'garment'], ['кирас', 'breastplate', 'garment'],
    ['нагрудник', 'breastplate', 'garment'], ['шлем', 'helmet', 'garment'], ['наруч', 'bracers', 'garment'],
    ['понож', 'greaves', 'garment'], ['щит', 'shield', 'accessory'],
    // footwear
    ['сапог', 'boots', 'garment'], ['сапож', 'boots', 'garment'], ['ботинк', 'boots', 'garment'],
    ['=ботинок', 'boots', 'garment'], ['ботфорт', 'thigh boots', 'garment'], ['туфл', 'shoes', 'garment'],
    ['туфел', 'shoes', 'garment'], ['башмак', 'shoes', 'garment'], ['кроссов', 'sneakers', 'garment'],
    ['=кеды', 'sneakers', 'garment'], ['=кедах', 'sneakers', 'garment'], ['=кедами', 'sneakers', 'garment'],
    ['сандал', 'sandals', 'garment'], ['босонож', 'sandals', 'garment'], ['тапк', 'slippers', 'garment'],
    ['тапоч', 'slippers', 'garment'], ['=тапок', 'slippers', 'garment'], ['мокасин', 'moccasins', 'garment'],
    ['каблук', 'high heels', 'garment'], ['каблуч', 'high heels', 'garment'], ['шпильк', 'high heels', 'garment'],
    // head, neck, hands
    ['шляп', 'hat', 'garment'], ['кепк', 'cap', 'garment'], ['берет', 'beret', 'garment'], ['шапк', 'hat', 'garment'],
    ['шапоч', 'hat', 'garment'], ['капюшон', 'hood', 'garment'], ['венк', 'head wreath', 'accessory'],
    ['=венок', 'head wreath', 'accessory'], ['корон', 'crown', 'accessory'], ['диадем', 'tiara', 'accessory'],
    ['тиар', 'tiara', 'accessory'], ['вуал', 'veil', 'garment'], ['=фата', 'veil', 'garment'],
    ['=фате', 'veil', 'garment'], ['=фату', 'veil', 'garment'], ['=фатой', 'veil', 'garment'],
    ['бандан', 'bandana', 'garment'], ['тюрбан', 'turban', 'garment'], ['чепец', 'bonnet', 'garment'],
    ['чепч', 'bonnet', 'garment'], ['ободок', 'hairband', 'accessory'], ['ободк', 'hairband', 'accessory'],
    ['шарф', 'scarf', 'garment'], ['платок', 'headscarf', 'garment'], ['платк', 'headscarf', 'garment'],
    ['=шаль', 'shawl', 'garment'], ['=шали', 'shawl', 'garment'], ['=шалью', 'shawl', 'garment'],
    ['галстук', 'necktie', 'accessory'], ['бабочк', 'bow tie', 'accessory'], ['бант', 'bow', 'accessory'],
    ['лент', 'ribbon', 'accessory'], ['перчат', 'gloves', 'garment'], ['варежк', 'mittens', 'garment'],
    ['рукавиц', 'mittens', 'garment'], ['пояс', 'belt', 'accessory'], ['поясниц', '', 'skip'],
    ['ремен', 'belt', 'accessory'], ['ремн', 'belt', 'accessory'], ['кушак', 'sash', 'accessory'],
    // jewellery and things carried
    ['ожерель', 'necklace', 'accessory'], ['колье', 'necklace', 'accessory'], ['бус', 'bead necklace', 'accessory'],
    ['кулон', 'pendant', 'accessory'], ['медальон', 'locket', 'accessory'], ['цепочк', 'chain necklace', 'accessory'],
    ['серьг', 'earrings', 'accessory'], ['=серег', 'earrings', 'accessory'], ['сереж', 'earrings', 'accessory'],
    ['браслет', 'bracelet', 'accessory'], ['кольц', 'ring', 'accessory'], ['перстен', 'ring', 'accessory'],
    ['перстн', 'ring', 'accessory'], ['брош', 'brooch', 'accessory'], ['заколк', 'hair clip', 'accessory'],
    ['очк', 'glasses', 'accessory'], ['пенсне', 'glasses', 'accessory'], ['маск', 'mask', 'accessory'],
    ['монокл', 'monocle', 'accessory'], ['сумк', 'bag', 'accessory'], ['сумочк', 'handbag', 'accessory'],
    ['рюкзак', 'backpack', 'accessory'], ['=босиком', 'barefoot', 'accessory'], ['=босая', 'barefoot', 'accessory'],
    ['=босой', 'barefoot', 'accessory'], ['=босые', 'barefoot', 'accessory'],
    // colours and shades
    ['бел', 'white', 'colour'], ['белоснеж', 'white', 'colour'], ['черн', 'black', 'colour'],
    ['красн', 'red', 'colour'], ['=алый', 'red', 'colour'], ['=алая', 'red', 'colour'], ['=алое', 'red', 'colour'],
    ['=алые', 'red', 'colour'], ['=алого', 'red', 'colour'], ['=алой', 'red', 'colour'], ['=алым', 'red', 'colour'],
    ['=алую', 'red', 'colour'], ['=алыми', 'red', 'colour'], ['багров', 'crimson', 'colour'],
    ['багрян', 'crimson', 'colour'], ['малинов', 'crimson', 'colour'], ['бордов', 'burgundy', 'colour'],
    ['вишнев', 'burgundy', 'colour'], ['винн', 'burgundy', 'colour'], ['рубинов', 'red', 'colour'],
    ['син', 'blue', 'colour'], ['синяк', '', 'skip'], ['синтет', '', 'skip'], ['голуб', 'light blue', 'colour'],
    ['лазур', 'azure', 'colour'], ['бирюз', 'turquoise', 'colour'], ['зелен', 'green', 'colour'],
    ['изумруд', 'emerald', 'colour'], ['оливк', 'olive', 'colour'], ['оливков', 'olive', 'colour'],
    ['салатов', 'light green', 'colour'], ['желт', 'yellow', 'colour'], ['золот', 'gold', 'colour'],
    ['золоч', 'gold', 'colour'], ['оранжев', 'orange', 'colour'], ['фиолетов', 'purple', 'colour'],
    ['лилов', 'purple', 'colour'], ['сиренев', 'lilac', 'colour'], ['пурпур', 'purple', 'colour'],
    ['розов', 'pink', 'colour'], ['сер', 'grey', 'colour'], ['серд', '', 'skip'], ['серьез', '', 'skip'],
    ['серен', '', 'skip'], ['серп', '', 'skip'], ['серебр', 'silver', 'colour'], ['коричнев', 'brown', 'colour'],
    ['шоколадн', 'brown', 'colour'], ['кофейн', 'brown', 'colour'], ['бежев', 'beige', 'colour'],
    ['кремов', 'cream', 'colour'], ['песочн', 'beige', 'colour'], ['хаки', 'khaki', 'colour'],
    ['разноцвет', 'multicolored', 'colour'], ['радужн', 'rainbow', 'colour'], ['темн', 'dark', 'shade'],
    ['темниц', '', 'skip'], ['светл', 'light', 'shade'], ['бледн', 'pale', 'shade'], ['ярк', 'bright', 'shade'],
    // materials
    ['кожан', 'leather', 'material'], ['кожзам', 'faux leather', 'material'], ['замш', 'suede', 'material'],
    ['шелк', 'silk', 'material'], ['атлас', 'satin', 'material'], ['бархат', 'velvet', 'material'],
    ['парч', 'brocade', 'material'], ['хлопк', 'cotton', 'material'], ['хлопчат', 'cotton', 'material'],
    ['льн', 'linen', 'material'], ['=лен', 'linen', 'material'], ['шерст', 'wool', 'material'],
    ['вязан', 'knitted', 'material'], ['трикотаж', 'knitted', 'material'], ['кружев', 'lace', 'material'],
    ['ажурн', 'lace', 'material'], ['джинсов', 'denim', 'material'], ['твид', 'tweed', 'material'],
    ['фланел', 'flannel', 'material'], ['мехов', 'fur', 'material'], ['=мех', 'fur', 'material'],
    ['=меха', 'fur', 'material'], ['=мехом', 'fur', 'material'], ['=меху', 'fur', 'material'],
    ['латекс', 'latex', 'material'], ['стальн', 'steel', 'material'], ['железн', 'iron', 'material'],
    ['латн', 'plate', 'material'], ['кольчуж', 'chainmail', 'material'], ['шифон', 'chiffon', 'material'],
    ['органз', 'organza', 'material'], ['тюл', 'tulle', 'material'], ['тюлен', '', 'skip'],
    ['сетчат', 'mesh', 'material'], ['сеточ', 'mesh', 'material'], ['холщ', 'canvas', 'material'],
    ['=холст', 'canvas', 'material'], ['брезент', 'canvas', 'material'], ['мешковин', 'burlap', 'material'],
    ['ситц', 'cotton', 'material'], ['батист', 'cotton', 'material'], ['кашемир', 'cashmere', 'material'],
    ['войлок', 'felt', 'material'], ['войлоч', 'felt', 'material'], ['соломен', 'straw', 'material'],
    ['деревян', 'wooden', 'material'],
    // cuts, wear and purpose
    ['рван', 'torn', 'modifier'], ['порван', 'torn', 'modifier'], ['изорван', 'torn', 'modifier'],
    ['разорван', 'torn', 'modifier'], ['дран', 'torn', 'modifier'], ['потерт', 'worn', 'modifier'],
    ['потрепан', 'worn', 'modifier'], ['поношен', 'worn', 'modifier'], ['заношен', 'worn', 'modifier'],
    ['ветх', 'worn', 'modifier'], ['заплат', 'patched', 'modifier'], ['длинн', 'long', 'modifier'],
    ['коротк', 'short', 'modifier'], ['облегающ', 'tight', 'modifier'], ['обтягивающ', 'tight', 'modifier'],
    ['свободн', 'loose', 'modifier'], ['просторн', 'loose', 'modifier'], ['мешковат', 'baggy', 'modifier'],
    ['полосат', 'striped', 'modifier'], ['клетчат', 'plaid', 'modifier'], ['цветочн', 'floral', 'modifier'],
    ['расстегнут', 'unbuttoned', 'modifier'], ['вечерн', 'evening', 'modifier'], ['свадебн', 'wedding', 'modifier'],
    ['бальн', 'ball', 'modifier'], ['военн', 'military', 'modifier'], ['школьн', 'school', 'modifier'],
    ['спортивн', 'sports', 'modifier'], ['дорожн', 'travel', 'modifier'], ['походн', 'travel', 'modifier'],
    ['охотнич', 'hunting', 'modifier'], ['парадн', 'formal', 'modifier'], ['официальн', 'formal', 'modifier'],
    ['делов', 'business', 'modifier'], ['праздничн', 'festive', 'modifier'], ['нарядн', 'fancy', 'modifier'],
    ['прозрачн', 'see-through', 'modifier'], ['полупрозрачн', 'sheer', 'modifier'], ['вышит', 'embroidered', 'modifier'],
    ['расшит', 'embroidered', 'modifier'], ['шипован', 'studded', 'modifier'], ['плиссир', 'pleated', 'modifier'],
    ['пышн', 'puffy', 'modifier'], ['оборк', 'frilled', 'modifier'], ['королевск', 'royal', 'modifier'],
    ['крестьянск', 'peasant', 'modifier'], ['повседневн', 'casual', 'modifier'], ['домашн', 'casual', 'modifier'],
    ['пляжн', 'beach', 'modifier'], ['зимн', 'winter', 'modifier'], ['летн', 'summer', 'modifier'],
    ['камуфляж', 'camouflage', 'modifier'],
    // states and generic words are not outfit terms (states have their own rules)
    ['ночн', '', 'skip'], ['мокр', '', 'skip'], ['грязн', '', 'skip'], ['кровав', '', 'skip'],
    ['окровавлен', '', 'skip'], ['одежд', '', 'skip'], ['наряд', '', 'skip'],
];

const RU_EXACT = new Map<string, Term>();
const RU_PREFIXES: { prefix: string; term: Term }[] = [];
for (const [key, en, kind] of RU_TABLE) {
    if (key.startsWith('=')) RU_EXACT.set(key.slice(1), { en, kind });
    else RU_PREFIXES.push({ prefix: key, term: { en, kind } });
}
RU_PREFIXES.sort((a, b) => b.prefix.length - a.prefix.length);

/* ------------------------------------------------------------------ English vocabulary */

interface EnEntry {
    kind: TermKind;
    /** Canonical concept (synonyms fold into one). */
    concept?: string;
    /** Spelling used in tags (gray → grey, armour → armor). */
    tag?: string;
}

// prettier-ignore
const EN_GARMENTS = [
    'dress', 'sundress', 'skirt', 'shirt', 'blouse', 't-shirt', 'top', 'sweater', 'sweatshirt', 'cardigan', 'hoodie',
    'turtleneck', 'vest', 'jacket', 'windbreaker', 'blazer', 'coat', 'greatcoat', 'trenchcoat', 'cloak', 'robe',
    'poncho', 'kimono', 'yukata', 'tunic', 'cassock', 'doublet', 'kaftan', 'tailcoat', 'tuxedo', 'suit', 'corset',
    'bodice', 'apron', 'uniform', 'armor', 'chainmail', 'breastplate', 'helmet', 'bracers', 'greaves', 'gauntlets',
    'pauldrons', 'pants', 'jeans', 'shorts', 'leggings', 'jumpsuit', 'boots', 'shoes', 'sneakers', 'sandals',
    'slippers', 'moccasins', 'heels', 'stockings', 'pantyhose', 'socks', 'gloves', 'mittens', 'hat', 'cap', 'beret',
    'hood', 'beanie', 'veil', 'bandana', 'turban', 'bonnet', 'scarf', 'shawl', 'headscarf', 'underwear', 'panties',
    'bra', 'lingerie', 'swimsuit', 'bikini', 'pajamas', 'nightgown', 'negligee', 'leotard', 'bodysuit', 'kilt', 'sari',
    'hakama', 'toga', 'loincloth', 'gown', 'overalls', 'overcoat', 'cape', 'mantle', 'robes', 'trousers', 'slacks',
    'jumper', 'pullover', 'waistcoat', 'armour', 'tights', 'thighhighs', 'pumps', 'tee', 'tshirt', 'pyjamas', 'frock',
    'boot', 'shoe', 'raincoat', 'parka', 'overshirt', 'camisole', 'chemise', 'petticoat', 'breeches', 'tabard',
    'boxers', 'briefs', 'undergarments',
];
// prettier-ignore
const EN_ACCESSORIES = [
    'necklace', 'pendant', 'locket', 'choker', 'earrings', 'bracelet', 'ring', 'brooch', 'glasses', 'spectacles',
    'mask', 'bag', 'handbag', 'backpack', 'ribbon', 'bow', 'belt', 'sash', 'necktie', 'tie', 'bowtie', 'crown',
    'tiara', 'circlet', 'wreath', 'hairband', 'headband', 'barefoot', 'monocle', 'shield', 'satchel', 'pouch',
];
// prettier-ignore
const EN_COLOURS = [
    'white', 'black', 'red', 'crimson', 'scarlet', 'maroon', 'burgundy', 'blue', 'navy', 'azure', 'cyan', 'aqua',
    'teal', 'turquoise', 'green', 'emerald', 'olive', 'yellow', 'gold', 'golden', 'orange', 'purple', 'violet',
    'lavender', 'lilac', 'pink', 'magenta', 'grey', 'gray', 'silver', 'brown', 'beige', 'tan', 'khaki', 'cream',
    'ivory', 'multicolored', 'rainbow',
];
const EN_SHADES = ['dark', 'light', 'pale', 'bright', 'deep'];
// prettier-ignore
const EN_MATERIALS = [
    'leather', 'suede', 'silk', 'silken', 'satin', 'velvet', 'brocade', 'cotton', 'linen', 'wool', 'woolen',
    'woollen', 'knitted', 'knit', 'lace', 'lacy', 'denim', 'tweed', 'flannel', 'fur', 'furry', 'latex', 'steel',
    'iron', 'chiffon', 'organza', 'tulle', 'mesh', 'fishnet', 'canvas', 'burlap', 'plate', 'cashmere', 'felt',
    'straw', 'wooden', 'metal',
];
// prettier-ignore
const EN_MODIFIERS = [
    'torn', 'ripped', 'tattered', 'ragged', 'worn', 'shabby', 'threadbare', 'patched', 'long', 'short', 'tight',
    'fitted', 'loose', 'baggy', 'oversized', 'striped', 'plaid', 'checkered', 'floral', 'unbuttoned', 'evening',
    'wedding', 'ball', 'military', 'school', 'sports', 'athletic', 'travel', 'traveling', 'travelling', 'hunting',
    'formal', 'business', 'festive', 'fancy', 'casual', 'see-through', 'sheer', 'transparent', 'sleeveless',
    'off-shoulder', 'long-sleeved', 'short-sleeved', 'floor-length', 'hooded', 'embroidered', 'studded', 'pleated',
    'puffy', 'frilled', 'frilly', 'ruffled', 'cropped', 'low-cut', 'royal', 'peasant', 'beach', 'winter', 'summer',
    'camouflage', 'polka-dot', 'high', 'knee-high', 'thigh-high', 'tank', 'crop', 'down', 'faux', 'trench',
];

/** Folded synonyms: the concept outfits are compared by. */
const EN_SYNONYMS: Readonly<Record<string, string>> = {
    gown: 'dress',
    frock: 'dress',
    trousers: 'pants',
    slacks: 'pants',
    jumper: 'sweater',
    pullover: 'sweater',
    waistcoat: 'vest',
    overcoat: 'coat',
    raincoat: 'coat',
    parka: 'coat',
    cape: 'cloak',
    mantle: 'cloak',
    robes: 'robe',
    armour: 'armor',
    tights: 'pantyhose',
    thighhighs: 'stockings',
    pumps: 'heels',
    tee: 't-shirt',
    tshirt: 't-shirt',
    pyjamas: 'pajamas',
    boot: 'boots',
    shoe: 'shoes',
    spectacles: 'glasses',
    tie: 'necktie',
    bowtie: 'necktie',
    headband: 'hairband',
    circlet: 'tiara',
    crimson: 'red',
    scarlet: 'red',
    maroon: 'red',
    burgundy: 'red',
    navy: 'blue',
    azure: 'blue',
    turquoise: 'aqua',
    emerald: 'green',
    golden: 'gold',
    violet: 'purple',
    lavender: 'purple',
    lilac: 'purple',
    magenta: 'pink',
    gray: 'grey',
    ivory: 'white',
    cream: 'white',
    silken: 'silk',
    woolen: 'wool',
    woollen: 'wool',
    knit: 'knitted',
    lacy: 'lace',
    furry: 'fur',
    ripped: 'torn',
    tattered: 'torn',
    ragged: 'torn',
    shabby: 'worn',
    threadbare: 'worn',
    fitted: 'tight',
    baggy: 'loose',
    oversized: 'loose',
    checkered: 'plaid',
    sheer: 'see-through',
    transparent: 'see-through',
    frilly: 'frilled',
    ruffled: 'frilled',
    athletic: 'sports',
    traveling: 'travel',
    travelling: 'travel',
};

/** Spellings normalised in tags. */
const EN_TAG_SPELLING: Readonly<Record<string, string>> = {
    gray: 'grey',
    armour: 'armor',
    colour: 'color',
    colours: 'colors',
    pyjamas: 'pajamas',
    woollen: 'woolen',
    travelling: 'traveling',
};

// Words that carry nothing in an outfit wording (articles, pronouns, links, verbs of wearing, praise).
// prettier-ignore
const EN_STOP = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'over', 'under', 'with', 'without', 'by', 'for',
    'from', 'into', 'onto', 'up', 'out', 'her', 'his', 'its', 'their', 'my', 'your', 'our', 'hers', 'him', 'she', 'he',
    'they', 'them', 'it', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has',
    'have', 'had', 'wears', 'wear', 'wearing', 'wore', 'dressed', 'clad', 'dons', 'donned', 'now', 'currently',
    'still', 'also', 'just', 'only', 'very', 'slightly', 'quite', 'rather', 'somewhat', 'some', 'pair', 'pairs', 'set',
    'piece', 'outfit', 'outfits', 'clothes', 'clothing', 'attire', 'garb', 'apparel', 'garments', 'garment',
    'ensemble', 'look', 'simple', 'plain', 'nice', 'beautiful', 'pretty', 'elegant', 'favorite', 'favourite', 'usual',
    'typical', 'new', 'own', 'matching', 'which', 'who', 'while', 'kind', 'sort', 'style', 'styled', 'type', 'made',
    'like', 'looks', 'appears', 'seems', 'one', 'two', 'both', 'each', 'several', 'few', 'its', 'as', 'none', 'nothing',
    'changed', 'changes', 'put', 'puts', 'putting', 'got', 'gets', 'getting', 'covered', 'around', 'across',
]);

const EN_VOCAB = new Map<string, EnEntry>();
const addEn = (words: readonly string[], kind: TermKind) => {
    for (const word of words) {
        const entry: EnEntry = { kind };
        if (EN_SYNONYMS[word]) entry.concept = EN_SYNONYMS[word];
        if (EN_TAG_SPELLING[word]) entry.tag = EN_TAG_SPELLING[word];
        EN_VOCAB.set(word, entry);
    }
};
addEn(EN_GARMENTS, 'garment');
addEn(EN_ACCESSORIES, 'accessory');
addEn(EN_COLOURS, 'colour');
addEn(EN_SHADES, 'shade');
addEn(EN_MATERIALS, 'material');
addEn(EN_MODIFIERS, 'modifier');

/* ------------------------------------------------------------------ anatomy */

/**
 * Explicit anatomy (NAI Studio's list, N:domain/passport.ts EXPLICIT_ANATOMY, plus a few close words): it belongs only
 * to the NSFW layer of a passport, never to an outfit or a state.
 */
const ANATOMY_RE =
    /(^|[^a-z])(futanari|futa|dickgirl|penis|testicles?|erection|flaccid|foreskin|pussy|vagina|clitoris|nipples?|areolae?|pubic hair|breasts?|genitals?|anus|cameltoe|groin)([^a-z]|$)/i;

export function isAnatomyTag(tag: string): boolean {
    return ANATOMY_RE.test(tag);
}

/* ------------------------------------------------------------------ words */

function normalize(text: string): string {
    return String(text ?? '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Words of a phrase: letters, digits, inner hyphens and apostrophes; Cyrillic hyphenated words split («темно-синий»). */
function phraseWords(phrase: string): string[] {
    const out: string[] = [];
    for (const raw of phrase.split(/[^\p{L}\p{N}'-]+/u)) {
        const word = raw.replace(/^['-]+|['-]+$/g, '');
        if (!word) continue;
        if (CYRILLIC_RE.test(word)) out.push(...word.split(/[-']+/).filter(Boolean));
        else out.push(word);
    }
    return out;
}

/** A Russian word through the dictionary; null when unknown. */
export function lookupRu(word: string): Term | null {
    const value = normalize(word);
    if (!value) return null;
    const exact = RU_EXACT.get(value);
    if (exact) return exact;
    for (const { prefix, term } of RU_PREFIXES) if (value.startsWith(prefix)) return term;
    return null;
}

/** The dictionary key a Russian word matched (`=form` for an exact form); null when unknown. */
export function ruTermKey(word: string): string | null {
    const value = normalize(word);
    if (!value) return null;
    if (RU_EXACT.has(value)) return `=${value}`;
    for (const { prefix } of RU_PREFIXES) if (value.startsWith(prefix)) return prefix;
    return null;
}

function enEntry(word: string): EnEntry | undefined {
    const direct = EN_VOCAB.get(word);
    if (direct) return direct;
    if (word.length > 3 && word.endsWith('es')) {
        const stem = EN_VOCAB.get(word.slice(0, -2));
        if (stem) return stem;
    }
    if (word.length > 3 && word.endsWith('s')) return EN_VOCAB.get(word.slice(0, -1));
    return undefined;
}

/** An English word: its kind ('other' when unknown), null for filler words. */
export function lookupEn(word: string): Term | null {
    const value = normalize(word);
    if (!value || EN_STOP.has(value) || !LATIN_RE.test(value)) return null;
    if (/^\d+$/.test(value)) return null;
    const entry = enEntry(value);
    return { en: entry?.tag ?? EN_TAG_SPELLING[value] ?? value, kind: entry?.kind ?? 'other' };
}

/** Any word: Russian through the dictionary, English kept; null for unknown Russian, filler and junk. */
export function termOf(word: string): Term | null {
    if (CYRILLIC_RE.test(word)) {
        const term = lookupRu(word);
        return term && term.kind !== 'skip' ? term : null;
    }
    return lookupEn(word);
}

/* ------------------------------------------------------------------ phrases */

// Russian idioms of cut and fit, replaced before the split (they span words or carry a preposition the split eats).
const IDIOMS: readonly (readonly [RegExp, string])[] = [
    [/без\s+рукав\p{L}*/gu, ' sleeveless '],
    [/с\s+открыт\p{L}*\s+плеч\p{L}*/gu, ' off-shoulder '],
    [/с\s+длинн\p{L}*\s+рукав\p{L}*/gu, ' long-sleeved '],
    [/с\s+коротк\p{L}*\s+рукав\p{L}*/gu, ' short-sleeved '],
    [/ночн\p{L}*\s+(?:сорочк|рубашк|рубах)\p{L}*/gu, ' nightgown '],
    [/(?<!\p{L})в\s+пол(?!\p{L})/gu, ' floor-length '],
    [/(?<!\p{L})на\s+(?:каблук|шпильк)\p{L}*/gu, ' high heels '],
    [/(?<!\p{L})в\s+горошек(?!\p{L})/gu, ' polka-dot '],
    [/(?<!\p{L})в\s+клетк\p{L}*/gu, ' plaid '],
    [/(?<!\p{L})в\s+полоск\p{L}*/gu, ' striped '],
    [/(?<!\p{L})с\s+капюшон\p{L}*/gu, ' hooded '],
];

const PHRASE_SPLIT_RE =
    /[,;:.!?\n()[\]{}«»"“”„/|•·—–+&]+|\s-\s|(?<!\p{L})(?:и|а|а также|плюс|поверх|под|над|с|со|and|with|plus|over|under|beneath|underneath|atop|also|then)(?!\p{L})/u;

/** Outfit wording split into phrases (one garment each, usually). */
export function outfitPhrases(text: string): string[] {
    let value = normalize(text);
    for (const [pattern, replacement] of IDIOMS) value = value.replace(pattern, replacement);
    return value
        .split(new RegExp(PHRASE_SPLIT_RE.source, 'gu'))
        .map((part) => part.trim())
        .filter(Boolean);
}

const KIND_RANK: Partial<Record<TermKind, number>> = { modifier: 0, other: 0, shade: 1, colour: 1, material: 2 };
/** Purpose words stand right before the garment in English («red silk evening gown», «black school uniform»). */
const PURPOSE = new Set([
    'evening',
    'wedding',
    'ball',
    'military',
    'school',
    'sports',
    'travel',
    'hunting',
    'formal',
    'business',
    'festive',
    'casual',
    'beach',
    'winter',
    'summer',
    'royal',
    'peasant',
]);

function rankOf(token: Term): number {
    if (token.kind === 'modifier' && PURPOSE.has(token.en)) return 3;
    return KIND_RANK[token.kind] ?? 0;
}

/** Cut and wear, then colours (shades before their colour, several join with «and»), materials, purpose. */
function orderWords(tokens: readonly Term[]): string[] {
    const ranked = tokens.map((token, index) => ({ token, index, rank: rankOf(token) }));
    ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
    const out: string[] = [];
    // A colour unit is shades followed by a colour; a unit that starts right after a colour joins with «and».
    let afterColour = false;
    for (const { token } of ranked) {
        const tinted = token.kind === 'shade' || token.kind === 'colour';
        if (tinted && afterColour) out.push('and');
        out.push(token.en);
        afterColour = token.kind === 'colour';
    }
    return out;
}

function dedupeWords(words: readonly string[]): string[] {
    const out: string[] = [];
    for (const word of words.flatMap((item) => item.split(' '))) {
        if (!word) continue;
        if (word !== 'and' && out.includes(word)) continue;
        out.push(word);
    }
    while (out[0] === 'and') out.shift();
    while (out[out.length - 1] === 'and') out.pop();
    return out;
}

/** A tag cleaned for NAI: lower case, Latin only, no markup, at most a few words (the garment is at the end). */
function cleanTag(words: readonly string[]): string {
    const list = dedupeWords(words)
        .map((word) => word.toLowerCase().replace(/[^a-z0-9'-]/g, ''))
        .filter(Boolean);
    return list.slice(-MAX_TAG_WORDS).join(' ').trim();
}

const isWorn = (term: Term) => term.kind === 'garment' || term.kind === 'accessory';
const GENERIC_CLOTHES = new Set(['clothes', 'clothing', 'outfit', 'attire', 'garb', 'apparel']);

function phraseTags(phrase: string): OutfitTag[] {
    const words = phraseWords(phrase);
    if (!words.length) return [];
    // English only: the phrase passes through as one tag (the writer's word order is kept).
    if (!words.some((word) => CYRILLIC_RE.test(word))) {
        const terms = words.map(lookupEn).filter((term): term is Term => term !== null);
        // «travel clothes»: the generic word is a filler, but without it only the purpose would be left.
        if (!terms.some(isWorn) && words.some((word) => GENERIC_CLOTHES.has(word))) {
            terms.push({ en: 'clothes', kind: 'garment' });
        }
        if (!terms.length || terms.every((term) => term.kind === 'shade' || term.kind === 'colour')) return [];
        const tag = cleanTag(terms.map((term) => term.en));
        return tag ? [{ tag, garment: terms.some(isWorn) }] : [];
    }
    // Russian or mixed: a tag at every garment, with the words before it; words after the last one join it.
    const tags: { words: string[]; garment: boolean }[] = [];
    let pending: Term[] = [];
    for (const word of words) {
        const term = termOf(word);
        if (!term) continue;
        if (isWorn(term)) {
            tags.push({ words: [...orderWords(pending), term.en], garment: true });
            pending = [];
        } else pending.push(term);
    }
    if (pending.length) {
        const last = tags[tags.length - 1];
        if (last) last.words = [...orderWords(pending), ...last.words];
        else if (pending.some((term) => term.kind === 'other' || term.kind === 'modifier')) {
            tags.push({ words: orderWords(pending), garment: false });
        }
    }
    return tags
        .map((item) => ({ tag: cleanTag(item.words), garment: item.garment }))
        .filter((item) => item.tag.length > 0);
}

/** Values that mean «nothing to say» (DES placeholders, «нет», "none", "N/A"). */
const EMPTY_RE = /^(?:none|nothing|no|n\/a|na|unknown|-+|—|нет|ничего|неизвестно|не указано|отсутствует)\.?$/i;

/** The wording trimmed; null when it says nothing (empty, «нет», a placeholder in braces). */
export function cleanOutfitText(text: unknown): string | null {
    if (typeof text !== 'string') return null;
    const value = text.replace(/\s+/g, ' ').trim();
    if (!value || EMPTY_RE.test(value) || /^\{\{.*\}\}$/.test(value) || /^\[.*\]$/.test(value)) return null;
    return value.length > 600 ? value.slice(0, 600) : value;
}

/** Tags of an outfit wording, in order: lower case, no Cyrillic, no explicit anatomy, no duplicates, capped. */
export function outfitTagList(text: string): OutfitTag[] {
    const seen = new Set<string>();
    const out: OutfitTag[] = [];
    for (const phrase of outfitPhrases(text)) {
        for (const item of phraseTags(phrase)) {
            if (isAnatomyTag(item.tag) || seen.has(item.tag)) continue;
            seen.add(item.tag);
            out.push(item);
            if (out.length >= MAX_TAGS) return out;
        }
    }
    return out;
}

/** Tags of an outfit wording as NAI wants them: "white blouse, black skirt". '' when nothing is recognised. */
export function outfitTags(text: string): string {
    return outfitTagList(text)
        .map((item) => item.tag)
        .join(', ');
}

/** A tag string as stored in a passport, cleaned the same way (lower case, no anatomy, no Cyrillic, no duplicates). */
export function sanitizeTags(tags: string): string {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of String(tags ?? '').split(/[,\n]/)) {
        const tag = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!tag || CYRILLIC_RE.test(tag) || /[<>{}[\]]/.test(tag) || isAnatomyTag(tag) || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
    }
    return out.join(', ');
}

/* ------------------------------------------------------------------ names */

function lastWords(tag: string, count: number): string[] {
    const words = tag.split(' ').filter(Boolean).slice(-count);
    while (words.length > 1 && words[0] === 'and') words.shift();
    return words;
}

/**
 * A short English name for a new outfit from its tags: the first garment (three words at most), and the second
 * garment when both fit in four words («white blouse and black skirt»); unique against `taken` (case-insensitive:
 * «… 2»).
 */
export function outfitName(tags: readonly OutfitTag[], taken: readonly string[] = []): string {
    const garments = tags.filter((item) => item.garment);
    const firstTag = garments[0] ?? tags[0];
    const first = firstTag ? lastWords(firstTag.tag, 3) : [];
    const second = garments[1] ? lastWords(garments[1].tag, 2) : [];
    let words =
        first.length && second.length && first.length + second.length <= 4 ? [...first, 'and', ...second] : first;
    if (!words.length) words = ['outfit'];
    let base = words.join(' ');
    while (base.length > MAX_NAME_CHARS && words.length > 1) {
        words = words.slice(1);
        if (words[0] === 'and') words = words.slice(1);
        base = words.join(' ');
    }
    base = base.slice(0, MAX_NAME_CHARS).trim();
    const used = new Set(taken.map((name) => name.trim().toLowerCase()));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${base} ${n}`;
        if (!used.has(candidate)) return candidate;
    }
}

/* ------------------------------------------------------------------ revision statements */

const REMOVAL_RE =
    /\b(?:took|takes|taking|take)\s+off\b|\b(?:removed|removes|removing|undress(?:ed|es|ing)?|strip(?:ped|s|ping)?)\b|\bno\s+longer\s+wear|(?<!\p{L})(?:снял\p{L}*|разделся|разделась)/iu;
const WEAR_RE =
    /\b(?:(?:is|was|now)\s+)*(?:wears|wearing|wore|worn|dressed\s+(?:up\s+)?(?:in|as)|clad\s+in|chang(?:ed|es|ing)\s+into|switch(?:ed|es)?\s+(?:to|into)|puts?\s+on|putting\s+on|has\s+on|don(?:s|ned)?|in\s+(?:a|an|her|his|their))\b/i;
const OUTFIT_LABEL_RE = /\b(?:outfit|attire|clothes|clothing)\s*(?:is|:|-)\s*/i;
/** Russian: «носит: …», «одета в …», «надел …», «переоделась в …», «одежда: …» (the preparation's starting outfits). */
const RU_WEAR_RE =
    /(?<!\p{L})(?:(?:сейчас|теперь)\s+)?(?:носит|одет[аоы]?(?:\s+в)?|надел[аи]?|переодел(?:ся|ась|ись)(?:\s+в)?|(?:одежда|наряд)(?=\s*[:—-]))(?!\p{L})\s*[:—-]?\s*/iu;
const TAIL_RE = /\s(?:for|to|at|because|while|since|after|before|when|during|so\s+that)\s.*$/i;

/**
 * The outfit wording of a revision statement (M8 'deferred.outfit': «Anna now wears a black leather jacket and torn
 * jeans.»; the preparation's Russian «Вера носит: стёганая куртка»): the part after the verb of wearing, without a
 * trailing purpose or time clause. Null for a removal («took off her armor») or when nothing is left.
 */
export function outfitFromStatement(statement: string): string | null {
    const text = cleanOutfitText(statement);
    if (!text) return null;
    if (REMOVAL_RE.test(text)) return null;
    let rest = text;
    const label = OUTFIT_LABEL_RE.exec(rest);
    const english = WEAR_RE.exec(rest);
    const russian = RU_WEAR_RE.exec(rest);
    const wear = russian && (!english || russian.index < english.index) ? russian : english;
    if (label && (!wear || label.index <= wear.index)) rest = rest.slice(label.index + label[0].length);
    else if (wear) rest = rest.slice(wear.index + wear[0].length);
    rest = rest
        .replace(TAIL_RE, '')
        .replace(/[.!;]+$/, '')
        .trim();
    return cleanOutfitText(rest);
}

/* ------------------------------------------------------------------ concepts */

/** English stem: plural -s/-es dropped (garments and boots compare in any number). */
function enStem(word: string): string {
    if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (word.length > 4 && /(?:ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

function addConcept(out: OutfitConcepts, word: string, kind: TermKind): void {
    const entry = enEntry(word);
    const concept = enStem(entry?.concept ?? EN_SYNONYMS[word] ?? word);
    const effective = entry?.kind ?? kind;
    if (!concept || concept.length < 2 || isAnatomyTag(word)) return;
    out.all.add(concept);
    if (effective === 'garment' || effective === 'accessory') out.garments.add(concept);
    if (effective === 'colour') out.colours.add(concept);
}

/**
 * Concepts of a wording in any language: Russian words through the dictionary (unknown ones are dropped), English
 * words with synonyms folded (gown = dress, trousers = pants, crimson = red) and plurals cut.
 */
export function outfitConcepts(text: string): OutfitConcepts {
    const out: OutfitConcepts = { all: new Set(), garments: new Set(), colours: new Set() };
    for (const phrase of outfitPhrases(text)) {
        for (const word of phraseWords(phrase)) {
            const term = termOf(word);
            if (!term || !term.en) continue;
            // «high heels», «fur coat»: the last word carries the term's kind, the others their own (or none).
            const parts = term.en.split(' ').filter((part) => part && !EN_STOP.has(part));
            parts.forEach((part, index) => addConcept(out, part, index === parts.length - 1 ? term.kind : 'other'));
        }
    }
    return out;
}
