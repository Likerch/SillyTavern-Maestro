// Cheap contradiction rules between preset blocks (M34 п.3, P4 «сначала правила»), pure. Each block is split into
// clauses; a clause with a negation ("never", "do not", «не», «никогда»…) forbids what it names, the others require
// it. Topics: narration person (first/second/third), tense (past/present), the reply language and length limits
// (words, paragraphs, sentences, tokens). Two blocks contradict when one requires what another forbids, when they
// require different values of one topic, or when their length ranges do not intersect. Conditional sections
// (`{{if}}…{{/if}}`) are left out: they are exclusive by design. English and Russian wording.
import { stripConditionals } from './preset-analysis-text';

export type ContradictionTopic = 'pov' | 'tense' | 'language' | 'length';

export interface ContradictionBlock {
    identifier: string;
    text: string;
}

export interface ContradictionHit {
    topic: ContradictionTopic;
    /** Identifiers of the two blocks. */
    a: string;
    b: string;
    /** What each block says (value codes: 'first', 'past', 'ru', '100-300 words', '!third' = forbids third). */
    left: string;
    right: string;
}

interface Polarity {
    required: boolean;
    forbidden: boolean;
}

export interface LengthLimit {
    unit: 'words' | 'paragraphs' | 'sentences' | 'tokens';
    min: number;
    max: number;
}

export interface InstructionFacets {
    pov: Map<string, Polarity>;
    tense: Map<string, Polarity>;
    language: Map<string, Polarity>;
    lengths: LengthLimit[];
}

const L = '\\p{L}';
/** Whole-word match that works for Cyrillic (`\b` is ASCII-only in JavaScript). */
function word(pattern: string): RegExp {
    return new RegExp(`(?<!${L})(?:${pattern})(?!${L})`, 'iu');
}

const NEGATION = word("not|never|don't|dont|do not|avoid|no|without|instead of|не|никогда|нельзя|избегай|без|вместо");
/** Length qualifiers that contain a negation word but are limits, not prohibitions. */
const LIMIT_PHRASES = new RegExp(
    word('no more than|not more than|no less than|not less than|не более|не больше|не менее|не меньше').source,
    'giu',
);
/** Clause separators: punctuation and "but" / «но» / «а». */
const CLAUSE_SPLIT = /[.!?;,\n]+|\s(?:but|however|но|а|однако)\s/iu;

const POV_PATTERNS: [string, RegExp][] = [
    ['first', word('first[- ]person|от первого лица|в первом лице|первого лица')],
    ['second', word('second[- ]person|от второго лица|во втором лице|второго лица')],
    ['third', word('third[- ]person|от третьего лица|в третьем лице|третьего лица')],
];

const TENSE_PATTERNS: [string, RegExp][] = [
    ['past', word('past tense|прошедш\\p{L}* времен\\p{L}*')],
    ['present', word('present tense|настоящ\\p{L}* времен\\p{L}*')],
];

const LANGUAGES: Record<string, string> = {
    english: 'en',
    russian: 'ru',
    japanese: 'ja',
    chinese: 'zh',
    german: 'de',
    french: 'fr',
    spanish: 'es',
    английском: 'en',
    русском: 'ru',
    японском: 'ja',
    китайском: 'zh',
    немецком: 'de',
    французском: 'fr',
    испанском: 'es',
};
const LANGUAGE_WORDS = Object.keys(LANGUAGES).join('|');
const LANGUAGE_PATTERNS: RegExp[] = [
    new RegExp(
        `(?<!${L})(?:respond|reply|write|answer|speak|output|narrate|use|translate)(?!${L})[^\\n]{0,40}?(?<!${L})(?:in|into)\\s+(${LANGUAGE_WORDS})(?!${L})`,
        'iu',
    ),
    new RegExp(`(?<!${L})(?:only\\s+in\\s+)(${LANGUAGE_WORDS})(?!${L})`, 'iu'),
    new RegExp(`(?<!${L})(${LANGUAGE_WORDS})\\s+only(?!${L})`, 'iu'),
    new RegExp(
        `(?<!${L})(?:отвечай|пиши|ответ\\p{L}*|говори|используй|повествуй|переводи|веди)(?!${L})[^\\n]{0,40}?(?<!${L})на\\s+(${LANGUAGE_WORDS})(?!${L})`,
        'iu',
    ),
];

const UNITS: [LengthLimit['unit'], string][] = [
    ['words', 'words?|слов\\p{L}*'],
    ['paragraphs', 'paragraphs?|абзац\\p{L}*|параграф\\p{L}*'],
    ['sentences', 'sentences?|предложени\\p{L}*'],
    ['tokens', 'tokens?|токен\\p{L}*'],
];
const UNIT_RE = UNITS.map(([, pattern]) => pattern).join('|');
const NUMBER = '\\d{1,5}';
const LENGTH_RE = new RegExp(
    `(?:(?<qualifier>up to|no more than|not more than|at most|maximum|max|under|fewer than|less than|at least|minimum|min|no less than|not less than|more than|over|не более|не больше|не менее|не меньше|максимум|минимум|до|от)\\s+)?(?<low>${NUMBER})(?:\\s*(?:-|–|—|to|до)\\s*(?<high>${NUMBER}))?\\s*(?<unit>${UNIT_RE})(?!${L})`,
    'giu',
);
const MAX_QUALIFIERS = new Set([
    'up to',
    'no more than',
    'not more than',
    'at most',
    'maximum',
    'max',
    'under',
    'fewer than',
    'less than',
    'не более',
    'не больше',
    'максимум',
    'до',
]);

