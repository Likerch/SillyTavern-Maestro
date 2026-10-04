// Contradiction rules (M26 п.5, P4 «сначала правила»): a new statement is compared sentence by sentence with the
// texts it must not contradict, in English and Russian, without a model:
// - names: one role of one person held by two different people («X is the father of Z» / «Z's father is Y» /
//   «X — отец Z» / «отец Z — Y»), or one person in two exclusive family roles;
// - numbers: the same unit about the same entity with different values (ages, counts, years);
// - dates: different years or days next to the same event words («born in 1850» / «born in 1852»);
// - negations: the same sentence with and without a negation («not», «never», «no longer», «не», «никогда»,
//   «больше не»).
// Sentences are compared only when they are about the same entity (a sentence without a name keeps the entity of the
// sentence before it). Every hit has a confidence; below CERTAIN the caller asks the cheap model. Pure and cheap.
import { hasCyrillic } from './canon-keys';
import { nameKey } from './signals-names';
import { monthNumber } from './signals-time';
import { STOP_WORDS, jaccard, normalizeText, stemWord, textWords } from './signals-tokens';

export type RuleKind = 'name' | 'number' | 'date' | 'negation';

export interface RuleInput {
    statement: string;
    entities: readonly string[];
    against: readonly { label: string; text: string }[];
}

export interface RuleHit {
    label: string;
    /** Short quote of the statement side. */
    statement: string;
    /** Short quote of the conflicting text. */
    conflicting: string;
    kind: RuleKind;
    confidence: number;
}

export interface RuleAnalysis {
    hits: RuleHit[];
    /** The rules are not sure (a weak hit, or numbers/negations about the same entity): worth asking the model. */
    suspicious: boolean;
}

/** Hits at or above this confidence need no model. */
export const CERTAIN = 0.8;

const MAX_STATEMENT_CHARS = 4000;
const MAX_TEXT_CHARS = 8000;
const MAX_AGAINST = 50;
const MAX_SENTENCES = 200;
const QUOTE_CHARS = 160;
const NEGATION_SAME = 0.6;
const NEGATION_CERTAIN = 0.85;
const PREFIX_EVENT = 5;

interface Quantity {
    value: number;
    unit: string;
}

interface DateMention {
    year?: number;
    month?: number;
    day?: number;
}

interface Role {
    holder: string;
    role: string;
    of: string;
    /** «a sister of»: not exclusive. */
    indefinite: boolean;
}

interface Sentence {
    text: string;
    entities: Set<string>;
    /** Entities named in this sentence (not carried over from the one before). */
    explicit: boolean;
    content: Set<string>;
    negated: boolean;
    quantities: Quantity[];
    dates: DateMention[];
    events: Set<string>;
    roles: Role[];
}

/* ------------------------------------------------------------------ vocabularies */

// prettier-ignore
const NUMBER_WORDS: Record<string, number> = {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
    два: 2, две: 2, двух: 2, двое: 2, три: 3, трех: 3, трое: 3, четыре: 4, четырех: 4, четверо: 4, пять: 5,
    пяти: 5, пятеро: 5, шесть: 6, шести: 6, шестеро: 6, семь: 7, семи: 7, семеро: 7, восемь: 8, восьми: 8,
    девять: 9, девяти: 9, десять: 10, десяти: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13,
    четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
    двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80,
    девяносто: 90, сто: 100,
};

const YEAR_UNITS = new Set(['year', 'years', 'yr', 'yrs', 'лет', 'год', 'года', 'году']);
const AGE_BEFORE = new Set(['aged', 'age', 'ей', 'ему', 'им', 'мне', 'тебе', 'исполнилось', 'исполнится', 'возрасте']);
const DURATION_BEFORE = new Set(['за', 'через', 'уже', 'на', 'течение', 'прошло', 'спустя', 'for', 'after', 'in']);
const DURATION_AFTER = new Set(['назад', 'спустя', 'ago', 'later']);

