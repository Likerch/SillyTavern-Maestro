// M25 «Механики», what the play surfaces show (plan-2 §6.А «Где и как видны механики»; §6 п.8 «Удобный конструктор»):
// - a value as the player may see it in a place: a number («65/100»), a bar (its share of the range), words by
//   thresholds (the attribute's bands, else the default bands of a bounded number), an icon; nothing when hidden;
// - what a change means for the change line under a reply: «80 → 65», words before and after (a change inside one
//   band shows nothing in the «book» view), options added and removed, a status put on or gone (its ticks are not
//   news), items gained, lost, worn or taken in hand, a fight started, ended or moved to the next round;
// - what is left of a status in parts (turns, story time, a story moment) for the UI language to word;
// - export and import of a definition as a JSON file, a copy under a new name, and the texts of a definition the
//   user wrote in his language that still wait for their English (the background translation for the model).
// Pure: no DOM, no SillyTavern.
import { stableHash } from './hash';
import { cleanList, cloneDef, newMechanicId, normalizeDef, snakeId, trackingOf, uniqueId } from './mechanics-defs';
import type { AttributeDef, AttributeValue, MechanicDef, MechanicScope, StatusDuration } from './mechanics-defs';
import { wordsFor } from './mechanics-visibility';
import type { ValueView, Visibility, VisibleAttribute, WordsOf } from './mechanics-visibility';

/* ------------------------------------------------------------------ values */

/** A number for people: whole numbers as they are, fractions to one decimal. */
export function formatNumber(value: number): string {
    if (!Number.isFinite(value)) return '—';
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** The range of a bounded number attribute, or null. */
export function boundsOf(
    attribute: Pick<VisibleAttribute, 'kind' | 'min' | 'max'>,
): { min: number; max: number } | null {
    if (attribute.kind !== 'number') return null;
    if (typeof attribute.min !== 'number' || typeof attribute.max !== 'number' || attribute.max <= attribute.min)
        return null;
    return { min: attribute.min, max: attribute.max };
}

/** Share of the range, clamped to 0…1. */
export function shareOf(value: number, min: number, max: number): number {
    if (!(max > min)) return 0;
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** A value as plain text: numbers formatted, lists joined, '' for an empty list. */
export function plainValue(value: AttributeValue | null | undefined): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'number') return formatNumber(value);
    return String(value);
}

export type ShownView = Exclude<ValueView, 'hidden'>;

/** A value ready to be drawn in one view. */
export interface ShownValue {
    view: ShownView;
    /** The number view's text («65/100», «65», a level, options, a text). */
    text: string;
    value?: number;
    min?: number;
    max?: number;
    /** Bounded numbers: the share of the range (bars, icons). */
    share?: number;
    /** The words of the value (the «words» view; a tooltip elsewhere). */
    words: WordsOf | null;
}

/**
 * How a value shows in a view: 'hidden' never; 'bar' needs a bounded number (else the number); 'words' needs words
 * (a value without any shows nothing, never its number); lists and texts always show as they are.
 */
export function shownValue(
    attribute: VisibleAttribute,
    visibility: Pick<Visibility, 'view' | 'words'>,
    value: AttributeValue | null | undefined,
): ShownValue | null {
    if (visibility.view === 'hidden' || value === null || value === undefined) return null;
    const words = wordsFor(attribute, visibility, value);
    if (attribute.kind !== 'number') {
        const text = plainValue(value);
        if (visibility.view === 'words') return words ? { view: 'words', text, words } : null;
        return { view: visibility.view === 'icon' ? 'icon' : 'number', text, words };
    }
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return null;
    const bounds = boundsOf(attribute);
    const base: ShownValue = {
        view: 'number',
        text: bounds ? `${formatNumber(number)}/${formatNumber(bounds.max)}` : formatNumber(number),
        value: number,
        words,
    };
    if (bounds) {
        base.min = bounds.min;
        base.max = bounds.max;
        base.share = shareOf(number, bounds.min, bounds.max);
    }
    switch (visibility.view) {
        case 'words':
            return words ? { ...base, view: 'words' } : null;
        case 'bar':
            return bounds ? { ...base, view: 'bar' } : base;
        case 'icon':
            return { ...base, view: 'icon' };
        default:
            return base;
    }
}

/** The same words (by band, display or label): a change inside one band says nothing in the «words» view. */
export function sameWords(a: WordsOf | null, b: WordsOf | null): boolean {
    if (!a || !b) return a === b;
    if (a.band !== undefined || b.band !== undefined) return a.band === b.band;
    return (a.display ?? a.label) === (b.display ?? b.label);
}

/* ------------------------------------------------------------------ changes */

