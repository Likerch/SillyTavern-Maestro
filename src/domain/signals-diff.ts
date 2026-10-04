// Signals of one committed turn (plan §4.4, §5 phase 1, M8 «Сигналы», P14): what changed between the DES tracker,
// Qvink memory, DES aliases and the names of the committed reply and what Maestro had accepted before.
//
// The accepted state is a baseline. Noise suppression (plan §4.4): free text from DES (location, outfit and
// appearance, character presence, quests) and names found in the reply only change the baseline — and give a
// signal — when the new value holds two committed turns in a row (the reply now and the committed reply before it
// agree); similar wordings are one value (normalised word sets). Relationship status, time, DES aliases and Qvink
// flags are changes of state, not free text, and count at once. A value seen for the first time only sets the
// baseline. Every baseline change of a turn is traced, so a swiped, edited or deleted reply rolls back exactly.
// Pure: no DOM, no SillyTavern.
import type { DesTrackerSnapshot } from './des-tracker';
import type { NameCandidate } from './signals-names';
import { cleanLabel, normalizePlaceName } from './places-label';
import { timeJump } from './signals-time';
import { containsAll, jaccard, normalizeText, sameTokens, textsDiffer, tokenSet, wordDiff } from './signals-tokens';

/** Signal kinds of stage 4 (same list as `SignalKind` in src/features/signals/api.ts). */
export type SignalKindName =
    | 'relationship.changed'
    | 'appearance.changed'
    | 'location.changed'
    | 'time.skipped'
    | 'scene.ended'
    | 'quest.added'
    | 'quest.removed'
    | 'character.appeared'
    | 'character.left'
    | 'alias.added'
    | 'memory.long'
    | 'memory.added'
    | 'name.new'
    | 'fact.new';

export type AppearanceAspect = 'appearance' | 'outfit';

export interface ObservedChar {
    /** Normalised canonical name. */
    key: string;
    /** Canonical name (DES alias resolved). */
    name: string;
    rel?: string;
    /** Appearance and outfit fields only, by DES field key. */
    fields: Record<string, string>;
    present: boolean;
}

export interface ObservedQuest {
    title: string;
    main: boolean;
}

/** What one committed reply's DES tracker says, reduced to what signals compare. */
export interface Observation {
    chars: ObservedChar[];
    location: string | null;
    date?: string;
    start?: string;
    end?: string;
    /** Null when the reply has no quest section (not «no quests»). */
    quests: ObservedQuest[] | null;
}

export interface BaseChar {
    name: string;
    rel?: string;
    fields: Record<string, string>;
    /** Undefined until the character was present two turns in a row. */
    present?: boolean;
}

/** What Maestro accepted so far in this chat. Optional parts are set by their first observation. */
export interface SignalsBaseline {
    chars: Record<string, BaseChar>;
    location?: string;
    placeId?: string;
    date?: string;
    start?: string;
    end?: string;
    quests?: ObservedQuest[];
    /** DES aliases: canonical name → normalised aliases, sorted. */
    aliases?: Record<string, string[]>;
    /** Qvink: message stamp → flags (1 memory, 2 long-term). */
    memories?: Record<string, number>;
    /** Name keys already reported as new. */
    names: Record<string, number>;
}

/** One baseline change: key `k` (and sub-key `s`) had value `b` before; no `b` = it did not exist. */
export interface TraceEntry {
    k: string;
    s?: string;
    b?: unknown;
}

export interface SignalSubject {
    type: 'character' | 'place' | 'quest';
    name: string;
    /** Place registry id. */
    id?: string;
}

export interface RawSignal {
    kind: SignalKindName;
    subject?: SignalSubject;
    data: Record<string, unknown>;
}

export interface MemoryObservation {
    index: number;
    /** `send_date|swipe_id` of the message. */
    stamp: string;
    text: string;
    remember: boolean;
}

/** A place change reported by the place registry (M24 onEnter) for this turn. */
export interface EnteredPlace {
    id: string;
    name: string;
    previousId: string | null;
    previousName: string | null;
}

export interface StepOptions {
    /** A forward jump of more than this many story hours is a time skip. */
    timeSkipHours: number;
    /** Appearance and outfit texts less similar than this (Jaccard of word sets) differ. */
    appearanceThreshold: number;
}