/** Words that start no name (pronouns, articles, links), checked after normalisation. */
// prettier-ignore
const NOT_NAMES: ReadonlySet<string> = new Set([
    'she', 'he', 'they', 'it', 'we', 'you', 'i', 'her', 'his', 'their', 'its', 'the', 'a', 'an', 'this', 'that',
    'there', 'then', 'but', 'and', 'or', 'if', 'when', 'after', 'before', 'now', 'yes', 'no', 'not', 'never',
    'он', 'она', 'они', 'оно', 'мы', 'вы', 'ты', 'я', 'его', 'ее', 'их', 'это', 'этот', 'эта', 'там', 'тогда', 'но',
    'и', 'а', 'или', 'если', 'когда', 'после', 'до', 'теперь', 'да', 'нет', 'не', 'никогда', 'в', 'на', 'у',
]);

const NEGATION_EN =
    /(?:^|[^\p{L}])(?:not|never|no|cannot|nobody|nothing|none|neither|nor)(?![\p{L}])|n['’]t(?![\p{L}])/iu;
const NEGATION_RU = /(?:^|[^\p{L}])(?:не|ни|никогда|нет|нету|никто|ничего|ничто|никого|нигде)(?![\p{L}])/iu;
/** Removed from the content words compared by the negation rule. */
// prettier-ignore
const NEGATION_WORDS: ReadonlySet<string> = new Set([
    'not', 'never', 'longer', 'more', 'cannot', 'nobody', 'nothing', 'none', 'neither', 'nor', 'any', 'anymore',
    'doesn', 'don', 'didn', 'isn', 'aren', 'wasn', 'weren', 'can', 'won', 'hasn', 'haven', 'hadn', 'couldn',
    'wouldn', 'shouldn', 'does', 'did', 'will', 'would', 'could', 'should',
    'никогда', 'нет', 'нету', 'никто', 'ничего', 'ничто', 'никого', 'нигде', 'больше', 'уже', 'был', 'была',
    'было', 'были', 'является',
]);

// prettier-ignore
const ROLE_STEMS = [
    'father', 'mother', 'son', 'daughter', 'brother', 'sister', 'husband', 'wife', 'uncle', 'aunt', 'cousin',
    'grandfather', 'grandmother', 'nephew', 'niece', 'king', 'queen', 'prince', 'princess', 'ruler', 'lord', 'lady',
    'owner', 'leader', 'head', 'captain', 'master', 'mistress', 'teacher', 'mentor', 'apprentice', 'student',
    'servant', 'maid', 'guard', 'friend', 'lover', 'fiance', 'fiancee', 'heir', 'founder', 'mayor', 'chief',
    'commander', 'general', 'keeper', 'innkeeper', 'priest', 'boss', 'partner', 'ally', 'enemy', 'rival', 'creator',
    'author', 'healer', 'blacksmith', 'twin',
    'отец', 'отц', 'мать', 'матер', 'сын', 'доч', 'брат', 'сестр', 'муж', 'жен', 'дяд', 'тет', 'кузен', 'кузин',
    'дед', 'бабушк', 'племянник', 'племянниц', 'корол', 'принц', 'правител', 'лорд', 'леди', 'владел', 'хозя',
    'лидер', 'глав', 'капитан', 'мастер', 'учител', 'наставник', 'учени', 'слуг', 'служанк', 'страж', 'друг',
    'подруг', 'любовни', 'невест', 'жених', 'наследни', 'основател', 'мэр', 'вожд', 'командир', 'генерал',
    'хранител', 'трактирщи', 'жрец', 'жриц', 'начальни', 'партнер', 'союзни', 'враг', 'соперни', 'создател',
    'автор', 'целител', 'кузнец', 'близнец',
];

/** Stems of one role in other case forms («отцом» → «отц» = «отец», «матери» → «матер» = «мать»). */
const ROLE_ALIASES: Record<string, string> = { отц: 'отец', матер: 'мать' };

/** Roles one person holds for another at a time (two holders contradict). */
// prettier-ignore
const UNIQUE_ROLES: ReadonlySet<string> = new Set([
    'father', 'mother', 'husband', 'wife', 'king', 'queen', 'ruler', 'owner', 'leader', 'head', 'captain', 'mayor',
    'chief', 'founder', 'heir', 'creator', 'author',
    'отец', 'отц', 'мать', 'матер', 'муж', 'жен', 'корол', 'правител', 'владел', 'хозя', 'глав', 'капитан', 'мэр',
    'вожд', 'основател', 'наследни', 'создател', 'автор',
]);

/** Family roles that exclude each other for the same pair («X is Z's sister» vs «X is Z's wife»). */
const FAMILY_GROUPS: Record<string, string> = {
    father: 'parent',
    mother: 'parent',
    отец: 'parent',
    отц: 'parent',
    мать: 'parent',
    матер: 'parent',
    son: 'child',
    daughter: 'child',
    сын: 'child',
    доч: 'child',
    brother: 'sibling',
    sister: 'sibling',
    брат: 'sibling',
    сестр: 'sibling',
    husband: 'spouse',
    wife: 'spouse',
    муж: 'spouse',
    жен: 'spouse',
};

/** Stems of once-in-a-life events: two dates of one of them about a named person are a sure contradiction. */
// prettier-ignore
const EVENT_STEMS = [
    'born', 'birth', 'die', 'death', 'kill', 'found', 'built', 'build', 'marri', 'marry', 'crown',
    'родил', 'рожд', 'умер', 'погиб', 'смерт', 'основ', 'постро', 'женил', 'замуж', 'свадьб', 'корон', 'убит',
];

/* ------------------------------------------------------------------ helpers */

function clip(text: string, max = QUOTE_CHARS): string {
    const value = text.replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    const cut = value.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function splitSentences(text: string, limit: number): string[] {
    return text
        .slice(0, limit)
        .split(/(?<=[.!?…])\s+|\n+|;\s+/)
        .map((sentence) => sentence.trim())
        .filter((sentence) => /\p{L}/u.test(sentence))
        .slice(0, MAX_SENTENCES);
}

/** Original words with their positions (letters and digits). */
function wordsOf(text: string): { raw: string; lower: string }[] {
    return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ raw: match[0], lower: normalizeText(match[0]) }));
}

