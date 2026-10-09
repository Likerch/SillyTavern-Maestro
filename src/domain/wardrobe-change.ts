// A change of clothes said in a message (M27 «переодевание по сообщениям»): the player writes «переодеваюсь в домашнее»,
// the narration says «Офелия сняла плащ» or "She slips into a silk robe". The detector finds such changes in Russian and
// English text without a model: verbs of changing, dressing, putting on, taking off and undressing with their person and
// tense; what was put on (the clothing words after the verb, an outfit named by the player: «в домашнее» ↔ «Домашнее»,
// «Домашняя одежда»); who it is (first person of the player = the persona, a named character in any case form, he/she
// only when one present character fits). Left out: negations, wishes and conditions («хочу переодеться», «если она
// снимет…», «бы»), questions, orders to others («Переоденься!»), direct speech in quotes or dash dialogue, the future
// in the narration, idioms («снял квартиру», «надела маску безразличия») and minor things alone (glasses, a ring, a hat,
// shoes). Pure.
import { nameGender } from './name-gender';
import { termOf } from './wardrobe-tags';
import { clothingPieces, detectUndress } from './wardrobe-wear';
import type { UndressKind } from './wardrobe-wear';
import { normalizeName } from './world-names';

/** change: put on other clothes; remove: took something off; undress: took everything off; dress: got dressed. */
export type ChangeKind = 'change' | 'remove' | 'undress' | 'dress';

export interface ChangeCastMember {
    name: string;
    /** Other names in the nominative (world model aliases: «Vera», «Верочка»): they can be the subject. */
    aliases?: readonly string[];
    /** Case forms (world model, DES-RU): «Веру», «Верой» — recognised, but no subject. */
    forms?: readonly string[];
    /** Grammatical gender; guessed from the name when absent. */
    gender?: 'f' | 'm' | null;
    /**
     * In the scene now (default). Someone known but away is still recognised by name, but «он», «она» and «ты» are
     * only the people present.
     */
    present?: boolean;
}

export interface ChangePersona {
    name: string;
    aliases?: readonly string[];
    forms?: readonly string[];
}

export interface ChangeOptions {
    /** The user's character (named in the text = 'persona'). */
    persona?: ChangePersona | string;
    /**
     * Who wrote the text: the player (default: the first person is the persona, «ты» the one present character) or the
     * narrator of a reply (the second person is the persona, the first person `narrator`).
     */
    speaker?: 'player' | 'narrator';
    /** The character whose reply this is (the narrator's «я»). */
    narrator?: string;
    /** Outfit names per who ('persona' or a cast member's name): an outfit the text names is recognised. */
    outfits?: Readonly<Record<string, readonly string[]>>;
}

export interface OutfitChange {
    /** 'persona' (the user's character), a cast member's name, or '?' (someone the text does not say clearly). */
    who: string;
    kind: ChangeKind;
    /** The words that say it, as written (the verb and what follows it in its clause). */
    phrase: string;
    /** What was put on or taken off, as written (accusative forms turned back: «красную юбку» → «красная юбка»). */
    garments: string[];
    /** The outfit of `options.outfits` the text names. */
    outfitName?: string;
    /** Undressing, when the text says how far (naked, a towel, underwear, half). */
    undress?: UndressKind;
    /** What it was changed into, as written («домашнее»), '' when the text does not say. */
    into: string;
}

/* ------------------------------------------------------------------ text helpers */

const L = '(?<!\\p{L})';
const R = '(?!\\p{L})';
const norm = (text: string) => text.toLowerCase().replace(/ё/g, 'е');
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** The text with direct speech blanked out (same length): quotes, and the speech parts of dash dialogue lines. */
export function maskSpeech(text: string): string {
    let value = String(text ?? '');
    const blank = (from: number, to: number) => {
        value = value.slice(0, from) + ' '.repeat(Math.max(0, to - from)) + value.slice(to);
    };
    // Paired quotes: «…», “…”, „…“, "…".
    for (const pattern of [/«[^«»]*»/g, /“[^“”]*”/g, /„[^„“”]*[“”]/g, /"[^"\n]*"/g]) {
        for (const match of value.matchAll(pattern)) blank(match.index ?? 0, (match.index ?? 0) + match[0].length);
    }
    // Dash dialogue: a line opening with a dash is speech; « — » then alternates the author's words and speech.
    let offset = 0;
    for (const line of value.split('\n')) {
        const lead = /^\s*[—–-]\s+/.exec(line);
        if (lead) {
            let at = offset + lead[0].length;
            let speech = true;
            for (const part of line.slice(lead[0].length).split(/(\s[—–]\s)/)) {
                if (/^\s[—–]\s$/.test(part)) speech = !speech;
                else if (speech) blank(at, at + part.length);
                at += part.length;
            }
        }
        offset += line.length + 1;
    }
    return value;
}

interface Span {
    start: number;
    end: number;
}

/** Sentences of a text as offsets (ends at . ! ? … or a line break; the mark is part of the sentence). */
function sentences(text: string): Span[] {
    const out: Span[] = [];
    let from = 0;
    for (const match of text.matchAll(/[.!?…]+|\n+/g)) {
        const end = (match.index ?? 0) + match[0].length;
        if (text.slice(from, end).trim()) out.push({ start: from, end });
        from = end;
    }
    if (text.slice(from).trim()) out.push({ start: from, end: text.length });
    return out;
}

/* ------------------------------------------------------------------ verbs */

type Family = 'change' | 'dress' | 'puton' | 'swap' | 'remove' | 'undress' | 'stay' | 'wrap';
type Form = '1s' | '2s' | '3' | '1p' | 'past' | 'inf' | 'ger' | 'base' | 'ing';

interface VerbRule {
    family: Family;
    lang: 'ru' | 'en';
    re: RegExp;
    /** Russian imperfective stems: a present ending on anything else is the perfective future. */
    present?: readonly string[];
}