function unitOf(text: string): LengthLimit['unit'] {
    for (const [unit, pattern] of UNITS) if (new RegExp(`^(?:${pattern})$`, 'iu').test(text)) return unit;
    return 'words';
}

function mark(map: Map<string, Polarity>, key: string, negated: boolean): void {
    const value = map.get(key) ?? { required: false, forbidden: false };
    if (negated) value.forbidden = true;
    else value.required = true;
    map.set(key, value);
}

function lengthLimits(clause: string): LengthLimit[] {
    const limits: LengthLimit[] = [];
    for (const match of clause.matchAll(LENGTH_RE)) {
        const groups = match.groups ?? {};
        const low = Number(groups.low);
        const high = groups.high === undefined ? undefined : Number(groups.high);
        const unit = unitOf(groups.unit ?? '');
        const qualifier = (groups.qualifier ?? '').toLowerCase();
        if (high !== undefined) limits.push({ unit, min: Math.min(low, high), max: Math.max(low, high) });
        else if (!qualifier) limits.push({ unit, min: low, max: low });
        else if (MAX_QUALIFIERS.has(qualifier)) limits.push({ unit, min: 0, max: low });
        else limits.push({ unit, min: low, max: Number.POSITIVE_INFINITY });
    }
    return limits;
}

/** What a block asks for, by topic. */
export function instructionFacets(text: string): InstructionFacets {
    const facets: InstructionFacets = { pov: new Map(), tense: new Map(), language: new Map(), lengths: [] };
    for (const clause of stripConditionals(text).split(CLAUSE_SPLIT)) {
        if (!clause.trim()) continue;
        const negated = NEGATION.test(clause.replace(LIMIT_PHRASES, ' '));
        for (const [key, pattern] of POV_PATTERNS) if (pattern.test(clause)) mark(facets.pov, key, negated);
        for (const [key, pattern] of TENSE_PATTERNS) if (pattern.test(clause)) mark(facets.tense, key, negated);
        for (const pattern of LANGUAGE_PATTERNS) {
            const found = pattern.exec(clause)?.[1]?.toLowerCase();
            const code = found ? LANGUAGES[found] : undefined;
            if (code) mark(facets.language, code, negated);
        }
        if (!negated) facets.lengths.push(...lengthLimits(clause));
    }
    return facets;
}

function polarityConflict(
    topic: ContradictionTopic,
    a: ContradictionBlock,
    left: Map<string, Polarity>,
    b: ContradictionBlock,
    right: Map<string, Polarity>,
): ContradictionHit | null {
    for (const [key, value] of left) {
        const other = right.get(key);
        if (value.required && other?.forbidden)
            return { topic, a: a.identifier, b: b.identifier, left: key, right: `!${key}` };
        if (value.forbidden && other?.required)
            return { topic, a: a.identifier, b: b.identifier, left: `!${key}`, right: key };
    }
    const required = (map: Map<string, Polarity>) => [...map].filter(([, value]) => value.required).map(([key]) => key);
    const mine = required(left);
    const theirs = required(right);
    // Only a block that asks for exactly one value is a clear instruction.
    if (mine.length === 1 && theirs.length === 1 && mine[0] !== theirs[0]) {
        return { topic, a: a.identifier, b: b.identifier, left: mine[0]!, right: theirs[0]! };
    }
    return null;
}

function formatLimit(limit: LengthLimit): string {
    if (limit.max === Number.POSITIVE_INFINITY) return `≥${limit.min} ${limit.unit}`;
    if (limit.min === 0) return `≤${limit.max} ${limit.unit}`;
    return limit.min === limit.max ? `${limit.min} ${limit.unit}` : `${limit.min}-${limit.max} ${limit.unit}`;
}

function lengthConflict(
    a: ContradictionBlock,
    left: LengthLimit[],
    b: ContradictionBlock,
    right: LengthLimit[],
): ContradictionHit | null {
    for (const mine of left) {
        for (const theirs of right) {
            if (mine.unit !== theirs.unit) continue;
            if (mine.max < theirs.min || theirs.max < mine.min) {
                return {
                    topic: 'length',
                    a: a.identifier,
                    b: b.identifier,
                    left: formatLimit(mine),
                    right: formatLimit(theirs),
                };
            }
        }
    }
    return null;
}

/** Contradictions between different blocks (at most one per topic and pair). */
export function findContradictions(blocks: readonly ContradictionBlock[]): ContradictionHit[] {
    const facets = blocks.map((block) => instructionFacets(block.text));
    const hits: ContradictionHit[] = [];
    for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
            const a = blocks[i]!;
            const b = blocks[j]!;
            const left = facets[i]!;
            const right = facets[j]!;
            const found = [
                polarityConflict('pov', a, left.pov, b, right.pov),
                polarityConflict('tense', a, left.tense, b, right.tense),
                polarityConflict('language', a, left.language, b, right.language),
                lengthConflict(a, left.lengths, b, right.lengths),
            ];
            for (const hit of found) if (hit) hits.push(hit);
        }
    }
    return hits;
}
