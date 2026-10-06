// What a character wears right now, from DES's free text (plan-2 §4 «Что надето сейчас», п. 2): real DES has no
// outfit field — its default character fields are `appearance` («Visible physical appearance (clothing, hair,
// notable features)») and `demeanor`, and a Russian setup names them «Внешность» / «Поведение». So the clothing is cut
// out of the appearance text by a dictionary: word runs around garments, footwear and accessories (wardrobe-tags.ts
// vocabulary) are kept as written, everything about hair, eyes, face and body is left out. Undressing (naked, in a
// towel, in underwear, topless) is read by its own lexicon with negations. No AI. Pure.
import { lookupEn, termOf } from './wardrobe-tags';
import type { Term } from './wardrobe-tags';

export type UndressKind = 'naked' | 'towel' | 'underwear' | 'partial';

/** Undress kinds that are an outfit of their own («Без одежды», «В полотенце», «Нижнее бельё»). */
export const UNDRESS_OUTFITS: readonly UndressKind[] = ['naked', 'towel', 'underwear'];

export interface Undress {
    kind: UndressKind;
    /** The words that say it, as written. */
    phrase: string;
}

export interface ClothingText {
    /** The clothing as written (pieces of the original text joined by ", "); the undress phrase when nothing else. */
    text: string;
    /** Undressing said in the text, if any. */
    undress: Undress | null;
}

/* ------------------------------------------------------------------ word classes */

type WordClass = 'garment' | 'adjective' | 'part' | 'body' | 'function' | 'verb' | 'wear' | 'other';

const norm = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

// Hair, eyes, face, skin, figure and other body words. Stems match a word start; the exact forms are whole words only,
// where a stem would also catch a garment («нос» / «носки», «рук» / «рукав», «кожа» / «кожаный»).
// prettier-ignore
const RU_BODY_STEMS: readonly string[] = [
    'волос', 'прическ', 'причесан', 'челк', 'локон', 'кудр', 'пряд', 'косичк', 'хвостик', 'макушк', 'глаз', 'взгляд',
    'ресниц', 'бров', 'зрачк', 'радужк', 'лиц', 'щек', 'щеч', 'скул', 'подбород', 'губ', 'улыб', 'зуб', 'клык', 'виск',
    'висок', 'ушк', 'фигур', 'телосложен', 'сложени', 'плеч', 'ключиц', 'бедр', 'живот', 'пупок', 'пупк', 'спин',
    'поясниц', 'ягодиц', 'колен', 'лодыж', 'ступн', 'пятк', 'ладон', 'пальц', 'пальч', 'ногт', 'запясть', 'локт',
    'локоть', 'кулак', 'горл', 'веснушк', 'родинк', 'родимо', 'шрам', 'рубц', 'рубец', 'татуир', 'тату', 'пирсинг',
    'макияж', 'помад', 'румян', 'тушь', 'морщин', 'бород', 'щетин', 'бакенбард', 'мышц', 'мускул', 'загар',
    'загорел', 'смугл', 'веснушчат', 'стройн', 'худощав', 'худая', 'худой', 'худым', 'худом', 'миниатюрн',
    'полноват', 'коренаст', 'широкоплеч', 'невысок', 'рослый', 'рослая', 'возраст', 'молод', 'пожил', 'крыл',
    'рожк', 'хвост', 'чешу', 'когт', 'носик', 'кровь', 'синяк', 'ссадин', 'порез', 'кудряв', 'темноволос',
    'светловолос', 'рыжеволос', 'седовлас', 'лыс', 'зеленоглаз', 'голубоглаз', 'кареглаз', 'сероглаз', 'запах',
    'голос',
];
// prettier-ignore
const RU_BODY_EXACT = new Set([
    'нос', 'носа', 'носом', 'носу', 'рот', 'рта', 'ртом', 'кожа', 'кожи', 'коже', 'кожу', 'кожей', 'руки', 'рука',
    'руке', 'руку', 'рукой', 'руками', 'руках', 'рук', 'ноги', 'нога', 'ноге', 'ногу', 'ногой', 'ногами', 'ногах', 'ног',
    'тело', 'тела', 'телу', 'теле', 'телом', 'лет', 'года', 'век', 'веки', 'веко', 'усы', 'усам', 'усов', 'усами',
    'рост', 'роста', 'ростом', 'лоб', 'лба', 'лбу', 'уши', 'ухо', 'ушей', 'ушами', 'шея', 'шеи', 'шее', 'шею', 'шеей',
    'сед', 'седой', 'седая', 'рога', 'рогами', 'грудь', 'груди', 'грудью', 'бюст', 'талия', 'талии', 'талию', 'талией',
    'голова', 'головы', 'голове', 'голову', 'головой', 'бледная', 'бледный', 'бледной', 'бледным', 'рана', 'раны',
    'вены',
]);

