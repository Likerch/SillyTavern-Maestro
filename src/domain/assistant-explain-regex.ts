// The assistant's regex explainer (M33, stage 13: «что делает этот регекс?»), pure: a JavaScript regular expression
// (ST regex scripts and lorebook regex keys are JS regexes) is parsed into a small tree and told in plain English or
// Russian — literal text, classes, quantifiers, groups, anchors, look-arounds, back-references and flags — with the
// pitfalls that matter for Russian chats: `\w` and `\b` know only Latin letters, `[А-я]` misses Ё, no `g` replaces
// only the first match, nested repetition can hang. The syntax is checked by the engine itself first (new RegExp), so
// the parser may assume a valid pattern.

export type ExplainLocale = 'en' | 'ru';

type GroupKind = 'capture' | 'named' | 'plain' | 'ahead' | 'notAhead' | 'behind' | 'notBehind';

type ClassItem =
    | { t: 'char'; value: string; label?: string }
    | { t: 'range'; from: string; to: string }
    | { t: 'escape'; code: string }
    | { t: 'prop'; negate: boolean; name: string };

type RegexNode =
    | { t: 'text'; value: string }
    | { t: 'char'; value: string; label: string }
    | { t: 'any' }
    | { t: 'class'; negate: boolean; items: ClassItem[] }
    | { t: 'escape'; code: string }
    | { t: 'prop'; negate: boolean; name: string }
    | { t: 'anchor'; kind: 'start' | 'end' | 'boundary' | 'notBoundary' }
    | { t: 'group'; kind: GroupKind; index?: number; name?: string; alts: RegexNode[][] }
    | { t: 'backref'; ref: number | string }
    | { t: 'repeat'; node: RegexNode; min: number; max: number | null; lazy: boolean };

export type RegexWarning =
    | 'latinOnly'
    | 'noGlobal'
    | 'nestedRepeat'
    | 'greedyDot'
    | 'propWithoutUnicode'
    | 'cyrillicRangeYo'
    | 'emptyAlternative';

export interface RegexGroupInfo {
    index: number;
    name?: string;
    /** What the group matches, in the requested language. */
    matches: string;
}

export interface RegexExplanation {
    ok: boolean;
    /** The engine's syntax error when the pattern does not compile. */
    error?: string;
    pattern: string;
    flags: string;
    /** The whole pattern in words (cut to `maxChars`). */
    summary: string;
    groups: RegexGroupInfo[];
    /** One line per flag. */
    flagNotes: string[];
    warnings: { code: RegexWarning; text: string }[];
}

export interface ExplainOptions {
    /** Cap of the summary (default 700 characters). */
    maxChars?: number;
    /** Nesting depth told in full; deeper groups become «…» (default 4). */
    maxDepth?: number;
}

/* ------------------------------------------------------------------ input */

/**
 * A pattern as the user or a script writes it: `/source/flags` (ST's `regexFromString` form) or a bare source with
 * separate flags. The explicit `flags` argument wins over the slashes' flags.
 */
export function splitPattern(input: string, flags?: string): { source: string; flags: string } {
    const slashed = /^\/([\s\S]+)\/([a-zA-Z]*)$/.exec(input);
    if (slashed) return { source: slashed[1] ?? '', flags: flags ?? slashed[2] ?? '' };
    return { source: input, flags: flags ?? '' };
}

/* ------------------------------------------------------------------ parser */

class Parser {
    private pos = 0;
    groupCount = 0;
    readonly emptyAlternative: { value: boolean } = { value: false };

    constructor(
        private readonly src: string,
        private readonly unicode: boolean,
    ) {}

    parse(): RegexNode[][] {
        return this.alternatives();
    }

    private peek(offset = 0): string {
        return this.src[this.pos + offset] ?? '';
    }

    /** One code point (surrogate pairs kept together in unicode mode and outside it alike, for display). */
    private take(): string {
        const code = this.src.codePointAt(this.pos);
        if (code === undefined) return '';
        const char = String.fromCodePoint(code);
        this.pos += char.length;
        return char;
    }

