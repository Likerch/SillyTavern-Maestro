// Field model of the Lore Studio entry form (M23): ST 1.19 semantics of every editor control
// (world-info.js getWorldEntry and helpers, WI:3086-3870) as pure functions — position with role and outlet,
// tri-state «global» selects, number fields with ST's limits, `delayUntilRecursion` as boolean or level, groups,
// character filter, generation triggers, entry status — plus the patch of a draft against the stored entry and the
// list of hidden changes ST's own editor makes when it opens an entry (research/parity-lore.md L-053…L-106, «трудные
// места» п. 5). The form keeps values as stored and only shows those differences; it never applies them silently.
import { stableHash } from './hash';

/* ------------------------------------------------------------------ constants (WI:28-100, constants.js:36-43) */

export const WI_POSITION = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
} as const;

export const MAX_SCAN_DEPTH = 1000;
export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const DEFAULT_ORDER = 100;
export const DEFAULT_PROBABILITY = 100;
/** Comment placeholder limit (`MAX_COMMENT_LENGTH`). */
export const MAX_COMMENT_LENGTH = 100;

/** `GENERATION_TYPE_TRIGGERS`; an empty list means «all types». */
export const GENERATION_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as const;
export type GenerationTrigger = (typeof GENERATION_TRIGGERS)[number];

/** Order of «Логика» in ST's list: AND ANY, AND ALL, NOT ALL, NOT ANY. */
export const LOGIC_ORDER = [0, 3, 1, 2] as const;

/** Scan-source flags (L-097…L-102), in ST's order. */
export const MATCH_FLAGS = [
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
] as const;

/** Tri-state fields: `null` = the global setting. */
export const TRI_STATE_FIELDS = ['caseSensitive', 'matchWholeWords', 'useGroupScoring'] as const;
export type TriStateField = (typeof TRI_STATE_FIELDS)[number];

/* ------------------------------------------------------------------ position, role, outlet (L-056, L-057, L-067) */

export interface PositionOption {
    /** Value of the option: position, plus `:role` for «at depth». */
    id: string;
    position: number;
    role: number | null;
    /** i18n suffix. */
    name: string;
}

export const POSITION_OPTIONS: readonly PositionOption[] = [
    { id: '0', position: 0, role: null, name: 'before' },
    { id: '1', position: 1, role: null, name: 'after' },
    { id: '5', position: 5, role: null, name: 'emTop' },
    { id: '6', position: 6, role: null, name: 'emBottom' },
    { id: '2', position: 2, role: null, name: 'anTop' },
    { id: '3', position: 3, role: null, name: 'anBottom' },
    { id: '4:0', position: 4, role: 0, name: 'depthSystem' },
    { id: '4:1', position: 4, role: 1, name: 'depthUser' },
    { id: '4:2', position: 4, role: 2, name: 'depthAssistant' },
    { id: '7', position: 7, role: null, name: 'outlet' },
];

/**
 * Option id of the stored position. ST shows a missing position as 0 and «at depth» with `role ?? 0`. Values ST's
 * list does not know (other extensions, newer ST) get their own id so the form can show and keep them.
 */
export function positionOptionId(position: unknown, role: unknown): string {
    const value = typeof position === 'number' ? position : 0;
    if (value === WI_POSITION.atDepth) {
        const roleValue = typeof role === 'number' ? role : 0;
        return `4:${roleValue}`;
    }
    return String(value);
}

export function isKnownPosition(id: string): boolean {
    return POSITION_OPTIONS.some((option) => option.id === id);
}

/** Position and role written when the user picks an option: role only for «at depth», `null` otherwise (ST). */
export function applyPosition(id: string): { position: number; role: number | null } {
    const option = POSITION_OPTIONS.find((item) => item.id === id);
    if (option) return { position: option.position, role: option.role };
    const [rawPosition, rawRole] = id.split(':');
    const position = Number(rawPosition);
    const safe = Number.isFinite(position) ? position : 0;
    if (safe === WI_POSITION.atDepth) {
        const role = Number(rawRole);
        return { position: safe, role: Number.isFinite(role) ? role : 0 };
    }
    return { position: safe, role: null };
}