/** What a value change of a list did: options added and removed. */
export function listDelta(
    from: AttributeValue | null | undefined,
    to: AttributeValue | null | undefined,
): { added: string[]; removed: string[] } {
    const before = Array.isArray(from) ? from : typeof from === 'string' && from ? cleanList(from) : [];
    const after = Array.isArray(to) ? to : typeof to === 'string' && to ? cleanList(to) : [];
    const key = (value: string) => value.trim().toLowerCase();
    const had = new Set(before.map(key));
    const has = new Set(after.map(key));
    return {
        added: after.filter((item) => !had.has(key(item))),
        removed: before.filter((item) => !has.has(key(item))),
    };
}

/** The kinds of what a logged change means for the player. */
export type ChangeMeaning =
    | { kind: 'value' }
    | { kind: 'statusOn'; name: string }
    | { kind: 'statusOff'; name: string }
    | { kind: 'statusTick' }
    | { kind: 'itemGained'; name: string; qty: number }
    | { kind: 'itemLost'; name: string; qty: number }
    | { kind: 'itemEquipped'; name: string; slot: string }
    | { kind: 'itemUnequipped'; name: string }
    | { kind: 'reveal'; shown: boolean }
    | { kind: 'combatStart' }
    | { kind: 'combatEnd' }
    | { kind: 'combatRound'; round: number }
    | { kind: 'combatJoin' };

interface ChangeLike {
    kind?: 'status' | 'item' | 'reveal' | 'combat';
    from: AttributeValue | null;
    to: AttributeValue;
    status?: { name: string };
    item?: { name: string; equipped?: string | null };
}

function roundOf(label: AttributeValue | null): number | null {
    const match = /^round (\d+)$/.exec(String(label ?? ''));
    return match ? Number(match[1]) : null;
}

/** What a change means (statuses: put on, gone, a tick; items: gained, lost, equipped; the fight; a reveal). */
export function changeMeaning(change: ChangeLike): ChangeMeaning {
    switch (change.kind) {
        case 'status': {
            const name = change.status?.name ?? String(change.to || change.from || '');
            if (change.to === '' || change.to === null) return { kind: 'statusOff', name };
            if (typeof change.to === 'number' && typeof change.from === 'number') return { kind: 'statusTick' };
            if (change.from !== null && change.from !== '' && typeof change.to === 'number')
                return { kind: 'statusTick' };
            return { kind: 'statusOn', name };
        }
        case 'item': {
            const name = change.item?.name ?? '';
            if (typeof change.from === 'number' || typeof change.to === 'number') {
                const before = Number(change.from) || 0;
                const after = Number(change.to) || 0;
                return after >= before
                    ? { kind: 'itemGained', name, qty: after - before }
                    : { kind: 'itemLost', name, qty: before - after };
            }
            const slot = String(change.to ?? '');
            return slot ? { kind: 'itemEquipped', name, slot } : { kind: 'itemUnequipped', name };
        }
        case 'reveal':
            return { kind: 'reveal', shown: change.to === 'shown' };
        case 'combat': {
            const before = roundOf(change.from);
            const after = roundOf(change.to);
            if (before === null && after !== null) return { kind: 'combatStart' };
            if (after === null) return { kind: 'combatEnd' };
            if (before !== after) return { kind: 'combatRound', round: after };
            return { kind: 'combatJoin' };
        }
        default:
            return { kind: 'value' };
    }
}

/* ------------------------------------------------------------------ durations */

export type TimeUnit = 'minute' | 'hour' | 'day' | 'week';

/** What is left of a status, in parts the UI words in its language. */
export interface DurationParts {
    turns?: number;
    time?: { unit: TimeUnit; count: number };
    until?: { day: number; time?: string };
}

/** Story minutes in the biggest unit that reads well: 45 minutes, 3 hours, 2 days, 2 weeks. */
export function timeAmount(minutes: number): { unit: TimeUnit; count: number } {
    const value = Math.max(0, minutes);
    if (value < 60) return { unit: 'minute', count: Math.max(1, Math.round(value)) };
    if (value < 2 * 1440) return { unit: 'hour', count: Math.round(value / 60) };
    if (value < 14 * 1440) return { unit: 'day', count: Math.round(value / 1440) };
    return { unit: 'week', count: Math.round(value / 10080) };
}