    private alternatives(): RegexNode[][] {
        const alts: RegexNode[][] = [this.sequence()];
        while (this.peek() === '|') {
            this.pos += 1;
            alts.push(this.sequence());
        }
        if (alts.length > 1 && alts.some((alt) => alt.length === 0)) this.emptyAlternative.value = true;
        return alts;
    }

    private sequence(): RegexNode[] {
        const nodes: RegexNode[] = [];
        while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
            const atom = this.atom();
            const node = this.quantified(atom);
            const last = nodes[nodes.length - 1];
            // Adjacent plain characters read as one piece of text («the text "abc"»).
            if (node.t === 'text' && last?.t === 'text') last.value += node.value;
            else nodes.push(node);
        }
        return nodes;
    }

    private quantified(atom: RegexNode): RegexNode {
        let min: number;
        let max: number | null;
        const char = this.peek();
        if (char === '*' || char === '+' || char === '?') {
            this.pos += 1;
            min = char === '+' ? 1 : 0;
            max = char === '?' ? 1 : null;
        } else if (char === '{') {
            const braces = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.pos));
            if (!braces) return atom;
            this.pos += braces[0].length;
            min = Number(braces[1]);
            max = braces[2] === undefined ? min : braces[3] ? Number(braces[3]) : null;
        } else {
            return atom;
        }
        const lazy = this.peek() === '?';
        if (lazy) this.pos += 1;
        // Atoms are single characters here (runs are merged after quantifiers), so `abc+` repeats only the «c».
        return { t: 'repeat', node: atom, min, max, lazy };
    }

    private atom(): RegexNode {
        const char = this.take();
        switch (char) {
            case '^':
                return { t: 'anchor', kind: 'start' };
            case '$':
                return { t: 'anchor', kind: 'end' };
            case '.':
                return { t: 'any' };
            case '(':
                return this.group();
            case '[':
                return this.charClass();
            case '\\':
                return this.escape();
            default:
                return { t: 'text', value: char };
        }
    }

    private group(): RegexNode {
        let kind: GroupKind = 'capture';
        let name: string | undefined;
        if (this.peek() === '?') {
            const rest = this.src.slice(this.pos + 1);
            const named = /^<([^>=!]+)>/.exec(rest);
            if (rest.startsWith(':')) {
                kind = 'plain';
                this.pos += 2;
            } else if (rest.startsWith('=')) {
                kind = 'ahead';
                this.pos += 2;
            } else if (rest.startsWith('!')) {
                kind = 'notAhead';
                this.pos += 2;
            } else if (rest.startsWith('<=')) {
                kind = 'behind';
                this.pos += 3;
            } else if (rest.startsWith('<!')) {
                kind = 'notBehind';
                this.pos += 3;
            } else if (named) {
                kind = 'named';
                name = named[1];
                this.pos += 1 + named[0].length;
            } else {
                // Modifier groups `(?i:…)` (ES2025): a plain group for our purposes.
                const modifiers = /^[-ims]*:/.exec(rest);
                kind = 'plain';
                this.pos += 1 + (modifiers ? modifiers[0].length : 0);
            }
        }
        let index: number | undefined;
        if (kind === 'capture' || kind === 'named') index = ++this.groupCount;
        const alts = this.alternatives();
        if (this.peek() === ')') this.pos += 1;
        const node: RegexNode = { t: 'group', kind, alts };
        if (index !== undefined) node.index = index;
        if (name !== undefined) node.name = name;
        return node;
    }

    private charClass(): RegexNode {
        let negate = false;
        if (this.peek() === '^') {
            negate = true;
            this.pos += 1;
        }
        const items: ClassItem[] = [];
        // In JavaScript `]` right after `[` closes the class (`[]` matches nothing).
        while (this.pos < this.src.length && this.peek() !== ']') {
            const item = this.classAtom();
            if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== '' && item.t === 'char') {
                this.pos += 1;
                const to = this.classAtom();
                if (to.t === 'char') {
                    items.push({ t: 'range', from: item.value, to: to.value });
                    continue;
                }
                items.push(item, { t: 'char', value: '-' }, to);
                continue;
            }
            items.push(item);
        }
        if (this.peek() === ']') this.pos += 1;
        return { t: 'class', negate, items };
    }

    private classAtom(): ClassItem {
        const char = this.take();
        if (char !== '\\') return { t: 'char', value: char };
        const next = this.peek();
        if (next === 'b') {
            this.pos += 1;
            return { t: 'char', value: '\b', label: 'backspace' };
        }
        const node = this.escape();
        if (node.t === 'escape') return { t: 'escape', code: node.code };
        if (node.t === 'prop') return { t: 'prop', negate: node.negate, name: node.name };
        if (node.t === 'char') return { t: 'char', value: node.value, label: node.label };
        if (node.t === 'text') return { t: 'char', value: node.value };
        // Back-references and anchors do not exist inside a class; treat the letter literally.
        return { t: 'char', value: next };
    }

    private escape(): RegexNode {
        const char = this.take();
        switch (char) {
            case 'd':
            case 'D':
            case 'w':
            case 'W':
            case 's':
            case 'S':
                return { t: 'escape', code: char };
            case 'b':
                return { t: 'anchor', kind: 'boundary' };
            case 'B':
                return { t: 'anchor', kind: 'notBoundary' };
            case 'n':
                return { t: 'char', value: '\n', label: 'newline' };
            case 'r':
                return { t: 'char', value: '\r', label: 'return' };
            case 't':
                return { t: 'char', value: '\t', label: 'tab' };
            case 'v':
                return { t: 'char', value: '\v', label: 'vtab' };
            case 'f':
                return { t: 'char', value: '\f', label: 'formfeed' };
            case '0':
                return { t: 'char', value: '\0', label: 'nul' };
            case 'c': {
                const letter = this.take();
                return { t: 'char', value: letter, label: `ctrl-${letter.toUpperCase()}` };
            }
            case 'x': {
                const hex = /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.pos));
                if (!hex) return { t: 'text', value: 'x' };
                this.pos += 2;
                return codeChar(parseInt(hex[0], 16));
            }
            case 'u': {
                const rest = this.src.slice(this.pos);
                const braced = this.unicode ? /^\{([0-9a-fA-F]+)\}/.exec(rest) : null;
                if (braced) {
                    this.pos += braced[0].length;
                    return codeChar(parseInt(braced[1] ?? '0', 16));
                }
                const hex = /^[0-9a-fA-F]{4}/.exec(rest);
                if (!hex) return { t: 'text', value: 'u' };
                this.pos += 4;
                return codeChar(parseInt(hex[0], 16));
            }
            case 'p':
            case 'P': {
                const prop = this.unicode ? /^\{([^}]+)\}/.exec(this.src.slice(this.pos)) : null;
                if (!prop) return { t: 'text', value: char };
                this.pos += prop[0].length;
                return { t: 'prop', negate: char === 'P', name: prop[1] ?? '' };
            }
            case 'k': {
                const named = /^<([^>]+)>/.exec(this.src.slice(this.pos));
                if (!named) return { t: 'text', value: 'k' };
                this.pos += named[0].length;
                return { t: 'backref', ref: named[1] ?? '' };
            }
            default: {
                if (/[1-9]/.test(char)) {
                    let digits = char;
                    while (/[0-9]/.test(this.peek())) digits += this.take();
                    return { t: 'backref', ref: Number(digits) };
                }
                return { t: 'text', value: char };
            }
        }
    }
}

