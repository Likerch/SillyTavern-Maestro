// Who left the scene (M43 «Сцена и вокруг»). DES «together» writes its tracker before the narration, so a character
// who walks out in a reply is still listed by that reply's tracker — and Maestro would keep their voice card, wardrobe
// line and mechanics in the next prompt, which pulls the model back to them. Here the narration decides: a character is
// out of the scene from the next turn when a committed reply (tracker JSON, HTML and the `<offscreen>` block left out)
// shows them leaving — an exit verb in the same sentence as their name, «дверь за ней закрылась», «она вышла» right
// after a sentence about her. They are back when a later reply has them act or speak in the scene (their name as a
// subject, not inside quoted speech, not after a preposition), or the player's message brings them (names them, not in
// a question).
//
// Read from the chat itself, newest first, up to `lookBack` assistant replies back: a reload, a swipe, an edit or a
// deleted message change the answer with no state to repair. Names: the tracker's name, the world model's names and
// aliases (nominative, «exact») and their case forms (world model / DES-RU, else a Russian stem); exact before
// inflected — an exit verb belongs to a name in the nominative near it whose gender agrees with the verb.
// Pure: no DOM, no SillyTavern.
import { nameGender } from './name-gender';
import type { NameGender } from './name-gender';
import { splitSentences } from './quality-text';
import { cleanForAnalysis } from './text-clean';
import { mentionNeedles, normalizeName } from './world-names';
import type { MentionNeedle } from './world-names';

export interface DepartureCandidate {
    /** The key the caller filters by: the name as the DES tracker writes it. */
    name: string;
    /** Names in the nominative: the tracker's, the world model's, aliases. */
    names: readonly string[];
    /** Case forms (world model, DES-RU); without any, single Cyrillic names also match by their stem. */
    forms: readonly string[];
}

export interface DepartureOptions {
    /** Assistant replies read back (default DEPARTURE_LOOKBACK). */
    lookBack?: number;
}

/** Replies read back for a departure: a character who left longer ago is usually gone from the tracker too. */
export const DEPARTURE_LOOKBACK = 12;

type Verb = NameGender | 'p' | null;

interface Span {
    start: number;
    end: number;
}

interface Mention extends Span {
    /** The word is one of the names in the nominative (not a case form). */
    exact: boolean;
    /** After a preposition, inside quoted speech or a possessive: a mention, never the one acting. */
    passive: boolean;
}

interface Matcher {
    candidate: DepartureCandidate;
    needles: MentionNeedle[];
    exact: Set<string>;
    gender: NameGender | null;
}

type Event = 'away' | 'here';

const L = '\\p{L}';
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

// Exit verbs (text is normalised: lower case, ё → е). Past tense carries gender; present tense does not.
// prettier-ignore
const RU_EXITS = [
    'ушел', 'ушла', 'ушли', 'покинул', 'покинула', 'покинули', 'удалился', 'удалилась', 'удалились', 'скрылся',
    'скрылась', 'скрылись', 'исчез', 'исчезла', 'исчезли', 'отправился', 'отправилась', 'отправились', 'уехал',
    'уехала', 'уехали', 'ускакал', 'ускакала', 'ускакали', 'убежал', 'убежала', 'убежали', 'ретировался',
    'ретировалась', 'умчался', 'умчалась', 'умчались', 'уходит', 'уходят', 'покидает', 'покидают', 'удаляется',
    'удаляются', 'скрывается', 'скрываются', 'исчезает', 'исчезают', 'уезжает', 'уезжают', 'убегает', 'убегают',
];
/**
 * «Вышла» is not an exit when she steps forward, out of the shadow, from behind the table or towards someone; «выходит,
 * что…» is «it turns out».
 */
const RU_STAYS = `(?!\\s+(?:вперед|навстречу|из-за|на середину|на свет|из тени|к|ко|что)(?!${L}))`;
const RU_OUT = `(?:(?:вышел|вышла|вышли)(?!${L})${RU_STAYS}|(?:выходит|выходят)(?!${L})(?!\\s*,)${RU_STAYS})`;
/** «Направилась» only with «прочь» or towards the way out. */
const RU_HEADED = `(?:направился|направилась|направились|направляется|направляются)(?!${L})(?=(?:\\s+${L}+){0,2}?\\s+(?:прочь|к выходу|к двери|к дверям|на выход)(?!${L}))`;
const RU_EXIT_RE = new RegExp(`(?<!${L})(?:${RU_OUT}|${RU_HEADED}|(?:${RU_EXITS.join('|')})(?!${L}))`, 'gu');

