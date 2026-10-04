// Free (rule-based) reply quality checks of M12 (plan §6 M12, §11, P4 «сначала правила»). Each check is a pure
// QualityCheck: it reads the reply (and the recent history), returns defects with a confidence, a short quote, the
// rule id and, where the remedy is clear, a fix (an English instruction for the swipe, a cleaned text, «continue»,
// «repair the tracker»). Hits below JUDGE_THRESHOLD are suspicions for the AI judge; the service decides what to do.
// NORMAL, never a defect: the DES tracker JSON at the start, NAI Studio markers and placeholders, BunnyMo tags and
// CK dumps, `<details>`, reasoning blocks hidden by preset regexes, names written in another script, short quoted
// foreign words, NPCs addressing {{user}} by name, a short reply that ends with «…».
// Sheets (M31) are never checked. canonContradiction is the service's (contradictions module), not here.
import { boundaryInstruction, matchBoundary, type BoundaryUnit } from './quality-boundary';
import { cleanJunk, codeLines } from './quality-junk';
import {
    CONSENT_RE,
    EN_ACTION,
    EN_CLICHES,
    EN_SPEECH,
    EN_YOU_ACTION,
    RU_ACTION,
    RU_CALQUES,
    RU_CLICHES,
    RU_SPEECH,
    RU_YOU_ACTION,
    TONE_RULES,
    type Phrase,
} from './quality-lexicon';
import {
    clip,
    contextQuote,
    fenceBlocks,
    isTrackerBody,
    languageName,
    lastUserProse,
    prepareReply,
    recentReplies,
    splitParagraphs,
    splitSentences,
    splitSpeech,
    storyText,
    type PreparedReply,
} from './quality-text';
import type { QualityCheck, QualityInput } from './quality-types';
import { textWords } from './signals-tokens';
import { stripDesTrackerJson, stripHtml } from './text-clean';

export {
    BOTH_PREFIX,
    BOTH_SEPARATOR,
    BOUNDARY_DEFECT,
    BOUNDARY_SUSPICION,
    DEFAULT_BOUNDARY_RULES,
    compileBoundaryPattern,
} from './quality-boundary';
export type { BoundaryRuleLike } from './quality-boundary';

/** Defect of features/quality/api.ts, taken through QualityCheck (domain must not import features). */
type Defect = ReturnType<QualityCheck>[number];
type DefectKind = Defect['kind'];
type DefectFix = NonNullable<Defect['fix']>;

