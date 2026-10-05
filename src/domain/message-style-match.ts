// The matching engine of message style rules (M32 «Стиль сообщений»): finds what each rule kind marks in a message
// text — "…"/“…” and «…» dialogue, Russian dash dialogue, *…*, **…**, _…_, (…), […], `…`, user regexes — and the
// narration left between them. Used on raw message text (the editor's rule tester, the preview fallback) and, by
// message-style-model.ts, on the visible text of SillyTavern's rendered HTML.
//
// Robustness: delimiters never count inside HTML tags and attributes, comments, code (fences and inline), the DES
// tracker JSON that opens a reply, NAI Studio markers or URLs; nested marks keep the outermost pair; unbalanced marks
// stay plain text. Every scanner is one linear pass over the text (lists of found pairs are merged, not re-scanned).
// Pure: no DOM, no SillyTavern.
import { activeRules, compileCustom } from './message-style';
import type { MatchKind, Scope, StyleRule } from './message-style';
import { stripDesTrackerJson } from './text-clean';

export interface TextRange {
    start: number;
    /** Exclusive. */
    end: number;
}

/** A found pair: the whole range with its marks; `open`/`close` are the lengths of the opening/closing marks. */
export interface Pair extends TextRange {
    open: number;
    close: number;
}

export interface StyleMatch extends Pair {
    ruleId: string;
    kind: MatchKind;
}

/** Mask values: opaque characters are never delimiters; excluded ones also never belong to a custom match. */
export const MASK_OPAQUE = 1;
export const MASK_EXCLUDED = 2;

/* ------------------------------------------------------------------ characters */

const SPACE_RE = /[\s\u00a0\u2009\u202f]/;
const WORD_RE = /[\p{L}\p{N}]/u;
const DASHES = '—–';
const SENTENCE_END = '.!?…';
/** Marks that may follow a sentence end before a dash: «Да.» — / "Нет!" — / (так.) —. */
const CLOSERS = '»"”\')]*_';

function isSpace(char: string | undefined): boolean {
    return char !== undefined && char !== '' && SPACE_RE.test(char);
}

function isWord(char: string | undefined): boolean {
    return char !== undefined && char !== '' && WORD_RE.test(char);
}

/* ------------------------------------------------------------------ lines and paragraphs */

/** Lines of a text range (without their line breaks). */
export function lineRanges(text: string, from = 0, to = text.length): TextRange[] {
    const out: TextRange[] = [];
    let pos = from;
    for (;;) {
        const nl = text.indexOf('\n', pos);
        const end = nl < 0 || nl >= to ? to : nl;
        out.push({ start: pos, end });
        if (end >= to) break;
        pos = end + 1;
    }
    return out;
}

function isBlank(text: string, start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
        const char = text[i];
        if (char !== ' ' && char !== '\t' && char !== '\r') return false;
    }
    return true;
}

/** Paragraphs: runs of non-blank lines (a blank line ends a paragraph). */
export function paragraphRanges(text: string): TextRange[] {
    const out: TextRange[] = [];
    let start = -1;
    let last = 0;
    for (const line of lineRanges(text)) {
        if (isBlank(text, line.start, line.end)) {
            if (start >= 0) out.push({ start, end: last });
            start = -1;
        } else {
            if (start < 0) start = line.start;
            last = line.end;
        }
    }
    if (start >= 0) out.push({ start, end: last });
    return out;
}

/* ------------------------------------------------------------------ exclusions */

export interface Exclusions {
    /** Sorted, merged ranges where nothing is matched (code spans included). */
    ranges: TextRange[];
    /** Inline code spans (`…`, ``…``): what the backticks kind marks. */
    code: TextRange[];
}

const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
/** Elements whose content is not story text. */
const HIDDEN_RE = /<(style|script|pre|code|textarea|bunnymotags|think|thinking)\b[^>]{0,1000}>[\s\S]*?<\/\1\s*>/gi;
/** HTML tags and tag-like markers (`<SPECIES:ELF>`, `<NPC name="…">`); quoted attribute values may hold `>`. */
const TAG_RE = /<\/?[A-Za-z][\w:.-]*(?:\s(?:[^<>"']|"[^"]{0,1000}"|'[^']{0,1000}')*)?\/?>/g;
const NAI_RE = /\[nai:img:[^\]\s]{1,80}\]/g;
const IIG_RE = /\[IMG:GEN:\{[\s\S]{0,4000}?\}\]/g;
/** A URL; balanced parentheses inside it (wiki links) belong to it, a closing one after it does not. */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'«»“”()[\]]+(?:\([^\s<>"'()]*\)[^\s<>"'«»“”()[\]]*)*/gi;
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;

function regexRanges(text: string, re: RegExp, out: TextRange[], trim?: RegExp): void {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        let value = match[0];
        if (trim) value = value.replace(trim, '');
        if (value.length) out.push({ start: match.index, end: match.index + value.length });
        if (match[0].length === 0) re.lastIndex++;
    }
    re.lastIndex = 0;
}