function clock(minutes: number): string {
    const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** The parts of what is left (null: until removed). */
export function durationParts(
    remaining: { turns?: number; minutes?: number } | null | undefined,
    until?: { day: number; minutes?: number } | null,
): DurationParts | null {
    const parts: DurationParts = {};
    if (remaining?.turns !== undefined) parts.turns = Math.max(0, Math.round(remaining.turns));
    if (remaining?.minutes !== undefined) parts.time = timeAmount(remaining.minutes);
    if (until)
        parts.until = until.minutes !== undefined ? { day: until.day, time: clock(until.minutes) } : { day: until.day };
    return parts.turns === undefined && !parts.time && !parts.until ? null : parts;
}

/** A status duration of the constructor from a number of turns and/or story hours (empty → until removed). */
export function durationOf(turns: number | undefined, hours: number | undefined): StatusDuration | null {
    const out: StatusDuration = {};
    if (turns !== undefined && Number.isFinite(turns) && turns > 0) out.turns = Math.round(turns);
    if (hours !== undefined && Number.isFinite(hours) && hours > 0) out.minutes = Math.round(hours * 60);
    return out.turns === undefined && out.minutes === undefined ? null : out;
}

/* ------------------------------------------------------------------ files and copies */

/** The `kind` of an exported mechanic file. */
export const MECHANIC_FILE_KIND = 'maestro.mechanic';
export const MECHANIC_FILE_VERSION = 1;

export interface MechanicFile {
    kind: typeof MECHANIC_FILE_KIND;
    version: number;
    mechanic: MechanicDef;
}

/** The definition without what belongs to this installation (its book, entry, scope, time of saving). */
function portable(def: MechanicDef): MechanicDef {
    const copy = cloneDef(def);
    delete copy.book;
    delete copy.uid;
    delete copy.updatedAt;
    copy.scope = { kind: 'global' };
    return copy;
}

/** The JSON of an exported mechanic (a file to keep or share). */
export function exportMechanic(def: MechanicDef): MechanicFile {
    return { kind: MECHANIC_FILE_KIND, version: MECHANIC_FILE_VERSION, mechanic: portable(def) };
}

/** A file name for an exported mechanic: `maestro-mechanic-<id>.json`. */
export function exportFileName(def: Pick<MechanicDef, 'id'>): string {
    return `maestro-mechanic-${def.id.replace(/[^a-z0-9_-]/gi, '_') || 'mechanic'}.json`;
}

export type ImportResult = { ok: true; def: MechanicDef } | { ok: false; error: 'json' | 'kind' | 'definition' };

/**
 * A mechanic from a file (the export wrapper or a bare definition): normalised, a fresh id when its own is taken, the
 * scope given (where the user imports it), nothing of another installation (book, entry).
 */
export function importMechanic(text: string, taken: Iterable<string>, scope: MechanicScope): ImportResult {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, error: 'json' };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'definition' };
    const record = raw as Record<string, unknown>;
    if (record.kind !== undefined && record.kind !== MECHANIC_FILE_KIND) return { ok: false, error: 'kind' };
    const body = record.kind === MECHANIC_FILE_KIND ? record.mechanic : record;
    const def = normalizeDef(body);
    if (!def || !def.name.trim()) return { ok: false, error: 'definition' };
    const clean = portable(def);
    const used = [...taken];
    if (used.includes(clean.id)) clean.id = newMechanicId(clean.name || clean.id, used);
    clean.scope = scope;
    return { ok: true, def: clean };
}

/** A copy of a definition under a new name and id (unsaved; same scope). */
export function duplicateMechanic(def: MechanicDef, name: string, taken: Iterable<string>): MechanicDef {
    const copy = cloneDef(def);
    delete copy.book;
    delete copy.uid;
    delete copy.updatedAt;
    copy.name = name;
    copy.id = newMechanicId(name, taken);
    return copy;
}

/** An id for a new part (attribute, check, event, status) from its name, unique among `taken`. */
export function idFromName(name: string, fallback: string, taken: Iterable<string>): string {
    return uniqueId(snakeId(name, fallback), taken);
}

/* ------------------------------------------------------------------ translation for the model */

/** Letters of the user's language the model should not get as the rules (Cyrillic). */
export function hasCyrillic(text: string | undefined): boolean {
    return !!text && /[Ѐ-ӿ]/.test(text);
}

/** Hash of a source text (what the English was made from). */
export function sourceHash(text: string): string {
    return stableHash(text.replace(/\r\n?/g, '\n').trim());
}

/** One text to translate: `summary`, `rules`, `name`, `attr.<id>`, `check.<id>`, `status.<index>`. */
export interface TranslationItem {
    key: string;
    text: string;
}

/** The summary and rules whose source changed since their English was made. */
export function staleSources(def: MechanicDef): ('summary' | 'rules')[] {
    const out: ('summary' | 'rules')[] = [];
    for (const field of ['summary', 'rules'] as const) {
        const source = field === 'summary' ? def.summarySource : def.rulesSource;
        if (!source?.trim()) continue;
        if (def.translatedFrom?.[field] !== sourceHash(source)) out.push(field);
    }
    return out;
}

/** A name for the model still in the user's language (its English name is missing or the same Cyrillic text). */
function needsName(name: string, promptName: string | undefined): boolean {
    return hasCyrillic(name) && (!promptName?.trim() || promptName.trim() === name.trim() || hasCyrillic(promptName));
}

/**
 * What a definition still needs in English: changed sources of the summary and rules, and names the model would
 * get in the user's language (the mechanic's, attributes' — never a DES stat's, whose name DES already keeps —,
 * checks', statuses').
 */
