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
import { difficultyWord } from './mechanics-checks';
import { trackingOf } from './mechanics-defs';
import type { AttributeDef, MechanicDef, StatusDuration } from './mechanics-defs';
import type { DifficultyLevel, RollMode } from './mechanics-dice';
import { findAttribute, nameKey, toNumber } from './mechanics-state';
import type { Edit, EditOp } from './mechanics-state';
import { parseDurationText } from './mechanics-status';
import { resolveVisibility } from './mechanics-visibility';

/**
 * One parsed line of a block. `attribute` is '' when the line had no `Holder.attribute` dot. Statuses, items and
 * equipment use the attributes 'status', 'items', 'equip' and 'wear' with the raw text as the value.
 */
export interface BlockItem {
    holder: string;
    attribute: string;
    op: EditOp;
    value: string | number;
    reason?: string;
    /** The line as written (trimmed). */
    line: string;
}

/** `roll: Stealth Kai vs Guard.Perception adv hard` — the model asks Maestro for a check. */
export interface BlockRoll {
    /** The check and (maybe) who rolls, as written («Stealth Kai», "Kai's Stealth"). */
    head: string;
    /** The other side of an opposed check. */
    vs?: { holder: string; check?: string };
    mode?: RollMode;
    level?: DifficultyLevel;
    difficulty?: number;
    line: string;
}

export type CombatAction = 'start' | 'end' | 'enemy' | 'out';

