// The assistant's knowledge base (M33, stage 13: «знает документацию Maestro и стека»), pure: topics in English and/or
// Russian (README and CHANGELOG split by their `##` sections, a hand-written module and stack catalogue), a small
// scoring search that works for both languages (lower case, ё → е, crude stemming of Russian and English endings,
// prefix matches at half weight, coverage of the query's words, phrase bonus) and lookup of one topic by id or title.
// No index files, no network: everything is built from strings at start.

export type DocLocale = 'en' | 'ru';

export interface LocalText {
    en?: string;
    ru?: string;
}

export type DocKind = 'module' | 'stack' | 'guide' | 'readme' | 'changelog';

export interface DocTopic {
    /** Stable, ASCII: `module.director`, `stack.des`, `changelog.1.8.0`, `readme.trebovaniya`. */
    id: string;
    kind: DocKind;
    title: LocalText;
    /** Extra search words (synonyms, both languages). */
    keywords?: readonly string[];
    body: LocalText;
}

export interface DocHit {
    id: string;
    kind: DocKind;
    title: string;
    score: number;
    /** The best matching sentence of the topic, cut. */
    snippet: string;
}

export interface SearchOptions {
    locale: DocLocale;
    /** Hits returned (default 5). */
    limit?: number;
    /** Only these kinds. */
    kinds?: readonly DocKind[];
    /** Characters of a snippet (default 220). */
    snippetChars?: number;
}

/* ------------------------------------------------------------------ text */

/** Lower case, ё → е, markdown emphasis and links reduced to their text. */
export function normalizeText(text: string): string {
    return text.toLowerCase().replace(/ё/g, 'е');
}

const STOP = new Set(
    (
        'a an and are as at be but by can do does did for from has have how i if in is it its me my no not of on or ' +
        'so that the their them then there these this to was what when where which who why will with you your ' +
        'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от ' +
        'меня еще нет о об из ему когда даже ну ли если уже или ни быть был него до вас нибудь уж вам ведь там потом ' +
        'себя ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без чего раз тоже себе под будет ' +
        'ж тогда кто этот того потому этого какой ним здесь этом мой тем чтобы нее сейчас были куда зачем всех можно ' +
        'при эти нас про всего них какая эту моя свою этой перед том такой им всю между почему это'
    ).split(' '),
);

const RU_ENDINGS = [
    'иями',
    'ями',
    'ами',
    'ость',
    'ости',
    'ться',
    'тся',
    'ией',
    'иям',
    'ием',
    'иях',
    'ого',
    'его',
    'ому',
    'ему',
    'ыми',
    'ими',
    'ешь',
    'ете',
    'ить',
    'ать',
    'ять',
    'еть',
    'уть',
    'ала',
    'ила',
    'ыла',
    'ела',
    'ало',
    'ило',
    'ов',
    'ев',
    'ей',
    'ий',
    'ый',
    'ой',
    'ая',
    'яя',
    'ое',
    'ее',
    'ые',
    'ие',
    'ую',
    'юю',
    'ом',
    'ем',
    'ам',
    'ям',
    'ах',
    'ях',
    'ия',
    'ья',
    'ье',
    'ью',
    'а',
    'я',
    'о',
    'е',
    'ы',
    'и',
    'у',
    'ю',
    'ь',
    'й',
];

/** Crude stem: one Russian ending, or an English plural then -ing/-ed/-ly; never shorter than 3 letters. */
export function stem(token: string): string {
    if (/[а-я]/.test(token)) {
        for (const ending of RU_ENDINGS) {
            if (token.endsWith(ending) && token.length - ending.length >= 3) return token.slice(0, -ending.length);
        }
        return token;
    }
    let word = token;
    if (word.length > 4 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
    else if (word.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(word)) word = word.slice(0, -2);
    else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
    for (const ending of ['ing', 'ed', 'ly']) {
        if (word.endsWith(ending) && word.length - ending.length >= 3) return word.slice(0, -ending.length);
    }
    return word;
}

/** Words of a text (letters and digits of any alphabet), stop words dropped. */
export function tokenize(text: string): string[] {
    // Dotted runs stay whole (versions `1.8.0`, `m13.title`); hyphenated words split (`DES-RU`, «Лор-студия»).
    const words = normalizeText(text).match(/[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)*/gu) ?? [];
    return words.filter((word) => word.length > 1 && !STOP.has(word));
}

/** Stems of a text's words. */
export function stems(text: string): string[] {
    return tokenize(text).map(stem);
}

const TRANSLIT: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
};