export function translationItems(def: MechanicDef): TranslationItem[] {
    const items: TranslationItem[] = [];
    for (const field of staleSources(def)) {
        const text = (field === 'summary' ? def.summarySource : def.rulesSource) ?? '';
        items.push({ key: field, text });
    }
    if (needsName(def.name, def.promptName)) items.push({ key: 'name', text: def.name });
    for (const attribute of def.attributes) {
        if (trackingOf(def, attribute) === 'desStats') continue;
        if (needsName(attribute.name, attribute.promptName))
            items.push({ key: `attr.${attribute.id}`, text: attribute.name });
    }
    for (const check of def.checks) {
        if (needsName(check.name, check.promptName)) items.push({ key: `check.${check.id}`, text: check.name });
    }
    (def.statuses ?? []).forEach((status, index) => {
        if (needsName(status.name, status.promptName)) items.push({ key: `status.${index}`, text: status.name });
    });
    return items;
}

/**
 * The definition with the English answers laid in (a copy): summary and rules (their sources' hashes remembered),
 * names for the model. Answers for texts that changed meanwhile, unknown keys and empty answers are ignored.
 */
export function applyTranslation(
    def: MechanicDef,
    asked: readonly TranslationItem[],
    answers: readonly TranslationItem[],
): MechanicDef {
    const out = cloneDef(def);
    const english = new Map(
        answers
            .filter((item) => typeof item.text === 'string' && item.text.trim())
            .map((item) => [item.key, item.text.trim()]),
    );
    for (const item of asked) {
        const value = english.get(item.key);
        if (!value) continue;
        if (item.key === 'summary' || item.key === 'rules') {
            const source = item.key === 'summary' ? out.summarySource : out.rulesSource;
            if (!source || sourceHash(source) !== sourceHash(item.text)) continue;
            out[item.key] = value;
            out.translatedFrom = { ...(out.translatedFrom ?? {}), [item.key]: sourceHash(source) };
        } else if (item.key === 'name') {
            if (out.name === item.text) out.promptName = value;
        } else if (item.key.startsWith('attr.')) {
            const attribute = out.attributes.find((entry) => entry.id === item.key.slice(5));
            if (attribute && attribute.name === item.text) attribute.promptName = value;
        } else if (item.key.startsWith('check.')) {
            const check = out.checks.find((entry) => entry.id === item.key.slice(6));
            if (check && check.name === item.text) check.promptName = value;
        } else if (item.key.startsWith('status.')) {
            const status = out.statuses?.[Number(item.key.slice(7))];
            if (status && status.name === item.text) status.promptName = value;
        }
    }
    return out;
}

/**
 * Before a save: the English the model gets while a changed source waits for its translation is the source itself
 * (the model reads it rather than stale rules); unchanged sources keep their English.
 */
export function interimEnglish(def: MechanicDef): MechanicDef {
    const out = cloneDef(def);
    for (const field of staleSources(out)) {
        const source = field === 'summary' ? out.summarySource : out.rulesSource;
        if (source) out[field] = source;
        if (out.translatedFrom) delete out.translatedFrom[field];
    }
    if (out.translatedFrom && !out.translatedFrom.summary && !out.translatedFrom.rules) delete out.translatedFrom;
    return out;
}

/* ------------------------------------------------------------------ kinds */

/** Attribute fields that belong to one kind only (dropped when the kind changes). */
const KIND_FIELDS = ['min', 'max', 'initial', 'levels', 'options', 'multi', 'formula', 'growth'] as const;

/** The events of an attribute that still make sense for another kind (numbers and scales compare; others «=»). */
export function eventsKeptFor(attribute: Pick<AttributeDef, 'events'>, kind: AttributeDef['kind']): number {
    return (attribute.events ?? []).filter((event) => {
        if (event.when.op === 'changed') return true;
        if (kind === 'number') return typeof event.when.value === 'number';
        if (kind === 'scale') return typeof event.when.value === 'string';
        return event.when.op === '=';
    }).length;
}

/**
 * An attribute switched to another kind: the fields of the old kind go, the new kind's defaults come; its events stay
 * unless `dropEvents` (the constructor asks first when some of them no longer fit).
 */
export function changeKind(attribute: AttributeDef, kind: AttributeDef['kind'], dropEvents = false): AttributeDef {
    const out = cloneDef(attribute);
    out.kind = kind;
    for (const key of KIND_FIELDS) delete out[key];
    if (kind === 'number') {
        out.min = 0;
        out.max = 100;
    } else if (kind === 'scale') {
        out.levels = ['low', 'medium', 'high'];
        out.initial = 'medium';
    } else if (kind === 'list') {
        out.options = [];
    }
    if (dropEvents) delete out.events;
    return out;
}