// prettier-ignore
const EN_BODY = new Set([
    'hair', 'haired', 'hairs', 'braid', 'braids', 'braided', 'ponytail', 'bangs', 'curls', 'curly', 'locks', 'fringe',
    'eye', 'eyes', 'eyed', 'gaze', 'lashes', 'eyelashes', 'brow', 'brows', 'eyebrows', 'pupils', 'iris', 'face',
    'faced', 'cheek', 'cheeks', 'cheekbones', 'jaw', 'jawline', 'chin', 'lips', 'lip', 'mouth', 'smile', 'teeth',
    'fangs', 'nose', 'ears', 'ear', 'forehead', 'skin', 'skinned', 'complexion', 'freckles', 'freckled', 'mole',
    'scar', 'scars', 'scarred', 'tattoo', 'tattoos', 'tattooed', 'piercing', 'piercings', 'pierced', 'makeup',
    'lipstick', 'eyeliner', 'mascara', 'blush', 'beard', 'bearded', 'mustache', 'moustache', 'stubble', 'body',
    'figure', 'build', 'frame', 'physique', 'height', 'tall', 'muscles', 'muscular', 'muscle', 'curves', 'curvy',
    'slender', 'slim', 'thin', 'lean', 'petite', 'stocky', 'chubby', 'chest', 'breasts', 'bust', 'shoulders',
    'shoulder', 'arms', 'arm', 'legs', 'leg', 'hands', 'hand', 'fingers', 'finger', 'nails', 'neck', 'collarbone',
    'collarbones', 'waist', 'hips', 'hip', 'thighs', 'thigh', 'stomach', 'belly', 'abs', 'back', 'feet', 'foot', 'toes',
    'wrists', 'wrist', 'knees', 'ankles', 'horns', 'horn', 'tail', 'wings', 'claws', 'tan', 'tanned', 'pale', 'age',
    'aged', 'years', 'old', 'young', 'youthful', 'elderly', 'veins', 'bruise', 'bruises', 'wound', 'wounds', 'blood',
    'sweat', 'tears', 'head', 'voice', 'scent',
]);

// A part of a garment (collar, sleeves, hem …): kept inside a clothing phrase, not a garment by itself.
// prettier-ignore
const RU_PART_STEMS: readonly string[] = [
    'воротни', 'пуговиц', 'подол', 'рукав', 'манжет', 'вырез', 'декольте', 'разрез', 'шнуровк', 'застежк', 'карман',
    'пряжк', 'отделк', 'вышивк', 'узор', 'принт', 'ткан', 'кант', 'кайм', 'каем', 'бахром', 'пайетк', 'блестк',
    'страз', 'кружевами', 'оборк', 'рюш', 'складк', 'лацкан', 'капюшон', 'шлейф', 'лямк', 'бретел', 'подкладк',
    'нашивк', 'эполет', 'погон', 'позумент', 'бант', 'шнурк', 'подошв', 'голенищ', 'молни', 'цвет',
];
// prettier-ignore
const EN_PARTS = new Set([
    'collar', 'collars', 'button', 'buttons', 'hem', 'hems', 'sleeve', 'sleeves', 'cuff', 'cuffs', 'neckline', 'slit',
    'laces', 'lacing', 'zipper', 'pocket', 'pockets', 'buckle', 'buckles', 'trim', 'trimmed', 'embroidery', 'pattern',
    'print', 'fabric', 'sequins', 'lapel', 'lapels', 'straps', 'strap', 'train', 'heel', 'soles', 'patch', 'patches',
    'insignia', 'epaulettes', 'details', 'accents', 'color', 'colour', 'colored', 'coloured',
]);