/** Fenced code blocks (``` or ~~~, line based; an unclosed fence runs to the end). */
export function fenceRanges(text: string): TextRange[] {
    if (!text.includes('```') && !text.includes('~~~')) return [];
    const out: TextRange[] = [];
    let open: { start: number; char: string; length: number } | null = null;
    for (const line of lineRanges(text)) {
        const head = FENCE_LINE_RE.exec(text.slice(line.start, Math.min(line.end, line.start + 64)));
        if (!head) continue;
        const run = head[1]!;
        if (!open) {
            open = { start: line.start, char: run[0]!, length: run.length };
        } else if (
            run[0] === open.char &&
            run.length >= open.length &&
            isBlank(text, line.start + head[0].length, line.end)
        ) {
            out.push({ start: open.start, end: line.end });
            open = null;
        }
    }
    if (open) out.push({ start: open.start, end: text.length });
    return out;
}

/** Inline code spans: a run of N backticks closed by the next run of exactly N in the same paragraph. */
export function codeSpanRanges(text: string, blocked?: Uint8Array): TextRange[] {
    if (!text.includes('`')) return [];
    const out: TextRange[] = [];
    for (const para of paragraphRanges(text)) {
        const runs: TextRange[] = [];
        for (let i = para.start; i < para.end;) {
            if (text[i] === '`' && !blocked?.[i]) {
                let j = i;
                while (j < para.end && text[j] === '`' && !blocked?.[j]) j++;
                runs.push({ start: i, end: j });
                i = j;
            } else {
                i++;
            }
        }
        // A length without a closer later in the paragraph never closes again: remember it (keeps this linear).
        const exhausted = new Set<number>();
        for (let r = 0; r < runs.length; r++) {
            const open = runs[r]!;
            const length = open.end - open.start;
            if (exhausted.has(length)) continue;
            let c = r + 1;
            while (c < runs.length && runs[c]!.end - runs[c]!.start !== length) c++;
            if (c >= runs.length) {
                exhausted.add(length);
                continue;
            }
            out.push({ start: open.start, end: runs[c]!.end });
            r = c;
        }
    }
    return out;
}

/** Sorted and merged. */
export function mergeRanges(ranges: TextRange[]): TextRange[] {
    const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
    const out: TextRange[] = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else out.push({ start: range.start, end: range.end });
    }
    return out;
}

/** The DES tracker JSON that opens a reply in together mode (fenced or bare), as a range. */
export function desTrackerRange(text: string): TextRange | null {
    const rest = stripDesTrackerJson(text);
    return rest.length < text.length ? { start: 0, end: text.length - rest.length } : null;
}

/** Everything that is not story text: code, HTML, the DES tracker, NAI markers, URLs. */
export function textExclusions(text: string): Exclusions {
    if (!text) return { ranges: [], code: [] };
    const ranges: TextRange[] = [];
    const des = desTrackerRange(text);
    if (des) ranges.push(des);
    const fences = fenceRanges(text);
    ranges.push(...fences);
    let code: TextRange[] = [];
    if (text.includes('`')) {
        code = codeSpanRanges(text, maskOf(text.length, mergeRanges([...fences, ...(des ? [des] : [])])));
        ranges.push(...code);
    }
    if (text.includes('<')) {
        regexRanges(text, COMMENT_RE, ranges);
        regexRanges(text, HIDDEN_RE, ranges);
        regexRanges(text, TAG_RE, ranges);
    }
    if (text.includes('[')) {
        regexRanges(text, NAI_RE, ranges);
        regexRanges(text, IIG_RE, ranges);
    }
    if (/https?:|www\./i.test(text)) regexRanges(text, URL_RE, ranges, /[.,!?;:…]+$/);
    return { ranges: mergeRanges(ranges), code };
}

