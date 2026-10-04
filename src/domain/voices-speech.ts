// M15 «Голоса персонажей», pure speech helpers: what a CarrotKernel archive says about how a character talks and
// thinks — the LING tags (inside `<BunnymoTags>` and in the `<Linguistics>` prose), a compact digest of that prose
// (register, quirks, dialect, pet words) and the MBTI archetype with its H/U variant, which CK itself cannot see
// (its tag regex needs a colon, research/bunnymo-carrotkernel.md §2.3 п. 4).
// Pure: no DOM, no SillyTavern.
import { parseSheet } from './bunnymo-mode-sheet';
import { mbtiOf, truncate } from './dossier-data';

export interface VoiceMbti {
    type: string;
    /** H = healthy, U = unhealthy; null when the archive gives the type alone. */
    variant: 'H' | 'U' | null;
}

/** What one archive says about a character's voice. */
export interface ArchiveVoice {
    /** LING tag values as readable labels (`SOFT_SPOKEN` → `soft spoken`), block tags first, unique. */
    ling: string[];
    /** The `<Linguistics>` prose, cleaned (tags turned into labels, markdown stripped); '' when absent. */
    linguistics: string;
    mbti: VoiceMbti | null;
}

/** The parts of a parsed sheet this module reads (an `ArchiveSheet` of M35 or a `SheetDraft`). */
export interface SheetLike {
    tags: readonly { key: string; value: string }[];
    mbti?: { type: string; variant: 'H' | 'U' } | null;
    linguistics?: string;
}

const TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;
const ANY_TAG_RE = /<\/?[^<>\n]{1,80}>/g;
const LING_KEYS: ReadonlySet<string> = new Set(['LING', 'LINGUISTICS', 'SPEECH']);
const MARKDOWN_RE = /\*\*|__|`+/g;
const HEADER_RE = /^\s{0,3}#{1,6}\s*/gm;
const BULLET_RE = /^\s*(?:[-*•·]|\d+[.)])\s+/gm;
/** A sentence's subject a card does not need («Character …», «She …»); the card already names the character. */
const SUBJECT_RE = /^(?:the\s+character|character|\{\{char\}\}|he|she|they)\s+(?=\S)/i;
/** A leading verb that carries nothing after the subject is gone («uses …», «speaks with …»). */
const VERB_RE = /^(?:uses|use|has|have|speaks\s+(?:with|in)|talks\s+(?:with|in))\s+(?=\S)/i;
/** Quoted words and short phrases: pet names, catchphrases, interjections. */
const QUOTE_RE = /"([^"\n]{1,30})"|“([^”\n]{1,30})”|«([^»\n]{1,30})»/g;
const MAX_QUOTES = 3;

/** What a speech digest looks for, in this order: register, quirks, dialect, pet words. */
export const SPEECH_ASPECTS: readonly { id: string; re: RegExp }[] = [
    {
        id: 'register',
        re: /\b(?:formal|informal|casual|polite|crude|vulgar|coarse|eloquent|articulate|terse|curt|blunt|verbose|laconic|commanding|soft[- ]spoken|softly|quiet|loud|register|tone|diction|vocabulary|sarcas\w*|deadpan|archaic|flowery|plain|clipped|measured|precise|rambl\w*)|(?:вежлив|грубо|формальн|официальн|тон\b|манер|сухо|резко|мягко|отрывист)/i,
    },
    {
        id: 'quirks',
        re: /\b(?:quirk|habit|tic|tends?\s+to|often|always|never|frequently|stutter\w*|stammer\w*|lisp|repeat\w*|trails?\s+off|pauses?|swear\w*|curs\w+|profan\w*|laugh\w*|giggl\w*|sigh\w*|hum\w*|mutter\w*|whisper\w*|rhetorical)|(?:заика|привычк|часто|всегда|ругает|бормоч|вздыха)/i,
    },
    {
        id: 'dialect',
        re: /\b(?:accent|dialect|drawl|brogue|lilt|slang|vernacular|regional|idiom\w*|street|old[- ]fashioned|foreign|code[- ]switch\w*|mixes)|(?:акцент|диалект|говор|сленг|жаргон|просторечи)/i,
    },
    {
        id: 'petWords',
        re: /\b(?:pet\s+names?|nicknames?|calls|refers\s+to|endearments?|honorifics?|catchphrases?|says|favou?rite\s+words?|exclaims?|interjections?|addresses)|(?:обращается|называет|словечк|присказк|прозвищ)/i,
    },
];

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function collapse(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/** A tag value as a readable label: `SOFT_SPOKEN` → `soft spoken`, `Old-Fashioned` → `old-fashioned`. */
export function tagLabel(value: string): string {
    return collapse(value.replace(/_/g, ' ')).toLowerCase();
}

function pushUnique(list: string[], value: string): void {
    const label = tagLabel(value);
    if (label && !list.includes(label)) list.push(label);
}

/** LING values used inside a prose text (`Character uses <LING:COMMANDING> speech`). */
export function lingInProse(prose: string): string[] {
    const found: string[] = [];
    for (const match of prose.matchAll(TAG_RE)) {
        if (LING_KEYS.has((match[1] ?? '').toUpperCase())) pushUnique(found, match[2] ?? '');
    }
    return found;
}

/**
 * Prose for a card: `<KEY:VALUE>` tags become their labels, other tags and markdown go, list markers become sentence
 * breaks, whitespace collapses.
 */
export function cleanLinguistics(prose: string): string {
    const replaced = prose
        .replace(TAG_RE, (_whole, _key: string, value: string) => tagLabel(value))
        .replace(ANY_TAG_RE, ' ')
        .replace(MARKDOWN_RE, '')
        .replace(HEADER_RE, '. ')
        .replace(BULLET_RE, '. ');
    return collapse(replaced)
        .replace(/\s+([.,;!?])/g, '$1')
        .replace(/([.!?…;])(?:\s*\.)+/g, '$1')
        .replace(/^[\s.;]+/, '');
}

/** The voice of a parsed sheet (M35 `readSheet`, a sheet draft). */
export function archiveVoiceFromSheet(sheet: SheetLike): ArchiveVoice {
    const ling: string[] = [];
    let mbti: VoiceMbti | null = sheet.mbti
        ? { type: sheet.mbti.type.toUpperCase(), variant: sheet.mbti.variant }
        : null;
    for (const tag of sheet.tags) {
        const key = tag.key.toUpperCase();
        if (LING_KEYS.has(key)) pushUnique(ling, tag.value);
        else if (key === 'MBTI' && !mbti) mbti = mbtiOf([`<MBTI:${tag.value}>`]);
    }
    const prose = text(sheet.linguistics);
    for (const value of lingInProse(prose)) if (!ling.includes(value)) ling.push(value);
    return { ling, linguistics: cleanLinguistics(prose), mbti };
}

/** The voice of an archive entry's text; null when it has no `<BunnymoTags>` block. */
export function archiveVoiceOf(content: unknown): ArchiveVoice | null {
    const parsed = parseSheet(text(content));
    if (!parsed.block) return null;
    const first = parsed.mbti[0];
    return archiveVoiceFromSheet({
        tags: parsed.tags,
        mbti: first ? { type: first.type, variant: first.variant } : null,
        linguistics: parsed.linguistics?.text ?? '',
    });
}

/** Sentences of a cleaned prose (ends of sentences, semicolons). */
export function splitSentences(prose: string): string[] {
    return prose
        .split(/(?<=[.!?…])\s+|;\s*/)
        .map((sentence) => collapse(sentence).replace(/[.;]+$/, ''))
        .filter((sentence) => sentence.length > 1);
}

/**
 * A sentence without what a card does not need: the subject (a pronoun, «Character», one of `names` — the character's
 * own names) and a leading «uses / has / speaks with». A capital that only started the sentence is lowered.
 */
export function compactSentence(sentence: string, names: readonly string[] = []): string {
    const original = sentence.trim();
    let result = original;
    const own = names
        .map((name) => name.trim())
        .filter(Boolean)
        .find((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?=\\S)`, 'i').test(result));
    result = own ? result.slice(own.length).trimStart() : result.replace(SUBJECT_RE, '');
    result = result.replace(VERB_RE, '');
    if (!result) return original;
    // Keep acronyms and names («NPC», «Kai»): only a capital followed by a small letter is lowered.
    if (result !== original && /^[A-Z][a-z]/.test(result)) result = result.charAt(0).toLowerCase() + result.slice(1);
    return result;
}

