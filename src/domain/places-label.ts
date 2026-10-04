// M24 «Места»: reading the location labels DES writes into `infoBox.location` (research/des.md §7). Models write them
// as free text in either direction: «Room, Building, District, City» (most specific first, English address style),
// «Город — район» or «Особняк Волковых, библиотека» (general first, Russian style), sometimes with a parenthetical
// container («Main Hall (Rusty Anchor)»). This file splits a label into parts, normalises names for matching and
// guesses the direction from a small lexicon of place words and the separators. The registry (places-match.ts) votes
// first when it knows some of the parts. Pure: no DOM, no SillyTavern.

/** How the order of the parts was decided. */
export type LabelOrder = 'single' | 'registry' | 'lexicon' | 'separator';

/** What separated a part from the previous one (the first part has none). */
export type SeparatorKind = 'comma' | 'dash' | 'paren';

export interface SplitLabel {
    /** Parts in written order, trimmed, without empty and repeated ones. */
    parts: string[];
    /** `kinds[i]` separated `parts[i]` from `parts[i - 1]`; `kinds[0]` is always null. */
    kinds: (SeparatorKind | null)[];
}

/** A label longer than this is a description, not a place name. */
export const MAX_LABEL_CHARS = 200;
const MAX_PART_CHARS = 100;

