// M25 «Механики», pure parts of the state (plan M25 п. 4, 7; plan-2 §6; P9, P14): values of every holder per mechanic,
// statuses and items per holder, revealed hidden attributes, the fight, the story clock of the mechanics, a change
// log per message (a swiped, deleted or edited reply takes its changes back), threshold events with `once` latches.
// - values are validated per attribute: numbers clamped to their bounds, scale levels by label or index (clamped),
//   list options (case-insensitive, canonical spelling; lists are always arrays, a single list holds at most one),
//   texts trimmed and capped; deltas exist for numbers (and scales: steps; lists: options added), factors for numbers,
//   push / pull for list options; derived attributes (formula) are computed on read and never stored;
// - a change of a holder that is not stored yet first creates it with the initial values of every attribute;
// - events: '<=', '>=', '=' compare the new value (numbers, scale levels by order, list membership or size, texts);
//   'changed' fires on every change (to its value, when it names one). A `once` event (the default) fires once and
//   re-arms when a later change makes its condition false. A fired event's actions (values, statuses, items,
//   revealing) and its chained event follow in the same application — each event at most once per application, at
//   most OPS_LIMIT operations, nesting at most DEPTH_LIMIT deep (loop guard);
// - experience: a change of a progression's XP sets the level and runs `onLevelUp` once per level gained;
// - rollback: changes are undone newest first; a change still followed by a kept change of the same target is
//   reverted as a difference (numbers, scales, lists, item quantities) instead of overwriting what came later.
// The document is a plain JSON object (a Maestro file per chat); functions here mutate the copy they are given.
// Pure: no DOM, no SillyTavern.
import { findChainEvent, initialValueOf } from './mechanics-defs';
import type {
    AttributeDef,
    AttributeEvent,
    AttributeValue,
    EquipSlot,
    HolderSpec,
    ItemSpec,
    MechanicDef,
    StatusSpec,
} from './mechanics-defs';
import { addCombatant, endCombat, markOut, readCombat } from './mechanics-combat';
import type { CombatState } from './mechanics-combat';
import type { Rng } from './mechanics-dice';
import { resolveActions } from './mechanics-effects';
import { evaluateFormula, parseFormula } from './mechanics-formula';
import {
    applyStatus,
    catalogueStatus,
    equipItem,
    findItem,
    findStatus,
    giveItem,
    mergeStatusSpec,
    modifierSum,
    readItem,
    readStatus,
    takeItem,
} from './mechanics-status';
import type { ItemState, StatusState, StoryTime } from './mechanics-status';
import { levelFor } from './mechanics-time';

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ types */

/** Same union as `ChangeSource` of src/features/mechanics/api.ts. */
export type ChangeSource = 'desStats' | 'block' | 'background' | 'check' | 'event' | 'user' | 'time';
export const CHANGE_SOURCES: readonly ChangeSource[] = [
    'desStats',
    'block',
    'background',
    'check',
    'event',
    'user',
    'time',
];
/** Sources the model's replies produce (tracking): rolled back with their message. */
export const TRACKED_SOURCES: readonly ChangeSource[] = ['desStats', 'block', 'background', 'event', 'time'];

/** What a logged change touched. */
export type ChangeKind = 'value' | 'status' | 'item' | 'reveal' | 'combat';

/** One change to apply (the public `ChangeInput` without source and message). */
export interface ChangeSpec {
    mechanicId: string;
    /** Holder name (already resolved for the mechanic); matched case-insensitively against stored holders. */
    holder: string;
    /** Attribute id, prompt name or display name. */
    attribute: string;
    value: AttributeValue;
    /** `value` is a delta: numbers add, scales step, lists add options. */
    delta?: boolean;
    /** 'mul': `value` is a factor (numbers); 'push' / 'pull': options added to / removed from a list. */
    op?: 'mul' | 'push' | 'pull';
    reason?: string;
}

/** What every operation carries: where it comes from and how it is grouped. */
export interface OpBase {
    source: ChangeSource;
    messageIndex: number;
    reason?: string;
    /** The roll whose consequence this is (undo per roll). */
    rollId?: string;
    /** Changes made together (one reset, one event chain…): undone together. */
    batch?: string;
}

export interface ChangeInputData extends ChangeSpec, OpBase {
    kind?: 'value';
}

export type StatusOp = OpBase & {
    kind: 'status';
    mechanicId: string;
    holder: string;
} & (
        | { op: 'add'; status: StatusSpec }
        | { op: 'remove'; ref: string; expired?: boolean }
        | { op: 'update'; instance: StatusState }
    );

export type ItemOp = OpBase & {
    kind: 'item';
    mechanicId: string;
    holder: string;
    item: ItemSpec;
} & ({ op: 'give'; qty?: number } | { op: 'take'; qty?: number } | { op: 'equip'; slot: EquipSlot | null });

export interface RevealOp extends OpBase {
    kind: 'reveal';
    mechanicId: string;
    holder: string;
    attribute: string;
    /** Hide it again. */
    hide?: boolean;
}

export type CombatOp = OpBase & { kind: 'combat'; mechanicId: string } & (
        | { op: 'set'; next: CombatState | null }
        | { op: 'join'; holder: string; init?: number; enemy?: boolean }
        | { op: 'out'; holder: string }
    );

/** Moves the mechanics' story clock (not logged; rolled back with the message index). */
export interface ClockOp extends OpBase {
    kind: 'clock';
    index: number;
    clock: ClockRecord | null;
}

export type OpInput = ChangeInputData | StatusOp | ItemOp | RevealOp | CombatOp | ClockOp;

/** A recorded change (same shape as the public `StateChange`). */
export interface StateChangeData {
    id: string;
    mechanicId: string;
    holder: string;
    attribute: string;
    from: AttributeValue | null;
    to: AttributeValue;
    source: ChangeSource;
    messageIndex: number;
    reason?: string;
    at: number;
    /** Absent: a value. */
    kind?: Exclude<ChangeKind, 'value'>;
    rollId?: string;
    batch?: string;
    /** Status changes: the status after (before for a removal). */
    status?: StatusState;
    /** Item changes: the item after (before when it is gone). */
    item?: ItemState;
}

/** A change in the log with what its rollback needs. */
export interface LoggedChange extends StateChangeData {
    /** Event latches this change flipped: key → value before. */
    latch?: Record<string, boolean>;
    /** The holder did not exist before this change. */
    created?: boolean;
    /** The holder's `updatedAt` before this change. */
    prevUpdatedAt?: number;
    statusBefore?: StatusState | null;
    statusAfter?: StatusState | null;
    itemBefore?: ItemState | null;
    itemAfter?: ItemState | null;
    revealBefore?: boolean;
    combatBefore?: CombatState | null;
    combatAfter?: CombatState | null;
}

/** A fired threshold event (same shape as the public `FiredEvent`). */
export interface FiredEventData {
    mechanicId: string;
    holder: string;
    attribute: string;
    eventId: string;
    text: string;
    messageIndex: number;
    at: number;
}

export interface StoredEvent extends FiredEventData {
    id: string;
    /** The change that fired it (rolled back with it). */
    changeId: string;
    /** Given to the model already. */
    delivered: boolean;
}

export interface StoredHolder {
    values: Record<string, AttributeValue>;
    /** Message index of the last change (-1: initial values or user edits only). */
    updatedAt: number;
}

/** The story clock of the mechanics after a committed reply. */
export interface ClockRecord {
    day: number;
    minutes?: number;
    label: string;
    /** The calendar's reading kept for the next step (domain/calendar-time StoryClock). */
    time?: string;
    weekday?: number;
    anchor?: { kind: 'day' | 'date'; n: number; abs?: number; key: string; day: number };
}

export interface MechanicsStateDoc {
    version: 1;
    /** mechanic id → holder name → values. */
    holders: Record<string, Record<string, StoredHolder>>;
    /** Changes, oldest first (capped). */
    log: LoggedChange[];
    /** Latched `once` events (key → true). */
    latched: Record<string, boolean>;
    /** Fired events, oldest first (capped). */
    fired: StoredEvent[];
    /** holder name → statuses. */
    statuses: Record<string, StatusState[]>;
    /** holder name → items. */
    items: Record<string, ItemState[]>;
    /** `mechanic|holder|attribute` → revealed (hidden attributes the player may see now). */
    revealed: Record<string, true>;
    combat: CombatState | null;
    clock: ClockRecord | null;
    /** The clock after each committed reply that moved it (newest last, capped). */
    clockHistory: { index: number; clock: ClockRecord }[];
    /** The last committed reply whose turn (time, statuses, the fight) was processed; -1: none. */
    lastTurn: number;
}

export const STATE_LIMITS = { log: 1000, fired: 200, text: 500, reason: 200, clockHistory: 200 } as const;
/** Loop guard of one application: operations processed, nesting of events and chains. */
export const OPS_LIMIT = 200;
export const DEPTH_LIMIT = 6;

/* ------------------------------------------------------------------ small helpers */

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Lower case, trimmed, inner whitespace / underscores / hyphens as one space: the matching form of a name. */
export function nameKey(value: string): string {
    return value
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\s_-]+/g, ' ');
}

function sameName(a: string, b: string): boolean {
    return nameKey(a) === nameKey(b);
}