const EN_PLACES =
    'room|house|hall|tavern|inn|building|chamber|camp|shop|kitchen|office|library|tent|cabin|cave|ship|castle|palace|keep|bar|party|table|courtyard|garden|study|scene';
const EN_EXIT_RE = new RegExp(
    `\\b(?:(?:walked|stormed|stepped|marched|slipped|hurried|ran|went|headed|strode|rushed) (?:out|off|away)|went away|walked away|departed|disappeared|vanished|(?:rode|drove|sailed) (?:off|away)|left(?= the (?:${EN_PLACES})\\b| without\\b| in a hurry\\b| abruptly\\b| for good\\b|\\s*[.!,;]|$))`,
    'g',
);

const RU_DOOR_RE = new RegExp(
    `двер${L}*\\s+(?:${L}+\\s+)?за\\s+(${L}+)\\s+(?:${L}+\\s+)?(?:закрыл|захлопнул|затворил)${L}*|за\\s+(${L}+)\\s+(?:${L}+\\s+)?(?:закрыл|захлопнул|затворил)${L}*\\s+(?:${L}+\\s+)?двер`,
    'gu',
);
const EN_DOOR_RE =
    /\bdoor\s+(?:\w+\s+)?(?:closed|shut|slammed(?:\s+shut)?|clicked\s+shut|swung\s+shut)\s+behind\s+(\w+)/g;

/** Relative clause after a name in another case: «…Веру, которая вышла». */
const RELATIVE_RE = /^\s*,\s*(?:которая|который|которые|who)(?![\p{L}])/u;
const RU_PRONOUN_RE = /(?<![\p{L}])(он|она)(?![\p{L}])/gu;
const EN_PRONOUN_RE = /\b(he|she)\b/g;
const PRONOUN_GENDER: Record<string, NameGender> = { он: 'm', она: 'f', he: 'm', she: 'f', ним: 'm', ней: 'f' };
const PRONOUN_SPAN = 30;

// prettier-ignore
const PREPOSITIONS = new Set([
    'о', 'об', 'обо', 'про', 'без', 'для', 'у', 'к', 'ко', 'от', 'до', 'из', 'с', 'со', 'за', 'над', 'под', 'перед',
    'при', 'по', 'через', 'между', 'около', 'возле', 'после', 'вокруг', 'вслед', 'of', 'about', 'for', 'to', 'with',
    'without', 'after', 'at', 'from', 'behind', 'toward', 'towards', 'like', 'than', 'by', 'on', 'onto', 'into',
    'beside', 'near', 'upon',
]);

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function verbGender(word: string): Verb {
    if (/^[a-z ]+$/.test(word)) return null;
    if (/(?:ли|лись|ют|ят|ются|ятся)$/.test(word)) return 'p';
    if (/(?:ла|лась)$/.test(word)) return 'f';
    if (/(?:л|лся|ез)$/.test(word)) return 'm';
    return null;
}

function agrees(verb: Verb, gender: NameGender | null): boolean {
    return verb === null || verb === 'p' || gender === null || verb === gender;
}

/** Every occurrence of a needle with a left boundary and at most `tail` word characters after it. */
function occurrences(text: string, needle: MentionNeedle): Span[] {
    const out: Span[] = [];
    if (!needle.needle) return out;
    for (let at = text.indexOf(needle.needle); at >= 0; at = text.indexOf(needle.needle, at + 1)) {
        if (at > 0 && WORD_CHAR_RE.test(text[at - 1] ?? '')) continue;
        let end = at + needle.needle.length;
        let extra = 0;
        while (end < text.length && WORD_CHAR_RE.test(text[end] ?? '') && extra <= needle.tail) {
            end++;
            extra++;
        }
        if (extra <= needle.tail) out.push({ start: at, end });
    }
    return out;
}

