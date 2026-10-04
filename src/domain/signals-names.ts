// Cheap detection of new names in a reply (signal 'name.new'; plan M26 п.1 «дешёвый поиск новых имён», P4): words
// and phrases written with a capital letter in the middle of a sentence, and short «quoted» names right after a
// common noun (таверна «Ржавый якорь», called "Shadow"). Sentence starts, dialogue openings, titles and common
// capitalised words are skipped; Russian case forms share one key («Блэквуда» = «Блэквуд»). No model, no lists of
// real names: the caller drops what the world model already knows. Pure: no DOM, no SillyTavern.
import { normalizeText, stemWord, textWords } from './signals-tokens';

export interface NameCandidate {
    /** As written in the reply (titles dropped). */
    name: string;
    /** Normalised and stemmed: the identity used for «seen before» and «known». */
    key: string;
    /** Came from «…» after a common noun (a deliberate name), not just from capitalisation. */
    quoted: boolean;
}

const MAX_CANDIDATES = 20;
const MAX_WORDS = 3;
const MAX_QUOTED_WORDS = 4;
const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const QUOTED_RE = /(\p{L})[ \t]+[«“"„]([^«»“”"„\n]{2,40})[»”"“]/gu;
/** A capitalised word right after one of these (spaces and emphasis skipped) starts a sentence or a line of speech. */
const SENTENCE_END = new Set([
    '.',
    '!',
    '?',
    '…',
    ':',
    ';',
    '"',
    '«',
    '»',
    '“',
    '”',
    '„',
    '(',
    '[',
    '—',
    '–',
    '-',
    '\n',
]);
const SKIPPED_BEFORE = new Set(['*', '_', '~', ' ', '\t', String.fromCharCode(0xa0)]);

/** Titles in front of a name: dropped, the name after them is kept. */
// prettier-ignore
const TITLES: ReadonlySet<string> = new Set([
    'mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'madam', 'madame', 'lady', 'lord', 'master', 'mister', 'mistress',
    'сэр', 'мисс', 'миссис', 'мистер', 'леди', 'лорд', 'госпожа', 'господин', 'доктор', 'мадам', 'мсье', 'месье',
]);

/** Capitalised words that are not names. */
// prettier-ignore
const COMMON: ReadonlySet<string> = new Set([
    'i', "i'm", "i'd", "i'll", "i've", 'god', 'gods', 'ok', 'okay', 'yes', 'no', 'oh', 'ah', 'hey', 'well', 'mom',
    'dad', 'mommy', 'daddy', 'mother', 'father', 'the', 'a', 'an', 'and', 'but', 'or', 'so', 'then', 'what', 'why',
    'how', 'who', 'where', 'when', 'please', 'thanks', 'sorry', 'hello', 'hi', 'goodbye', 'english', 'monday',
    'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april',
    'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'christmas',
    'вы', 'вас', 'вам', 'вами', 'ваш', 'ваша', 'ваше', 'ваши', 'вашего', 'вашей', 'вашу', 'твой', 'бог', 'боже',
    'господи', 'господь', 'мама', 'папа', 'мамочка', 'папочка', 'да', 'нет', 'ну', 'ох', 'ах', 'эй', 'и', 'но',
    'а', 'что', 'кто', 'как', 'где', 'когда', 'почему', 'зачем', 'пожалуйста', 'спасибо', 'привет', 'прости',
    'извини',
]);

/** Words joining a multi-word name («Order of Dawn», «фон Штерн»). */
// prettier-ignore
const CONNECTORS: ReadonlySet<string> = new Set([
    'of', 'de', 'van', 'von', 'der', 'del', 'la', 'le', 'du', 'фон', 'де', 'ван', 'ди',
]);

/** Normalised, stemmed key of a name («Блэквуда» and «Блэквуд» share it). */
export function nameKey(name: string): string {
    return textWords(name)
        .filter((word) => !CONNECTORS.has(word))
        .map(stemWord)
        .join(' ');
}

/** Keys of known names, with every word of three or more letters on its own («Anna Petrova» → also «anna»). */
export function knownNameKeys(names: Iterable<unknown>): Set<string> {
    const out = new Set<string>();
    for (const name of names) {
        if (typeof name !== 'string' || !name.trim()) continue;
        const key = nameKey(name);
        if (key) out.add(key);
        for (const word of key.split(' ')) if (word.length >= 3) out.add(word);
    }
    return out;
}

/** A candidate is known when its key or any of its words of three or more letters is known. */
export function isKnownName(key: string, known: ReadonlySet<string>): boolean {
    if (known.has(key)) return true;
    return key.split(' ').some((word) => word.length >= 3 && known.has(word));
}

interface Token {
    text: string;
    lower: string;
    index: number;
    end: number;
    capital: boolean;
}

function isCapitalised(word: string): boolean {
    return /^\p{Lu}/u.test(word) && /\p{Ll}/u.test(word);
}

/** The character before `index`, skipping spaces and markdown emphasis; '' at the start of the text. */
function charBefore(text: string, index: number): string {
    for (let i = index - 1; i >= 0; i--) {
        const char = text.charAt(i);
        if (char === '\n') return '\n';
        if (!SKIPPED_BEFORE.has(char)) return char;
    }
    return '';
}

function sentenceStart(text: string, index: number): boolean {
    const before = charBefore(text, index);
    return before === '' || SENTENCE_END.has(before);
}

/** Only spaces (no punctuation, no line break) between two tokens. */
function adjacent(text: string, a: Token, b: Token): boolean {
    return /^[ \t\xa0]+$/.test(text.slice(a.end, b.index));
}

function letters(word: string): number {
    return (word.match(/\p{L}/gu) ?? []).length;
}

function tokensOf(text: string): Token[] {
    const tokens: Token[] = [];
    for (const match of text.matchAll(WORD_RE)) {
        const word = match[0].replace(/['’-]+$/, '');
        const index = match.index ?? 0;
        tokens.push({
            text: word,
            lower: normalizeText(word),
            index,
            end: index + word.length,
            capital: isCapitalised(word),
        });
    }
    return tokens;
}

/** The capitalised run starting at `start`: capital words with connectors between them, only spaces around. */
function phraseAt(text: string, tokens: readonly Token[], start: number): { phrase: Token[]; next: number } {
    const phrase: Token[] = [tokens[start] as Token];
    let j = start + 1;
    while (j < tokens.length) {
        const next = tokens[j] as Token;
        const last = phrase[phrase.length - 1] as Token;
        if (!adjacent(text, last, next)) break;
        if (next.capital) {
            phrase.push(next);
            j++;
            continue;
        }
        const after = tokens[j + 1];
        if (!CONNECTORS.has(next.lower) || !after?.capital || !adjacent(text, next, after)) break;
        phrase.push(next, after);
        j += 2;
    }
    return { phrase, next: j };
}

/** Drops titles and common words at the edges and connectors left at the edges. */
function trimPhrase(phrase: Token[]): Token[] {
    const edge = (token: Token | undefined, front: boolean): boolean =>
        !!token && (COMMON.has(token.lower) || CONNECTORS.has(token.lower) || (front && TITLES.has(token.lower)));
    const out = [...phrase];
    while (edge(out[0], true)) out.shift();
    while (edge(out[out.length - 1], false)) out.pop();
    return out;
}

/** Capitalised phrases (1–3 words, connectors allowed inside) that do not start a sentence. */
function capitalisedNames(text: string): string[] {
    const tokens = tokensOf(text);
    const out: string[] = [];
    let i = 0;
    while (i < tokens.length) {
        const first = tokens[i] as Token;
        if (!first.capital) {
            i++;
            continue;
        }
        const previous = tokens[i - 1];
        const { phrase, next } = phraseAt(text, tokens, i);
        i = next;
        // «Mr. Hale»: the full stop of an abbreviated title does not end a sentence.
        const afterTitle =
            !!previous && TITLES.has(previous.lower) && /^\.\s+$/.test(text.slice(previous.end, first.index));
        if (!afterTitle && sentenceStart(text, first.index)) phrase.shift();
        const words = trimPhrase(phrase);
        const capitals = words.filter((token) => token.capital);
        if (!capitals.length || capitals.length > MAX_WORDS) continue;
        if (capitals.some((token) => letters(token.text) < 2)) continue;
        if (capitals.reduce((sum, token) => sum + letters(token.text), 0) < 3) continue;
        out.push(words.map((token) => token.text).join(' '));
    }
    return out;
}

/** «Name» right after a lower-case word (таверна «Ржавый якорь»), not direct speech (after «:», a dash or a line). */
function quotedNames(text: string): string[] {
    const out: string[] = [];
    for (const match of text.matchAll(QUOTED_RE)) {
        const before = match[1] ?? '';
        const inner = (match[2] ?? '').trim();
        if (!/\p{Ll}/u.test(before) || !/^\p{Lu}/u.test(inner)) continue;
        if (/[.!?,;:…—–()]/.test(inner)) continue;
        const words = inner.split(/\s+/);
        if (words.length > MAX_QUOTED_WORDS || letters(inner) < 2) continue;
        if (words.length === 1 && COMMON.has(normalizeText(inner))) continue;
        out.push(inner);
    }
    return out;
}

/** Name candidates of a reply, quoted ones first, unique by key, at most 20. */
export function findNameCandidates(text: string): NameCandidate[] {
    if (typeof text !== 'string' || !text.trim()) return [];
    const out: NameCandidate[] = [];
    const seen = new Set<string>();
    const add = (name: string, quoted: boolean) => {
        const key = nameKey(name);
        if (!key || seen.has(key) || out.length >= MAX_CANDIDATES) return;
        seen.add(key);
        out.push({ name, key, quoted });
    };
    for (const name of quotedNames(text)) add(name, true);
    for (const name of capitalisedNames(text)) add(name, false);
    return out;
}
