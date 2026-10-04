// M18 «Кто что знает», pure matching (plan M18 п. 3, M15 п. 1): a voice card says what a present character does not
// know only when the topic came up. A fact's topic came up when one of its topic words occurs in the recent story text
// with a left word boundary: names (capitalised topics) may take a short Russian case ending — or any ending after
// the stem when no forms are known — Latin names need a right boundary too; keywords (lower-case topics) match as
// prefixes (Cyrillic ones by their stem: «поцелуй» → «поцел…»). Secrets first, then the newest; at most three.
// Pure: no DOM, no SillyTavern.
import { hasCyrillic, russianStem } from './canon-keys';
import { desSwipeRecord, parseDesCharacters, parseTrackerJson } from './des-tracker';
import { knows } from './knowledge-facts';
import type { KnowledgeFactData } from './knowledge-facts';
import { cleanForAnalysis } from './text-clean';
import { presentCharacters } from './voices-cards';
import { findNeedle, normalizeName } from './world-names';

/** Facts a card names at most (plan M18 п. 3). */
export const MAX_UNKNOWN = 3;
/** Messages read for «the topic came up» (the committed reply, the user's answer and the two before). */
export const RECENT_MESSAGES = 4;
/** Word characters a Cyrillic name may be followed by (a case ending: «Анн|ой»). */
const NAME_TAIL = 2;
/** After a stem («Маш|енька» is too much, «Маш|ей» is fine). */
const STEM_TAIL = 3;
/** Word characters after a keyword: Latin «kiss|ed», Cyrillic «поцел|овал». */
const LATIN_KEYWORD_TAIL = 3;
const CYRILLIC_KEYWORD_TAIL = 6;
const MIN_NAME = 2;
const MIN_KEYWORD = 4;

/** A Russian keyword without its ending vowels («поцелуй» → «поцел», «смерть» → «смерт»), at least four letters. */
export function keywordStem(word: string): string {
    const stem = word.replace(/[аяоеёьйыиуюэ]+$/u, '');
    return stem.length >= MIN_KEYWORD ? stem : word;
}

export interface TopicNeedle {
    needle: string;
    tail: number;
}

/** How one topic word is looked for in normalised text. */
export function topicNeedles(topic: string): TopicNeedle[] {
    const raw = topic.trim();
    const needle = normalizeName(raw);
    if (!needle) return [];
    const name = /^\p{Lu}/u.test(raw);
    const cyrillic = hasCyrillic(needle);
    const single = !needle.includes(' ');
    const out: TopicNeedle[] = [];
    const add = (value: string, tail: number, min: number) => {
        if (value.length >= min && !out.some((item) => item.needle === value && item.tail >= tail)) {
            out.push({ needle: value, tail });
        }
    };
    if (name) {
        add(needle, cyrillic ? NAME_TAIL : 0, MIN_NAME);
        if (cyrillic && single) add(normalizeName(russianStem(raw)), STEM_TAIL, MIN_NAME + 1);
        return out;
    }
    if (cyrillic) {
        add(single ? keywordStem(needle) : needle, CYRILLIC_KEYWORD_TAIL, MIN_KEYWORD);
        return out;
    }
    add(needle, LATIN_KEYWORD_TAIL, MIN_KEYWORD);
    return out;
}

/** Normalised story text for matching (lower case, ё → е, one space). */
export function storyText(text: string): string {
    return normalizeName(text);
}

/**
 * The facts whose topic came up in the text. One call shares the needle hits between facts (many facts name the same
 * people), so it stays cheap for a few hundred facts.
 */
export function factsOnTopic<F extends Pick<KnowledgeFactData, 'topics'>>(facts: readonly F[], text: string): F[] {
    const haystack = storyText(text);
    if (!haystack) return [];
    const hits = new Map<string, boolean>();
    const hit = ({ needle, tail }: TopicNeedle): boolean => {
        const key = `${tail}\u0000${needle}`;
        let found = hits.get(key);
        if (found === undefined) {
            found = findNeedle(haystack, needle, tail) >= 0;
            hits.set(key, found);
        }
        return found;
    };
    return facts.filter((fact) => fact.topics.some((topic) => topicNeedles(topic).some(hit)));
}

export interface UnknownOptions {
    /** Other names of the character (aliases) that may stand among the knowers. */
    aliases?: readonly string[];
    max?: number;
}

