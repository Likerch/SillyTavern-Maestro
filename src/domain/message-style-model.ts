// The visible text of a rendered message and the annotation plan for it (M32 «Стиль сообщений»). SillyTavern already
// marks "…", “…” and «…» (`<q>`), *…*/_…_ (`<em>`), **…** (`<strong>`) and `…` (`<code>`); the rest — dash dialogue,
// (…), […], custom rules, which `<q>` is which, swappable marks — is found here on the text the reader sees and
// handed to the DOM side (src/features/messageStyle/annotate.ts) as wraps.
//
// The builder is driven by a walk over the message's nodes (elements open/close, text pieces). It records, for every
// visible character, the text piece and offset it came from, its innermost element and depth, and a mask: content
// of code, links, scripts and NAI image hosts is excluded; the content of `<q>` is opaque (ST's dialogue: nothing
// starts or ends inside it). Block elements and `<br>` add virtual line breaks so the matchers see lines and
// paragraphs as the reader does. Pure: no DOM, no SillyTavern.
import type { PlanSpan, ScopePlan, StyleRule } from './message-style';
import { compileCustom, makeStyle } from './message-style';
import {
    MASK_EXCLUDED,
    MASK_OPAQUE,
    bracketPairs,
    customPairs,
    dashSpeech,
    findMatches,
    paragraphRanges,
    parenPairs,
    selectLayer1,
    textExclusions,
} from './message-style-match';
import type { Layer1Source, Pair, TextRange } from './message-style-match';

// prettier-ignore
export const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
    'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure',
    'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
    'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Elements whose text is never story text for the rules. */
// prettier-ignore
export const EXCLUDED_ELEMENTS: ReadonlySet<string> = new Set([
    'a', 'audio', 'button', 'canvas', 'code', 'custom-style', 'iframe', 'kbd', 'math', 'noscript', 'object', 'pre',
    'samp', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'video',
]);

// prettier-ignore
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** A `<q>` element: its id and the first/last visible character inside it (-1 when empty). */
export interface QuoteElement {
    element: number;
    first: number;
    last: number;
}

export interface VisibleText {
    /** Visible characters; whitespace collapses to spaces, blocks and `<br>` add virtual `\n`. */
    text: string;
    /** Per character: the text piece it came from (-1 for virtual characters). */
    piece: Int32Array;
    /** Per character: its offset in that piece. */
    offset: Int32Array;
    /** Per character: the innermost element id (-1 = the root). */
    parent: Int32Array;
    /** Per character: element depth. */
    depth: Int32Array;
    /** Per character: 0, MASK_OPAQUE (inside `<q>`) or MASK_EXCLUDED. */
    mask: Uint8Array;
    quotes: QuoteElement[];
}

interface OpenElement {
    id: number;
    name: string;
    excluded: boolean;
    quote: number;
}

export class VisibleTextBuilder {
    private readonly chars: string[] = [];
    private readonly pieces: number[] = [];
    private readonly offsets: number[] = [];
    private readonly parents: number[] = [];
    private readonly depths: number[] = [];
    private readonly masks: number[] = [];
    private readonly stack: OpenElement[] = [];
    private readonly quotes: QuoteElement[] = [];
    private excludedDepth = 0;
    private quoteDepth = 0;
    private nextId = 0;

    /**
     * An element starts; returns its id. `skip`: treat its content as excluded (NAI image hosts, foreign widgets).
     * Void elements are not entered (their close() is a no-op).
     */
    open(name: string, options: { skip?: boolean } = {}): number {
        const tag = name.toLowerCase();
        const id = this.nextId++;
        if (BLOCK_ELEMENTS.has(tag)) this.paragraphBreak();
        if (VOID_ELEMENTS.has(tag)) {
            if (tag === 'br') this.virtual('\n');
            return id;
        }
        const excluded = options.skip === true || EXCLUDED_ELEMENTS.has(tag);
        let quote = -1;
        if (tag === 'q' && !excluded) {
            quote = this.quotes.length;
            this.quotes.push({ element: id, first: -1, last: -1 });
            this.quoteDepth++;
        }
        if (excluded) this.excludedDepth++;
        this.stack.push({ id, name: tag, excluded, quote });
        return id;
    }

    /** The element with this id ends (ignored unless it is the innermost open one). */
    close(id: number): void {
        const top = this.stack[this.stack.length - 1];
        if (!top || top.id !== id) return;
        this.stack.pop();
        if (top.excluded) this.excludedDepth--;
        if (top.quote >= 0) this.quoteDepth--;
        if (BLOCK_ELEMENTS.has(top.name)) this.paragraphBreak();
    }

