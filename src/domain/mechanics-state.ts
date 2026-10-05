// M25 «Механики», pure parts of the state (plan M25 п. 4, 7; P9, P14): values of every holder per mechanic, a change
// log per message (a swiped, deleted or edited reply takes its changes back), threshold events with `once` latches.
// - values are validated per attribute: numbers clamped to their bounds, scale levels by label or index (clamped),
//   list options (case-insensitive, canonical spelling; lists are always arrays, a single list holds at most one),
//   texts trimmed and capped; deltas exist for numbers (and scales: steps; lists: options added);
// - a change of a holder that is not stored yet first creates it with the initial values of every attribute;
// - events: '<=', '>=', '=' compare the new value (numbers, scale levels by order, list membership or size, texts);
//   'changed' fires on every change (to its value, when it names one). A `once` event (the default) fires once and
//   re-arms when a later change makes its condition false;
// - rollback: changes are undone newest first; a change still followed by a kept change of the same attribute is
//   reverted as a difference (numbers, scales and lists) instead of overwriting what came later.
// The document is a plain JSON object (a Maestro file per chat); functions here mutate the copy they are given.
// Pure: no DOM, no SillyTavern.
import { initialValueOf } from './mechanics-defs';
import type { AttributeDef, AttributeEvent, AttributeValue, HolderSpec, MechanicDef } from './mechanics-defs';

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ types */

/** Same union as `ChangeSource` of src/features/mechanics/api.ts. */
export type ChangeSource = 'desStats' | 'block' | 'background' | 'check' | 'event' | 'user';
export const CHANGE_SOURCES: readonly ChangeSource[] = ['desStats', 'block', 'background', 'check', 'event', 'user'];
/** Sources the model's replies produce (tracking): rolled back with their message. */
export const TRACKED_SOURCES: readonly ChangeSource[] = ['desStats', 'block', 'background', 'event'];

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
    reason?: string;
}

export interface ChangeInputData extends ChangeSpec {
    source: ChangeSource;
    messageIndex: number;
}

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
}

/** A change in the log with what its rollback needs. */
export interface LoggedChange extends StateChangeData {
    /** Event latches this change flipped: key → value before. */
    latch?: Record<string, boolean>;
    /** The holder did not exist before this change. */
    created?: boolean;
    /** The holder's `updatedAt` before this change. */
    prevUpdatedAt?: number;
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
}