// Adjectives a clothing phrase is described with that the tag dictionary does not know (plain, light, wet …).
// prettier-ignore
const RU_DESCRIPTOR_STEMS: readonly string[] = [
    'прост', 'легк', 'тяжел', 'стар', 'нов', 'широк', 'узк', 'тонк', 'плотн', 'тепл', 'мягк', 'груб', 'элегантн',
    'изящн', 'строг', 'скромн', 'дорог', 'дешев', 'роскошн', 'богат', 'бедн', 'изношен', 'чист', 'мят', 'помят',
    'выглажен', 'наглухо', 'застегнут', 'накинут', 'наброшен', 'распахнут', 'закатан', 'подвернут', 'мокр', 'промок',
    'вымок', 'сыр', 'грязн', 'запачкан', 'испачкан', 'пыльн', 'окровавлен', 'кровав', 'обгорел', 'опален', 'высок',
    'низк', 'глубок', 'открыт', 'закрыт', 'приталенн', 'облегающ', 'струящ', 'воздушн', 'летящ', 'пышн',
    'короткополов', 'широкополов', 'остроносн', 'начищен', 'кружевн', 'шелков', 'черно', 'бело', 'красно', 'сине',
    'темно', 'светло', 'серо', 'зелено', 'бледно', 'небрежн', 'аккуратн', 'потрепан', 'полинявш', 'выцветш', 'любим',
    'привычн', 'неизменн', 'парадн', 'форменн', 'видав', 'надежн', 'практичн', 'удобн', 'утепленн', 'добротн',
    'нарядн', 'длинн', 'коротк', 'простор', 'мешковат', 'ночн', 'домашн', 'банн', 'слонов', 'кост', 'тугой', 'туго',
    'стоптан', 'латун', 'медн', 'бронзов', 'жемчуж', 'костян', 'рогов', 'кованн', 'вышит', 'расшит', 'украшен',
];
// prettier-ignore
const EN_DESCRIPTORS = new Set([
    'plain', 'simple', 'light', 'heavy', 'new', 'wide', 'narrow', 'thick', 'warm', 'soft', 'rough', 'elegant',
    'modest', 'expensive', 'cheap', 'luxurious', 'rich', 'clean', 'wrinkled', 'crumpled', 'wet', 'damp', 'soaked',
    'muddy', 'dirty', 'dusty', 'bloodied', 'bloody', 'singed', 'low', 'deep', 'open', 'closed', 'flowing', 'airy',
    'pointed', 'polished', 'buttoned', 'tucked', 'rolled', 'neat', 'sturdy', 'practical', 'comfortable', 'faded',
    'favorite', 'favourite', 'usual', 'matching', 'mismatched', 'fine', 'delicate', 'bare', 'ivory',
]);

// Words of wearing: they end a phrase and are left out, except a verb right before it («одета в …», "wearing …").
const RU_WEAR_STEMS: readonly string[] = [
    'одет',
    'надет',
    'облачен',
    'облачил',
    'обут',
    'носит',
    'носил',
    'переодел',
    'наряжен',
    'наряди',
    'накинул',
];
const EN_WEAR = new Set(['wearing', 'wears', 'wore', 'dressed', 'clad', 'donning', 'dons', 'donned', 'sporting']);
const RU_VERB_STEMS: readonly string[] = [
    'ней',
    'нем',
    'них',
    'нему',
    'ним',
    'сейчас',
    'теперь',
    'все',
    'еще',
    'уже',
    'только',
    'одном',
    'одних',
];
const EN_VERBS = new Set([
    'worn',
    'has',
    'have',
    'is',
    'are',
    'was',
    'were',
    'now',
    'currently',
    'still',
    'just',
    'only',
    'she',
    'he',
    'they',
    'also',
]);

// Words for clothes in general: a clothing phrase of their own («в дорожной одежде», "travel clothes").
const EN_GENERIC = new Set(['clothes', 'clothing', 'outfit', 'attire', 'garb', 'apparel', 'garments', 'getup']);

// Links inside a clothing phrase; «в», «на» and "in" may open one («в мокром плаще», «на каблуках», "in a black gown").
const RU_FUNCTION = new Set([
    'в',
    'во',
    'с',
    'со',
    'из',
    'на',
    'и',
    'да',
    'или',
    'под',
    'поверх',
    'без',
    'до',
    'по',
    'цвета',
]);
const EN_FUNCTION = new Set([
    'in',
    'with',
    'of',
    'and',
    'or',
    'a',
    'an',
    'the',
    'her',
    'his',
    'their',
    'its',
    'on',
    'over',
    'under',
    'to',
]);
const OPENERS = new Set(['в', 'во', 'на', 'in']);