    /** A text piece (a text node) with its index in the caller's piece list. */
    text(data: string, piece: number): void {
        if (!data) return;
        const top = this.stack[this.stack.length - 1];
        const parent = top ? top.id : -1;
        const depth = this.stack.length;
        const mask = this.excludedDepth > 0 ? MASK_EXCLUDED : this.quoteDepth > 0 ? MASK_OPAQUE : 0;
        const first = this.chars.length;
        for (let k = 0; k < data.length; k++) {
            let char = data[k]!;
            if (mask !== MASK_EXCLUDED && (char === '\n' || char === '\r' || char === '\t')) char = ' ';
            this.push(char, piece, k, parent, depth, mask);
        }
        if (this.quoteDepth > 0) {
            for (const entry of this.stack) {
                if (entry.quote < 0) continue;
                const quote = this.quotes[entry.quote]!;
                if (quote.first < 0) quote.first = first;
                quote.last = this.chars.length - 1;
            }
        }
    }

    build(): VisibleText {
        const text = this.chars.join('');
        const mask = Uint8Array.from(this.masks);
        // Text-level exclusions on what the reader sees: URLs, NAI markers, tag-like text, the DES tracker JSON.
        for (const range of textExclusions(text).ranges) mask.fill(MASK_EXCLUDED, range.start, range.end);
        return {
            text,
            piece: Int32Array.from(this.pieces),
            offset: Int32Array.from(this.offsets),
            parent: Int32Array.from(this.parents),
            depth: Int32Array.from(this.depths),
            mask,
            quotes: this.quotes.map((quote) => ({ ...quote })),
        };
    }

    private push(char: string, piece: number, offset: number, parent: number, depth: number, mask: number): void {
        this.chars.push(char);
        this.pieces.push(piece);
        this.offsets.push(offset);
        this.parents.push(parent);
        this.depths.push(depth);
        this.masks.push(mask);
    }

    private virtual(char: string): void {
        const top = this.stack[this.stack.length - 1];
        this.push(char, -1, 0, top ? top.id : -1, this.stack.length, 0);
    }

    private paragraphBreak(): void {
        const n = this.chars.length;
        if (!n) return;
        if (this.chars[n - 1] === '\n' && this.chars[n - 2] === '\n') return;
        if (this.chars[n - 1] !== '\n') this.virtual('\n');
        this.virtual('\n');
    }
}

/* ------------------------------------------------------------------ the plan */

export type Annotation =
    | {
          type: 'quote';
          /** The `<q>` element id. */
          element: number;
          cls: 'dq' | 'gq';
          /** The opening and closing mark (visible ranges) when they are to be wrapped. */
          marks: TextRange[];
      }
    | {
          type: 'span';
          /** `dash`, `paren`, `bracket` or `c-<rule id>`. */
          cls: string;
          start: number;
          end: number;
          /** One wrap around the whole range (it starts and ends in the same element); else one per piece. */
          whole: boolean;
          /** Per-piece wraps when not whole: runs of plain text inside one text piece. */
          pieces: TextRange[];
          /** The opening mark (dash and its space) when it is to be wrapped. */
          marks: TextRange[];
      };

const QUOTE_CLASS: Readonly<Record<string, 'dq' | 'gq'>> = { '"': 'dq', '“': 'dq', '＂': 'dq', '«': 'gq' };
const QUOTE_CLOSER: Readonly<Record<string, string>> = { '"': '"', '“': '”', '＂': '＂', '«': '»' };

/** The range starts and ends in text of the same element and never leaves it. */
export function isWhole(model: VisibleText, start: number, end: number): boolean {
    if (end <= start || model.piece[start]! < 0 || model.piece[end - 1]! < 0) return false;
    const parent = model.parent[start];
    if (model.parent[end - 1] !== parent) return false;
    const depth = model.depth[start]!;
    for (let i = start; i < end; i++) if (model.depth[i]! < depth) return false;
    return true;
}

/** Runs of plain (unmasked, real) characters of one text piece inside the range. */
export function pieceRuns(model: VisibleText, start: number, end: number): TextRange[] {
    const out: TextRange[] = [];
    let run = -1;
    for (let i = start; i <= end; i++) {
        const plain = i < end && model.piece[i]! >= 0 && model.mask[i] === 0;
        const continues =
            plain && run >= 0 && model.piece[i] === model.piece[i - 1] && model.offset[i] === model.offset[i - 1]! + 1;
        if (run >= 0 && !continues) {
            out.push({ start: run, end: i });
            run = -1;
        }
        if (plain && run < 0) run = i;
    }
    return out;
}

function spanPairs(model: VisibleText, span: PlanSpan): Pair[] {
    const { text, mask } = model;
    switch (span.kind) {
        case 'dashDialogue':
            return dashSpeech(text, mask);
        case 'parentheses':
            return parenPairs(text, mask);
        case 'brackets':
            return bracketPairs(text, mask);
        default: {
            const compiled = compileCustom(span.pattern, span.flags);
            return compiled.ok ? customPairs(text, mask, compiled.re) : [];
        }
    }
}