export interface StepInput {
    /** The committed reply; null when it has no tracker data. */
    current: Observation | null;
    /** The committed reply before it that had tracker data (the two-turn rule). */
    previous: Observation | null;
    aliases?: Record<string, string[]> | null;
    memories?: MemoryObservation[] | null;
    names?: { current: NameCandidate[]; previous: NameCandidate[]; known: (key: string) => boolean } | null;
    /**
     * The place registry is on: location changes come from its enter events (it owns place identity and applies
     * its own two-turn rule to new places) and the DES location rule is off. `entered` is this turn's change.
     */
    registry?: { entered: EnteredPlace | null } | null;
    options: StepOptions;
}

export interface StepResult {
    signals: RawSignal[];
    trace: TraceEntry[];
}

const LOCATION_SAME = 0.6;
const QUEST_SAME = 0.5;
const MEMORY_TEXT_CHARS = 300;
const MEMORY_KEEP = 200;
const NAMES_KEEP = 500;

const OUTFIT_FIELD_RE =
    /outfit|cloth|attire|wear|dress|garb|apparel|costume|armou?r|uniform|одежд|наряд|костюм|облачен|доспех|форма/i;
const APPEARANCE_FIELD_RE =
    /appear|look|hair|eye|body|face|feature|physi|skin|height|build|scar|tattoo|внешн|облик|волос|глаз|лиц|тел|рост|шрам|татуир/i;

export function emptyBaseline(): SignalsBaseline {
    return { chars: {}, names: {} };
}

/** Appearance or outfit field of a DES character (by its key), null for any other field. */
export function fieldAspect(field: string): AppearanceAspect | null {
    if (OUTFIT_FIELD_RE.test(field)) return 'outfit';
    if (APPEARANCE_FIELD_RE.test(field)) return 'appearance';
    return null;
}

/** Reduces a tracker snapshot; null when it holds nothing. `canonical` maps DES names to canonical names. */
export function observe(
    snapshot: DesTrackerSnapshot | null | undefined,
    canonical: (name: string) => string = (name) => name,
): Observation | null {
    if (!snapshot) return null;
    if (!snapshot.characters.length && !snapshot.infoBox && !snapshot.quests) return null;
    const chars = new Map<string, ObservedChar>();
    for (const character of snapshot.characters) {
        const name = canonical(character.name) || character.name;
        const key = normalizeText(name);
        if (!key) continue;
        const existing = chars.get(key);
        if (existing) {
            existing.present ||= !character.offScene;
            continue;
        }
        const fields: Record<string, string> = {};
        for (const [field, value] of Object.entries(character.details)) {
            if (fieldAspect(field) && value.trim()) fields[field] = value.trim();
        }
        const observed: ObservedChar = { key, name, fields, present: !character.offScene };
        if (character.relationship?.trim()) observed.rel = character.relationship.trim();
        chars.set(key, observed);
    }
    const info = snapshot.infoBox;
    const observation: Observation = {
        chars: [...chars.values()],
        location: cleanLabel(info?.location),
        quests: snapshot.quests
            ? [
                  ...(snapshot.quests.main ? [{ title: snapshot.quests.main, main: true }] : []),
                  ...snapshot.quests.optional.map((title) => ({ title, main: false })),
              ]
            : null,
    };
    if (info?.date) observation.date = info.date;
    if (info?.time?.start) observation.start = info.time.start;
    if (info?.time?.end) observation.end = info.time.end;
    return observation;
}

/* ------------------------------------------------------------------ comparisons */

/** Relationship statuses differ unless their word sets are the same («Friendly» = «very friendly.»). */
export function relationshipChanged(before: string, after: string): boolean {
    const a = tokenSet(before);
    const b = tokenSet(after);
    if (!a.size && !b.size) return normalizeText(before) !== normalizeText(after);
    return !sameTokens(a, b);
}

/**
 * How a DES location relates to the accepted one: 'same' (equal, similar wording, or coarser — DES dropped the room
 * for a turn), 'refined' (the accepted one plus more detail) or 'different'.
 */