/** Labels that name no place: DES fillers and model hedges. */
const NOISE_RE =
    /^(?:unknown|none|n\/a|na|null|undefined|not specified|unspecified|same|same place|same location|same as before|various|elsewhere|неизвестно|неизвестное место|не указано|нет|то же|то же место|там же|прежнее место|где-то)$/;

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const QUOTES_RE = /[«»"“”„‟]/g;
const APOSTROPHES_RE = /[’‘`´]/g;
const EDGE_PUNCT_RE = /^[\s'.,:;!?()[\]{}\-–—]+|[\s'.,:;!?()[\]{}\-–—]+$/g;
const ARTICLE_RE = /^(?:the|a|an)\s+/;
const WORD_SPLIT_RE = /[^\p{L}\p{N}']+/u;

/**
 * Normalised form of a place name for matching: lower case, ё → е, quotes dropped, whitespace collapsed, edge
 * punctuation and a leading English article removed. «Таверна «Ржавый якорь»» → «таверна ржавый якорь».
 */
export function normalizePlaceName(text: string): string {
    let value = text.normalize('NFC').toLowerCase().replace(/ё/g, 'е');
    value = value.replace(APOSTROPHES_RE, "'").replace(QUOTES_RE, ' ').replace(/\s+/g, ' ').trim();
    value = value.replace(EDGE_PUNCT_RE, '').replace(ARTICLE_RE, '');
    return value.trim();
}

/** Words of a normalised name (letters, digits and apostrophes). */
export function placeWords(name: string): string[] {
    return normalizePlaceName(name)
        .split(WORD_SPLIT_RE)
        .map((word) => word.replace(/^'+|'+$/g, ''))
        .filter(Boolean);
}

/** The label trimmed, or null when it is empty, a filler («Unknown», «Там же») or too long to be a name. */
export function cleanLabel(label: unknown): string | null {
    if (typeof label !== 'string') return null;
    const trimmed = label.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > MAX_LABEL_CHARS) return null;
    const normalized = normalizePlaceName(trimmed);
    if (!normalized || NOISE_RE.test(normalized)) return null;
    return trimmed;
}

const OPENERS: Record<string, string> = { '«': '»', '“': '”', '„': '“' };
const STRENGTH: Record<SeparatorKind, number> = { comma: 1, dash: 2, paren: 3 };

/**
 * Splits a label on commas, semicolons, dashes (em and en dash anywhere, a hyphen only with spaces around it — never
 * inside «Нью-Йорк»), arrows, bars and spaced slashes, and on parentheses. Quoted text («…», “…”, "…") is never split.
 */
export function splitLabel(label: string): SplitLabel {
    const parts: string[] = [];
    const kinds: (SeparatorKind | null)[] = [];
    let current = '';
    /** The strongest boundary since the last kept part (a parenthesis beats a dash next to it, a dash a comma). */
    let pending: SeparatorKind | null = null;
    const closers: string[] = [];
    let straight = false;

    const boundary = (kind: SeparatorKind | null) => {
        const text = current.replace(/\s+/g, ' ').replace(/^[\s\-–—]+|[\s\-–—]+$/g, '');
        current = '';
        if (text && /[\p{L}\p{N}]/u.test(text) && text.length <= MAX_PART_CHARS) {
            const key = normalizePlaceName(text);
            if (key && !parts.some((part) => normalizePlaceName(part) === key)) {
                parts.push(text);
                kinds.push(parts.length === 1 ? null : pending);
                pending = null;
            }
        }
        if (kind !== null && (pending === null || STRENGTH[kind] > STRENGTH[pending])) pending = kind;
    };

    const chars = [...label];
    for (let i = 0; i < chars.length; i++) {
        const char = chars[i] as string;
        const prev = chars[i - 1];
        const next = chars[i + 1];
        if (char === '"') {
            straight = !straight;
            current += char;
            continue;
        }
        const opener = OPENERS[char];
        if (opener !== undefined && !(char === '“' && closers.at(-1) === '“')) {
            closers.push(opener);
            current += char;
            continue;
        }
        if (closers.length && char === closers.at(-1)) {
            closers.pop();
            current += char;
            continue;
        }
        if (closers.length > 0 || straight) {
            current += char;
            continue;
        }
        const spacedBefore = prev === undefined || /\s/.test(prev);
        const spacedAfter = next === undefined || /\s/.test(next) || next === '-';
        if (char === ',' || char === ';' || char === '，' || char === '\n') boundary('comma');
        else if (char === '—' || char === '–' || char === '→' || char === '›' || char === '>' || char === '|') {
            boundary('dash');
        } else if ((char === '-' || char === '/' || char === '·' || char === '•') && spacedBefore && spacedAfter) {
            boundary('dash');
        } else if (char === '-' && prev === '-') {
            // the second hyphen of « -- »: already split
        } else if (char === '(' || char === '[' || char === ')' || char === ']') boundary('paren');
        else current += char;
    }
    boundary(null);
    return { parts, kinds };
}

/* ------------------------------------------------------------------ lexicon */

/**
 * Levels of place words: 0 realm/region, 1 settlement, 2 district or open area, 3 building or site, 4 room or part
 * of a building. Latin words match whole words (with a plural s/es); Cyrillic entries are stems matched at the start
 * of a word, so every case form counts («таверн» — «таверна», «таверне», «таверной»).
 */
const LATIN_LEVELS: readonly (readonly string[])[] = [
    [
        'kingdom',
        'empire',
        'realm',
        'country',
        'land',
        'province',
        'region',
        'continent',
        'world',
        'planet',
        'duchy',
        'principality',
        'county',
        'territory',
        'republic',
        'nation',
        'state',
    ],
    [
        'city',
        'town',
        'village',
        'capital',
        'settlement',
        'hamlet',
        'metropolis',
        'township',
        'megacity',
        'colony',
        'stronghold',
        'outpost',
    ],
    [
        'district',
        'quarter',
        'ward',
        'borough',
        'street',
        'avenue',
        'road',
        'square',
        'market',
        'marketplace',
        'harbor',
        'harbour',
        'port',
        'docks',
        'dock',
        'slums',
        'outskirts',
        'park',
        'forest',
        'woods',
        'beach',
        'shore',
        'valley',
        'mountains',
        'plaza',
        'alley',
        'bazaar',
        'neighborhood',
        'neighbourhood',
        'suburb',
        'suburbs',
        'downtown',
        'uptown',
        'riverside',
        'waterfront',
        'countryside',
        'wilds',
        'swamp',
        'desert',
        'jungle',
        'meadow',
        'fields',
        'field',
        'highway',
        'lane',
        'boulevard',
        'campus',
        'grounds',
    ],
    [
        'tavern',
        'inn',
        'house',
        'home',
        'mansion',
        'manor',
        'castle',
        'palace',
        'keep',
        'fortress',
        'fort',
        'tower',
        'temple',
        'church',
        'cathedral',
        'chapel',
        'shrine',
        'monastery',
        'abbey',
        'academy',
        'school',
        'university',
        'shop',
        'store',
        'bakery',
        'smithy',
        'forge',
        'guild',
        'guildhall',
        'hospital',
        'clinic',
        'apartment',
        'apartments',
        'flat',
        'cottage',
        'cabin',
        'hut',
        'barracks',
        'prison',
        'jail',
        'dungeon',
        'warehouse',
        'mill',
        'farm',
        'farmhouse',
        'estate',
        'villa',
        'lighthouse',
        'station',
        'bar',
        'pub',
        'cafe',
        'café',
        'restaurant',
        'hotel',
        'motel',
        'club',
        'theater',
        'theatre',
        'museum',
        'arena',
        'stadium',
        'embassy',
        'bank',
        'mall',
        'building',
        'ship',
        'brothel',
        'dormitory',
        'dorm',
        'office',
        'headquarters',
        'lab',
        'laboratory',
        'workshop',
        'stable',
        'stables',
        'cave',
        'cavern',
        'ruins',
        'camp',
        'encampment',
    ],
    [
        'room',
        'bedroom',
        'chamber',
        'chambers',
        'hall',
        'hallway',
        'corridor',
        'kitchen',
        'cellar',
        'basement',
        'attic',
        'study',
        'library',
        'bathroom',
        'bath',
        'balcony',
        'terrace',
        'courtyard',
        'garden',
        'lobby',
        'foyer',
        'parlor',
        'parlour',
        'lounge',
        'stairs',
        'staircase',
        'stairwell',
        'floor',
        'roof',
        'rooftop',
        'vault',
        'cell',
        'quarters',
        'suite',
        'closet',
        'pantry',
        'nursery',
        'gallery',
        'ballroom',
        'throne',
        'deck',
        'booth',
        'backroom',
        'storeroom',
        'washroom',
        'restroom',
        'loft',
        'porch',
        'veranda',
        'greenhouse',
        'conservatory',
        'infirmary',
        'armory',
        'armoury',
        'kitchens',
    ],
];

const CYRILLIC_LEVELS: readonly (readonly string[])[] = [
    [
        'королевств',
        'импери',
        'стран',
        'провинци',
        'област',
        'регион',
        'континент',
        'планет',
        'княжеств',
        'графств',
        'земл',
        'республик',
        'государств',
        'герцогств',
    ],
    ['город', 'деревн', 'сел', 'посел', 'столиц', 'хутор', 'станиц', 'град', 'колони', 'аванпост', 'мегаполис'],
    [
        'район',
        'квартал',
        'улиц',
        'переул',
        'проспект',
        'площад',
        'рынок',
        'рынк',
        'базар',
        'гаван',
        'порт',
        'пристан',
        'окраин',
        'предмест',
        'парк',
        'лес',
        'пляж',
        'берег',
        'долин',
        'набережн',
        'трущоб',
        'бульвар',
        'шоссе',
        'пустын',
        'болот',
        'джунгл',
        'луг',
        'поле',
        'кампус',
        'горы',
    ],
    [
        'таверн',
        'трактир',
        'корчм',
        'гостиниц',
        'отел',
        'дом',
        'особняк',
        'усадьб',
        'поместь',
        'замк',
        'замок',
        'дворц',
        'дворец',
        'крепост',
        'башн',
        'храм',
        'церк',
        'собор',
        'часовн',
        'монастыр',
        'академи',
        'школ',
        'университет',
        'лавк',
        'магазин',
        'кузниц',
        'гильди',
        'больниц',
        'лечебниц',
        'клиник',
        'офис',
        'квартир',
        'хижин',
        'избушк',
        'изб',
        'казарм',
        'тюрьм',
        'темниц',
        'подземель',
        'склад',
        'мельниц',
        'ферм',
        'вилл',
        'маяк',
        'станци',
        'вокзал',
        'бар',
        'кафе',
        'ресторан',
        'клуб',
        'театр',
        'музе',
        'арен',
        'стадион',
        'посольств',
        'банк',
        'здани',
        'корабл',
        'общежити',
        'бордел',
        'лаборатори',
        'мастерск',
        'конюшн',
        'пещер',
        'руин',
        'лагер',
        'штаб',
        'святилищ',
    ],
    [
        'комнат',
        'спальн',
        'поко',
        'зал',
        'холл',
        'коридор',
        'кухн',
        'подвал',
        'погреб',
        'чердак',
        'кабинет',
        'библиотек',
        'ванн',
        'купальн',
        'балкон',
        'террас',
        'двор',
        'сад',
        'вестибюл',
        'прихож',
        'гостин',
        'столов',
        'лестниц',
        'этаж',
        'крыш',
        'хранилищ',
        'камер',
        'кель',
        'мансард',
        'будуар',
        'оранжере',
        'кладов',
        'палат',
        'кают',
        'трюм',
        'палуб',
        'приемн',
        'гардероб',
        'чулан',
        'лазарет',
        'оружейн',
    ],
];

const LATIN_INDEX = new Map<string, number>();
LATIN_LEVELS.forEach((words, level) => {
    for (const word of words) if (!LATIN_INDEX.has(word)) LATIN_INDEX.set(word, level);
});

function latinLevel(word: string): number | null {
    const direct = LATIN_INDEX.get(word);
    if (direct !== undefined) return direct;
    if (word.endsWith('es')) {
        const stem = LATIN_INDEX.get(word.slice(0, -2));
        if (stem !== undefined) return stem;
    }
    if (word.endsWith('s')) {
        const stem = LATIN_INDEX.get(word.slice(0, -1));
        if (stem !== undefined) return stem;
    }
    return null;
}

/** Stems that begin unrelated longer words («странный», «дворянский», «портной», «паркет»). */
const TIGHT_STEMS = new Set(['стран', 'земл', 'поко', 'камер', 'палат', 'двор', 'порт', 'парк', 'град', 'поле']);

/**
 * The longest stem at the start of the word wins. Stems of three letters or less and the tight ones match only words
 * at most two letters longer: «дом», «дома», «домик» — not «доминион»; «двором» — not «дворянский».
 */
function cyrillicLevel(word: string): number | null {
    let level: number | null = null;
    let length = 0;
    for (let i = 0; i < CYRILLIC_LEVELS.length; i++) {
        for (const stem of CYRILLIC_LEVELS[i] as readonly string[]) {
            if (!word.startsWith(stem) || stem.length <= length) continue;
            if ((stem.length <= 3 || TIGHT_STEMS.has(stem)) && word.length > stem.length + 2) continue;
            level = i;
            length = stem.length;
        }
    }
    return level;
}

/** Level of one normalised word (a place-type word like «tavern», «комнатой»), null for any other word. */
export function wordLevel(word: string): number | null {
    return CYRILLIC_RE.test(word) ? cyrillicLevel(word) : latinLevel(word);
}

/**
 * Level of a label part from its head word: in English the last place word before «of/in/at/on» («Castle Kitchen»,
 * «Throne Room of the Castle» → room), in Russian the first place word («Кухня замка» → кухня). Null when no word of
 * the lexicon occurs.
 */
export function placeLevel(part: string): number | null {
    const words = placeWords(part);
    if (!words.length) return null;
    if (CYRILLIC_RE.test(part)) {
        for (const word of words) {
            const level = wordLevel(word);
            if (level !== null) return level;
        }
        return null;
    }
    const cut = words.findIndex((word) => word === 'of' || word === 'in' || word === 'at' || word === 'on');
    const head = cut > 0 ? words.slice(0, cut) : words;
    for (const list of [head, words]) {
        for (let i = list.length - 1; i >= 0; i--) {
            const level = latinLevel(list[i] as string);
            if (level !== null) return level;
        }
    }
    return null;
}

/* ------------------------------------------------------------------ direction */

/**
 * Direction from the lexicon: +1 general first, -1 specific first, 0 unknown. Two parts with levels compare the first
 * and the last of them; a single part with a level decides only at an end of the label (a room or building last means
 * general first; a city or region first means general first).
 */
export function lexiconDirection(parts: readonly string[]): number {
    const levels = parts.map(placeLevel);
    const known = levels.map((level, index) => ({ level, index })).filter((item) => item.level !== null);
    if (known.length >= 2) {
        const first = known[0]!.level as number;
        const last = known[known.length - 1]!.level as number;
        if (first < last) return 1;
        if (first > last) return -1;
        return 0;
    }
    if (known.length === 1) {
        const { level, index } = known[0] as { level: number; index: number };
        const lastIndex = parts.length - 1;
        if (level >= 3) return index === lastIndex ? 1 : index === 0 ? -1 : 0;
        if (level <= 1) return index === 0 ? 1 : index === lastIndex ? -1 : 0;
    }
    return 0;
}

/**
 * Direction from the separators when nothing else tells: a parenthetical holds the container («Hall (Inn)»), dashes and
 * arrows go from general to specific («Город — район», «Castle > Throne Room»), commas follow the address style of
 * the label's script (Russian: from general, English: from specific).
 */
export function separatorDirection(label: string, kinds: readonly (SeparatorKind | null)[]): number {
    const used = kinds.filter((kind): kind is SeparatorKind => kind !== null);
    if (used.length && used.every((kind) => kind === 'paren')) return -1;
    if (used.includes('dash')) return 1;
    return CYRILLIC_RE.test(label) ? 1 : -1;
}

export interface OrderedLabel {
    /** Parts, most specific first. */
    parts: string[];
    order: LabelOrder;
}

/**
 * Orders the parts most specific first. `registryVote` comes from the place registry (+1 general first, -1 specific
 * first, 0 no evidence) and wins over the lexicon, which wins over the separators.
 */
export function orderLabelParts(label: string, split: SplitLabel, registryVote = 0): OrderedLabel {
    const { parts, kinds } = split;
    if (parts.length <= 1) return { parts: [...parts], order: 'single' };
    let direction = Math.sign(registryVote);
    let order: LabelOrder = 'registry';
    if (direction === 0) {
        direction = lexiconDirection(parts);
        order = 'lexicon';
    }
    if (direction === 0) {
        direction = separatorDirection(label, kinds);
        order = 'separator';
    }
    return { parts: direction > 0 ? [...parts].reverse() : [...parts], order };
}

/** Splits and orders a label without a registry (most specific part first). */
export function parsePlaceLabel(label: string): OrderedLabel {
    const clean = cleanLabel(label);
    if (!clean) return { parts: [], order: 'single' };
    return orderLabelParts(clean, splitLabel(clean));
}