/** Role key of a word (the matching stem), or null when the word is no role. */
export function roleKey(word: string): string | null {
    const value = normalizeText(word);
    if (!value) return null;
    if (hasCyrillic(value)) {
        let best: string | null = null;
        for (const stem of ROLE_STEMS) {
            if (!hasCyrillic(stem) || !value.startsWith(stem) || value.length - stem.length > 4) continue;
            if (!best || stem.length > best.length) best = stem;
        }
        return best ? (ROLE_ALIASES[best] ?? best) : null;
    }
    const singular = value.endsWith('s') && !value.endsWith('ss') ? value.slice(0, -1) : value;
    return ROLE_STEMS.includes(value) ? value : ROLE_STEMS.includes(singular) ? singular : null;
}

/** Entity names mentioned in a sentence: whole words for Latin names, a stem plus a short ending for Cyrillic. */
function mentioned(words: readonly { lower: string }[], entities: readonly { name: string; needles: string[] }[]) {
    const found = new Set<string>();
    for (const entity of entities) {
        const hit = entity.needles.some((needle) =>
            words.some((word) =>
                hasCyrillic(needle)
                    ? word.lower.startsWith(needle) && word.lower.length - needle.length <= 3
                    : word.lower === needle,
            ),
        );
        if (hit) found.add(entity.name);
    }
    return found;
}

function needlesOf(name: string): string[] {
    const words = normalizeText(name)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !NOT_NAMES.has(word));
    return words.map((word) => (hasCyrillic(word) ? stemWord(word) : word));
}