/** Keeps every confidence in 0..1 with two decimals. */
function score(value: number): number {
    return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function swipe(instruction: string): DefectFix {
    return { kind: 'swipe', instruction };
}

/** Sheets are not checked; a missing reply gives nothing. */
function guarded(check: (input: QualityInput) => Defect[]): QualityCheck {
    return (input) => (!input || input.isSheet || !input.reply ? [] : check(input));
}

const LEFT = '(?<![\\p{L}\\p{N}_])';
const RIGHT = '(?![\\p{L}\\p{N}_])';

function escapeRegex(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** Lower case, ё → е: names compared across case and spelling. */
function nameKey(word: string): string {
    return word.toLowerCase().replace(/ё/g, 'е');
}

/* ================================================================== 1. language */

const CYRILLIC_LANGS: ReadonlySet<string> = new Set(['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'ky', 'tg', 'mn']);
// prettier-ignore
const LATIN_LANGS: ReadonlySet<string> = new Set([
    'en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'sk', 'sv', 'no', 'nb', 'da', 'fi', 'tr', 'id', 'ro', 'hu',
    'hr', 'sl', 'lt', 'lv', 'et', 'ca', 'vi', 'ms',
]);
const WORD_RE = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const OTHER_SCRIPT_RE =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}]+/gu;
/** Short quoted, bracketed or emphasised segments: a foreign word in quotes is a quotation, not a slip. */
const SHORT_SEGMENT_RE =
    /«[^«»\n]{1,60}»|“[^“”\n]{1,60}”|"[^"\n]{1,60}"|‘[^‘’\n]{1,60}’|\([^()\n]{1,60}\)|\*[^*\n]{1,40}\*|_[^_\n]{1,40}_/g;
const MIN_RUN_WORDS = 4;
const SENTENCE_BREAK_RE = /[.!?…\n]/;
const MIN_RUN_LOWER = 3;

/** Masks short segments of at most three words with spaces (offsets stay, so quotes can be cut from the prose). */
function maskShortSegments(text: string): string {
    return text.replace(SHORT_SEGMENT_RE, (segment) => {
        const words = segment.match(WORD_RE)?.length ?? 0;
        return words <= 3 ? ' '.repeat(segment.length) : segment;
    });
}

function namesOf(input: QualityInput): Set<string> {
    const names = new Set<string>();
    const add = (value: unknown) => {
        for (const word of String(value ?? '').match(WORD_RE) ?? []) names.add(nameKey(word));
    };
    add(input.userName);
    add(input.charName);
    for (const message of input.history ?? []) add(message?.name);
    return names;
}

interface ScriptStats {
    expectedLetters: number;
    foreignLetters: number;
    foreignWords: number;
    foreignLower: number;
    runs: { start: number; end: number; words: number }[];
}

function isLowerInitial(word: string): boolean {
    const first = word[0] ?? '';
    return first !== first.toUpperCase() && first === first.toLowerCase();
}

/** Letters per script and runs of foreign words (names are neutral; a run needs mostly lower-case words). */
function scriptStats(prose: string, expected: 'cyr' | 'lat', names: ReadonlySet<string>): ScriptStats {
    const stats: ScriptStats = { expectedLetters: 0, foreignLetters: 0, foreignWords: 0, foreignLower: 0, runs: [] };
    let run: { start: number; end: number; words: number; lower: number } | null = null;
    const close = () => {
        if (run && run.words >= MIN_RUN_WORDS && run.lower >= MIN_RUN_LOWER) stats.runs.push(run);
        run = null;
    };
    const masked = maskShortSegments(prose);
    let previousEnd = 0;
    for (const match of masked.matchAll(WORD_RE)) {
        const word = match[0];
        // A sentence mark between words ends a run: «…ждал в Riverside. She looked…» is one slip, not two words more.
        if (SENTENCE_BREAK_RE.test(masked.slice(previousEnd, match.index))) close();
        previousEnd = match.index + word.length;
        const script = CYRILLIC_RE.test(word) ? 'cyr' : LATIN_RE.test(word) ? 'lat' : '';
        if (!script || names.has(nameKey(word))) continue;
        if (script === expected) {
            stats.expectedLetters += word.length;
            close();
            continue;
        }
        const lower = isLowerInitial(word) ? 1 : 0;
        stats.foreignLetters += word.length;
        stats.foreignWords++;
        stats.foreignLower += lower;
        run ??= { start: match.index, end: match.index, words: 0, lower: 0 };
        run.end = match.index + word.length;
        run.words++;
        run.lower += lower;
    }
    close();
    return stats;
}

function styleDefect(prose: string, language: string): Defect | null {
    const calques = language === 'ru' ? RU_CALQUES : [];
    const cliches: readonly Phrase[] = language === 'ru' ? RU_CLICHES : language === 'en' ? EN_CLICHES : [];
    const found: { group: 'calque' | 'cliche'; text: string; index: number }[] = [];
    for (const [group, list] of [
        ['calque', calques],
        ['cliche', cliches],
    ] as const) {
        for (const phrase of list) {
            const match = phrase.re.exec(prose);
            if (match) found.push({ group, text: match[0].trim(), index: match.index });
        }
    }
    if (!found.length) return null;
    const first = found[0]!;
    const examples = found
        .slice(0, 3)
        .map((item) => `"${clip(item.text, 60)}"`)
        .join(', ');
    return {
        kind: 'language',
        confidence: score(found.length >= 3 ? 0.65 : found.length === 2 ? 0.5 : 0.3),
        quote: contextQuote(prose, first.index, first.text.length),
        by: found.some((item) => item.group === 'calque') ? 'language:calque' : 'language:cliche',
        fix: swipe(
            `Rewrite the reply in natural, idiomatic ${languageName(language)} without calques from English and without clichés such as ${examples}.`,
        ),
    };
}

function scriptDefects(prepared: PreparedReply, input: QualityInput): Defect[] {
    const { prose, language } = prepared;
    const expected = CYRILLIC_LANGS.has(language) ? 'cyr' : LATIN_LANGS.has(language) ? 'lat' : null;
    if (!expected) return [];
    const name = languageName(language);
    const defects: Defect[] = [];
    const stats = scriptStats(prose, expected, namesOf(input));
    const total = stats.expectedLetters + stats.foreignLetters;
    const share = total ? stats.foreignLetters / total : 0;
    const instruction = `Rewrite the reply fully in ${name}: narration, dialogue and thoughts; keep only names and tags as they are.`;
    const firstRun = stats.runs[0];
    if (stats.foreignWords >= 5 && stats.foreignLower >= 2 && share >= 0.6) {
        defects.push({
            kind: 'language',
            confidence: 0.95,
            quote: firstRun ? clip(prose.slice(firstRun.start, firstRun.end)) : clip(prose),
            by: 'language:script',
            fix: swipe(instruction),
        });
    } else if (firstRun) {
        const slipped = stats.runs.reduce((sum, item) => sum + item.words, 0);
        const confidence = stats.runs.length >= 2 || slipped >= 12 ? 0.85 : slipped >= 6 ? 0.7 : 0.55;
        defects.push({
            kind: 'language',
            confidence,
            quote: clip(prose.slice(firstRun.start, firstRun.end)),
            by: 'language:mixed',
            fix: swipe(instruction),
        });
    }
    const other = [...prose.matchAll(OTHER_SCRIPT_RE)];
    if (other.length) {
        const chars = other.reduce((sum, match) => sum + [...match[0]].length, 0);
        const first = other[0]!;
        defects.push({
            kind: 'language',
            confidence: chars >= 2 ? 0.85 : 0.6,
            quote: contextQuote(prose, first.index, first[0].length),
            by: 'language:foreign-chars',
            fix: swipe(`Rewrite the reply in ${name} only, without Chinese or other foreign characters.`),
        });
    }
    return defects;
}

/**
 * 1. The reply is not in the chat language: the share of foreign-script letters in the prose, runs of four or more
 * foreign words (names, short quotes and capitalised-only runs ignored), CJK and other scripts; plus calques and
 * clichés (Russian lists, English «slop» for English chats) with low confidence.
 */
export const checkLanguage: QualityCheck = guarded((input) => {
    const prepared = prepareReply(input);
    if (!prepared.prose) return [];
    const defects = scriptDefects(prepared, input);
    const style = styleDefect(prepared.prose, prepared.language);
    if (style) defects.push(style);
    return defects;
});

/* ================================================================== 2. user speech */

interface UserPatterns {
    script: RegExp;
    colon: RegExp;
    attribution: RegExp;
    quoted: RegExp;
    lineStart: RegExp;
    speechOnly: RegExp;
}

const userPatternCache = new Map<string, UserPatterns | null>();
const RU_ADVERB =
    '(?:медленно|тихо|осторожно|молча|быстро|уверенно|нехотя|послушно|наконец|просто|сразу|снова|опять|тоже|уже|покорно|робко|невольно)';
const YOU_RU_RE = new RegExp(`${LEFT}(?:Ты|ты|Вы|вы)\\s+(?:${RU_ADVERB}\\s+)?${RU_YOU_ACTION}`, 'u');
const YOU_EN_RE = new RegExp(
    `\\b[Yy]ou\\s+(?:[a-z]+ly\\s+|(?:then|finally|also|just|now|slowly|quietly|simply|eventually)\\s+)?${EN_YOU_ACTION}`,
    'u',
);
const FIRST_PERSON_RE = /(?:^|[.!?…]\s+)[*_]*(?:Я|I)\s+(?!'m\b|am\b)[\p{Ll}]/u;

function nameForms(userName: string, charName: string): string[] {
    const full = userName.trim();
    if (!full) return [];
    const forms = new Set<string>([full]);
    const first = full.split(/\s+/)[0] ?? '';
    if (first.length >= 2) forms.add(first);
    const charKeys = new Set([nameKey(charName.trim()), nameKey(charName.trim().split(/\s+/)[0] ?? '')]);
    const result = [...forms].filter((form) => !charKeys.has(nameKey(form)));
    if (result.length) result.push('{{user}}');
    return result;
}

function userPatterns(userName: string, charName: string): UserPatterns | null {
    const key = `${userName}\u0000${charName}`;
    if (userPatternCache.has(key)) return userPatternCache.get(key) ?? null;
    const forms = nameForms(userName, charName);
    let patterns: UserPatterns | null = null;
    if (forms.length) {
        const name = `(?:${forms
            .map((form) => escapeRegex(form).replace(/[её]/g, '[её]').replace(/\s+/g, '\\s+'))
            .join('|')})`;
        const speech = `(?:${RU_SPEECH}|${EN_SPEECH}${RIGHT})`;
        const anyVerb = `(?:${RU_SPEECH}|${EN_SPEECH}${RIGHT}|${RU_ACTION}|${EN_ACTION}${RIGHT})`;
        const emphasis = '(?:\\*\\*|__|\\*|_)?';
        patterns = {
            script: new RegExp(
                `(?:^|\\n)[ \\t]*${emphasis}${name}${emphasis}[ \\t]*:[ \\t]*${emphasis}[ \\t]*\\S`,
                'u',
            ),
            colon: new RegExp(`${LEFT}${name}${RIGHT}\\s+(?:\\p{L}+\\s+)?${speech}\\s*:\\s*[«"“—–-]`, 'u'),
            attribution: new RegExp(
                `^[\\s,]*(?:${RU_SPEECH}\\s+${name}${RIGHT}|${name}${RIGHT}\\s+(?:\\p{L}+\\s+)?${RU_SPEECH})`,
                'u',
            ),
            quoted: new RegExp(
                `(?:«([^«»\\n]{1,400})»|"([^"\\n]{1,400})"|“([^“”\\n]{1,400})”)\\s*,?\\s*(?:[—–-]\\s*)?(?:${name}${RIGHT}\\s+(?:\\p{L}+\\s+)?${speech}|${speech}\\s+${name}${RIGHT})`,
                'gu',
            ),
            lineStart: new RegExp(
                `(?:^|[.!?…]\\s+|\\n)[ \\t]*[*_]*${name}${RIGHT}[*_]*\\s+(?:(?!(?:и|а|с|со|или|and|or|with)${RIGHT})\\p{L}+\\s+)?(${anyVerb})`,
                'gu',
            ),
            speechOnly: new RegExp(`^${speech}`, 'u'),
        };
    }
    userPatternCache.set(key, patterns);
    if (userPatternCache.size > 32) userPatternCache.delete(userPatternCache.keys().next().value!);
    return patterns;
}

/** The quoted words were already in the user's message: the reply only echoes them. */
function isEcho(speech: string, userProse: string): boolean {
    const words = textWords(speech);
    if (words.length < 2 || !userProse) return false;
    return ` ${textWords(userProse).join(' ')} `.includes(` ${words.join(' ')} `);
}

interface Hit {
    family: string;
    confidence: number;
    quote: string;
}

/**
 * The most confident hit; two independent kinds of evidence (groups) add 0.05. One spoken line found by two
 * patterns (`"…," Kai said` is both an attribution and a line opening with the name) is one piece of evidence.
 */
function strongestHit(hits: readonly Hit[], group: (family: string) => string = (family) => family): Hit | null {
    if (!hits.length) return null;
    const best = hits.reduce((top, hit) => (hit.confidence > top.confidence ? hit : top));
    const families = new Set(hits.filter((hit) => hit.confidence >= 0.5).map((hit) => group(hit.family)));
    return families.size >= 2 ? { ...best, confidence: Math.min(0.95, best.confidence + 0.05) } : best;
}

function nameHits(prepared: PreparedReply, patterns: UserPatterns, userProse: string): Hit[] {
    const { prose, speech } = prepared;
    const hits: Hit[] = [];
    const script = patterns.script.exec(prose);
    if (script)
        hits.push({ family: 'script', confidence: 0.95, quote: contextQuote(prose, script.index, script[0].length) });
    const colon = patterns.colon.exec(prose);
    if (colon)
        hits.push({ family: 'attributed', confidence: 0.9, quote: contextQuote(prose, colon.index, colon[0].length) });
    let attributed = 0;
    const attribute = (said: string, quote: string) => {
        const echo = isEcho(said, userProse);
        if (!echo) attributed++;
        hits.push({ family: echo ? 'echo' : 'attributed', confidence: echo ? 0.45 : 0.9, quote: clip(quote) });
    };
    for (const { speech: said, words } of speech.attributions) {
        if (patterns.attribution.test(words)) attribute(said, `— ${said} — ${words}`);
    }
    for (const match of prose.matchAll(patterns.quoted)) {
        attribute(match[1] ?? match[2] ?? match[3] ?? '', match[0]);
    }
    if (attributed >= 2)
        hits.push({
            family: 'attributed',
            confidence: 0.95,
            quote: hits.find((h) => h.family === 'attributed')!.quote,
        });
    const speechLines: string[] = [];
    const actionLines: string[] = [];
    for (const match of speech.narration.matchAll(patterns.lineStart)) {
        const quote = contextQuote(speech.narration, match.index, match[0].length);
        (patterns.speechOnly.test(match[1] ?? '') ? speechLines : actionLines).push(quote);
    }
    if (speechLines.length) {
        hits.push({ family: 'line', confidence: speechLines.length >= 2 ? 0.85 : 0.75, quote: speechLines[0]! });
    }
    if (actionLines.length) {
        const confidence = actionLines.length >= 3 ? 0.8 : actionLines.length === 2 ? 0.65 : 0.5;
        hits.push({ family: 'action', confidence, quote: actionLines[0]! });
    }
    return hits;
}

/** Families that are one kind of evidence: the user's spoken words. */
const SPEECH_GROUPS: Record<string, string> = { script: 'speech', attributed: 'speech', line: 'speech' };

function firstPersonCount(text: string): number {
    return splitSentences(splitSpeech(text).narration).filter((sentence) => FIRST_PERSON_RE.test(sentence)).length;
}

/**
 * 2. The reply speaks or acts for {{user}}: a «Name:» script line, speech attributed to the user («— …, — сказал
 * Кай», `"…," Kai says`, «Кай сказал: …»), narration lines opening with the user's name and a speech or action
 * verb, «ты/you» narration that decides the user's actions, first-person narration taking over the user's voice.
 * NPCs addressing the user by name and quotes of the user's own message are not (or barely) defects.
 */
export const checkUserSpeech: QualityCheck = guarded((input) => {
    const prepared = prepareReply(input);
    if (!prepared.prose) return [];
    const userProse = lastUserProse(input.history);
    const patterns = userPatterns(String(input.userName ?? ''), String(input.charName ?? ''));
    const hits: Hit[] = patterns ? nameHits(prepared, patterns, userProse) : [];
    const you = prepared.narrationSentences.filter((sentence) => YOU_RU_RE.test(sentence) || YOU_EN_RE.test(sentence));
    if (you.length) {
        hits.push({
            family: 'you',
            confidence: you.length >= 3 ? 0.9 : you.length === 2 ? 0.8 : 0.6,
            quote: clip(you[0]!),
        });
    }
    const own = prepared.narrationSentences.filter((sentence) => FIRST_PERSON_RE.test(sentence));
    if (own.length >= 2 && userProse && firstPersonCount(userProse) >= 1) {
        const previous = recentReplies(input.history, 3);
        if (previous.length >= 2 && previous.every((text) => firstPersonCount(text) === 0)) {
            hits.push({ family: 'first-person', confidence: 0.55, quote: clip(own[0]!) });
        }
    }
    const best = strongestHit(hits, (family) => SPEECH_GROUPS[family] ?? family);
    if (!best) return [];
    return [
        {
            kind: 'userSpeech',
            confidence: score(best.confidence),
            quote: best.quote,
            by: `userSpeech:${best.family}`,
            fix: swipe("Do not write {{user}}'s words, thoughts or actions; stop where {{user}} would act or speak."),
        },
    ];
});

/* ================================================================== 3. refusal, moralising, softening */

const TONE_INSTRUCTIONS: Record<'refusal' | 'moralizing' | 'softening', string> = {
    refusal:
        'Stay in character and continue the scene as written: no refusals, no out-of-character notes, disclaimers or offers of help.',
    moralizing:
        'Continue the scene without moralizing, warnings, disclaimers or lectures, and do not ask {{user}} for consent again.',
    softening: 'Show the scene fully and directly: no fade to black, no skipped or blurred moments.',
};

function consentCount(text: string): { count: number; first: RegExpMatchArray | null } {
    let count = 0;
    let first: RegExpMatchArray | null = null;
    for (const match of text.matchAll(CONSENT_RE)) {
        count++;
        first ??= match;
    }
    return { count, first };
}

/**
 * 3. Refusals and out-of-role notes, moralising (lectures, fiction disclaimers, repeated consent questions) and
 * softening (fade to black, skipped or blurred scenes). Weights are lower inside dialogue, where a character may
 * refuse or ask in character; a consent question counts only when repeated in the reply or across recent replies.
 * «All characters too agreeable» is the judge's.
 */
export const checkRefusal: QualityCheck = guarded((input) => {
    const prepared = prepareReply(input);
    if (!prepared.prose) return [];
    const { narration, dialogue } = prepared.speech;
    const byKind = new Map<'refusal' | 'moralizing' | 'softening', Hit[]>();
    const push = (kind: 'refusal' | 'moralizing' | 'softening', hit: Hit) => {
        const list = byKind.get(kind) ?? [];
        list.push(hit);
        byKind.set(kind, list);
    };
    for (const rule of TONE_RULES) {
        const inNarration = rule.re.exec(narration);
        if (inNarration) {
            const quote = contextQuote(narration, inNarration.index, inNarration[0].length);
            push(rule.kind, { family: rule.id, confidence: rule.narration, quote });
            continue;
        }
        for (const line of dialogue) {
            const match = rule.re.exec(line);
            if (!match) continue;
            push(rule.kind, { family: rule.id, confidence: rule.dialogue, quote: clip(line) });
            break;
        }
    }
    const consent = consentCount(prepared.prose);
    if (consent.count && consent.first) {
        const earlier = recentReplies(input.history, 4).filter((text) => consentCount(text).count > 0).length;
        const confidence =
            consent.count >= 3 ? 0.9 : consent.count === 2 || earlier >= 2 ? 0.8 : earlier === 1 ? 0.55 : 0;
        if (confidence) {
            const quote = contextQuote(prepared.prose, consent.first.index ?? 0, consent.first[0].length);
            push('moralizing', { family: 'consent', confidence, quote });
        }
    }
    const defects: Defect[] = [];
    for (const [kind, hits] of byKind) {
        const best = strongestHit(hits)!;
        defects.push({
            kind,
            confidence: score(best.confidence),
            quote: best.quote,
            by: `${kind}:${best.family}`,
            fix: swipe(TONE_INSTRUCTIONS[kind]),
        });
    }
    return defects;
});

/* ================================================================== 4. repetition */

const SHINGLE = 5;
const MIN_REPLY_WORDS = 15;
const MIN_SENTENCE_WORDS = 6;
const OPENING_WORDS = 6;
const WORDS_RE = /[\p{L}\p{N}]+/gu;

/** Normalised words (lower case, ё → е); twice as fast as signals-tokens textWords on long replies. */
function wordsOf(text: string): string[] {
    return text.normalize('NFC').toLowerCase().replace(/ё/g, 'е').match(WORDS_RE) ?? [];
}

function shingles(words: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i + SHINGLE <= words.length; i++) {
        out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]} ${words[i + 4]}`);
    }
    return out;
}

interface SentenceWords {
    text: string;
    words: string[];
    /** Normalised sentence of MIN_SENTENCE_WORDS or more words; null for short ones. */
    key: string | null;
}

/** Sentences with their words, and all words of the text (sentences split at whitespace, so nothing is lost). */
function sentenceWords(sentences: readonly string[]): { sentences: SentenceWords[]; words: string[] } {
    const words: string[] = [];
    const out = sentences.map((text) => {
        const own = wordsOf(text);
        for (const word of own) words.push(word);
        return { text, words: own, key: own.length >= MIN_SENTENCE_WORDS ? own.join(' ') : null };
    });
    return { sentences: out, words };
}

interface ReplyFingerprint {
    shingles: Set<string>;
    sentences: Set<string>;
    opening: string | null;
}

const FINGERPRINT_LIMIT = 32;
const fingerprints = new Map<string, ReplyFingerprint>();

/** 5-grams, sentence keys and opening of an earlier reply (LRU: the same history is checked turn after turn). */
function fingerprint(prose: string): ReplyFingerprint {
    const cached = fingerprints.get(prose);
    if (cached) {
        fingerprints.delete(prose);
        fingerprints.set(prose, cached);
        return cached;
    }
    const { sentences, words } = sentenceWords(splitSentences(prose));
    const result: ReplyFingerprint = {
        shingles: shingles(words),
        sentences: new Set(sentences.map((sentence) => sentence.key).filter((key): key is string => key !== null)),
        opening: words.length >= OPENING_WORDS ? words.slice(0, OPENING_WORDS).join(' ') : null,
    };
    fingerprints.set(prose, result);
    if (fingerprints.size > FINGERPRINT_LIMIT) fingerprints.delete(fingerprints.keys().next().value!);
    return result;
}

/**
 * 4. Repetition of the last 3–5 assistant replies: share of the reply's word 5-grams already used, whole repeated
 * sentences (six or more words) and the same opening (first six words).
 */
export const checkRepetition: QualityCheck = guarded((input) => {
    const prepared = prepareReply(input);
    const { sentences, words } = sentenceWords(prepared.sentences);
    if (words.length < MIN_REPLY_WORDS) return [];
    const previous = recentReplies(input.history, 5);
    if (!previous.length) return [];
    const reply = shingles(words);
    const earlier = previous.map(fingerprint);
    const seen = (shingle: string) => earlier.some((item) => item.shingles.has(shingle));
    let shared = 0;
    for (const shingle of reply) if (seen(shingle)) shared++;
    const overlap = shared / reply.size;
    const repeated = sentences.filter(
        (sentence) => sentence.key !== null && earlier.some((item) => item.sentences.has(sentence.key!)),
    );
    const opening = words.slice(0, OPENING_WORDS).join(' ');
    const sameOpening = earlier.filter((item) => item.opening === opening).length;
    const first = sentences[0]!.text;
    const candidates: { by: string; confidence: number; quote: string }[] = [];
    if (overlap >= 0.15) {
        const sentence = sentences.find((item) => [...shingles(item.words)].some(seen))?.text ?? first;
        const confidence = overlap >= 0.4 ? 0.9 : overlap >= 0.25 ? 0.8 : 0.55;
        candidates.push({ by: 'repetition:overlap', confidence, quote: clip(sentence) });
    }
    if (repeated.length) {
        const longest = Math.max(...repeated.map((sentence) => sentence.words.length));
        const confidence = repeated.length >= 3 ? 0.85 : repeated.length === 2 ? 0.7 : longest >= 8 ? 0.5 : 0.35;
        candidates.push({ by: 'repetition:sentences', confidence, quote: clip(repeated[0]!.text) });
    }
    if (sameOpening) {
        candidates.push({ by: 'repetition:opening', confidence: sameOpening >= 2 ? 0.8 : 0.55, quote: clip(first) });
    }
    if (!candidates.length) return [];
    const best = candidates.reduce((top, item) => (item.confidence > top.confidence ? item : top));
    const boost = candidates.filter((item) => item.confidence >= 0.5).length >= 2 ? 0.05 : 0;
    return [
        {
            kind: 'repetition',
            confidence: score(Math.min(0.95, best.confidence + boost)),
            quote: best.quote,
            by: best.by,
            fix: swipe(
                'Write this reply with new wording and new events; do not reuse sentences, phrases or the opening of earlier replies.',
            ),
        },
    ];
});

/* ================================================================== 5. truncated */

const LENGTH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens', 'max_output_tokens', 'model_length']);
/** Endings of a finished reply: sentence marks, closing quotes and brackets, emphasis, dashes, hearts, emoji. */
const FINISHED_END_RE = /(?:[.!?…»"”“'’)\]}*_~>`—–\-♡♥❤]|[♪♫]|\p{Extended_Pictographic}|\p{Emoji_Presentation})\s*$/u;
const SOFT_STOP_END_RE = /[,;:]\s*$/;
const LIST_ITEM_RE = /^\s*(?:\d{1,2}[.)]|[-*•])\s+\S/;
/** A status footer line («📍 Таверна | 🕐 Вечер», «Время: вечер»): not the end of the story. */
const STATUS_LINE_RE =
    /\||^\s*(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})|^[^.!?…:\n]{1,30}:\s*[^.!?…\n]{1,60}$/u;