const MINUS_RE = /[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g;

/** A number from a number or a numeric string (unicode minus, spaces, decimal comma); null otherwise. */
export function toNumber(raw: unknown): number | null {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const text = raw
        .trim()
        .replace(MINUS_RE, '-')
        .replace(/[\s\u00a0\u202f]/g, '')
        .replace(/^(-?\+?\d+),(\d+)$/, '$1.$2');
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

function round(value: number): number {
    return Math.round(value * 10000) / 10000;
}

function clampNumber(attr: AttributeDef, value: number): { value: number; clamped: boolean } {
    let next = round(value);
    if (attr.min !== undefined && next < attr.min) next = attr.min;
    if (attr.max !== undefined && next > attr.max) next = attr.max;
    return { value: next, clamped: next !== round(value) };
}

/** Attribute of a mechanic by id, prompt name or display name (case-insensitive). */
export function findAttribute(def: Pick<MechanicDef, 'attributes'>, name: string): AttributeDef | null {
    const key = nameKey(name);
    if (!key) return null;
    return (
        def.attributes.find((attr) => nameKey(attr.id) === key) ??
        def.attributes.find((attr) => nameKey(attr.promptName) === key) ??
        def.attributes.find((attr) => nameKey(attr.name) === key) ??
        null
    );
}

/** A value for display and prompts: lists joined with ", ". */
export function formatValue(value: AttributeValue | null | undefined): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
}

/** Equal values (lists as sets, case-sensitive canonical spellings). */
export function valuesEqual(a: AttributeValue | null | undefined, b: AttributeValue | null | undefined): boolean {
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        const set = new Set(a);
        return b.every((item) => set.has(item));
    }
    return a === b;
}

/* ------------------------------------------------------------------ validation */

export type ValueResult = { ok: true; value: AttributeValue; clamped: boolean } | { ok: false; reason: string };