/** What to mark in a rendered message for the plan of its scope. */
export function planAnnotations(model: VisibleText, plan: ScopePlan): Annotation[] {
    const out: Annotation[] = [];
    const { text, mask } = model;
    if (plan.quotes) {
        for (const quote of model.quotes) {
            if (quote.first < 0 || mask[quote.first] === MASK_EXCLUDED) continue;
            const opener = text[quote.first]!;
            const cls = QUOTE_CLASS[opener];
            if (!cls) continue;
            const marks: TextRange[] = [];
            if (
                plan.marks[cls] &&
                quote.last > quote.first &&
                text[quote.last] === QUOTE_CLOSER[opener] &&
                model.parent[quote.first] === quote.element &&
                model.parent[quote.last] === quote.element
            ) {
                marks.push({ start: quote.first, end: quote.first + 1 }, { start: quote.last, end: quote.last + 1 });
            }
            out.push({ type: 'quote', element: quote.element, cls, marks });
        }
    }
    if (!plan.spans.length) return out;
    const sources: Layer1Source[] = plan.spans.map((span) => ({
        ruleId: span.cls,
        kind: span.kind,
        pairs: spanPairs(model, span),
    }));
    for (const match of selectLayer1(sources)) {
        const whole = isWhole(model, match.start, match.end);
        const pieces = whole ? [] : pieceRuns(model, match.start, match.end);
        if (!whole && !pieces.length) continue;
        const marks: TextRange[] = [];
        if (match.kind === 'dashDialogue' && plan.marks.dash && match.open > 0) {
            const mark = { start: match.start, end: match.start + match.open };
            const single = pieceRuns(model, mark.start, mark.end);
            const inPiece =
                single.length === 1 &&
                single[0]!.start === mark.start &&
                single[0]!.end === mark.end &&
                (whole || pieces.some((piece) => piece.start <= mark.start && mark.end <= piece.end));
            if (inPiece) marks.push(mark);
        }
        out.push({ type: 'span', cls: match.ruleId, start: match.start, end: match.end, whole, pieces, marks });
    }
    return out;
}

const ENTITY_DASHES = ['&mdash;', '&ndash;', '&#8212;', '&#8211;', '&#x2014;', '&#x2013;'];

/** Cheap check before parsing a rendered message: could the plan mark anything in this HTML? */
export function mayAnnotate(html: string, plan: ScopePlan): boolean {
    if (!html) return false;
    if (plan.quotes && html.includes('<q')) return true;
    for (const span of plan.spans) {
        if (span.kind === 'custom') return true;
        if (
            span.kind === 'dashDialogue' &&
            (html.includes('—') || html.includes('–') || ENTITY_DASHES.some((entity) => html.includes(entity)))
        ) {
            return true;
        }
        if (span.kind === 'parentheses' && html.includes('(')) return true;
        if (span.kind === 'brackets' && html.includes('[')) return true;
    }
    return false;
}

/* ------------------------------------------------------------------ sample rendering (preview fallback) */

/** What ST itself marks, as rules: quotes become `<q>`, emphasis `<em>`/`<strong>`, backticks `<code>`. */
const ST_RULES: readonly StyleRule[] = (
    [
        ['q1', 'doubleQuotes'],
        ['q2', 'guillemets'],
        ['e1', 'asterisk'],
        ['e2', 'doubleAsterisk'],
        ['e3', 'underscore'],
        ['k1', 'backticks'],
    ] as const
).map(([id, kind]) => ({
    id,
    name: '',
    enabled: true,
    match: { kind },
    applyTo: 'all' as const,
    style: makeStyle(),
}));

const ST_TAGS: Readonly<Record<string, string>> = {
    doubleQuotes: 'q',
    guillemets: 'q',
    asterisk: 'em',
    underscore: 'em',
    doubleAsterisk: 'strong',
    backticks: 'code',
};

function escapeHtml(char: string): string {
    return char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char;
}

/**
 * HTML for a plain sample text the way SillyTavern renders it (quotes in `<q>` with their marks, emphasis in
 * `<em>`/`<strong>` without the asterisks, paragraphs and line breaks): the preview uses it when ST's own formatter
 * is not available. Text is escaped; nothing from the input becomes markup.
 */
export function sampleHtml(text: string): string {
    const n = text.length;
    if (!n) return '';
    const matches = findMatches(text, ST_RULES);
    const opens: string[][] = Array.from({ length: n + 1 }, () => []);
    const closes: string[][] = Array.from({ length: n + 1 }, () => []);
    const skip = new Uint8Array(n);
    for (const match of matches) {
        const tag = ST_TAGS[match.kind] ?? 'span';
        if (tag !== 'q') {
            skip.fill(1, match.start, match.start + match.open);
            skip.fill(1, match.end - match.close, match.end);
        }
        opens[match.start]!.push(`<${tag}>`);
        // Outer matches come first: their closing tags go after the inner ones at the same position.
        closes[match.end]!.unshift(`</${tag}>`);
    }
    const parts: string[] = [];
    for (const para of paragraphRanges(text)) {
        parts.push('<p>');
        for (let i = para.start; i < para.end; i++) {
            parts.push(...closes[i]!, ...opens[i]!);
            if (skip[i]) continue;
            const char = text[i]!;
            parts.push(char === '\n' ? '<br>' : escapeHtml(char));
        }
        parts.push(...closes[para.end]!, '</p>');
    }
    return parts.join('');
}