function codeChar(code: number): RegexNode {
    const value = String.fromCodePoint(code);
    return { t: 'char', value, label: `U+${code.toString(16).toUpperCase().padStart(4, '0')}` };
}

/* ------------------------------------------------------------------ words */

interface Words {
    text(value: string): string;
    char(value: string): string;
    any(dotAll: boolean): string;
    oneOf(items: string, negate: boolean): string;
    escape: Record<string, string>;
    anchor(kind: 'start' | 'end' | 'boundary' | 'notBoundary', multiline: boolean): string;
    label: Record<string, string>;
    prop(name: string, negate: boolean): string;
    group(kind: GroupKind, body: string, index?: number, name?: string): string;
    backref(ref: number | string): string;
    times(min: number, max: number | null, lazy: boolean): string;
    then: string;
    either(alts: string[]): string;
    nothing: string;
    flags: Record<string, string>;
    warnings: Record<RegexWarning, string>;
}

const QUOTE = {
    en: (value: string) => `"${value}"`,
    ru: (value: string) => `«${value}»`,
};

function visible(value: string): string {
    return value.length > 40 ? `${value.slice(0, 39)}…` : value;
}

const EN: Words = {
    text: (value) => (value.length === 1 ? QUOTE.en(value) : `the text ${QUOTE.en(visible(value))}`),
    char: (value) => QUOTE.en(value),
    any: (dotAll) => (dotAll ? 'any character' : 'any character except a line break'),
    oneOf: (items, negate) => (negate ? `any character except [${items}]` : `one of [${items}]`),
    escape: {
        d: 'a digit',
        D: 'a non-digit',
        w: 'a Latin letter, digit or _',
        W: 'a character other than a Latin letter, digit or _',
        s: 'a whitespace character',
        S: 'a non-whitespace character',
    },
    anchor: (kind, multiline) =>
        ({
            start: multiline ? 'the start of a line' : 'the start of the text',
            end: multiline ? 'the end of a line' : 'the end of the text',
            boundary: 'a word boundary',
            notBoundary: 'a place that is not a word boundary',
        })[kind],
    label: {
        newline: 'a line break',
        return: 'a carriage return',
        tab: 'a tab',
        vtab: 'a vertical tab',
        formfeed: 'a form feed',
        nul: 'a NUL character',
        backspace: 'a backspace',
    },
    prop: (name, negate) => {
        const known: Record<string, string> = {
            L: 'a letter of any alphabet',
            Letter: 'a letter of any alphabet',
            Lu: 'an uppercase letter',
            Ll: 'a lowercase letter',
            N: 'a number character',
            Nd: 'a digit of any script',
            P: 'a punctuation mark',
            S: 'a symbol',
            Z: 'a separator',
            Emoji: 'an emoji',
        };
        const script = /^(?:Script|sc|Script_Extensions|scx)=(\w+)$/.exec(name);
        const base = script
            ? `a ${script[1]} character`
            : (known[name] ?? `a character with the Unicode property ${name}`);
        return negate ? `not ${base}` : base;
    },
    group: (kind, body, index, name) => {
        switch (kind) {
            case 'capture':
                return `group ${index} (${body})`;
            case 'named':
                return `group ${index} "${name}" (${body})`;
            case 'ahead':
                return `followed by (${body})`;
            case 'notAhead':
                return `not followed by (${body})`;
            case 'behind':
                return `preceded by (${body})`;
            case 'notBehind':
                return `not preceded by (${body})`;
            default:
                return `(${body})`;
        }
    },
    backref: (ref) => (typeof ref === 'number' ? `the same text as group ${ref}` : `the same text as group "${ref}"`),
    times: (min, max, lazy) => {
        let words: string;
        if (min === 0 && max === 1) words = 'optional';
        else if (min === 0 && max === null) words = 'zero or more times';
        else if (min === 1 && max === null) words = 'one or more times';
        else if (max === null) words = `${min} or more times`;
        else if (min === max) words = `exactly ${min} ${min === 1 ? 'time' : 'times'}`;
        else words = `${min} to ${max} times`;
        return lazy ? `${words}, as few as possible` : words;
    },
    then: ', then ',
    either: (alts) => `either ${alts.join(', or ')}`,
    nothing: 'nothing (the empty string)',
    flags: {
        g: 'g — every match (without it only the first one)',
        i: 'i — upper and lower case are the same',
        m: 'm — ^ and $ match at every line',
        s: 's — . also matches line breaks',
        u: 'u — Unicode mode (\\p{…}, code points)',
        v: 'v — Unicode sets mode',
        y: 'y — sticky: matches only where the previous match ended',
        d: 'd — match indices are recorded',
    },
    warnings: {
        latinOnly:
            '\\w, \\W, \\b and \\B know only Latin letters, digits and _: Cyrillic letters are not word characters for them. Use [\\p{L}\\d_] with the u flag, or [А-Яа-яЁё].',
        noGlobal: 'No g flag: only the first match is found and replaced.',
        nestedRepeat:
            'Nested repetition like (a+)+ can take forever on a long text that almost matches (catastrophic backtracking).',
        greedyDot:
            'A greedy .* or .+ takes as much as it can (up to the last possible place); .*? stops at the first one.',
        propWithoutUnicode: '\\p{…} works only with the u (or v) flag; without it \\p is just the letter p.',
        cyrillicRangeYo: 'А-Я and а-я do not include Ё and ё: add them to the class.',
        emptyAlternative: 'One of the alternatives is empty, so the pattern can match the empty string.',
    },
};