export function compareLocations(base: string, next: string): 'same' | 'refined' | 'different' {
    const a = normalizePlaceName(base);
    const b = normalizePlaceName(next);
    if (a === b) return 'same';
    const before = tokenSet(a);
    const after = tokenSet(b);
    if (containsAll(before, after)) return 'same';
    if (containsAll(after, before)) return 'refined';
    return jaccard(before, after) >= LOCATION_SAME ? 'same' : 'different';
}

/** One quest in two wordings: equal text, similar word sets, or one set inside the other (two words or more). */
export function sameQuest(a: string, b: string): boolean {
    if (normalizeText(a) === normalizeText(b)) return true;
    const left = tokenSet(a);
    const right = tokenSet(b);
    if (jaccard(left, right) >= QUEST_SAME) return true;
    const smaller = left.size <= right.size ? left : right;
    const larger = smaller === left ? right : left;
    return smaller.size >= 2 && containsAll(larger, smaller);
}

/* ------------------------------------------------------------------ trace */

function clone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

type Container = Record<string, unknown>;

/** Records the value of a baseline key the first time a step touches it. */
class Tracer {
    readonly trace: TraceEntry[] = [];
    private readonly touched = new Set<string>();

    constructor(private readonly baseline: SignalsBaseline) {}

    touch(k: keyof SignalsBaseline, s?: string): void {
        const id = s === undefined ? k : `${k}\u0000${s}`;
        if (this.touched.has(id)) return;
        this.touched.add(id);
        const root = this.baseline as unknown as Container;
        const holder = s === undefined ? root : (root[k] as Container | undefined);
        const before = s === undefined ? root[k] : holder?.[s];
        const entry: TraceEntry = { k };
        if (s !== undefined) entry.s = s;
        if (before !== undefined) entry.b = clone(before);
        this.trace.push(entry);
    }
}

/** Undoes a step's trace (newest entry first). */
export function rollbackTrace(baseline: SignalsBaseline, trace: readonly TraceEntry[]): void {
    const root = baseline as unknown as Container;
    for (let i = trace.length - 1; i >= 0; i--) {
        const entry = trace[i] as TraceEntry;
        const had = Object.prototype.hasOwnProperty.call(entry, 'b');
        if (entry.s === undefined) {
            if (had) root[entry.k] = clone(entry.b);
            else delete root[entry.k];
            continue;
        }
        let holder = root[entry.k] as Container | undefined;
        if (!holder || typeof holder !== 'object') {
            if (!had) continue;
            holder = {};
            root[entry.k] = holder;
        }
        if (had) holder[entry.s] = clone(entry.b);
        else delete holder[entry.s];
    }
    baseline.chars ??= {};
    baseline.names ??= {};
}

/* ------------------------------------------------------------------ parts of a step */

interface Ctx {
    baseline: SignalsBaseline;
    tracer: Tracer;
    signals: RawSignal[];
    input: StepInput;
}

function characterSignals(ctx: Ctx, current: Observation, previous: Observation | null): void {
    const { baseline, tracer, signals } = ctx;
    const threshold = ctx.input.options.appearanceThreshold;
    const before = new Map((previous?.chars ?? []).map((char) => [char.key, char]));
    const now = new Map(current.chars.map((char) => [char.key, char]));
    for (const char of current.chars) {
        let base = baseline.chars[char.key];
        if (!base) {
            tracer.touch('chars', char.key);
            base = { name: char.name, fields: {} };
            baseline.chars[char.key] = base;
        }
        const subject: SignalSubject = { type: 'character', name: base.name };
        if (char.rel) {
            if (base.rel === undefined) {
                tracer.touch('chars', char.key);
                base.rel = char.rel;
            } else if (relationshipChanged(base.rel, char.rel)) {
                signals.push({
                    kind: 'relationship.changed',
                    subject,
                    data: { name: base.name, from: base.rel, to: char.rel },
                });
                tracer.touch('chars', char.key);
                base.rel = char.rel;
            }
        }
        const changes: Record<string, unknown>[] = [];
        const earlier = before.get(char.key);
        for (const [field, value] of Object.entries(char.fields)) {
            const accepted = base.fields[field];
            if (accepted === undefined) {
                tracer.touch('chars', char.key);
                base.fields[field] = value;
                continue;
            }
            if (!textsDiffer(accepted, value, threshold)) continue;
            const last = earlier?.fields[field];
            if (last === undefined || textsDiffer(last, value, threshold)) continue;
            changes.push({
                field,
                aspect: fieldAspect(field) ?? 'appearance',
                from: accepted,
                to: value,
                ...wordDiff(accepted, value),
            });
            tracer.touch('chars', char.key);
            base.fields[field] = value;
        }
        if (changes.length) signals.push({ kind: 'appearance.changed', subject, data: { name: base.name, changes } });
        if (char.present && previous && earlier?.present && base.present !== true) {
            signals.push({
                kind: 'character.appeared',
                subject,
                data: { name: base.name, first: base.present === undefined },
            });
            tracer.touch('chars', char.key);
            base.present = true;
        }
    }
    if (!previous) return;
    for (const [key, base] of Object.entries(baseline.chars)) {
        if (base.present !== true || now.get(key)?.present || before.get(key)?.present) continue;
        signals.push({
            kind: 'character.left',
            subject: { type: 'character', name: base.name },
            data: { name: base.name },
        });
        tracer.touch('chars', key);
        base.present = false;
    }
}