/** A mask with `value` over the ranges (other characters 0). */
export function maskOf(length: number, ranges: readonly TextRange[], value = MASK_EXCLUDED): Uint8Array {
    const mask = new Uint8Array(length);
    for (const range of ranges) mask.fill(value, Math.max(0, range.start), Math.min(length, range.end));
    return mask;
}

/* ------------------------------------------------------------------ dialogue and asides */

/** "…" and “…” on one line, like ST pairs them (the first closing mark ends the quote; empty quotes are skipped). */
export function quotePairs(text: string, mask: Uint8Array): Pair[] {
    const out: Pair[] = [];
    if (!text.includes('"') && !text.includes('“')) return out;
    for (const line of lineRanges(text)) {
        let straight = -1;
        let curly = -1;
        for (let i = line.start; i < line.end; i++) {
            if (mask[i]) continue;
            const char = text[i];
            if (char === '"') {
                if (straight < 0 && curly < 0) straight = i;
                else if (straight >= 0) {
                    if (i > straight + 1) out.push({ start: straight, end: i + 1, open: 1, close: 1 });
                    straight = -1;
                }
            } else if (char === '“') {
                if (straight < 0 && curly < 0) curly = i;
            } else if (char === '”' && curly >= 0) {
                if (i > curly + 1) out.push({ start: curly, end: i + 1, open: 1, close: 1 });
                curly = -1;
            }
        }
    }
    return out;
}

/**
 * Outermost balanced pairs of `open`/`close` in each range (a stack: nested pairs fold into the outer one, an
 * unmatched mark is plain text and inner pairs around it still count). Empty pairs are skipped.
 */
export function nestedPairs(
    text: string,
    mask: Uint8Array,
    open: string,
    close: string,
    ranges: readonly TextRange[],
    options: { skip?: (index: number) => boolean; accept?: (pair: Pair) => boolean } = {},
): Pair[] {
    const out: Pair[] = [];
    for (const range of ranges) {
        const stack: number[] = [];
        const kept: Pair[] = [];
        for (let i = range.start; i < range.end; i++) {
            if (mask[i]) continue;
            const char = text[i];
            if (char === open) {
                if (!options.skip?.(i)) stack.push(i);
            } else if (char === close && stack.length && !options.skip?.(i)) {
                const start = stack.pop()!;
                const pair: Pair = { start, end: i + 1, open: 1, close: 1 };
                if (pair.end - pair.start <= 2 || (options.accept && !options.accept(pair))) continue;
                // Pairs inside this one were kept before it (they closed first): the outer one replaces them.
                while (kept.length && kept[kept.length - 1]!.start > start) kept.pop();
                kept.push(pair);
            }
        }
        out.push(...kept);
    }
    return out;
}

/** «…» on one line, nesting allowed. */
export function guillemetPairs(text: string, mask: Uint8Array): Pair[] {
    if (!text.includes('«')) return [];
    return nestedPairs(text, mask, '«', '»', lineRanges(text));
}

/** (…) in a paragraph; smileys `:)` `;(` are not brackets. */
export function parenPairs(text: string, mask: Uint8Array): Pair[] {
    if (!text.includes('(')) return [];
    return nestedPairs(text, mask, '(', ')', paragraphRanges(text), {
        skip: (i) => text[i - 1] === ':' || text[i - 1] === ';',
    });
}

/** […] in a paragraph; a Markdown link `[text](url)` is not an aside. */
export function bracketPairs(text: string, mask: Uint8Array): Pair[] {
    if (!text.includes('[')) return [];
    return nestedPairs(text, mask, '[', ']', paragraphRanges(text), { accept: (pair) => text[pair.end] !== '(' });
}

/** Index of the previous character that is neither whitespace nor excluded (line start - 1 when none). */
function previousChar(text: string, mask: Uint8Array, from: number, lineStart: number): number {
    let p = from;
    while (p >= lineStart && (isSpace(text[p]) || mask[p] === MASK_EXCLUDED)) p--;
    return p;
}

/** The character at p ends a sentence, possibly followed by closing marks: `.`, `!»`, `?"`, `.)`. */
function endsSentence(text: string, p: number, lineStart: number): boolean {
    let q = p;
    while (q >= lineStart && CLOSERS.includes(text[q]!)) q--;
    return q >= lineStart && SENTENCE_END.includes(text[q]!);
}

