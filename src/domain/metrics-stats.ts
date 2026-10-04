// Measurements for the R3 criteria (plan §14, P15, §4.11-4.12; dev-plan 4.6): percentiles, device class, send-path
// latency per device, the background cost share over the last N turns and the lore baseline. Pure: the metrics
// feature collects the samples and stores them in its per-chat document (metrics-doc.ts).

export type DeviceClass = 'desktop' | 'phone';

/** P15: Maestro's added time before the request leaves, 95th percentile. */
export const LATENCY_TARGET_MS: Readonly<Record<DeviceClass, number>> = { desktop: 200, phone: 600 };
/** Below this viewport width a window counts as a phone (the pult switches to its phone layout there too). */
export const PHONE_MAX_WIDTH = 768;
/** A p95 over fewer samples says little: the verdict waits for this many. */
export const MIN_LATENCY_SAMPLES = 20;
/** Criterion 2: Maestro's background spend ≤ 15 % of the main model's over 100 turns. */
export const COST_SHARE_TARGET = 0.15;
export const COST_WINDOW_TURNS = 100;
export const MIN_COST_TURNS = 20;
/** Criterion 3: lore characters per turn at least halved. */
export const LORE_RATIO_TARGET = 0.5;
export const BASELINE_TURNS = 50;
export const MIN_LORE_TURNS = 10;

export const DEVICES: readonly DeviceClass[] = ['desktop', 'phone'];

/** Phone when the primary pointer is coarse (touch) or the window is narrower than PHONE_MAX_WIDTH. */
export function deviceClass(input: { coarsePointer?: boolean; width?: number }): DeviceClass {
    if (input.coarsePointer === true) return 'phone';
    const width = input.width;
    return typeof width === 'number' && Number.isFinite(width) && width > 0 && width < PHONE_MAX_WIDTH
        ? 'phone'
        : 'desktop';
}