function listItems(attr: AttributeDef, raw: unknown): string[] | null {
    const options = attr.options ?? [];
    const exact = (item: string) => options.find((option) => sameName(option, item));
    let items: string[];
    if (Array.isArray(raw)) items = raw.map((item) => (typeof item === 'number' ? String(item) : str(item)));
    else if (typeof raw === 'string') {
        const whole = raw.trim();
        items = !whole ? [] : exact(whole) || !/[,;]/.test(whole) ? [whole] : whole.split(/\s*[,;]\s*/);
    } else if (typeof raw === 'number') items = [String(raw)];
    else return null;
    return items.map((item) => item.replace(/^["'«»“”]+|["'«»“”]+$/g, '').trim()).filter(Boolean);
}

function scaleIndex(attr: AttributeDef, raw: unknown): number | null {
    const levels = attr.levels ?? [];
    if (typeof raw === 'string') {
        const index = levels.findIndex((level) => sameName(level, raw));
        if (index >= 0) return index;
    }
    const number = toNumber(raw);
    return number !== null && Number.isInteger(number) ? number : null;
}

/** Validates (and clamps) an absolute value for an attribute. */
export function normalizeValue(attr: AttributeDef, raw: unknown): ValueResult {
    switch (attr.kind) {
        case 'number': {
            const number = toNumber(raw);
            if (number === null) return { ok: false, reason: 'number' };
            return { ok: true, ...clampNumber(attr, number) };
        }
        case 'scale': {
            const levels = attr.levels ?? [];
            if (!levels.length) return { ok: false, reason: 'levels' };
            const index = scaleIndex(attr, raw);
            if (index === null) return { ok: false, reason: 'level' };
            const clampedIndex = Math.min(levels.length - 1, Math.max(0, index));
            return { ok: true, value: levels[clampedIndex] as string, clamped: clampedIndex !== index };
        }
        case 'list': {
            const items = listItems(attr, raw);
            if (items === null) return { ok: false, reason: 'list' };
            const options = attr.options ?? [];
            const known: string[] = [];
            let unknown = 0;
            for (const item of items) {
                const option = options.length ? options.find((candidate) => sameName(candidate, item)) : item;
                if (option === undefined) unknown++;
                else if (!known.some((existing) => sameName(existing, option))) known.push(option);
            }
            if (unknown && !known.length) return { ok: false, reason: 'option' };
            const value = attr.multi ? known : known.slice(-1);
            return { ok: true, value, clamped: unknown > 0 || value.length !== known.length };
        }
        default: {
            if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, reason: 'text' };
            const text = String(raw).replace(/\s+/g, ' ').trim();
            const value = text.length > STATE_LIMITS.text ? text.slice(0, STATE_LIMITS.text) : text;
            return { ok: true, value, clamped: value !== text };
        }
    }
}

/** The value after a change: absolute (validated) or a delta (numbers add, scales step, lists add options). */
export function nextValue(
    attr: AttributeDef,
    current: AttributeValue | null,
    value: AttributeValue,
    delta = false,
    op?: ChangeSpec['op'],
): ValueResult {
    if (op === 'mul') {
        const factor = toNumber(value);
        const base = toNumber(current) ?? toNumber(initialValueOf(attr));
        if (attr.kind !== 'number' || factor === null || base === null) return { ok: false, reason: 'op' };
        return { ok: true, ...clampNumber(attr, base * factor) };
    }
    if (op === 'push' || op === 'pull') {
        if (attr.kind !== 'list') return { ok: false, reason: 'op' };
        const base = Array.isArray(current) ? current : [];
        const items = listItems(attr, value) ?? [];
        if (op === 'push') return normalizeValue(attr, attr.multi ? [...base, ...items] : items);
        return { ok: true, value: base.filter((item) => !items.some((gone) => sameName(gone, item))), clamped: false };
    }
    if (!delta) return normalizeValue(attr, value);
    switch (attr.kind) {
        case 'number': {
            const step = toNumber(value);
            if (step === null) return { ok: false, reason: 'number' };
            const base = toNumber(current) ?? (initialValueOf(attr) as number);
            return { ok: true, ...clampNumber(attr, base + step) };
        }
        case 'scale': {
            const step = toNumber(value);
            if (step === null || !Number.isInteger(step)) return { ok: false, reason: 'level' };
            const base = scaleIndex(attr, current ?? initialValueOf(attr));
            return normalizeValue(attr, (base ?? 0) + step);
        }
        case 'list': {
            const base = Array.isArray(current) ? current : [];
            const added = listItems(attr, value) ?? [];
            return normalizeValue(attr, attr.multi ? [...base, ...added] : added);
        }
        default:
            return { ok: false, reason: 'delta' };
    }
}

/** Initial values of every stored attribute of a mechanic for a new holder (derived ones are computed, not stored). */
export function initialValues(def: Pick<MechanicDef, 'attributes'>): Record<string, AttributeValue> {
    const values: Record<string, AttributeValue> = {};
    for (const attr of def.attributes) if (!attr.formula) values[attr.id] = initialValueOf(attr);
    return values;
}

/* ------------------------------------------------------------------ holders */

export interface HolderContext {
    /** The persona's name (`name1`). */
    persona: string;
    /** Canonical character name for any name, alias or case form (the world model), when known. */
    canonical?: (name: string) => string | undefined;
    /** Enemies of the fight: holders of character mechanics even when nobody else knows them. */
    extra?: readonly string[];
}

const USER_ALIASES = new Set(['user', '{{user}}', 'persona', 'player', 'you', 'игрок', 'персона']);
const WORLD_ALIASES = new Set(['world', 'the world', 'global', 'мир', 'весь мир']);
export const WORLD_HOLDER = 'world';

function cleanHolder(raw: string): string {
    return raw
        .replace(/^[\s"'«»“”*_`[(]+|[\s"'«»“”*_`\])]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The holder of a mechanic a raw name stands for (canonical spelling), or null when the mechanic has no such holder:
 * persona → the persona; characters → any name (the persona only with `includePersona`); named and factions → one of
 * the listed names; world → 'world'.
 */
export function resolveHolder(
    def: Pick<MechanicDef, 'id' | 'name' | 'holders'>,
    raw: string,
    context: HolderContext,
): string | null {
    const name = cleanHolder(String(raw ?? ''));
    if (!name) return null;
    const canonical = (value: string): string => {
        try {
            return context.canonical?.(value) ?? value;
        } catch {
            return value;
        }
    };
    const persona = context.persona.trim();
    const isPersona =
        USER_ALIASES.has(name.toLowerCase()) ||
        (!!persona && (sameName(name, persona) || sameName(canonical(name), persona)));
    const among = (names: readonly string[]): string | null => {
        const wanted = [name, canonical(name)];
        for (const candidate of names) {
            const forms = [candidate, canonical(candidate)];
            if (forms.some((form) => wanted.some((value) => sameName(form, value)))) return candidate;
            if (isPersona && persona && sameName(candidate, persona)) return candidate;
        }
        return null;
    };
    const spec: HolderSpec = def.holders;
    switch (spec.kind) {
        case 'persona':
            return isPersona ? persona || 'User' : null;
        case 'characters':
            if (isPersona) return spec.includePersona ? persona || 'User' : null;
            return canonical(name);
        case 'named':
            return among(spec.names) ?? among(context.extra ?? []);
        case 'factions':
            return among(spec.names);
        case 'world':
            return WORLD_ALIASES.has(name.toLowerCase()) || sameName(name, def.id) || sameName(name, def.name)
                ? WORLD_HOLDER
                : null;
    }
}

/** The stored holder key matching a name (case-insensitive), or null. */
export function storedHolderKey(doc: MechanicsStateDoc, mechanicId: string, name: string): string | null {
    const holders = doc.holders[mechanicId];
    if (!holders) return null;
    if (Object.hasOwn(holders, name)) return name;
    return Object.keys(holders).find((key) => sameName(key, name)) ?? null;
}

/** The key of a per-holder record (statuses, items) matching a name, or the name itself. */
export function recordKey(records: Record<string, unknown>, name: string): string {
    if (Object.hasOwn(records, name)) return name;
    return Object.keys(records).find((key) => sameName(key, name)) ?? cleanHolder(name);
}

/** Current stored value: stored, else the attribute's initial value (derived attributes: see readValues). */
export function currentValue(
    doc: MechanicsStateDoc,
    def: Pick<MechanicDef, 'id' | 'attributes'>,
    holder: string,
    attr: AttributeDef,
): AttributeValue {
    const key = storedHolderKey(doc, def.id, holder);
    const stored = key ? doc.holders[def.id]?.[key]?.values[attr.id] : undefined;
    return stored ?? initialValueOf(attr);
}

/** The statuses of a holder (empty when none). */
export function statusesOf(doc: MechanicsStateDoc, holder: string): StatusState[] {
    const key = recordKey(doc.statuses, holder);
    return doc.statuses[key] ?? [];
}

/** The items of a holder (empty when none). */
export function itemsOf(doc: MechanicsStateDoc, holder: string): ItemState[] {
    const key = recordKey(doc.items, holder);
    return doc.items[key] ?? [];
}

export function revealKey(mechanicId: string, holder: string, attribute: string): string {
    return `${mechanicId}|${nameKey(holder)}|${attribute}`;
}

/** A hidden attribute was revealed for this holder (or for every holder: holder '*'). */
export function isRevealed(doc: MechanicsStateDoc, mechanicId: string, holder: string, attribute: string): boolean {
    return (
        doc.revealed[revealKey(mechanicId, holder, attribute)] === true ||
        doc.revealed[revealKey(mechanicId, '*', attribute)] === true
    );
}

/* ------------------------------------------------------------------ reading values (derived, effective) */

export interface ValueBreakdown {
    /** Stored (or initial) value; derived attributes: the formula's result. */
    base: number;
    /** With the modifiers of statuses and equipped items. */
    value: number;
    parts: { from: 'status' | 'item'; name: string; amount: number }[];
    /** References of a formula that had no value. */
    missing?: string[];
}

export interface ValueReader {
    /** The stored / initial / derived value (no modifiers). */
    raw(mechanicId: string, holder: string, attribute: string): AttributeValue | null;
    /** A number with modifiers: numbers, derived numbers, scales as their level index; null otherwise. */
    number(mechanicId: string, holder: string, attribute: string): number | null;
    breakdown(mechanicId: string, holder: string, attribute: string): ValueBreakdown | null;
}

/** Ids a status or item modifier may use for an attribute. */
export function attributeModifierIds(mechanicId: string, attribute: string): string[] {
    return [attribute, `${mechanicId}.${attribute}`];
}

/** Ids a status or item modifier may use for a check (a bare id only when no attribute has it). */
export function checkModifierIds(def: Pick<MechanicDef, 'id' | 'attributes'>, checkId: string): string[] {
    const ids = [`check:${checkId}`, `check:${def.id}.${checkId}`, 'checks'];
    if (!def.attributes.some((attr) => attr.id === checkId)) ids.push(checkId, `${def.id}.${checkId}`);
    return ids;
}

/** Reads values of the document: derived formulas (cycles give 0), status and item modifiers. */
export function valueReader(doc: MechanicsStateDoc, getDef: (id: string) => MechanicDef | null): ValueReader {
    const computing = new Set<string>();
    const raw = (mechanicId: string, holder: string, attribute: string): AttributeValue | null => {
        const def = getDef(mechanicId);
        const attr = def ? findAttribute(def, attribute) : null;
        if (!def || !attr) return null;
        if (attr.formula) return derived(def, holder, attr).value;
        return currentValue(doc, def, holder, attr);
    };
    const derived = (def: MechanicDef, holder: string, attr: AttributeDef): { value: number; missing: string[] } => {
        const key = `${def.id}|${nameKey(holder)}|${attr.id}`;
        if (computing.has(key)) return { value: 0, missing: [attr.id] };
        const parsed = parseFormula(attr.formula ?? '');
        if (!parsed.ok) return { value: toNumber(initialValueOf(attr)) ?? 0, missing: [] };
        computing.add(key);
        try {
            const result = evaluateFormula(parsed.ast, {
                ref: (path) =>
                    path.length === 1
                        ? number(def.id, holder, path[0] as string)
                        : number(path[0] as string, holder, path[1] as string),
            });
            return { value: clampNumber(attr, result.value).value, missing: result.missing };
        } finally {
            computing.delete(key);
        }
    };
    const breakdown = (mechanicId: string, holder: string, attribute: string): ValueBreakdown | null => {
        const def = getDef(mechanicId);
        const attr = def ? findAttribute(def, attribute) : null;
        if (!def || !attr) return null;
        let base: number | null;
        let missing: string[] | undefined;
        if (attr.formula) {
            const result = derived(def, holder, attr);
            base = result.value;
            if (result.missing.length) missing = result.missing;
        } else if (attr.kind === 'scale') {
            const value = currentValue(doc, def, holder, attr);
            const index = scaleIndex(attr, value);
            base = index;
        } else base = toNumber(currentValue(doc, def, holder, attr));
        if (base === null) return null;
        const mods =
            attr.kind === 'number'
                ? modifierSum(statusesOf(doc, holder), itemsOf(doc, holder), attributeModifierIds(def.id, attr.id))
                : { total: 0, parts: [] };
        const out: ValueBreakdown = { base, value: round(base + mods.total), parts: mods.parts };
        if (missing) out.missing = missing;
        return out;
    };
    const number = (mechanicId: string, holder: string, attribute: string): number | null =>
        breakdown(mechanicId, holder, attribute)?.value ?? null;
    return { raw, number, breakdown };
}

/* ------------------------------------------------------------------ events */

export function eventKey(mechanicId: string, holder: string, attribute: string, eventId: string): string {
    return `${mechanicId}|${nameKey(holder)}|${attribute}|${eventId}`;
}

function compare(op: '<=' | '>=' | '=', left: number, right: number): boolean {
    if (op === '<=') return left <= right;
    if (op === '>=') return left >= right;
    return left === right;
}

/** The condition of an event for a value. */
export function eventCondition(attr: AttributeDef, when: AttributeEvent['when'], value: AttributeValue): boolean {
    if (when.op === 'changed') {
        if (when.value === undefined || when.value === '') return true;
        if (attr.kind === 'list')
            return Array.isArray(value) && value.some((item) => sameName(item, String(when.value)));
        if (attr.kind === 'number') return toNumber(value) === toNumber(when.value);
        return sameName(formatValue(value), String(when.value));
    }
    const op = when.op;
    if (when.value === undefined) return false;
    switch (attr.kind) {
        case 'number': {
            const left = toNumber(value);
            const right = toNumber(when.value);
            return left !== null && right !== null && compare(op, left, right);
        }
        case 'scale': {
            const left = scaleIndex(attr, value);
            const right = scaleIndex(attr, when.value);
            return left !== null && right !== null && compare(op, left, right);
        }
        case 'list': {
            const items = Array.isArray(value) ? value : [];
            const size = toNumber(when.value);
            if (size !== null) return compare(op, items.length, size);
            return op !== '<=' && items.some((item) => sameName(item, String(when.value)));
        }
        default:
            return op === '=' && sameName(formatValue(value), String(when.value));
    }
}

export interface EventOutcome {
    fire: boolean;
    /** New latch state; undefined when the event does not latch ('changed'). */
    latch?: boolean;
}

/** Whether an event fires on a change to `value` (with its latch before), and its latch after. */
export function evaluateEvent(
    attr: AttributeDef,
    event: AttributeEvent,
    value: AttributeValue,
    latched: boolean,
): EventOutcome {
    const condition = eventCondition(attr, event.when, value);
    if (event.when.op === 'changed') return { fire: condition };
    if (!condition) return { fire: false, latch: false };
    if (event.once === false) return { fire: true, latch: true };
    return { fire: !latched, latch: true };
}

/** The event note with {holder}, {value} and {attribute} filled in. */
export function fillEventText(text: string, holder: string, value: AttributeValue, attribute = ''): string {
    return text
        .replace(/\{holder\}/gi, holder)
        .replace(/\{value\}/gi, formatValue(value))
        .replace(/\{attribute\}/gi, attribute);
}

/* ------------------------------------------------------------------ the document */

export function emptyStateDoc(): MechanicsStateDoc {
    return {
        version: 1,
        holders: {},
        log: [],
        latched: {},
        fired: [],
        statuses: {},
        items: {},
        revealed: {},
        combat: null,
        clock: null,
        clockHistory: [],
        lastTurn: -1,
    };
}

function isValue(value: unknown): value is AttributeValue {
    return (
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'string' ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    );
}

function isSource(value: unknown): value is ChangeSource {
    return typeof value === 'string' && (CHANGE_SOURCES as readonly string[]).includes(value);
}

function int(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

const KINDS: readonly ChangeKind[] = ['value', 'status', 'item', 'reveal', 'combat'];

function readClock(raw: unknown): ClockRecord | null {
    if (!isDict(raw) || typeof raw.day !== 'number' || !Number.isFinite(raw.day)) return null;
    const clock: ClockRecord = { day: Math.trunc(raw.day), label: typeof raw.label === 'string' ? raw.label : '' };
    if (typeof raw.minutes === 'number' && Number.isFinite(raw.minutes)) clock.minutes = Math.trunc(raw.minutes);
    if (typeof raw.time === 'string' && raw.time) clock.time = raw.time;
    if (typeof raw.weekday === 'number' && Number.isInteger(raw.weekday)) clock.weekday = raw.weekday;
    const anchor = raw.anchor;
    if (
        isDict(anchor) &&
        (anchor.kind === 'day' || anchor.kind === 'date') &&
        typeof anchor.n === 'number' &&
        typeof anchor.key === 'string' &&
        typeof anchor.day === 'number'
    ) {
        clock.anchor = { kind: anchor.kind, n: anchor.n, key: anchor.key, day: anchor.day };
        if (typeof anchor.abs === 'number') clock.anchor.abs = anchor.abs;
    }
    return clock;
}

function readChange(raw: unknown): LoggedChange | null {
    if (!isDict(raw)) return null;
    const { id, mechanicId, holder, attribute, to, source } = raw;
    if (typeof id !== 'string' || typeof mechanicId !== 'string' || typeof holder !== 'string') return null;
    if (typeof attribute !== 'string' || !isValue(to) || !isSource(source)) return null;
    const change: LoggedChange = {
        id,
        mechanicId,
        holder,
        attribute,
        from: isValue(raw.from) ? raw.from : null,
        to,
        source,
        messageIndex: int(raw.messageIndex, -1),
        at: int(raw.at, 0),
    };
    if (typeof raw.reason === 'string' && raw.reason) change.reason = raw.reason;
    if (isDict(raw.latch)) {
        const latch: Record<string, boolean> = {};
        for (const [key, value] of Object.entries(raw.latch)) if (typeof value === 'boolean') latch[key] = value;
        if (Object.keys(latch).length) change.latch = latch;
    }
    if (raw.created === true) change.created = true;
    if (typeof raw.prevUpdatedAt === 'number') change.prevUpdatedAt = int(raw.prevUpdatedAt, -1);
    const kind = KINDS.includes(raw.kind as ChangeKind) ? (raw.kind as ChangeKind) : 'value';
    if (kind !== 'value') change.kind = kind;
    if (typeof raw.rollId === 'string' && raw.rollId) change.rollId = raw.rollId;
    if (typeof raw.batch === 'string' && raw.batch) change.batch = raw.batch;
    if (kind === 'status') {
        change.statusBefore = raw.statusBefore === null ? null : readStatus(raw.statusBefore);
        change.statusAfter = raw.statusAfter === null ? null : readStatus(raw.statusAfter);
        const shown = change.statusAfter ?? change.statusBefore;
        if (shown) change.status = shown;
    } else if (kind === 'item') {
        change.itemBefore = raw.itemBefore === null ? null : readItem(raw.itemBefore);
        change.itemAfter = raw.itemAfter === null ? null : readItem(raw.itemAfter);
        const shown = change.itemAfter ?? change.itemBefore;
        if (shown) change.item = shown;
    } else if (kind === 'reveal') {
        change.revealBefore = raw.revealBefore === true;
    } else if (kind === 'combat') {
        change.combatBefore = raw.combatBefore === null ? null : readCombat(raw.combatBefore);
        change.combatAfter = raw.combatAfter === null ? null : readCombat(raw.combatAfter);
    }
    return change;
}

function readEvent(raw: unknown): StoredEvent | null {
    if (!isDict(raw)) return null;
    const { id, changeId, mechanicId, holder, attribute, eventId, text } = raw;
    for (const field of [id, changeId, mechanicId, holder, attribute, eventId, text]) {
        if (typeof field !== 'string') return null;
    }
    return {
        id: id as string,
        changeId: changeId as string,
        mechanicId: mechanicId as string,
        holder: holder as string,
        attribute: attribute as string,
        eventId: eventId as string,
        text: text as string,
        messageIndex: int(raw.messageIndex, -1),
        at: int(raw.at, 0),
        delivered: raw.delivered === true,
    };
}

function readRecords<T>(raw: unknown, read: (item: unknown) => T | null): Record<string, T[]> {
    const out: Record<string, T[]> = {};
    if (!isDict(raw)) return out;
    for (const [holder, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        const items = list.map(read).filter((item): item is T => item !== null);
        if (items.length) out[holder] = items;
    }
    return out;
}

/** A stored document repaired (unknown or broken parts dropped). */
export function normalizeStateDoc(raw: unknown): MechanicsStateDoc {
    const doc = emptyStateDoc();
    if (!isDict(raw)) return doc;
    if (isDict(raw.holders)) {
        for (const [mechanicId, holders] of Object.entries(raw.holders)) {
            if (!isDict(holders)) continue;
            const out: Record<string, StoredHolder> = {};
            for (const [name, holder] of Object.entries(holders)) {
                if (!isDict(holder) || !isDict(holder.values)) continue;
                const values: Record<string, AttributeValue> = {};
                for (const [attr, value] of Object.entries(holder.values)) if (isValue(value)) values[attr] = value;
                out[name] = { values, updatedAt: int(holder.updatedAt, -1) };
            }
            if (Object.keys(out).length) doc.holders[mechanicId] = out;
        }
    }
    if (Array.isArray(raw.log)) {
        for (const item of raw.log) {
            const change = readChange(item);
            if (change) doc.log.push(change);
        }
    }
    if (isDict(raw.latched)) {
        for (const [key, value] of Object.entries(raw.latched)) if (value === true) doc.latched[key] = true;
    }
    if (Array.isArray(raw.fired)) {
        for (const item of raw.fired) {
            const event = readEvent(item);
            if (event) doc.fired.push(event);
        }
    }
    doc.statuses = readRecords(raw.statuses, readStatus);
    doc.items = readRecords(raw.items, readItem);
    if (isDict(raw.revealed)) {
        for (const [key, value] of Object.entries(raw.revealed)) if (value === true) doc.revealed[key] = true;
    }
    doc.combat = readCombat(raw.combat);
    doc.clock = readClock(raw.clock);
    if (Array.isArray(raw.clockHistory)) {
        for (const item of raw.clockHistory) {
            if (!isDict(item)) continue;
            const clock = readClock(item.clock);
            if (clock && typeof item.index === 'number') doc.clockHistory.push({ index: int(item.index, -1), clock });
        }
    }
    doc.lastTurn = int(raw.lastTurn, -1);
    return doc;
}

/** Keeps the newest log entries and events within the limits. */
export function capStateDoc(doc: MechanicsStateDoc, limits: { log?: number; fired?: number } = {}): void {
    const log = limits.log ?? STATE_LIMITS.log;
    const fired = limits.fired ?? STATE_LIMITS.fired;
    if (doc.log.length > log) doc.log.splice(0, doc.log.length - log);
    if (doc.fired.length > fired) doc.fired.splice(0, doc.fired.length - fired);
    if (doc.clockHistory.length > STATE_LIMITS.clockHistory) {
        doc.clockHistory.splice(0, doc.clockHistory.length - STATE_LIMITS.clockHistory);
    }
}

/** The public shape of a logged change (bookkeeping dropped). */
export function publicChange(change: LoggedChange): StateChangeData {
    const out: StateChangeData = {
        id: change.id,
        mechanicId: change.mechanicId,
        holder: change.holder,
        attribute: change.attribute,
        from: change.from,
        to: change.to,
        source: change.source,
        messageIndex: change.messageIndex,
        at: change.at,
    };
    if (change.reason) out.reason = change.reason;
    if (change.kind) out.kind = change.kind;
    if (change.rollId) out.rollId = change.rollId;
    if (change.batch) out.batch = change.batch;
    if (change.status) out.status = structuredClone(change.status);
    if (change.item) out.item = structuredClone(change.item);
    return out;
}

export function publicEvent(event: StoredEvent): FiredEventData {
    return {
        mechanicId: event.mechanicId,
        holder: event.holder,
        attribute: event.attribute,
        eventId: event.eventId,
        text: event.text,
        messageIndex: event.messageIndex,
        at: event.at,
    };
}

/* ------------------------------------------------------------------ applying */

export type RejectReason =
    | 'mechanic'
    | 'attribute'
    | 'holder'
    | 'number'
    | 'level'
    | 'levels'
    | 'derived'
    | 'item'
    | 'status'
    | 'combat'
    | 'limit'
    | string;

export interface ApplyOptions {
    getDef: (id: string) => MechanicDef | null;
    now: number;
    newId: () => string;
    /** For event actions: the persona, canonical names, the fight's enemies. */
    holders?: HolderContext;
    /** Statuses of every active mechanic (a status named in a block finds its duration and modifiers there). */
    catalogue?: readonly StatusSpec[];
    /** Dice in event actions. */
    rng?: Rng;
    /** The story clock now (statuses lasting until a moment). */
    clock?: StoryTime | null;
}

export interface ApplyResult {
    applied: LoggedChange[];
    fired: StoredEvent[];
    rejected: { input: OpInput; reason: RejectReason }[];
    /** Valid changes that left the value as it was. */
    unchanged: OpInput[];
}

function clip(text: string | undefined, max: number): string | undefined {
    const value = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return undefined;
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

interface Pending {
    op: OpInput;
    depth: number;
}

interface Runner {
    doc: MechanicsStateDoc;
    options: ApplyOptions;
    result: ApplyResult;
    queue: Pending[];
    /** Events fired in this application (loop guard). */
    fired: Set<string>;
}

function baseChange(
    runner: Runner,
    op: OpBase,
    fields: Omit<LoggedChange, 'id' | 'source' | 'messageIndex' | 'at'>,
): LoggedChange {
    const change: LoggedChange = {
        id: runner.options.newId(),
        ...fields,
        source: op.source,
        messageIndex: Number.isInteger(op.messageIndex) ? op.messageIndex : -1,
        at: runner.options.now,
    };
    const reason = clip(op.reason, STATE_LIMITS.reason);
    if (reason) change.reason = reason;
    if (op.rollId) change.rollId = op.rollId;
    if (op.batch) change.batch = op.batch;
    return change;
}

function pushFired(
    runner: Runner,
    change: LoggedChange,
    fields: Pick<StoredEvent, 'mechanicId' | 'holder' | 'attribute' | 'eventId' | 'text'>,
): StoredEvent {
    const fired: StoredEvent = {
        id: runner.options.newId(),
        changeId: change.id,
        ...fields,
        messageIndex: change.messageIndex,
        at: runner.options.now,
        delivered: false,
    };
    runner.doc.fired.push(fired);
    runner.result.fired.push(fired);
    return fired;
}

/** Event actions and chains are queued right after the change that fired them. */
function followEvent(
    runner: Runner,
    def: MechanicDef,
    attr: AttributeDef,
    event: AttributeEvent,
    holder: string,
    op: OpBase,
    depth: number,
): void {
    if (depth >= DEPTH_LIMIT) return;
    const context = runner.options.holders ?? { persona: '' };
    const reader = valueReader(runner.doc, runner.options.getDef);
    const next: OpBase = { source: 'event', messageIndex: op.messageIndex };
    if (op.rollId) next.rollId = op.rollId;
    if (op.batch) next.batch = op.batch;
    const followUps: OpInput[] = [];
    if (event.actions?.length) {
        const resolved = resolveActions(event.actions, {
            def,
            actor: holder,
            persona: context.persona,
            getDef: runner.options.getDef,
            resolveHolder: (target, raw) => resolveHolder(target, raw, context),
            numberOf: (mechanicId, who, attribute) => reader.number(mechanicId, who, attribute),
            ...(runner.options.rng ? { rng: runner.options.rng } : {}),
            base: { ...next, reason: event.id },
        });
        followUps.push(...resolved.ops);
    }
    runner.queue.unshift(...followUps.map((item) => ({ op: item, depth: depth + 1 })));
    if (event.chain) {
        const target = findChainEvent(def, event.chain);
        if (target) fireChained(runner, def, target.attribute, target.event, holder, next, depth + 1, attr);
    }
}

/** A chained event fires whatever its condition (no latch), once per application. */
function fireChained(
    runner: Runner,
    def: MechanicDef,
    attr: AttributeDef,
    event: AttributeEvent,
    holder: string,
    op: OpBase,
    depth: number,
    from: AttributeDef,
): void {
    const key = eventKey(def.id, holder, attr.id, event.id);
    if (runner.fired.has(key) || depth > DEPTH_LIMIT) return;
    runner.fired.add(key);
    const anchor = runner.result.applied[runner.result.applied.length - 1];
    if (anchor && event.text.trim()) {
        const value = valueReader(runner.doc, runner.options.getDef).raw(def.id, holder, attr.id) ?? '';
        pushFired(runner, anchor, {
            mechanicId: def.id,
            holder,
            attribute: attr.id,
            eventId: event.id,
            text: fillEventText(event.text, holder, value, attr.promptName || from.promptName),
        });
    }
    followEvent(runner, def, attr, event, holder, op, depth);
}

function applyValue(runner: Runner, input: ChangeInputData, depth: number): void {
    const { doc, options, result } = runner;
    const def = options.getDef(input.mechanicId);
    if (!def) {
        result.rejected.push({ input, reason: 'mechanic' });
        return;
    }
    const attr = findAttribute(def, input.attribute);
    if (!attr) {
        result.rejected.push({ input, reason: 'attribute' });
        return;
    }
    if (attr.formula) {
        result.rejected.push({ input, reason: 'derived' });
        return;
    }
    const name = cleanHolder(String(input.holder ?? ''));
    if (!name) {
        result.rejected.push({ input, reason: 'holder' });
        return;
    }
    const existing = storedHolderKey(doc, def.id, name);
    const holderName = existing ?? name;
    const stored = existing ? doc.holders[def.id]?.[existing] : undefined;
    const from: AttributeValue | null = stored ? (stored.values[attr.id] ?? null) : null;
    const base = from ?? initialValueOf(attr);
    const next = nextValue(attr, base, input.value, input.delta === true, input.op);
    if (!next.ok) {
        result.rejected.push({ input, reason: next.reason });
        return;
    }
    if (valuesEqual(base, next.value)) {
        result.unchanged.push(input);
        return;
    }
    let holder = stored;
    const created = !holder;
    if (!holder) {
        holder = { values: initialValues(def), updatedAt: -1 };
        (doc.holders[def.id] ??= {})[holderName] = holder;
    }
    const change = baseChange(runner, input, {
        mechanicId: def.id,
        holder: holderName,
        attribute: attr.id,
        from: created ? initialValueOf(attr) : from,
        to: next.value,
        prevUpdatedAt: holder.updatedAt,
    });
    if (created) change.created = true;
    holder.values[attr.id] = next.value;
    if (change.messageIndex >= 0) holder.updatedAt = Math.max(holder.updatedAt, change.messageIndex);
    doc.log.push(change);
    result.applied.push(change);
    const follow: AttributeEvent[] = [];
    for (const event of attr.events ?? []) {
        const key = eventKey(def.id, holderName, attr.id, event.id);
        const before = doc.latched[key] === true;
        const outcome = evaluateEvent(attr, event, next.value, before);
        if (outcome.latch !== undefined && outcome.latch !== before) {
            (change.latch ??= {})[key] = before;
            if (outcome.latch) doc.latched[key] = true;
            else delete doc.latched[key];
        }
        if (!outcome.fire || runner.fired.has(key)) continue;
        runner.fired.add(key);
        if (event.text.trim()) {
            pushFired(runner, change, {
                mechanicId: def.id,
                holder: holderName,
                attribute: attr.id,
                eventId: event.id,
                text: fillEventText(event.text, holderName, next.value, attr.promptName),
            });
        }
        follow.push(event);
    }
    // Follow-ups run after this change and before the rest of the queue (newest event first in the queue).
    for (const event of [...follow].reverse()) followEvent(runner, def, attr, event, holderName, input, depth);
    progress(runner, def, attr, holderName, input, depth);
}

/** A change of a progression's XP: the level follows, `onLevelUp` runs once per level gained. */
function progress(
    runner: Runner,
    def: MechanicDef,
    attr: AttributeDef,
    holder: string,
    op: OpBase,
    depth: number,
): void {
    const progression = def.progression;
    if (!progression || progression.xp !== attr.id || depth >= DEPTH_LIMIT) return;
    const levelAttr = findAttribute(def, progression.level);
    if (!levelAttr || levelAttr.formula) return;
    const xp = toNumber(currentValue(runner.doc, def, holder, attr)) ?? 0;
    const current = toNumber(currentValue(runner.doc, def, holder, levelAttr)) ?? 1;
    const target = levelFor(xp, progression.thresholds);
    if (target <= current) return;
    const next: OpBase = { source: 'event', messageIndex: op.messageIndex, reason: 'level up' };
    if (op.rollId) next.rollId = op.rollId;
    if (op.batch) next.batch = op.batch;
    const ops: OpInput[] = [{ ...next, mechanicId: def.id, holder, attribute: levelAttr.id, value: target }];
    if (progression.onLevelUp?.length) {
        const context = runner.options.holders ?? { persona: '' };
        const reader = valueReader(runner.doc, runner.options.getDef);
        for (let level = current + 1; level <= target; level++) {
            const resolved = resolveActions(progression.onLevelUp, {
                def,
                actor: holder,
                persona: context.persona,
                getDef: runner.options.getDef,
                resolveHolder: (target2, raw) => resolveHolder(target2, raw, context),
                numberOf: (mechanicId, who, attribute) => reader.number(mechanicId, who, attribute),
                ...(runner.options.rng ? { rng: runner.options.rng } : {}),
                base: next,
            });
            ops.push(...resolved.ops);
        }
    }
    runner.queue.unshift(...ops.map((item) => ({ op: item, depth: depth + 1 })));
}

function statusCatalogue(runner: Runner, mechanicId: string): StatusSpec[] {
    const own = runner.options.getDef(mechanicId)?.statuses ?? [];
    return [...own, ...(runner.options.catalogue ?? [])];
}

function holderOf(runner: Runner, mechanicId: string, raw: string): string {
    const name = cleanHolder(raw);
    const def = runner.options.getDef(mechanicId);
    const key = def ? storedHolderKey(runner.doc, def.id, name) : null;
    return key ?? name;
}

function statusLabel(status: StatusState): string {
    return status.stacks > 1 ? `${status.name} x${status.stacks}` : status.name;
}

function remainingValue(status: StatusState): AttributeValue {
    if (status.remaining?.turns !== undefined) return status.remaining.turns;
    if (status.remaining?.minutes !== undefined) return status.remaining.minutes;
    return statusLabel(status);
}

function applyStatusOp(runner: Runner, op: StatusOp): void {
    const { doc, options, result } = runner;
    const holder = holderOf(runner, op.mechanicId, op.holder);
    if (!holder) {
        result.rejected.push({ input: op, reason: 'holder' });
        return;
    }
    const key = recordKey(doc.statuses, holder);
    const list = doc.statuses[key] ?? [];
    let before: StatusState | null = null;
    let after: StatusState | null = null;
    if (op.op === 'add') {
        const spec = mergeStatusSpec(
            catalogueStatus(statusCatalogue(runner, op.mechanicId), op.status.name),
            op.status,
        );
        const outcome = applyStatus(list, spec, {
            id: options.newId(),
            source: op.source,
            since: op.messageIndex,
            at: options.now,
            mechanicId: op.mechanicId,
        });
        before = outcome.before;
        after = outcome.after;
        if (before && JSON.stringify({ ...before, at: 0 }) === JSON.stringify({ ...after, at: 0 })) {
            result.unchanged.push(op);
            return;
        }
    } else if (op.op === 'remove') {
        before = findStatus(list, op.ref);
        if (!before) {
            result.unchanged.push(op);
            return;
        }
    } else {
        before = list.find((status) => status.id === op.instance.id) ?? null;
        if (!before) {
            result.rejected.push({ input: op, reason: 'status' });
            return;
        }
        after = structuredClone(op.instance);
    }
    const next = list.filter((status) => status.id !== (before?.id ?? after?.id));
    if (after) {
        const at = before ? list.findIndex((status) => status.id === before?.id) : list.length;
        next.splice(Math.min(at, next.length), 0, after);
    }
    if (next.length) doc.statuses[key] = next;
    else delete doc.statuses[key];
    const shown = (after ?? before) as StatusState;
    const change = baseChange(runner, op, {
        mechanicId: op.mechanicId,
        holder: key,
        attribute: 'status',
        kind: 'status',
        from: before ? (op.op === 'update' ? remainingValue(before) : statusLabel(before)) : null,
        to: after ? (op.op === 'update' ? remainingValue(after) : statusLabel(after)) : '',
        statusBefore: before ? structuredClone(before) : null,
        statusAfter: after ? structuredClone(after) : null,
        status: structuredClone(shown),
    });
    doc.log.push(change);
    result.applied.push(change);
    if (op.op === 'remove' && op.expired && before) {
        pushFired(runner, change, {
            mechanicId: op.mechanicId,
            holder: key,
            attribute: 'status',
            eventId: `expired_${before.statusId}`,
            text: `${key} is no longer ${before.promptName}.`,
        });
    }
}

function applyItemOp(runner: Runner, op: ItemOp): void {
    const { doc, options, result } = runner;
    const holder = holderOf(runner, op.mechanicId, op.holder);
    if (!holder || !op.item.name.trim()) {
        result.rejected.push({ input: op, reason: holder ? 'item' : 'holder' });
        return;
    }
    const key = recordKey(doc.items, holder);
    const list = doc.items[key] ?? [];
    let outcome: { before: ItemState | null; after: ItemState | null } | null;
    if (op.op === 'give') outcome = giveItem(list, op.item, options.newId, op.qty);
    else if (op.op === 'take') outcome = takeItem(list, op.item.name, op.qty);
    else outcome = equipItem(list, op.item.name, op.slot);
    if (!outcome) {
        if (op.op === 'equip' && findItem(list, op.item.name)) result.unchanged.push(op);
        else result.rejected.push({ input: op, reason: 'item' });
        return;
    }
    const { before, after } = outcome;
    const id = before?.id ?? after?.id;
    const next = list.filter((item) => item.id !== id);
    if (after) {
        const at = before ? list.findIndex((item) => item.id === before.id) : list.length;
        next.splice(Math.min(at, next.length), 0, after);
    }
    if (next.length) doc.items[key] = next;
    else delete doc.items[key];
    const equip = op.op === 'equip';
    const change = baseChange(runner, op, {
        mechanicId: op.mechanicId,
        holder: key,
        attribute: 'item',
        kind: 'item',
        from: equip ? (before?.equipped ?? '') : (before?.qty ?? 0),
        to: equip ? (after?.equipped ?? '') : (after?.qty ?? 0),
        itemBefore: before ? structuredClone(before) : null,
        itemAfter: after ? structuredClone(after) : null,
        item: structuredClone((after ?? before) as ItemState),
    });
    doc.log.push(change);
    result.applied.push(change);
}

function applyRevealOp(runner: Runner, op: RevealOp): void {
    const { doc, result } = runner;
    const def = runner.options.getDef(op.mechanicId);
    const attr = def ? findAttribute(def, op.attribute) : null;
    if (!def || !attr) {
        result.rejected.push({ input: op, reason: def ? 'attribute' : 'mechanic' });
        return;
    }
    const holder = op.holder === '*' ? '*' : holderOf(runner, def.id, op.holder);
    const key = revealKey(def.id, holder, attr.id);
    const before = doc.revealed[key] === true;
    if (before === !op.hide) {
        result.unchanged.push(op);
        return;
    }
    if (op.hide) delete doc.revealed[key];
    else doc.revealed[key] = true;
    const change = baseChange(runner, op, {
        mechanicId: def.id,
        holder,
        attribute: attr.id,
        kind: 'reveal',
        from: before ? 'shown' : 'hidden',
        to: op.hide ? 'hidden' : 'shown',
        revealBefore: before,
    });
    doc.log.push(change);
    result.applied.push(change);
}

function combatLabel(state: CombatState | null): string {
    if (!state?.active) return 'off';
    return `round ${state.round}`;
}

function applyCombatOp(runner: Runner, op: CombatOp): void {
    const { doc, result } = runner;
    const before = doc.combat ? structuredClone(doc.combat) : null;
    let after: CombatState | null;
    let ended = false;
    let holder = '';
    if (op.op === 'set') after = op.next ? structuredClone(op.next) : null;
    else {
        if (!before?.active) {
            result.rejected.push({ input: op, reason: 'combat' });
            return;
        }
        holder = holderOf(runner, op.mechanicId, op.holder);
        if (op.op === 'join') {
            const join: { holder: string; init: number; enemy?: boolean } = { holder, init: op.init ?? 0 };
            if (op.enemy) join.enemy = true;
            after = addCombatant(before, join);
        } else {
            const outcome = markOut(before, holder);
            after = outcome.state;
            ended = outcome.ended;
            if (ended) after = endCombat(after, op.messageIndex);
        }
    }
    if (JSON.stringify(before) === JSON.stringify(after)) {
        result.unchanged.push(op);
        return;
    }
    doc.combat = after;
    const change = baseChange(runner, op, {
        mechanicId: op.mechanicId,
        holder: holder || (after?.order[0]?.holder ?? before?.order[0]?.holder ?? ''),
        attribute: 'combat',
        kind: 'combat',
        from: combatLabel(before),
        to: combatLabel(after),
        combatBefore: before,
        combatAfter: after ? structuredClone(after) : null,
    });
    doc.log.push(change);
    result.applied.push(change);
    if (before?.active && !after?.active) {
        pushFired(runner, change, {
            mechanicId: op.mechanicId,
            holder: change.holder,
            attribute: 'combat',
            eventId: 'combat_ended',
            text: ended ? 'The fight is over: every enemy is down.' : 'The fight is over.',
        });
    }
}

function applyClockOp(runner: Runner, op: ClockOp): void {
    const { doc } = runner;
    doc.lastTurn = Math.max(doc.lastTurn, op.index);
    if (!op.clock) return;
    doc.clock = { ...op.clock };
    doc.clockHistory = doc.clockHistory.filter((entry) => entry.index < op.index);
    doc.clockHistory.push({ index: op.index, clock: { ...op.clock } });
}

/**
 * Applies operations in order to the document (validated, clamped, logged, events fired with their actions and
 * chains, levels from experience). Loop guard: OPS_LIMIT operations, DEPTH_LIMIT nesting, each event once.
 */
export function applyOps(doc: MechanicsStateDoc, inputs: readonly OpInput[], options: ApplyOptions): ApplyResult {
    const runner: Runner = {
        doc,
        options,
        result: { applied: [], fired: [], rejected: [], unchanged: [] },
        queue: inputs.map((op) => ({ op, depth: 0 })),
        fired: new Set(),
    };
    let processed = 0;
    while (runner.queue.length) {
        const { op, depth } = runner.queue.shift() as Pending;
        if (++processed > OPS_LIMIT) {
            runner.result.rejected.push({ input: op, reason: 'limit' });
            continue;
        }
        switch (op.kind) {
            case 'status':
                applyStatusOp(runner, op);
                break;
            case 'item':
                applyItemOp(runner, op);
                break;
            case 'reveal':
                applyRevealOp(runner, op);
                break;
            case 'combat':
                applyCombatOp(runner, op);
                break;
            case 'clock':
                applyClockOp(runner, op);
                break;
            default:
                applyValue(runner, op, depth);
        }
    }
    return runner.result;
}

/** Applies value changes in order to the document (validated, clamped, logged, events fired). */
export function applyChanges(
    doc: MechanicsStateDoc,
    inputs: readonly ChangeInputData[],
    options: ApplyOptions,
): ApplyResult {
    return applyOps(doc, inputs, options);
}

/* ------------------------------------------------------------------ rollback */

/** What a change changed: changes of the same target revert as differences when a later one is kept. */
function targetKey(change: LoggedChange): string {
    switch (change.kind) {
        case 'status':
            return `s|${nameKey(change.holder)}|${(change.statusBefore ?? change.statusAfter)?.id ?? ''}`;
        case 'item':
            return `i|${nameKey(change.holder)}|${nameKey((change.itemBefore ?? change.itemAfter)?.name ?? '')}`;
        case 'reveal':
            return `r|${change.mechanicId}|${nameKey(change.holder)}|${change.attribute}`;
        case 'combat':
            return 'c';
        default:
            return `v|${change.mechanicId}|${nameKey(change.holder)}|${change.attribute}`;
    }
}

function sameTarget(a: LoggedChange, b: LoggedChange): boolean {
    return targetKey(a) === targetKey(b);
}

function listDiff(a: readonly string[], b: readonly string[]): string[] {
    return a.filter((item) => !b.includes(item));
}

/** The value with a change taken out of it when later changes are kept (null: cannot be reverted this way). */
function revertDifference(
    attr: AttributeDef | null,
    change: LoggedChange,
    current: AttributeValue,
): AttributeValue | null {
    if (typeof change.to === 'number' && typeof current === 'number') {
        const from = typeof change.from === 'number' ? change.from : change.to;
        const raw = current - (change.to - from);
        return attr ? clampNumber(attr, raw).value : round(raw);
    }
    if (attr?.kind === 'scale' && typeof current === 'string') {
        const to = scaleIndex(attr, change.to);
        const from = scaleIndex(attr, change.from);
        const now = scaleIndex(attr, current);
        if (to === null || from === null || now === null) return null;
        const result = normalizeValue(attr, now - (to - from));
        return result.ok ? result.value : null;
    }
    if (Array.isArray(change.to) && Array.isArray(current)) {
        const from = Array.isArray(change.from) ? change.from : [];
        const added = listDiff(change.to, from);
        const removed = listDiff(from, change.to);
        const kept = current.filter((item) => !added.includes(item));
        for (const item of removed) if (!kept.includes(item)) kept.push(item);
        return kept;
    }
    return null;
}

/** A status change taken back: exact restores the instance; else an addition goes, a removal comes back. */
function revertStatus(doc: MechanicsStateDoc, change: LoggedChange, exact: boolean): boolean {
    const key = recordKey(doc.statuses, change.holder);
    const list = [...(doc.statuses[key] ?? [])];
    const before = change.statusBefore ?? null;
    const after = change.statusAfter ?? null;
    const id = (before ?? after)?.id;
    const at = list.findIndex((status) => status.id === id);
    if (exact || !after || !before) {
        if (at >= 0) list.splice(at, 1);
        if (before) list.splice(at >= 0 ? at : list.length, 0, structuredClone(before));
    } else if (at >= 0) {
        // Later ticks are kept: give back what this change took (turns, minutes, stacks).
        const current = list[at] as StatusState;
        const remaining: { turns?: number; minutes?: number } = { ...(current.remaining ?? {}) };
        for (const part of ['turns', 'minutes'] as const) {
            const was = before.remaining?.[part];
            if (was === undefined) continue;
            remaining[part] = (current.remaining?.[part] ?? 0) + was - (after.remaining?.[part] ?? 0);
        }
        const stacks = Math.max(1, current.stacks - (after.stacks - before.stacks));
        list[at] = { ...current, remaining: Object.keys(remaining).length ? remaining : null, stacks };
    } else return false;
    if (list.length) doc.statuses[key] = list;
    else delete doc.statuses[key];
    return true;
}

/** An item change taken back: exact restores the record; else the quantity difference is taken out. */
function revertItem(doc: MechanicsStateDoc, change: LoggedChange, exact: boolean): boolean {
    const key = recordKey(doc.items, change.holder);
    const list = [...(doc.items[key] ?? [])];
    const before = change.itemBefore ?? null;
    const after = change.itemAfter ?? null;
    const name = (before ?? after)?.name ?? '';
    const at = list.findIndex((item) => nameKey(item.name) === nameKey(name));
    if (exact) {
        if (at >= 0) list.splice(at, 1);
        if (before) list.splice(at >= 0 ? at : list.length, 0, structuredClone(before));
    } else {
        const diff = (after?.qty ?? 0) - (before?.qty ?? 0);
        if (at >= 0) {
            const current = list[at] as ItemState;
            const qty = Math.round((current.qty - diff) * 100) / 100;
            if (qty <= 0) list.splice(at, 1);
            else list[at] = { ...current, qty };
        } else if (before && diff < 0) {
            list.push({ ...structuredClone(before), qty: -diff });
        } else return false;
    }
    if (list.length) doc.items[key] = list;
    else delete doc.items[key];
    return true;
}

/**
 * Takes one change out of the document. `exact` (no later change of the same target is kept): the value, the
 * holder's `updatedAt` and the latches go back to what they were. Otherwise the change is reverted as a difference;
 * texts then stay as they are. Returns false when nothing could be reverted (the log entry is removed anyway).
 */
function revertEntry(
    doc: MechanicsStateDoc,
    change: LoggedChange,
    exact: boolean,
    getDef?: (id: string) => MechanicDef | null,
): boolean {
    let reverted = false;
    let holders: Record<string, StoredHolder> | undefined;
    let key: string | null = null;
    let holder: StoredHolder | undefined;
    switch (change.kind) {
        case 'status':
            reverted = revertStatus(doc, change, exact);
            break;
        case 'item':
            reverted = revertItem(doc, change, exact);
            break;
        case 'reveal': {
            const revealed = revealKey(change.mechanicId, change.holder, change.attribute);
            if (change.revealBefore) doc.revealed[revealed] = true;
            else delete doc.revealed[revealed];
            reverted = true;
            break;
        }
        case 'combat':
            if (exact) {
                doc.combat = change.combatBefore ? structuredClone(change.combatBefore) : null;
                reverted = true;
            }
            break;
        default: {
            holders = doc.holders[change.mechanicId];
            key = holders ? storedHolderKey(doc, change.mechanicId, change.holder) : null;
            holder = key ? holders?.[key] : undefined;
            if (!holder) break;
            if (exact) {
                if (change.from === null) delete holder.values[change.attribute];
                else holder.values[change.attribute] = change.from;
                if (change.prevUpdatedAt !== undefined) holder.updatedAt = change.prevUpdatedAt;
                for (const [latchKey, before] of Object.entries(change.latch ?? {})) {
                    if (before) doc.latched[latchKey] = true;
                    else delete doc.latched[latchKey];
                }
                reverted = true;
            } else {
                const def = getDef?.(change.mechanicId) ?? null;
                const attr = def ? findAttribute(def, change.attribute) : null;
                const current = holder.values[change.attribute];
                const value = current === undefined ? null : revertDifference(attr, change, current);
                if (value !== null) {
                    holder.values[change.attribute] = value;
                    reverted = true;
                }
            }
        }
    }
    const index = doc.log.indexOf(change);
    if (index >= 0) doc.log.splice(index, 1);
    doc.fired = doc.fired.filter((event) => event.changeId !== change.id);
    if (
        holder &&
        key &&
        change.created &&
        exact &&
        !doc.log.some(
            (item) =>
                (item.kind ?? 'value') === 'value' &&
                item.mechanicId === change.mechanicId &&
                sameName(item.holder, change.holder),
        )
    ) {
        delete holders?.[key];
        if (holders && !Object.keys(holders).length) delete doc.holders[change.mechanicId];
    }
    return reverted;
}

/** Takes the matching changes out, newest first. Returns the removed changes. */
export function rollbackWhere(
    doc: MechanicsStateDoc,
    match: (change: LoggedChange) => boolean,
    getDef?: (id: string) => MechanicDef | null,
): LoggedChange[] {
    const removed: LoggedChange[] = [];
    for (let i = doc.log.length - 1; i >= 0; i--) {
        const change = doc.log[i];
        if (!change || !match(change)) continue;
        const exact = !doc.log.slice(i + 1).some((later) => sameTarget(later, change));
        revertEntry(doc, change, exact, getDef);
        removed.push(change);
    }
    return removed;
}

/** Forgets the clock and the processed turns from a message on. */
function rewindClock(doc: MechanicsStateDoc, messageIndex: number, only = false): void {
    doc.clockHistory = doc.clockHistory.filter((entry) =>
        only ? entry.index !== messageIndex : entry.index < messageIndex,
    );
    const last = doc.clockHistory[doc.clockHistory.length - 1];
    doc.clock = last ? { ...last.clock } : null;
    if (doc.lastTurn >= messageIndex) doc.lastTurn = messageIndex - 1;
}

/** A swiped or deleted reply: every change from that message on (user edits stay); the clock goes back too. */
export function rollbackFrom(
    doc: MechanicsStateDoc,
    messageIndex: number,
    getDef?: (id: string) => MechanicDef | null,
): LoggedChange[] {
    const removed = rollbackWhere(
        doc,
        (change) => change.source !== 'user' && change.messageIndex >= messageIndex,
        getDef,
    );
    rewindClock(doc, messageIndex);
    return removed;
}

/** The changes of one message from the given sources (an edited reply); its turn is processed again. */
export function rollbackMessage(
    doc: MechanicsStateDoc,
    messageIndex: number,
    sources: readonly ChangeSource[] = TRACKED_SOURCES,
    getDef?: (id: string) => MechanicDef | null,
): LoggedChange[] {
    const removed = rollbackWhere(
        doc,
        (change) => change.messageIndex === messageIndex && sources.includes(change.source),
        getDef,
    );
    if (sources.includes('time')) rewindClock(doc, messageIndex, true);
    return removed;
}

/** Locator of a change for undo: its id, or (when the id was not known yet) message, source and target. */
export interface ChangeRef {
    changeId?: string;
    mechanicId?: string;
    holder?: string;
    attribute?: string;
    messageIndex?: number;
    source?: ChangeSource;
}

/** The newest logged change a reference points to. */
export function findChange(doc: MechanicsStateDoc, ref: ChangeRef): LoggedChange | null {
    if (ref.changeId) return doc.log.find((change) => change.id === ref.changeId) ?? null;
    for (let i = doc.log.length - 1; i >= 0; i--) {
        const change = doc.log[i];
        if (!change) continue;
        if (ref.mechanicId !== undefined && change.mechanicId !== ref.mechanicId) continue;
        if (ref.attribute !== undefined && change.attribute !== ref.attribute) continue;
        if (ref.holder !== undefined && !sameName(change.holder, ref.holder)) continue;
        if (ref.messageIndex !== undefined && change.messageIndex !== ref.messageIndex) continue;
        if (ref.source !== undefined && change.source !== ref.source) continue;
        return change;
    }
    return null;
}

/**
 * Undo of one change (journal): exact when it is the newest change of its target, else reverted as a difference.
 * A text overwritten later (or a fight changed since) cannot be reverted: false, and the change stays logged.
 */
export function revertChange(
    doc: MechanicsStateDoc,
    change: LoggedChange,
    getDef?: (id: string) => MechanicDef | null,
): boolean {
    const index = doc.log.indexOf(change);
    if (index < 0) return false;
    const exact = !doc.log.slice(index + 1).some((later) => sameTarget(later, change));
    if (!exact) {
        if (change.kind === 'combat') return false;
        if ((change.kind ?? 'value') === 'value') {
            const def = getDef?.(change.mechanicId) ?? null;
            const attr = def ? findAttribute(def, change.attribute) : null;
            const key = storedHolderKey(doc, change.mechanicId, change.holder);
            const current = key ? doc.holders[change.mechanicId]?.[key]?.values[change.attribute] : undefined;
            if (current === undefined || revertDifference(attr, change, current) === null) return false;
        }
    }
    return revertEntry(doc, change, exact, getDef);
}

/* ------------------------------------------------------------------ reset */

/**
 * Operations that bring a mechanic (and/or a holder) back to the start: values to their initial ones, statuses gone,
 * items gone (only for mechanics with an inventory, or a whole holder), the fight ended. Applied as one batch.
 */
export function resetOps(
    doc: MechanicsStateDoc,
    getDef: (id: string) => MechanicDef | null,
    target: { mechanicId?: string; holder?: string },
    base: OpBase,
): OpInput[] {
    const ops: OpInput[] = [];
    const wanted = target.holder ? nameKey(target.holder) : null;
    const mechanics = target.mechanicId ? [target.mechanicId] : Object.keys(doc.holders);
    for (const mechanicId of mechanics) {
        const def = getDef(mechanicId);
        if (!def) continue;
        for (const [holder, stored] of Object.entries(doc.holders[mechanicId] ?? {})) {
            if (wanted !== null && nameKey(holder) !== wanted) continue;
            for (const attr of def.attributes) {
                if (attr.formula) continue;
                const initial = initialValueOf(attr);
                const value = stored.values[attr.id];
                if (value === undefined || valuesEqual(value, initial)) continue;
                ops.push({ ...base, mechanicId, holder, attribute: attr.id, value: initial });
            }
        }
    }
    const holderMatches = (holder: string) => wanted === null || nameKey(holder) === wanted;
    for (const [holder, list] of Object.entries(doc.statuses)) {
        if (!holderMatches(holder)) continue;
        for (const status of list) {
            if (target.mechanicId && !target.holder && status.mechanicId !== target.mechanicId) continue;
            ops.push({
                ...base,
                kind: 'status',
                op: 'remove',
                mechanicId: status.mechanicId ?? target.mechanicId ?? '',
                holder,
                ref: status.id,
            });
        }
    }
    const inventory = !target.mechanicId || !!getDef(target.mechanicId)?.inventory || !!target.holder;
    if (inventory) {
        for (const [holder, list] of Object.entries(doc.items)) {
            if (!holderMatches(holder)) continue;
            for (const item of list) {
                ops.push({
                    ...base,
                    kind: 'item',
                    op: 'take',
                    mechanicId: target.mechanicId ?? '',
                    holder,
                    item: { name: item.name },
                });
            }
        }
    }
    if (doc.combat?.active && (!target.mechanicId || doc.combat.mechanicId === target.mechanicId) && !target.holder) {
        ops.push({ ...base, kind: 'combat', op: 'set', mechanicId: target.mechanicId ?? '', next: null });
    }
    return ops;
}

/* ------------------------------------------------------------------ edits (block lines, background answers) */

/**
 * One edit as the model states it: 'set' a value; 'add' a signed number (numbers, scale steps) or an option (lists);
 * 'sub' an option (lists); 'mul' a number by a factor.
 */
export type EditOp = 'set' | 'add' | 'sub' | 'mul';

export interface Edit {
    mechanicId: string;
    holder: string;
    /** Attribute id (or any of its names). */
    attribute: string;
    op: EditOp;
    value: AttributeValue;
    reason?: string;
}

/**
 * Edits → changes in order. Numbers and scale steps stay deltas (they compose with other changes of the turn); list
 * additions and removals and multiplications become absolute values from the running value (`valueOf`: the stored
 * or initial value).
 */
export function editsToChanges(
    edits: readonly Edit[],
    getDef: (id: string) => MechanicDef | null,
    valueOf: (mechanicId: string, holder: string, attribute: string) => AttributeValue | null,
): { changes: ChangeSpec[]; rejected: { edit: Edit; reason: string }[] } {
    const changes: ChangeSpec[] = [];
    const rejected: { edit: Edit; reason: string }[] = [];
    const running = new Map<string, AttributeValue>();
    for (const edit of edits) {
        const def = getDef(edit.mechanicId);
        const attr = def ? findAttribute(def, edit.attribute) : null;
        if (!def || !attr) {
            rejected.push({ edit, reason: def ? 'attribute' : 'mechanic' });
            continue;
        }
        if (attr.formula) {
            rejected.push({ edit, reason: 'derived' });
            continue;
        }
        const key = `${def.id}|${nameKey(edit.holder)}|${attr.id}`;
        const current = running.get(key) ?? valueOf(def.id, edit.holder, attr.id) ?? initialValueOf(attr);
        let spec: ChangeSpec | null = null;
        let reason = '';
        const numeric = toNumber(edit.value);
        switch (edit.op) {
            case 'set':
                spec = { mechanicId: def.id, holder: edit.holder, attribute: attr.id, value: edit.value };
                break;
            case 'add':
                if (attr.kind === 'list') {
                    const items = listItems(attr, edit.value) ?? [];
                    const base = Array.isArray(current) ? current : [];
                    spec = {
                        mechanicId: def.id,
                        holder: edit.holder,
                        attribute: attr.id,
                        value: attr.multi ? [...base, ...items] : items,
                    };
                } else if ((attr.kind === 'number' || attr.kind === 'scale') && numeric !== null) {
                    spec = { mechanicId: def.id, holder: edit.holder, attribute: attr.id, value: numeric, delta: true };
                } else if (attr.kind === 'scale') {
                    spec = { mechanicId: def.id, holder: edit.holder, attribute: attr.id, value: edit.value };
                } else reason = 'op';
                break;
            case 'sub':
                if (attr.kind === 'list') {
                    const items = listItems(attr, edit.value) ?? [];
                    const base = Array.isArray(current) ? current : [];
                    spec = {
                        mechanicId: def.id,
                        holder: edit.holder,
                        attribute: attr.id,
                        value: base.filter((item) => !items.some((gone) => sameName(gone, item))),
                    };
                } else if ((attr.kind === 'number' || attr.kind === 'scale') && numeric !== null) {
                    spec = {
                        mechanicId: def.id,
                        holder: edit.holder,
                        attribute: attr.id,
                        value: -numeric,
                        delta: true,
                    };
                } else reason = 'op';
                break;
            case 'mul': {
                const base = toNumber(current);
                if (attr.kind === 'number' && numeric !== null && base !== null) {
                    spec = {
                        mechanicId: def.id,
                        holder: edit.holder,
                        attribute: attr.id,
                        value: round(base * numeric),
                    };
                } else reason = 'op';
                break;
            }
        }
        if (!spec) {
            rejected.push({ edit, reason: reason || 'op' });
            continue;
        }
        const next = nextValue(attr, current, spec.value, spec.delta === true);
        if (!next.ok) {
            rejected.push({ edit, reason: next.reason });
            continue;
        }
        if (edit.reason) spec.reason = edit.reason;
        running.set(key, next.value);
        changes.push(spec);
    }
    return { changes, rejected };
}

/** What a change would make of a value (previews and Inbox diffs); null when invalid. */
export function previewChange(
    attr: AttributeDef,
    current: AttributeValue | null,
    spec: ChangeSpec,
): AttributeValue | null {
    const next = nextValue(attr, current ?? initialValueOf(attr), spec.value, spec.delta === true, spec.op);
    return next.ok ? next.value : null;
}
