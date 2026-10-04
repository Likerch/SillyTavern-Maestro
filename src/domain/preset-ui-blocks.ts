// Pure helpers of the Preset Studio's block list and block editor (M34, research/parity-preset.md §2–§3): what kind
// of block a prompt is (P-020), what may be edited, detached or deleted (P-025, P-026, P-029), strict type
// normalization (P-039, P-044…P-047, P-132), search, macro and flag highlighting (M34 п. 2, P-149) and the built-in
// defaults ST resets to (P-033, P-053).

export type PromptRole = 'system' | 'user' | 'assistant';

export const PROMPT_ROLES: readonly PromptRole[] = ['system', 'user', 'assistant'];

/** Generation types a block can be limited to (constants.js:36-43); empty = every type. */
export const PROMPT_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as const;
export type PromptTrigger = (typeof PROMPT_TRIGGERS)[number];

/** PM:31-32 and the form limits (IDX:7345-7358). */
export const DEFAULT_DEPTH = 4;
export const DEFAULT_INJECTION_ORDER = 100;
export const MAX_DEPTH = 9999;
export const MAX_INJECTION_ORDER = 9999;

/** The eight places ST fills itself (P-035). */
export const MARKER_IDS = [
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'dialogueExamples',
    'chatHistory',
] as const;

/** Markers whose role, position, depth, order and triggers may be edited, but not the text (P-025, P-051). */
export const EXTERNAL_MARKERS = [
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'worldInfoBefore',
    'worldInfoAfter',
] as const;

/** Built-in system blocks (P-036) with the values «Сброс» puts back (PM:521-545, OAI:102-106). */
export const SYSTEM_DEFAULTS: Readonly<Record<string, { name: string; content: string; forbidOverrides?: false }>> = {
    main: {
        name: 'Main Prompt',
        content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
        forbidOverrides: false,
    },
    nsfw: { name: 'Nsfw Prompt', content: '' },
    jailbreak: { name: 'Jailbreak Prompt', content: '', forbidOverrides: false },
    enhanceDefinitions: {
        name: 'Enhance Definitions',
        content:
            "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    },
};

/** Blocks a character card may override (PM:320-323): only they show «Запретить перезапись». */
export const OVERRIDABLE_IDS = ['main', 'jailbreak'] as const;

/** «Сбросить текущего персонажа»: ST's default global order (PM:2087-2136). */
export const DEFAULT_PROMPT_ORDER: readonly { identifier: string; enabled: boolean }[] = [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'personaDescription', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'charPersonality', enabled: true },
    { identifier: 'scenario', enabled: true },
    { identifier: 'enhanceDefinitions', enabled: false },
    { identifier: 'nsfw', enabled: true },
    { identifier: 'worldInfoAfter', enabled: true },
    { identifier: 'dialogueExamples', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
];

const BUILTIN_IDS: ReadonlySet<string> = new Set([...Object.keys(SYSTEM_DEFAULTS), ...MARKER_IDS]);

/** A prompt as found in a preset: every field may be missing or of a foreign type (P-132). */
export interface PromptLike {
    identifier: string;
    name?: unknown;
    role?: unknown;
    content?: unknown;
    system_prompt?: unknown;
    marker?: unknown;
    injection_position?: unknown;
    injection_depth?: unknown;
    injection_order?: unknown;
    injection_trigger?: unknown;
    forbid_overrides?: unknown;
    [field: string]: unknown;
}

export function isBuiltinId(identifier: string): boolean {
    return BUILTIN_IDS.has(identifier);
}

export function isMarker(prompt: PromptLike): boolean {
    return prompt.marker === true;
}

/** «В чате» is strictly the number 1 (OAI:1198): a string "1" from a foreign file is a relative block. */
export function isInChat(prompt: PromptLike): boolean {
    return prompt.injection_position === 1;
}

export type BlockKind = 'inChat' | 'marker' | 'important' | 'global' | 'user';

/** The icon PM shows in the row (PM:1721-1751). */
export function blockKind(prompt: PromptLike): BlockKind {
    if (isInChat(prompt)) return 'inChat';
    if (isMarker(prompt)) return 'marker';
    if (prompt.system_prompt === true) return prompt.forbid_overrides === true ? 'important' : 'global';
    return 'user';
}

/** P-025: every non-marker and the six external markers; `chatHistory` and `dialogueExamples` never. */
export function canEditBlock(prompt: PromptLike): boolean {
    return !isMarker(prompt) || (EXTERNAL_MARKERS as readonly string[]).includes(prompt.identifier);
}

/** P-035, P-050: a marker's text is filled by ST. */
export function canEditText(prompt: PromptLike): boolean {
    return !isMarker(prompt);
}

/**
 * P-026, P-029: PM detaches and deletes only `system_prompt === false`. The studio also lets go of user blocks with
 * the key missing (imported files, P-039) — they are never built-in and never markers.
 */
export function canRemoveBlock(prompt: PromptLike): boolean {
    return !isBuiltinId(prompt.identifier) && !isMarker(prompt) && prompt.system_prompt !== true;
}

/** P-049: the «forbid overrides» checkbox is shown for main and jailbreak only. */
export function canForbidOverrides(identifier: string): boolean {
    return (OVERRIDABLE_IDS as readonly string[]).includes(identifier);
}

/** P-053: «Сброс» exists for system blocks (markers included; only the four have values to reset to). */
export function canReset(prompt: PromptLike): boolean {
    return prompt.system_prompt === true;
}

export function promptName(prompt: PromptLike): string {
    return typeof prompt.name === 'string' && prompt.name.trim() ? prompt.name : prompt.identifier;
}

export function promptText(prompt: PromptLike): string {
    return typeof prompt.content === 'string' ? prompt.content : '';
}

export function promptRole(prompt: PromptLike): PromptRole {
    return (PROMPT_ROLES as readonly unknown[]).includes(prompt.role) ? (prompt.role as PromptRole) : 'system';
}

function clampInt(value: unknown, fallback: number, max: number): number {
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(0, Math.round(number)));
}