function desLocation(ctx: Ctx, current: Observation, previous: Observation | null): void {
    const { baseline, tracer } = ctx;
    const label = current.location;
    if (!label) return;
    if (baseline.location === undefined) {
        tracer.touch('location');
        baseline.location = label;
        return;
    }
    const relation = compareLocations(baseline.location, label);
    if (relation === 'same') return;
    if (relation === 'refined') {
        tracer.touch('location');
        baseline.location = label;
        return;
    }
    // Two turns: the previous reply named the same place (a more specific label is not seen twice yet).
    const last = previous?.location;
    if (!last || compareLocations(last, label) !== 'same') return;
    ctx.signals.push({
        kind: 'location.changed',
        subject: { type: 'place', name: label },
        data: { from: baseline.location, to: label, via: 'des' },
    });
    tracer.touch('location');
    tracer.touch('placeId');
    baseline.location = label;
    delete baseline.placeId;
}

function registryLocation(ctx: Ctx, entered: EnteredPlace): void {
    const { baseline, tracer } = ctx;
    if (entered.id === baseline.placeId) return;
    const data: Record<string, unknown> = {
        from: entered.previousName ?? baseline.location ?? null,
        to: entered.name,
        placeId: entered.id,
        via: 'places',
    };
    const previousId = entered.previousId ?? baseline.placeId;
    if (previousId) data.previousPlaceId = previousId;
    ctx.signals.push({
        kind: 'location.changed',
        subject: { type: 'place', name: entered.name, id: entered.id },
        data,
    });
    tracer.touch('location');
    tracer.touch('placeId');
    baseline.location = entered.name;
    baseline.placeId = entered.id;
}

function timeSignals(ctx: Ctx, current: Observation): void {
    const { baseline, tracer } = ctx;
    if (!current.date && !current.start && !current.end) return;
    if (baseline.date || baseline.start || baseline.end) {
        const before = { date: baseline.date, start: baseline.start, end: baseline.end };
        const jump = timeJump(before, current, ctx.input.options.timeSkipHours);
        if (jump.skipped) {
            const data: Record<string, unknown> = { dateChanged: jump.dateChanged };
            if (before.date) data.fromDate = before.date;
            if (current.date) data.toDate = current.date;
            const fromTime = before.end ?? before.start;
            const toTime = current.start ?? current.end;
            if (fromTime) data.fromTime = fromTime;
            if (toTime) data.toTime = toTime;
            if (jump.hours !== undefined) data.hours = jump.hours;
            ctx.signals.push({ kind: 'time.skipped', data });
        }
    }
    tracer.touch('date');
    tracer.touch('start');
    tracer.touch('end');
    if (current.date) baseline.date = current.date;
    if (current.start) baseline.start = current.start;
    else delete baseline.start;
    if (current.end) baseline.end = current.end;
    else delete baseline.end;
}