const RU: Words = {
    text: (value) => (value.length === 1 ? QUOTE.ru(value) : `текст ${QUOTE.ru(visible(value))}`),
    char: (value) => QUOTE.ru(value),
    any: (dotAll) => (dotAll ? 'любой символ' : 'любой символ, кроме перевода строки'),
    oneOf: (items, negate) => (negate ? `любой символ, кроме [${items}]` : `один из [${items}]`),
    escape: {
        d: 'цифра',
        D: 'не цифра',
        w: 'латинская буква, цифра или _',
        W: 'символ, кроме латинской буквы, цифры и _',
        s: 'пробельный символ',
        S: 'непробельный символ',
    },
    anchor: (kind, multiline) =>
        ({
            start: multiline ? 'начало строки' : 'начало текста',
            end: multiline ? 'конец строки' : 'конец текста',
            boundary: 'граница слова',
            notBoundary: 'место, где нет границы слова',
        })[kind],
    label: {
        newline: 'перевод строки',
        return: 'возврат каретки',
        tab: 'табуляция',
        vtab: 'вертикальная табуляция',
        formfeed: 'перевод страницы',
        nul: 'символ NUL',
        backspace: 'символ backspace',
    },
    prop: (name, negate) => {
        const known: Record<string, string> = {
            L: 'буква любого алфавита',
            Letter: 'буква любого алфавита',
            Lu: 'заглавная буква',
            Ll: 'строчная буква',
            N: 'символ числа',
            Nd: 'цифра любой письменности',
            P: 'знак препинания',
            S: 'символ',
            Z: 'разделитель',
            Emoji: 'эмодзи',
        };
        const script = /^(?:Script|sc|Script_Extensions|scx)=(\w+)$/.exec(name);
        const base = script
            ? script[1] === 'Cyrillic'
                ? 'кириллический символ'
                : script[1] === 'Latin'
                  ? 'латинский символ'
                  : `символ письменности ${script[1]}`
            : (known[name] ?? `символ со свойством Юникода ${name}`);
        return negate ? `не ${base}` : base;
    },
    group: (kind, body, index, name) => {
        switch (kind) {
            case 'capture':
                return `группа ${index} (${body})`;
            case 'named':
                return `группа ${index} «${name}» (${body})`;
            case 'ahead':
                return `дальше идёт (${body})`;
            case 'notAhead':
                return `дальше не идёт (${body})`;
            case 'behind':
                return `перед этим (${body})`;
            case 'notBehind':
                return `перед этим не (${body})`;
            default:
                return `(${body})`;
        }
    },
    backref: (ref) =>
        typeof ref === 'number' ? `тот же текст, что в группе ${ref}` : `тот же текст, что в группе «${ref}»`,
    times: (min, max, lazy) => {
        let words: string;
        if (min === 0 && max === 1) words = 'необязательно';
        else if (min === 0 && max === null) words = 'ноль или больше раз';
        else if (min === 1 && max === null) words = 'один или больше раз';
        else if (max === null) words = `${min} или больше раз`;
        else if (min === max) words = `ровно ${min} ${plural(min, 'раз', 'раза', 'раз')}`;
        else words = `от ${min} до ${max} раз`;
        return lazy ? `${words}, как можно меньше` : words;
    },
    then: ', затем ',
    either: (alts) => `либо ${alts.join(', либо ')}`,
    nothing: 'ничего (пустая строка)',
    flags: {
        g: 'g — все совпадения (без него только первое)',
        i: 'i — заглавные и строчные буквы не различаются',
        m: 'm — ^ и $ срабатывают на каждой строке',
        s: 's — точка совпадает и с переводом строки',
        u: 'u — режим Юникода (\\p{…}, кодовые точки)',
        v: 'v — режим наборов Юникода',
        y: 'y — «липкий»: совпадение только там, где кончилось прошлое',
        d: 'd — запоминаются позиции совпадений',
    },
    warnings: {
        latinOnly:
            '\\w, \\W, \\b и \\B знают только латинские буквы, цифры и _: кириллица для них не буквы. Используй [\\p{L}\\d_] с флагом u или [А-Яа-яЁё].',
        noGlobal: 'Нет флага g: находится и заменяется только первое совпадение.',
        nestedRepeat:
            'Вложенное повторение вроде (a+)+ может «зависнуть» на длинном тексте, который почти подходит (катастрофический откат).',
        greedyDot:
            'Жадные .* и .+ забирают как можно больше (до последнего подходящего места); .*? остановится на первом.',
        propWithoutUnicode: '\\p{…} работает только с флагом u (или v); без него \\p — просто буква p.',
        cyrillicRangeYo: 'А-Я и а-я не включают Ё и ё: добавь их в класс.',
        emptyAlternative: 'Один из вариантов пустой, поэтому шаблон может совпасть с пустой строкой.',
    },
};