// Cut idioms that name a body part but describe the garment («с открытыми плечами», "with bare shoulders").
const CUT_IDIOMS_RE =
    /(?<!\p{L})(?:(?:с|со)\s+(?:открыт|обнаженн|голы|глубок|низк|длинн|коротк|широк|узк|пышн)\p{L}*\s+(?:плеч|спин|рукав|вырез|декольте)\p{L}*|без\s+рукав\p{L}*|до\s+(?:колен|щиколот|пят|пола|бедер|середины\s+бедра)\p{L}*|в\s+пол)(?!\p{L})|\b(?:with\s+)?(?:bare|open|exposed)\s+(?:shoulders|back)\b|\b(?:knee|ankle|floor|thigh|hip)-(?:length|high)\b/giu;

// Phrases with a garment word that are about the body («на поясе кинжал»: the waist, not a belt).
const NOT_CLOTHING_RE = /(?<!\p{L})на\s+пояс(?:е|у)(?!\p{L})|\bat\s+(?:her|his|their)\s+(?:belt|hip|side)\b/giu;

/** Accessories that belong to a hairdo when the clause is about the body («волосы перехвачены лентой»). */
const HAIR_ACCESSORIES = new Set(['ribbon', 'hair clip', 'hairband', 'bow', 'head wreath']);

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

function startsWithAny(word: string, stems: readonly string[]): boolean {
    for (const stem of stems) if (word.startsWith(stem)) return true;
    return false;
}

function ruBody(word: string): boolean {
    return RU_BODY_EXACT.has(word) || startsWithAny(word, RU_BODY_STEMS);
}

function termClass(term: Term | null): WordClass | null {
    if (!term) return null;
    if (term.kind === 'garment' || term.kind === 'accessory') return 'garment';
    if (term.kind === 'colour' || term.kind === 'shade' || term.kind === 'material' || term.kind === 'modifier') {
        return 'adjective';
    }
    return null;
}

function ruGeneric(word: string): boolean {
    return (
        word.startsWith('одежд') ||
        word.startsWith('облачени') ||
        word.startsWith('экипировк') ||
        (word.startsWith('наряд') && !word.startsWith('нарядн'))
    );
}

/** One Russian word (or one part of a hyphenated word). */
function ruClass(word: string): WordClass {
    if (RU_FUNCTION.has(word)) return 'function';
    if (startsWithAny(word, RU_PART_STEMS)) return 'part';
    if (ruGeneric(word)) return 'garment';
    const known = termClass(termOf(word));
    if (known === 'garment') return 'garment';
    if (ruBody(word)) return 'body';
    if (known) return 'adjective';
    if (startsWithAny(word, RU_WEAR_STEMS)) return 'wear';
    if (RU_VERB_STEMS.includes(word)) return 'verb';
    if (startsWithAny(word, RU_DESCRIPTOR_STEMS)) return 'adjective';
    return 'other';
}

function enClass(word: string): WordClass {
    if (EN_FUNCTION.has(word)) return 'function';
    if (EN_WEAR.has(word)) return 'wear';
    if (EN_VERBS.has(word)) return 'verb';
    if (EN_GENERIC.has(word)) return 'garment';
    if (EN_BODY.has(word)) return 'body';
    if (EN_PARTS.has(word)) return 'part';
    const known = termClass(lookupEn(word));
    if (known) return known;
    if (EN_DESCRIPTORS.has(word)) return 'adjective';
    return 'other';
}

function pickClass(parts: readonly WordClass[]): WordClass {
    if (parts.includes('body')) return 'body';
    if (parts.includes('garment')) return 'garment';
    if (parts.every((part) => part === 'adjective' || part === 'function')) return 'adjective';
    if (parts.includes('part')) return 'part';
    return 'other';
}