const ru = (family: Family, source: string, present: readonly string[]): VerbRule => ({
    family,
    lang: 'ru',
    re: new RegExp(`${L}(?:${source})${R}`, 'gu'),
    present,
});
const en = (family: Family, source: string): VerbRule => ({
    family,
    lang: 'en',
    re: new RegExp(`\\b(?:${source})\\b`, 'gu'),
});

// prettier-ignore
const VERBS: readonly VerbRule[] = [
    ru('change', 'переодева(?:юсь|ешься|ется|емся|етесь|ются|лся|лась|лось|лись|ться|ясь)|переоде(?:нусь|нешься|нется|немся|нетесь|нутся|лся|лась|лось|лись|ться|вшись)', ['переодева']),
    ru('dress', 'одева(?:юсь|ешься|ется|емся|етесь|ются|лся|лась|лось|лись|ться|ясь)|оде(?:нусь|нешься|нется|немся|нетесь|нутся|лся|лась|лось|лись|ться|вшись)|наряжа(?:юсь|ешься|ется|ются|лся|лась|лись|ться|ясь)|наряди(?:лся|лась|лись|ться|вшись|тся)|наряжусь|облача(?:юсь|ешься|ется|ются|лся|лась|лись|ться|ясь)|облачи(?:лся|лась|лись|ться|вшись|тся)|облачусь|приоде(?:лся|лась|лись|ться|нусь|нется)', ['одева', 'наряжа', 'облача']),
    ru('puton', 'наде(?:ва(?:ю|ешь|ет|ем|ете|ют|л|ла|ло|ли|ть|я)|л|ла|ло|ли|ну|нешь|нет|нем|нете|нут|ть|в)|натя(?:гива(?:ю|ешь|ет|ем|ют|л|ла|ли|ть|я)|нул|нула|нули|нуть|нув|ну|нешь|нет|нут)|наки(?:дыва(?:ю|ешь|ет|ем|ют|л|ла|ли|ть|я)|нул|нула|нули|нуть|нув|ну|нешь|нет|нут)|набр(?:асыва(?:ю|ешь|ет|ют|л|ла|ли|ть|я)|осил|осила|осили|осить|осив|ошу|осишь|осит|осят)|оде(?:ва(?:ю|ешь|ет|ем|ют|л|ла|ли)|л|ла|ли|ну|нешь|нет|нут)|влез(?:ла|ли|у|ешь|ет|ут|ть)|влеза(?:ю|ешь|ет|ют|л|ла|ли|ть)', ['надева', 'натягива', 'накидыва', 'набрасыва', 'одева', 'влеза']),
    ru('swap', 'смени(?:л|ла|ли|ть|в)|сменю|сменишь|сменит|сменят|меня(?:ю|ешь|ет|ем|ют|л|ла|ли|ть|я)|поменя(?:л|ла|ли|ть|ю|ет|ют|в)', ['меня']),
    ru('remove', 'сн(?:ял|яла|яло|яли|ять|яв|иму|имешь|имет|имем|имут|има(?:ю|ешь|ет|ем|ют|л|ла|ли|ть|я))|стя(?:гива(?:ю|ешь|ет|ют|л|ла|ли|ть|я)|нул|нула|нули|нуть|нув|ну|нешь|нет|нут)|ски(?:дыва(?:ю|ешь|ет|ют|л|ла|ли|ть|я)|нул|нула|нули|нуть|нув|ну|нешь|нет|нут)|сбр(?:асыва(?:ю|ешь|ет|ют|л|ла|ли|ть|я)|осил|осила|осили|осить|осив|ошу|осишь|осит|осят)|сорва(?:л|ла|ли|ть|в)|срыва(?:ю|ешь|ет|ют|л|ла|ли|ть|я)|стащи(?:л|ла|ли|ть|в)|стаскива(?:ю|ешь|ет|ют|л|ла|ли|ть|я)|выскользну(?:л|ла|ли|ть|в)|выскальзыва(?:ю|ешь|ет|ют|л|ла|ли|ть|я)', ['снима', 'стягива', 'скидыва', 'сбрасыва', 'срыва', 'стаскива', 'выскальзыва']),
    ru('undress', 'раздева(?:юсь|ешься|ется|емся|етесь|ются|лся|лась|лось|лись|ться|ясь)|разде(?:нусь|нешься|нется|немся|нетесь|нутся|лся|лась|лось|лись|ться|вшись)|оголи(?:лся|лась|лись|ться)|обнажи(?:лся|лась|лись|ться)', ['раздева']),
    ru('stay', 'оста(?:лся|лась|лись|юсь|ется|ешься|нусь|нется|ваясь|вшись)', ['остаю', 'остае', 'остава']),
    ru('wrap', 'оберну(?:лся|лась|лись|ться|вшись)|обора?чива(?:юсь|ется|ются|лся|лась|ться|ясь)|заверну(?:лся|лась|лись|ться|вшись)|заворачива(?:юсь|ется|лся|лась|ться)|закута(?:лся|лась|лись|ться|вшись)|закутыва(?:юсь|ется|лся|лась|ться)|укута(?:лся|лась|лись|ться|вшись)', ['обора', 'оборачива', 'заворачива', 'закутыва']),
    en('change', 'chang(?:e|es|ed|ing)\\s+(?:back\\s+)?into|(?:switch(?:es|ed|ing)?|slip(?:s|ped|ping)?|wriggl(?:e|es|ed|ing)|squeez(?:e|es|ed|ing))\\s+(?:back\\s+)?into|(?:get|gets|got|getting|gotten)\\s+changed'),
    en('swap', 'chang(?:e|es|ed|ing)\\s+(?:(?:his|her|their|my|your|our)\\s+)?(?:clothes|outfit|clothing)'),
    en('dress', '(?:get|gets|got|getting|gotten)\\s+dressed|dress(?:es|ed|ing)?\\s+(?:up\\s+)?in(?!to)|(?<=\\b(?:i|you|he|she|they|we)\\s+(?:quickly\\s+|hastily\\s+|slowly\\s+)?)dress(?:es|ed)?'),
    en('puton', '(?:put(?:s|ting)?|pull(?:s|ed|ing)?|throw(?:s|ing)?|threw|thrown|tug(?:s|ged|ging)?|shrug(?:s|ged|ging)?)(?=[^.,;!?\\n]{0,40}?\\bon\\b)|don(?:s|ned|ning)?|slip(?:s|ped|ping)?\\s+on'),
    en('remove', '(?:take|takes|taking|took|taken)(?=[^.,;!?\\n]{0,40}?\\boff\\b)|remov(?:e|es|ed|ing)|shed(?:s|ding)?|(?:peel(?:s|ed|ing)?|strip(?:s|ped|ping)?|kick(?:s|ed|ing)?|shrug(?:s|ged|ging)?|pull(?:s|ed|ing)?|tug(?:s|ged|ging)?)\\s+off|slip(?:s|ped|ping)?\\s+(?:off|out\\s+of)'),
    en('undress', 'undress(?:es|ed|ing)?|strip(?:s|ped|ping)?(?:\\s+(?:naked|bare|nude|down))?|(?:get|gets|got|getting|gotten)\\s+undressed'),
];

