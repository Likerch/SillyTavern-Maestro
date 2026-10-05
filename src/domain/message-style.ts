// Message style rules (M32 «Стиль сообщений», stage 12): the rule model, the presets and the repair of stored
// settings. A rule says WHAT to find in a chat message (a match kind: "…" dialogue, «…», dash dialogue, *…*, …,
// narration = everything else, or a user regex), WHOSE messages it applies to (all / the player's / the
// characters') and HOW it looks (colour token, italic, bold, …, and for dialogue kinds the marks shown). Display only:
// rules never change the stored message text. The matching engine is in message-style-match.ts, the page model and
// the annotation plan in message-style-model.ts, the stylesheet in message-style-css.ts, the model hint in
// message-style-hint.ts. Pure: no DOM, no SillyTavern.

/* ------------------------------------------------------------------ kinds and values */

export const MATCH_KINDS = [
    'narration',
    'doubleQuotes',
    'guillemets',
    'dashDialogue',
    'asterisk',
    'doubleAsterisk',
    'underscore',
    'parentheses',
    'brackets',
    'backticks',
    'custom',
] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/**
 * Kinds that are direct speech: they may change the marks they are shown with. ST wraps "…", “…” and «…» alike in
 * `<q>`; dash dialogue, asides and custom rules it does not mark at all — Maestro's formatter hook does (see buildPlan).
 */
export const DIALOGUE_KINDS: readonly MatchKind[] = ['doubleQuotes', 'guillemets', 'dashDialogue'];

export const APPLY_TO = ['all', 'user', 'char'] as const;
export type ApplyTo = (typeof APPLY_TO)[number];
/** Whose message is being drawn: the player's or a character's. */
export type Scope = 'user' | 'char';

export const COLOR_TOKENS = ['accent', 'text', 'muted', 'quote', 'em', 'underline'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
/** A colour token or a custom `#rgb` / `#rrggbb` colour. */
export type ColorValue = ColorToken | string;

export const FONT_TOKENS = ['ui', 'chat', 'mono', 'serif'] as const;
export type FontToken = (typeof FONT_TOKENS)[number];

export const MARKS = ['keep', 'straight', 'curly', 'guillemets', 'none'] as const;
/** How direct speech is shown: its own marks, "…", “…”, «…» or no marks at all (display only). */
export type MarksMode = (typeof MARKS)[number];

export const PLAYER_MARKS = ['none', 'bar', 'tint', 'both'] as const;
export type PlayerMark = (typeof PLAYER_MARKS)[number];
export const PLAYER_ALIGN = ['default', 'indent'] as const;
export type PlayerAlign = (typeof PLAYER_ALIGN)[number];

export const OPACITY_MIN = 0.3;
export const MAX_RULES = 40;
export const MAX_NAME = 60;
export const MAX_PATTERN = 300;
/** Flags a custom rule may add to the always-on `g` (and `u` when the pattern allows it). */
export const CUSTOM_FLAGS = 'is';

/* ------------------------------------------------------------------ rules */

export interface RuleStyle {
    /** null: the colour SillyTavern gives it. */
    color: ColorValue | null;
    /** null: as ST draws it; true italic; false upright. */
    italic: boolean | null;
    /** null: as ST draws it; true bold; false regular. */
    bold: boolean | null;
    underline: boolean;
    /** 0.3–1 (1 = opaque); drawn as a translucent colour, not CSS opacity. */
    opacity: number;
    /** Slightly wider letter spacing. */
    spacing: boolean;
    /** null: the font around it. */
    font: FontToken | null;
    /** Soft accent background. */
    highlight: boolean;
    /** Soft accent bar on the left. */
    bar: boolean;
    /** Dialogue kinds only (display only, the stored text keeps its marks). */
    marks: MarksMode;
}

export interface RuleMatch {
    kind: MatchKind;
    /** custom: the regular expression. */
    pattern?: string;
    /** custom: extra flags from CUSTOM_FLAGS. */
    flags?: string;
}

export interface StyleRule {
    /** Lower-case letters and digits, unique in the set (it names the CSS class of custom rules). */
    id: string;
    /** Shown in the editor; '' = the kind's own name. */
    name: string;
    enabled: boolean;
    match: RuleMatch;
    applyTo: ApplyTo;
    style: RuleStyle;
}

/** The player's messages as a whole: a mark on the message, the name colour, bubble alignment. */
export interface PlayerStyle {
    enabled: boolean;
    mark: PlayerMark;
    color: ColorValue;
    /** Paint the player's name with the colour. */
    name: boolean;
    /** Bubbles chat style only: shift the player's bubbles to the right. */
    align: PlayerAlign;
}

export function defaultStyle(): RuleStyle {
    return {
        color: null,
        italic: null,
        bold: null,
        underline: false,
        opacity: 1,
        spacing: false,
        font: null,
        highlight: false,
        bar: false,
        marks: 'keep',
    };
}

export function makeStyle(partial: Partial<RuleStyle> = {}): RuleStyle {
    return { ...defaultStyle(), ...partial };
}

export function defaultPlayerStyle(): PlayerStyle {
    return { enabled: true, mark: 'bar', color: 'accent', name: true, align: 'default' };
}

export function isDialogueKind(kind: MatchKind): boolean {
    return DIALOGUE_KINDS.includes(kind);
}

/** Narration styles the whole message text: underline, highlight and bar make no sense there. */
export function supportsDecoration(kind: MatchKind): boolean {
    return kind !== 'narration';
}

/** The rule applies to messages of this scope. */
export function appliesTo(rule: Pick<StyleRule, 'applyTo'>, scope: Scope): boolean {
    return rule.applyTo === 'all' || rule.applyTo === scope;
}

/** Enabled rules of a scope (all enabled rules without a scope), in priority order. */
export function activeRules(rules: readonly StyleRule[], scope?: Scope): StyleRule[] {
    return rules.filter((rule) => rule.enabled && (!scope || appliesTo(rule, scope)));
}

/* ------------------------------------------------------------------ presets */

export const PRESET_IDS = [
    'classic',
    'book',
    'speech',
    'thoughts',
    'guillemets',
    'screenplay',
    'novel',
    'contrast',
    'player',
    'minimal',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];
export const DEFAULT_PRESET: PresetId = 'classic';

function rule(
    id: string,
    kind: MatchKind,
    style: Partial<RuleStyle> = {},
    extra: Partial<Omit<StyleRule, 'id' | 'style' | 'match'>> = {},
): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(style), ...extra };
}