export const STATE_LIMITS = { log: 1000, fired: 200, text: 500, reason: 200 } as const;

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
): ValueResult {
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

/** Initial values of every attribute of a mechanic for a new holder. */
export function initialValues(def: Pick<MechanicDef, 'attributes'>): Record<string, AttributeValue> {
    const values: Record<string, AttributeValue> = {};
    for (const attr of def.attributes) values[attr.id] = initialValueOf(attr);
    return values;
}

/* ------------------------------------------------------------------ holders */

export interface HolderContext {
    /** The persona's name (`name1`). */
    persona: string;
    /** Canonical character name for any name, alias or case form (the world model), when known. */
    canonical?: (name: string) => string | undefined;
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

/** Current value: stored, else the attribute's initial value. */
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
    return { version: 1, holders: {}, log: [], latched: {}, fired: [] };
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
    return doc;
}

/** Keeps the newest log entries and events within the limits. */
export function capStateDoc(doc: MechanicsStateDoc, limits: { log?: number; fired?: number } = {}): void {
    const log = limits.log ?? STATE_LIMITS.log;
    const fired = limits.fired ?? STATE_LIMITS.fired;
    if (doc.log.length > log) doc.log.splice(0, doc.log.length - log);
    if (doc.fired.length > fired) doc.fired.splice(0, doc.fired.length - fired);
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

export type RejectReason = 'mechanic' | 'attribute' | 'holder' | 'number' | 'level' | 'levels' | string;

export interface ApplyOptions {
    getDef: (id: string) => MechanicDef | null;
    now: number;
    newId: () => string;
}

export interface ApplyResult {
    applied: LoggedChange[];
    fired: StoredEvent[];
    rejected: { input: ChangeInputData; reason: RejectReason }[];
    /** Valid changes that left the value as it was. */
    unchanged: ChangeInputData[];
}

function clip(text: string | undefined, max: number): string | undefined {
    const value = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return undefined;
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Applies changes in order to the document (validated, clamped, logged, events fired). */
export function applyChanges(
    doc: MechanicsStateDoc,
    inputs: readonly ChangeInputData[],
    options: ApplyOptions,
): ApplyResult {
    const result: ApplyResult = { applied: [], fired: [], rejected: [], unchanged: [] };
    for (const input of inputs) {
        const def = options.getDef(input.mechanicId);
        if (!def) {
            result.rejected.push({ input, reason: 'mechanic' });
            continue;
        }
        const attr = findAttribute(def, input.attribute);
        if (!attr) {
            result.rejected.push({ input, reason: 'attribute' });
            continue;
        }
        const name = cleanHolder(String(input.holder ?? ''));
        if (!name) {
            result.rejected.push({ input, reason: 'holder' });
            continue;
        }
        const existing = storedHolderKey(doc, def.id, name);
        const holderName = existing ?? name;
        const stored = existing ? doc.holders[def.id]?.[existing] : undefined;
        const from: AttributeValue | null = stored ? (stored.values[attr.id] ?? null) : null;
        const base = from ?? initialValueOf(attr);
        const next = nextValue(attr, base, input.value, input.delta === true);
        if (!next.ok) {
            result.rejected.push({ input, reason: next.reason });
            continue;
        }
        if (valuesEqual(base, next.value)) {
            result.unchanged.push(input);
            continue;
        }
        let holder = stored;
        const created = !holder;
        if (!holder) {
            holder = { values: initialValues(def), updatedAt: -1 };
            (doc.holders[def.id] ??= {})[holderName] = holder;
        }
        const change: LoggedChange = {
            id: options.newId(),
            mechanicId: def.id,
            holder: holderName,
            attribute: attr.id,
            from: created ? initialValueOf(attr) : from,
            to: next.value,
            source: input.source,
            messageIndex: Number.isInteger(input.messageIndex) ? input.messageIndex : -1,
            at: options.now,
            prevUpdatedAt: holder.updatedAt,
        };
        const reason = clip(input.reason, STATE_LIMITS.reason);
        if (reason) change.reason = reason;
        if (created) change.created = true;
        holder.values[attr.id] = next.value;
        if (change.messageIndex >= 0) holder.updatedAt = Math.max(holder.updatedAt, change.messageIndex);
        for (const event of attr.events ?? []) {
            const key = eventKey(def.id, holderName, attr.id, event.id);
            const before = doc.latched[key] === true;
            const outcome = evaluateEvent(attr, event, next.value, before);
            if (outcome.latch !== undefined && outcome.latch !== before) {
                (change.latch ??= {})[key] = before;
                if (outcome.latch) doc.latched[key] = true;
                else delete doc.latched[key];
            }
            if (!outcome.fire) continue;
            const fired: StoredEvent = {
                id: options.newId(),
                changeId: change.id,
                mechanicId: def.id,
                holder: holderName,
                attribute: attr.id,
                eventId: event.id,
                text: fillEventText(event.text, holderName, next.value, attr.promptName),
                messageIndex: change.messageIndex,
                at: options.now,
                delivered: false,
            };
            doc.fired.push(fired);
            result.fired.push(fired);
        }
        doc.log.push(change);
        result.applied.push(change);
    }
    return result;
}

/* ------------------------------------------------------------------ rollback */

function sameTarget(a: StateChangeData, b: StateChangeData): boolean {
    return a.mechanicId === b.mechanicId && a.attribute === b.attribute && sameName(a.holder, b.holder);
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

/**
 * Takes one change out of the document. `exact` (no later change of the same value is kept): the value, the holder's
 * `updatedAt` and the latches go back to what they were. Otherwise the change is reverted as a difference; texts
 * then stay as they are. Returns false when nothing could be reverted (the log entry is removed anyway).
 */
function revertEntry(
    doc: MechanicsStateDoc,
    change: LoggedChange,
    exact: boolean,
    getDef?: (id: string) => MechanicDef | null,
): boolean {
    const holders = doc.holders[change.mechanicId];
    const key = holders ? storedHolderKey(doc, change.mechanicId, change.holder) : null;
    const holder = key ? holders?.[key] : undefined;
    let reverted = false;
    if (holder) {
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
    const index = doc.log.indexOf(change);
    if (index >= 0) doc.log.splice(index, 1);
    doc.fired = doc.fired.filter((event) => event.changeId !== change.id);
    if (
        holder &&
        key &&
        change.created &&
        exact &&
        !doc.log.some((item) => item.mechanicId === change.mechanicId && sameName(item.holder, change.holder))
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

/** A swiped or deleted reply: every change from that message on (user edits stay). */
export function rollbackFrom(
    doc: MechanicsStateDoc,
    messageIndex: number,
    getDef?: (id: string) => MechanicDef | null,
): LoggedChange[] {
    return rollbackWhere(doc, (change) => change.source !== 'user' && change.messageIndex >= messageIndex, getDef);
}

/** The changes of one message from the given sources (an edited reply). */
export function rollbackMessage(
    doc: MechanicsStateDoc,
    messageIndex: number,
    sources: readonly ChangeSource[] = TRACKED_SOURCES,
    getDef?: (id: string) => MechanicDef | null,
): LoggedChange[] {
    return rollbackWhere(
        doc,
        (change) => change.messageIndex === messageIndex && sources.includes(change.source),
        getDef,
    );
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
 * Undo of one change (journal): exact when it is the newest change of its value, else reverted as a difference.
 * A text overwritten later cannot be reverted: false, and the change stays logged.
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
        const def = getDef?.(change.mechanicId) ?? null;
        const attr = def ? findAttribute(def, change.attribute) : null;
        const key = storedHolderKey(doc, change.mechanicId, change.holder);
        const current = key ? doc.holders[change.mechanicId]?.[key]?.values[change.attribute] : undefined;
        if (current === undefined || revertDifference(attr, change, current) === null) return false;
    }
    return revertEntry(doc, change, exact, getDef);
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
    const next = nextValue(attr, current ?? initialValueOf(attr), spec.value, spec.delta === true);
    return next.ok ? next.value : null;
}
