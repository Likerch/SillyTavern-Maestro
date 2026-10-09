// Prompt architect (M20, stage 7): budgets per source, presence/place damping of lore, duplicate facts across
// sources, cache-friendly order and provider cache measurement. Book caps and recursion limits stay rules of M22
// (stage 1); scan-only glosses stay in M6 (stage 2). Every rule shows its effect in the inspector (before/after).
// Exposed as app.modules.api<ArchitectApi>('architect').
import type { Unsubscribe } from '../../shared/contracts';

/** Prompt sources with a budget (plan M20 п.1). Tokens; 0 = no budget. */
export type BudgetSource = 'lore' | 'ckRag' | 'qvink' | 'des' | 'voices' | 'mechanics' | 'director' | 'dramatis';

export interface SourceBudget {
    source: BudgetSource;
    tokens: number;
    /** Per-book caps for 'lore' are M22's (book caps); here: the total lore budget across books. */
}

/** What the presence/place rule did to one lore entry on the last scan. */
export interface DampedEntry {
    world: string;
    uid: number;
    comment: string;
    /** Entity the entry is about (world model id), absent or far place. */
    entity: string;
    reason: 'absent' | 'farPlace';
    /** Messages since the entity was last mentioned. */
    sinceMention: number;
}

/** One fact present in several sources of the same prompt (M2 report first, then one source by consent). */
export interface DuplicateFact {
    id: string;
    text: string;
    sources: { owner: string; ref: string; tokens: number }[];
    /** The source the user chose to keep (dedup on); null = report only. */
    keep: string | null;
}

export interface CacheStats {
    /** Provider prompt-cache hits/misses from responses (OpenRouter `usage.prompt_tokens_details.cached_tokens`, DeepSeek `prompt_cache_hit_tokens`). */
    requests: number;
    cachedTokens: number;
    promptTokens: number;
    /** cachedTokens / promptTokens over the window. */
    hitRate: number;
    /** Where the prompt first changes between consecutive requests (message index from the start), median. */
    firstChangeAt: number | null;
}

export interface ArchitectReport {
    at: number;
    budgets: { source: BudgetSource; limit: number; used: number; cut: number; status?: BudgetStatus }[];
    damped: DampedEntry[];
    duplicates: DuplicateFact[];
    // Additions of the M20 implementation (optional so that fakes of the stage-7 contract stay valid).
    /** Assistant message the prompt produced (set once the reply is rendered). */
    messageIndex?: number;
    generationType?: string;
    /** Entries forced into the scan: present characters, the current place. */
    pinned?: PinnedEntry[];
    /** Lore activations removed by the lore budget. */
    cuts?: LoreCut[];
    /** Injections shortened to their budget. */
    trims?: InjectionTrim[];
    /** Copies of duplicate facts dropped by the user's consent. */
    dropped?: DroppedCopy[];
    /** Maestro's volatile injections found before stable content (P16). */
    order?: OrderViolation[];
    /** Before/after of every rule this turn (tokens are estimates where ST gives no count). */
    effects?: RuleEffect[];
}

/**
 * How a budget fared this turn: 'off' (no budget), 'ok' (fits), 'trimmed' / 'cut' (shortened), 'over' (could not
 * be brought under the limit), 'empty' (the source sent nothing), 'notFound' (its text was not found in the prompt),
 * 'noSource' (the source comes in a later stage), 'na' (nothing of it may be cut).
 */
export type BudgetStatus = 'off' | 'ok' | 'trimmed' | 'cut' | 'over' | 'empty' | 'notFound' | 'noSource' | 'na';

export interface PinnedEntry {
    world: string;
    uid: number;
    comment: string;
    entity: string;
    reason: 'present' | 'currentPlace';
    tokens: number;
}

export interface LoreCut {
    world: string;
    uid: number;
    comment: string;
    tokens: number;
    order: number;
}

export interface InjectionTrim {
    source: BudgetSource;
    /** Extension prompt key (`carrotkernel_rag`, `qvink_memory_short`, `dooms-tracker-context`). */
    key: string;
    before: number;
    after: number;
    /** Chunks, memories or sentences removed. */
    units: number;
}

export interface DroppedCopy {
    duplicateId: string;
    owner: string;
    ref: string;
    tokens: number;
}

export interface OrderViolation {
    key: string;
    messageIndex: number;
    /** Messages after the injection that were already in the previous request. */
    stableAfter: number;
    position: number;
    depth: number;
}

export type RuleEffectId = 'damp' | 'pin' | 'loreBudget' | 'ckRag' | 'qvink' | 'des' | 'dedup';

export interface RuleEffect {
    rule: RuleEffectId;
    /** Tokens of what the rule acted on, before and after (damping: tokens of the damped entries → 0). */
    before: number;
    after: number;
    /** Entries damped / pinned / cut, units trimmed, copies dropped. */
    count: number;
}

export interface ArchitectApi {
    budgets(): SourceBudget[];
    setBudget(source: BudgetSource, tokens: number): Promise<void>;
    lastReport(): ArchitectReport | null;
    duplicates(): DuplicateFact[];
    /**
     * Consent for one duplicate: keep this source, drop the others on the fly. `owner` may be a source `ref` (exact)
     * or an owner name (its first source is kept); null withdraws the consent (report only).
     */
    keepSource(duplicateId: string, owner: string | null): Promise<void>;
    cache(): CacheStats;
    onReport(listener: (report: ArchitectReport) => void): Unsubscribe;
    // Additions of the M20 implementation (optional so that fakes of the stage-7 contract stay valid).
    /** Reports of the recent turns of this session, oldest first. */
    reports?(): ArchitectReport[];
    /** Fires after every measured response (cache stats changed). */
    onCache?(listener: () => void): Unsubscribe;
}