/* ------------------------------------------------------------------ status (L-055) and tri-states (L-068…L-071) */

export type EntryState = 'constant' | 'normal' | 'vectorized';

/** ST: `constant` wins over `vectorized`. */
export function entryState(entry: { constant?: unknown; vectorized?: unknown }): EntryState {
    if (entry.constant === true) return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
}

export function applyEntryState(state: EntryState): { constant: boolean; vectorized: boolean } {
    return { constant: state === 'constant', vectorized: state === 'vectorized' };
}

export type TriState = 'null' | 'true' | 'false';

/** ST's `handleBooleanSelectHelper` display: null/undefined → global, truthy → yes, falsy → no. */
export function triStateOf(value: unknown): TriState {
    if (value === null || value === undefined) return 'null';
    return value ? 'true' : 'false';
}

export function parseTriState(value: string): boolean | null {
    if (value === 'null') return null;
    return value === 'true';
}

/* ------------------------------------------------------------------ numbers */

export type NumberError = 'notNumber' | 'required' | 'negative' | 'notInteger';

export type NumberResult =
    { ok: true; value: number | null; adjusted?: 'min' | 'max' | 'floor' } | { ok: false; error: NumberError };

export interface NumberSpec {
    /** Empty input stores `null` (`number?` fields); otherwise empty input is an error. */
    nullable?: boolean;
    min?: number;
    max?: number;
    /** Clamp to min/max (ST does for probability, group weight and scan depth); otherwise below min is an error. */
    clamp?: boolean;
    /** Round down (scan depth) instead of rejecting fractions. */
    floor?: boolean;
    /** Reject fractions. */
    integer?: boolean;
}

/** ST's limits per numeric field; validation is stricter than ST where ST would store junk (`Number('')` = 0). */
export const NUMBER_FIELDS = {
    order: { integer: false },
    depth: { min: 0 },
    probability: { min: 0, max: 100, clamp: true },
    scanDepth: { nullable: true, min: 0, max: MAX_SCAN_DEPTH, clamp: true, floor: true },
    groupWeight: { min: 1, max: 10000, clamp: true },
    sticky: { nullable: true, min: 0, integer: true },
    cooldown: { nullable: true, min: 0, integer: true },
    delay: { nullable: true, min: 0, integer: true },
} satisfies Record<string, NumberSpec>;

export type NumberField = keyof typeof NUMBER_FIELDS;

export function parseNumber(text: string, spec: NumberSpec): NumberResult {
    const trimmed = text.trim();
    if (trimmed === '') return spec.nullable ? { ok: true, value: null } : { ok: false, error: 'required' };
    let value = Number(trimmed);
    if (!Number.isFinite(value)) return { ok: false, error: 'notNumber' };
    let adjusted: 'min' | 'max' | 'floor' | undefined;
    if (spec.min !== undefined && value < spec.min) {
        if (!spec.clamp) return { ok: false, error: 'negative' };
        value = spec.min;
        adjusted = 'min';
    }
    if (spec.max !== undefined && value > spec.max) {
        if (spec.clamp) {
            value = spec.max;
            adjusted = 'max';
        }
    }
    if (!Number.isInteger(value)) {
        if (spec.floor) {
            value = Math.floor(value);
            adjusted = 'floor';
        } else if (spec.integer) {
            return { ok: false, error: 'notInteger' };
        }
    }
    return adjusted ? { ok: true, value, adjusted } : { ok: true, value };
}