/**
 * Russian direct speech with dashes, line by line. Speech starts at «— »/«– » at the start of a line, after a
 * sentence end or a colon; in a line that opened with speech also after a comma («…, — сказал он, — как дела?»).
 * Speech ends before « — » that follows `,` `.` `!` `?` `…` (the author's words), or at the end of the line. A
 * dash inside a sentence («Москва — столица») is plain text. The opening mark is the dash with its space; a comma
 * before the author's words stays outside («— Привет», — сказал он).
 */
export function dashSpeech(text: string, mask: Uint8Array): Pair[] {
    const out: Pair[] = [];
    if (!text.includes('—') && !text.includes('–')) return out;
    for (const line of lineRanges(text)) {
        let first = line.start;
        while (first < line.end && (isSpace(text[first]) || text[first] === '>' || mask[first] === MASK_EXCLUDED)) {
            first++;
        }
        let speech = -1;
        let dialogueLine = false;
        for (let i = first; i < line.end; i++) {
            if (!DASHES.includes(text[i]!) || mask[i] || i + 1 >= line.end || !isSpace(text[i + 1])) continue;
            const p = previousChar(text, mask, i - 1, line.start);
            const spaced = p < i - 1;
            if (speech < 0) {
                if (i === first) {
                    speech = i;
                    dialogueLine = true;
                    continue;
                }
                if (!spaced || p < line.start) continue;
                const prev = text[p]!;
                if (prev === ':' || endsSentence(text, p, line.start) || (dialogueLine && prev === ',')) speech = i;
            } else {
                if (!spaced || p < speech + 2) continue;
                const prev = text[p]!;
                if (prev !== ',' && !endsSentence(text, p, line.start)) continue;
                const end = prev === ',' ? p : p + 1;
                if (end > speech + 2) out.push({ start: speech, end, open: 2, close: 0 });
                speech = -1;
            }
        }
        if (speech >= 0) {
            let end = line.end;
            while (end > speech && isSpace(text[end - 1])) end--;
            if (end > speech + 2) out.push({ start: speech, end, open: 2, close: 0 });
        }
    }
    return out;
}

/** Matches of a user regex (at most `limit`); none may start or end in opaque text or hold excluded text. */
export function customPairs(text: string, mask: Uint8Array, re: RegExp, limit = 500): Pair[] {
    const out: Pair[] = [];
    const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
    global.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = global.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (end === start) {
            global.lastIndex = start + 1;
            continue;
        }
        let clear = mask[start] === 0 && mask[end - 1] === 0;
        for (let i = start; clear && i < end; i++) if (mask[i] === MASK_EXCLUDED) clear = false;
        if (clear) out.push({ start, end, open: 0, close: 0 });
        if (out.length >= limit) break;
    }
    global.lastIndex = 0;
    return out;
}

/* ------------------------------------------------------------------ inline emphasis */

/**
 * `*…*` and `**…**` per paragraph with a delimiter stack (a light CommonMark): a run can open when the next character
 * is not a space and close when the previous one is not; `***x***` gives an `*` pair around a `**` pair. Pairs are
 * properly nested by construction.
 */
export function emphasisPairs(text: string, mask: Uint8Array): { em: Pair[]; strong: Pair[] } {
    const em: Pair[] = [];
    const strong: Pair[] = [];
    if (!text.includes('*')) return { em, strong };
    for (const para of paragraphRanges(text)) {
        const stack: TextRange[] = [];
        for (let i = para.start; i < para.end; i++) {
            if (text[i] !== '*' || mask[i]) continue;
            let j = i;
            while (j < para.end && text[j] === '*' && !mask[j]) j++;
            const prev = i > para.start ? text[i - 1] : undefined;
            const next = j < para.end ? text[j] : undefined;
            const canOpen = next !== undefined && !isSpace(next);
            const canClose = prev !== undefined && !isSpace(prev);
            let rest = i;
            if (canClose) {
                while (rest < j && stack.length) {
                    const opener = stack[stack.length - 1]!;
                    const use = opener.end - opener.start >= 2 && j - rest >= 2 ? 2 : 1;
                    (use === 2 ? strong : em).push({ start: opener.end - use, end: rest + use, open: use, close: use });
                    opener.end -= use;
                    rest += use;
                    if (opener.end <= opener.start) stack.pop();
                }
            }
            if (rest < j && canOpen) stack.push({ start: rest, end: j });
            i = j - 1;
        }
    }
    return { em, strong };
}