/** Words a sentence cannot end with. */
const DANGLING_RE =
    /(?<![\p{L}\p{N}])(?:и|в|во|на|с|со|к|ко|по|за|из|от|до|но|а|что|как|чтобы|если|когда|его|её|ее|the|a|an|and|to|of|in|on|with|but|or|for|her|his|my|your|their|that)$/iu;
const UNCLOSED_TAG_RE = /<[A-Za-z!][^<>]*$/;
const CONTINUE_INSTRUCTION = 'Continue the reply exactly from where it stopped; do not repeat what is already written.';

function continueFix(): DefectFix {
    return { kind: 'continue', instruction: CONTINUE_INSTRUCTION };
}

/**
 * 5. A cut reply: finish reason 'length', an unclosed fence or tag at the end of the stored text, or prose that
 * ends mid-sentence (no sentence mark, closing quote, emphasis or closing tag) once trackers and markers are gone.
 */
export const checkTruncated: QualityCheck = guarded((input) => {
    const raw = String(input.reply.text ?? '');
    const prepared = prepareReply(input);
    const tail = clip(prepared.prose.slice(-120) || raw.slice(-120));
    const reason = String(input.finishReason ?? '').toLowerCase();
    if (LENGTH_REASONS.has(reason)) {
        return [{ kind: 'truncated', confidence: 0.95, quote: tail, by: 'truncated:length', fix: continueFix() }];
    }
    if (!raw.trim()) return [];
    const trimmed = raw.trimEnd();
    if (fenceBlocks(trimmed).some((block) => !block.closed) || UNCLOSED_TAG_RE.test(trimmed)) {
        return [
            {
                kind: 'truncated',
                confidence: 0.9,
                quote: clip(trimmed.slice(-120)),
                by: 'truncated:unclosed',
                fix: continueFix(),
            },
        ];
    }
    const lines = splitParagraphs(prepared.prose);
    while (lines.length > 1 && STATUS_LINE_RE.test(lines[lines.length - 1]!)) lines.pop();
    const lastLine = lines[lines.length - 1] ?? '';
    const prose = lines.join('\n');
    if (!prose || FINISHED_END_RE.test(prose) || LIST_ITEM_RE.test(lastLine)) return [];
    const confidence = SOFT_STOP_END_RE.test(prose) || DANGLING_RE.test(prose) ? 0.9 : prose.length < 60 ? 0.5 : 0.8;
    return [{ kind: 'truncated', confidence, quote: tail, by: 'truncated:open-end', fix: continueFix() }];
});