/** ASCII slug of a heading (Cyrillic transliterated): «Что умеет сейчас» → `chto-umeet-seychas`. */
export function slugify(text: string): string {
    const ascii = [...normalizeText(text)].map((char) => TRANSLIT[char] ?? char).join('');
    return (
        ascii
            .replace(/[^a-z0-9.]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48)
            .replace(/-+$/, '') || 'section'
    );
}

/** The text in the wanted language, else the other one. */
export function localText(text: LocalText, locale: DocLocale): string {
    return (locale === 'ru' ? (text.ru ?? text.en) : (text.en ?? text.ru)) ?? '';
}

/** Markdown reduced for the model: links → their text, emphasis marks dropped, blank runs collapsed. */
export function plainMarkdown(md: string): string {
    return md
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\r\n?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface SplitOptions {
    /** Id prefix: `readme`, `changelog`. */
    prefix: string;
    kind: DocKind;
    lang: DocLocale;
}

/**
 * One topic per `##` section; the text before the first one (under the `#` title) is `<prefix>.intro`. A heading
 * that starts with a version (`## 1.8.0 — …`) gets the version as its id.
 */
export function splitMarkdown(md: string, options: SplitOptions): DocTopic[] {
    const lines = plainMarkdown(md).split('\n');
    const topics: DocTopic[] = [];
    let title = '';
    let heading: string | null = null;
    let buffer: string[] = [];
    const used = new Set<string>();
    const flush = () => {
        const text = buffer.join('\n').trim();
        buffer = [];
        if (!text && heading === null) return;
        const name = heading ?? title;
        const version = heading ? /^(\d+\.\d+\.\d+)/.exec(heading) : null;
        const base = `${options.prefix}.${heading === null ? 'intro' : version ? version[1] : slugify(heading)}`;
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        topics.push({
            id,
            kind: options.kind,
            title: { [options.lang]: name },
            body: { [options.lang]: text },
        });
    };
    for (const line of lines) {
        const h1 = /^#\s+(.+)$/.exec(line);
        const h2 = /^##\s+(.+)$/.exec(line);
        if (h1 && !title && heading === null && !buffer.join('').trim()) {
            title = h1[1]?.trim() ?? '';
            continue;
        }
        if (h2) {
            flush();
            heading = h2[1]?.trim() ?? '';
            continue;
        }
        buffer.push(line);
    }
    flush();
    return topics;
}

/* ------------------------------------------------------------------ index */

interface TopicIndex {
    title: Set<string>;
    keywords: Set<string>;
    id: Set<string>;
    body: Map<string, number>;
    /** Every stem of the topic (prefix matches). */
    all: string[];
    /** Normalised title + body (phrase matches). */
    flat: string;
}

const indexCache = new WeakMap<DocTopic, TopicIndex>();

function indexOf(topic: DocTopic): TopicIndex {
    const cached = indexCache.get(topic);
    if (cached) return cached;
    const titleText = `${topic.title.en ?? ''} ${topic.title.ru ?? ''}`;
    const bodyText = `${topic.body.en ?? ''}\n${topic.body.ru ?? ''}`;
    const body = new Map<string, number>();
    for (const item of stems(bodyText)) body.set(item, (body.get(item) ?? 0) + 1);
    const title = new Set(stems(titleText));
    const keywords = new Set(stems((topic.keywords ?? []).join(' ')));
    const id = new Set(stems(topic.id.replace(/[._-]/g, ' ')));
    const index: TopicIndex = {
        title,
        keywords,
        id,
        body,
        all: [...new Set([...title, ...keywords, ...id, ...body.keys()])],
        flat: normalizeText(`${titleText}\n${bodyText}`).replace(/\s+/g, ' '),
    };
    indexCache.set(topic, index);
    return index;
}

function prefixHit(term: string, candidates: Iterable<string>): boolean {
    if (term.length < 4) return false;
    for (const candidate of candidates) {
        if (candidate.length < 4 || candidate === term) continue;
        if (candidate.startsWith(term) || term.startsWith(candidate)) return true;
    }
    return false;
}

function termScore(term: string, index: TopicIndex): number {
    if (index.title.has(term)) return 6;
    if (index.keywords.has(term)) return 5;
    if (index.id.has(term)) return 4;
    const count = index.body.get(term);
    if (count) return 1 + Math.min(2, Math.log2(count));
    if (prefixHit(term, index.title)) return 3;
    if (prefixHit(term, index.keywords)) return 2.5;
    if (prefixHit(term, index.body.keys())) return 0.75;
    return 0;
}

/** Relevance of a topic for the query's stems (0 = no match). */
export function scoreTopic(topic: DocTopic, terms: readonly string[], phrase = ''): number {
    if (!terms.length) return 0;
    const index = indexOf(topic);
    let total = 0;
    let matched = 0;
    for (const term of terms) {
        const score = termScore(term, index);
        if (score > 0) matched += 1;
        total += score;
    }
    if (!matched) return 0;
    total *= 0.5 + matched / terms.length;
    if (phrase && terms.length > 1 && index.flat.includes(phrase)) total += 4;
    return Math.round(total * 100) / 100;
}

function cut(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The sentence (or line) of a text that holds most of the terms, cut to `max`. */
export function snippetOf(text: string, terms: readonly string[], max = 220): string {
    const pieces = text
        .split(/\n+|(?<=[.!?…])\s+/)
        .map((piece) => piece.trim())
        .filter(Boolean);
    let best = pieces[0] ?? '';
    let bestScore = -1;
    for (const piece of pieces) {
        const words = new Set(stems(piece));
        const score = terms.filter((term) => words.has(term) || prefixHit(term, words)).length;
        if (score > bestScore) {
            best = piece;
            bestScore = score;
        }
    }
    return cut(best.replace(/^[-*#>\s]+/, ''), max);
}

/** Search over the topics; best first. */
export function searchDocs(topics: readonly DocTopic[], query: string, options: SearchOptions): DocHit[] {
    const terms = [...new Set(stems(query))];
    if (!terms.length) return [];
    const phrase = normalizeText(query).replace(/\s+/g, ' ').trim();
    const hits: DocHit[] = [];
    for (const topic of topics) {
        if (options.kinds && !options.kinds.includes(topic.kind)) continue;
        const score = scoreTopic(topic, terms, phrase);
        if (score <= 0) continue;
        hits.push({
            id: topic.id,
            kind: topic.kind,
            title: localText(topic.title, options.locale),
            score,
            snippet: snippetOf(localText(topic.body, options.locale), terms, options.snippetChars ?? 220),
        });
    }
    // Ties: guides and modules before changelog entries, then the id for a stable order.
    const rank: Record<DocKind, number> = { guide: 0, module: 1, stack: 2, readme: 3, changelog: 4 };
    hits.sort((a, b) => b.score - a.score || rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
    return hits.slice(0, options.limit ?? 5);
}

/**
 * One topic by id (exact, case-insensitive, or the last part: `director` → `module.director`), by title, or the best
 * search hit when it is clearly relevant; null otherwise.
 */
export function findTopic(topics: readonly DocTopic[], query: string, locale: DocLocale): DocTopic | null {
    const wanted = query.trim();
    if (!wanted) return null;
    const lower = normalizeText(wanted);
    const byId =
        topics.find((topic) => topic.id === wanted) ??
        topics.find((topic) => topic.id.toLowerCase() === lower) ??
        topics.find((topic) => topic.id.toLowerCase().endsWith(`.${lower}`));
    if (byId) return byId;
    const byTitle = topics.find(
        (topic) => normalizeText(topic.title.en ?? '') === lower || normalizeText(topic.title.ru ?? '') === lower,
    );
    if (byTitle) return byTitle;
    const [hit] = searchDocs(topics, wanted, { locale, limit: 1 });
    if (!hit || hit.score < 3) return null;
    return topics.find((topic) => topic.id === hit.id) ?? null;
}
