// Content boundary of M12 check 9 (plan §11): a configurable list of rules, never hard-coded; the default rule
// forbids sexual content with minors. A rule is a list of patterns; this module compiles and matches them.
//
// Pattern format (each string of `BoundaryRule.patterns`):
// - `both:<A>&&<B>` — a combination: A and B must both match inside one paragraph (a line of the reply). In one
//   sentence it is a strong hit (counts as two hits → defect), in one paragraph but different sentences a single
//   hit (suspicion for the judge). A and B are each a regex source or plain words as below.
// - `/source/` — a regular expression (flags `iu` are always used).
// - a string with regex metacharacters (`\ ^ $ . | ? * + ( ) [ ] { }`) — a regular expression source (flags `iu`);
//   an invalid one falls back to plain words.
// - anything else — plain words: matched case-insensitively at a word start (left boundary only, so stems such as
//   «школьниц» match every ending), spaces match any whitespace, «е» matches «ё».
// Scoring per rule: one hit = suspicion (0.5, the judge decides); two different hits (two patterns, two different
// matched texts, or a `both:` match inside one sentence) = defect (0.85).
// Pure: no DOM, no SillyTavern.

/** Same shape as features/quality/api.ts BoundaryRule (domain must not import features). */
export interface BoundaryRuleLike {
    id: string;
    title: string;
    patterns: string[];
    enabled: boolean;
}

export const BOTH_PREFIX = 'both:';
export const BOTH_SEPARATOR = '&&';
export const BOUNDARY_SUSPICION = 0.5;
export const BOUNDARY_DEFECT = 0.85;

/** `all` is the global copy of `re` for counting different matches. */
type Matcher = { type: 'single'; re: RegExp; all: RegExp } | { type: 'both'; a: RegExp; b: RegExp };

const REGEX_META_RE = /[\\^$.|?*+()[\]{}]/;
const compiled = new Map<string, Matcher | null>();

