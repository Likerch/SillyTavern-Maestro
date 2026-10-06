// M25 «Механики», statuses and inventories (plan-2 §6 п. 3 «Состояния с длительностью», п. 4 «Инвентарь»):
// - a status (condition) belongs to a holder: «Отравлен — 3 хода», «Благословение — до заката», «Сломана рука —
//   2 недели». It lasts a number of committed turns, a span of story minutes and/or until a story moment; a repeat
//   refreshes it (or stacks up to `maxStacks`); it gives modifiers to attributes and checks while it lasts and expires
//   by itself (the state fires an expiry event for the model);
// - an item belongs to a holder: quantity, description, worn / in hand, tags, price (trade against the inventory's
//   money attribute), modifiers while equipped. Items merge by name (case-insensitive).
// Plus durations from words («3 хода», "2 hours", «2 недели») and modifier sums for attributes and checks.
// Pure: no DOM, no SillyTavern. Functions return new objects; the caller stores them.
import { cleanList, snakeId } from './mechanics-defs';
import type { EquipSlot, ItemSpec, StatusDuration, StatusSpec } from './mechanics-defs';

/** Same union as the state's ChangeSource (kept here as a string to avoid a cycle). */
export type StatusSource = string;

export interface StatusState {
    /** Instance id (unique in the chat). */
    id: string;
    /** Snake id of the status ('poisoned', 'otravlen'): a repeat of the same status refreshes or stacks it. */
    statusId: string;
    name: string;
    promptName: string;
    /** What is left: committed turns and/or story minutes; null: until removed or until `until`. */
    remaining: { turns?: number; minutes?: number } | null;
    /** Ends when the story clock reaches this moment. */
    until?: { day: number; minutes?: number };
    modifiers: Record<string, number>;
    stacks: number;
    maxStacks: number;
    source: StatusSource;
    /** Message index it came from (-1: by hand). */
    since: number;
    at: number;
    /** The mechanic that defines it (its catalogue), when known. */
    mechanicId?: string;
    text?: string;
    icon?: string;
}

export interface ItemState {
    id: string;
    name: string;
    qty: number;
    desc?: string;
    equipped?: EquipSlot | null;
    tags?: string[];
    value?: number;
    modifiers?: Record<string, number>;
}

export interface StoryTime {
    day: number;
    minutes?: number;
}

export const STATUS_LIMITS = { perHolder: 30, items: 200, qty: 1_000_000, turns: 10_000 } as const;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function key(value: string): string {
    return value
        .normalize('NFC')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\s_-]+/g, ' ');
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ------------------------------------------------------------------ statuses */

/** The snake id of a status by its id or name ('Отравлен' → 'otravlen'). */
export function statusIdOf(spec: Pick<StatusSpec, 'id' | 'name' | 'promptName'>): string {
    return snakeId(spec.id || spec.promptName || spec.name, 'status');
}

/** A status in a list by instance id, status id, name or English name. */
export function findStatus(list: readonly StatusState[], ref: string): StatusState | null {
    const wanted = key(ref);
    if (!wanted) return null;
    const id = snakeId(ref, '');
    return (
        list.find((status) => status.id === ref) ??
        list.find((status) => status.statusId === id || status.statusId === ref) ??
        list.find((status) => key(status.name) === wanted || key(status.promptName) === wanted) ??
        null
    );
}

/** A catalogue status by id, name or English name. */
export function catalogueStatus(catalogue: readonly StatusSpec[], ref: string): StatusSpec | null {
    const wanted = key(ref);
    const id = snakeId(ref, '');
    return (
        catalogue.find((spec) => (spec.id ?? '') === ref || statusIdOf(spec) === id) ??
        catalogue.find((spec) => key(spec.name) === wanted || key(spec.promptName ?? '') === wanted) ??
        null
    );
}

/** The given spec over the catalogue's one (the given duration, modifiers and stacks win). */
export function mergeStatusSpec(base: StatusSpec | null, given: StatusSpec): StatusSpec {
    if (!base) return given;
    const out: StatusSpec = { ...base, ...given, name: base.name };
    if (given.duration === undefined && base.duration !== undefined) out.duration = base.duration;
    if (!given.modifiers && base.modifiers) out.modifiers = { ...base.modifiers };
    if (base.promptName && !given.promptName) out.promptName = base.promptName;
    if (base.id) out.id = base.id;
    return out;
}

