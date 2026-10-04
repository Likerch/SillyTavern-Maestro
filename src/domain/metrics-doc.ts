// The per-chat metrics document (chat store kind 'metrics'): rolling turn samples, cost entries, counters, the lore
// baseline and the last "what if" comparison, with caps. Several tabs may append to it, so changes travel as
// batches that are applied at most once per document (`applied[tab] >= seq` means the batch is already in): a
// write that failed after the batch was applied to the store's cached copy never counts it twice. Sealed batches
// are never merged with later ones for the same reason. Pure: the feature reads and writes through app.chat.
import { freezeBaseline } from './metrics-stats';
import type { CostSample, DeviceClass, LoreBaseline, LoreWhatIf } from './metrics-stats';

export const METRICS_DOC_VERSION = 1;

export const DOC_LIMITS = {
    turns: 300,
    costs: 1500,
    counters: 100,
    /** Tabs remembered in `applied` (one per page load that wrote). */
    tabs: 20,
    modules: 24,
} as const;

export interface TurnSample {
    /** `<tab>:<seq>`: unique per tab and generation, so patches from later events find the sample. */
    id: string;
    /** When the request left (epoch ms). */
    at: number;
    type: string;
    device: DeviceClass;
    /** Core mode at the time (economy / balanced / cinema). */
    mode?: string;
    sendMs?: number;
    windowMs?: number;
    maestroMs?: number;
    /** Maestro's whole generate interceptor (producers, generation:before, intercept handlers), when core reports it. */
    interceptMs?: number;
    modules?: Record<string, number>;
    /** Automatic swipe started by Maestro (QC, stage 6). */
    auto?: boolean;
    messageIndex?: number;
    loreChars?: number;
    loreEntries?: number;
    /** Lore rules (M22) that were on. */
    loreRules?: number;
    /** Activations at depth with the assistant role that reached the prompt. */
    assistantDepth?: number;
    promptTokens?: number;
    loreTokens?: number;
    /** Prompt entries Qvink dropped without a summary; absent when the check did not apply (no Qvink removal). */
    dropped?: number;
}

export interface MetricsDoc {
    v: number;
    startedAt: number;
    turns: TurnSample[];
    costs: CostSample[];
    baseline?: LoreBaseline;
    /** The baseline is frozen from turns at or after this time (a reset moves it to "now"). */
    baselineFrom?: number;
    whatIf?: LoreWhatIf;
    /** Named counters (living canon, guardian, data losses, auto-swipes…). */
    counters: Record<string, number>;
    /** Last batch applied per tab. */
    applied: Record<string, number>;
}

/** A turn patch: `id` plus the fields to set. */
export type TurnPatch = Partial<TurnSample> & { id: string };

