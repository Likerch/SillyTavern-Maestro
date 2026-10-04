// M20 «Архитектор промпта», pure text helpers: sentence segmentation that never splits inside a tag, sentence keys
// for duplicate facts, removal of given sentences, and trimming an injection to a token budget by whole units
// (CarrotKernel RAG chunks, Qvink memories, sentences). Every split keeps the exact original text: joining the
// segments gives the input back, so whatever is not removed stays byte-identical.
// Pure: no DOM, no SillyTavern.
import { stableHash } from './hash';
import { estimateTokens } from './rules-lore';

export type TokenCounter = (text: string) => number;

/** Default counter: the project-wide chars/3.6 estimate (exact counts are never awaited on the send path, P15). */
export const estimateText: TokenCounter = (text) => estimateTokens(text.length);

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", '»', '”', '’', ')', ']', '*', '_']);

function isSpace(char: string | undefined): boolean {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ' ';
}

/**
 * Sentence segments with their trailing whitespace (`segments.join('') === text`). A segment ends after a line
 * break or after `. ! ? …` (plus closing quotes/brackets) followed by whitespace; nothing inside `<…>` ends one.
 */
export function splitSentenceSegments(text: string): string[] {
    const segments: string[] = [];
    let start = 0;
    let inTag = false;
    let i = 0;
    const cut = (end: number) => {
        let stop = end;
        while (stop < text.length && isSpace(text[stop])) stop++;
        if (stop > start) segments.push(text.slice(start, stop));
        start = stop;
        return stop;
    };
    while (i < text.length) {
        const char = text[i] as string;
        if (inTag) {
            if (char === '>') inTag = false;
            i++;
            continue;
        }
        if (char === '<' && /[A-Za-z/!]/.test(text[i + 1] ?? '')) {
            inTag = true;
            i++;
            continue;
        }
        if (char === '\n') {
            i = cut(i + 1);
            continue;
        }
        if (TERMINATORS.has(char)) {
            let end = i + 1;
            while (end < text.length && (TERMINATORS.has(text[end] as string) || CLOSERS.has(text[end] as string))) {
                end++;
            }
            if (end >= text.length || isSpace(text[end])) {
                i = cut(end);
                continue;
            }
            i = end;
            continue;
        }
        i++;
    }
    if (start < text.length) segments.push(text.slice(start));
    return segments;
}

/** Paragraph segments (split after blank lines) with their trailing whitespace; joining gives the text back. */
export function splitParagraphs(text: string): string[] {
    const segments: string[] = [];
    const re = /\n[ \t]*\n\s*/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const end = match.index + match[0].length;
        segments.push(text.slice(start, end));
        start = end;
    }
    if (start < text.length) segments.push(text.slice(start));
    return segments;
}

