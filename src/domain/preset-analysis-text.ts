// Text checks of the Preset Studio analysis (M34 п.3), pure: macros (`{{if}}` only works with the new macro engine,
// P-133), messages that would go out empty or as whitespace (P-117, P-138, P-146), overlap of block texts with other
// texts by word shingles (duplicates with lore, extension prompts and other blocks) and the heaviest blocks.
import { normalizeText, textWords } from './signals-tokens';

/* ------------------------------------------------------------------ macros */

const IF_OPEN_RE = /^#?if\b/i;
const IF_CLOSE_RE = /^\/if\s*$/i;
const ANY_IF_RE = /\{\{\s*#?if\b/i;

/** The text uses `{{if …}}` / `{{#if …}}` (the old regex macro engine sends it literally, P-133). */
export function hasIfMacro(text: string): boolean {
    return ANY_IF_RE.test(text);
}

/** End of the macro that starts at `start` (`{{`), nested macros included; -1 when it is not closed. */
function macroEnd(text: string, start: number): number {
    let depth = 0;
    for (let i = start; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') {
            depth++;
            i++;
        } else if (text[i] === '}' && text[i + 1] === '}') {
            depth--;
            i++;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

/** `::` outside nested macros: the short form `{{if cond::text}}` (P-134). */
function hasTopLevelArgs(body: string): boolean {
    let depth = 0;
    for (let i = 0; i < body.length - 1; i++) {
        const pair = body.slice(i, i + 2);
        if (pair === '{{') depth++;
        else if (pair === '}}') depth--;
        else if (pair === '::' && depth === 0) return true;
        if (pair === '{{' || pair === '}}' || pair === '::') i++;
    }
    return false;
}

/**
 * The text outside conditional sections: `{{if …}}…{{/if}}` (nested, with `{{else}}`) and the short form
 * `{{if cond::text}}` are removed; everything else stays as written.
 */
export function stripConditionals(text: string): string {
    let result = '';
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf('{{', i);
        if (open < 0) {
            if (depth === 0) result += text.slice(i);
            break;
        }
        if (depth === 0) result += text.slice(i, open);
        const end = macroEnd(text, open);
        if (end < 0) {
            if (depth === 0) result += text.slice(open);
            break;
        }
        const body = text.slice(open + 2, end - 2).trim();
        if (IF_OPEN_RE.test(body)) {
            if (!hasTopLevelArgs(body)) depth++;
        } else if (IF_CLOSE_RE.test(body)) {
            depth = Math.max(0, depth - 1);
        } else if (depth === 0) result += text.slice(open, end);
        i = end;
    }
    return result;
}

export type EmptyIssue = 'whitespace' | 'outsideIf';

/**
 * A relative block that would send a message of whitespace only: ST drops empty messages but keeps whitespace
 * (P-117). 'outsideIf': the block is conditional but has whitespace outside its `{{if}}`, so with the condition
 * false it still sends "\n\n" (P-138, P-146). An empty block is not an issue here (ST drops it).
 */
export function emptyMessageIssue(content: string): EmptyIssue | null {
    if (!content) return null;
    if (!content.trim()) return 'whitespace';
    if (!hasIfMacro(content)) return null;
    const outside = stripConditionals(content);
    return outside.length > 0 && !outside.trim() ? 'outsideIf' : null;
}

/* ------------------------------------------------------------------ overlap */

/** Default shingle length in words. */
export const SHINGLE_WORDS = 5;

/** Macros are not words of the text. */
function withoutMacros(text: string): string {
    return text.replace(/\{\{[^{}]*\}\}/g, ' ');
}

/**
 * Word shingles of a text (normalised words, macros removed). A text shorter than `size` words but with at least
 * three words is one shingle; shorter texts have none.
 */
export function shingleSet(text: string, size = SHINGLE_WORDS): Set<string> {
    const words = textWords(withoutMacros(text));
    const result = new Set<string>();
    if (words.length < size) {
        if (words.length >= 3) result.add(words.join(' '));
        return result;
    }
    for (let i = 0; i + size <= words.length; i++) result.add(words.slice(i, i + size).join(' '));
    return result;
}

export interface Overlap {
    shared: number;
    /** Shared shingles of the smaller text (0…1). */
    containment: number;
}

export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): Overlap {
    if (!a.size || !b.size) return { shared: 0, containment: 0 };
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let shared = 0;
    for (const item of small) if (large.has(item)) shared++;
    return { shared, containment: shared / small.size };
}

export interface OverlapThresholds {
    /** Minimum shared shingles. */
    minShared: number;
    /** Minimum share of the smaller text. */
    minContainment: number;
    /** This many shared shingles count whatever the share. */
    alwaysShared: number;
}

export const DUPLICATE_THRESHOLDS: OverlapThresholds = { minShared: 4, minContainment: 0.5, alwaysShared: 15 };

export function isOverlapping(value: Overlap, thresholds: OverlapThresholds = DUPLICATE_THRESHOLDS): boolean {
    if (value.shared >= thresholds.alwaysShared) return true;
    return value.shared >= thresholds.minShared && value.containment >= thresholds.minContainment;
}

/** Same text after normalisation (case, ё, whitespace). */
export function sameText(a: string, b: string): boolean {
    const left = normalizeText(a);
    return left !== '' && left === normalizeText(b);
}

/* ------------------------------------------------------------------ weight */

export interface WeightedBlock {
    identifier: string;
    tokens: number;
}

export interface HeavyOptions {
    minTokens: number;
    /** Share of the preset total. */
    minShare: number;
    limit: number;
}

export const HEAVY_DEFAULTS: HeavyOptions = { minTokens: 400, minShare: 0.15, limit: 3 };

/** The heaviest blocks: at least `minTokens` and `minShare` of the total, the top `limit`. */
export function heavyBlocks(
    blocks: readonly WeightedBlock[],
    options: HeavyOptions = HEAVY_DEFAULTS,
): (WeightedBlock & { share: number })[] {
    const total = blocks.reduce((sum, block) => sum + Math.max(0, block.tokens), 0);
    if (total <= 0) return [];
    return blocks
        .filter((block) => block.tokens >= options.minTokens && block.tokens / total >= options.minShare)
        .map((block) => ({ ...block, share: block.tokens / total }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, Math.max(0, options.limit));
}
