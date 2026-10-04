// Pacing of the story for the director (M14): stall detection over committed turns (same place for N turns, nothing
// happening, the model repeating itself, the conversation circling one topic), the frequency limit of director's
// notes, and «the user steered the plot himself» (then the director stays silent, M14 п.4).
// Pure: no DOM, no SillyTavern.
import { STOP_WORDS, normalizeText, stemWord, textWords } from './signals-tokens';

export type StallReason = 'samePlace' | 'noEvents' | 'repetition' | 'loop';

/** What one committed turn says about pacing. */
export interface TurnRecord {
    /** Assistant message index of the committed reply. */
    index: number;
    /** Place key (registry id or normalised DES location); null when unknown. */
    place: string | null;
    /** Meaningful changes in this turn: location, quests, relationships, characters, time (signals + own diff). */
    events: number;
    /** The turn could be observed (DES tracker of the reply): zero events then means «nothing happened». */
    known: boolean;
    /** The reply repeats earlier replies (quality's repetition defect or the own n-gram check). */
    repetition: boolean;
    /** Characteristic word stems of the turn (user message + reply). */
    topic: string[];
}

export interface StallResult {
    /** Committed turns in a row without a meaningful change (unobserved turns count as quiet). */
    turns: number;
    reasons: StallReason[];
    /** The reasons together are worth a director's note. */
    stalled: boolean;
}

/** Consecutive topic similarity (Jaccard) that counts as «the conversation circles one topic». */
export const LOOP_AVERAGE = 0.3;
const LOOP_MINIMUM = 0.15;

function jaccard(a: readonly string[], b: readonly string[]): number {
    const left = new Set(a);
    const right = new Set(b);
    if (!left.size && !right.size) return 0;
    let common = 0;
    for (const item of left) if (right.has(item)) common++;
    return common / (left.size + right.size - common);
}

/**
 * Stall reasons over the last `n` committed turns:
 * - samePlace: the same known place in all of them;
 * - noEvents: all of them observed and none had a meaningful change;
 * - repetition: at least two of them repeated earlier replies;
 * - loop: their topics stay alike from turn to turn.
 * A stall worth a note: nothing happening plus any other reason, or a loop that repeats itself.
 */
export function detectStall(records: readonly TurnRecord[], n: number): StallResult {
    const size = Math.max(2, Math.floor(n));
    let turns = 0;
    for (let i = records.length - 1; i >= 0; i--) {
        if ((records[i] as TurnRecord).events > 0) break;
        turns++;
    }
    const window = records.slice(-size);
    const reasons: StallReason[] = [];
    if (window.length < size) return { turns, reasons, stalled: false };
    const firstPlace = window[0]?.place ?? null;
    if (firstPlace !== null && window.every((record) => record.place === firstPlace)) reasons.push('samePlace');
    if (window.every((record) => record.known && record.events === 0)) reasons.push('noEvents');
    if (window.filter((record) => record.repetition).length >= 2) reasons.push('repetition');
    const similarities: number[] = [];
    for (let i = 1; i < window.length; i++) {
        similarities.push(jaccard((window[i - 1] as TurnRecord).topic, (window[i] as TurnRecord).topic));
    }
    const average = similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
    if (average >= LOOP_AVERAGE && similarities.every((value) => value >= LOOP_MINIMUM)) reasons.push('loop');
    const stalled =
        (reasons.includes('noEvents') && reasons.length >= 2) ||
        (reasons.includes('loop') && reasons.includes('repetition'));
    return { turns, reasons, stalled };
}

/* ------------------------------------------------------------------ topic and repetition */

/** Narrative filler that appears in every reply and says nothing about the topic (stemmed at load). */
// prettier-ignore
const FILLER = new Set(
    [
        'said', 'says', 'look', 'looked', 'eyes', 'smile', 'smiled', 'voice', 'hand', 'hands', 'head', 'face', 'back',
        'turn', 'turned', 'like', 'just', 'know', 'think', 'would', 'could', 'should', 'your', 'what', 'then', 'there',
        'here', 'when', 'where', 'will', 'only', 'even', 'more', 'some', 'time', 'moment', 'again', 'want', 'need',
        'make', 'take', 'come', 'came', 'went', 'going', 'well', 'yeah', 'okay', 'really', 'little', 'something',
        'you', 'not', 'but', 'all', 'can', 'did', 'get', 'got', 'out', 'how', 'why', 'yes', 'our', 'let', 'may', 'too',
        'any', 'ask', 'was', 'had', 'has', 'are', 'one', 'two', 'see', 'saw',
        'сказал', 'сказала', 'ответил', 'ответила', 'глаза', 'взгляд', 'улыбка', 'улыбнулась', 'улыбнулся', 'голос',
        'рука', 'руки', 'голова', 'лицо', 'только', 'может', 'быть', 'было', 'была', 'были', 'если', 'чтобы', 'когда',
        'потом', 'тебя', 'тебе', 'меня', 'себя', 'этого', 'этом', 'очень', 'просто', 'знаю', 'хочу', 'надо', 'нужно',
        'момент', 'снова', 'опять', 'сейчас', 'теперь', 'больше', 'здесь', 'тогда', 'говорит', 'спросил', 'спросила',
        'что', 'там', 'тут', 'мне', 'нас', 'вас', 'был', 'нет', 'кто', 'где', 'чем', 'вот', 'ему', 'ней', 'них', 'ним',
        'сам', 'про', 'они', 'чтоб', 'даже', 'тоже', 'лишь',
    ].map(stemWord),
);