/* ================================================================== 6. junk */

const JUNK_SWIPE = 'Write only the roleplay reply itself, in prose: no code, no service tokens, no prompt text.';

/**
 * 6. Service junk: leaked template tokens, program code that is not the DES JSON block, document-level HTML,
 * tool-call blocks, prompt echoes. The fix is a clean text with exactly the junk removed; a reply that is mostly
 * code (the prefill bug: `<｜begin▁of▁sentence｜>` and random code) or nothing but junk gets a swipe instead.
 */
export const checkJunk: QualityCheck = guarded((input) => {
    const raw = String(input.reply.text ?? '');
    if (!raw) return [];
    const { cleaned, hits } = cleanJunk(raw);
    const removable = hits.filter((hit) => hit.removable);
    const defects: Defect[] = [];
    const rules = [...new Set(removable.map((hit) => hit.rule))];
    const prose = storyText(cleaned);
    const { code, total } = codeLines(prose);
    if (code >= 3 && code / Math.max(1, total) >= 0.5) {
        defects.push({
            kind: 'junk',
            confidence: 0.95,
            quote: clip(prose),
            by: ['junk:code-unfenced', ...rules].join('+'),
            fix: swipe(JUNK_SWIPE),
        });
    } else if (removable.length) {
        const confidence = Math.max(...removable.map((hit) => hit.confidence));
        defects.push({
            kind: 'junk',
            confidence,
            quote: clip(removable[0]!.text),
            by: `junk:${rules.join('+')}`,
            fix: prose ? { kind: 'clean', cleaned } : swipe(JUNK_SWIPE),
        });
    }
    const fenceText = hits.find((hit) => hit.rule === 'fence-text');
    if (fenceText) {
        defects.push({
            kind: 'junk',
            confidence: fenceText.confidence,
            quote: clip(fenceText.text),
            by: 'junk:fence-text',
        });
    }
    return defects;
});

