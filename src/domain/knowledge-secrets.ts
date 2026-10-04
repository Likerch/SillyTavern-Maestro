// M18 «Кто что знает», secrets (plan M18 п. 2, M8 «Маршрутизация»: «Секрет, знание → M18»): the revision writes a
// secret as a short English statement («Anna is a spy for the Duke; Kai does not know»). Who knows it is read from the
// statement — «X knows / X and Y know / known only to X / X told Y / X confided to Y» make knowers, «X does not know /
// X is unaware / hidden from X / without X knowing» make the unaware — and otherwise it is the cast of the turn the
// secret came from. The secret's own subject always knows it. Topics: the names it mentions and a few English words.
// Pure: no DOM, no SillyTavern.
import { uniqueStrings } from './canon-keys';
import { cleanTopics, keywordTopics, nameTopics } from './knowledge-facts';
import type { NameInfo, NameLookup } from './knowledge-facts';
import { buildMentionMatcher, findMentions, mentionNeedles, nameList, normalizeName } from './world-names';

export interface SecretKnowers {
    knows: string[];
    unaware: string[];
}

/** Text right after a name that makes it a knower («knows», «and Bob know», «, who…, learned», «told», «was told»). */
const KNOWS_AFTER =
    /^(?:'s)?\s*(?:(?:,|and)\s+[^.;:]{0,40}?\s+)?(?:also\s+|now\s+|already\s+|alone\s+|secretly\s+|finally\s+)?(?:knows?|knew|is aware|are aware|was aware|were aware|(?:was|were|has been|have been|is|are)\s+(?:told|informed)|learn(?:ed|t|s)|ha(?:s|ve) learn(?:ed|t)|f(?:ound|inds) out|discover(?:ed|s)|suspects?|reali[sz]ed|told|tells|reveal(?:ed|s)|confide(?:d|s)|confess(?:ed|es)|admit(?:ted|s))\b/;
/** Text right after a name that makes it unaware («does not know», «and Bob don't know», «is unaware»). */
const UNAWARE_AFTER =
    /^(?:'s)?\s*(?:(?:,|and)\s+[^.;:]{0,40}?\s+)?(?:still\s+|also\s+)?(?:(?:does not|doesn't|do not|don't|did not|didn't|never|cannot|can't)\s+(?:yet\s+|even\s+)?(?:know|knew|learn|find out|suspect|reali[sz]e|guess)|(?:is|are|was|were|remains?|stays?)\s+(?:still\s+|completely\s+)?(?:unaware|not aware|oblivious|in the dark|clueless|ignorant))\b/;
/** Text right before a name that makes it a knower («known only to», «confided to Bob and», «told»). */
const KNOWS_BEFORE =
    /(?:(?:known|told|revealed|reveals|confided|confides|confessed|confesses|admitted|admits|disclosed|whispered|shared)\s+(?:only\s+|it\s+|this\s+|everything\s+|the truth\s+|the secret\s+)?(?:to|with)\s+(?:only\s+)?(?:[^.;:]{0,40}?(?:,|and)\s+)?|(?:told|tells|informed|informs|warned|warns)\s+)$/;
/** Text right before a name that makes it unaware («unknown to», «hidden from Bob and»). */
const UNAWARE_BEFORE =
    /(?:unknown|hidden|kept|keeps|keeping|concealed|conceals|secret)\s+(?:secret\s+)?(?:to|from)\s+(?:[^.;:]{0,40}?(?:,|and)\s+)?$/;
/** «without Bob knowing». */
const WITHOUT_BEFORE = /without\s+$/;
const KNOWING_AFTER = /^(?:'s)?\s+knowing\b/;
const WORD_RE = /[\p{L}\p{N}_]/u;
const WINDOW = 60;

/** Start positions of a needle with a left word boundary and at most `tail` word characters after it. */
function occurrences(text: string, needle: string, tail: number): number[] {
    const out: number[] = [];
    if (!needle) return out;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
        if (at > 0 && WORD_RE.test(text[at - 1] ?? '')) continue;
        let extra = 0;
        while (extra <= tail && WORD_RE.test(text[at + needle.length + extra] ?? '')) extra++;
        if (extra <= tail) out.push(at);
    }
    return out;
}

/**
 * Who the statement says knows the secret and who does not, among the candidate names (canonical names returned).
 * A name that is said to be unaware is never a knower.
 */
export function parseSecretKnowers(value: string, candidates: readonly NameInfo[]): SecretKnowers {
    const text = normalizeName(value).replace(/[’`]/g, "'");
    const knows: string[] = [];
    const unaware: string[] = [];
    if (!text) return { knows, unaware };
    for (const candidate of candidates) {
        const needles = mentionNeedles([candidate.name, ...(candidate.aliases ?? [])], [], false);
        let isKnower = false;
        let isUnaware = false;
        for (const { needle, tail } of needles) {
            for (const start of occurrences(text, needle, tail)) {
                const end = start + needle.length;
                const after = text.slice(end, end + WINDOW).replace(/^[\p{L}\p{N}_]+/u, '');
                const before = text.slice(Math.max(0, start - WINDOW), start);
                const withoutKnowing = WITHOUT_BEFORE.test(before) && KNOWING_AFTER.test(after);
                if (UNAWARE_AFTER.test(after) || UNAWARE_BEFORE.test(before) || withoutKnowing) isUnaware = true;
                if (KNOWS_AFTER.test(after) || KNOWS_BEFORE.test(before)) isKnower = true;
            }
        }
        if (isUnaware) unaware.push(candidate.name);
        else if (isKnower) knows.push(candidate.name);
    }
    return { knows: nameList(knows), unaware: nameList(unaware) };
}

export interface SecretKnownByOptions {
    /** The cast of the turn the secret came from (canonical names, the persona included). */
    cast: readonly string[];
    /** The character the secret is about (knows their own secret), when it is a character. */
    subject?: string;
}

/** Knowers named in the statement, else the cast of the source turn; plus the subject; never the unaware. */
export function secretKnownBy(parsed: SecretKnowers, options: SecretKnownByOptions): string[] {
    const base = parsed.knows.length ? parsed.knows : options.cast;
    const skip = new Set(parsed.unaware.map(normalizeName));
    return nameList([...(options.subject ? [options.subject] : []), ...base]).filter(
        (name) => !skip.has(normalizeName(name)),
    );
}

export interface SecretTopicsOptions {
    /** Names the statement and the quote may mention (characters, places), with their forms. */
    names: readonly NameInfo[];
    subject?: string;
    /** The persona's names (left out of topics). */
    persona?: readonly string[];
    lookup?: NameLookup;
}

const SECRET_WORDS = new Set([
    'secret',
    'secretly',
    'knows',
    'known',
    'unaware',
    'aware',
    "doesn't",
    'hidden',
    'nobody',
    'everyone',
    'someone',
    'really',
    'actually',
]);

/** Topic words of a secret: its subject and every name the statement or the quote mentions, then up to 3 words. */
export function secretTopics(value: string, evidence: string, options: SecretTopicsOptions): string[] {
    const matcher = buildMentionMatcher(
        options.names.map((info) => ({
            id: info.name,
            needles: mentionNeedles([info.name, ...(info.aliases ?? [])], info.forms ?? [], !info.forms?.length),
        })),
    );
    const named = uniqueStrings([
        ...(options.subject ? [options.subject] : []),
        ...findMentions(matcher, value),
        ...findMentions(matcher, evidence),
    ]);
    const lookup: NameLookup = (name) =>
        options.lookup?.(name) ?? options.names.find((info) => normalizeName(info.name) === normalizeName(name));
    const words = keywordTopics(value, 12).filter(
        (word) => word === word.toLowerCase() && word.length >= 5 && !SECRET_WORDS.has(word),
    );
    return cleanTopics(
        [...named.flatMap((name) => nameTopics(name, lookup)), ...words.slice(0, 3)],
        options.persona ?? [],
    );
}