export interface MetricsBatch {
    tab: string;
    seq: number;
    turns: TurnPatch[];
    costs: CostSample[];
    counters: Record<string, number>;
    /** Set (value) or clear (null) the baseline / what-if; undefined = untouched. */
    baseline?: LoreBaseline | null;
    baselineFrom?: number;
    whatIf?: LoreWhatIf | null;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function emptyMetricsDoc(now = 0): MetricsDoc {
    return { v: METRICS_DOC_VERSION, startedAt: now, turns: [], costs: [], counters: {}, applied: {} };
}

export function emptyBatch(tab: string, seq: number): MetricsBatch {
    return { tab, seq, turns: [], costs: [], counters: {} };
}

export function batchIsEmpty(batch: MetricsBatch): boolean {
    return (
        !batch.turns.length &&
        !batch.costs.length &&
        !Object.keys(batch.counters).length &&
        batch.baseline === undefined &&
        batch.baselineFrom === undefined &&
        batch.whatIf === undefined
    );
}

const NUMBER_FIELDS = [
    'sendMs',
    'windowMs',
    'maestroMs',
    'interceptMs',
    'messageIndex',
    'loreChars',
    'loreEntries',
    'loreRules',
    'assistantDepth',
    'promptTokens',
    'loreTokens',
    'dropped',
] as const;

function readModules(value: unknown): Record<string, number> | undefined {
    if (!isDict(value)) return undefined;
    const out: Record<string, number> = {};
    for (const [label, ms] of Object.entries(value).slice(0, DOC_LIMITS.modules)) {
        const n = num(ms);
        if (n !== undefined && n >= 0) out[label] = n;
    }
    return Object.keys(out).length ? out : undefined;
}

/** A stored or incoming turn sample, validated; null when unusable. */
export function readTurn(value: unknown): TurnSample | null {
    if (!isDict(value) || typeof value.id !== 'string' || !value.id) return null;
    const at = num(value.at);
    if (at === undefined) return null;
    const turn: TurnSample = {
        id: value.id,
        at,
        type: typeof value.type === 'string' ? value.type : 'normal',
        device: value.device === 'phone' ? 'phone' : 'desktop',
    };
    if (typeof value.mode === 'string') turn.mode = value.mode;
    if (value.auto === true) turn.auto = true;
    for (const field of NUMBER_FIELDS) {
        const n = num(value[field]);
        if (n !== undefined) turn[field] = n;
    }
    const modules = readModules(value.modules);
    if (modules) turn.modules = modules;
    return turn;
}

export function readCost(value: unknown): CostSample | null {
    if (!isDict(value) || typeof value.source !== 'string') return null;
    const at = num(value.at);
    const usd = num(value.usd);
    if (at === undefined || usd === undefined) return null;
    const cost: CostSample = { at, source: value.source, usd: Math.max(0, usd) };
    if (typeof value.task === 'string') cost.task = value.task;
    if (value.estimated === true) cost.estimated = true;
    return cost;
}

function readBaseline(value: unknown): LoreBaseline | undefined {
    if (!isDict(value)) return undefined;
    const avgChars = num(value.avgChars);
    const turns = num(value.turns);
    if (avgChars === undefined || turns === undefined) return undefined;
    return {
        avgChars,
        turns,
        from: num(value.from) ?? 0,
        to: num(value.to) ?? 0,
        rulesOff: value.rulesOff === true,
        at: num(value.at) ?? 0,
    };
}

function readWhatIf(value: unknown): LoreWhatIf | undefined {
    if (!isDict(value)) return undefined;
    const before = num(value.before);
    const after = num(value.after);
    if (before === undefined || after === undefined) return undefined;
    return {
        at: num(value.at) ?? 0,
        before,
        after,
        ruleIds: Array.isArray(value.ruleIds) ? value.ruleIds.filter((id): id is string => typeof id === 'string') : [],
        removed: num(value.removed) ?? 0,
    };
}

function readNumberMap(value: unknown, limit: number): Record<string, number> {
    const out: Record<string, number> = {};
    if (!isDict(value)) return out;
    for (const [key, item] of Object.entries(value).slice(0, limit)) {
        const n = num(item);
        if (n !== undefined) out[key] = n;
    }
    return out;
}

const costKey = (cost: CostSample) => `${cost.at}|${cost.source}|${cost.usd}|${cost.task ?? ''}`;

function capTurns(turns: TurnSample[]): TurnSample[] {
    const sorted = turns.sort((a, b) => a.at - b.at);
    return sorted.length > DOC_LIMITS.turns ? sorted.slice(-DOC_LIMITS.turns) : sorted;
}

function capCosts(costs: CostSample[]): CostSample[] {
    const sorted = costs.sort((a, b) => a.at - b.at);
    return sorted.length > DOC_LIMITS.costs ? sorted.slice(-DOC_LIMITS.costs) : sorted;
}

/**
 * Brings whatever is stored (older versions, hand edits, the store's defaults merge) into shape, in place: the
 * chat store writes a document back to the chat it was read from by object identity.
 */
export function normalizeMetricsDoc(doc: Dict, now = 0): MetricsDoc {
    const turns: TurnSample[] = [];
    const seen = new Set<string>();
    for (const raw of Array.isArray(doc.turns) ? doc.turns : []) {
        const turn = readTurn(raw);
        if (turn && !seen.has(turn.id)) {
            seen.add(turn.id);
            turns.push(turn);
        }
    }
    const costs: CostSample[] = [];
    const costSeen = new Set<string>();
    for (const raw of Array.isArray(doc.costs) ? doc.costs : []) {
        const cost = readCost(raw);
        if (cost && !costSeen.has(costKey(cost))) {
            costSeen.add(costKey(cost));
            costs.push(cost);
        }
    }
    const target = doc as unknown as MetricsDoc;
    target.v = METRICS_DOC_VERSION;
    target.startedAt = num(doc.startedAt) ?? now;
    target.turns = capTurns(turns);
    target.costs = capCosts(costs);
    target.counters = readNumberMap(doc.counters, DOC_LIMITS.counters);
    target.applied = readNumberMap(doc.applied, DOC_LIMITS.tabs * 2);
    const baseline = readBaseline(doc.baseline);
    if (baseline) target.baseline = baseline;
    else delete target.baseline;
    const from = num(doc.baselineFrom);
    if (from !== undefined) target.baselineFrom = from;
    else delete target.baselineFrom;
    const whatIf = readWhatIf(doc.whatIf);
    if (whatIf) target.whatIf = whatIf;
    else delete target.whatIf;
    return target;
}

/** Sets the defined fields of a patch on the sample (a patch never clears a field). */
function patchTurn(turn: TurnSample, patch: TurnPatch): void {
    const valid = readTurn({ ...turn, ...patch });
    if (!valid) return;
    for (const [key, value] of Object.entries(valid)) {
        if (value !== undefined) (turn as unknown as Dict)[key] = value;
    }
}

/**
 * Applies a batch once (idempotent per tab and seq). Returns false when the document already had it. New turns
 * need `at`, `type` and `device`; patches for samples that fell out of the window are dropped.
 */
export function applyBatch(doc: MetricsDoc, batch: MetricsBatch): boolean {
    if ((doc.applied[batch.tab] ?? -Infinity) >= batch.seq) return false;
    const byId = new Map(doc.turns.map((turn) => [turn.id, turn]));
    for (const patch of batch.turns) {
        const existing = byId.get(patch.id);
        if (existing) {
            patchTurn(existing, patch);
            continue;
        }
        const turn = readTurn(patch);
        if (!turn) continue;
        doc.turns.push(turn);
        byId.set(turn.id, turn);
    }
    doc.turns = capTurns(doc.turns);
    if (batch.costs.length) {
        const keys = new Set(doc.costs.map(costKey));
        for (const raw of batch.costs) {
            const cost = readCost(raw);
            if (!cost || keys.has(costKey(cost))) continue;
            keys.add(costKey(cost));
            doc.costs.push(cost);
        }
        doc.costs = capCosts(doc.costs);
    }
    for (const [name, delta] of Object.entries(batch.counters)) {
        if (!Number.isFinite(delta) || delta === 0) continue;
        if (!(name in doc.counters) && Object.keys(doc.counters).length >= DOC_LIMITS.counters) continue;
        doc.counters[name] = (doc.counters[name] ?? 0) + delta;
    }
    if (batch.baseline === null) delete doc.baseline;
    else if (batch.baseline) doc.baseline = { ...batch.baseline };
    if (batch.baselineFrom !== undefined) doc.baselineFrom = batch.baselineFrom;
    if (batch.whatIf === null) delete doc.whatIf;
    else if (batch.whatIf) doc.whatIf = { ...batch.whatIf, ruleIds: [...batch.whatIf.ruleIds] };
    doc.applied[batch.tab] = batch.seq;
    const tabs = Object.entries(doc.applied);
    if (tabs.length > DOC_LIMITS.tabs) {
        tabs.sort((a, b) => b[1] - a[1]);
        doc.applied = Object.fromEntries(tabs.slice(0, DOC_LIMITS.tabs));
    }
    return true;
}

/**
 * Freezes the lore baseline once `size` turns with lore data exist after `baselineFrom` (deterministic, so tabs
 * that save the same turns agree). Returns true when it was set now.
 */
export function freezeDocBaseline(doc: MetricsDoc, size: number, now: number): boolean {
    if (doc.baseline) return false;
    const from = doc.baselineFrom ?? 0;
    const baseline = freezeBaseline(
        doc.turns.filter((turn) => turn.at >= from),
        size,
        now,
    );
    if (!baseline) return false;
    doc.baseline = baseline;
    return true;
}

/** A deep copy for display (the stored object stays the store's). */
export function copyMetricsDoc(doc: MetricsDoc): MetricsDoc {
    return normalizeMetricsDoc(JSON.parse(JSON.stringify(doc)) as Dict, doc.startedAt);
}