/** Capitalised words of a text that may be names (used when the caller gave no entities). */
function capitalisedNames(text: string): string[] {
    const out = new Set<string>();
    for (const match of text.matchAll(/\p{Lu}\p{Ll}{2,}/gu)) {
        const word = match[0];
        if (!NOT_NAMES.has(normalizeText(word)) && !STOP_WORDS.has(normalizeText(word))) out.add(word);
    }
    return [...out];
}

function quantitiesOf(words: readonly { raw: string; lower: string }[]): Quantity[] {
    const out: Quantity[] = [];
    words.forEach((word, i) => {
        const value = /^\d{1,4}$/.test(word.lower) ? Number(word.lower) : NUMBER_WORDS[word.lower];
        if (value === undefined) return;
        const before = words[i - 1];
        const next = words[i + 1];
        const after = words[i + 2];
        if (next && /^\d+$/.test(next.lower)) return;
        if (before && /^\d+$/.test(before.lower)) return;
        if (!next) {
            // «Anna is 25.» — a bare number after a verb: an age when the sentence says so elsewhere.
            if (before && ['is', 'was', 'aged', 'age'].includes(before.lower)) out.push({ value, unit: 'age' });
            return;
        }
        // «in 1850», «в 1850 году» are dates; only «1000 years / 1000 лет» is an amount.
        if (/^\d{4}$/.test(word.lower) && !['years', 'yrs', 'лет'].includes(next.lower)) return;
        if (YEAR_UNITS.has(next.lower) || /^летн/.test(next.lower)) {
            const durationAfter = after && DURATION_AFTER.has(after.lower);
            const durationBefore = before && DURATION_BEFORE.has(before.lower);
            const old = after?.lower === 'old' || /^летн/.test(next.lower);
            // «Анне 25 лет», «ей было 25 лет»: a dative name or pronoun one or two words before.
            const ageBefore = [before, words[i - 2]].some(
                (item) => !!item && (AGE_BEFORE.has(item.lower) || /^\p{Lu}/u.test(item.raw)),
            );
            if (durationAfter || (durationBefore && !old)) return;
            out.push({ value, unit: old || ageBefore ? 'age' : 'year' });
            return;
        }
        if (before && AGE_BEFORE.has(before.lower) && !hasCyrillic(before.lower)) {
            out.push({ value, unit: 'age' });
            return;
        }
        const unit = [next, after]
            .filter((item): item is { raw: string; lower: string } => !!item)
            .map((item) => item.lower)
            .find((item) => item.length >= 3 && !STOP_WORDS.has(item) && !/^\d+$/.test(item));
        if (unit) out.push({ value, unit: stemWord(unit) });
    });
    return out;
}

function datesOf(words: readonly { raw: string; lower: string }[]): DateMention[] {
    const out: DateMention[] = [];
    words.forEach((word, i) => {
        const month = monthNumber(word.lower);
        if (month !== undefined) {
            const near = [words[i - 1], words[i + 1]].find((item) => item && /^\d{1,2}$/.test(item.lower));
            if (!near) return;
            const mention: DateMention = { month, day: Number(near.lower) };
            const year = words.slice(i + 1, i + 4).find((item) => /^\d{4}$/.test(item.lower));
            if (year) mention.year = Number(year.lower);
            out.push(mention);
            return;
        }
        if (!/^\d{3,4}$/.test(word.lower)) return;
        const value = Number(word.lower);
        const next = words[i + 1]?.lower;
        const previous = words[i - 1]?.lower;
        const yearWord = next !== undefined && ['год', 'году', 'года', 'г'].includes(next);
        // The year of «March 5, 1856» / «5 марта 1856» already belongs to the month mention.
        const twoBack = words[i - 2]?.lower;
        if (twoBack !== undefined && monthNumber(twoBack) !== undefined) return;
        if (previous !== undefined && monthNumber(previous) !== undefined) return;
        if (yearWord || (value >= 1000 && value <= 2999 && !YEAR_UNITS.has(next ?? ''))) out.push({ year: value });
    });
    return out;
}