function questSignals(ctx: Ctx, current: Observation, previous: Observation | null): void {
    const { baseline, tracer } = ctx;
    const quests = current.quests;
    if (!quests) return;
    if (!baseline.quests) {
        tracer.touch('quests');
        baseline.quests = clone(quests);
        return;
    }
    const last = previous?.quests;
    if (!last) return;
    const next = clone(baseline.quests);
    let changed = false;
    for (const quest of quests) {
        if (next.some((item) => sameQuest(item.title, quest.title))) continue;
        if (!last.some((item) => sameQuest(item.title, quest.title))) continue;
        ctx.signals.push({
            kind: 'quest.added',
            subject: { type: 'quest', name: quest.title },
            data: { title: quest.title, main: quest.main },
        });
        next.push({ ...quest });
        changed = true;
    }
    for (const accepted of [...next]) {
        if (quests.some((item) => sameQuest(item.title, accepted.title))) continue;
        if (last.some((item) => sameQuest(item.title, accepted.title))) continue;
        ctx.signals.push({
            kind: 'quest.removed',
            subject: { type: 'quest', name: accepted.title },
            data: { title: accepted.title, main: accepted.main },
        });
        next.splice(next.indexOf(accepted), 1);
        changed = true;
    }
    if (!changed) return;
    tracer.touch('quests');
    baseline.quests = next;
}

function aliasSignals(ctx: Ctx, aliases: Record<string, string[]>): void {
    const { baseline, tracer } = ctx;
    const normalised = (canonical: string, list: readonly string[]): string[] => {
        const own = normalizeText(canonical);
        const set = new Set(list.map(normalizeText).filter((alias) => alias && alias !== own));
        return [...set].sort();
    };
    if (!baseline.aliases) {
        tracer.touch('aliases');
        baseline.aliases = Object.fromEntries(
            Object.entries(aliases).map(([canonical, list]) => [canonical, normalised(canonical, list)]),
        );
        return;
    }
    const known = baseline.aliases;
    for (const [canonical, list] of Object.entries(aliases)) {
        const next = normalised(canonical, list);
        const had = new Set(known[canonical] ?? []);
        const added: string[] = [];
        const seen = new Set<string>();
        for (const alias of list) {
            const key = normalizeText(alias);
            if (!key || had.has(key) || seen.has(key) || key === normalizeText(canonical)) continue;
            seen.add(key);
            added.push(alias.trim());
        }
        if (added.length) {
            ctx.signals.push({
                kind: 'alias.added',
                subject: { type: 'character', name: canonical },
                data: { name: canonical, aliases: added },
            });
        }
        if (JSON.stringify(next) !== JSON.stringify(known[canonical])) {
            tracer.touch('aliases', canonical);
            known[canonical] = next;
        }
    }
    for (const canonical of Object.keys(known)) {
        if (Object.prototype.hasOwnProperty.call(aliases, canonical)) continue;
        tracer.touch('aliases', canonical);
        delete known[canonical];
    }
}

function clip(text: string, max: number): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function memorySignals(ctx: Ctx, memories: readonly MemoryObservation[]): void {
    const { baseline, tracer } = ctx;
    // The long-term flag counts once the memory has text (Qvink may mark a message before summarising it).
    const flagsOf = (memory: MemoryObservation): number => (memory.text.trim() ? 1 | (memory.remember ? 2 : 0) : 0);
    if (!baseline.memories) {
        tracer.touch('memories');
        baseline.memories = Object.fromEntries(memories.map((memory) => [memory.stamp, flagsOf(memory)]));
        return;
    }
    const known = baseline.memories;
    const added: { index: number; text: string }[] = [];
    const long: { index: number; text: string }[] = [];
    for (const memory of memories) {
        const flags = flagsOf(memory);
        const old = known[memory.stamp] ?? 0;
        if (flags === old) continue;
        const item = { index: memory.index, text: clip(memory.text, MEMORY_TEXT_CHARS) };
        if (flags & 1 && !(old & 1)) added.push(item);
        if (flags & 2 && !(old & 2)) long.push(item);
        tracer.touch('memories', memory.stamp);
        known[memory.stamp] = flags;
    }
    if (added.length) ctx.signals.push({ kind: 'memory.added', data: { items: added } });
    if (long.length) ctx.signals.push({ kind: 'memory.long', data: { items: long } });
    // Messages that left the window are never compared again: forget them (not traced, it is only a cache).
    const stamps = Object.keys(known);
    if (stamps.length > MEMORY_KEEP) {
        const window = new Set(memories.map((memory) => memory.stamp));
        for (const stamp of stamps) if (!window.has(stamp)) delete known[stamp];
    }
}