/** The person and tense of a Russian verb form by its ending. */
function ruForm(word: string): Form {
    if (/ть(?:ся)?$/.test(word)) return 'inf';
    if (/(?:вшись|ясь)$/.test(word) || /[аеиуыяо]в$/.test(word) || /[аи]я$/.test(word)) return 'ger';
    if (/(?:лся|лась|лось|лись|л|ла|ло|ли)$/.test(word)) return 'past';
    if (/(?:ешься|ишься|ешь|ишь|етесь|ете|ите)$/.test(word)) return '2s';
    if (/(?:емся|ем)$/.test(word)) return '1p';
    if (/(?:юсь|усь|ю|у)$/.test(word)) return '1s';
    return '3';
}

/** Past-tense gender of a Russian form ('pl' for plural). */
function ruGender(word: string): 'f' | 'm' | 'pl' | null {
    if (/(?:лась|ла)$/.test(word)) return 'f';
    if (/(?:лся|л)$/.test(word)) return 'm';
    if (/(?:лись|ли)$/.test(word)) return 'pl';
    return null;
}

/** The tense of an English match by its first word (the verb). */
function enForm(word: string): Form {
    const verb = word.split(/\s+/)[0] ?? word;
    if (/ing$/.test(verb)) return 'ing';
    if (/(?:ed|took|threw|thrown|got|gotten|taken)$/.test(verb) || verb === 'put' || verb === 'shed') return 'past';
    if (/s$/.test(verb) && !/ss$/.test(verb)) return '3';
    return 'base';
}

/* ------------------------------------------------------------------ filters */

const RU_NEGATION = new Set(['не', 'ни', 'нет', 'никогда', 'нельзя']);
// prettier-ignore
const RU_WISH_WORDS = new Set([
    'хочу', 'хочет', 'хочешь', 'хотим', 'хотите', 'хотят', 'хотел', 'хотела', 'хотели', 'хотелось', 'надо', 'нужно',
    'нужна', 'нужен', 'нужны', 'стоит', 'стоило', 'пора', 'можно', 'может', 'могу', 'можешь', 'мог', 'могла', 'могли',
    'прошу', 'просит', 'просил', 'просила', 'просят', 'велит', 'велел', 'велела', 'лучше', 'следует', 'придется',
    'приходится', 'готов', 'готова', 'давно',
]);
// prettier-ignore
const RU_WISH_STEMS = [
    'должн', 'собира', 'планиру', 'предлага', 'предложи', 'попроси', 'приказ', 'заставля', 'застави', 'уговарива',
    'уговори', 'мечта', 'пыта', 'попыта', 'намерева', 'намерен', 'жела', 'забыл', 'забыва', 'отказыва', 'отказал',
];
const RU_CONDITION = new Set([
    'если',
    'ежели',
    'бы',
    'б',
    'чтобы',
    'чтоб',
    'пусть',
    'пускай',
    'давай',
    'давайте',
    'коли',
]);
// Going off to change, beginning or managing to change counts: «пошла переодеться», «начала раздеваться».
const RU_GO_RE =
    /(?:^|\s)(?:пош(?:ел|ла|ли)|ушл[аи]|ушел|иду|идет|идем|пойду|пойдет|отправил(?:ся|ась|ись)|отправляюсь|убежал[аи]?|побежал[аи]?|вышл[аи]|вышел|удалил(?:ся|ась|ись)|удаляюсь|бегу|бежит|поднял(?:ся|ась|ись)|спустил(?:ся|ась|ись)|начал[аи]?|начина(?:ю|ет|ют)|стал[аи]?|стану|станет|принял(?:ся|ась|ись)|принимаюсь|принимается|успел[аи]?|успева(?:ю|ет|ют))\s+(?:\S+\s+){0,3}$/u;