/** Content tokens that may name an event: no numbers, months or entity names. */
function eventsOf(content: ReadonlySet<string>, names: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const token of content) {
        if (/^\d+$/.test(token) || monthNumber(token) !== undefined || names.has(token)) continue;
        out.add(token);
    }
    return out;
}

function commonPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
}

/** Shared event words: equal stems, or Cyrillic stems with a common prefix of five letters («родился»/«родилась»). */
function sharedEvents(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const left of a) {
        for (const right of b) {
            if (left === right || (hasCyrillic(left) && commonPrefix(left, right) >= PREFIX_EVENT)) out.push(left);
        }
    }
    return out;
}

function uniqueEvent(words: readonly string[]): boolean {
    return words.some((word) => EVENT_STEMS.some((stem) => word.startsWith(stem)));
}

const NAME = String.raw`\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?`;
const NAMES = String.raw`\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)*`;
const ADJ = String.raw`(?:(?:new|current|former|only|eldest|youngest|older|younger|elder|true|real)\s+)?`;
const ROLE = String.raw`(\p{Ll}+)`;
const RU_LINK = String.raw`(?:является|был|была|стал|стала|приходится)`;

interface RolePattern {
    re: RegExp;
    holder: number;
    role: number;
    of: number;
    article?: number;
    /** The role word comes first and may open the sentence with a capital («Сестра Ивана — Анна»). */
    lowerFirst?: boolean;
}

const pattern = (parts: string[], groups: Omit<RolePattern, 're'>): RolePattern => ({
    re: new RegExp(parts.join(''), 'gu'),
    ...groups,
});

const ROLE_PATTERNS: RolePattern[] = [
    // X is the Y of Z
    pattern(
        [
            String.raw`(${NAME})\s+(?:is|was|became|remains)\s+(the|a|an|his|her|their)\s+`,
            ADJ,
            ROLE,
            String.raw`\s+of\s+(?:the\s+)?(${NAMES})`,
        ],
        { holder: 1, article: 2, role: 3, of: 4 },
    ),
    // Z's Y is X
    pattern([String.raw`(${NAME})['’]s?\s+`, ADJ, ROLE, String.raw`\s+(?:is|was)\s+(?:named\s+|called\s+)?(${NAME})`], {
        of: 1,
        role: 2,
        holder: 3,
    }),
    // the Y of Z is X
    pattern(
        [
            String.raw`(?:^|\s)[Tt]he\s+`,
            ADJ,
            ROLE,
            String.raw`\s+of\s+(?:the\s+)?(${NAMES})\s+(?:is|was)\s+(?:named\s+|called\s+)?(${NAME})`,
        ],
        { role: 1, of: 2, holder: 3 },
    ),
    // X is Z's Y
    pattern([String.raw`(${NAME})\s+(?:is|was)\s+(${NAME})['’]s?\s+`, ADJ, ROLE], { holder: 1, of: 2, role: 3 }),
    // X — Y Z
    pattern([String.raw`(${NAME})\s+[—–-]\s+(?:(?:его|её|ее|их)\s+)?`, ROLE, String.raw`\s+(${NAME})`], {
        holder: 1,
        role: 2,
        of: 3,
    }),
    // Y Z — X
    pattern([String.raw`(?:^|[^\p{L}])`, ROLE, String.raw`\s+(${NAME})\s+[—–-]\s+(${NAME})`], {
        role: 1,
        of: 2,
        holder: 3,
        lowerFirst: true,
    }),
    // X является Y Z
    pattern([String.raw`(${NAME})\s+`, RU_LINK, String.raw`\s+`, ROLE, String.raw`\s+(${NAME})`], {
        holder: 1,
        role: 2,
        of: 3,
    }),
    // Y Z является X
    pattern([String.raw`(?:^|[^\p{L}])`, ROLE, String.raw`\s+(${NAME})\s+`, RU_LINK, String.raw`\s+(${NAME})`], {
        role: 1,
        of: 2,
        holder: 3,
        lowerFirst: true,
    }),
];
function rolesOf(text: string): Role[] {
    const out: Role[] = [];
    const lowered = text.replace(/^\p{Lu}/u, (char) => char.toLowerCase());
    for (const rolePattern of ROLE_PATTERNS) {
        const source = rolePattern.lowerFirst ? lowered : text;
        for (const match of source.matchAll(rolePattern.re)) {
            const role = roleKey(match[rolePattern.role] ?? '');
            const holder = nameKey(match[rolePattern.holder] ?? '');
            const of = nameKey(match[rolePattern.of] ?? '');
            if (!role || !holder || !of || holder === of) continue;
            const article = rolePattern.article ? (match[rolePattern.article] ?? '').toLowerCase() : '';
            if (out.some((item) => item.holder === holder && item.role === role && item.of === of)) continue;
            out.push({ holder, role, of, indefinite: article === 'a' || article === 'an' });
        }
    }
    return out;
}