function plainSource(words: string): string {
    const body = words
        .trim()
        .split(/\s+/)
        .map((word) => word.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&').replace(/[её]/gi, '[её]'))
        .join('\\s+');
    return `(?<![\\p{L}\\p{N}_])${body}`;
}

function compileOne(source: string): RegExp | null {
    const trimmed = source.trim();
    if (!trimmed) return null;
    let body = trimmed;
    let regex = REGEX_META_RE.test(trimmed);
    if (trimmed.length > 2 && trimmed.startsWith('/') && trimmed.endsWith('/')) {
        body = trimmed.slice(1, -1);
        regex = true;
    }
    if (regex) {
        try {
            return new RegExp(body, 'iu');
        } catch {
            // An invalid regex is read as plain words: the rule keeps working.
        }
    }
    return new RegExp(plainSource(trimmed), 'iu');
}

/** Compiles one pattern (cached); null for an empty or unusable one. */
export function compileBoundaryPattern(pattern: string): Matcher | null {
    const key = String(pattern ?? '');
    if (compiled.has(key)) return compiled.get(key) ?? null;
    let matcher: Matcher | null = null;
    const trimmed = key.trim();
    if (trimmed.toLowerCase().startsWith(BOTH_PREFIX)) {
        const body = trimmed.slice(BOTH_PREFIX.length);
        const split = body.indexOf(BOTH_SEPARATOR);
        const a = split > 0 ? compileOne(body.slice(0, split)) : null;
        const b = split > 0 ? compileOne(body.slice(split + BOTH_SEPARATOR.length)) : null;
        if (a && b) matcher = { type: 'both', a, b };
    } else {
        const re = compileOne(trimmed);
        if (re) matcher = { type: 'single', re, all: new RegExp(re.source, 'giu') };
    }
    compiled.set(key, matcher);
    return matcher;
}

export interface BoundaryUnit {
    /** A paragraph and its sentences. */
    paragraph: string;
    sentences: string[];
}

export interface BoundaryResult {
    id: string;
    /** Number of different hits (capped at 2). */
    score: number;
    confidence: number;
    quote: string;
}

function sentenceOf(text: string, index: number, length: number): string {
    let start = index;
    while (start > 0 && !/[.!?…\n]/.test(text[start - 1] ?? '')) start--;
    let end = index + length;
    while (end < text.length && !/[.!?…\n]/.test(text[end] ?? '')) end++;
    return text.slice(start, Math.min(text.length, end + 1)).trim();
}

/** Hits of one rule over the units: a different matched text or a different pattern is a different hit. */
function scoreRule(patterns: readonly string[], units: readonly BoundaryUnit[]): { score: number; quote: string } {
    const seen = new Set<string>();
    let score = 0;
    let quote = '';
    patterns.forEach((pattern, index) => {
        if (score >= 2) return;
        const matcher = compileBoundaryPattern(pattern);
        if (!matcher) return;
        for (const unit of units) {
            if (score >= 2) return;
            if (matcher.type === 'single') {
                for (const match of unit.paragraph.matchAll(matcher.all)) {
                    const key = `${index}:${match[0].toLowerCase()}`;
                    if (seen.has(key) || !match[0]) continue;
                    seen.add(key);
                    score++;
                    quote ||= sentenceOf(unit.paragraph, match.index, match[0].length);
                }
                continue;
            }
            if (!matcher.a.test(unit.paragraph) || !matcher.b.test(unit.paragraph)) continue;
            const sentence = unit.sentences.find((item) => matcher.a.test(item) && matcher.b.test(item));
            score += sentence ? 2 : 1;
            quote ||= sentence ?? unit.paragraph;
        }
    });
    return { score: Math.min(score, 2), quote };
}

/** Rules hit by the units, with their confidence (one hit → suspicion, two → defect). */
export function matchBoundary(
    rules: readonly { id: string; patterns: readonly string[] }[],
    units: readonly BoundaryUnit[],
): BoundaryResult[] {
    const results: BoundaryResult[] = [];
    for (const rule of rules ?? []) {
        if (!rule || !Array.isArray(rule.patterns) || !rule.patterns.length) continue;
        const { score, quote } = scoreRule(rule.patterns, units);
        if (!score) continue;
        results.push({
            id: rule.id,
            score,
            confidence: score >= 2 ? BOUNDARY_DEFECT : BOUNDARY_SUSPICION,
            quote,
        });
    }
    return results;
}

/* ------------------------------------------------------------------ the default rule */

const LEFT = '(?<![\\p{L}\\p{N}_])';
const RIGHT = '(?![\\p{L}\\p{N}_])';
/** Ages 1–17 as digits. */
const MINOR_AGE = '(?<![\\p{N}.,])(?:[1-9]|1[0-7])(?![\\p{N}])';

/** Minor markers, Russian and English (adult endearments such as «девочка», "good girl", «малыш» are left out). */
const MINOR_MARKERS = [
    `${LEFT}(?:реб[её]н(?:ок|ка|ку|ком|ке)|реб[её]ночек|малол[её]т(?:к|н)|несовершеннолетн|школьниц|школьник|подрост(?:ок|ка|ку|ком|ке|ки|ков|кам|ками|ках|ков)${RIGHT}|младен(?:ец|ца|цу|цем|це|чес)|первоклашк|детсад|детск(?:ий|ого|ом|ому)\\s+сад|(?:перво|второ|третье|четв[её]рто|пято|шесто|седьмо|восьмо|девято|десято)классни|педофил|растлени|растлил|растлева|лоли(?:кон)?${RIGHT}|шотакон)`,
    `${LEFT}(?:одно|двух|тр[её]х|четыр[её]х|пяти|шести|семи|восьми|девяти|десяти|одиннадцати|двенадцати|тринадцати|четырнадцати|пятнадцати|шестнадцати|семнадцати)летн`,
    `${MINOR_AGE}\\s*-?\\s*(?:летн|летк|годовал)`,
    `${LEFT}(?:ей|ему|мне|тебе)\\s+(?:(?:было|исполнилось|всего|только|едва|лишь)\\s+){0,2}(?:${MINOR_AGE}|девять|десять|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать)\\s*(?:лет|год)`,
    '\\b(?:child|children|underage|under-age|preteens?|pre-teens?|prepubescent|pubescent|toddlers?|infants?|schoolgirls?|schoolboys?|grade-?schoolers?|middle-?schoolers?|elementary\\s+school(?:er)?s?|kindergarten(?:ers?)?|lolis?|lolicon|shotas?|shotacon|p(?:a)?edophil\\w*)\\b',
    // "a minor" as a noun only: "a minor injury" is an adjective.
    '\\b(?:a|the)\\s+minor(?=\\s*[.,;:!?)]|\\s+(?:in|at|on|who|and|or|is|was|under|from|with|by|to)\\b)',
    '\\bminors\\b(?!\\s+(?:details?|injur\\w*|issues?|changes?|characters?|roles?|problems?|wounds?|cuts?|keys?|chords?|leagues?|points?|differences?|adjustments?|repairs?)\\b)',
    `\\b(?:[1-9]|1[0-7])[- ]?(?:years?[- ]old|yo|y\\/o)\\b|\\b(?:aged?|age\\s+of)\\s+(?:[1-9]|1[0-7])\\b`,
    '\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[- ]years?[- ]old\\b|\\b(?:young|early)\\s+teens?\\b',
].join('|');

/** Sexual-context markers, Russian and English (narrow: «член семьи», "the sex of the baby", «трах!» do not count). */
const SEXUAL_MARKERS = [
    `${LEFT}(?:секс(?!т|от)|трах(?:ал|ну|ать|ает|аю|ают|нул|аться|ался|алась|ались|ни)|совокуп|оргазм|эрекц|пенис|вагин|клитор|минет|кун+илин|фрикци|соити|мастурб|дроч|изнасил|лиш(?:ил|ить|[её]н|ена)\\p{L}*\\s+девственност|заня(?:ться|лись|лся|лась)\\s+(?:сексом|любовью)|занима(?:ться|лись|лся|лась|ются|ется)\\s+(?:сексом|любовью)|интимн\\p{L}*\\s+(?:близост|ласк|связ))`,
    `${LEFT}кончи(?:л|ла|ли|т|ть)${RIGHT}(?!\\s+(?:\\p{L}+ть(?:ся)?${RIGHT}|с${RIGHT}|со${RIGHT}|дело|работу|войну|школу|университет|институт|жизнь|разговор|урок|игру|ужин|завтрак|обед))`,
    `${LEFT}член(?:ом|у|а)?${RIGHT}(?!\\s+(?:семь|совет|клуб|команд|парти|гильди|отряд|экипаж|орден|обществ|комисси|групп|банд|клан|братств|организаци|правлени|союз|сообществ|культ|сект|экспедици|делегаци|стаи|стая|рода|династи|экипажа))`,
    '\\b(?:sex(?!\\s+(?:of|education|ed)\\b)|sexual(?:ly)?|sexy|fuck(?:s|ed|ing)?|cock|pussy|penis|vagina|clit(?:oris)?|cum(?!\\s+laude)(?:s|med|ming)?|orgasm\\w*|erection|blowjob|handjob|intercourse|masturbat\\w*|aroused|arousal|horny|molest\\w*|rap(?:e|ed|es|ing)|grop(?:e|ed|es|ing)|fondl\\w*|lewd|nsfw|deflower\\w*)\\b',
    '\\b(?:make|made|making)\\s+love\\b|\\b(?:have|had|having)\\s+sex\\b|\\bspread\\s+(?:her|his)\\s+legs\\b',
].join('|');

/** Unambiguous words: a single hit is a suspicion for the judge. */
const UNAMBIGUOUS_MARKERS = `\\b(?:lolicon|shotacon)\\b|${LEFT}(?:лоликон|шотакон)`;

/** Default content boundary (§11): enabled, editable and extendable in the quality settings. */
export const DEFAULT_BOUNDARY_RULES: readonly BoundaryRuleLike[] = [
    {
        id: 'minors',
        title: 'Несовершеннолетние в сексуальном контексте',
        patterns: [`${BOTH_PREFIX}${MINOR_MARKERS}${BOTH_SEPARATOR}${SEXUAL_MARKERS}`, UNAMBIGUOUS_MARKERS],
        enabled: true,
    },
];

/** The swipe instruction for a broken rule. */
export function boundaryInstruction(id: string): string {
    if (id === 'minors') {
        return 'Rewrite the reply with no sexual content involving minors: every character in a sexual context must be an adult.';
    }
    return `Rewrite the reply so that it stays within the content boundary "${id}".`;
}