/** Text of a number field: the stored value, empty for null/undefined/non-numbers. */
export function numberText(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/* ------------------------------------------------------------------ recursion (L-073, L-079) */

/** Checkbox and level text of `delayUntilRecursion` (boolean, level number, or ST's default 0). */
export function recursionDelayView(value: unknown): { on: boolean; level: string } {
    const on = !!value;
    if (typeof value === 'number' && value > 0) return { on, level: String(value) };
    if (typeof value === 'string') return { on, level: value };
    return { on, level: '' };
}

/** ST's checkbox: on keeps an existing level (`value || true`), off writes `false`. */
export function toggleRecursionDelay(current: unknown, on: boolean): boolean | number {
    if (!on) return false;
    if (typeof current === 'number' && current > 0) return current;
    return true;
}

/**
 * ST's level field: empty keeps a boolean (or `true` when a level was set), a number becomes the level (so «1» is
 * stored as 1, not `true` — same for the engine). Text that is not a number is rejected here; ST would store false.
 */
export function recursionDelayFromLevel(
    current: unknown,
    text: string,
): { ok: true; value: boolean | number } | { ok: false } {
    const trimmed = text.trim();
    if (trimmed === '') return { ok: true, value: typeof current === 'boolean' ? current : true };
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return { ok: false };
    return { ok: true, value };
}

/** Recursion level the engine uses: `true` = 1. */
export function recursionLevel(value: unknown): number {
    if (value === true) return 1;
    return typeof value === 'number' && value > 0 ? value : 0;
}

/* ------------------------------------------------------------------ groups (L-086) */

/** ST stores the trimmed text; the engine splits it with `/,\s*\/` (WI:5391), so «a ,b» names the group «a ». */
export function groupNames(group: unknown): string[] {
    if (typeof group !== 'string') return [];
    return group.split(/,\s*/).filter(Boolean);
}

/** Values used by other entries of the book (suggestions for group, outlet and automation id). */
export function bookSuggestions(
    entries: readonly Record<string, unknown>[],
    field: 'group' | 'outletName' | 'automationId',
    exceptUid?: number,
): string[] {
    const values = new Map<string, number>();
    for (const entry of entries) {
        if (exceptUid !== undefined && entry.uid === exceptUid) continue;
        if (field === 'outletName' && entry.position !== WI_POSITION.outlet) continue;
        const raw = entry[field];
        const names = field === 'group' ? groupNames(raw) : [typeof raw === 'string' ? raw : ''];
        for (const item of names) {
            const name = item.trim();
            if (name) values.set(name, (values.get(name) ?? 0) + 1);
        }
    }
    return [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/* ------------------------------------------------------------------ character filter (L-093, L-094) */

export interface CharacterFilter {
    isExclude: boolean;
    names: string[];
    tags: string[];
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function readCharacterFilter(value: unknown): CharacterFilter {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { isExclude: false, names: [], tags: [] };
    }
    const filter = value as Record<string, unknown>;
    return { isExclude: filter.isExclude === true, names: strings(filter.names), tags: strings(filter.tags) };
}

/** ST removes the field when nothing is selected and the exclude mode is off. */
export function buildCharacterFilter(filter: CharacterFilter): CharacterFilter | undefined {
    if (!filter.isExclude && !filter.names.length && !filter.tags.length) return undefined;
    return { isExclude: filter.isExclude, names: [...filter.names], tags: [...filter.tags] };
}

/** Character name as ST's filter stores it: the avatar file without its extension. */
export function avatarName(avatar: string): string {
    return avatar.replace(/\.[^/.]+$/, '');
}

/* ------------------------------------------------------------------ triggers (L-095) */

export function readTriggers(value: unknown): { known: GenerationTrigger[]; unknown: string[] } {
    const list = strings(value);
    const known = list.filter((item): item is GenerationTrigger =>
        (GENERATION_TRIGGERS as readonly string[]).includes(item),
    );
    return { known, unknown: list.filter((item) => !known.includes(item as GenerationTrigger)) };
}

/* ------------------------------------------------------------------ comment placeholder (L-054) */

export function commentPlaceholder(keys: readonly string[]): string {
    return keys.join(', ').slice(0, MAX_COMMENT_LENGTH);
}

/* ------------------------------------------------------------------ draft vs stored */

function sortedClone(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortedClone);
    if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(
            Object.keys(record)
                .sort()
                .filter((key) => record[key] !== undefined)
                .map((key) => [key, sortedClone(record[key])]),
        );
    }
    return value;
}

/** JSON with sorted keys and without `undefined` members (what a saved file would hold). */
export function canonicalJson(value: unknown): string {
    return value === undefined ? 'undefined' : JSON.stringify(sortedClone(value));
}

export function sameValue(a: unknown, b: unknown): boolean {
    return canonicalJson(a) === canonicalJson(b);
}

/** Deep copy of JSON data (lorebook entries are plain JSON). */
export function cloneJson<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Fields of `draft` that differ from `stored` (`uid` never). A field missing from the draft is reported as
 * `undefined` (the store drops it on save). Unknown fields of other extensions are compared like any other.
 */
export function entryPatch(stored: Record<string, unknown>, draft: Record<string, unknown>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(stored), ...Object.keys(draft)]);
    for (const key of keys) {
        if (key === 'uid') continue;
        if (!sameValue(stored[key], draft[key])) patch[key] = draft[key];
    }
    return patch;
}