function remainingOf(duration: StatusDuration | null | undefined): StatusState['remaining'] {
    if (!duration) return null;
    const out: { turns?: number; minutes?: number } = {};
    if (duration.turns !== undefined && duration.turns > 0) out.turns = Math.min(STATUS_LIMITS.turns, duration.turns);
    if (duration.minutes !== undefined && duration.minutes > 0) out.minutes = duration.minutes;
    return Object.keys(out).length ? out : null;
}

export interface NewStatusOptions {
    id: string;
    source: StatusSource;
    since: number;
    at: number;
    mechanicId?: string;
}

/** A new status instance from a spec. */
export function makeStatus(spec: StatusSpec, options: NewStatusOptions): StatusState {
    const status: StatusState = {
        id: options.id,
        statusId: statusIdOf(spec),
        name: spec.name,
        promptName: spec.promptName || spec.name,
        remaining: remainingOf(spec.duration),
        modifiers: { ...(spec.modifiers ?? {}) },
        stacks: Math.max(1, Math.min(spec.stacks ?? 1, spec.maxStacks ?? Math.max(1, spec.stacks ?? 1))),
        maxStacks: Math.max(1, spec.maxStacks ?? 1),
        source: options.source,
        since: options.since,
        at: options.at,
    };
    if (spec.duration?.until) status.until = { ...spec.duration.until };
    if (options.mechanicId) status.mechanicId = options.mechanicId;
    if (spec.text) status.text = spec.text;
    if (spec.icon) status.icon = spec.icon;
    return status;
}

/**
 * What applying a status to a holder's list does: a new instance, or the existing one refreshed (duration renewed to
 * the longer one) and stacked up to its maximum.
 */
export function applyStatus(
    list: readonly StatusState[],
    spec: StatusSpec,
    options: NewStatusOptions,
): { before: StatusState | null; after: StatusState } {
    const fresh = makeStatus(spec, options);
    const existing = list.find((status) => status.statusId === fresh.statusId) ?? null;
    if (!existing) return { before: null, after: fresh };
    const after: StatusState = structuredClone(existing);
    after.maxStacks = Math.max(existing.maxStacks, fresh.maxStacks);
    after.stacks = Math.min(after.maxStacks, existing.stacks + (spec.stacks ?? 1));
    after.remaining = longer(existing.remaining, fresh.remaining);
    if (fresh.until && (!existing.until || later(fresh.until, existing.until))) after.until = fresh.until;
    if (spec.modifiers) after.modifiers = { ...spec.modifiers };
    after.at = options.at;
    return { before: existing, after };
}

function longer(a: StatusState['remaining'], b: StatusState['remaining']): StatusState['remaining'] {
    if (!a || !b) return null;
    const out: { turns?: number; minutes?: number } = {};
    if (a.turns !== undefined || b.turns !== undefined) out.turns = Math.max(a.turns ?? 0, b.turns ?? 0);
    if (a.minutes !== undefined || b.minutes !== undefined) out.minutes = Math.max(a.minutes ?? 0, b.minutes ?? 0);
    return out;
}

function later(a: StoryTime, b: StoryTime): boolean {
    return a.day * 1440 + (a.minutes ?? 0) > b.day * 1440 + (b.minutes ?? 0);
}

/** Minutes since the start of the story's day 0 (a moment without a time counts from midnight). */
export function storyMinutes(time: StoryTime): number {
    return time.day * 1440 + (time.minutes ?? 0);
}

export interface TickResult {
    /** Statuses whose remaining time changed: [before, after]. */
    updated: [StatusState, StatusState][];
    expired: StatusState[];
}

/**
 * One step of time for a holder's statuses: `turns` committed turns and `minutes` story minutes passed, `now` the story
 * clock after the step. A status ends when its turns or minutes run out or the clock reaches `until`.
 */
