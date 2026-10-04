// Public API of M21m «Замеры» (R3 criteria, plan §14; dev-plan 4.6), exposed as app.modules.api<MetricsApi>('metrics').
// Other modules may opt in: time()/record() book their own time on the send path, count() feeds counters that no
// API exposes (living canon decisions), noteAutoSwipe() marks the quality check's automatic swipes (stage 6).
import type { CriterionRow } from '../../domain/metrics-report';
import type {
    CostShare,
    DeviceClass,
    LatencySummary,
    LoreBaseline,
    LoreRatio,
    LoreWhatIf,
} from '../../domain/metrics-stats';
import type { PackComparison } from '../../domain/metrics-checks';
import type { Unsubscribe } from '../../shared/contracts';

export type { CriterionKey, CriterionRow } from '../../domain/metrics-report';
export type {
    CostShare,
    DeviceClass,
    Distribution,
    LatencySummary,
    LoreBaseline,
    LoreRatio,
    LoreWhatIf,
    Verdict,
} from '../../domain/metrics-stats';
export type { PackComparison } from '../../domain/metrics-checks';

/**
 * Counters other modules may bump with count(). Living canon (M26) feeds criterion 8 this way unless its API grows
 * a stats() method; the guardian and data-loss counters are kept by M21m itself.
 */
export const METRIC_COUNTERS = {
    /** A fact became provisional (M26). */
    livingProvisional: 'livingCanon.provisional',
    /** The user dropped a provisional fact (M26). */
    livingDropped: 'livingCanon.droppedByUser',
    /** A provisional fact was confirmed (M26). */
    livingConfirmed: 'livingCanon.confirmed',
    /** A confirmed fact was contradicted later (M26 + contradictions). */
    livingContradicted: 'livingCanon.contradictedAfterConfirm',
    /** Automatic swipes Maestro started (M12). */
    autoSwipes: 'qc.autoSwipe',
    /** A settings/preset/lorebook save left while the tab was stale (the guard missed it). */
    staleSaves: 'guardian.staleSave',
    /** The tab turned stale (another tab or device saved later). */
    staleEpisodes: 'guardian.staleEpisode',
    /** A failed write or an action that was applied but not journaled (warnings in the log). */
    dataLosses: 'data.loss',
} as const;

export interface LoreState {
    current: { avg?: number; turns: number };
    baseline?: LoreBaseline;
    whatIf?: LoreWhatIf;
    ratio: LoreRatio;
}

export interface CriteriaReport {
    generatedAt: number;
    /** Turns sampled in this chat. */
    turns: number;
    startedAt: number;
    device: DeviceClass;
    rows: CriterionRow[];
}

export interface MetricsApi {
    /**
     * Runs `fn` and books its duration under `label` for the generation in flight (send path) or as idle time.
     * Promises are timed until they settle. Never throws on its own; errors of `fn` pass through.
     */
    time<T>(label: string, fn: () => T): T;
    /** Books a duration the caller measured itself. */
    record(label: string, ms: number): void;
    /** Bumps a named counter of this chat (see METRIC_COUNTERS). */
    count(counter: string, delta?: number): void;
    /** The next main generation is an automatic swipe started by Maestro: its cost counts as background. */
    noteAutoSwipe(): void;
    /** Device class of this tab now. */
    device(): DeviceClass;
    latency(): LatencySummary;
    costShare(): CostShare;
    lore(): LoreState;
    /** Dry-runs the current chat with and without the enabled lore rules (M1 + M22) and stores the result. */
    compareLore(): Promise<LoreWhatIf | null>;
    /** Freezes a new lore baseline from the next turns (forgets the stored one). */
    resetBaseline(): Promise<void>;
    /** Fingerprints the BunnyMo books now and compares them with the stored ones (reads only). */
    checkPacks(): Promise<PackComparison | null>;
    /** Takes the current fingerprints as the new reference (after an intended pack update). */
    acceptPacks(): Promise<void>;
    criteria(): Promise<CriteriaReport>;
    exportReport(format: 'json' | 'markdown'): Promise<string>;
    onChange(listener: () => void): Unsubscribe;
}

/** Optional additions other modules may expose for criterion 6-8 (duck-typed; M21m tolerates their absence). */
export interface GuardianStats {
    guardInfo?(): { held: Record<string, number>; vetoed: Record<string, number> } | undefined;
}

export interface LivingCanonStats {
    stats?(): { provisional: number; droppedByUser: number; confirmed?: number; contradictedAfterConfirm: number };
}

export interface RevisionStats {
    stats?(): { decisions: number; acceptedAsIs: number; edited: number; rejected: number };
}