export function promptDepth(prompt: PromptLike): number {
    return clampInt(prompt.injection_depth, DEFAULT_DEPTH, MAX_DEPTH);
}

export function promptOrder(prompt: PromptLike): number {
    return clampInt(prompt.injection_order, DEFAULT_INJECTION_ORDER, MAX_INJECTION_ORDER);
}

export function promptTriggers(prompt: PromptLike): PromptTrigger[] {
    if (!Array.isArray(prompt.injection_trigger)) return [];
    const known = PROMPT_TRIGGERS as readonly string[];
    const list = prompt.injection_trigger
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.toLowerCase())
        .filter((item) => known.includes(item));
    return [...new Set(list)] as PromptTrigger[];
}

/** Editable fields of a block (the studio's form, P-043…P-052). */
export interface BlockFields {
    name: string;
    role: PromptRole;
    position: 0 | 1;
    depth: number;
    order: number;
    triggers: PromptTrigger[];
    forbidOverrides: boolean;
    content: string;
}

export function blockFields(prompt: PromptLike): BlockFields {
    return {
        name: typeof prompt.name === 'string' ? prompt.name : '',
        role: promptRole(prompt),
        position: isInChat(prompt) ? 1 : 0,
        depth: promptDepth(prompt),
        order: promptOrder(prompt),
        triggers: promptTriggers(prompt),
        forbidOverrides: prompt.forbid_overrides === true,
        content: promptText(prompt),
    };
}

export function sameFields(a: BlockFields, b: BlockFields): boolean {
    return (
        a.name === b.name &&
        a.role === b.role &&
        a.position === b.position &&
        a.depth === b.depth &&
        a.order === b.order &&
        a.forbidOverrides === b.forbidOverrides &&
        a.content === b.content &&
        a.triggers.length === b.triggers.length &&
        a.triggers.every((trigger) => b.triggers.includes(trigger))
    );
}

/**
 * The patch the form writes (P-052): fields the user changed plus fields stored with a foreign type (a string depth,
 * an unknown role — P-132), always with strict types; a marker's text is never written. Untouched missing keys
 * stay missing (P-056).
 */