/* ================================================================== 7. missing tracker */

const LEADING_NOISE_RE = /^(?:\s|<｜[^｜\n]{1,64}｜>|<\|[A-Za-z][A-Za-z0-9_]{0,40}\|>)*/;
const TRACKER_KEY_RE = /"(?:quests|infoBox|infobox|characterThoughts|characters)"\s*:/;

/**
 * 7. DES together mode expects the tracker JSON block at the start of the reply: none at all (repair through DES),
 * a broken or cut block at the start, or a block elsewhere in the reply (DES may still have read it: suspicion).
 */
export const checkMissingTracker: QualityCheck = guarded((input) => {
    if (!input.desTogether) return [];
    const raw = String(input.reply.text ?? '');
    if (!raw.trim()) return [];
    const lead = raw.replace(LEADING_NOISE_RE, '');
    if (stripDesTrackerJson(lead) !== lead) return [];
    const fix: DefectFix = { kind: 'repairTracker' };
    const head = lead.slice(0, 400);
    if (/^(?:```[^\n]*\n\s*)?\{/.test(head) && TRACKER_KEY_RE.test(head)) {
        return [
            {
                kind: 'missingTracker',
                confidence: 0.9,
                quote: clip(head.slice(0, 120)),
                by: 'missingTracker:broken',
                fix,
            },
        ];
    }
    const elsewhere = fenceBlocks(lead).find((block) => isTrackerBody(block.body));
    if (elsewhere) {
        const quote = clip(lead.slice(elsewhere.start, elsewhere.start + 120));
        return [{ kind: 'missingTracker', confidence: 0.5, quote, by: 'missingTracker:position', fix }];
    }
    const quote = clip(prepareReply(input).prose.slice(0, 120) || lead.slice(0, 120));
    return [{ kind: 'missingTracker', confidence: 0.95, quote, by: 'missingTracker:absent', fix }];
});

/* ================================================================== 8. boundary */

const MARKER_PROMPT_RE =
    /data-nai\s*=\s*(?:'([^']*)'|"([^"]*)")|\[IMG:GEN:(\{[\s\S]*?\})\]|<!--\s*img-prompt="([^"]*)"\s*-->/gi;

/** Paragraphs of the prose plus the prompts of image markers (a picture is content too). */
function boundaryUnits(raw: string, prepared: PreparedReply): BoundaryUnit[] {
    const units: BoundaryUnit[] = prepared.paragraphs.map((paragraph) => ({
        paragraph,
        sentences: splitSentences(paragraph),
    }));
    for (const match of raw.matchAll(MARKER_PROMPT_RE)) {
        const value = stripHtml(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
        if (value) units.push({ paragraph: value, sentences: [value] });
    }
    return units;
}

/**
 * 8. Content boundary (§11): the enabled rules of the input. One hit is a suspicion for the judge (0.5), two
 * different hits a defect (0.85); a `both:` pattern matching inside one sentence counts as two. The rule id is `by`.
 */
export const checkBoundary: QualityCheck = guarded((input) => {
    const rules = Array.isArray(input.boundary) ? input.boundary : [];
    if (!rules.length) return [];
    const raw = String(input.reply.text ?? '');
    const units = boundaryUnits(raw, prepareReply(input));
    if (!units.length) return [];
    return matchBoundary(rules, units).map((result) => ({
        kind: 'boundary' as const,
        confidence: result.confidence,
        quote: clip(result.quote),
        by: result.id,
        fix: swipe(boundaryInstruction(result.id)),
    }));
});

/* ================================================================== all together */

/** The free checks by name, in the plan's order. */
export const FREE_CHECKS: Readonly<Record<string, QualityCheck>> = {
    language: checkLanguage,
    userSpeech: checkUserSpeech,
    refusal: checkRefusal,
    repetition: checkRepetition,
    truncated: checkTruncated,
    junk: checkJunk,
    missingTracker: checkMissingTracker,
    boundary: checkBoundary,
};

const KIND_ORDER: readonly DefectKind[] = [
    'junk',
    'truncated',
    'missingTracker',
    'boundary',
    'refusal',
    'language',
    'userSpeech',
    'moralizing',
    'softening',
    'repetition',
    'canonContradiction',
];

function safely(check: QualityCheck, input: QualityInput): Defect[] {
    try {
        return check(input);
    } catch {
        return [];
    }
}

/**
 * Runs every free check: one defect per kind and rule id (the most confident), sorted by confidence (then by kind
 * severity). Sheets give nothing. A check that throws is skipped: one broken rule must not hide the others.
 */
export function runFreeChecks(input: QualityInput): Defect[] {
    if (!input || input.isSheet || !input.reply) return [];
    const merged = new Map<string, Defect>();
    for (const check of Object.values(FREE_CHECKS)) {
        for (const defect of safely(check, input)) {
            const key = `${defect.kind}\u0000${defect.by}`;
            const current = merged.get(key);
            if (!current || defect.confidence > current.confidence) merged.set(key, defect);
        }
    }
    return [...merged.values()].sort(
        (a, b) => b.confidence - a.confidence || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
}