/** Content tokens without negations and copulas (the negation rule compares what is left). */
function contentOf(text: string): Set<string> {
    const out = new Set<string>();
    for (const word of textWords(text)) {
        if (NEGATION_WORDS.has(word) || STOP_WORDS.has(word) || (word.length < 3 && !/^\d+$/.test(word))) continue;
        out.add(stemWord(word));
    }
    return out;
}

function analyseText(
    text: string,
    limit: number,
    entities: readonly { name: string; needles: string[] }[],
    inherit: Set<string>,
): Sentence[] {
    let carried = new Set(inherit);
    const names = new Set(entities.flatMap((entity) => entity.needles.map(stemWord)));
    return splitSentences(text, limit).map((sentence) => {
        const words = wordsOf(sentence);
        const named = mentioned(words, entities);
        const explicit = named.size > 0;
        if (explicit) carried = named;
        const content = contentOf(sentence);
        return {
            text: sentence,
            entities: explicit ? named : new Set(carried),
            explicit,
            content,
            negated: NEGATION_EN.test(sentence) || NEGATION_RU.test(sentence),
            quantities: quantitiesOf(words),
            dates: datesOf(words),
            events: eventsOf(content, names),
            roles: rolesOf(sentence),
        };
    });
}

function shareEntity(a: Sentence, b: Sentence): boolean {
    for (const entity of a.entities) if (b.entities.has(entity)) return true;
    return false;
}

/* ------------------------------------------------------------------ rules */

function numberHits(s: Sentence, a: Sentence): { confidence: number } | null {
    let best: number | null = null;
    for (const left of s.quantities) {
        for (const right of a.quantities) {
            if (left.unit !== right.unit || left.value === right.value) continue;
            const confidence = left.unit === 'age' ? (s.explicit && a.explicit ? 0.85 : 0.65) : 0.6;
            best = Math.max(best ?? 0, confidence);
        }
    }
    return best === null ? null : { confidence: best };
}

function dateHits(s: Sentence, a: Sentence): { confidence: number } | null {
    if (!s.dates.length || !a.dates.length) return null;
    const events = sharedEvents(s.events, a.events);
    if (!events.length) return null;
    const differ = s.dates.some((left) =>
        a.dates.some((right) => {
            if (left.year !== undefined && right.year !== undefined && left.year !== right.year) return true;
            const days = left.month !== undefined && right.month !== undefined;
            const sameYear = left.year === undefined || right.year === undefined || left.year === right.year;
            return days && sameYear && (left.month !== right.month || left.day !== right.day);
        }),
    );
    if (!differ) return null;
    return { confidence: uniqueEvent(events) && s.explicit && a.explicit ? 0.85 : 0.6 };
}

function negationHit(s: Sentence, a: Sentence): { confidence: number } | null {
    if (s.negated === a.negated) return null;
    if (Math.min(s.content.size, a.content.size) < 2) return null;
    const similarity = jaccard(s.content, a.content);
    if (similarity < NEGATION_SAME) return null;
    return { confidence: similarity >= NEGATION_CERTAIN ? 0.85 : 0.65 };
}