function plural(count: number, one: string, few: string, many: string): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

/* ------------------------------------------------------------------ describe */

interface DescribeState {
    words: Words;
    dotAll: boolean;
    multiline: boolean;
    maxDepth: number;
    groups: RegexGroupInfo[];
    warnings: Set<RegexWarning>;
}

function describeClassItem(item: ClassItem, state: DescribeState): string {
    switch (item.t) {
        case 'char':
            return item.label ? (state.words.label[item.label] ?? item.label) : state.words.char(item.value);
        case 'range':
            if (/[А-Яа-я]/.test(item.from + item.to) && (item.to === 'Я' || item.to === 'я')) {
                state.warnings.add('cyrillicRangeYo');
            }
            return `${item.from}–${item.to}`;
        case 'escape':
            if (item.code === 'w' || item.code === 'W') state.warnings.add('latinOnly');
            return state.words.escape[item.code] ?? item.code;
        case 'prop':
            return state.words.prop(item.name, item.negate);
    }
}

/** True when the class lists Ё/ё itself (so a А-Я range is complete). */
function classHasYo(items: readonly ClassItem[]): boolean {
    return items.some((item) => item.t === 'char' && (item.value === 'Ё' || item.value === 'ё'));
}

function hasUnboundedRepeat(nodes: readonly RegexNode[]): boolean {
    return nodes.some((node) => {
        if (node.t === 'repeat') return node.max === null || hasUnboundedRepeat([node.node]);
        if (node.t === 'group') return node.alts.some((alt) => hasUnboundedRepeat(alt));
        return false;
    });
}

