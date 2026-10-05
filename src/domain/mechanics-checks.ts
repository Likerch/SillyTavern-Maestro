// M25 «Механики», checks in the user's message (plan M25 п.3, §5 phase 1, P15): the trigger words of the checks
// on in this chat are looked up in the story part of the message (OOC, parentheses, brackets, macros and quoted
// speech skipped), at word starts (RU/EN stems; a full word given as a trigger is cut to its stem, so Russian endings
// follow), never after a negation («не пытаюсь убедить», "don't try to persuade") and never in a question. At most one
// check per message: the strongest match (an attempt word nearby, a longer stem, repeated hits). The actor is the
// persona unless a clause starts with the name of a known actor («Элизабет пытается убедить…») — conservative.
// The difficulty comes from an explicit number ("DC 15", «сложность 15») or from words in the same sentence
// («легко», «трудно», "very hard"), otherwise the check's default.
// Runs on the send path: one short message, plain string work, no allocation-heavy parsing.
// Pure: no DOM, no SillyTavern.
import type { DifficultyLevel } from './mechanics-dice';

export interface CheckTrigger {
    mechanicId: string;
    checkId: string;
    triggers: readonly string[];
}

/** Someone who may act in the scene: the canonical holder name and every name to look for. */
export interface ActorNames {
    holder: string;
    /** Canonical name, aliases, Russian case forms. */
    names: readonly string[];
}

export interface DetectedCheck {
    mechanicId: string;
    checkId: string;
    /** The trigger (as defined) that matched best. */
    trigger: string;
    /** The actor named as the subject of the attempt; null → the persona. */
    holder: string | null;
    /** Difficulty from words in the sentence of the match; null → the check's default. */
    level: DifficultyLevel | null;
    /** An explicit number anywhere in the message (OOC included); wins over words. */
    difficulty: number | null;
    score: number;
}

/* ------------------------------------------------------------------ text */