const CLASSIC = (): StyleRule[] => [
    rule('narration', 'narration'),
    rule('speech', 'doubleQuotes', { color: 'quote' }),
    rule('guillemets', 'guillemets', { color: 'quote' }),
    rule('thoughts', 'asterisk', { italic: true }),
    rule('accent', 'doubleAsterisk', { bold: true }),
    rule('dash', 'dashDialogue', { color: 'quote' }, { enabled: false }),
];

const PRESETS: Record<PresetId, () => StyleRule[]> = {
    // Narration plain, "…" dialogue in ST's quote colour, *…* thoughts and emphasis in italics (the user's default).
    classic: CLASSIC,
    // A printed book: dash dialogue and «…» in the text colour, thoughts italic and muted.
    book: () => [
        rule('narration', 'narration'),
        rule('dash', 'dashDialogue'),
        rule('guillemets', 'guillemets', { color: 'text' }),
        rule('speech', 'doubleQuotes', { color: 'text' }),
        rule('thoughts', 'asterisk', { italic: true, color: 'muted' }),
        rule('accent', 'doubleAsterisk', { bold: true }),
    ],
    // Speech stands out: bold accent dialogue of every kind, narration slightly muted.
    speech: () => [
        rule('narration', 'narration', { opacity: 0.8 }),
        rule('speech', 'doubleQuotes', { color: 'accent', bold: true }),
        rule('guillemets', 'guillemets', { color: 'accent', bold: true }),
        rule('dash', 'dashDialogue', { color: 'accent', bold: true }),
        rule('thoughts', 'asterisk', { italic: true }),
    ],
    // Thoughts apart: italic, muted, with a soft accent bar on the left.
    thoughts: () => [
        rule('narration', 'narration'),
        rule('speech', 'doubleQuotes', { color: 'quote' }),
        rule('guillemets', 'guillemets', { color: 'quote' }),
        rule('thoughts', 'asterisk', { italic: true, color: 'muted', bar: true }),
        rule('thoughts2', 'underscore', { italic: true, color: 'muted', bar: true }),
        rule('accent', 'doubleAsterisk', { bold: true }),
    ],
    // Every kind of dialogue shown with «…».
    guillemets: () => [
        rule('narration', 'narration'),
        rule('speech', 'doubleQuotes', { color: 'quote', marks: 'guillemets' }),
        rule('guillemets', 'guillemets', { color: 'quote' }),
        rule('dash', 'dashDialogue', { color: 'quote', marks: 'guillemets' }),
        rule('thoughts', 'asterisk', { italic: true }),
    ],
    // A script: bold dialogue, narration italic and muted like stage directions, emphasis upright inside it.
    screenplay: () => [
        rule('narration', 'narration', { italic: true, color: 'muted' }),
        rule('speech', 'doubleQuotes', { bold: true, color: 'text' }),
        rule('guillemets', 'guillemets', { bold: true, color: 'text' }),
        rule('dash', 'dashDialogue', { bold: true, color: 'text' }),
        rule('thoughts', 'asterisk', { italic: false, color: 'em' }),
    ],
    // A novel: serif text, dialogue in “curly quotes” in the text colour, thoughts italic and muted.
    novel: () => [
        rule('narration', 'narration', { font: 'serif' }),
        rule('speech', 'doubleQuotes', { color: 'text', marks: 'curly' }),
        rule('guillemets', 'guillemets', { color: 'text' }),
        rule('dash', 'dashDialogue'),
        rule('thoughts', 'asterisk', { italic: true, color: 'muted' }),
    ],
    // Contrast: muted narration, dialogue in the full text colour, thoughts in the accent colour.
    contrast: () => [
        rule('narration', 'narration', { color: 'muted' }),
        rule('speech', 'doubleQuotes', { color: 'text' }),
        rule('guillemets', 'guillemets', { color: 'text' }),
        rule('dash', 'dashDialogue', { color: 'text' }),
        rule('thoughts', 'asterisk', { italic: true, color: 'accent' }),
    ],
    // The player's own look: his narration reads like stage directions, his lines bold; characters as in Classic.
    player: () => [
        rule('usernarr', 'narration', { italic: true, color: 'muted' }, { applyTo: 'user' }),
        rule('userspeech', 'doubleQuotes', { bold: true, color: 'text' }, { applyTo: 'user' }),
        rule('userdash', 'dashDialogue', { bold: true, color: 'text' }, { applyTo: 'user' }),
        ...CLASSIC().filter((item) => item.id !== 'dash'),
    ],
    // No rules: SillyTavern's own look.
    minimal: () => [],
};