export function tickStatuses(
    list: readonly StatusState[],
    step: { turns: number; minutes: number; now?: StoryTime | null },
): TickResult {
    const result: TickResult = { updated: [], expired: [] };
    for (const status of list) {
        let ended = false;
        const after = structuredClone(status);
        if (after.remaining) {
            if (after.remaining.turns !== undefined && step.turns > 0) {
                after.remaining.turns = Math.max(0, after.remaining.turns - step.turns);
                if (after.remaining.turns <= 0) ended = true;
            }
            if (after.remaining.minutes !== undefined && step.minutes > 0) {
                after.remaining.minutes = Math.max(0, after.remaining.minutes - step.minutes);
                if (after.remaining.minutes <= 0) ended = true;
            }
        }
        if (status.until && step.now && storyMinutes(step.now) >= storyMinutes(status.until)) ended = true;
        if (ended) result.expired.push(status);
        else if (JSON.stringify(after.remaining) !== JSON.stringify(status.remaining))
            result.updated.push([status, after]);
    }
    return result;
}

/** English duration for the model: "2 turns left", "3 h left", "until day 5 18:00", '' without one. */
export function durationText(status: Pick<StatusState, 'remaining' | 'until'>): string {
    const parts: string[] = [];
    if (status.remaining?.turns !== undefined) {
        parts.push(`${status.remaining.turns} turn${status.remaining.turns === 1 ? '' : 's'} left`);
    }
    if (status.remaining?.minutes !== undefined) parts.push(`${minutesText(status.remaining.minutes)} left`);
    if (status.until) {
        const time = status.until.minutes !== undefined ? ` ${clockText(status.until.minutes)}` : '';
        parts.push(`until day ${status.until.day}${time}`);
    }
    return parts.join(', ');
}

/** "45 min", "3 h", "2 days", "2 weeks". */
export function minutesText(minutes: number): string {
    if (minutes < 60) return `${Math.round(minutes)} min`;
    if (minutes < 2 * 1440) return `${Math.round(minutes / 60)} h`;
    if (minutes < 14 * 1440) return `${Math.round(minutes / 1440)} days`;
    return `${Math.round(minutes / 10080)} weeks`;
}

function clockText(minutes: number): string {
    const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ durations from words */

const UNIT_WORDS: { stems: string[]; minutes: number | 'turn' }[] = [
    { stems: ['turn', 'round', 'ход', 'раунд'], minutes: 'turn' },
    { stems: ['min', 'мин'], minutes: 1 },
    { stems: ['h', 'hr', 'hour', 'час', 'ч'], minutes: 60 },
    { stems: ['d', 'day', 'день', 'дн', 'сут'], minutes: 1440 },
    { stems: ['w', 'week', 'недел', 'нед'], minutes: 10080 },
    { stems: ['month', 'месяц', 'мес'], minutes: 43200 },
];

const NUMBER_WORDS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    a: 1,
    an: 1,
    один: 1,
    одна: 1,
    одну: 1,
    одни: 1,
    два: 2,
    две: 2,
    три: 3,
    четыре: 4,
    пять: 5,
    шесть: 6,
    семь: 7,
    восемь: 8,
    девять: 9,
    десять: 10,
    пару: 2,
    пара: 2,
};

/**
 * A duration in words: «3 хода», "2 hours", «2 недели», "1d", "a week", «полчаса»; several parts add up
 * («1 день 6 часов»). Null when no part is understood (a phrase like «до заката» is for the calendar).
 */
export function parseDurationText(raw: string): StatusDuration | null {
    const text = key(String(raw ?? ''))
        .replace(/полчаса/g, '30 мин')
        .replace(/half an hour/g, '30 min');
    if (!text) return null;
    let turns = 0;
    let minutes = 0;
    let found = false;
    const re = /(\d+(?:[.,]\d+)?|[a-zа-я]+)?\s*([a-zа-я]+)/g;
    for (const match of text.matchAll(re)) {
        const [, countText, unitText] = match;
        if (!unitText) continue;
        const count =
            countText === undefined
                ? 1
                : /\d/.test(countText)
                  ? Number(countText.replace(',', '.'))
                  : NUMBER_WORDS[countText];
        if (count === undefined || !Number.isFinite(count)) continue;
        const unit = UNIT_WORDS.find((item) =>
            item.stems.some((stem) =>
                // Single letters and short Latin units are whole words ('h', 'hr', 'hrs'); Cyrillic stems take endings.
                stem.length === 1 || (stem.length === 2 && /^[a-z]+$/.test(stem))
                    ? unitText === stem || unitText === `${stem}s`
                    : unitText.startsWith(stem),
            ),
        );
        if (!unit) continue;
        found = true;
        if (unit.minutes === 'turn') turns += count;
        else minutes += count * unit.minutes;
    }
    if (!found) {
        const bare = /^(\d+)$/.exec(text.trim());
        if (bare) return { turns: Number(bare[1]) };
        return null;
    }
    const out: StatusDuration = {};
    if (turns > 0) out.turns = Math.ceil(turns);
    if (minutes > 0) out.minutes = Math.round(minutes);
    return Object.keys(out).length ? out : null;
}