/** Secrets first, then the newest message, then the newest fact. */
function byPriority(a: KnowledgeFactData, b: KnowledgeFactData): number {
    return Number(b.secret) - Number(a.secret) || b.sourceMessage - a.sourceMessage || b.at - a.at;
}

/**
 * Among the facts whose topic came up (`onTopic`, from factsOnTopic), the ones the character does not know: not among
 * the knowers, and no other fact with the same text names them (a second kiss is still the same news). At most `max`.
 */
export function unknownAmong(
    onTopic: readonly KnowledgeFactData[],
    all: readonly KnowledgeFactData[],
    character: string,
    options: UnknownOptions = {},
): KnowledgeFactData[] {
    const names = [character, ...(options.aliases ?? [])].filter((name) => normalizeName(name));
    if (!names.length) return [];
    const max = options.max ?? MAX_UNKNOWN;
    const known = new Set(all.filter((fact) => knows(fact, names)).map((fact) => normalizeName(fact.text)));
    const out: KnowledgeFactData[] = [];
    const seen = new Set<string>();
    for (const fact of [...onTopic].sort(byPriority)) {
        if (out.length >= max) break;
        const key = normalizeName(fact.text);
        if (known.has(key) || seen.has(key) || knows(fact, names)) continue;
        seen.add(key);
        out.push(fact);
    }
    return out;
}

/** What the character does not know among the facts whose topic came up in `recentText`. */
export function unknownFacts(
    facts: readonly KnowledgeFactData[],
    character: string,
    recentText: string,
    options: UnknownOptions = {},
): KnowledgeFactData[] {
    return unknownAmong(factsOnTopic(facts, recentText), facts, character, options);
}

/** The card line: the facts' texts, «; »-separated. */
export function unknownLine(facts: readonly Pick<KnowledgeFactData, 'text'>[]): string {
    return facts.map((fact) => fact.text.replace(/[.;\s]+$/u, '')).join('; ');
}

/* ------------------------------------------------------------------ the chat */

interface MessageLike {
    is_user?: boolean;
    is_system?: boolean;
    mes?: unknown;
}

function asMessage(value: unknown): MessageLike | null {
    return typeof value === 'object' && value !== null ? (value as MessageLike) : null;
}

/** Replies looked back for a tracker when the reply itself has no character data (DES keeps showing its last). */
export const CAST_LOOKBACK = 10;

/**
 * Names of the characters DES shows in the scene at a reply (not off-scene, not hidden): the reply's own tracker, or
 * the nearest earlier reply with character data, at most `lookBack` replies back. Null when there is none.
 */
export function castAt(
    chat: readonly unknown[],
    index: number,
    hidden: readonly string[] = [],
    lookBack = CAST_LOOKBACK,
): string[] | null {
    let seen = 0;
    for (let at = Math.min(index, chat.length - 1); at >= 0 && seen <= lookBack; at--) {
        const message = asMessage(chat[at]);
        if (!message || message.is_user || message.is_system) continue;
        seen++;
        const record = desSwipeRecord(message);
        if (!record || parseTrackerJson(record.characterThoughts) === null) continue;
        return presentCharacters(parseDesCharacters(record.characterThoughts), hidden).map((item) => item.name);
    }
    return null;
}

/** Index of the last user message, -1 if none. */
export function lastUserIndex(chat: readonly unknown[]): number {
    for (let index = chat.length - 1; index >= 0; index--) if (asMessage(chat[index])?.is_user) return index;
    return -1;
}

/**
 * The story text of the last `count` visible messages up to the user's last message (P14: a reply being generated or
 * swiped after it does not count), cleaned of trackers, HTML and picture posts.
 */
export function recentStoryText(
    chat: readonly unknown[],
    count = RECENT_MESSAGES,
    clean: (message: unknown) => string = cleanForAnalysis,
): string {
    const last = lastUserIndex(chat);
    const end = last >= 0 ? last : chat.length - 1;
    const parts: string[] = [];
    let read = 0;
    for (let index = end; index >= 0 && read < count; index--) {
        const message = asMessage(chat[index]);
        if (!message || message.is_system) continue;
        read++;
        const text = clean(message);
        if (text) parts.unshift(text);
    }
    return parts.join('\n');
}