/** Short quoted words of a prose (pet names, catchphrases), as written, unique. */
export function quotedWords(prose: string): string[] {
    const found: string[] = [];
    for (const match of prose.matchAll(QUOTE_RE)) {
        const word = collapse(match[1] ?? match[2] ?? match[3] ?? '');
        if (word && !found.includes(word)) found.push(word);
    }
    return found;
}

/**
 * A compact digest of the Linguistics prose: one sentence per aspect (register, quirks, dialect, pet words) in the
 * prose's own order, the first sentence when no aspect matches, then quoted pet words not shown yet; cut to
 * `maxChars` at a word boundary. '' for `maxChars` ≤ 0 or an empty prose.
 */
export function linguisticsDigest(prose: string, maxChars: number, names: readonly string[] = []): string {
    if (maxChars <= 0) return '';
    const clean = cleanLinguistics(prose);
    if (!clean) return '';
    const sentences = splitSentences(clean);
    const picked = new Set<number>();
    for (const aspect of SPEECH_ASPECTS) {
        const index = sentences.findIndex((sentence, at) => !picked.has(at) && aspect.re.test(sentence));
        if (index >= 0) picked.add(index);
    }
    if (!picked.size && sentences.length) picked.add(0);
    let digest = [...picked]
        .sort((a, b) => a - b)
        .map((index) => compactSentence(sentences[index] ?? '', names))
        .filter(Boolean)
        .join('; ');
    const quotes = quotedWords(clean)
        .filter((word) => !digest.includes(word))
        .slice(0, MAX_QUOTES);
    if (quotes.length) digest += `${digest ? '; ' : ''}says ${quotes.map((word) => `"${word}"`).join(', ')}`;
    return truncate(digest, maxChars);
}

export interface SpeechOptions {
    /** Characters of the prose digest; 0 = LING labels only. */
    proseChars: number;
    /** At most this many LING labels (undefined = all). */
    maxTags?: number;
    /** The character's names (dropped as the subject of prose sentences). */
    names?: readonly string[];
}

/** The «Speech:» part of a card: LING labels, then the prose digest. '' when the archive says nothing. */
export function speechText(voice: Pick<ArchiveVoice, 'ling' | 'linguistics'> | null, options: SpeechOptions): string {
    if (!voice) return '';
    const labels = options.maxTags === undefined ? voice.ling : voice.ling.slice(0, Math.max(0, options.maxTags));
    const digest = linguisticsDigest(voice.linguistics, options.proseChars, options.names);
    return [labels.join(', '), digest].filter(Boolean).join('; ');
}

/**
 * «INFP-H (healthy; now: guarded)»: the archetype, its variant in words and the current state (DES demeanor). ''
 * without an archetype (the card shows the state on its own then).
 */
export function mbtiText(mbti: VoiceMbti | null, state?: string, stateChars = 60): string {
    if (!mbti) return '';
    const now = state && stateChars > 0 ? truncate(collapse(state), stateChars) : '';
    const variant = mbti.variant === 'H' ? 'healthy' : mbti.variant === 'U' ? 'unhealthy' : '';
    const notes = [variant, now ? `now: ${now}` : ''].filter(Boolean).join('; ');
    const type = mbti.variant ? `${mbti.type}-${mbti.variant}` : mbti.type;
    return notes ? `${type} (${notes})` : type;
}