/** Patch that turns `current` back into `version` (history restore). */
export function restorePatch(
    current: Record<string, unknown>,
    version: Record<string, unknown>,
): Record<string, unknown> {
    return entryPatch(current, version);
}

/** Hash of entry content used for canon override bases (`CanonMeta.base.contentHash`). */
export function contentHash(content: unknown): string {
    return stableHash(typeof content === 'string' ? content : '');
}

/* ------------------------------------------------------------------ ST's hidden normalisation (L-080…L-082, L-106) */

export interface StOpenDifference {
    field: string;
    /** Value as stored. */
    stored: unknown;
    /** Value ST's editor would hold after opening the entry (and write on the next save of the book). */
    st: unknown;
    /** The difference changes how the engine treats the entry. */
    engine: boolean;
}

/**
 * What ST's classic editor silently changes when it shows/opens this entry (written to the file with the next
 * save of anything in the book). Maestro keeps the stored values and shows this list instead.
 */
export function stEditorDifferences(entry: Record<string, unknown>): StOpenDifference[] {
    const result: StOpenDifference[] = [];
    const secondary = strings(entry.keysecondary);
    if (entry.selective !== true) {
        result.push({ field: 'selective', stored: entry.selective, st: true, engine: secondary.length > 0 });
    }
    const probability = entry.probability;
    // The list row's probability input runs `Number(val(null))` = 0 before the toggle could set 100 (WI:3173-3220).
    // A roll against null and against 0 fail alike, so only the switch of `useProbability` changes the engine.
    const stProbability =
        typeof probability === 'number' && Number.isFinite(probability) ? Math.min(100, Math.max(0, probability)) : 0;
    if (entry.useProbability !== true) {
        result.push({
            field: 'useProbability',
            stored: entry.useProbability,
            st: true,
            engine: stProbability !== 100,
        });
    }
    if (stProbability !== probability) {
        result.push({ field: 'probability', stored: probability, st: stProbability, engine: false });
    }
    if (entry.addMemo !== true) result.push({ field: 'addMemo', stored: entry.addMemo, st: true, engine: false });
    // A missing position is not inserted anywhere by the engine (no `case`); ST's editor makes it 0 (WI:3405).
    if (entry.position === undefined) result.push({ field: 'position', stored: undefined, st: 0, engine: true });
    for (const field of ['sticky', 'cooldown', 'delay'] as const) {
        const value = entry[field];
        if (value === null || value === undefined) result.push({ field, stored: value, st: 0, engine: false });
    }
    const depth = entry.depth;
    if (typeof depth !== 'number') {
        // The engine groups by `depth ?? 4`; ST's editor writes `Number('')` = 0.
        result.push({ field: 'depth', stored: depth, st: 0, engine: entry.position === WI_POSITION.atDepth });
    }
    const weight = entry.groupWeight;
    const stWeight = typeof weight === 'number' && Number.isFinite(weight) ? Math.min(10000, Math.max(1, weight)) : 1;
    if (stWeight !== weight) {
        // The engine reads `groupWeight ?? 100`; ST's opened editor clamps to 1…10000 and writes 1 for a missing one.
        result.push({ field: 'groupWeight', stored: weight, st: stWeight, engine: groupNames(entry.group).length > 0 });
    }
    if (
        entry.characterFilter !== undefined &&
        buildCharacterFilter(readCharacterFilter(entry.characterFilter)) === undefined
    ) {
        result.push({ field: 'characterFilter', stored: entry.characterFilter, st: undefined, engine: false });
    }
    const triggers = readTriggers(entry.triggers);
    if (triggers.unknown.length) {
        result.push({ field: 'triggers', stored: entry.triggers, st: triggers.known, engine: true });
    }
    return result;
}