export function fieldsPatch(prompt: PromptLike, fields: BlockFields): Record<string, unknown> {
    const before = blockFields(prompt);
    const patch: Record<string, unknown> = {};
    const differs = (key: string, value: unknown, changed: boolean) => {
        const stored = prompt[key];
        if (changed || (stored !== undefined && JSON.stringify(stored) !== JSON.stringify(value))) patch[key] = value;
    };
    const name = fields.name.trim() ? fields.name : before.name || prompt.identifier;
    if (name !== prompt.name) patch.name = name;
    differs('role', fields.role, fields.role !== before.role);
    differs('injection_position', fields.position, fields.position !== before.position);
    const depth = clampInt(fields.depth, DEFAULT_DEPTH, MAX_DEPTH);
    differs('injection_depth', depth, depth !== before.depth);
    const order = clampInt(fields.order, DEFAULT_INJECTION_ORDER, MAX_INJECTION_ORDER);
    differs('injection_order', order, order !== before.order);
    const triggers = promptTriggers({ identifier: prompt.identifier, injection_trigger: fields.triggers });
    differs('injection_trigger', triggers, !sameList(triggers, before.triggers));
    differs('forbid_overrides', fields.forbidOverrides, fields.forbidOverrides !== before.forbidOverrides);
    if (canEditText(prompt) && fields.content !== before.content) patch.content = fields.content;
    if (!isBuiltinId(prompt.identifier)) Object.assign(patch, userFlagsPatch(prompt));
    return patch;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((item) => b.includes(item));
}

/** P-039, P-132: a user block must carry `system_prompt: false` and `marker: false`, or ST silently skips it. */
export function userFlagsPatch(prompt: PromptLike): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (prompt.system_prompt !== false) patch.system_prompt = false;
    if (prompt.marker !== false) patch.marker = false;
    return patch;
}

/**
 * A copy of a foreign or imported block with ST's strict types (P-132): numbers for position, depth and order, one
 * of the three roles, a string list of triggers, user flags for non-built-in blocks. Unknown fields are kept;
 * `extension`, `position` and the legacy `enabled` (runtime-only, P-055) are dropped.
 */
export function normalizePrompt<T extends PromptLike>(prompt: T): T {
    const copy: Record<string, unknown> = { ...prompt };
    delete copy.extension;
    delete copy.position;
    delete copy.enabled;
    copy.name = typeof prompt.name === 'string' && prompt.name.trim() ? prompt.name : prompt.identifier;
    copy.role = promptRole(prompt);
    if (prompt.content !== undefined || !isMarker(prompt)) copy.content = promptText(prompt);
    if (prompt.injection_position !== undefined)
        copy.injection_position = Number(prompt.injection_position) === 1 ? 1 : 0;
    if (prompt.injection_depth !== undefined) copy.injection_depth = promptDepth(prompt);
    if (prompt.injection_order !== undefined) copy.injection_order = promptOrder(prompt);
    if (prompt.injection_trigger !== undefined) copy.injection_trigger = promptTriggers(prompt);
    if (prompt.forbid_overrides !== undefined) copy.forbid_overrides = prompt.forbid_overrides === true;
    if (!isBuiltinId(prompt.identifier)) Object.assign(copy, { system_prompt: false, marker: false });
    return copy as T;
}

/** True when the block's types would make ST drop or misplace it (P-039, P-044…P-047). */
export function typeProblems(prompt: PromptLike): string[] {
    const problems: string[] = [];
    if (!isBuiltinId(prompt.identifier) && prompt.system_prompt !== false) problems.push('systemPrompt');
    if (prompt.role !== undefined && !(PROMPT_ROLES as readonly unknown[]).includes(prompt.role)) problems.push('role');
    if (prompt.injection_position !== undefined && typeof prompt.injection_position !== 'number')
        problems.push('position');
    if (prompt.injection_depth !== undefined && typeof prompt.injection_depth !== 'number') problems.push('depth');
    if (prompt.injection_order !== undefined && typeof prompt.injection_order !== 'number') problems.push('order');
    return problems;
}

/* ------------------------------------------------------------------ search */

function haystack(prompt: PromptLike | null, identifier: string): string {
    if (!prompt) return identifier.toLowerCase();
    return `${promptName(prompt)}\n${identifier}\n${promptText(prompt)}`.toLowerCase();
}

/** Every word of the term must occur in the name, identifier or text (case-insensitive). */
export function matchesSearch(prompt: PromptLike | null, identifier: string, term: string): boolean {
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = haystack(prompt, identifier);
    return words.every((word) => text.includes(word));
}

/* ------------------------------------------------------------------ highlighting */

export type SegmentKind = 'text' | 'macro' | 'variable' | 'condition' | 'flag' | 'comment';

export interface TextSegment {
    kind: SegmentKind;
    text: string;
}