function describeNode(node: RegexNode, state: DescribeState, depth: number): string {
    const { words } = state;
    switch (node.t) {
        case 'text':
            return words.text(node.value);
        case 'char':
            return words.label[node.label] ?? `${words.char(node.value)} (${node.label})`;
        case 'any':
            return words.any(state.dotAll);
        case 'class': {
            const before = state.warnings.has('cyrillicRangeYo');
            const items = node.items.map((item) => describeClassItem(item, state)).join(', ');
            if (!before && classHasYo(node.items)) state.warnings.delete('cyrillicRangeYo');
            return words.oneOf(items, node.negate);
        }
        case 'escape':
            if (node.code === 'w' || node.code === 'W') state.warnings.add('latinOnly');
            return words.escape[node.code] ?? node.code;
        case 'prop':
            return words.prop(node.name, node.negate);
        case 'anchor':
            if (node.kind === 'boundary' || node.kind === 'notBoundary') state.warnings.add('latinOnly');
            return words.anchor(node.kind, state.multiline);
        case 'backref':
            return words.backref(node.ref);
        case 'repeat': {
            const inner = node.node;
            if (inner.t === 'any' && node.max === null && !node.lazy) state.warnings.add('greedyDot');
            if (node.max === null && inner.t === 'group' && inner.alts.some((alt) => hasUnboundedRepeat(alt))) {
                state.warnings.add('nestedRepeat');
            }
            return `${describeNode(inner, state, depth)} [${words.times(node.min, node.max, node.lazy)}]`;
        }
        case 'group': {
            const body = depth >= state.maxDepth ? '…' : describeAlternatives(node.alts, state, depth + 1);
            if (node.index !== undefined) {
                const info: RegexGroupInfo = { index: node.index, matches: body };
                if (node.name !== undefined) info.name = node.name;
                state.groups.push(info);
            }
            // A plain group around one item reads better without brackets.
            if (node.kind === 'plain' && node.alts.length === 1) return body;
            return words.group(node.kind, body, node.index, node.name);
        }
    }
}