function nameSignals(ctx: Ctx, names: NonNullable<StepInput['names']>): void {
    const { baseline, tracer } = ctx;
    const earlier = new Set(names.previous.map((candidate) => candidate.key));
    for (const candidate of names.current) {
        if (baseline.names[candidate.key] || names.known(candidate.key)) continue;
        if (!candidate.quoted && !earlier.has(candidate.key)) continue;
        ctx.signals.push({ kind: 'name.new', data: { name: candidate.name, quoted: candidate.quoted } });
        tracer.touch('names', candidate.key);
        baseline.names[candidate.key] = 1;
    }
    const keys = Object.keys(baseline.names);
    for (const key of keys.slice(0, Math.max(0, keys.length - NAMES_KEEP))) delete baseline.names[key];
}

/* ------------------------------------------------------------------ step and fold */

/** Signals of one committed reply; updates `baseline` in place and returns the trace that undoes it. */
export function step(baseline: SignalsBaseline, input: StepInput): StepResult {
    baseline.chars ??= {};
    baseline.names ??= {};
    const ctx: Ctx = { baseline, tracer: new Tracer(baseline), signals: [], input };
    const { current, previous } = input;
    if (current) characterSignals(ctx, current, previous);
    if (input.registry) {
        if (input.registry.entered) registryLocation(ctx, input.registry.entered);
    } else if (current) {
        desLocation(ctx, current, previous);
    }
    if (current) {
        timeSignals(ctx, current);
        questSignals(ctx, current, previous);
    }
    const reasons: string[] = [];
    if (ctx.signals.some((signal) => signal.kind === 'location.changed')) reasons.push('location');
    if (ctx.signals.some((signal) => signal.kind === 'time.skipped')) reasons.push('time');
    if (reasons.length) ctx.signals.push({ kind: 'scene.ended', data: { reasons } });
    if (input.aliases) aliasSignals(ctx, input.aliases);
    if (input.memories) memorySignals(ctx, input.memories);
    if (input.names) nameSignals(ctx, input.names);
    return { signals: ctx.signals, trace: ctx.tracer.trace };
}

/** Fold key: kind + subject (characters, places, quests by name or id) + the name of a new name. */
export function foldKey(signal: RawSignal): string {
    const subject = signal.subject
        ? `${signal.subject.type}:${signal.subject.id ?? normalizeText(signal.subject.name)}`
        : '';
    const name = signal.kind === 'name.new' ? normalizeText(String(signal.data.name ?? '')) : '';
    return `${signal.kind}|${subject}|${name}`;
}

function mergeData(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(source)) {
        const current = target[key];
        if (Array.isArray(current) && Array.isArray(value)) {
            const seen = new Set(current.map((item) => JSON.stringify(item)));
            target[key] = [...current, ...value.filter((item) => !seen.has(JSON.stringify(item)))];
        } else if (current === undefined || key === 'to') {
            target[key] = value;
        }
    }
}

/**
 * Same-kind signals of one subject in one batch become one (plan §4.4 «свёртка»): list fields are joined, the latest
 * `to` wins, `data.folded` counts the signals merged in. Returns the signals and the number folded away.
 */
export function foldSignals(signals: readonly RawSignal[]): { signals: RawSignal[]; folded: number } {
    const out: RawSignal[] = [];
    const byKey = new Map<string, RawSignal>();
    let folded = 0;
    for (const signal of signals) {
        const key = foldKey(signal);
        const existing = byKey.get(key);
        if (!existing) {
            const copy: RawSignal = { ...signal, data: { ...signal.data } };
            byKey.set(key, copy);
            out.push(copy);
            continue;
        }
        mergeData(existing.data, signal.data);
        existing.data.folded = (typeof existing.data.folded === 'number' ? existing.data.folded : 0) + 1;
        folded++;
    }
    return { signals: out, folded };
}
