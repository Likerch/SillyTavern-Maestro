// Grammatical gender of a character's name for Russian notices («Офелия переоделась», «Кай переоделся»; plan-2 §3
// «естественный русский»). Maestro knows no character's gender, so this only guesses where Russian grammar is
// near-certain: a first name ending in -а/-я is feminine (except a list of male names and diminutives), a name ending
// in -й or one of the common male names is masculine. Everything else — foreign names ending in a consonant (Элис,
// Кармен), names that fit both (Саша, Женя), soft signs (Игорь / Любовь) — is unknown, and the caller words the notice
// without a gendered verb. Pure.

export type NameGender = 'f' | 'm';

// Male names and diminutives ending in -а/-я (Cyrillic and their usual Latin spelling).
// prettier-ignore
const MALE_A = new Set([
    'никита', 'илья', 'фома', 'кузьма', 'лука', 'савва', 'фока', 'данила', 'гаврила', 'мина', 'иона', 'ерема',
    'миша', 'гриша', 'паша', 'ваня', 'дима', 'петя', 'вася', 'коля', 'толя', 'федя', 'лёша', 'леша', 'алёша',
    'алеша', 'серёжа', 'сережа', 'костя', 'сеня', 'гена', 'жора', 'вова', 'володя', 'боря', 'лёва', 'лева', 'стёпа',
    'степа', 'тёма', 'тема', 'рома', 'сева', 'яша', 'юра', 'гоша', 'кеша', 'митя', 'витя', 'тоша', 'добрыня',
    'nikita', 'ilya', 'luca', 'luka', 'joshua', 'ezra', 'noah', 'elijah', 'misha', 'grisha', 'pasha', 'vanya', 'dima',
    'kostya', 'yura', 'jonah', 'isaiah', 'zacharia', 'mustafa', 'akira',
]);

// Names used for both sexes: never guessed.
// prettier-ignore
const EITHER = new Set([
    'саша', 'женя', 'валя', 'слава', 'шура', 'стася', 'ким', 'sasha', 'zhenya', 'kim', 'robin', 'alex', 'andrea',
    'nicola',
]);

// Common male names ending in a consonant (a foreign name ending in a consonant may well be female: not guessed).
// prettier-ignore
const MALE = new Set([
    'иван', 'пётр', 'петр', 'олег', 'артём', 'артем', 'максим', 'роман', 'денис', 'антон', 'борис', 'глеб', 'лев',
    'марк', 'павел', 'михаил', 'владимир', 'александр', 'константин', 'станислав', 'ярослав', 'святослав',
    'вячеслав', 'владислав', 'мирослав', 'богдан', 'руслан', 'тимур', 'кирилл', 'даниил', 'егор', 'фёдор', 'федор',
    'степан', 'семён', 'семен', 'захар', 'леонид', 'виктор', 'вадим', 'эдуард', 'герман', 'ростислав', 'мирон',
    'назар', 'платон', 'демид', 'давид', 'адам', 'ян', 'эрик', 'артур', 'ричард', 'джон', 'джек', 'томас', 'генри',
    'уильям', 'чарльз', 'эдвард', 'роберт', 'джеймс', 'дэниел', 'майкл', 'дэвид', 'гарри', 'люк', 'лукас',
    'себастьян', 'алан', 'альберт', 'аркадий', 'ахмед', 'тарас', 'наум', 'лазарь', 'игорь', 'дамир', 'рустам',
    'john', 'jack', 'thomas', 'henry', 'william', 'charles', 'edward', 'robert', 'james', 'daniel', 'michael',
    'david', 'harry', 'mark', 'luke', 'lucas', 'sebastian', 'arthur', 'richard', 'peter', 'paul', 'ivan', 'oleg',
    'maxim', 'roman', 'boris', 'igor', 'adam', 'eric', 'victor', 'george', 'frank', 'kai',
]);

const CYRILLIC_A = /[ая]$/u;
const LATIN_A = /a$/u;
const LETTERS = /^[\p{L}'’-]+/u;

/** The first word of a name, lower case («Офелия Грей» → «офелия»). */
function firstName(name: string): string {
    const word = LETTERS.exec(name.trim())?.[0] ?? '';
    return word.toLowerCase();
}

/** 'f', 'm', or null when the name does not tell. */
export function nameGender(name: string): NameGender | null {
    const word = firstName(name);
    if (word.length < 2 || EITHER.has(word)) return null;
    if (MALE.has(word) || MALE_A.has(word)) return 'm';
    if (CYRILLIC_A.test(word)) return 'f';
    if (/\p{Script=Cyrillic}/u.test(word)) return word.endsWith('й') ? 'm' : null;
    return LATIN_A.test(word) ? 'f' : null;
}

/** `${base}.f`, `${base}.m`, or `${base}.n` (wording without a gendered verb) for a phrase about this name. */
export function genderKey(base: string, name: string): string {
    return `${base}.${nameGender(name) ?? 'n'}`;
}