/* ------------------------------------------------------------------ modifiers */

/**
 * The bonus statuses and equipped items give to one key: an attribute (`ids` = ['stealth', 'skills.stealth']) or a
 * check (`ids` = ['check:stealth', 'check:skills.stealth', 'checks']). Stacks multiply a status's modifiers.
 */
export function modifierSum(
    statuses: readonly StatusState[],
    items: readonly ItemState[],
    ids: readonly string[],
): { total: number; parts: { from: 'status' | 'item'; name: string; amount: number }[] } {
    const wanted = new Set(ids.map((id) => id.toLowerCase()));
    const parts: { from: 'status' | 'item'; name: string; amount: number }[] = [];
    for (const status of statuses) {
        let amount = 0;
        for (const [name, value] of Object.entries(status.modifiers)) if (wanted.has(name)) amount += value;
        if (amount) parts.push({ from: 'status', name: status.name, amount: amount * status.stacks });
    }
    for (const item of items) {
        if (!item.equipped || !item.modifiers) continue;
        let amount = 0;
        for (const [name, value] of Object.entries(item.modifiers)) if (wanted.has(name)) amount += value;
        if (amount) parts.push({ from: 'item', name: item.name, amount });
    }
    const total = Math.round(parts.reduce((sum, part) => sum + part.amount, 0) * 10000) / 10000;
    return { total, parts };
}

/* ------------------------------------------------------------------ items */

/** An item in a list by id or name (case-insensitive). */
export function findItem(list: readonly ItemState[], ref: string): ItemState | null {
    const wanted = key(ref);
    if (!wanted) return null;
    return list.find((item) => item.id === ref) ?? list.find((item) => key(item.name) === wanted) ?? null;
}

function cleanQty(value: number | undefined, fallback: number): number {
    const qty = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(STATUS_LIMITS.qty, Math.round(qty * 100) / 100));
}

function withSpec(item: ItemState, spec: ItemSpec): void {
    if (spec.desc !== undefined) item.desc = spec.desc;
    if (spec.equipped !== undefined) item.equipped = spec.equipped;
    if (spec.tags?.length) item.tags = cleanList([...(item.tags ?? []), ...spec.tags]);
    if (spec.value !== undefined) item.value = spec.value;
    if (spec.modifiers) item.modifiers = { ...spec.modifiers };
}

/** Gives `qty` (default the spec's, else 1) of an item: merged with one of the same name, else a new record. */
export function giveItem(
    list: readonly ItemState[],
    spec: ItemSpec,
    newId: () => string,
    qty?: number,
): { before: ItemState | null; after: ItemState } | null {
    const amount = cleanQty(qty ?? spec.qty, 1);
    if (amount <= 0 || !spec.name.trim()) return null;
    const existing = findItem(list, spec.name);
    if (existing) {
        const after = structuredClone(existing);
        after.qty = cleanQty(existing.qty + amount, existing.qty);
        withSpec(after, spec);
        return { before: existing, after };
    }
    const after: ItemState = { id: newId(), name: spec.name.trim(), qty: amount };
    withSpec(after, spec);
    return { before: null, after };
}