/** A word of the text; hyphenated words take the strongest class of their parts («тёмно-синий», «юноша-трактирщик»). */
function classOf(raw: string): WordClass {
    const word = norm(raw).replace(/’/g, "'");
    if (!CYRILLIC_RE.test(word)) {
        const whole = enClass(word);
        if (whole !== 'other' || !word.includes('-')) return whole;
        return pickClass(word.split('-').filter(Boolean).map(enClass));
    }
    const parts = word.split(/[-']+/).filter(Boolean);
    if (parts.length === 1) return ruClass(parts[0] as string);
    return pickClass(parts.map(ruClass));
}

/* ------------------------------------------------------------------ clothing phrases */

interface Token {
    start: number;
    end: number;
    word: string;
    cls: WordClass;
}

// Clause breaks: sentences, commas, semicolons, dashes between words, parentheses.
const CLAUSE_RE = /[.;!?\n,()[\]{}«»"“”„|•·:]+|\s[—–-]\s/g;

function clauses(text: string): { start: number; end: number }[] {
    const out: { start: number; end: number }[] = [];
    let from = 0;
    for (const match of text.matchAll(CLAUSE_RE)) {
        const index = match.index ?? 0;
        if (index > from) out.push({ start: from, end: index });
        from = index + match[0].length;
    }
    if (from < text.length) out.push({ start: from, end: text.length });
    return out;
}

/** Words of one clause with their classes; words inside a cut idiom are garment parts. */
function tokensOf(text: string, start: number, end: number): Token[] {
    const part = text.slice(start, end);
    const ranges = (pattern: RegExp) =>
        [...part.matchAll(pattern)].map((match) => {
            const at = start + (match.index ?? 0);
            return [at, at + match[0].length] as const;
        });
    const cuts = ranges(CUT_IDIOMS_RE);
    const notClothing = ranges(NOT_CLOTHING_RE);
    const inside = (list: readonly (readonly [number, number])[], at: number) =>
        list.some(([from, to]) => at >= from && at < to);
    const out: Token[] = [];
    for (const match of part.matchAll(WORD_RE)) {
        const word = match[0];
        const at = start + (match.index ?? 0);
        const cls = inside(notClothing, at) ? 'other' : inside(cuts, at) ? 'part' : classOf(word);
        out.push({ start: at, end: at + word.length, word, cls });
    }
    return out;
}

const KEEP = new Set<WordClass>(['garment', 'adjective', 'part']);

/** Runs of clothing words of one clause (each with at least one garment), as [start, end) offsets. */
function clothingRuns(tokens: readonly Token[]): { start: number; end: number }[] {
    const runs: { start: number; end: number }[] = [];
    let run: Token[] = [];
    /** The verb of wearing the run follows («одета в …»). */
    let wearBefore: Token | null = null;
    /** A verb of wearing with only links after it so far ("wearing a …"). */
    let pendingWear: Token | null = null;
    const close = () => {
        // A run ends at its last garment or garment part; links at the start go, except an opening «в» / "in".
        while (run.length && run[run.length - 1]!.cls !== 'garment' && run[run.length - 1]!.cls !== 'part') run.pop();
        while (run.length && run[0]!.cls === 'function') {
            // «в мокром плаще», "in a black gown": the opening preposition stays with its phrase.
            if (OPENERS.has(norm(run[0]!.word))) break;
            run.shift();
        }
        if (run.some((token) => token.cls === 'garment')) {
            // «одета в …», "wearing …": the verb right before the phrase stays with it.
            const start = wearBefore ? wearBefore.start : run[0]!.start;
            runs.push({ start, end: run[run.length - 1]!.end });
        }
        run = [];
        wearBefore = null;
    };
    for (const token of tokens) {
        if (KEEP.has(token.cls)) {
            if (!run.length) wearBefore = pendingWear;
            pendingWear = null;
            run.push(token);
        } else if (token.cls === 'function') {
            if (run.length) run.push(token);
            else if (OPENERS.has(norm(token.word))) {
                wearBefore = pendingWear;
                pendingWear = null;
                run.push(token);
            }
            // Other links before a phrase ("wearing a …", "her …") are skipped; the verb still counts.
        } else {
            close();
            pendingWear = token.cls === 'wear' ? token : null;
        }
    }
    close();
    return runs;
}

/** The clothing pieces of a text as written, in order. */
export function clothingPieces(text: string): string[] {
    const source = String(text ?? '');
    const out: string[] = [];
    for (const clause of clauses(source)) {
        const tokens = tokensOf(source, clause.start, clause.end);
        const aboutBody = tokens.some((token) => token.cls === 'body');
        for (const run of clothingRuns(tokens)) {
            const piece = source.slice(run.start, run.end).replace(/\s+/g, ' ').trim();
            if (!piece || out.some((item) => norm(item) === norm(piece))) continue;
            // A ribbon or a hair clip in a clause about hair belongs to the hairdo.
            const garments = garmentsOf(piece);
            if (aboutBody && garments.length && garments.every((garment) => HAIR_ACCESSORIES.has(garment))) continue;
            out.push(piece);
        }
    }
    return out;
}

/* ------------------------------------------------------------------ undressing */

const L = '(?<!\\p{L})';
const R = '(?!\\p{L})';
const NEGATION_RE =
    /(?:^|[\s,])(?:не|нет|ни|уже\s+не|больше\s+не|not|no\s+longer|never|isn't|aren't|wasn't|fully)\s+(?:\S+\s+)?$/u;

interface UndressRule {
    kind: UndressKind;
    pattern: RegExp;
}

const rx = (source: string) => new RegExp(source, 'giu');

// Most covering first: towel, underwear, topless / half-dressed, naked.
// prettier-ignore
const UNDRESS_RULES: readonly UndressRule[] = [
    { kind: 'towel', pattern: rx(`${L}(?:(?:в|во)\\s+(?:одном\\s+|одних\\s+|банном\\s+)?полотенц\\p{L}*|(?:обернут|обмотан|завернут|замотан|укутан|закутан)\\p{L}*\\s+(?:в\\s+)?(?:банн\\p{L}*\\s+)?полотенц\\p{L}*|(?:только|лишь)\\s+(?:банное\\s+)?полотенце|полотенце\\s+(?:на\\s+бедрах|вокруг\\s+\\p{L}+|на\\s+теле))${R}|\\b(?:(?:in|wearing|wrapped\\s+in|only)\\s+(?:a\\s+|just\\s+a\\s+|only\\s+a\\s+)?(?:bath\\s+)?towel|towel\\s+(?:wrapped\\s+)?around\\s+(?:her|his|their)\\s+(?:body|waist|hips|chest)|(?:just|only)\\s+a\\s+towel)\\b`) },
    { kind: 'underwear', pattern: rx(`${L}(?:(?:в|во)\\s+(?:одном\\s+|одних\\s+)?нижнем\\s+бель\\p{L}*|(?:в\\s+)?(?:одном|одних)\\s+(?:нижнем\\s+)?(?:трус\\p{L}*|бель\\p{L}*)|(?:только|лишь)\\s+(?:в\\s+)?(?:нижнее\\s+|нижнем\\s+)?бель\\p{L}*|в\\s+трус(?:ах|иках)|в\\s+(?:лифчике|бюстгальтере)\\s+и\\s+трус\\p{L}*|раздет\\p{L}*\\s+до\\s+(?:нижнего\\s+)?бель\\p{L}*)${R}|\\b(?:in\\s+(?:(?:her|his|their|just|only)\\s+)?(?:underwear|undergarments|bra\\s+and\\s+panties|panties|boxers|briefs)|(?:underwear|lingerie)\\s+only|(?:just|only)\\s+(?:(?:her|his|their)\\s+)?(?:underwear|lingerie|a\\s+bra\\s+and\\s+panties|panties|boxers|briefs)|stripped\\s+to\\s+(?:her|his|their)\\s+underwear)\\b`) },
    { kind: 'partial', pattern: rx(`${L}(?:топлес|полуобнажен\\p{L}*|полураздет\\p{L}*|полугол\\p{L}*|(?:раздет|раздел|обнажен)\\p{L}*\\s+(?:до\\s+пояса|по\\s+пояс)|по\\s+пояс\\s+(?:голая|голый|обнажен\\p{L}*|раздет\\p{L}*)|(?:обнаженн|голы)\\p{L}*\\s+(?:торс\\p{L}*|грудь|грудью)|без\\s+(?:рубашки|рубахи|футболки|верха|блузки|кофты))${R}|\\b(?:topless|shirtless|bare-chested|bare\\s+chested|half-naked|half\\s+naked|half-dressed|half\\s+dressed|partially\\s+(?:undressed|dressed|clothed))\\b`) },
    { kind: 'naked', pattern: rx(`${L}(?:без\\s+(?:всякой\\s+)?одежды|без\\s+единой\\s+нитки|ничего\\s+не\\s+(?:надето|одето)|голая|голый|голые|голой|голую|голым|нагая|нагой|нагие|нагую|нагишом|обнажена|обнажен|обнажены|обнаженная|обнаженный|обнаженные|обнаженной|обнаженную|раздета|раздет|раздеты|раздетая|раздетый|раздетые|раздетой|раздетую|разделся|разделась|разделись)${R}|\\b(?:naked|nude|undressed|unclothed|in\\s+the\\s+nude|wearing\\s+nothing|nothing\\s+on|without\\s+(?:any\\s+)?clothes|no\\s+clothes)\\b`) },
];

/** A naked word followed by a body part, a weapon or a garment is a detail («голые плечи», «обнажённый меч», "nude lipstick"). */
const NOT_UNDRESS_AFTER_RE =
    /^[\s-]*(?:плеч|рук|ног|спин|колен|ступн|ладон|пальц|шея|шее|шеи|шею|ключиц|живот|бедр|кож|лодыж|запясть|меч|клин|шпаг|сабл|кинжал|нож|оруж|сталь|лезви|shoulders?|arms?|legs?|feet|back|skin|knees|lipstick|makeup|heels?|pumps|colou?r|tone|blade|sword|steel|stockings|dress|gown|top|bra)/iu;

/** Undressing said in a text (negations skipped); the most covering kind wins. */
export function detectUndress(text: string): Undress | null {
    const source = String(text ?? '');
    // ё → е keeps the length, so offsets of the normalised text are offsets of the source.
    const value = norm(source);
    for (const rule of UNDRESS_RULES) {
        for (const match of value.matchAll(rule.pattern)) {
            const index = match.index ?? 0;
            const before = value.slice(0, index);
            const clauseStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
            if (NEGATION_RE.test(before.slice(clauseStart + 1))) continue;
            const after = value.slice(index + match[0].length);
            if (rule.kind === 'naked' && NOT_UNDRESS_AFTER_RE.test(after)) continue;
            return { kind: rule.kind, phrase: source.slice(index, index + match[0].length).trim() };
        }
    }
    return null;
}

/* ------------------------------------------------------------------ the whole text */

const UNDERWEAR_GARMENTS = new Set(['underwear', 'panties', 'bra', 'lingerie', 'undergarments', 'boxers', 'briefs']);

/** The garments a piece names (English, as the dictionary has them). */
function garmentsOf(piece: string): string[] {
    const out: string[] = [];
    for (const match of piece.matchAll(WORD_RE)) {
        const word = norm(match[0]);
        const term = CYRILLIC_RE.test(word) ? termOf(word) : lookupEn(word);
        if (term && (term.kind === 'garment' || term.kind === 'accessory')) out.push(term.en);
    }
    return out;
}

/**
 * The clothing of an appearance text (or of an outfit field): the clothing pieces as written and undressing. Null when
 * the text says nothing about clothes. Underwear alone counts as being in underwear.
 */
export function clothingOf(text: unknown): ClothingText | null {
    if (typeof text !== 'string' || !text.trim()) return null;
    const pieces = clothingPieces(text);
    let undress = detectUndress(text);
    if (!undress && pieces.length) {
        const garments = pieces.flatMap(garmentsOf);
        if (garments.length && garments.every((garment) => UNDERWEAR_GARMENTS.has(garment))) {
            undress = { kind: 'underwear', phrase: pieces.join(', ') };
        }
    }
    if (!pieces.length && !undress) return null;
    // A piece inside the undress phrase is not said twice («в одном полотенце» is both).
    const phrase = undress ? norm(undress.phrase) : '';
    const kept = pieces.filter((piece) => !phrase || !phrase.includes(norm(piece)));
    const parts = undress && UNDRESS_OUTFITS.includes(undress.kind) ? [undress.phrase, ...kept] : kept;
    const unique: string[] = [];
    for (const part of parts.map((item) => item.trim()).filter(Boolean)) {
        if (!unique.some((item) => norm(item) === norm(part))) unique.push(part);
    }
    return { text: unique.join(', ') || (undress?.phrase ?? ''), undress };
}

/** True when a text mentions clothes or undressing at all (the cheap gate of the persona check). */
export function mentionsClothing(text: string): boolean {
    const source = String(text ?? '');
    if (detectUndress(source)) return true;
    for (const match of source.matchAll(WORD_RE)) {
        if (classOf(match[0]) === 'garment') return true;
    }
    return false;
}

/** Hair, eye and body words of a text, cut idioms aside (the real-samples check: none may leak into outfit text). */
export function bodyWords(text: string): string[] {
    const source = String(text ?? '');
    const out: string[] = [];
    for (const clause of clauses(source)) {
        for (const token of tokensOf(source, clause.start, clause.end)) if (token.cls === 'body') out.push(token.word);
    }
    return out;
}