const MACRO = /\{\{[\s\S]*?\}\}/g;
const COMMENT = /^\{\{\s*\/\//;
const MAESTRO_FLAG = /^\{\{\s*#?if\s+!?\s*\.maestro_/i;
const CONDITION = /^\{\{\s*(?:#?if\b|else\s*\}\}|\/if\s*\}\})/i;
const VARIABLE_NAMES =
    'getvar|setvar|addvar|incvar|decvar|flushvar|hasvar|deletevar|getglobalvar|setglobalvar|addglobalvar|incglobalvar|decglobalvar|flushglobalvar|hasglobalvar|deleteglobalvar';
const VARIABLE = new RegExp(`^\\{\\{\\s*(?:(?:${VARIABLE_NAMES})\\b|[.$][a-zA-Z])`, 'i');

function macroKind(macro: string): SegmentKind {
    if (COMMENT.test(macro)) return 'comment';
    if (MAESTRO_FLAG.test(macro)) return 'flag';
    if (CONDITION.test(macro)) return 'condition';
    if (VARIABLE.test(macro)) return 'variable';
    return 'macro';
}

/** Splits a block's text into plain text and macros (`{{…}}`), classifying Maestro flags and conditions (P-134). */
export function highlightSegments(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    let last = 0;
    for (const match of text.matchAll(MACRO)) {
        const start = match.index ?? 0;
        if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
        segments.push({ kind: macroKind(match[0]), text: match[0] });
        last = start + match[0].length;
    }
    if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
    return segments;
}

/** Names of Maestro flags a block reads (`{{if .maestro_scene_combat}}` → `maestro_scene_combat`). */
export function maestroFlags(text: string): string[] {
    const names = [...text.matchAll(/\{\{\s*#?if\s+!?\s*\.(maestro_[A-Za-z0-9_-]*[A-Za-z0-9_])/gi)].map(
        (match) => match[1] ?? '',
    );
    return [...new Set(names.filter(Boolean))];
}

const SIDE_EFFECT_MACROS = [
    'setvar',
    'addvar',
    'incvar',
    'decvar',
    'flushvar',
    'deletevar',
    'setglobalvar',
    'addglobalvar',
    'incglobalvar',
    'decglobalvar',
    'flushglobalvar',
    'deleteglobalvar',
];

/** Macros that change chat or global variables when evaluated (P-145): a preview would run them too. */
export function sideEffectMacros(text: string): string[] {
    const found = new Set<string>();
    for (const match of text.matchAll(/\{\{\s*([a-z]+)\s*(?:::|\s|\}\})/gi)) {
        const name = (match[1] ?? '').toLowerCase();
        if (SIDE_EFFECT_MACROS.includes(name)) found.add(name);
    }
    return [...found];
}

/* ------------------------------------------------------------------ list summaries */

export interface OrderRow {
    item: { identifier: string; enabled: boolean };
    prompt: PromptLike | null;
}

/** Enabled / listed blocks (rows without a block are not counted, PM skips them, P-019). */
export function enabledCount(rows: readonly OrderRow[]): { enabled: number; total: number } {
    const listed = rows.filter((row) => row.prompt !== null);
    return { enabled: listed.filter((row) => row.item.enabled).length, total: listed.length };
}

/** Sum of known token counts of enabled rows. */
export function tokenTotal(rows: readonly OrderRow[], tokens: ReadonlyMap<string, number>): number {
    let total = 0;
    for (const row of rows) {
        if (!row.prompt || !row.item.enabled) continue;
        const value = tokens.get(row.item.identifier);
        if (typeof value === 'number' && Number.isFinite(value)) total += value;
    }
    return total;
}

/** Blocks not in the active order: what «Вставить блок» offers (P-027: non-system, sorted by name). */
export function detachedPrompts<T extends PromptLike>(prompts: readonly T[], order: readonly string[]): T[] {
    const listed = new Set(order);
    return prompts
        .filter((prompt) => prompt.system_prompt !== true && !isMarker(prompt) && !listed.has(prompt.identifier))
        .sort((a, b) => promptName(a).localeCompare(promptName(b)));
}

/** A free name for a copy: «Name (copy)», «Name (copy 2)»… */
export function copyName(name: string, taken: readonly string[], suffix: string): string {
    const used = new Set(taken);
    let candidate = `${name} (${suffix})`;
    for (let index = 2; used.has(candidate); index++) candidate = `${name} (${suffix} ${index})`;
    return candidate;
}