/** Takes `qty` of an item (all of it when qty is undefined); null when the holder has none. */
export function takeItem(
    list: readonly ItemState[],
    name: string,
    qty?: number,
): { before: ItemState; after: ItemState | null; taken: number } | null {
    const existing = findItem(list, name);
    if (!existing) return null;
    const amount = qty === undefined ? existing.qty : cleanQty(qty, 1);
    const left = cleanQty(existing.qty - amount, 0);
    const taken = existing.qty - left;
    if (left <= 0) return { before: existing, after: null, taken };
    const after = structuredClone(existing);
    after.qty = left;
    return { before: existing, after, taken };
}

/** Puts an item on, in hand, or away (null); null when the holder has none or nothing changes. */
export function equipItem(
    list: readonly ItemState[],
    name: string,
    slot: EquipSlot | null,
): { before: ItemState; after: ItemState } | null {
    const existing = findItem(list, name);
    if (!existing || (existing.equipped ?? null) === slot) return null;
    const after = structuredClone(existing);
    if (slot) after.equipped = slot;
    else delete after.equipped;
    return { before: existing, after };
}

/** "rope x2, sword (in hand), cloak (worn)" for the model. */
export function itemsText(list: readonly ItemState[], max = 12): string {
    const parts = list.slice(0, max).map((item) => {
        const qty = item.qty !== 1 ? ` x${item.qty}` : '';
        const slot = item.equipped === 'hand' ? ' (in hand)' : item.equipped === 'worn' ? ' (worn)' : '';
        return `${item.name}${qty}${slot}`;
    });
    if (list.length > max) parts.push(`+${list.length - max} more`);
    return parts.join(', ');
}

/* ------------------------------------------------------------------ stored data */

function readModifiers(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!isDict(raw)) return out;
    for (const [name, value] of Object.entries(raw)) if (finite(value) !== undefined) out[name] = value as number;
    return out;
}

/** A stored status repaired, or null. */
export function readStatus(raw: unknown): StatusState | null {
    if (!isDict(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
    const status: StatusState = {
        id: raw.id,
        statusId: typeof raw.statusId === 'string' && raw.statusId ? raw.statusId : snakeId(raw.name, 'status'),
        name: raw.name,
        promptName: typeof raw.promptName === 'string' && raw.promptName ? raw.promptName : raw.name,
        remaining: null,
        modifiers: readModifiers(raw.modifiers),
        stacks: Math.max(1, Math.round(finite(raw.stacks) ?? 1)),
        maxStacks: Math.max(1, Math.round(finite(raw.maxStacks) ?? 1)),
        source: typeof raw.source === 'string' ? raw.source : 'user',
        since: Math.trunc(finite(raw.since) ?? -1),
        at: Math.trunc(finite(raw.at) ?? 0),
    };
    if (isDict(raw.remaining)) {
        const remaining: { turns?: number; minutes?: number } = {};
        if (finite(raw.remaining.turns) !== undefined) remaining.turns = raw.remaining.turns as number;
        if (finite(raw.remaining.minutes) !== undefined) remaining.minutes = raw.remaining.minutes as number;
        status.remaining = Object.keys(remaining).length ? remaining : null;
    }
    if (isDict(raw.until) && finite(raw.until.day) !== undefined) {
        status.until = { day: raw.until.day as number };
        if (finite(raw.until.minutes) !== undefined) status.until.minutes = raw.until.minutes as number;
    }
    if (typeof raw.mechanicId === 'string' && raw.mechanicId) status.mechanicId = raw.mechanicId;
    if (typeof raw.text === 'string' && raw.text) status.text = raw.text;
    if (typeof raw.icon === 'string' && raw.icon) status.icon = raw.icon;
    return status;
}

/** A stored item repaired, or null. */
export function readItem(raw: unknown): ItemState | null {
    if (!isDict(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const item: ItemState = { id: raw.id, name: raw.name, qty: cleanQty(finite(raw.qty), 1) };
    if (typeof raw.desc === 'string' && raw.desc) item.desc = raw.desc;
    if (raw.equipped === 'worn' || raw.equipped === 'hand') item.equipped = raw.equipped;
    const tags = cleanList(raw.tags);
    if (tags.length) item.tags = tags;
    if (finite(raw.value) !== undefined) item.value = raw.value as number;
    const modifiers = readModifiers(raw.modifiers);
    if (Object.keys(modifiers).length) item.modifiers = modifiers;
    return item;
}