/** Ranges of quoted speech: «…», “…”, "…". */
function quoteRanges(text: string): Span[] {
    const out: Span[] = [];
    for (const match of text.matchAll(/«[^«»]*»|“[^“”]*”|"[^"]*"/g)) {
        const start = match.index ?? 0;
        out.push({ start, end: start + match[0].length });
    }
    return out;
}

function previousWord(text: string, at: number): string {
    return /([\p{L}]+)[^\p{L}]*$/u.exec(text.slice(Math.max(0, at - 24), at))?.[1] ?? '';
}

function matcherOf(candidate: DepartureCandidate): Matcher {
    const names = [candidate.name, ...candidate.names].filter((name) => typeof name === 'string' && name.trim());
    const forms = candidate.forms.filter((form) => typeof form === 'string' && form.trim());
    return {
        candidate,
        needles: mentionNeedles(names, forms, forms.length === 0),
        exact: new Set(names.map(normalizeName).filter(Boolean)),
        gender: nameGender(candidate.name) ?? names.map(nameGender).find((gender) => gender !== null) ?? null,
    };
}

function mentionsIn(text: string, matcher: Matcher, quotes: readonly Span[]): Mention[] {
    const spans = new Map<number, Span>();
    for (const needle of matcher.needles) {
        for (const span of occurrences(text, needle)) {
            const known = spans.get(span.start);
            if (!known || known.end < span.end) spans.set(span.start, span);
        }
    }
    return [...spans.values()]
        .sort((a, b) => a.start - b.start)
        .map((span) => {
            const word = text.slice(span.start, span.end);
            const quoted = quotes.some((range) => span.start > range.start && span.end < range.end);
            const possessive = /^['’]s\b/.test(text.slice(span.end, span.end + 3));
            const passive = quoted || possessive || PREPOSITIONS.has(previousWord(text, span.start));
            return { ...span, exact: matcher.exact.has(word), passive };
        });
}

interface SentenceRead {
    away: Set<number>;
    here: Set<number>;
    /** Candidates named in any form (pronouns of the next sentence may stand for them). */
    named: Set<number>;
}

interface Exit extends Span {
    verb: Verb;
}

function exitsIn(text: string): Exit[] {
    const out: Exit[] = [];
    for (const re of [RU_EXIT_RE, EN_EXIT_RE]) {
        re.lastIndex = 0;
        for (const match of text.matchAll(re)) {
            const start = match.index ?? 0;
            out.push({ start, end: start + match[0].length, verb: verbGender(match[0]) });
        }
    }
    return out;
}

/** The one candidate of a pronoun's gender named in this sentence or the one before (gender must be known). */
function pronounTarget(
    gender: NameGender,
    matchers: readonly Matcher[],
    here: ReadonlyMap<number, Mention[]>,
    before: ReadonlySet<number>,
): number | null {
    const fits = matchers
        .map((matcher, index) => ({ matcher, index }))
        .filter(
            ({ matcher, index }) =>
                matcher.gender === gender && ((here.get(index)?.length ?? 0) > 0 || before.has(index)),
        );
    return fits.length === 1 ? fits[0]!.index : null;
}

function readSentence(
    sentence: string,
    matchers: readonly Matcher[],
    previous: ReadonlySet<number>,
    user: boolean,
): SentenceRead {
    const text = normalizeName(sentence);
    const quotes = quoteRanges(text);
    const mentions = new Map<number, Mention[]>();
    matchers.forEach((matcher, index) => {
        const found = mentionsIn(text, matcher, quotes);
        if (found.length) mentions.set(index, found);
    });
    const away = new Set<number>();
    const pronounAt = (start: number, end: number): number | null => {
        const window = text.slice(Math.max(0, start - PRONOUN_SPAN), end);
        let gender: NameGender | undefined;
        for (const re of [RU_PRONOUN_RE, EN_PRONOUN_RE]) {
            re.lastIndex = 0;
            for (const match of window.matchAll(re)) gender = PRONOUN_GENDER[match[1] ?? ''] ?? gender;
        }
        return gender ? pronounTarget(gender, matchers, mentions, previous) : null;
    };

    for (const exit of exitsIn(text)) {
        if (exit.verb === 'p') {
            for (const [index, list] of mentions) if (list.some((item) => item.exact && !item.passive)) away.add(index);
            continue;
        }
        // «…Веру, которая вышла»: a name followed by a relative clause holding the verb (the nearest such name).
        let relative: { index: number; at: number } | null = null;
        for (const [index, list] of mentions) {
            if (!agrees(exit.verb, matchers[index]!.gender)) continue;
            for (const item of list) {
                if (item.end > exit.start || !RELATIVE_RE.test(text.slice(item.end, exit.start))) continue;
                if (!relative || item.end > relative.at) relative = { index, at: item.end };
            }
        }
        if (relative) {
            away.add(relative.index);
            continue;
        }
        // The subject: a name in the nominative near the verb whose gender agrees (after the verb counts double).
        let best: { index: number; distance: number } | null = null;
        for (const [index, list] of mentions) {
            if (!agrees(exit.verb, matchers[index]!.gender)) continue;
            for (const item of list) {
                if (!item.exact || item.passive) continue;
                const distance = item.end <= exit.start ? exit.start - item.end : (item.start - exit.end) * 2;
                if (distance >= 0 && (!best || distance < best.distance)) best = { index, distance };
            }
        }
        if (best) {
            away.add(best.index);
            continue;
        }
        const target = pronounAt(exit.start, exit.start);
        if (target !== null && agrees(exit.verb, matchers[target]!.gender)) away.add(target);
    }

    for (const re of [RU_DOOR_RE, EN_DOOR_RE]) {
        re.lastIndex = 0;
        for (const match of text.matchAll(re)) {
            const word = match[1] ?? match[2] ?? '';
            const gender = PRONOUN_GENDER[word];
            if (gender) {
                const target = pronounTarget(gender, matchers, mentions, previous);
                if (target !== null) away.add(target);
                continue;
            }
            const start = (match.index ?? 0) + match[0].indexOf(word);
            for (const [index, list] of mentions) {
                if (list.some((item) => item.start <= start && item.end >= start + word.length)) away.add(index);
            }
        }
    }

    const here = new Set<number>();
    const question = /\?\s*["»”']*\s*$/.test(sentence.trim());
    for (const [index, list] of mentions) {
        if (away.has(index)) continue;
        if (user ? !question : list.some((item) => item.exact && !item.passive)) here.add(index);
    }
    return { away, here, named: new Set(mentions.keys()) };
}

/** The last thing a message says about each candidate: left (away) or in the scene (here). */
function readMessage(text: string, matchers: readonly Matcher[], user: boolean): Map<number, Event> {
    const out = new Map<number, Event>();
    let previous: ReadonlySet<number> = new Set();
    for (const sentence of splitSentences(text)) {
        const read = readSentence(sentence, matchers, previous, user);
        for (const index of read.here) out.set(index, 'here');
        for (const index of read.away) out.set(index, 'away');
        previous = read.named;
    }
    return out;
}

function lastUserIndex(chat: readonly unknown[]): number {
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (isDict(message) && message.is_user === true) return i;
    }
    return -1;
}

/**
 * The candidates (their `name`) the narration shows leaving and not coming back, read back from the player's last
 * message (replies after it are not committed yet: a swipe or a reply being written does not count). To count the
 * newest reply, read the chat with a user message appended (as sceneTracker callers do).
 */
export function departedCharacters(
    chat: readonly unknown[],
    candidates: readonly DepartureCandidate[],
    options: DepartureOptions = {},
): string[] {
    if (!candidates.length || !chat.length) return [];
    const start = lastUserIndex(chat);
    if (start < 0) return [];
    const lookBack = Math.max(1, Math.floor(options.lookBack ?? DEPARTURE_LOOKBACK));
    const matchers = candidates.map(matcherOf);
    const decided = new Map<number, Event>();
    let replies = 0;
    for (let i = start; i >= 0 && replies < lookBack && decided.size < matchers.length; i--) {
        const message = chat[i];
        if (!isDict(message) || message.is_system === true) continue;
        const user = message.is_user === true;
        if (!user) replies++;
        const text = cleanForAnalysis(message);
        if (!text) continue;
        for (const [index, event] of readMessage(text, matchers, user))
            if (!decided.has(index)) decided.set(index, event);
    }
    return matchers.filter((_, index) => decided.get(index) === 'away').map((matcher) => matcher.candidate.name);
}