function roleHit(s: Sentence, a: Sentence): { confidence: number } | null {
    let best: number | null = null;
    for (const left of s.roles) {
        for (const right of a.roles) {
            if (left.of !== right.of) continue;
            if (left.role === right.role) {
                if (left.indefinite || right.indefinite) continue;
                if (left.holder === right.holder) continue;
                if (left.holder.startsWith(right.holder) || right.holder.startsWith(left.holder)) continue;
                best = Math.max(best ?? 0, UNIQUE_ROLES.has(left.role) ? 0.75 : 0.45);
            } else if (left.holder === right.holder) {
                const groupA = FAMILY_GROUPS[left.role];
                const groupB = FAMILY_GROUPS[right.role];
                if (groupA && groupB && groupA !== groupB) best = Math.max(best ?? 0, 0.5);
            }
        }
    }
    return best === null ? null : { confidence: best };
}

/** Runs every rule over the statement and each text it must not contradict. */
export function analyseContradictions(input: RuleInput): RuleAnalysis {
    const statement = typeof input.statement === 'string' ? input.statement : '';
    const against = (Array.isArray(input.against) ? input.against : [])
        .filter((item) => item && typeof item.text === 'string' && item.text.trim())
        .slice(0, MAX_AGAINST);
    if (!statement.trim() || !against.length) return { hits: [], suspicious: false };
    const given = (Array.isArray(input.entities) ? input.entities : []).filter(
        (name): name is string => typeof name === 'string' && !!name.trim(),
    );
    const names = given.length ? given : capitalisedNames(statement);
    const entities = names.map((name) => ({ name: normalizeText(name), needles: needlesOf(name) }));
    const usable = entities.filter((entity) => entity.needles.length);
    const statementSentences = analyseText(
        statement,
        MAX_STATEMENT_CHARS,
        usable,
        new Set(given.length ? usable.map((entity) => entity.name) : []),
    );
    const hits = new Map<string, RuleHit>();
    let suspicious = false;
    const add = (label: string, s: Sentence, a: Sentence, kind: RuleKind, confidence: number) => {
        const key = `${label}\u0000${kind}\u0000${s.text}\u0000${a.text}`;
        const existing = hits.get(key);
        if (existing && existing.confidence >= confidence) return;
        hits.set(key, { label, statement: clip(s.text), conflicting: clip(a.text), kind, confidence });
    };
    for (const item of against) {
        const sentences = analyseText(item.text, MAX_TEXT_CHARS, usable, new Set());
        for (const s of statementSentences) {
            for (const a of sentences) {
                const role = roleHit(s, a);
                if (role) add(item.label, s, a, 'name', role.confidence);
                const related = usable.length ? shareEntity(s, a) : jaccard(s.content, a.content) >= 0.3;
                if (!related) continue;
                const number = numberHits(s, a);
                if (number) add(item.label, s, a, 'number', number.confidence);
                const date = dateHits(s, a);
                if (date) add(item.label, s, a, 'date', date.confidence);
                const negation = negationHit(s, a);
                if (negation) add(item.label, s, a, 'negation', negation.confidence);
                // A pair about one entity with figures (or a negation) on both sides that no rule could settle.
                if (role || number || date || negation) continue;
                const figures = (x: Sentence) => x.quantities.length > 0 || x.dates.length > 0;
                if (figures(s) && figures(a)) suspicious = true;
                if (s.negated !== a.negated && sharedEvents(s.content, a.content).length >= 2) suspicious = true;
            }
        }
    }
    const list = [...hits.values()].sort((a, b) => b.confidence - a.confidence);
    if (list.some((hit) => hit.confidence < CERTAIN)) suspicious = true;
    return { hits: list, suspicious };
}

/** Rule hits only (quick check). */
export function quickContradictions(input: RuleInput): RuleHit[] {
    return analyseContradictions(input).hits;
}