export function normalizeWord(word: string): string {
    return word.toLowerCase().replace(/ё/g, 'е').replace(/[’`]/g, "'");
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu;

export function tokenize(text: string): string[] {
    return normalizeWord(text).match(TOKEN_RE) ?? [];
}

/**
 * The story part of a message: without HTML comments, `{{macros}}`, `((OOC))`, OOC and `//` lines, anything in
 * parentheses or square brackets (innermost first) and quoted speech ("…", «…», “…”, „…“).
 */
export function storyPart(text: string): string {
    let out = text.replace(/\r\n?/g, '\n');
    out = out.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\{\{[\s\S]*?\}\}/g, ' ');
    out = out.replace(/\(\([\s\S]*?\)\)/g, ' ');
    out = out.replace(/^[ \t>*_]*(?:\/\/|(?:ooc|оос)(?![\p{L}])).*$/gimu, ' ');
    let previous: string;
    do {
        previous = out;
        out = out.replace(/\([^()]*\)/g, ' ').replace(/\[[^[\]]*\]/g, ' ');
    } while (out !== previous);
    out = out.replace(/"[^"\n]*"|«[^«»]*»|“[^“”]*”|„[^„“”]*[“”]/g, ' ');
    return out;
}

const EXPLICIT_DC_RE = /(?<![\p{L}\p{N}])(?:dc|сл|сложность|difficulty)\s*[:=]?\s*(\d{1,3})(?!\p{N})/iu;

/** "DC 15", «сложность: 12», «сл 18» anywhere in the message (OOC notes included). */
export function explicitDifficulty(text: string): number | null {
    const match = EXPLICIT_DC_RE.exec(text);
    return match ? Number(match[1]) : null;
}

interface Sentence {
    clauses: string[][];
    question: boolean;
}

function splitSentences(text: string): Sentence[] {
    const result: Sentence[] = [];
    for (const match of text.matchAll(/([^.!?…\n]+)([.!?…]*)/g)) {
        const body = match[1] ?? '';
        const clauses = body
            .split(/[,;:—–]|\s-\s/)
            .map(tokenize)
            .filter((tokens) => tokens.length > 0);
        if (clauses.length) result.push({ clauses, question: (match[2] ?? '').includes('?') });
    }
    return result;
}

/* ------------------------------------------------------------------ stems */

const RU_ENDINGS = [
    'иться',
    'ыться',
    'аться',
    'яться',
    'еться',
    'уться',
    'ешься',
    'ется',
    'ются',
    'ится',
    'ятся',
    'ость',
    'ться',
    'ами',
    'ями',
    'ыми',
    'ими',
    'ого',
    'его',
    'ому',
    'ему',
    'ать',
    'ять',
    'ить',
    'еть',
    'уть',
    'ыть',
    'оть',
    'ешь',
    'ете',
    'ует',
    'уют',
    'ает',
    'яет',
    'ают',
    'яют',
    'ия',
    'ие',
    'ий',
    'ти',
    'чь',
    'ет',
    'ют',
    'ут',
    'ит',
    'ят',
    'ат',
    'ую',
    'юю',
    'ая',
    'яя',
    'ое',
    'ее',
    'ые',
    'ый',
    'ой',
    'ым',
    'им',
    'ых',
    'их',
    'ов',
    'ев',
    'ей',
    'ам',
    'ям',
    'ах',
    'ях',
    'ом',
    'ем',
    'ся',
    'сь',
    'а',
    'я',
    'о',
    'е',
    'и',
    'ы',
    'у',
    'ю',
    'ь',
    'й',
];
const EN_ENDINGS = ['ing', 'ed', 'es', 'e', 's'];
/** Infinitive endings may leave a 4-letter stem («убедить» → «убед»); other endings need 5 («красться» ≠ «крас»). */
const RU_INFINITIVES = new Set(['ить', 'ать', 'ять', 'еть', 'уть', 'ыть', 'оть']);
const RU_MIN_STEM = 5;
const RU_MIN_INFINITIVE_STEM = 4;
const EN_MIN_STEM = 3;

/** A word cut to its stem (one ending; Cyrillic → Russian endings, Latin → English); unchanged when too short. */
export function stemOf(word: string): string {
    const plain = normalizeWord(word.trim());
    const russian = /[а-я]/.test(plain);
    for (const ending of russian ? RU_ENDINGS : EN_ENDINGS) {
        if (!plain.endsWith(ending)) continue;
        const min = russian ? (RU_INFINITIVES.has(ending) ? RU_MIN_INFINITIVE_STEM : RU_MIN_STEM) : EN_MIN_STEM;
        if (plain.length - ending.length >= min) return plain.slice(0, -ending.length);
    }
    return plain;
}

/** The word sequences a trigger matches: as written and cut to stems (each word is matched at a word start). */
export function triggerStems(trigger: string): string[][] {
    const words = tokenize(trigger);
    if (!words.length) return [];
    const variants = [words];
    const stems = words.map(stemOf);
    if (stems.some((stem, index) => stem !== words[index])) variants.push(stems);
    return variants;
}

/** Stems shorter than this must match a whole word («бег» is not «бегство»… but is too noisy as a prefix). */
const PREFIX_MIN = 3;

function wordMatches(token: string, stem: string): boolean {
    return stem.length >= PREFIX_MIN ? token.startsWith(stem) : token === stem;
}

function matchAt(tokens: readonly string[], index: number, words: readonly string[]): boolean {
    if (index + words.length > tokens.length) return false;
    for (let i = 0; i < words.length; i++) {
        if (!wordMatches(tokens[index + i] as string, words[i] as string)) return false;
    }
    return true;
}

/* ------------------------------------------------------------------ negations and attempts */

const NEGATIONS = new Set([
    'не',
    'ни',
    'нет',
    'без',
    'никогда',
    'никак',
    'нельзя',
    'незачем',
    'not',
    'no',
    'never',
    'without',
    "don't",
    'dont',
    "doesn't",
    'doesnt',
    "didn't",
    'didnt',
    "won't",
    'wont',
    "can't",
    'cant',
    'cannot',
    "isn't",
    "aren't",
    "wasn't",
    "weren't",
    "shouldn't",
    "wouldn't",
    'refuse',
    'refuses',
    'refused',
]);

/** «Убеждать его не стану»: a negated modal after the trigger. */
const NEGATED_MODALS = ['буд', 'стан', 'собира', 'хоч', 'хот', 'мог', 'смог', 'намер'];
const NEGATION_BEFORE = 3;
const NEGATION_AFTER = 3;

function negated(tokens: readonly string[], start: number, end: number): boolean {
    for (let i = Math.max(0, start - NEGATION_BEFORE); i < start; i++) {
        if (NEGATIONS.has(tokens[i] as string)) return true;
    }
    for (let i = end; i < Math.min(tokens.length - 1, end + NEGATION_AFTER); i++) {
        if (tokens[i] === 'не' && NEGATED_MODALS.some((stem) => (tokens[i + 1] as string).startsWith(stem))) {
            return true;
        }
    }
    return false;
}

const ATTEMPT_STEMS = ['пыта', 'попыта', 'пробу', 'попробу', 'стара', 'постара', 'рискн', 'attempt'];
const ATTEMPT_WORDS = new Set(['try', 'tries', 'trying', 'tried']);
const ATTEMPT_WINDOW = 4;

function attemptBefore(tokens: readonly string[], start: number): boolean {
    for (let i = Math.max(0, start - ATTEMPT_WINDOW); i < start; i++) {
        const token = tokens[i] as string;
        if (ATTEMPT_WORDS.has(token) || ATTEMPT_STEMS.some((stem) => token.startsWith(stem))) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ difficulty words */

interface LevelPattern {
    level: DifficultyLevel;
    words: string[];
}

/** Russian entries are stems (word start), English ones whole words. Longer patterns first. */
const LEVEL_PATTERNS: LevelPattern[] = [
    { level: 'veryHard', words: ['очень', 'трудн'] },
    { level: 'veryHard', words: ['очень', 'сложн'] },
    { level: 'veryHard', words: ['крайне', 'трудн'] },
    { level: 'veryHard', words: ['крайне', 'сложн'] },
    { level: 'veryHard', words: ['very', 'hard'] },
    { level: 'veryHard', words: ['very', 'difficult'] },
    { level: 'veryHard', words: ['very', 'tough'] },
    { level: 'veryHard', words: ['extremely', 'hard'] },
    { level: 'veryHard', words: ['extremely', 'difficult'] },
    { level: 'veryHard', words: ['невозможн'] },
    { level: 'veryHard', words: ['impossible'] },
    { level: 'easy', words: ['несложн'] },
    { level: 'easy', words: ['нетрудн'] },
    { level: 'easy', words: ['легк'] },
    { level: 'easy', words: ['легч'] },
    { level: 'easy', words: ['пустяк'] },
    { level: 'easy', words: ['easy'] },
    { level: 'easy', words: ['easier'] },
    { level: 'easy', words: ['easily'] },
    { level: 'easy', words: ['simple'] },
    { level: 'easy', words: ['trivial'] },
    { level: 'hard', words: ['нелегк'] },
    { level: 'hard', words: ['непрост'] },
    { level: 'hard', words: ['трудн'] },
    { level: 'hard', words: ['сложн'] },
    { level: 'hard', words: ['hard'] },
    { level: 'hard', words: ['harder'] },
    { level: 'hard', words: ['difficult'] },
    { level: 'hard', words: ['tough'] },
    { level: 'hard', words: ['challenging'] },
];

const OPPOSITE: Record<DifficultyLevel, DifficultyLevel> = {
    easy: 'hard',
    hard: 'easy',
    veryHard: 'easy',
    normal: 'normal',
};

function levelWordMatches(token: string, word: string): boolean {
    return /[а-я]/.test(word) ? token.startsWith(word) : token === word;
}

function levelAt(tokens: readonly string[], index: number): { level: DifficultyLevel; length: number } | null {
    for (const pattern of LEVEL_PATTERNS) {
        if (index + pattern.words.length > tokens.length) continue;
        if (pattern.words.every((word, i) => levelWordMatches(tokens[index + i] as string, word))) {
            return { level: pattern.level, length: pattern.words.length };
        }
    }
    return null;
}

/** The first difficulty level said in these tokens; «не трудно» / "not hard" flip it. */
export function difficultyLevel(tokens: readonly string[]): DifficultyLevel | null {
    for (let i = 0; i < tokens.length; i++) {
        const found = levelAt(tokens, i);
        if (!found) continue;
        const before = tokens[i - 1];
        return before === 'не' || before === 'not' ? OPPOSITE[found.level] : found.level;
    }
    return null;
}

const NORMAL_WORDS = new Set(['normal', 'medium', 'average', 'обычн', 'средн', 'норм']);

/** One word typed as a difficulty (/maestro-roll … трудно): its level, or null. */
export function difficultyWord(word: string): DifficultyLevel | null {
    const tokens = tokenize(word.replace(/[_-]/g, ' '));
    if (!tokens.length) return null;
    const first = tokens[0] as string;
    if (tokens.length === 1 && [...NORMAL_WORDS].some((stem) => first.startsWith(stem))) return 'normal';
    if (tokens.length === 1 && first === 'veryhard') return 'veryHard';
    return difficultyLevel(tokens);
}

/* ------------------------------------------------------------------ the actor */

const LEADING = new Set(['и', 'а', 'но', 'затем', 'потом', 'тогда', 'тут', 'and', 'but', 'then', 'so', 'now']);
const FIRST_NAME_MIN = 3;

interface ActorTokens {
    holder: string;
    names: string[][];
}

function actorTokens(actors: readonly ActorNames[]): ActorTokens[] {
    return actors.map((actor) => {
        const names: string[][] = [];
        for (const name of [actor.holder, ...actor.names]) {
            const tokens = tokenize(name);
            if (!tokens.length) continue;
            names.push(tokens);
            if (tokens.length > 1 && (tokens[0] as string).length >= FIRST_NAME_MIN) names.push([tokens[0] as string]);
        }
        return { holder: actor.holder, names };
    });
}

/** The holder named at the start of the clause, before the match (null: none, or more than one fits). */
function subjectOf(clause: readonly string[], hitAt: number, actors: readonly ActorTokens[]): string | null {
    let start = 0;
    while (start < hitAt && LEADING.has(clause[start] as string)) start++;
    const found = new Map<string, number>();
    for (const actor of actors) {
        for (const name of actor.names) {
            if (start + name.length > hitAt) continue;
            if (name.every((word, i) => clause[start + i] === word)) {
                found.set(actor.holder, Math.max(found.get(actor.holder) ?? 0, name.length));
            }
        }
    }
    // Two actors fit (a shared first name): only a longer, fuller name decides.
    const [first, second] = [...found.entries()].sort((a, b) => b[1] - a[1]);
    if (!first || (second && second[1] === first[1])) return null;
    return first[0];
}

/* ------------------------------------------------------------------ detection */

interface Hit {
    check: CheckTrigger;
    trigger: string;
    sentence: number;
    clause: number;
    at: number;
    score: number;
}

const REPEAT_BONUS = 0.25;
const REPEAT_BONUS_MAX = 0.5;

/** The strongest check the message calls for, or null. */
export function detectCheck(
    text: string,
    checks: readonly CheckTrigger[],
    actors: readonly ActorNames[] = [],
): DetectedCheck | null {
    if (!text || !checks.length) return null;
    const sentences = splitSentences(storyPart(text));
    if (!sentences.length) return null;
    const prepared = checks.map((check) => ({
        check,
        triggers: check.triggers.flatMap((trigger) =>
            triggerStems(trigger).map((words) => ({ trigger, words, length: words.join(' ').length })),
        ),
    }));
    const hits: Hit[] = [];
    sentences.forEach((sentence, s) => {
        if (sentence.question) return;
        sentence.clauses.forEach((tokens, c) => {
            for (const { check, triggers } of prepared) {
                for (const { trigger, words, length } of triggers) {
                    for (let at = 0; at < tokens.length; at++) {
                        if (!matchAt(tokens, at, words)) continue;
                        if (negated(tokens, at, at + words.length)) continue;
                        const score = 1 + (attemptBefore(tokens, at) ? 1 : 0) + Math.min(length, 12) / 24;
                        hits.push({ check, trigger, sentence: s, clause: c, at, score });
                    }
                }
            }
        });
    });
    if (!hits.length) return null;

    // Per check: its best hit, plus a little for every other place it is called for.
    const best = new Map<CheckTrigger, { hit: Hit; places: Set<string> }>();
    for (const hit of hits) {
        const place = `${hit.sentence}:${hit.clause}:${hit.at}`;
        const entry = best.get(hit.check);
        if (!entry) {
            best.set(hit.check, { hit, places: new Set([place]) });
            continue;
        }
        entry.places.add(place);
        if (hit.score > entry.hit.score) entry.hit = hit;
    }
    let winner: { hit: Hit; score: number } | null = null;
    for (const { hit, places } of best.values()) {
        const score = hit.score + Math.min(REPEAT_BONUS_MAX, REPEAT_BONUS * (places.size - 1));
        const earlier =
            winner !== null &&
            (hit.sentence !== winner.hit.sentence
                ? hit.sentence < winner.hit.sentence
                : hit.clause !== winner.hit.clause
                  ? hit.clause < winner.hit.clause
                  : hit.at < winner.hit.at);
        if (!winner || score > winner.score || (score === winner.score && earlier)) winner = { hit, score };
    }
    const { hit, score } = winner as { hit: Hit; score: number };
    const sentence = sentences[hit.sentence] as Sentence;
    const clause = sentence.clauses[hit.clause] as string[];
    return {
        mechanicId: hit.check.mechanicId,
        checkId: hit.check.checkId,
        trigger: hit.trigger,
        holder: actors.length ? subjectOf(clause, hit.at, actorTokens(actors)) : null,
        level: difficultyLevel(sentence.clauses.flat()),
        difficulty: explicitDifficulty(text),
        score: Math.round(score * 1000) / 1000,
    };
}