/** `combat: start`, `combat: enemy Bandit hp=20`, `combat: out Bandit`, `combat: end`. */
export interface BlockCombat {
    action: CombatAction;
    names: string[];
    /** Starting values of an enemy (`hp=20 armor=12`). */
    stats?: Record<string, number>;
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
    rolls: BlockRoll[];
    combat: BlockCombat[];
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

/** A line that is surely a block line (outside the tags): `Holder.attribute …`, an explicit change, a roll or a fight. */
function strictLine(line: string): boolean {
    if (parseRollLine(line) || parseCombatLine(line)) return true;
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

const SPECIAL_ATTRIBUTES: Record<string, 'status' | 'items' | 'equip' | 'wear'> = {
    status: 'status',
    statuses: 'status',
    condition: 'status',
    conditions: 'status',
    состояние: 'status',
    состояния: 'status',
    статус: 'status',
    статусы: 'status',
    эффект: 'status',
    эффекты: 'status',
    items: 'items',
    item: 'items',
    inventory: 'items',
    inv: 'items',
    предметы: 'items',
    предмет: 'items',
    инвентарь: 'items',
    вещи: 'items',
    equip: 'equip',
    equipped: 'equip',
    hand: 'equip',
    hands: 'equip',
    'в руках': 'equip',
    wear: 'wear',
    wears: 'wear',
    worn: 'wear',
    надето: 'wear',
};

/** 'status' / 'items' / 'equip' / 'wear' for the pseudo attributes of statuses and inventories. */
export function specialAttribute(attribute: string): 'status' | 'items' | 'equip' | 'wear' | null {
    return SPECIAL_ATTRIBUTES[nameKey(attribute)] ?? null;
}

/** A trailing note after `#`, `//` or a dash (parentheses stay in the value). */
function splitNote(right: string): { value: string; reason?: string } {
    const value = right.trim();
    const separator = /\s+(?:#|\/\/|—|–|--)\s+/.exec(value);
    if (separator && separator.index > 0) {
        const reason = value.slice(separator.index + separator[0].length).trim();
        const head = value.slice(0, separator.index).trim();
        return reason ? { value: head, reason } : { value: head };
    }
    return { value };
}

/** "rope x2", '"rope" ×2', "2 rope", "rope (2)" → name and quantity (1 by default). */
export function parseItemText(raw: string): { name: string; qty: number; slot?: 'hand' | 'worn' } {
    let text = String(raw ?? '').trim();
    let slot: 'hand' | 'worn' | undefined;
    const slotMatch = /\s*\((?:in hand|hand|в руках|в руке|worn|wear|надет[оаы]?)\)\s*$/i.exec(text);
    if (slotMatch) {
        slot = /hand|рук/i.test(slotMatch[0]) ? 'hand' : 'worn';
        text = text.slice(0, slotMatch.index).trim();
    }
    let qty = 1;
    const tail = /\s*(?:[x×*]\s*(\d+(?:[.,]\d+)?)|\((\d+(?:[.,]\d+)?)\))\s*$/i.exec(text);
    const head = /^(\d+(?:[.,]\d+)?)(?:\s*[x×*]\s*|\s+)(?=\S)/i.exec(text);
    if (tail && tail.index > 0) {
        qty = toNumber(tail[1] ?? tail[2]) ?? 1;
        text = text.slice(0, tail.index);
    } else if (head && head[0].length < text.length) {
        qty = toNumber(head[1]) ?? 1;
        text = text.slice(head[0].length);
    }
    const name = text.replace(/^["'«»“”`]+|["'«»“”`]+$/g, '').trim();
    return slot ? { name, qty, slot } : { name, qty };
}

/** «Отравлен (3 хода)», "Poisoned 3 turns", "Blessed (until sunset)" → name, duration and the duration as written. */
export function parseStatusText(raw: string): { name: string; duration: StatusDuration | null; durationText?: string } {
    const text = String(raw ?? '').trim();
    const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text);
    if (paren?.[1]) {
        const name = cleanName(paren[1]);
        const words = (paren[2] ?? '').trim();
        return { name, duration: parseDurationText(words), ...(words ? { durationText: words } : {}) };
    }
    const trailing = /^(.*?)\s+(?:for\s+|на\s+)?(\d+\s*[a-zа-яё]+(?:\s+\d+\s*[a-zа-яё]+)?)\s*$/i.exec(text);
    if (trailing?.[1]) {
        const duration = parseDurationText(trailing[2] ?? '');
        if (duration) {
            return {
                name: cleanName(trailing[1]),
                duration,
                durationText: (trailing[2] ?? '').trim(),
            };
        }
    }
    return { name: cleanName(text), duration: null };
}

/** A name without quotes and stray brackets around it. */
function cleanName(text: string): string {
    return text.replace(/^[\s"'«»“”`()[\]]+|[\s"'«»“”`()[\]]+$/g, '').trim();
}

const ROLL_RE = /^(?:roll|check|проверка|бросок)\s*[:\-—]\s*(.+)$/i;
const VS_RE = /\s+(?:vs\.?|versus|против)\s+/i;
const ADV_RE = /(?:^|\s)(?:with\s+advantage|advantage|adv|с\s+преимуществом|преимущество)(?=\s|$)/i;
const DIS_RE = /(?:^|\s)(?:with\s+disadvantage|disadvantage|dis|с\s+помехой|помеха)(?=\s|$)/i;
const DC_RE = /(?:^|\s)(?:dc|сл|сложность|difficulty)\s*[:=]?\s*(\d{1,3})(?=\s|$)/i;
const LEVEL_WORDS =
    /(?:^|\s)(very\s+hard|very\s+difficult|easy|normal|hard|difficult|очень\s+трудн\S*|очень\s+сложн\S*|легк\S*|трудн\S*|сложн\S*)(?=\s|$)/i;

/** `roll: <check> [who] [vs <who>.<check>] [adv|dis] [easy|hard|DC 15]`; null when the line is not a roll. */
export function parseRollLine(raw: string): BlockRoll | null {
    const line = String(raw ?? '')
        .trim()
        .replace(/^(?:[-*•·]|\d+[.)])\s+/, '');
    const match = ROLL_RE.exec(line);
    if (!match?.[1]) return null;
    let text = ` ${match[1].trim()} `;
    const roll: BlockRoll = { head: '', line };
    if (ADV_RE.test(text)) {
        roll.mode = 'adv';
        text = text.replace(ADV_RE, ' ');
    } else if (DIS_RE.test(text)) {
        roll.mode = 'dis';
        text = text.replace(DIS_RE, ' ');
    }
    const dc = DC_RE.exec(text);
    if (dc?.[1]) {
        roll.difficulty = Number(dc[1]);
        text = text.replace(DC_RE, ' ');
    }
    const level = LEVEL_WORDS.exec(text);
    if (level?.[1]) {
        const parsed = difficultyWord(level[1]);
        if (parsed) roll.level = parsed;
        text = text.replace(LEVEL_WORDS, ' ');
    }
    const parts = text.split(VS_RE);
    const clean = (part: string | undefined) =>
        (part ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[.,;:]+$/g, '')
            .trim();
    roll.head = clean(parts[0]);
    const other = clean(parts[1]);
    if (other) {
        const dot = other.lastIndexOf('.');
        const possessive = /^(.+?)['’]s\s+(.+)$/i.exec(other);
        if (dot > 0 && dot < other.length - 1) {
            roll.vs = { holder: other.slice(0, dot).trim(), check: other.slice(dot + 1).trim() };
        } else if (possessive?.[1] && possessive[2]) {
            roll.vs = { holder: possessive[1].trim(), check: possessive[2].trim() };
        } else roll.vs = { holder: other };
    }
    return roll.head ? roll : null;
}

const COMBAT_RE = /^(?:combat|fight|battle|бой|битва|схватка)\s*[:\-—]\s*(.+)$/i;
const COMBAT_ACTIONS: { action: CombatAction; re: RegExp }[] = [
    { action: 'start', re: /^(?:start|begin|starts|begins|начало|начать|начинается|старт)(?=[\s,:]|$)\s*[:,]?\s*/i },
    {
        action: 'end',
        re: /^(?:end|ends|over|stop|finish|конец|закончен|окончен|завершён|завершен)(?=[\s,:]|$)\s*[:,]?\s*/i,
    },
    {
        action: 'enemy',
        re: /^(?:enemy|enemies|foe|adds?|join|joins|враг|враги|противник|противники)(?=[\s,:]|$)\s*[:,]?\s*/i,
    },
    {
        action: 'out',
        re: /^(?:out|down|defeated|dead|fled|выбыл|выбыла|повержен|повержена|убит|убита|сбежал)(?=[\s,:]|$)\s*[:,]?\s*/i,
    },
];

/** `combat: start [Bandit, Wolf]` / `end` / `enemy Bandit hp=20 armor=12` / `out Bandit`; null otherwise. */
export function parseCombatLine(raw: string): BlockCombat | null {
    const line = String(raw ?? '')
        .trim()
        .replace(/^(?:[-*•·]|\d+[.)])\s+/, '');
    const match = COMBAT_RE.exec(line);
    if (!match?.[1]) return null;
    let rest = match[1].trim();
    const found = COMBAT_ACTIONS.find((item) => item.re.test(rest));
    if (!found) return null;
    rest = rest.replace(found.re, '').trim();
    const stats: Record<string, number> = {};
    rest = rest
        .replace(/([a-zа-яё_][\wа-яё]*)\s*[=:]\s*(-?\d+(?:[.,]\d+)?)/gi, (_all, name: string, value: string) => {
            const number = toNumber(value);
            if (number !== null) stats[name.toLowerCase()] = number;
            return ' ';
        })
        .replace(/[()]/g, ' ');
    const names = rest
        .split(/\s*(?:,|;|\band\b|\bи\b)\s*/i)
        .map((name) =>
            name
                .replace(/^["'«»“”`]+|["'«»“”`]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim(),
        )
        .filter((name) => name && !/^(?:with|vs|против)$/i.test(name));
    const combat: BlockCombat = { action: found.action, names, line };
    if (Object.keys(stats).length) combat.stats = stats;
    return combat;
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
    const special = specialAttribute(attribute);
    if (special) {
        // The parentheses belong to the value here: «Отравлен (3 хода)», "sword (hand)".
        const { value, reason } = splitNote(right);
        if (!value) return null;
        const specialOp: EditOp = op === '-=' ? 'sub' : op === '+=' ? 'add' : 'set';
        const item: BlockItem = { holder, attribute: special, op: specialOp, value, line };
        if (reason) item.reason = reason;
        return item;
    }
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
    const result: ParsedBlock = { found: false, items: [], repaired: [], dropped: [], rolls: [], combat: [] };
    if (!hasBlockMarker(source)) return result;
    const repaired = new Set<string>();
    const spans = blockSpans(source, repaired);
    result.found = spans.length > 0;
    for (const span of spans) {
        for (const line of source.slice(span.bodyStart, span.bodyEnd).split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || /^```[\w-]*$/.test(trimmed)) continue;
            const roll = parseRollLine(trimmed);
            if (roll) {
                result.rolls.push(roll);
                continue;
            }
            const combat = parseCombatLine(trimmed);
            if (combat) {
                result.combat.push(combat);
                continue;
            }
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
    /** Attributes the block may change for a holder (default: tracking 'block', known to the model). */
    allows?: (def: MechanicDef, attr: AttributeDef, holder: string) => boolean;
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

/** A status the block applies or removes. */
export interface BlockStatusEdit {
    mechanicId: string;
    holder: string;
    op: 'add' | 'remove';
    name: string;
    duration: StatusDuration | null;
    /** The duration as written (a phrase like «до заката» is placed in story time by the calendar). */
    durationText?: string;
    reason?: string;
}

/** An item the block gives, takes or puts on / in hand. */
export interface BlockItemEdit {
    mechanicId: string;
    holder: string;
    op: 'give' | 'take' | 'equip';
    name: string;
    qty: number;
    slot?: 'hand' | 'worn' | null;
    reason?: string;
}

export interface ResolvedBlock {
    edits: Edit[];
    statuses: BlockStatusEdit[];
    inventory: BlockItemEdit[];
    rejected: { item: BlockItem; reason: BlockRejectReason }[];
}

/** The first mechanic with that part (statuses / inventory) that has the holder, and the holder's name. */
function partOwner(
    defs: readonly MechanicDef[],
    has: (def: MechanicDef) => boolean,
    raw: string,
    options: BlockResolveOptions,
): { def: MechanicDef; holder: string } | 'mode' | 'holder' {
    const owners = defs.filter(has);
    if (!owners.length) return 'mode';
    for (const def of owners) {
        const holder = options.resolveHolder(def, raw);
        if (holder) return { def, holder };
    }
    return 'holder';
}

function resolveSpecial(
    item: BlockItem,
    defs: readonly MechanicDef[],
    options: BlockResolveOptions,
    out: ResolvedBlock,
): void {
    const text = String(item.value);
    if (item.attribute === 'status') {
        const owner = partOwner(defs, (def) => def.statuses !== undefined, item.holder, options);
        if (typeof owner === 'string') {
            out.rejected.push({ item, reason: owner });
            return;
        }
        const parsed = parseStatusText(text);
        if (!parsed.name) {
            out.rejected.push({ item, reason: 'attribute' });
            return;
        }
        const edit: BlockStatusEdit = {
            mechanicId: owner.def.id,
            holder: owner.holder,
            op: item.op === 'sub' ? 'remove' : 'add',
            name: parsed.name,
            duration: parsed.duration,
        };
        if (parsed.durationText) edit.durationText = parsed.durationText;
        if (item.reason) edit.reason = item.reason;
        out.statuses.push(edit);
        return;
    }
    const owner = partOwner(defs, (def) => def.inventory !== undefined, item.holder, options);
    if (typeof owner === 'string') {
        out.rejected.push({ item, reason: owner });
        return;
    }
    const parsed = parseItemText(text);
    if (!parsed.name) {
        out.rejected.push({ item, reason: 'attribute' });
        return;
    }
    const base = { mechanicId: owner.def.id, holder: owner.holder, name: parsed.name, qty: parsed.qty };
    let edit: BlockItemEdit;
    if (item.attribute === 'items') {
        edit = { ...base, op: item.op === 'sub' ? 'take' : 'give' };
        if (parsed.slot && edit.op === 'give') edit.slot = parsed.slot;
    } else {
        edit = { ...base, op: 'equip', slot: item.op === 'sub' ? null : item.attribute === 'wear' ? 'worn' : 'hand' };
    }
    if (item.reason) edit.reason = item.reason;
    out.inventory.push(edit);
}

/**
 * Block lines → edits of the given mechanics (the holder decides between attributes of the same name); statuses and
 * items go to the mechanics that keep them. Attributes the model is not told about (prompt 'none') are not its to
 * change.
 */
export function resolveBlock(
    items: readonly BlockItem[],
    defs: readonly MechanicDef[],
    options: BlockResolveOptions,
): ResolvedBlock {
    const allows =
        options.allows ??
        ((def: MechanicDef, attr: AttributeDef) =>
            trackingOf(def, attr) === 'block' && !attr.formula && resolveVisibility(def, attr).prompt !== 'none');
    const out: ResolvedBlock = { edits: [], statuses: [], inventory: [], rejected: [] };
    const { edits, rejected } = out;
    for (const item of items) {
        if (specialAttribute(item.attribute) && !defs.some((def) => findAttribute(def, item.attribute))) {
            resolveSpecial({ ...item, attribute: specialAttribute(item.attribute) as string }, defs, options, out);
            continue;
        }
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
            if (!allows(candidate.def, candidate.attr, holder)) {
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
    return out;
}

/** A check to roll: its mechanic, its names (id, display, English, `mechanic.check`). */
export interface RollCheckRef {
    mechanicId: string;
    checkId: string;
    names: readonly string[];
}

/**
 * The check and the actor of a roll request: the longest run of words at the start (or the end) of the head that is
 * a check name; the rest, without a possessive, is the actor ('' when none).
 */
export function resolveRollHead(
    head: string,
    checks: readonly RollCheckRef[],
): { check: RollCheckRef; actor: string } | null {
    const words = head
        .replace(/['’]s\b/gi, '')
        .split(/\s+/)
        .filter(Boolean);
    const named = (text: string) => {
        const key = nameKey(text.replace(/[.,:;]+$/g, ''));
        return key ? (checks.find((check) => check.names.some((name) => nameKey(name) === key)) ?? null) : null;
    };
    for (let count = words.length; count >= 1; count--) {
        const front = named(words.slice(0, count).join(' '));
        if (front) return { check: front, actor: words.slice(count).join(' ').trim() };
        const back = named(words.slice(words.length - count).join(' '));
        if (back)
            return {
                check: back,
                actor: words
                    .slice(0, words.length - count)
                    .join(' ')
                    .trim(),
            };
    }
    return null;
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

/** What else the block may carry besides values. */
export interface BlockInstructionOptions {
    /** Names of the checks the model may ask Maestro to roll (`roll: …`); none → no roll line. */
    checks?: readonly string[];
    /** Fights are run by a mechanic in the scene. */
    combat?: boolean;
    /** Attributes the block tracks for the persona only (DES does not list the user's character). */
    persona?: { name: string; attributes: (def: MechanicDef) => AttributeDef[] };
}

/** The attributes the block tracks: block tracking, stored, and known to the model. */
function blockAttributes(def: MechanicDef): AttributeDef[] {
    return def.attributes.filter(
        (attr) => trackingOf(def, attr) === 'block' && !attr.formula && resolveVisibility(def, attr).prompt !== 'none',
    );
}

/**
 * English instruction for the 'block' attributes of the mechanics in the scene: the format, the holders and the
 * attributes; statuses and items of the mechanics that keep them (with block tracking); roll requests and fights when
 * given. '' when there is nothing the block could carry.
 */
export function blockInstruction(
    defs: readonly MechanicDef[],
    holdersByMechanic: Readonly<Record<string, readonly string[]>>,
    options: BlockInstructionOptions = {},
): string {
    const groups: string[] = [];
    let example = '';
    let statuses = '';
    let items = '';
    let someone = '';
    for (const def of defs) {
        const holders = (holdersByMechanic[def.id] ?? []).filter((holder) => holder.trim());
        // A secret mechanic is Maestro's alone: the model is told nothing about it.
        if (!holders.length || resolveVisibility(def).prompt === 'none') continue;
        someone ||= holders.find((holder) => holder !== 'world') ?? '';
        const attributes = blockAttributes(def);
        if (attributes.length) {
            const first = attributes[0];
            if (!example && first) example = exampleLine(holders[0] ?? 'Holder', first);
            groups.push(
                [`Holders: ${holders.join(', ')}`, ...attributes.map((attr) => `- ${describeForModel(attr)}`)].join(
                    '\n',
                ),
            );
        }
        const persona = options.persona;
        if (persona && holders.some((holder) => nameKey(holder) === nameKey(persona.name))) {
            const own = persona.attributes(def).filter((attr) => !attributes.includes(attr));
            if (own.length) {
                if (!example && own[0]) example = exampleLine(persona.name, own[0]);
                groups.push(
                    [`Holders: ${persona.name}`, ...own.map((attr) => `- ${describeForModel(attr)}`)].join('\n'),
                );
            }
        }
        if (def.tracking === 'block') {
            if (def.statuses !== undefined && !statuses) statuses = holders[0] ?? '';
            if (def.inventory !== undefined && !items) items = holders[0] ?? '';
        }
    }
    const checks = (options.checks ?? []).filter((name) => name.trim());
    if (!groups.length && !statuses && !items && !checks.length && !options.combat) return '';
    if (!example && statuses) example = `${statuses}.status += Poisoned (3 turns)`;
    if (!example && items) example = `${items}.items += rope x2`;
    if (!example && checks.length) example = `roll: ${checks[0]} ${someone || 'Holder'}`;
    if (!example && options.combat) example = 'combat: start';
    const changes = groups.length > 0 || !!statuses || !!items;
    const lines = changes
        ? [
              '[Mechanics block] At the very end of your reply, after the story, list every change this reply makes to the values below in a service block (leave the block out when nothing changed):',
              '<mechanics>',
              example,
              '</mechanics>',
              'One change per line: Holder.attribute: +N or -N changes a number; Holder.attribute = value sets a value (a number, a level of a scale, an option of a list, a text); Holder.attribute += option / -= option adds or removes an option of a list. Use the holder and attribute names exactly as listed. Write nothing else inside the block; the reader never sees it.',
          ]
        : [
              '[Mechanics block] When the story needs it, end your reply with a service block (the reader never sees it):',
              '<mechanics>',
              example,
              '</mechanics>',
          ];
    if (statuses) {
        lines.push(
            'Conditions: Holder.status += Poisoned (3 turns) puts a condition on someone (say how long: turns, hours, days, or until when); Holder.status -= Poisoned ends it.',
        );
    }
    if (items) {
        lines.push(
            'Items: Holder.items += rope x2 gives, Holder.items -= coin x5 takes away; Holder.equip += sword puts it in hand, Holder.wear += cloak puts it on.',
        );
    }
    if (checks.length) {
        lines.push(
            `Rolls: when the outcome of a risky action is uncertain, do not decide it — write roll: <check> <who> (optionally vs <other>.<check>, adv or dis, easy or hard) and stop before the outcome; Maestro rolls and gives you the result next turn. Checks: ${checks.join(', ')}.`,
        );
    }
    if (options.combat) {
        lines.push(
            'Fights: combat: start (with combat: enemy <name> for each foe), combat: out <name> when someone is down or flees, combat: end when it is over.',
        );
    }
    return [...lines, ...groups].join('\n');
}