function finite(values: readonly unknown[]): number[] {
    return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

/**
 * Nearest-rank percentile (`p` in 0..100) of the finite values; undefined for an empty list. Nearest rank never
 * interpolates, so a p95 is always a latency that really happened (the conservative choice for a budget).
 */
export function percentile(values: readonly number[], p: number): number | undefined {
    const list = finite(values).sort((a, b) => a - b);
    if (!list.length) return undefined;
    const clamped = Math.min(100, Math.max(0, Number.isFinite(p) ? p : 0));
    const rank = Math.ceil((clamped / 100) * list.length);
    return list[Math.max(0, rank - 1)];
}

export interface Distribution {
    n: number;
    p50?: number;
    p95?: number;
    max?: number;
    mean?: number;
}

export function distribution(values: readonly number[]): Distribution {
    const list = finite(values);
    if (!list.length) return { n: 0 };
    const sum = list.reduce((total, value) => total + value, 0);
    return {
        n: list.length,
        p50: percentile(list, 50),
        p95: percentile(list, 95),
        max: Math.max(...list),
        mean: sum / list.length,
    };
}

/* ------------------------------------------------------------------ latency */

export interface LatencySample {
    device: DeviceClass;
    /** generation:before (Maestro's interceptor) → the chat-completion request leaves (fetch gate). */
    sendMs?: number;
    /** GENERATION_STARTED → the request leaves: ST's whole send path, an upper bound for context. */
    windowMs?: number;
    /** Time Maestro's own code reported: the interceptor segment plus module timings (time()/record()). */
    maestroMs?: number;
    /** Module timings booked during this generation (label → ms). */
    modules?: Record<string, number>;
}

export interface DeviceLatency {
    send: Distribution;
    window: Distribution;
    maestro: Distribution;
}

export interface LatencySummary {
    byDevice: Record<DeviceClass, DeviceLatency>;
    /** Per module label: the time it added to a generation (only generations where it reported). */
    modules: Record<string, Distribution>;
}

export function summarizeLatency(samples: readonly LatencySample[]): LatencySummary {
    const byDevice = {} as Record<DeviceClass, DeviceLatency>;
    for (const device of DEVICES) {
        const own = samples.filter((sample) => sample.device === device);
        byDevice[device] = {
            send: distribution(own.map((sample) => sample.sendMs as number)),
            window: distribution(own.map((sample) => sample.windowMs as number)),
            maestro: distribution(own.map((sample) => sample.maestroMs as number)),
        };
    }
    const perModule = new Map<string, number[]>();
    for (const sample of samples) {
        for (const [label, ms] of Object.entries(sample.modules ?? {})) {
            let list = perModule.get(label);
            if (!list) perModule.set(label, (list = []));
            list.push(ms);
        }
    }
    const modules: Record<string, Distribution> = {};
    for (const [label, list] of [...perModule].sort((a, b) => a[0].localeCompare(b[0]))) {
        modules[label] = distribution(list);
    }
    return { byDevice, modules };
}

export type Verdict = 'ok' | 'warn' | 'none';

/** Criterion 1: every device with enough samples meets its budget; none has enough → no verdict. */
export function latencyVerdict(summary: LatencySummary, minSamples = MIN_LATENCY_SAMPLES): Verdict {
    let judged = false;
    for (const device of DEVICES) {
        const own = summary.byDevice[device].maestro;
        if (own.n < minSamples || own.p95 === undefined) continue;
        judged = true;
        if (own.p95 > LATENCY_TARGET_MS[device]) return 'warn';
    }
    return judged ? 'ok' : 'none';
}

/* ------------------------------------------------------------------ cost share */

export interface CostSample {
    at: number;
    source: string;
    usd: number;
    task?: string;
    estimated?: boolean;
}

export interface TurnMark {
    at: number;
    /** An automatic swipe Maestro started (M12, stage 6): its main-model cost counts as Maestro's. */
    auto?: boolean;
}

export interface CostShare {
    /** Turns inside the window. */
    turns: number;
    /** Start of the window (the oldest turn in it); 0 when no turn is known. */
    from: number;
    mainUsd: number;
    /** Maestro's own LLM tasks plus automatic swipes. */
    backgroundUsd: number;
    maestroUsd: number;
    autoSwipeUsd: number;
    autoSwipes: number;
    /** Neighbours, reported apart (not Maestro's spend). */
    qvinkUsd: number;
    otherUsd: number;
    /** Entries without a real price (usd estimated or 0). */
    estimated: number;
    /** backgroundUsd / mainUsd; undefined while the main model cost nothing. */
    share?: number;
}

/**
 * Background share over the last `windowTurns` turns (plan §14 п. 2): Maestro's tasks and auto-swipes against the
 * main model. A main entry belongs to the newest turn that started at or before it; a turn marked `auto` moves its
 * main cost to the background side.
 */
export function costShare(
    costs: readonly CostSample[],
    turns: readonly TurnMark[],
    windowTurns = COST_WINDOW_TURNS,
): CostShare {
    const sorted = [...turns].filter((turn) => Number.isFinite(turn.at)).sort((a, b) => a.at - b.at);
    const window = sorted.slice(-Math.max(1, Math.floor(windowTurns)));
    const from = window[0]?.at ?? 0;
    const result: CostShare = {
        turns: window.length,
        from,
        mainUsd: 0,
        backgroundUsd: 0,
        maestroUsd: 0,
        autoSwipeUsd: 0,
        autoSwipes: window.filter((turn) => turn.auto).length,
        qvinkUsd: 0,
        otherUsd: 0,
        estimated: 0,
    };
    const ownerOf = (at: number): TurnMark | undefined => {
        let owner: TurnMark | undefined;
        for (const turn of window) {
            if (turn.at <= at) owner = turn;
            else break;
        }
        return owner;
    };
    for (const cost of costs) {
        if (!Number.isFinite(cost.at) || cost.at < from) continue;
        const usd = Number.isFinite(cost.usd) && cost.usd > 0 ? cost.usd : 0;
        if (cost.estimated || usd === 0) result.estimated++;
        switch (cost.source) {
            case 'main':
                if (ownerOf(cost.at)?.auto) result.autoSwipeUsd += usd;
                else result.mainUsd += usd;
                break;
            case 'maestro':
                result.maestroUsd += usd;
                break;
            case 'qvink':
                result.qvinkUsd += usd;
                break;
            default:
                result.otherUsd += usd;
        }
    }
    result.backgroundUsd = result.maestroUsd + result.autoSwipeUsd;
    if (result.mainUsd > 0) result.share = result.backgroundUsd / result.mainUsd;
    return result;
}

export function costVerdict(share: CostShare, minTurns = MIN_COST_TURNS): Verdict {
    if (share.turns < minTurns || share.share === undefined) return 'none';
    return share.share <= COST_SHARE_TARGET ? 'ok' : 'warn';
}

/* ------------------------------------------------------------------ lore chars per turn */

export interface LoreTurn {
    at: number;
    loreChars?: number;
    /** Lore rules (M22) that were on for this turn. */
    loreRules?: number;
}

export interface LoreBaseline {
    avgChars: number;
    turns: number;
    from: number;
    to: number;
    /** Most baseline turns ran without Maestro's lore rules: the baseline is "before Maestro". */
    rulesOff: boolean;
    at: number;
}

export interface LoreWhatIf {
    at: number;
    /** Lore characters of the current chat without / with the lore rules (M1 dry runs through M22 compare()). */
    before: number;
    after: number;
    ruleIds: string[];
    /** Entries active only without the rules. */
    removed: number;
}

function loreTurns(turns: readonly LoreTurn[]): LoreTurn[] {
    return turns
        .filter((turn) => typeof turn.loreChars === 'number' && Number.isFinite(turn.loreChars))
        .sort((a, b) => a.at - b.at);
}

/** Average lore characters over the newest `limit` turns that carry lore data. */
export function averageLore(turns: readonly LoreTurn[], limit?: number): { avg?: number; turns: number } {
    const list = loreTurns(turns);
    const size = limit === undefined ? list.length : Math.max(0, Math.floor(limit));
    const window = size > 0 ? list.slice(-size) : [];
    if (!window.length) return { turns: 0 };
    return { avg: window.reduce((sum, turn) => sum + (turn.loreChars ?? 0), 0) / window.length, turns: window.length };
}

/** The first `size` turns with lore data become the baseline once that many are known; undefined before. */
export function freezeBaseline(turns: readonly LoreTurn[], size = BASELINE_TURNS, now = 0): LoreBaseline | undefined {
    const list = loreTurns(turns);
    if (size < 1 || list.length < size) return undefined;
    const first = list.slice(0, size);
    const off = first.filter((turn) => (turn.loreRules ?? 0) === 0).length;
    return {
        avgChars: first.reduce((sum, turn) => sum + (turn.loreChars ?? 0), 0) / first.length,
        turns: first.length,
        from: first[0]!.at,
        to: first[first.length - 1]!.at,
        rulesOff: off * 2 >= first.length,
        at: now,
    };
}

export interface LoreRatio {
    ratio?: number;
    source: 'whatIf' | 'baseline' | 'none';
    /** The baseline exists but was taken with the lore rules on (says nothing about Maestro's effect). */
    baselineWithRules?: boolean;
}

/**
 * Criterion 3 ratio (current / before Maestro): a fresh "what if" dry run wins; otherwise the frozen baseline,
 * but only when it was taken with the lore rules off and enough current turns exist.
 */
export function loreRatio(input: {
    whatIf?: LoreWhatIf;
    baseline?: LoreBaseline;
    current?: { avg?: number; turns: number };
    minTurns?: number;
}): LoreRatio {
    const { whatIf, baseline, current } = input;
    if (whatIf && whatIf.before > 0) return { ratio: whatIf.after / whatIf.before, source: 'whatIf' };
    if (baseline && !baseline.rulesOff) return { source: 'none', baselineWithRules: true };
    const minTurns = input.minTurns ?? MIN_LORE_TURNS;
    if (baseline && baseline.avgChars > 0 && current?.avg !== undefined && current.turns >= minTurns) {
        return { ratio: current.avg / baseline.avgChars, source: 'baseline' };
    }
    return { source: 'none' };
}

export function loreVerdict(ratio: LoreRatio): Verdict {
    if (ratio.ratio === undefined) return 'none';
    return ratio.ratio <= LORE_RATIO_TARGET ? 'ok' : 'warn';
}