const TAG_RE = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/;
const HEADER_RE = /^\s*(?:#{1,6}\s|(?:Tags|Reason):)/;

/**
 * Segments that trimming and duplicate removal never drop: empty ones, markdown headers, CK chunk metadata lines,
 * and anything holding a tag (`<context>`, `</memories>`, `<SPECIES:ELF>`) — so a cut never breaks a tag pair.
 */
export function isProtectedSegment(segment: string): boolean {
    if (!segment.trim()) return true;
    return HEADER_RE.test(segment) || TAG_RE.test(segment);
}

/** Lower case, ё → е, only letters and digits separated by single spaces. */
export function normalizeSentence(text: string): string {
    return text
        .normalize('NFC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

export function wordCount(normalized: string): number {
    return normalized ? normalized.split(' ').length : 0;
}

/** Stable key of a sentence (normalised text hash); '' for a sentence without letters or digits. */
export function sentenceKey(sentence: string): string {
    const normalized = normalizeSentence(sentence);
    return normalized ? stableHash(normalized) : '';
}

/** Keys of every sentence of a text that has at least `minWords` words. */
export function sentenceKeysOf(text: string, minWords = 1): string[] {
    const keys: string[] = [];
    for (const segment of splitSentenceSegments(text)) {
        const normalized = normalizeSentence(segment);
        if (wordCount(normalized) < minWords) continue;
        keys.push(stableHash(normalized));
    }
    return keys;
}

export interface RemovalResult {
    text: string;
    /** Sentences removed. */
    removed: number;
    removedChars: number;
}

/** Removes every unprotected sentence whose key is in `keys`; everything else stays as it was. */
export function removeSentences(text: string, keys: ReadonlySet<string>): RemovalResult {
    if (!keys.size || !text) return { text, removed: 0, removedChars: 0 };
    let removed = 0;
    let removedChars = 0;
    const kept: string[] = [];
    for (const segment of splitSentenceSegments(text)) {
        if (!isProtectedSegment(segment) && keys.has(sentenceKey(segment))) {
            removed++;
            removedChars += segment.length;
            continue;
        }
        kept.push(segment);
    }
    return removed ? { text: kept.join(''), removed, removedChars } : { text, removed: 0, removedChars: 0 };
}

/** Text left after protected-only content is ignored: true when something worth sending remains. */
export function hasStoryText(text: string): boolean {
    return splitSentenceSegments(text).some((segment) => !isProtectedSegment(segment) && /[\p{L}\p{N}]/u.test(segment));
}

/* ------------------------------------------------------------------ trimming */

export interface TrimResult {
    text: string;
    /** Tokens before and after (by the counter given). */
    before: number;
    after: number;
    /** Units removed. */
    removed: number;
}

export interface TrimOptions {
    /** Which end loses units first. */
    from: 'start' | 'end';
    unit: 'sentence' | 'paragraph';
    count?: TokenCounter;
    /** The first non-empty unit is a header and stays (Qvink's template line). */
    keepFirst?: boolean;
}

/**
 * Removes whole units from one end until the text fits `budget` tokens; protected units (tags, headers) stay.
 * When nothing removable is left the result may still be over the budget.
 */
export function trimToTokens(text: string, budget: number, options: TrimOptions): TrimResult {
    const count = options.count ?? estimateText;
    const before = count(text);
    if (!(budget >= 0) || before <= budget) return { text, before, after: before, removed: 0 };
    const units = options.unit === 'paragraph' ? splitParagraphs(text) : splitSentenceSegments(text);
    const firstIndex = units.findIndex((unit) => unit.trim().length > 0);
    const locked = units.map(
        (unit, index) => isProtectedSegment(unit) || (options.keepFirst === true && index === firstIndex),
    );
    const alive = units.map(() => true);
    const joined = () => units.filter((_, i) => alive[i]).join('');
    let total = before;
    let removed = 0;
    const order = units.map((_, index) => index);
    if (options.from === 'end') order.reverse();
    for (const index of order) {
        if (total <= budget) {
            // Unit counts are only nearly additive: confirm with one real count before stopping.
            total = count(joined());
            if (total <= budget) break;
        }
        if (locked[index]) continue;
        alive[index] = false;
        removed++;
        total -= count(units[index] as string);
    }
    const result = joined();
    return { text: result, before, after: count(result), removed };
}

/** CarrotKernel RAG chunks: `### header` blocks joined by blank lines (fullsheet-rag.js injectRAGResults). */
export function splitRagChunks(text: string): string[] {
    const parts: string[] = [];
    const re = /\n[ \t]*\n\s*(?=###\s)/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        parts.push(text.slice(start, match.index));
        start = match.index;
    }
    parts.push(text.slice(start));
    return parts.filter((part) => part.length > 0);
}

/**
 * Trims a CK RAG injection: CK lists its chunks best first, so whole chunks go from the end; when one chunk is
 * left and still too long, its sentences go from the end (headers, tags and `Tags:` lines stay). An injection that
 * cannot fit at all becomes ''.
 */
export function trimRagInjection(text: string, budget: number, count: TokenCounter = estimateText): TrimResult {
    const before = count(text);
    if (!(budget >= 0) || before <= budget) return { text, before, after: before, removed: 0 };
    const chunks = splitRagChunks(text);
    let removed = 0;
    while (chunks.length > 1 && count(chunks.join('')) > budget) {
        chunks.pop();
        removed++;
    }
    let result = chunks.join('');
    if (count(result) > budget) {
        const last = chunks.pop() ?? '';
        const rest = chunks.join('');
        const inner = trimToTokens(last, Math.max(0, budget - count(rest)), { from: 'end', unit: 'sentence', count });
        removed += inner.removed;
        result = hasStoryText(inner.text) && count(rest + inner.text) <= budget ? rest + inner.text : rest;
        if (!hasStoryText(result)) result = '';
    }
    return { text: result, before, after: count(result), removed };
}

/**
 * Trims Qvink's short-term memory injection oldest first. `memories` are the injected memory texts in chronological
 * order (as Qvink concatenates them); removing the oldest k cuts from the first memory to the (k+1)-th, so the
 * template header and the separator layout stay. Null when the memories cannot be found in the text (another
 * template or prefill): the caller then trims by sentences.
 */
export function trimMemoryInjection(
    text: string,
    memories: readonly string[],
    budget: number,
    count: TokenCounter = estimateText,
): TrimResult | null {
    const before = count(text);
    if (!(budget >= 0) || before <= budget) return { text, before, after: before, removed: 0 };
    const starts: number[] = [];
    let pos = 0;
    for (const raw of memories) {
        const memory = raw.trim();
        if (!memory) continue;
        const index = text.indexOf(memory, pos);
        if (index < 0) return null;
        starts.push(index);
        pos = index + memory.length;
    }
    if (!starts.length) return null;
    const head = text.slice(0, starts[0]);
    for (let k = 1; k < starts.length; k++) {
        const candidate = head + text.slice(starts[k]);
        if (count(candidate) <= budget) return { text: candidate, before, after: count(candidate), removed: k };
    }
    return { text: '', before, after: 0, removed: starts.length };
}
