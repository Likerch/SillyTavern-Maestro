// Public API of M1 «Журнал лора» (exposed as app.modules.api<LoreJournalApi>('loreJournal')).
import type { Unsubscribe } from '../../shared/contracts';

/** Stack tags attached to an activated entry (plan M1 п. 8). */
export type LoreTag =
    'bunnymo.core' | 'bunnymo.pack' | 'ck.archive' | 'localizer' | 'des.book' | 'canon' | 'maestro.book' | 'constant';

export interface LoreActivation {
    world: string;
    uid: number;
    comment: string;
    chars: number;
    /** Token estimate (getTokenCountAsync on the final content when available). */
    tokens: number;
    position: number;
    depth?: number;
    role?: number;
    order: number;
    /** Scan loop that activated it (1 = initial scan). */
    loop: number;
    /** 0 = matched directly, n = activated through recursion level n. */
    recursionLevel: number;
    /** Entry whose content triggered this one through recursion, when known. */
    via?: { world: string; uid: number };
    /**
     * Matching key, filled lazily by attributeKeys(): `primary` or `primary + secondary`; '' when no key explains
     * the activation (constant, sticky, forced, @@activate) or the entry is gone from its book.
     */
    key?: string;
    /** Activated but cut by the budget (or by a Maestro cap rule); `cut` without `cutBy`: another extension removed it. */
    cut?: boolean;
    cutBy?: 'budget' | 'maestro';
    tags: LoreTag[];
}

export interface TurnLoreRecord {
    /** Assistant message this scan produced (−1 for simulations). */
    messageIndex: number;
    at: number;
    generationType: string;
    activations: LoreActivation[];
    totalChars: number;
    totalTokens: number;
    overflow: boolean;
    budgetTokens?: number;
    /** Canon entries injected by Maestro this turn (M6), for the canon-size summary. */
    canonChars?: number;
    simulated?: boolean;
}

export type BookReason =
    | 'global'
    | 'character'
    | 'characterExtra'
    | 'chat'
    | 'persona'
    | 'desCampaign'
    | 'desAutoLink'
    | 'ckConnector'
    | 'workshop'
    | 'canon';

export interface BookActivationReason {
    book: string;
    reasons: BookReason[];
}

export interface LoreSummaryRow {
    world: string;
    uid?: number;
    comment?: string;
    activations: number;
    avgChars: number;
    lastSeenTurn?: number;
}

export interface LoreSummary {
    turns: number;
    heaviestBooks: LoreSummaryRow[];
    heaviestEntries: LoreSummaryRow[];
    alwaysActive: LoreSummaryRow[];
    neverActive: LoreSummaryRow[];
    avgTotalChars: number;
    avgCanonChars: number;
}

/** A transform applied to entry copies during a simulation (the rules engine uses it for before/after). */
export type EntriesTransform = (lists: {
    globalLore: Record<string, unknown>[];
    characterLore: Record<string, unknown>[];
    chatLore: Record<string, unknown>[];
    personaLore: Record<string, unknown>[];
}) => void;

export interface SimulateOptions {
    /** Disable probability rolls for a deterministic result (default true). */
    deterministic?: boolean;
    /** Rule ids of M22 to suspend during this simulation ("before"). */
    suspendRules?: string[];
    transform?: EntriesTransform;
}

export interface LoreJournalApi {
    /** Stored turns of the current chat, oldest first (`limit` = the newest N). */
    turns(limit?: number): TurnLoreRecord[];
    /** The newest stored turn of the current chat. */
    last(): TurnLoreRecord | undefined;
    whyActive(): Promise<BookActivationReason[]>;
    summary(): LoreSummary;
    /** Dry-run scan on the current chat (sticky/cooldown are not evaluated by ST in dry runs). */
    simulate(options?: SimulateOptions): Promise<TurnLoreRecord>;
    /** Fills `key` for every activation (lazy, may take a moment on big books). */
    attributeKeys(record: TurnLoreRecord): Promise<TurnLoreRecord>;
    onTurn(listener: (record: TurnLoreRecord) => void): Unsubscribe;
    /** True while a simulation runs (other modules may skip side effects). */
    simulating(): boolean;
    /** Rule ids (M22) the running simulation asked to suspend; empty outside simulations. */
    suspendedRules(): string[];
    /**
     * A Maestro rule removed an activated entry during the scan in progress (M22 calls it from its scan
     * listener), so the journal shows it as cut by Maestro instead of by the budget.
     */
    markCut?(world: string, uid: number): void;
    /**
     * Contents of the entries that reached the prompt on the last real turn of this chat (memory only: empty after
     * a reload or a chat switch). M2 uses it to find facts repeated across sources.
     */
    lastContents?(): LoreContent[];
}

export interface LoreContent {
    world: string;
    uid: number;
    comment: string;
    content: string;
}