/** `_…_` on one line like ST's underscore extension: single underscores at word edges, the first closer wins. */
export function underscorePairs(text: string, mask: Uint8Array): Pair[] {
    const out: Pair[] = [];
    if (!text.includes('_')) return out;
    for (const line of lineRanges(text)) {
        let open = -1;
        for (let i = line.start; i < line.end; i++) {
            if (text[i] !== '_' || mask[i] || text[i - 1] === '_' || text[i + 1] === '_') continue;
            const prev = i > line.start ? text[i - 1] : undefined;
            const next = i + 1 < line.end ? text[i + 1] : undefined;
            if (open < 0) {
                if (!isWord(prev) && next !== undefined && !isSpace(next)) open = i;
            } else if (!isWord(next) && prev !== undefined && !isSpace(prev) && i > open + 1) {
                out.push({ start: open, end: i + 1, open: 1, close: 1 });
                open = -1;
            }
        }
    }
    return out;
}

/* ------------------------------------------------------------------ selection */

/** For a family of properly nested (or disjoint) ranges: the innermost range holding each position, -1 for none. */
export function innermost(length: number, ranges: readonly TextRange[]): Int32Array {
    const inner = new Int32Array(length).fill(-1);
    if (!ranges.length) return inner;
    const order = ranges
        .map((_, index) => index)
        .sort((a, b) => ranges[a]!.start - ranges[b]!.start || ranges[b]!.end - ranges[a]!.end);
    const stack: number[] = [];
    let k = 0;
    for (let pos = 0; pos < length; pos++) {
        while (stack.length && ranges[stack[stack.length - 1]!]!.end <= pos) stack.pop();
        while (k < order.length && ranges[order[k]!]!.start <= pos) {
            if (ranges[order[k]!]!.end > pos) stack.push(order[k]!);
            k++;
        }
        inner[pos] = stack.length ? stack[stack.length - 1]! : -1;
    }
    return inner;
}

/** The range crosses a member of the family the `inner` map was built from (neither inside nor around it). */
export function crosses(range: TextRange, inner: Int32Array): boolean {
    return inner[range.start] !== inner[range.end - 1];
}

/** Candidates of one rule (or plan entry) for the outer layer: dialogue, asides, custom. */
export interface Layer1Source {
    ruleId: string;
    kind: MatchKind;
    /** Sorted by start. */
    pairs: Pair[];
}

/**
 * Outer layer: no overlaps. Sources are merged by start (one linear k-way merge); the earliest start wins, a tie
 * goes to the source listed first (the rule higher in the list).
 */
export function selectLayer1(sources: readonly Layer1Source[]): StyleMatch[] {
    const heads = sources.map(() => 0);
    const out: StyleMatch[] = [];
    let cursor = 0;
    for (;;) {
        let best = -1;
        for (let s = 0; s < sources.length; s++) {
            const pair = sources[s]!.pairs[heads[s]!];
            if (!pair) continue;
            if (best < 0 || pair.start < sources[best]!.pairs[heads[best]!]!.start) best = s;
        }
        if (best < 0) break;
        const source = sources[best]!;
        const pair = source.pairs[heads[best]!]!;
        heads[best]!++;
        if (pair.start < cursor) continue;
        out.push({ ...pair, ruleId: source.ruleId, kind: source.kind });
        cursor = pair.end;
    }
    return out;
}

/** Candidates of a built-in outer-layer kind. */
export function layer1Pairs(text: string, mask: Uint8Array, kind: MatchKind): Pair[] {
    switch (kind) {
        case 'doubleQuotes':
            return quotePairs(text, mask);
        case 'guillemets':
            return guillemetPairs(text, mask);
        case 'dashDialogue':
            return dashSpeech(text, mask);
        case 'parentheses':
            return parenPairs(text, mask);
        case 'brackets':
            return bracketPairs(text, mask);
        default:
            return [];
    }
}

const LAYER1_KINDS: readonly MatchKind[] = [
    'doubleQuotes',
    'guillemets',
    'dashDialogue',
    'parentheses',
    'brackets',
    'custom',
];

function byStart(a: StyleMatch, b: StyleMatch): number {
    return a.start - b.start || b.end - a.end;
}

/**
 * Everything the enabled rules of a scope mark in a raw message text, outer matches before the ones inside them.
 * With several rules of one built-in kind the first one marks it. Narration is not a match: see narrationRanges.
 */
