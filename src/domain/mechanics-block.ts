// M25 «Механики», the service block (plan M25 п. 4: «короткий служебный блок в ответе модели — Maestro разбирает и
// прячет его, ошибки формата чинит»). In 'block' tracking the model ends its reply with
//     <mechanics>
//     Kai.Mana: -10
//     Kai.School += fire
//     Mira.Attitude = warm
//     </mechanics>
// Maestro parses it on arrival, keeps the parsed lines in the message's extra, strips the block from the text and
// applies the changes when the reply is committed (P14). The parser is tolerant: a missing closing (or opening) tag,
// code fences, `[mechanics]` brackets, HTML-escaped tags, bullets, Russian holder names, `Kai's health`, attribute by
// id / prompt name / display name in any case, unicode minus, ×/x/* factors, `12 → 9`, `45/100`, trailing comments.
// Pure: no DOM, no SillyTavern.
import { trackingOf } from './mechanics-defs';
import type { AttributeDef, MechanicDef } from './mechanics-defs';
import { findAttribute, nameKey, toNumber } from './mechanics-state';
import type { Edit, EditOp } from './mechanics-state';

/** One parsed line of a block. `attribute` is '' when the line had no `Holder.attribute` dot. */
export interface BlockItem {
    holder: string;
    attribute: string;
    op: EditOp;
    value: string | number;
    reason?: string;
    /** The line as written (trimmed). */
    line: string;
}

export interface ParsedBlock {
    /** A block (or a fragment of one) was in the text. */
    found: boolean;
    items: BlockItem[];
    /** What was repaired: 'unclosed', 'unopened', 'fence', 'bracket', 'escaped', 'stray', 'many'. */
    repaired: string[];
    /** Non-empty lines inside a block that could not be read. */
    dropped: string[];
}

interface Token {
    kind: 'open' | 'close';
    start: number;
    end: number;
    style: 'tag' | 'bracket' | 'escaped';
}

interface Span {
    start: number;
    end: number;
    bodyStart: number;
    bodyEnd: number;
}

