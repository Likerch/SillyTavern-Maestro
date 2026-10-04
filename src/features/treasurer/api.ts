// Treasurer (M21, stage 7 «полностью»): what the game costs — per turn, session and day, by source (main, Qvink,
// Maestro tasks, auto-swipes and regenerations, NAI Anlas from NAI Studio's records) — on top of the core cost meter
// (stage 0: actual OpenRouter cost capture, background daily cap, optional overall daily limit).
// Exposed as app.modules.api<TreasurerApi>('treasurer').
import type { Unsubscribe } from '../../shared/contracts';

export type SpendSource = 'main' | 'regeneration' | 'autoSwipe' | 'qvink' | 'maestro' | 'nai' | 'other';

export interface SpendLine {
    source: SpendSource;
    usd: number;
    /** NAI Anlas spent (source 'nai'). */
    anlas?: number;
    requests: number;
    tokens: { prompt: number; completion: number; cached?: number };
    /** Some entries are estimates from tokens (no cost in the response). */
    estimated: boolean;
}

export interface SpendSummary {
    period: 'turn' | 'session' | 'day';
    from: number;
    to: number;
    totalUsd: number;
    totalAnlas: number;
    lines: SpendLine[];
}

export interface TurnSpend {
    messageIndex: number;
    at: number;
    lines: SpendLine[];
}

export interface TreasurerApi {
    summary(period: 'turn' | 'session' | 'day'): SpendSummary;
    /** Last N turns of this chat with their spend (newest last). */
    turns(limit?: number): TurnSpend[];
    /** Per-day totals of the last N days (from the core meter's daily files). */
    days(limit?: number): Promise<SpendSummary[]>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M21 implementation (optional so that fakes of the stage-7 contract stay valid).
    /**
     * The next main generation is an automatic swipe started by Maestro (M12 calls it next to
     * MetricsApi.noteAutoSwipe): its cost goes to 'autoSwipe' instead of 'regeneration'. Without the call the
     * treasurer falls back to M12's verdicts (action 'swiped').
     */
    noteAutoSwipe?(): void;
}