export function isPresetId(value: unknown): value is PresetId {
    return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value);
}

/** Fresh copies of a preset's rules. */
export function presetRules(id: PresetId): StyleRule[] {
    return (PRESETS[id] ?? PRESETS[DEFAULT_PRESET])();
}

const STYLE_KEYS: readonly (keyof RuleStyle)[] = [
    'color',
    'italic',
    'bold',
    'underline',
    'opacity',
    'spacing',
    'font',
    'highlight',
    'bar',
    'marks',
];

/** Same rules in the same order (the editor shows «changed» when the rules differ from their preset). */
export function sameRules(a: readonly StyleRule[], b: readonly StyleRule[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((item, index) => canonical(item) === canonical(b[index]!));
}

function canonical(item: StyleRule): string {
    const match: RuleMatch = { kind: item.match.kind };
    if (item.match.kind === 'custom') {
        match.pattern = item.match.pattern ?? '';
        match.flags = item.match.flags ?? '';
    }
    const style = makeStyle(item.style);
    return JSON.stringify([item.id, item.name, item.enabled, match, item.applyTo, STYLE_KEYS.map((key) => style[key])]);
}

/* ------------------------------------------------------------------ custom regular expressions */

export type CustomCheck =
    { ok: true; re: RegExp } | { ok: false; reason: 'empty' | 'tooLong' | 'syntax' | 'emptyMatch'; detail?: string };

const customCache = new Map<string, CustomCheck>();
const CUSTOM_CACHE_SIZE = 64;

/** Only CUSTOM_FLAGS letters, each once, in a stable order. */
export function cleanFlags(flags: unknown): string {
    const text = typeof flags === 'string' ? flags : '';
    return [...CUSTOM_FLAGS].filter((flag) => text.includes(flag)).join('');
}

/**
 * Compiles a custom rule's pattern (global; with `u` when the pattern is valid in Unicode mode, so `\p{L}` works).
 * A pattern that matches the empty string is refused: it would match everywhere.
 */
export function compileCustom(pattern: unknown, flags?: unknown): CustomCheck {
    const source = typeof pattern === 'string' ? pattern : '';
    const extra = cleanFlags(flags);
    if (!source.trim()) return { ok: false, reason: 'empty' };
    if (source.length > MAX_PATTERN) return { ok: false, reason: 'tooLong' };
    const key = `${extra}\u0000${source}`;
    const cached = customCache.get(key);
    if (cached) return cached;
    let result: CustomCheck;
    let re: RegExp | null = null;
    let detail = '';
    for (const base of ['gu', 'g']) {
        try {
            re = new RegExp(source, base + extra);
            break;
        } catch (error) {
            if (!detail) detail = error instanceof Error ? error.message : String(error);
        }
    }
    if (!re) {
        result = { ok: false, reason: 'syntax', detail };
    } else {
        re.lastIndex = 0;
        const empty = re.exec('');
        re.lastIndex = 0;
        result = empty ? { ok: false, reason: 'emptyMatch' } : { ok: true, re };
    }
    if (customCache.size >= CUSTOM_CACHE_SIZE) customCache.delete(customCache.keys().next().value as string);
    customCache.set(key, result);
    return result;
}

/* ------------------------------------------------------------------ repair of stored settings */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const ID_RE = /^[a-z][a-z0-9]{0,23}$/;

export function isHexColor(value: unknown): value is string {
    return typeof value === 'string' && HEX_RE.test(value);
}

export function isColorToken(value: unknown): value is ColorToken {
    return typeof value === 'string' && (COLOR_TOKENS as readonly string[]).includes(value);
}

/** A colour token, a lower-cased hex colour, or null. */
export function normalizeColor(value: unknown): ColorValue | null {
    if (isColorToken(value)) return value;
    if (isHexColor(value)) return value.toLowerCase();
    return null;
}

function triState(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function clampOpacity(value: unknown): number {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    return Math.round(Math.min(1, Math.max(OPACITY_MIN, number)) * 100) / 100;
}

export function normalizeStyle(raw: unknown, kind: MatchKind): RuleStyle {
    const source = isDict(raw) ? raw : {};
    const decorated = supportsDecoration(kind);
    const font = source.font;
    const marks = source.marks;
    return {
        color: normalizeColor(source.color),
        italic: triState(source.italic),
        bold: triState(source.bold),
        underline: decorated && source.underline === true,
        opacity: clampOpacity(source.opacity),
        spacing: source.spacing === true,
        font:
            typeof font === 'string' && (FONT_TOKENS as readonly string[]).includes(font) ? (font as FontToken) : null,
        highlight: decorated && source.highlight === true,
        bar: decorated && source.bar === true,
        marks:
            isDialogueKind(kind) && typeof marks === 'string' && (MARKS as readonly string[]).includes(marks)
                ? (marks as MarksMode)
                : 'keep',
    };
}

/** The smallest free id with this prefix (`c1`, `c2`, …). */
export function newRuleId(rules: readonly Pick<StyleRule, 'id'>[], prefix = 'c'): string {
    const used = new Set(rules.map((item) => item.id));
    for (let n = 1; ; n++) {
        const id = `${prefix}${n}`;
        if (!used.has(id)) return id;
    }
}

/** A repaired rule, or null when it is not a rule at all (unknown kind). */
export function normalizeRule(raw: unknown): StyleRule | null {
    if (!isDict(raw)) return null;
    const match = isDict(raw.match) ? raw.match : { kind: raw.match };
    const kind = match.kind;
    if (typeof kind !== 'string' || !(MATCH_KINDS as readonly string[]).includes(kind)) return null;
    const matchKind = kind as MatchKind;
    const result: StyleRule = {
        id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '',
        name: typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '',
        enabled: raw.enabled !== false,
        match: { kind: matchKind },
        applyTo:
            typeof raw.applyTo === 'string' && (APPLY_TO as readonly string[]).includes(raw.applyTo)
                ? (raw.applyTo as ApplyTo)
                : 'all',
        style: normalizeStyle(raw.style, matchKind),
    };
    if (matchKind === 'custom') {
        result.match.pattern = typeof match.pattern === 'string' ? match.pattern.slice(0, MAX_PATTERN) : '';
        result.match.flags = cleanFlags(match.flags);
    }
    return result;
}

/** Repaired rules: unknown entries dropped, ids made valid and unique, at most MAX_RULES. */
export function normalizeRules(raw: unknown): StyleRule[] {
    if (!Array.isArray(raw)) return [];
    const result: StyleRule[] = [];
    for (const item of raw) {
        if (result.length >= MAX_RULES) break;
        const repaired = normalizeRule(item);
        if (!repaired) continue;
        if (!repaired.id || result.some((other) => other.id === repaired.id)) repaired.id = newRuleId(result, 'r');
        result.push(repaired);
    }
    return result;
}

export function normalizePlayer(raw: unknown): PlayerStyle {
    const source = isDict(raw) ? raw : {};
    const defaults = defaultPlayerStyle();
    return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
        mark:
            typeof source.mark === 'string' && (PLAYER_MARKS as readonly string[]).includes(source.mark)
                ? (source.mark as PlayerMark)
                : defaults.mark,
        color: normalizeColor(source.color) ?? defaults.color,
        name: typeof source.name === 'boolean' ? source.name : defaults.name,
        align:
            typeof source.align === 'string' && (PLAYER_ALIGN as readonly string[]).includes(source.align)
                ? (source.align as PlayerAlign)
                : defaults.align,
    };
}

/* ------------------------------------------------------------------ the annotation plan */

/** An outer-layer kind the formatter hook marks with a span of class `maestro-ms-<cls>`. */
export interface PlanSpan {
    /** `dash`, `paren`, `bracket` or `c-<rule id>` for a custom rule. */
    cls: string;
    kind: 'dashDialogue' | 'parentheses' | 'brackets' | 'custom';
    pattern?: string;
    flags?: string;
}

/** What the formatter hook must mark in messages of one scope (everything else is styled on ST's own HTML). */
export interface ScopePlan {
    /** Tell ST's `<q>` apart: "…"/“…” get `dq`, «…» gets `gq`. */
    quotes: boolean;
    /** Wrap the marks so a stylesheet can swap them (dialogue rules with marks other than «keep»). */
    marks: { dq: boolean; gq: boolean; dash: boolean };
    /** Spans in rule priority order (a tie at the same start goes to the earlier one). */
    spans: PlanSpan[];
}

const SPAN_CLASS: Partial<Record<MatchKind, string>> = {
    dashDialogue: 'dash',
    parentheses: 'paren',
    brackets: 'bracket',
};

export function buildPlan(rules: readonly StyleRule[], scope: Scope): ScopePlan {
    const active = activeRules(rules, scope);
    const has = (kind: MatchKind) => active.some((item) => item.match.kind === kind);
    const swaps = (kind: MatchKind) => active.some((item) => item.match.kind === kind && item.style.marks !== 'keep');
    const spans: PlanSpan[] = [];
    for (const item of active) {
        const kind = item.match.kind;
        if (kind === 'custom') {
            if (!compileCustom(item.match.pattern, item.match.flags).ok) continue;
            spans.push({
                cls: `c-${item.id}`,
                kind,
                pattern: item.match.pattern ?? '',
                flags: cleanFlags(item.match.flags),
            });
            continue;
        }
        const cls = SPAN_CLASS[kind];
        if (cls && !spans.some((span) => span.cls === cls)) spans.push({ cls, kind: kind as PlanSpan['kind'] });
    }
    return {
        quotes: has('doubleQuotes') || has('guillemets'),
        marks: { dq: swaps('doubleQuotes'), gq: swaps('guillemets'), dash: swaps('dashDialogue') },
        spans,
    };
}

/** The plan marks nothing. */
export function isEmptyPlan(plan: ScopePlan): boolean {
    return !plan.quotes && plan.spans.length === 0;
}

/** Changes when the hook would mark messages differently (then visible messages are marked again). */
export function planSignature(plans: Readonly<Record<Scope, ScopePlan>> | null): string {
    return plans ? JSON.stringify([plans.user, plans.char]) : '';
}