const OPEN_RE = /<[ \t]*mechanics(?![\w-])[^>\n]*>/gi;
const CLOSE_RE = /<[ \t]*\/[ \t]*mechanics[ \t]*>/gi;
const ESCAPED_OPEN_RE = /&lt;[ \t]*mechanics(?![\w-])[^&\n]*?&gt;/gi;
const ESCAPED_CLOSE_RE = /&lt;[ \t]*\/[ \t]*mechanics[ \t]*&gt;/gi;
const BRACKET_OPEN_RE = /\[[ \t]*mechanics[ \t]*\]/gi;
const BRACKET_CLOSE_RE = /\[[ \t]*\/[ \t]*mechanics[ \t]*\]/gi;
const FENCE_RE = /```[ \t]*mechanics[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```[ \t]*(?=\r?\n|$)|$)/gi;
/** A block opening cut off by the end of a streamed text: `<`, `<mec`, `</mechanic`, `[mecha` … */
const PARTIAL_TAIL_RE = /(?:<|&lt;|\[)[ \t]*\/?[ \t]*m(?:e(?:c(?:h(?:a(?:n(?:i(?:c(?:s)?)?)?)?)?)?)?)?[ \t]*$/i;
const MARKER_RE = /mechanics/i;
const MINUS_RE = /[\u2212\u2012\u2013\u2014\uFE63\uFF0D](?=\s*\d)/g;

/** Cheap pre-check: the text may hold a block. */
export function hasBlockMarker(text: string): boolean {
    return typeof text === 'string' && MARKER_RE.test(text);
}

function tokensOf(text: string): Token[] {
    const tokens: Token[] = [];
    const collect = (re: RegExp, kind: Token['kind'], style: Token['style']) => {
        for (const match of text.matchAll(re)) {
            tokens.push({ kind, style, start: match.index, end: match.index + match[0].length });
        }
    };
    collect(OPEN_RE, 'open', 'tag');
    collect(CLOSE_RE, 'close', 'tag');
    collect(ESCAPED_OPEN_RE, 'open', 'escaped');
    collect(ESCAPED_CLOSE_RE, 'close', 'escaped');
    collect(BRACKET_OPEN_RE, 'open', 'bracket');
    collect(BRACKET_CLOSE_RE, 'close', 'bracket');
    return tokens.sort((a, b) => a.start - b.start);
}

function lineBounds(text: string, from: number): { start: number; end: number } {
    const end = text.indexOf('\n', from);
    return { start: from, end: end < 0 ? text.length : end };
}

/** A line that is surely a block line (outside the tags): `Holder.attribute …` or an explicit change. */
function strictLine(line: string): boolean {
    const item = parseBlockLine(line);
    return !!item && (item.attribute !== '' || item.op !== 'set');
}

/** Where an unclosed block ends: after its last readable (or blank) line. */
function unclosedEnd(text: string, bodyStart: number): number {
    // The rest of the opening line belongs to the block.
    const first = lineBounds(text, bodyStart);
    const firstLine = text.slice(first.start, first.end);
    if (firstLine.trim() && !strictLine(firstLine)) return bodyStart;
    let end = first.end;
    let cursor = first.end + 1;
    while (cursor <= text.length) {
        const { start, end: lineEnd } = lineBounds(text, cursor);
        const line = text.slice(start, lineEnd);
        if (line.trim()) {
            if (!strictLine(line) && !/^\s*```\s*$/.test(line)) break;
            end = lineEnd;
        }
        if (lineEnd >= text.length) break;
        cursor = lineEnd + 1;
    }
    return end;
}

/** Where a block without its opening tag starts: the readable lines right above the closing tag. */
function unopenedStart(text: string, closeStart: number, floor: number): number {
    let start = closeStart;
    const head = text.slice(floor, closeStart);
    const lines = head.split('\n');
    // The part of the closing tag's own line before it.
    let offset = closeStart;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? '';
        offset -= line.length;
        if (line.trim()) {
            if (!strictLine(line)) break;
            start = offset;
        }
        offset -= 1; // the line break
    }
    return Math.max(floor, start);
}

/** Extends a span over a plain code fence wrapped around it. */
function withFence(text: string, span: Span): Span {
    const before = /```[\w-]*[ \t]*\r?\n[ \t]*$/.exec(text.slice(Math.max(0, span.start - 40), span.start));
    const after = /^[ \t]*\r?\n?[ \t]*```[ \t]*(?=\r?\n|$)/.exec(text.slice(span.end));
    if (!before || !after) return span;
    return { ...span, start: span.start - before[0].length, end: span.end + after[0].length };
}

function blockSpans(text: string, repaired: Set<string>, partial = false): Span[] {
    const spans: Span[] = [];
    const tokens = tokensOf(text);
    let floor = 0;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token || token.start < floor) continue;
        if (token.style !== 'tag') repaired.add(token.style);
        if (token.kind === 'open') {
            const close = tokens.slice(i + 1).find((item) => item.kind === 'close');
            const nextOpen = tokens.slice(i + 1).find((item) => item.kind === 'open');
            if (close && (!nextOpen || close.start < nextOpen.start)) {
                spans.push({ start: token.start, end: close.end, bodyStart: token.end, bodyEnd: close.start });
                floor = close.end;
                if (close.style !== 'tag') repaired.add(close.style);
            } else {
                repaired.add('unclosed');
                // A block still streaming runs to the end of the text.
                const end = partial ? text.length : unclosedEnd(text, token.end);
                spans.push({ start: token.start, end, bodyStart: token.end, bodyEnd: end });
                floor = end;
            }
        } else {
            const start = unopenedStart(text, token.start, floor);
            repaired.add(start < token.start ? 'unopened' : 'stray');
            spans.push({ start, end: token.end, bodyStart: start, bodyEnd: token.start });
            floor = token.end;
        }
    }
    for (const match of text.matchAll(FENCE_RE)) {
        const start = match.index;
        const end = start + match[0].length;
        if (spans.some((span) => start < span.end && end > span.start)) continue;
        repaired.add('fence');
        const bodyStart = start + match[0].indexOf('\n') + 1;
        spans.push({ start, end, bodyStart, bodyEnd: bodyStart + (match[1] ?? '').length });
    }
    const wrapped = spans.map((span) => {
        const fenced = withFence(text, span);
        if (fenced !== span) repaired.add('fence');
        return fenced;
    });
    if (wrapped.length > 1) repaired.add('many');
    return wrapped.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ lines */

const ARROW_RE = /(?:→|->|=>|⟶)\s*([^→]*?)\s*$/;
const FRACTION_RE = /^([+-]?\d+(?:[.,]\d+)?)\s*\/\s*\d+(?:[.,]\d+)?$/;
const FACTOR_RE = /^[×x*]\s*(\d+(?:[.,]\d+)?)$/i;
const SIGNED_RE = /^[+-]\s*\d+(?:[.,]\d+)?$/;

function unquote(value: string): string {
    return value.replace(/^["'«»“”`]+|["'«»“”`]+$/g, '').trim();
}

function splitReason(right: string): { value: string; reason?: string } {
    let value = right.trim();
    let reason: string | undefined;
    const paren = /\s*\(([^()]*)\)\s*$/.exec(value);
    if (paren && paren.index > 0) {
        reason = paren[1]?.trim();
        value = value.slice(0, paren.index).trim();
    }
    const separator = /\s+(?:#|\/\/|—|–|--)\s*/.exec(value);
    if (separator && separator.index > 0) {
        const rest = value.slice(separator.index + separator[0].length).trim();
        if (rest) reason = reason ? `${rest}; ${reason}` : rest;
        value = value.slice(0, separator.index).trim();
    }
    return reason ? { value, reason } : { value };
}

function splitLeft(left: string): { holder: string; attribute: string } {
    const text = left
        .replace(/[*`]+/g, '')
        .replace(/^_+|_+$/g, '')
        .trim()
        .replace(/\s*\.\s*/g, '.');
    const dot = text.lastIndexOf('.');
    if (dot > 0 && dot < text.length - 1) {
        return { holder: text.slice(0, dot).trim(), attribute: text.slice(dot + 1).trim() };
    }
    const possessive = /^(.+?)['’]s\s+(.+)$/i.exec(text);
    if (possessive?.[1] && possessive[2]) return { holder: possessive[1].trim(), attribute: possessive[2].trim() };
    return { holder: text.replace(/\.$/, '').trim(), attribute: '' };
}

/** One `Holder.attribute <op> value` line; null when the line is not one. */
export function parseBlockLine(raw: string): BlockItem | null {
    let line = String(raw ?? '')
        .replace(/[\u00a0\u202f]/g, ' ')
        .trim();
    if (!line || /^(?:<|&lt;|\[\/?\s*mechanics|```)/i.test(line)) return null;
    line = line
        .replace(/^(?:[-*•·]|\d+[.)])\s+/, '')
        .replace(/^[*_`]+|[*_`]+$/g, '')
        .trim();
    const normalized = line.replace(MINUS_RE, '-');
    let left: string;
    let op: string;
    let right: string;
    const strict = /^(.+?)\s*(\+=|-=|\*=|×=|=|:)\s*(.*)$/.exec(normalized);
    const loose = /^(.+?)\s+((?:[+\-×*]|x(?=\s*\d))\s*\d[\s\S]*)$/i.exec(normalized);
    if (strict?.[1] && strict[2] && strict[3]?.trim()) {
        left = strict[1];
        op = strict[2];
        right = strict[3];
    } else if (loose?.[1] && loose[2]) {
        left = loose[1];
        op = ':';
        right = loose[2];
    } else return null;
    const { holder, attribute } = splitLeft(left);
    if (!holder || holder.length > 80 || /[<>{}]/.test(holder)) return null;
    const { value: rawValue, reason } = splitReason(right);
    const value = unquote(rawValue);
    if (!value || /^\(.*\)$/.test(value)) return null;
    const number = toNumber(value);
    let item: Omit<BlockItem, 'line'> | null = null;
    switch (op) {
        case '+=':
            item = { holder, attribute, op: 'add', value: number ?? value };
            break;
        case '-=':
            item =
                number !== null
                    ? { holder, attribute, op: 'add', value: -number }
                    : { holder, attribute, op: 'sub', value };
            break;
        case '*=':
        case '×=':
            item = number !== null ? { holder, attribute, op: 'mul', value: number } : null;
            break;
        default: {
            const arrow = ARROW_RE.exec(value);
            const target = arrow?.[1] ? unquote(arrow[1]) : value;
            const fraction = FRACTION_RE.exec(target);
            const factor = FACTOR_RE.exec(target);
            if (SIGNED_RE.test(target)) item = { holder, attribute, op: 'add', value: toNumber(target) ?? 0 };
            else if (factor?.[1]) item = { holder, attribute, op: 'mul', value: toNumber(factor[1]) ?? 1 };
            else if (fraction?.[1]) item = { holder, attribute, op: 'set', value: toNumber(fraction[1]) ?? 0 };
            else if (target) item = { holder, attribute, op: 'set', value: toNumber(target) ?? target };
        }
    }
    if (!item) return null;
    return reason ? { ...item, reason, line } : { ...item, line };
}

/** Every block of a text: its lines, what was repaired and what could not be read. */
export function parseBlock(text: string): ParsedBlock {
    const source = typeof text === 'string' ? text : '';
    const result: ParsedBlock = { found: false, items: [], repaired: [], dropped: [] };
    if (!hasBlockMarker(source)) return result;
    const repaired = new Set<string>();
    const spans = blockSpans(source, repaired);
    result.found = spans.length > 0;
    for (const span of spans) {
        for (const line of source.slice(span.bodyStart, span.bodyEnd).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || /^```[\w-]*$/.test(trimmed)) continue;
            const item = parseBlockLine(trimmed);
            if (item) result.items.push(item);
            else result.dropped.push(trimmed);
        }
    }
    result.repaired = [...repaired];
    return result;
}

function joinAround(head: string, tail: string): string {
    const left = head.replace(/[ \t]+$/, '');
    const right = tail.replace(/^[ \t]+/, '');
    if (!right.trim()) return left.replace(/\s+$/, '');
    if (!left.trim()) return right.replace(/^\s+/, '');
    const leftBreaks = (/(?:\r?\n)*$/.exec(left)?.[0] ?? '').replace(/\r/g, '').length;
    const rightBreaks = (/^(?:\r?\n)*/.exec(right)?.[0] ?? '').replace(/\r/g, '').length;
    // The block's own line breaks go with it: keep the wider gap of the two sides, at most one blank line.
    const breaks = Math.min(2, Math.max(leftBreaks, rightBreaks));
    const glue = breaks ? '\n'.repeat(breaks) : ' ';
    return `${left.replace(/\s+$/, '')}${glue}${right.replace(/^\s+/, '')}`;
}

/**
 * The text without its blocks (whitespace around them tidied, everything else kept byte for byte). `partial`: also
 * cuts an opening cut off by the end of a streamed text. The same string comes back when there is nothing to strip.
 */
export function stripBlock(text: string, options: { partial?: boolean } = {}): string {
    if (typeof text !== 'string' || (!hasBlockMarker(text) && !(options.partial && /[<[&]/.test(text)))) return text;
    let out = text;
    if (hasBlockMarker(out)) {
        const spans = blockSpans(out, new Set(), options.partial === true);
        for (const span of [...spans].reverse()) out = joinAround(out.slice(0, span.start), out.slice(span.end));
    }
    if (options.partial) {
        const tail = PARTIAL_TAIL_RE.exec(out);
        if (tail && tail.index > 0 && /\n\s*$/.test(out.slice(0, tail.index)))
            out = out.slice(0, tail.index).replace(/\s+$/, '');
    }
    return out === text ? text : out;
}

/* ------------------------------------------------------------------ resolution */

export type BlockRejectReason = 'attribute' | 'holder' | 'mode';

export interface BlockResolveOptions {
    /** The holder of a mechanic a raw name stands for; null when the mechanic has no such holder. */
    resolveHolder: (def: MechanicDef, raw: string) => string | null;
    /** Attributes the block may change (default: tracking 'block'). */
    allows?: (def: MechanicDef, attr: AttributeDef) => boolean;
}

function attributeSuffix(holderText: string, attr: AttributeDef): string | null {
    const text = nameKey(holderText);
    for (const name of [attr.promptName, attr.name, attr.id]) {
        const key = nameKey(name);
        if (key && text.endsWith(` ${key}`)) {
            const words = key.split(' ').length;
            return holderText
                .trim()
                .split(/\s+/)
                .slice(0, -words)
                .join(' ')
                .replace(/['’]s$/i, '')
                .trim();
        }
    }
    return null;
}

/** Block lines → edits of the given mechanics (the holder decides between attributes of the same name). */
export function resolveBlock(
    items: readonly BlockItem[],
    defs: readonly MechanicDef[],
    options: BlockResolveOptions,
): { edits: Edit[]; rejected: { item: BlockItem; reason: BlockRejectReason }[] } {
    const allows = options.allows ?? ((def: MechanicDef, attr: AttributeDef) => trackingOf(def, attr) === 'block');
    const edits: Edit[] = [];
    const rejected: { item: BlockItem; reason: BlockRejectReason }[] = [];
    for (const item of items) {
        const candidates: { def: MechanicDef; attr: AttributeDef; holder: string }[] = [];
        for (const def of defs) {
            if (item.attribute) {
                const attr = findAttribute(def, item.attribute);
                if (attr) candidates.push({ def, attr, holder: item.holder });
            } else {
                for (const attr of def.attributes) {
                    const holder = attributeSuffix(item.holder, attr);
                    if (holder) candidates.push({ def, attr, holder });
                }
            }
        }
        if (!candidates.length) {
            rejected.push({ item, reason: 'attribute' });
            continue;
        }
        // Mechanics of listed holders first: 'characters' takes any name, so it must not win a shared attribute name.
        candidates.sort(
            (a, b) => Number(a.def.holders.kind === 'characters') - Number(b.def.holders.kind === 'characters'),
        );
        let reason: BlockRejectReason = 'holder';
        let done = false;
        for (const candidate of candidates) {
            const holder = options.resolveHolder(candidate.def, candidate.holder);
            if (holder === null) continue;
            if (!allows(candidate.def, candidate.attr)) {
                reason = 'mode';
                continue;
            }
            const edit: Edit = {
                mechanicId: candidate.def.id,
                holder,
                attribute: candidate.attr.id,
                op: item.op,
                value: item.value,
            };
            if (item.reason) edit.reason = item.reason;
            edits.push(edit);
            done = true;
            break;
        }
        if (!done) rejected.push({ item, reason });
    }
    return { edits, rejected };
}

/* ------------------------------------------------------------------ the instruction */

function bounds(attr: AttributeDef): string {
    if (attr.min !== undefined && attr.max !== undefined) return ` ${attr.min}-${attr.max}`;
    if (attr.min !== undefined) return ` from ${attr.min}`;
    if (attr.max !== undefined) return ` up to ${attr.max}`;
    return '';
}

/** One attribute for the model: "Mana: number 0-100", "Attitude: scale hostile < cold < neutral". */
export function describeForModel(attr: AttributeDef): string {
    const name = attr.promptName || attr.id;
    switch (attr.kind) {
        case 'number':
            return `${name}: number${bounds(attr)}`;
        case 'scale':
            return `${name}: scale ${(attr.levels ?? []).join(' < ')}`;
        case 'list': {
            const options = attr.options?.length ? ` (${attr.options.join(', ')})` : '';
            return `${name}: list${options}, ${attr.multi ? 'several at once' : 'one at a time'}`;
        }
        default:
            return `${name}: short text`;
    }
}

function exampleLine(holder: string, attr: AttributeDef): string {
    const name = attr.promptName || attr.id;
    switch (attr.kind) {
        case 'number':
            return `${holder}.${name}: -2`;
        case 'scale': {
            const levels = attr.levels ?? [];
            return `${holder}.${name} = ${levels[Math.floor(levels.length / 2)] ?? 'level'}`;
        }
        case 'list':
            return attr.multi
                ? `${holder}.${name} += ${attr.options?.[0] ?? 'option'}`
                : `${holder}.${name} = ${attr.options?.[0] ?? 'option'}`;
        default:
            return `${holder}.${name} = short text`;
    }
}

/**
 * English instruction for the 'block' attributes of the mechanics in the scene: the format, the holders and the
 * attributes. '' when no mechanic in the scene uses the block.
 */
export function blockInstruction(
    defs: readonly MechanicDef[],
    holdersByMechanic: Readonly<Record<string, readonly string[]>>,
): string {
    const groups: string[] = [];
    let example = '';
    for (const def of defs) {
        const attributes = def.attributes.filter((attr) => trackingOf(def, attr) === 'block');
        const holders = (holdersByMechanic[def.id] ?? []).filter((holder) => holder.trim());
        if (!attributes.length || !holders.length) continue;
        const first = attributes[0];
        if (!example && first) example = exampleLine(holders[0] ?? 'Holder', first);
        groups.push(
            [`Holders: ${holders.join(', ')}`, ...attributes.map((attr) => `- ${describeForModel(attr)}`)].join('\n'),
        );
    }
    if (!groups.length) return '';
    return [
        '[Mechanics block] At the very end of your reply, after the story, list every change this reply makes to the values below in a service block (leave the block out when nothing changed):',
        '<mechanics>',
        example,
        '</mechanics>',
        'One change per line: Holder.attribute: +N or -N changes a number; Holder.attribute = value sets a value (a number, a level of a scale, an option of a list, a text); Holder.attribute += option / -= option adds or removes an option of a list. Use the holder and attribute names exactly as listed. Write nothing else inside the block; the reader never sees it.',
        ...groups,
    ].join('\n');
}