const NAME_RE = /(^|[^\p{L}\p{N}])(\p{Lu}[\p{Ll}\p{Lu}'-]*)/gu;
const SENTENCE_END_RE = /[.!?…"«»“”\n—:]\s*$/u;

/** Capitalised words in the middle of a sentence: names, not topics. */
function nameLikeStems(text: string): Set<string> {
    const names = new Set<string>();
    for (const match of text.matchAll(NAME_RE)) {
        const word = match[2] ?? '';
        const start = (match.index ?? 0) + (match[1]?.length ?? 0);
        const before = text.slice(Math.max(0, start - 3), start);
        if (start === 0 || SENTENCE_END_RE.test(before)) continue;
        names.add(stemWord(word));
    }
    return names;
}

/**
 * Characteristic word stems of a text: the most frequent content stems (three letters or more; stop words, narrative
 * filler, names and the `exclude` words left out), most frequent first.
 */
export function topicWords(text: string, limit = 10, exclude: readonly string[] = []): string[] {
    const skip = nameLikeStems(text);
    for (const name of exclude) for (const word of textWords(name)) skip.add(stemWord(word));
    const counts = new Map<string, { count: number; first: number }>();
    textWords(text).forEach((word, position) => {
        if (word.length < 3 || STOP_WORDS.has(word) || /^\p{N}+$/u.test(word)) return;
        const stem = stemWord(word);
        if (FILLER.has(stem) || skip.has(stem)) return;
        const entry = counts.get(stem);
        if (entry) entry.count++;
        else counts.set(stem, { count: 1, first: position });
    });
    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
        .slice(0, Math.max(0, limit))
        .map(([stem]) => stem);
}

function grams(text: string, size: number): Set<string> {
    const words = textWords(text);
    const out = new Set<string>();
    for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
    return out;
}

/** Distinct word n-grams of `text` that also occur in one of the `earlier` texts. */
export function repeatedNgrams(
    text: string,
    earlier: readonly string[],
    size = 4,
): { repeated: number; total: number } {
    const own = grams(text, size);
    if (!own.size) return { repeated: 0, total: 0 };
    const before = new Set<string>();
    for (const item of earlier) for (const gram of grams(item, size)) before.add(gram);
    let repeated = 0;
    for (const gram of own) if (before.has(gram)) repeated++;
    return { repeated, total: own.size };
}

/** The reply copies phrases of earlier replies: many shared 4-grams, or a noticeable share of them. */
export function isRepetitive(text: string, earlier: readonly string[]): boolean {
    const { repeated, total } = repeatedNgrams(text, earlier);
    return repeated >= 8 || (repeated >= 3 && repeated / Math.max(1, total) >= 0.08);
}

/* ------------------------------------------------------------------ frequency */

/**
 * A director's note may be written now: notes are on in this mode (`every` > 0) and at least `every` committed turns
 * passed since the last one. A nudge ignores this limit.
 */
export function noteAllowed(every: number, turnsSinceNote: number): boolean {
    return every > 0 && turnsSinceNote >= every;
}

/* ------------------------------------------------------------------ the user's steering */

export type SteeringReason = 'ooc' | 'request' | 'plot' | 'long';

const OOC_RE = /\(\(|\)\)|\[\s*ooc|\(\s*ooc|(?<!\p{L})ooc\s*:|\{\{|вне\s+роли|\[[^\]\n]{8,}\]/iu;
const REQUEST_RE =
    /(?<!\p{L})(?:напиши|опиши|покажи|сделай|начни|продолжи)(?!\p{L})[^.!?\n]{0,30}(?:сцен|постельн|секс|бой|битв|драк)|(?<!\p{L})(?:write|describe|show|start)(?!\p{L})[^.!?\n]{0,30}(?:scene|sex|fight|battle)/iu;
const PLOT_RE =
    /(?<!\p{L})(?:давай(?:те)?|пусть|позволь(?:те)?|нужно,? чтобы|хочу,? чтобы|сделай так|перейд[её]м|перемотай|промотай|пропусти|внезапно|вдруг|тем временем|на следующий день|спустя|let'?s|let us|suddenly|meanwhile|skip to|fast[- ]?forward|time ?skip|the next day|hours later|i want (?:you|the|a|to|him|her|them)|make (?:it|him|her|them)|have (?:him|her|them))(?!\p{L})/iu;
const LONG_CHARS = 700;
const LONG_SENTENCES = 4;

/**
 * Why the user's last message steers the plot himself (the director stays silent then), or null: an out-of-character
 * direction in brackets, an explicit scene request, imperative or plot words («давай», «пусть», "let's", «вдруг»,
 * a time skip) or a long message describing events.
 */
export function steeringReason(text: string | null | undefined): SteeringReason | null {
    const source = String(text ?? '').trim();
    if (!source) return null;
    if (OOC_RE.test(source)) return 'ooc';
    const normalized = normalizeText(source);
    if (REQUEST_RE.test(normalized)) return 'request';
    if (PLOT_RE.test(normalized)) return 'plot';
    const sentences = source.split(/[.!?…]+(?:\s|$)/u).filter((part) => part.trim().length > 2).length;
    if (source.length >= LONG_CHARS && sentences >= LONG_SENTENCES) return 'long';
    return null;
}