function describeSequence(nodes: readonly RegexNode[], state: DescribeState, depth: number): string {
    if (!nodes.length) return state.words.nothing;
    return nodes.map((node) => describeNode(node, state, depth)).join(state.words.then);
}

function describeAlternatives(alts: readonly RegexNode[][], state: DescribeState, depth: number): string {
    if (alts.length === 1) return describeSequence(alts[0] ?? [], state, depth);
    return state.words.either(alts.map((alt) => describeSequence(alt, state, depth)));
}

function cut(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Explains a JavaScript regex in plain words (English or Russian). */
export function explainRegex(
    source: string,
    flags: string,
    locale: ExplainLocale,
    options: ExplainOptions = {},
): RegexExplanation {
    const words = locale === 'ru' ? RU : EN;
    const base = { pattern: source, flags, groups: [], flagNotes: [], warnings: [] };
    try {
        new RegExp(source, flags);
    } catch (error) {
        return {
            ...base,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            summary: '',
        };
    }
    const unicode = flags.includes('u') || flags.includes('v');
    const parser = new Parser(source, unicode);
    const alts = parser.parse();
    const state: DescribeState = {
        words,
        dotAll: flags.includes('s'),
        multiline: flags.includes('m'),
        maxDepth: options.maxDepth ?? 4,
        groups: [],
        warnings: new Set(),
    };
    const summary = describeAlternatives(alts, state, 0);
    if (!flags.includes('g')) state.warnings.add('noGlobal');
    if (parser.emptyAlternative.value) state.warnings.add('emptyAlternative');
    if (!unicode && /\\[pP]\{/.test(source)) state.warnings.add('propWithoutUnicode');
    state.groups.sort((a, b) => a.index - b.index);
    return {
        ...base,
        ok: true,
        summary: cut(summary, options.maxChars ?? 700),
        groups: state.groups.map((group) => ({ ...group, matches: cut(group.matches, 300) })),
        flagNotes: [...new Set(flags)].map((flag) => words.flags[flag] ?? flag),
        warnings: [...state.warnings].map((code) => ({ code, text: words.warnings[code] })),
    };
}
