// Word sets for comparing free text (plan §4.4 «шумоподавление»): DES rewrites the same outfit, location, quest or
// relationship in other words from turn to turn, so a change counts only when the normalised word sets differ enough.
// Words are lower case with ё → е, short and filler words dropped, Russian case endings and English plural/verb
// endings cut off, so «чёрные волосы» and «чёрными волосами» are one set. Shared with the contradiction rules.
// Pure: no DOM, no SillyTavern.

const WORD_SPLIT_RE = /[^\p{L}\p{N}]+/u;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const DIGITS_RE = /^\p{N}+$/u;

/** Russian endings, longest first: one is cut from a word that keeps at least three letters. */
// prettier-ignore
const RU_ENDINGS = [
    'иями', 'ями', 'ами', 'ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ую', 'юю', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
    'ый', 'ий', 'ой', 'ей', 'ом', 'ем', 'ым', 'им', 'ам', 'ям', 'ах', 'ях', 'их', 'ых', 'ов', 'ев', 'ью', 'ия', 'ья',
    'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
];

/** Words that carry no content in descriptions (articles, pronouns, links, intensifiers). */
// prettier-ignore
export const STOP_WORDS: ReadonlySet<string> = new Set([
    // English
    'the', 'and', 'with', 'her', 'his', 'its', 'their', 'she', 'him', 'they', 'them', 'this', 'that', 'these',
    'those', 'for', 'from', 'into', 'onto', 'over', 'under', 'very', 'slightly', 'quite', 'rather', 'somewhat',
    'some', 'bit', 'also', 'still', 'now', 'currently', 'wearing', 'wears', 'wore', 'has', 'have', 'had', 'are',
    'was', 'were', 'been', 'being', 'is', 'who', 'which', 'while', 'about', 'around', 'one', 'own',
    // Russian
    'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'за', 'из', 'от', 'до', 'для', 'при', 'под', 'над', 'без',
    'её', 'ее', 'его', 'их', 'она', 'он', 'они', 'оно', 'это', 'этот', 'эта', 'эти', 'тот', 'та', 'те', 'то',
    'очень', 'слегка', 'немного', 'чуть', 'довольно', 'весьма', 'также', 'тоже', 'ещё', 'еще', 'всё', 'все',
    'уже', 'сейчас', 'теперь', 'одет', 'одета', 'одеты', 'носит', 'который', 'которая', 'которые', 'свой',
    'своя', 'свои', 'своё', 'свое', 'как', 'так', 'но', 'а', 'или', 'же', 'бы', 'ли',
]);

/** NFC, lower case, ё → е, whitespace runs → one space, trimmed. */
export function normalizeText(text: string): string {
    return String(text ?? '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Words of a text (letters and digits), normalised. */
export function textWords(text: string): string[] {
    return normalizeText(text).split(WORD_SPLIT_RE).filter(Boolean);
}

/**
 * A crude stem: one Russian ending cut (the stem keeps ≥ 3 letters); English plurals, -ing and -ed cut. Enough to
 * make case forms and plurals one token; not a linguistic stemmer.
 */
export function stemWord(word: string): string {
    const value = normalizeText(word);
    if (!value || DIGITS_RE.test(value)) return value;
    if (CYRILLIC_RE.test(value)) {
        for (const ending of RU_ENDINGS) {
            if (value.endsWith(ending) && value.length - ending.length >= 3) return value.slice(0, -ending.length);
        }
        return value;
    }
    if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
    if (value.length > 5 && value.endsWith('sses')) return value.slice(0, -2);
    if (value.length > 5 && value.endsWith('ing')) return value.slice(0, -3);
    if (value.length > 4 && value.endsWith('ed')) return value.slice(0, -2);
    if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
    return value;
}

/** Content tokens of a text: stems of words of three or more letters (or numbers) that are not stop words. */
export function tokenSet(text: string): Set<string> {
    const out = new Set<string>();
    for (const word of textWords(text)) {
        if (STOP_WORDS.has(word)) continue;
        if (word.length < 3 && !DIGITS_RE.test(word)) continue;
        out.add(stemWord(word));
    }
    return out;
}

/** |A ∩ B| / |A ∪ B|; two empty sets are equal (1). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
    if (!a.size && !b.size) return 1;
    let common = 0;
    for (const token of a) if (b.has(token)) common++;
    return common / (a.size + b.size - common);
}

/** Every token of `inner` is in `outer` (and `inner` is not empty). */
export function containsAll(outer: ReadonlySet<string>, inner: ReadonlySet<string>): boolean {
    if (!inner.size) return false;
    for (const token of inner) if (!outer.has(token)) return false;
    return true;
}

export function sameTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    return a.size === b.size && containsAll(a, b);
}

/**
 * Two descriptions differ meaningfully: their token sets are less similar than `threshold` (Jaccard) and at least
 * two tokens differ. Texts without content tokens differ only when their normalised text differs.
 */
export function textsDiffer(a: string, b: string, threshold: number): boolean {
    const left = tokenSet(a);
    const right = tokenSet(b);
    if (!left.size && !right.size) return normalizeText(a) !== normalizeText(b);
    let common = 0;
    for (const token of left) if (right.has(token)) common++;
    const differing = left.size + right.size - 2 * common;
    return jaccard(left, right) < threshold && differing >= 2;
}

/** Words added and removed between two descriptions (first spelling of each stem, at most `limit` each). */
export function wordDiff(from: string, to: string, limit = 8): { added: string[]; removed: string[] } {
    const firstOf = (text: string): Map<string, string> => {
        const map = new Map<string, string>();
        for (const word of textWords(text)) {
            if (STOP_WORDS.has(word) || (word.length < 3 && !DIGITS_RE.test(word))) continue;
            const stem = stemWord(word);
            if (!map.has(stem)) map.set(stem, word);
        }
        return map;
    };
    const before = firstOf(from);
    const after = firstOf(to);
    const added = [...after].filter(([stem]) => !before.has(stem)).map(([, word]) => word);
    const removed = [...before].filter(([stem]) => !after.has(stem)).map(([, word]) => word);
    return { added: added.slice(0, limit), removed: removed.slice(0, limit) };
}