const EN_NEGATION_RE =
    /\b(?:not|never|no\s+longer|cannot|can't|won't|don't|doesn't|didn't|isn't|wasn't|aren't|weren't|haven't|hasn't|hadn't|wouldn't|shouldn't|couldn't)\s+(?:\S+\s+)?$/;
const EN_WISH_RE =
    /\b(?:want|wants|wanted|wanna|would|could|should|might|may|must|need|needs|needed|have\s+to|has\s+to|had\s+to|going\s+to|gonna|plans?|planned|try|tries|tried|asks?|asked|tells?|told|orders?|ordered|suggests?|suggested|offers?|offered|begs?|begged|let's|let\s+me|lets|if|unless|whether|wish|wishes|wished|hopes?|hoped|forgot|forget)\b/;
const EN_FUTURE_RE = /\b(?:will|shall)\s+(?:\S+\s+)?$|'ll\s+(?:\S+\s+)?$/;
const EN_TO_RE = /\bto\s+$/;
const EN_GO_RE =
    /\b(?:went|goes|go|going|ran|runs|run|hurried|hurries|heads?|headed|stepped|steps|left|leaves|disappeared|disappears|ducked|ducks|retreated|retreats|began|begins|started|starts|managed|manages)\b(?:\s+\S+){0,4}\s+to\s+$|\b(?:began|begins|started|starts)\s+$/;
const RELATIVE_RE = /(?:^|\s)(?:котор(?:ый|ая|ое|ые)|кто|who|which)\s*$/u;
const EN_STATE_RE = /\b(?:is|was|are|were|be|been|being|am|'s|'re|'m)\s+(?:\S+\s+)?$/;
/** «надела на меня», «сняла с неё»: oblique pronouns after the preposition. */
const OBLIQUE: Readonly<Record<string, { person: 1 | 2 | 3; gender: 'f' | 'm' | null }>> = {
    меня: { person: 1, gender: null },
    тебя: { person: 2, gender: null },
    вас: { person: 2, gender: null },
    него: { person: 3, gender: 'm' },
    нее: { person: 3, gender: 'f' },
};

/* ------------------------------------------------------------------ who */

interface Mention {
    start: number;
    end: number;
    /** 'persona', a cast name; '' for a pronoun. */
    who: string;
    /** The name as is (or a nominative pronoun), not a case form. */
    nominative: boolean;
    person: 1 | 2 | 3;
    gender: 'f' | 'm' | 'pl' | null;
    pronoun: boolean;
}

type PronounInfo = { person: 1 | 2 | 3; gender: Mention['gender'] };
const PRONOUNS: Readonly<Record<string, PronounInfo>> = {
    я: { person: 1, gender: null },
    ты: { person: 2, gender: null },
    вы: { person: 2, gender: null },
    он: { person: 3, gender: 'm' },
    она: { person: 3, gender: 'f' },
    они: { person: 3, gender: 'pl' },
    мы: { person: 1, gender: 'pl' },
    i: { person: 1, gender: null },
    "i'm": { person: 1, gender: null },
    "i've": { person: 1, gender: null },
    "i'll": { person: 1, gender: null },
    "i'd": { person: 1, gender: null },
    you: { person: 2, gender: null },
    "you're": { person: 2, gender: null },
    "you've": { person: 2, gender: null },
    "you'll": { person: 2, gender: null },
    he: { person: 3, gender: 'm' },
    "he's": { person: 3, gender: 'm' },
    "he'll": { person: 3, gender: 'm' },
    she: { person: 3, gender: 'f' },
    "she's": { person: 3, gender: 'f' },
    "she'll": { person: 3, gender: 'f' },
    they: { person: 3, gender: 'pl' },
    "they're": { person: 3, gender: 'pl' },
    we: { person: 1, gender: 'pl' },
    "we're": { person: 1, gender: 'pl' },
};

interface Person {
    who: string;
    names: string[];
    forms: string[];
    gender: 'f' | 'm' | null;
    present: boolean;
}

function escapeRe(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every place a person is named in the (normalised) text: as is, by a case form, or by a stem with an ending. */
function nameMentions(text: string, person: Person): Mention[] {
    const out: Mention[] = [];
    const seen = new Set<number>();
    const push = (start: number, end: number, nominative: boolean) => {
        if (seen.has(start)) return;
        seen.add(start);
        out.push({ start, end, who: person.who, nominative, person: 3, gender: person.gender, pronoun: false });
    };
    const exact = [...new Set(person.names.map(norm).filter((name) => name.length >= 2))];
    const forms = [...new Set(person.forms.map(norm).filter((form) => form.length >= 2 && !exact.includes(form)))];
    for (const name of exact) {
        for (const match of text.matchAll(new RegExp(`${L}${escapeRe(name)}${R}`, 'gu')))
            push(match.index ?? 0, (match.index ?? 0) + match[0].length, true);
    }
    for (const form of forms) {
        for (const match of text.matchAll(new RegExp(`${L}${escapeRe(form)}${R}`, 'gu')))
            push(match.index ?? 0, (match.index ?? 0) + match[0].length, false);
    }
    // Case endings of a Russian name without forms: «Вера» → «Веру», «Веры», «Верой».
    for (const name of exact) {
        if (!CYRILLIC_RE.test(name) || name.includes(' ')) continue;
        const base = name.replace(/[аяоеьйи]$/u, '');
        if (base.length < 3) continue;
        for (const match of text.matchAll(new RegExp(`${L}${escapeRe(base)}\\p{L}{0,3}${R}`, 'gu'))) {
            const start = match.index ?? 0;
            push(start, start + match[0].length, match[0] === name);
        }
    }
    return out;
}

function pronounMentions(text: string): Mention[] {
    const out: Mention[] = [];
    for (const match of text.matchAll(WORD_RE)) {
        const info = PRONOUNS[match[0].replace(/’/g, "'")];
        if (!info) continue;
        const start = match.index ?? 0;
        out.push({ start, end: start + match[0].length, who: '', nominative: true, ...info, pronoun: true });
    }
    return out;
}

/* ------------------------------------------------------------------ what was put on */

// Minor things: alone they are no change of clothes (glasses, a ring, a hat, shoes, gloves, a mask …).
// prettier-ignore
const MINOR = new Set([
    'boots', 'boot', 'shoes', 'shoe', 'sneakers', 'sandals', 'slippers', 'moccasins', 'high heels', 'heels', 'thigh boots',
    'socks', 'hat', 'cap', 'beret', 'hood', 'beanie', 'glasses', 'spectacles', 'mask', 'earrings', 'ring', 'bracelet',
    'necklace', 'bead necklace', 'chain necklace', 'pendant', 'locket', 'brooch', 'gloves', 'mittens', 'scarf',
    'headscarf', 'necktie', 'tie', 'bow tie', 'belt', 'sash', 'ribbon', 'bow', 'crown', 'tiara', 'circlet',
    'head wreath', 'wreath', 'hairband', 'headband', 'hair clip', 'bag', 'handbag', 'backpack', 'satchel', 'pouch',
    'shield', 'monocle', 'helmet', 'veil', 'bandana', 'choker', 'barefoot',
]);

/** Words for clothes in general («одежду», "clothes"): with a remove verb they mean everything. */
const GENERIC_RE =
    /(?<!\p{L})(?:одежд\p{L}*|вещи|наряд(?:ы|ов)?|вс[её](?:\s+с\s+себя)?|догола|clothes|clothing|everything)(?!\p{L})/u;

function garmentTerms(piece: string): string[] {
    const out: string[] = [];
    for (const match of piece.matchAll(WORD_RE)) {
        const term = termOf(norm(match[0]));
        if (term && (term.kind === 'garment' || term.kind === 'accessory') && term.en) out.push(term.en);
    }
    return out;
}

/** Every garment of the pieces is a minor thing (or there is none). */
function onlyMinor(pieces: readonly string[]): boolean {
    return pieces.flatMap(garmentTerms).every((term) => MINOR.has(term));
}

const OPENER_RE = /^(?:в|во|на|into|in|on)\s+/iu;
const POSSESSIVE_RE =
    /^(?:(?:свою|свой|свое|своё|свои|мою|мой|мое|моё|мои|его|ее|её|их|her|his|their|my|your|our|a|an|the|some)\s+)+/iu;

/** A clothing phrase in the accusative back in the nominative where it is sure: «красную юбку» → «красная юбка». */
export function nominative(phrase: string): string {
    return phrase.replace(WORD_RE, (word) => {
        const lower = norm(word);
        if (!CYRILLIC_RE.test(lower)) return word;
        if (/ую$/.test(lower) && lower.length > 4) return `${word.slice(0, -2)}ая`;
        if (/юю$/.test(lower) && lower.length > 4) return `${word.slice(0, -2)}яя`;
        if (/[ую]$/.test(lower) && lower.length > 3) {
            const changed = word.slice(0, -1) + (lower.endsWith('у') ? 'а' : 'я');
            const was = termOf(lower);
            const now = termOf(norm(changed));
            if (was && now && was.kind === 'garment' && now.kind === 'garment' && was.en === now.en) return changed;
        }
        return word;
    });
}

function cleanGarment(piece: string): string {
    const text = piece.replace(/\s+/g, ' ').trim().replace(OPENER_RE, '').replace(POSSESSIVE_RE, '');
    return nominative(text.replace(/[.,;:!?…]+$/, '').trim());
}

/**
 * The clause after the verb: comma parts while they name clothes (the first part always), and how far into the text
 * they reach.
 */
function objectParts(text: string): { parts: string[]; length: number } {
    const parts: string[] = [];
    let length = 0;
    let from = 0;
    const bounds = [...text.matchAll(/[,;:—–()]+/g)].map((match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
    }));
    bounds.push({ start: text.length, end: text.length });
    for (const bound of bounds) {
        const part = text.slice(from, bound.start);
        const first = parts.length === 0;
        if (part.trim() && (first || startsClothing(part))) {
            parts.push(part);
            length = bound.start;
        } else break;
        from = bound.end;
    }
    return { parts, length };
}

/** How far someone undressed: «до белья», «до пояса», "down to her underwear". */
const UNDRESS_TO: readonly { re: RegExp; kind: UndressKind }[] = [
    { re: /^\s*(?:до|в)\s+(?:нижнего\s+|одном\s+|одних\s+)?(?:бель|трус)/u, kind: 'underwear' },
    { re: /^\s*(?:до\s+пояса|по\s+пояс)/u, kind: 'partial' },
    {
        re: /^\s*(?:down\s+)?to\s+(?:her|his|their|my|your)\s+(?:underwear|lingerie|panties|boxers|briefs)/,
        kind: 'underwear',
    },
    { re: /^\s*(?:down\s+)?to\s+the\s+waist/, kind: 'partial' },
];

const LINKS = new Set([
    'и',
    'а',
    'также',
    'еще',
    'ещё',
    'плюс',
    'and',
    'also',
    'plus',
    'her',
    'his',
    'their',
    'a',
    'an',
    'the',
]);
const CLOTHING_KINDS = new Set(['garment', 'accessory', 'colour', 'shade', 'material', 'modifier']);

/** A later comma part goes on with clothes («, шарф и перчатки»), not with another action («, оставшись в …»). */
function startsClothing(part: string): boolean {
    for (const match of part.matchAll(WORD_RE)) {
        const word = norm(match[0]);
        if (LINKS.has(word)) continue;
        const term = termOf(word);
        return !!term && CLOTHING_KINDS.has(term.kind) && garmentTerms(part).length > 0;
    }
    return false;
}

/** What it was changed into: the words after «в» / "into" (or the whole first part), up to «и» / "and". */
function intoOf(first: string, family: Family): string {
    let text = first.trim();
    if (family === 'swap') {
        const after = /(?<!\p{L})(?:на|for|into)\s+(.+)$/iu.exec(text);
        if (!after?.[1]) return '';
        text = after[1];
    } else text = text.replace(OPENER_RE, '').replace(/^(?:меня|тебя|вас|него|нее|неё|себя)\s+/iu, '');
    text = text.split(/\s(?:и|а|затем|потом|после|and|then|before|after|to)\s/iu)[0] ?? '';
    return text
        .replace(POSSESSIVE_RE, '')
        .replace(/[.,;:!?…]+$/, '')
        .trim();
}

/* ------------------------------------------------------------------ outfit names */

// prettier-ignore
const RU_ENDINGS = [
    'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ей',
    'ую', 'юю', 'ым', 'им', 'ом', 'ем', 'ых', 'их', 'ах', 'ях', 'ов', 'ев', 'ам', 'ям', 'а', 'я', 'о', 'е', 'ы', 'и',
    'у', 'ю', 'ь', 'й',
];
// prettier-ignore
const NAME_STOP = new Set([
    'в', 'во', 'на', 'с', 'со', 'и', 'а', 'из', 'мой', 'моя', 'мое', 'мою', 'мои', 'свой', 'своя', 'свое', 'свою', 'свои',
    'ее', 'его', 'их', 'my', 'her', 'his', 'their', 'your', 'the', 'a', 'an', 'into', 'in', 'on', 'of', 'and',
    'одежда', 'одежду', 'одежде', 'одеждой', 'одежды', 'наряд', 'наряда', 'наряде', 'вещи', 'clothes', 'clothing',
    'outfit', 'attire',
]);

function stem(word: string): string {
    const value = norm(word);
    if (CYRILLIC_RE.test(value)) {
        for (const ending of RU_ENDINGS) {
            if (value.endsWith(ending) && value.length - ending.length >= 3) return value.slice(0, -ending.length);
        }
        return value;
    }
    if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2);
    if (value.length > 3 && value.endsWith('s')) return value.slice(0, -1);
    return value;
}

function stems(text: string): string[] {
    const out: string[] = [];
    for (const match of String(text ?? '').matchAll(WORD_RE)) {
        const word = norm(match[0]);
        if (word.length < 2 || NAME_STOP.has(word)) continue;
        out.push(stem(word));
    }
    return out;
}

function sameStem(a: string, b: string): boolean {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 4 && long.startsWith(short);
}

const covers = (outer: readonly string[], inner: readonly string[]) =>
    inner.length > 0 && inner.every((item) => outer.some((other) => sameStem(item, other)));

/**
 * The outfit a phrase names («в домашнее» → «Домашнее», «Домашняя одежда»): every word of the name in the phrase (the
 * most specific name wins), else every word of the phrase in exactly one name. Null when none or it is unclear.
 */
export function matchOutfitName(phrase: string, names: readonly string[]): string | null {
    const wanted = stems(phrase);
    if (!wanted.length) return null;
    const list = names.filter((name) => typeof name === 'string' && name.trim());
    const exact = list.find((name) => normalizeName(name) === normalizeName(phrase));
    if (exact) return exact;
    const inside = list
        .map((name) => ({ name, words: stems(name) }))
        .filter((item) => covers(wanted, item.words))
        .sort((a, b) => b.words.length - a.words.length);
    if (inside.length === 1 || (inside.length > 1 && inside[0]!.words.length > inside[1]!.words.length))
        return inside[0]!.name;
    if (inside.length) return null;
    const around = list.filter((name) => covers(stems(name), wanted));
    return around.length === 1 ? around[0]! : null;
}

/* ------------------------------------------------------------------ the detector */

interface Found {
    rule: VerbRule;
    start: number;
    end: number;
    word: string;
}

function findVerbs(text: string, span: Span): Found[] {
    const part = text.slice(span.start, span.end);
    const out: Found[] = [];
    for (const rule of VERBS) {
        for (const match of part.matchAll(rule.re)) {
            const start = span.start + (match.index ?? 0);
            const end = start + match[0].length;
            if (out.some((item) => start < item.end && end > item.start)) continue;
            out.push({ rule, start, end, word: match[0] });
        }
    }
    return out.sort((a, b) => a.start - b.start);
}

/** The words of the verb's clause before it (lower case, at most `count`). */
function wordsBefore(text: string, span: Span, at: number, count: number): string[] {
    const head = text.slice(span.start, at);
    const clause = head.split(/[,;:—–()]/).pop() ?? head;
    return (clause.match(WORD_RE) ?? []).slice(-count);
}

interface Context {
    cast: Person[];
    speaker: 'player' | 'narrator';
    narrator: string;
    outfits: Readonly<Record<string, readonly string[]>>;
}

/** The present character of a gender, when exactly one fits. */
function onlyOfGender(context: Context, gender: 'f' | 'm' | 'pl' | null): string | null {
    if (gender !== 'f' && gender !== 'm') return null;
    const fit = context.cast.filter((person) => person.present && person.gender === gender);
    return fit.length === 1 ? fit[0]!.who : null;
}

/** Who the first or second person is. */
function personWho(person: 1 | 2, context: Context): string {
    if (person === 1) return context.speaker === 'player' ? 'persona' : context.narrator || '?';
    if (context.speaker === 'narrator') return 'persona';
    const present = context.cast.filter((person) => person.present);
    return present.length === 1 ? present[0]!.who : '?';
}

function personOf(form: Form): 1 | 2 | 3 | null {
    if (form === '1s' || form === '1p') return 1;
    if (form === '2s') return 2;
    if (form === '3') return 3;
    return null;
}

interface Subject {
    who: string;
    gender: 'f' | 'm' | null;
}

/** Detects the changes of clothes a text says (see the header). */
export function detectOutfitChange(
    text: string,
    cast: readonly ChangeCastMember[] = [],
    options: ChangeOptions = {},
): OutfitChange[] {
    const source = String(text ?? '');
    if (!source.trim()) return [];
    const masked = norm(maskSpeech(source));
    const personaSpec = typeof options.persona === 'string' ? { name: options.persona } : options.persona;
    const personaName = personaSpec?.name?.trim() ?? '';
    const context: Context = {
        cast: cast
            .filter((member) => member?.name?.trim() && normalizeName(member.name) !== normalizeName(personaName))
            .map((member) => ({
                who: member.name.trim(),
                names: [member.name, ...(member.aliases ?? [])],
                forms: [...(member.forms ?? [])],
                gender: member.gender === undefined ? nameGender(member.name) : member.gender,
                present: member.present !== false,
            })),
        speaker: options.speaker ?? 'player',
        narrator: options.narrator?.trim() ?? '',
        outfits: options.outfits ?? {},
    };
    const persona: Person | null = personaName
        ? {
              who: 'persona',
              names: [personaName, ...(personaSpec?.aliases ?? [])],
              forms: [...(personaSpec?.forms ?? [])],
              gender: nameGender(personaName),
              present: true,
          }
        : null;
    const people = [...context.cast, ...(persona ? [persona] : [])];
    const genderOf = (who: string) => people.find((person) => person.who === who)?.gender ?? null;
    const mentions = [...people.flatMap((person) => nameMentions(masked, person)), ...pronounMentions(masked)].sort(
        (a, b) => a.start - b.start,
    );
    const out: OutfitChange[] = [];
    // The subject the previous sentence was about (a sentence without one continues it).
    let previous: Subject | null = null;
    for (const span of sentences(masked)) {
        const question = /\?[\s"»”]*$/.test(masked.slice(span.start, span.end));
        const inSentence = mentions.filter((item) => item.start >= span.start && item.end <= span.end);
        let current: Subject | null = null;
        for (const found of findVerbs(masked, span)) {
            if (question) continue;
            const change = readVerb(found, span, inSentence, previous);
            if (!change) continue;
            out.push(change);
            if (change.who !== '?') current = { who: change.who, gender: genderOf(change.who) };
        }
        const last = inSentence.filter((item) => item.nominative && item.gender !== 'pl').pop();
        previous =
            current ??
            (last ? { who: resolve(last, previous), gender: last.gender === 'pl' ? null : last.gender } : null);
    }
    return out;

    /**
     * The person a mention stands for: he/she is the subject of the sentence before when it fits, else the one present
     * character of that gender ('?' when more fit).
     */
    function resolve(mention: Mention, before: Subject | null = null): string {
        if (!mention.pronoun) return mention.who;
        if (mention.person === 1 || mention.person === 2) return personWho(mention.person, context);
        if (before && before.who !== '?' && before.who !== 'persona' && before.gender === mention.gender)
            return before.who;
        return onlyOfGender(context, mention.gender) ?? '?';
    }

    /** The change one verb says, or null when a filter leaves it out. */
    function readVerb(found: Found, span: Span, inSentence: Mention[], before: Subject | null): OutfitChange | null {
        const { rule, word } = found;
        const head = masked.slice(span.start, found.start);
        let form: Form;
        let gender: 'f' | 'm' | 'pl' | null = null;
        let future = false;
        if (rule.lang === 'ru') {
            form = ruForm(word);
            gender = form === 'past' ? ruGender(word) : null;
            future =
                (form === '1s' || form === '2s' || form === '3' || form === '1p') &&
                !(rule.present ?? []).some((stemWord) => word.startsWith(stemWord));
            if (wordsBefore(masked, span, found.start, 3).some((item) => RU_NEGATION.has(item))) return null;
            const going = RU_GO_RE.test(head);
            const near = wordsBefore(masked, span, found.start, 4);
            const wish = near.some(
                (item) => RU_WISH_WORDS.has(item) || RU_WISH_STEMS.some((stemWord) => item.startsWith(stemWord)),
            );
            if (wish && !(form === 'inf' && going)) return null;
            if ((head.match(WORD_RE) ?? []).some((item) => RU_CONDITION.has(item))) return null;
            // «переоделась бы»
            if ((masked.slice(found.end, span.end).match(WORD_RE) ?? [])[0] === 'бы') return null;
            if (form === 'inf' && !going) return null;
        } else {
            form = enForm(word);
            const tail = head.slice(-80);
            if (EN_NEGATION_RE.test(tail)) return null;
            const going = EN_GO_RE.test(tail);
            if (EN_TO_RE.test(tail)) {
                if (!going) return null;
                form = 'inf';
            }
            if (!going && EN_WISH_RE.test(wordsBefore(masked, span, found.start, 6).join(' '))) return null;
            if (EN_FUTURE_RE.test(tail)) future = true;
            // "is dressed in …" says what someone wears, not that they changed.
            if (rule.family === 'dress' && EN_STATE_RE.test(tail)) return null;
            // An order ("Take that off!") or a bare form without anyone before it.
            if (form === 'base' && !inSentence.some((item) => item.end <= found.start)) return null;
        }
        // The player says what he does now or is about to do; the narration only what happened.
        if (future && context.speaker === 'narrator') return null;
        if (gender === 'pl') return null;

        const who = whoOf(found, form, gender, head, inSentence, before);

        // What.
        const objectText = source.slice(found.end, span.end);
        const objectNorm = masked.slice(found.end, span.end);
        const { parts, length } = objectParts(objectText);
        const first = parts[0] ?? '';
        const joined = parts.join(', ');
        const pieces =
            rule.family === 'swap'
                ? clothingPieces(intoOf(first, 'swap'))
                : clothingPieces(joined).filter((piece) => garmentTerms(piece).length);
        const garments = pieces.map(cleanGarment).filter(Boolean);
        const into = rule.family === 'remove' || rule.family === 'undress' ? '' : intoOf(first, rule.family);
        const outfitName = into ? (matchOutfitName(into, context.outfits[who] ?? []) ?? undefined) : undefined;
        const phrase = `${source.slice(found.start, found.end)}${objectText.slice(0, length)}`
            .replace(/\s+/g, ' ')
            .replace(/[,;:\s]+$/, '')
            .trim();
        const generic = GENERIC_RE.test(norm(first));
        const undress =
            UNDRESS_TO.find((item) => item.re.test(objectNorm))?.kind ??
            detectUndress(objectText)?.kind ??
            (/(?<!\p{L})полотенц/u.test(objectNorm) ? 'towel' : undefined);
        const base = { who, phrase, garments, into, ...(outfitName ? { outfitName } : {}) };
        const minorOnly = garments.length > 0 && onlyMinor(garments) && !outfitName;

        switch (rule.family) {
            case 'change':
                if (minorOnly) return null;
                return { ...base, kind: 'change' };
            case 'dress':
                if (minorOnly) return null;
                return { ...base, kind: garments.length || outfitName || into ? 'change' : 'dress' };
            case 'puton':
                if (!outfitName && (!garments.length || minorOnly)) return null;
                return { ...base, kind: 'change' };
            case 'swap':
                if (!generic && !garmentTerms(first).length && !outfitName) return null;
                if (minorOnly) return null;
                return { ...base, kind: 'change' };
            case 'remove':
                if (generic && !garments.length) return { ...base, into: '', kind: 'undress', undress: 'naked' };
                if (!garments.length || minorOnly) return null;
                return { ...base, kind: 'remove' };
            case 'undress':
                return { ...base, kind: 'undress', garments: [], undress: undress ?? 'naked' };
            case 'stay':
                if (!undress) return null;
                return { ...base, into: '', kind: 'undress', garments: [], undress };
            case 'wrap':
                if (undress === 'towel') return { ...base, kind: 'undress', garments: [], undress: 'towel' };
                if (!garments.length || minorOnly) return null;
                return { ...base, kind: 'change' };
        }
        return null;
    }

    /** Who the verb is about: its subject, the person of its form, the sentence before, the one character that fits. */
    function whoOf(
        found: Found,
        form: Form,
        gender: 'f' | 'm' | 'pl' | null,
        head: string,
        inSentence: Mention[],
        before: Subject | null,
    ): string {
        const person = found.rule.lang === 'ru' ? personOf(form) : form === '3' ? 3 : null;
        // «сняла с Веры плащ», «надела на меня плащ»: the clothes go on or come off someone else.
        const target = targetOf(found, inSentence);
        if (target) return target;
        // «…на Веру, которая переоделась»: the relative pronoun stands for the name before it.
        if (RELATIVE_RE.test(head)) {
            const named = inSentence.filter((item) => !item.pronoun && item.end <= found.start).pop();
            if (named) return named.who;
        }
        const accept = (mention: Mention): boolean => {
            if (!mention.nominative || mention.gender === 'pl') return false;
            if (person === 1 || person === 2) return mention.pronoun && mention.person === person;
            if (person === 3 && mention.pronoun && mention.person !== 3) return false;
            if (gender && mention.gender && mention.gender !== gender) return false;
            return true;
        };
        const left = inSentence.filter((item) => item.end <= found.start).reverse();
        const subject = left.find(accept);
        if (subject) return resolve(subject, before);
        if (form === 'past' || form === 'ger' || form === '3' || form === 'ing') {
            const right = inSentence.find((item) => item.start >= found.end && accept(item));
            if (right && (found.rule.lang === 'ru' || form === 'ing')) return resolve(right, before);
        }
        if (person === 1 || person === 2) return personWho(person, context);
        if (before && (!gender || !before.gender || before.gender === gender)) return before.who;
        if (context.speaker === 'player' && person !== 3) return 'persona';
        return onlyOfGender(context, gender) ?? '?';
    }

    /** Someone the clothes go on («надела на меня») or come off («сняла с Веры»), right after the verb. */
    function targetOf(found: Found, inSentence: Mention[]): string | null {
        const preposition = found.rule.family === 'remove' ? 'с' : found.rule.family === 'puton' ? 'на' : null;
        if (!preposition) return null;
        const after = masked.slice(found.end, found.end + 40);
        const word = new RegExp(`^\\s+${preposition}\\s+(\\p{L}+)`, 'u').exec(after)?.[1];
        const oblique = word ? OBLIQUE[word] : undefined;
        if (oblique) {
            return oblique.person === 3
                ? (onlyOfGender(context, oblique.gender) ?? '?')
                : personWho(oblique.person, context);
        }
        const named = inSentence.find((item) => {
            if (item.pronoun || item.start < found.end) return false;
            return new RegExp(`^\\s+${preposition}\\s+$`, 'u').test(masked.slice(found.end, item.start));
        });
        return named?.who ?? null;
    }
}

/**
 * What the changes of one text come to per person, in order: a later change, undressing or dressing replaces what came
 * before it for the same person; removals of one person merge.
 */
export function finalChanges(changes: readonly OutfitChange[]): OutfitChange[] {
    const out: OutfitChange[] = [];
    for (const change of changes) {
        if (change.kind !== 'remove') {
            for (let i = out.length - 1; i >= 0; i--) if (out[i]!.who === change.who) out.splice(i, 1);
            out.push({ ...change, garments: [...change.garments] });
            continue;
        }
        const previous = out.find((item) => item.who === change.who && item.kind === 'remove');
        if (previous) {
            previous.garments = [...previous.garments, ...change.garments];
            previous.phrase = `${previous.phrase}; ${change.phrase}`;
        } else out.push({ ...change, garments: [...change.garments] });
    }
    return out;
}

/** The text has a verb of changing clothes the detector knows (a cheap gate before the detector or a model). */
export function mentionsChange(text: string): boolean {
    const value = norm(String(text ?? ''));
    return VERBS.some((rule) => {
        rule.re.lastIndex = 0;
        const found = rule.re.test(value);
        rule.re.lastIndex = 0;
        return found;
    });
}

/**
 * A wording without the garments that came off: comma and «и» parts that name one of them go. Null when nothing was
 * taken away or nothing is left.
 */
export function withoutGarments(wording: string, removed: readonly string[]): string | null {
    const gone = new Set(removed.flatMap(garmentTerms));
    if (!gone.size) return null;
    const parts = String(wording ?? '')
        .split(/\s*(?:,|;|(?<!\p{L})и(?!\p{L})|\band\b)\s*/u)
        .map((part) => part.trim())
        .filter(Boolean);
    const kept = parts.filter((part) => !garmentTerms(part).some((term) => gone.has(term)));
    if (kept.length === parts.length || !kept.length) return null;
    return kept.join(', ');
}

/** A person a command can name: its key ('persona' or a character's name) and the names it answers to. */
export interface WhoCandidate {
    who: string;
    names: readonly string[];
}

/**
 * The person a command starts with (the longest matching name, a quoted one too) and the rest of it:
 * «Офелия Грей вечернее платье» → Офелия Грей + «вечернее платье». Null when it starts with nobody known.
 */
export function splitWho(text: string, candidates: readonly WhoCandidate[]): { who: string; rest: string } | null {
    const value = String(text ?? '').trim();
    const quoted = /^["«“]([^"»”]+)["»”]\s*(.*)$/su.exec(value);
    const known = (name: string) =>
        candidates.find((candidate) =>
            candidate.names.some((item) => item.trim() && normalizeName(item) === normalizeName(name)),
        );
    if (quoted?.[1]) {
        const found = known(quoted[1]);
        return found ? { who: found.who, rest: (quoted[2] ?? '').trim() } : null;
    }
    const words = value.split(/\s+/).filter(Boolean);
    for (let count = Math.min(4, words.length); count >= 1; count--) {
        const found = known(
            words
                .slice(0, count)
                .join(' ')
                .replace(/[,:]+$/, ''),
        );
        if (found) return { who: found.who, rest: words.slice(count).join(' ').trim() };
    }
    return null;
}