export function findMatches(text: string, rules: readonly StyleRule[], options: { scope?: Scope } = {}): StyleMatch[] {
    const active = activeRules(rules, options.scope).filter((rule) => rule.match.kind !== 'narration');
    if (!text || !active.length) return [];
    const exclusions = textExclusions(text);
    const mask = maskOf(text.length, exclusions.ranges);

    const firstOf = (kind: MatchKind) => active.find((rule) => rule.match.kind === kind);
    const sources: Layer1Source[] = [];
    const seen = new Set<MatchKind>();
    for (const rule of active) {
        const kind = rule.match.kind;
        if (!LAYER1_KINDS.includes(kind)) continue;
        if (kind === 'custom') {
            const compiled = compileCustom(rule.match.pattern, rule.match.flags);
            if (compiled.ok) sources.push({ ruleId: rule.id, kind, pairs: customPairs(text, mask, compiled.re) });
            continue;
        }
        if (seen.has(kind)) continue;
        seen.add(kind);
        sources.push({ ruleId: rule.id, kind, pairs: layer1Pairs(text, mask, kind) });
    }
    const outer = selectLayer1(sources);
    const outerInner = innermost(text.length, outer);

    const inline: StyleMatch[] = [];
    const want = (kind: MatchKind) => firstOf(kind);
    const asterisk = want('asterisk');
    const strongRule = want('doubleAsterisk');
    const underscore = want('underscore');
    const backticks = want('backticks');
    if (asterisk || strongRule || underscore) {
        const { em, strong } = emphasisPairs(text, mask);
        const family = [...em, ...strong];
        const familyInner = innermost(text.length, family);
        const keep = (pair: Pair) => !crosses(pair, outerInner);
        if (asterisk)
            for (const pair of em) if (keep(pair)) inline.push({ ...pair, ruleId: asterisk.id, kind: 'asterisk' });
        if (strongRule) {
            for (const pair of strong) {
                if (keep(pair)) inline.push({ ...pair, ruleId: strongRule.id, kind: 'doubleAsterisk' });
            }
        }
        if (underscore) {
            for (const pair of underscorePairs(text, mask)) {
                if (keep(pair) && !crosses(pair, familyInner)) {
                    inline.push({ ...pair, ruleId: underscore.id, kind: 'underscore' });
                }
            }
        }
    }
    if (backticks) {
        for (const range of exclusions.code) {
            const ticks = countTicks(text, range.start);
            const pair: Pair = { start: range.start, end: range.end, open: ticks, close: ticks };
            if (!crosses(pair, outerInner)) inline.push({ ...pair, ruleId: backticks.id, kind: 'backticks' });
        }
    }
    return [...outer, ...inline].sort(byStart);
}

function countTicks(text: string, start: number): number {
    let n = 0;
    while (text[start + n] === '`') n++;
    return n;
}

/**
 * Narration: text no match covers, outside excluded parts, without whitespace-only runs. `matches` may nest; a
 * difference array keeps this linear.
 */
export function narrationRanges(text: string, matches: readonly TextRange[]): TextRange[] {
    const n = text.length;
    if (!n) return [];
    const mask = maskOf(n, textExclusions(text).ranges);
    const diff = new Int32Array(n + 1);
    for (const match of matches) {
        diff[Math.max(0, match.start)]!++;
        diff[Math.min(n, match.end)]!--;
    }
    const out: TextRange[] = [];
    let depth = 0;
    let start = -1;
    let content = false;
    const flush = (end: number) => {
        if (start >= 0 && content) out.push({ start, end });
        start = -1;
        content = false;
    };
    for (let i = 0; i < n; i++) {
        depth += diff[i]!;
        const free = depth === 0 && mask[i] !== MASK_EXCLUDED;
        if (!free) {
            flush(i);
            continue;
        }
        if (start < 0) start = i;
        if (!isSpace(text[i])) content = true;
    }
    flush(n);
    return out;
}

export interface Segmentation {
    matches: StyleMatch[];
    /** The narration rule of the scope (the first enabled one) and its ranges; null without such a rule. */
    narration: { ruleId: string; ranges: TextRange[] } | null;
}

/** Matches and narration of a raw message text for one scope. */
export function segmentText(text: string, rules: readonly StyleRule[], options: { scope?: Scope } = {}): Segmentation {
    const matches = findMatches(text, rules, options);
    const narrationRule = activeRules(rules, options.scope).find((rule) => rule.match.kind === 'narration');
    return {
        matches,
        narration: narrationRule ? { ruleId: narrationRule.id, ranges: narrationRanges(text, matches) } : null,
    };
}
